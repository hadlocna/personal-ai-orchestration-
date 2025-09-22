const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const twilio = require('twilio');
const WebSocket = require('ws');

const {
  ensureConfig,
  validateEnv,
  buildConfigReport,
  requireAuth,
  createDashboardCors,
  createServiceLogger
} = require('@repo/common');

const SERVICE_NAME = 'call-agent-svc';
const SIP_SESSION_HEADER = 'X-Session-Id';
const DEFAULT_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_INSTRUCTIONS = 'You are a helpful AI voice assistant. Keep responses short, speak clearly, and confirm understanding when needed.';
const DEFAULT_GREETING = 'Hello! I\'m an AI assistant here to help. How can I assist you today?';
const DEFAULT_SESSION_RETENTION_MS = 15 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const globalFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

function bootstrap() {
  // Validate env but do not hard-exit on optional key format errors; only error on truly required keys
  try {
    const result = validateEnv();
    if (!result.valid) {
      const fatal = (result.errors || []).some((e) => {
        // Treat missing required keys as fatal
        return e.keyword === 'required';
      });
      if (fatal) {
        console.error(`${SERVICE_NAME}: configuration validation failed`, result.errors);
        process.exit(1);
      } else {
        console.warn(`${SERVICE_NAME}: non-fatal config warnings`, result.errors);
      }
    }
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation error`, err.cause || err);
    process.exit(1);
  }

  const runtime = buildRuntimeConfig();
  const logger = createLogFacade(runtime.loggingUrl);
  const sessionStore = createSessionStore(logger);

  logger.info('Bootstrapping service', {
    port: runtime.port,
    testMode: runtime.twilio.testMode,
    publicBaseUrl: runtime.publicBaseUrl || null,
    openAiProjectId: runtime.openAi.projectId || null,
    openAiModel: runtime.openAi.model,
    openAiVoice: runtime.openAi.voice,
    hasWebhookSecret: Boolean(runtime.openAi.webhookSecret)
  });

  if (!runtime.openAi.key) {
    logger.warn('OPENAI_API_KEY not configured; call acceptance will fail');
  }

  if (!runtime.openAi.projectId) {
    logger.warn('OPENAI_PROJECT_ID not configured; outbound calls cannot reach OpenAI SIP endpoint');
  }

  if (!runtime.openAi.webhookSecret) {
    logger.warn('OPENAI_WEBHOOK_SECRET not configured; webhook verification disabled');
  }

  if (!runtime.publicBaseUrl) {
    logger.warn('WEBHOOK_PUBLIC_BASE_URL not configured; external webhooks will not reach this service');
  }

  if (!runtime.twilio.testMode && (!runtime.twilio.accountSid || !runtime.twilio.authToken)) {
    logger.warn('Twilio credentials missing while TWILIO_TEST_MODE disabled; outbound call attempts will fail');
  }

  const twilioClient = buildTwilioClient(runtime.twilio, logger);

  const app = express();

  const server = http.createServer(app);

  app.use(helmet());
  app.use(morgan('combined'));
  app.use(createDashboardCors());

  const openAiWebhookRouter = express.Router();
  openAiWebhookRouter.use(express.raw({ type: '*/*', limit: '1mb' }));
  openAiWebhookRouter.post('/', async (req, res) => {
    if (!runtime.openAi.webhookSecret) {
      logger.warn('Received OpenAI webhook but OPENAI_WEBHOOK_SECRET is not configured');
      return res.status(403).send('Webhook secret not configured');
    }

    const signature = req.get('webhook-signature');
    const timestamp = req.get('webhook-timestamp');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    if (!verifyOpenAiSignature(rawBody, signature, timestamp, runtime.openAi.webhookSecret)) {
      logger.warn('Rejected OpenAI webhook due to invalid signature');
      return res.status(400).send('Invalid signature');
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.error('Failed to parse OpenAI webhook payload', { error: serializeError(err) });
      return res.status(400).send('Invalid JSON');
    }

    const eventType = event?.type || 'unknown';
    const callId = event?.data?.call_id || null;

    logger.info('Received OpenAI webhook event', {
      type: eventType,
      callId,
      sessionHeader: extractSessionIdFromSipHeaders(event?.data?.sip_headers)
    });

    switch (eventType) {
      case 'realtime.call.incoming': {
        if (!runtime.openAi.key) {
          logger.error('Cannot accept OpenAI call without OPENAI_API_KEY');
          return res.status(500).send('OpenAI not configured');
        }

        if (!globalFetch) {
          logger.error('Global fetch API unavailable; cannot accept OpenAI call');
          return res.status(500).send('fetch unavailable');
        }

        if (!callId) {
          logger.error('realtime.call.incoming missing call_id');
          return res.status(400).send('call_id missing');
        }

        const sessionId = extractSessionIdFromSipHeaders(event.data?.sip_headers) || null;
        const session = sessionId ? sessionStore.get(sessionId) : null;

        if (!session) {
          logger.warn('OpenAI webhook could not find matching session', {
            callId,
            sessionId
          });
        } else {
          sessionStore.attachOpenAiCallId(session.sessionId, callId);
          sessionStore.updateStatus(session.sessionId, 'openai_call_incoming', {
            callId,
            sipHeaders: event.data?.sip_headers || []
          });
        }

        try {
          const acceptPayload = buildOpenAiAcceptPayload(runtime, session);
          const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
          const response = await globalFetch(acceptUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${runtime.openAi.key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(acceptPayload)
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            logger.error('OpenAI call acceptance failed', {
              callId,
              status: response.status,
              body: text
            });
            if (session) {
              sessionStore.updateStatus(session.sessionId, 'openai_accept_failed', {
                status: response.status,
                body: text
              });
            }
            return res.status(502).send('OpenAI call acceptance failed');
          }

          if (session) {
            sessionStore.updateStatus(session.sessionId, 'openai_call_accepted', { callId });
          }

          res.status(200).json({ status: 'accepted' });

          setImmediate(() => {
            try {
              const monitorSocket = monitorOpenAiCall(callId, session, runtime.openAi, logger, sessionStore);
              if (session && monitorSocket) {
                sessionStore.setMonitor(session.sessionId, monitorSocket);
              }
            } catch (monitorErr) {
              logger.error('Failed to start OpenAI realtime monitor', {
                callId,
                error: serializeError(monitorErr)
              });
            }
          });
          return;
        } catch (err) {
          logger.error('OpenAI call acceptance threw error', {
            callId,
            error: serializeError(err)
          });
          if (session) {
            sessionStore.updateStatus(session.sessionId, 'openai_accept_error', {
              error: serializeError(err)
            });
          }
          return res.status(500).send('OpenAI call acceptance error');
        }
      }
      case 'realtime.call.hangup': {
        if (callId) {
          sessionStore.updateStatusByOpenAiCallId(callId, 'openai_call_hangup', {
            reason: event?.data?.reason || null
          });
          sessionStore.closeByOpenAiCallId(callId, {
            reason: event?.data?.reason || null
          });
        }
        return res.status(200).json({ status: 'acknowledged' });
      }
      default:
        return res.status(200).json({ status: 'ignored', type: eventType });
    }
  });
  app.use('/webhooks/openai', openAiWebhookRouter);

  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false }));

  const twilioWebhookRouter = express.Router();
  twilioWebhookRouter.use(express.urlencoded({ extended: false }));
  twilioWebhookRouter.use(createTwilioSignatureValidator(runtime, logger));
  twilioWebhookRouter.post('/status', (req, res) => {
    const payload = { ...req.body };
    logger.debug('Received Twilio status callback', payload);
    if (payload.CallSid) {
      const status = payload.CallStatus || payload.CallStatusCallbackEvent || 'unknown';
      sessionStore.updateStatusByCallSid(payload.CallSid, `twilio_${status}`, { payload });
      if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
        sessionStore.closeByCallSid(payload.CallSid, { reason: status, payload });
      }
    }
    res.status(204).end();
  });
  app.use('/webhooks/twilio', twilioWebhookRouter);

  // Public health/config endpoints for platform probes
  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });
  app.get('/healthz', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  // Protect remaining endpoints with Basic Auth / internal key
  app.use(requireAuth());


  app.post('/call', async (req, res) => {
    const requestPayload = req.body || {};
    const to = typeof requestPayload.to === 'string' ? requestPayload.to.trim() : '';
    const from = typeof requestPayload.from === 'string' ? requestPayload.from.trim() : runtime.twilio.callerId;
    const instructions = sanitizePrompt(requestPayload.instructions, runtime.openAi.instructions);
    const voice = sanitizeString(requestPayload.voice, runtime.openAi.voice);
    const model = sanitizeString(requestPayload.model, runtime.openAi.model);
    const greeting = sanitizePrompt(requestPayload.greeting, runtime.openAi.greeting);
    const metadata = requestPayload.metadata && typeof requestPayload.metadata === 'object' ? requestPayload.metadata : null;

    if (!to) {
      return res.status(400).json({ error: 'MISSING_DESTINATION', message: 'Request body must include `to` E.164 phone number.' });
    }

    if (!from) {
      return res.status(400).json({ error: 'MISSING_CALLER_ID', message: 'No caller ID provided. Configure TWILIO_CALLER_ID or include `from` in the payload.' });
    }

    if (!runtime.openAi.key || !runtime.openAi.projectId) {
      logger.error('Rejecting call initiation: OpenAI configuration incomplete');
      return res.status(500).json({ error: 'OPENAI_NOT_CONFIGURED', message: 'OPENAI_API_KEY and OPENAI_PROJECT_ID must be set to start calls.' });
    }

    const session = sessionStore.createSession({
      to,
      from,
      instructions,
      voice,
      model,
      greeting,
      metadata
    });

    logger.info('Dispatching outbound call request', {
      sessionId: session.sessionId,
      to,
      from,
      voice,
      model
    });

    if (runtime.twilio.testMode) {
      const fakeSid = `CA${crypto.randomBytes(16).toString('hex')}`;
      sessionStore.attachCallSid(session.sessionId, fakeSid);
      sessionStore.updateStatus(session.sessionId, 'simulated', { note: 'Twilio test mode enabled' });
      return res.status(202).json({
        status: 'simulated',
        callSid: fakeSid,
        sessionId: session.sessionId,
        to,
        from,
        voice,
        model
      });
    }

    if (!twilioClient) {
      logger.error('Twilio client unavailable while TWILIO_TEST_MODE is false. Check credentials.');
      sessionStore.updateStatus(session.sessionId, 'failed', { reason: 'twilio_client_unavailable' });
      return res.status(500).json({ error: 'TWILIO_NOT_CONFIGURED', message: 'Twilio client unavailable.' });
    }

    try {
      const twiml = buildOutboundDialTwiml(runtime.openAi.projectId, session.sessionId);
      const params = {
        to,
        from,
        twiml
      };

      if (runtime.publicBaseUrl) {
        params.statusCallback = buildPublicHttpUrl(runtime.publicBaseUrl, '/webhooks/twilio/status');
        params.statusCallbackMethod = 'POST';
        params.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed', 'busy', 'failed', 'no-answer'];
      }

      const call = await twilioClient.calls.create(params);

      sessionStore.attachCallSid(session.sessionId, call.sid);
      sessionStore.updateStatus(session.sessionId, 'queued', { accountSid: call.accountSid });

      logger.info('Twilio call created', {
        sessionId: session.sessionId,
        callSid: call.sid,
        accountSid: call.accountSid
      });

      res.status(202).json({
        status: 'queued',
        callSid: call.sid,
        sessionId: session.sessionId,
        to,
        from,
        voice,
        model
      });
    } catch (err) {
      logger.error('Twilio call creation failed', { error: serializeError(err) });
      sessionStore.updateStatus(session.sessionId, 'failed', { error: serializeError(err) });
      res.status(502).json({
        error: 'TWILIO_CALL_FAILED',
        message: err?.message || 'Twilio call initiation failed.'
      });
    }
  });

  const serverInstance = server.listen(runtime.port, () => {
    logger.info(`${SERVICE_NAME} listening`, { port: runtime.port, testMode: runtime.twilio.testMode });
  });

  setInterval(() => {
    const pruned = sessionStore.prune(runtime.sessionRetentionMs);
    if (pruned > 0) {
      logger.debug('Pruned inactive call sessions', { count: pruned });
    }
  }, Math.max(runtime.sessionRetentionMs / 3, 30_000));

  return serverInstance;
}

function buildRuntimeConfig() {
  return {
    port: Number.parseInt(process.env.PORT, 10) || 4020,
    publicBaseUrl: sanitizeString(process.env.WEBHOOK_PUBLIC_BASE_URL || process.env.PUBLIC_DOMAIN, ''),
    loggingUrl: sanitizeString(process.env.LOGGING_URL, ''),
    sessionRetentionMs: parseInteger(process.env.CALL_AGENT_SESSION_RETENTION_MS, DEFAULT_SESSION_RETENTION_MS),
    openAi: {
      key: sanitizeString(process.env.OPENAI_API_KEY, ''),
      baseUrl: sanitizeString(process.env.OPENAI_API_BASE_URL, 'https://api.openai.com'),
      projectId: sanitizeString(process.env.OPENAI_PROJECT_ID, ''),
      model: sanitizeString(process.env.OPENAI_MODEL, DEFAULT_MODEL),
      voice: sanitizeString(process.env.OPENAI_REALTIME_VOICE, DEFAULT_VOICE),
      instructions: sanitizePrompt(process.env.CALL_AGENT_DEFAULT_INSTRUCTIONS, DEFAULT_INSTRUCTIONS),
      greeting: sanitizePrompt(process.env.CALL_AGENT_GREETING, DEFAULT_GREETING),
      webhookSecret: sanitizeString(process.env.OPENAI_WEBHOOK_SECRET, '')
    },
    twilio: {
      accountSid: sanitizeString(process.env.TWILIO_ACCOUNT_SID, ''),
      authToken: sanitizeString(process.env.TWILIO_AUTH_TOKEN, ''),
      callerId: sanitizeString(
        process.env.TWILIO_CALLER_ID
          || process.env.TWILIO_NUMBER_PERSONAL
          || process.env.TWILIO_NUMBER_WORK
          || process.env.TWILIO_NUMBER_Work,
        ''
      ),
      baseUrl: sanitizeString(process.env.TWILIO_API_BASE_URL || process.env.TWILIO_BASE_URL, ''),
      webhookSecret: sanitizeString(process.env.TWILIO_WEBHOOK_SECRET || process.env.TWILIO_AUTH_TOKEN, ''),
      testMode: parseBoolean(process.env.TWILIO_TEST_MODE, true)
    }
  };
}

function buildTwilioClient(twilioConfig, logger) {
  if (!twilioConfig.accountSid || !twilioConfig.authToken) {
    return null;
  }
  const client = twilio(twilioConfig.accountSid, twilioConfig.authToken, { lazyLoading: true });
  if (twilioConfig.baseUrl) {
    try {
      client.requestClient.setBaseUrl?.(twilioConfig.baseUrl);
      logger.info('Configured custom Twilio API base URL', { baseUrl: twilioConfig.baseUrl });
    } catch (err) {
      logger.warn('Unable to configure Twilio API base URL; continuing with default', { error: serializeError(err) });
    }
  }
  return client;
}

function buildOutboundDialTwiml(projectId, sessionId) {
  const voiceResponse = new twilio.twiml.VoiceResponse();
  const dial = voiceResponse.dial({ answerOnBridge: true });
  const headerValue = sessionId ? encodeURIComponent(sessionId) : '';
  const sipUrl = `sip:${projectId}@sip.api.openai.com;transport=tls${headerValue ? `?${SIP_SESSION_HEADER}=${headerValue}` : ''}`;
  dial.sip(sipUrl);
  return voiceResponse.toString();
}

function buildPublicHttpUrl(baseUrl, path) {
  const url = new URL(path, baseUrl);
  return url.toString();
}

function buildOpenAiAcceptPayload(runtime, session) {
  const instructions = session?.instructions || runtime.openAi.instructions;
  const voice = session?.voice || runtime.openAi.voice;
  const model = session?.model || runtime.openAi.model;

  const payload = {
    type: 'realtime',
    model,
    instructions,
    modalities: ['audio', 'text'],
    input_audio_format: 'g711_ulaw',
    output_audio_format: 'g711_ulaw'
  };

  if (voice) {
    payload.voice = voice;
  }

  return payload;
}

function buildOpenAiRealtimeCallUrl(baseUrl, callId) {
  // Use configured API base URL (defaults to https://api.openai.com), upgrading to wss.
  // If the base already points to the realtime endpoint, don't append the path again.
  const apiBase = sanitizeString(baseUrl, 'https://api.openai.com');
  let url;
  try {
    const parsed = new URL(apiBase);
    const normalizedPath = parsed.pathname.replace(/\/$/, '');
    if (normalizedPath.endsWith('/v1/realtime')) {
      url = parsed;
    } else {
      url = new URL('/v1/realtime', parsed);
    }
  } catch (_err) {
    url = new URL('/v1/realtime', 'https://api.openai.com');
  }
  if (callId) {
    url.searchParams.set('call_id', callId);
  }
  // Force secure websocket regardless of http/https on base
  url.protocol = 'wss:';
  return url.toString();
}

function monitorOpenAiCall(callId, session, openAiConfig, logger, sessionStore) {
  if (!callId || !openAiConfig?.key) {
    return null;
  }

  const url = buildOpenAiRealtimeCallUrl(openAiConfig.baseUrl, callId);
  const sessionId = session?.sessionId || null;

  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${openAiConfig.key}`,
      'User-Agent': `${SERVICE_NAME}/1.0`
    }
  });

  socket.on('open', () => {
    logger.info('Connected to OpenAI realtime session', { callId, sessionId, url });

    // Send initial greeting response for the call
    const greeting = session?.greeting || openAiConfig.greeting;
    if (greeting) {
      const message = {
        type: 'response.create',
        response: {
          instructions: greeting
        }
      };
      try {
        socket.send(JSON.stringify(message));
        logger.debug('Sent greeting to OpenAI realtime session', { callId, sessionId });
      } catch (err) {
        logger.error('Failed to send greeting to OpenAI realtime session', {
          callId,
          sessionId,
          error: serializeError(err)
        });
      }
    }
  });

  socket.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const type = event?.type || 'unknown';
      if (type === 'response.output_text.delta' && event?.delta) {
        logger.debug('OpenAI text delta', {
          callId,
          sessionId,
          text: String(event.delta).slice(0, 120)
        });
      } else if (type === 'response.completed') {
        logger.debug('OpenAI response completed', { callId, sessionId });
      } else if (type === 'error' || type === 'response.error') {
        logger.error('OpenAI realtime error event', { callId, sessionId, event });
      } else if (type === 'realtime.session.ended') {
        logger.info('OpenAI realtime session ended', { callId, sessionId });
      }
    } catch (_err) {
      logger.debug('Received non-JSON OpenAI realtime frame', { callId, sessionId });
    }
  });

  socket.on('close', (code, reason) => {
    logger.info('OpenAI realtime monitor closed', {
      callId,
      sessionId,
      code,
      reason: reason?.toString()
    });
    if (sessionId) {
      sessionStore.clearMonitor(sessionId, socket);
    }
  });

  socket.on('error', (err) => {
    logger.error('OpenAI realtime monitor socket error', {
      callId,
      sessionId,
      error: serializeError(err)
    });
  });

  return socket;
}

function createTwilioSignatureValidator(runtime, logger) {
  const secret = runtime.twilio.webhookSecret;
  const baseUrl = runtime.publicBaseUrl;
  if (!secret) {
    logger.warn('Twilio webhook signature verification disabled (no TWILIO_WEBHOOK_SECRET or TWILIO_AUTH_TOKEN)');
    return (_req, _res, next) => next();
  }
  if (!baseUrl) {
    logger.warn('Cannot validate Twilio signatures without WEBHOOK_PUBLIC_BASE_URL; bypassing verification');
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const signature = req.get('x-twilio-signature');
    if (!signature) {
      logger.warn('Twilio webhook missing X-Twilio-Signature header');
      return res.status(403).send('Signature required');
    }
    const expectedUrl = buildPublicHttpUrl(baseUrl, req.originalUrl || req.url);
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const valid = twilio.validateRequest(secret, signature, expectedUrl, params);
    if (!valid) {
      logger.warn('Invalid Twilio webhook signature', { expectedUrl });
      return res.status(403).send('Invalid signature');
    }
    return next();
  };
}

function createLogFacade(loggingUrl) {
  const hasLogging = Boolean(loggingUrl);
  const serviceLogger = hasLogging
    ? createServiceLogger({ service: SERVICE_NAME, loggingUrl, broadcast: null })
    : null;

  const emit = (level, message, data) => {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${SERVICE_NAME}] ${message}`;
    if (data) {
      if (level === 'error') {
        console.error(logLine, data);
      } else {
        console.log(logLine, data);
      }
    } else {
      if (level === 'error') {
        console.error(logLine);
      } else {
        console.log(logLine);
      }
    }
    if (!serviceLogger) return;
    const payload = data ? { data } : undefined;
    if (level === 'info') serviceLogger.info(message, payload);
    else if (level === 'warn') serviceLogger.warn(message, payload);
    else if (level === 'error') serviceLogger.error(message, payload);
  };

  return {
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
    debug: (msg, data) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [${SERVICE_NAME}] ${msg}`;
      if (data) {
        console.debug(line, data);
      } else {
        console.debug(line);
      }
    }
  };
}

function createSessionStore(logger) {
  const byId = new Map();
  const byCallSid = new Map();
  const byOpenAiCallId = new Map();

  return {
    createSession(data) {
      const sessionId = crypto.randomUUID();
      const record = {
        sessionId,
        to: data.to,
        from: data.from,
        instructions: data.instructions,
        voice: data.voice,
        model: data.model,
        greeting: data.greeting,
        metadata: data.metadata || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'created',
        callSid: null,
        openAiCallId: null,
        monitorSocket: null,
        monitoring: false,
        lastDetail: null
      };
      byId.set(sessionId, record);
      logger.debug('Registered new call session', { sessionId, to: data.to, model: data.model, voice: data.voice });
      return record;
    },
    get(sessionId) {
      return byId.get(sessionId) || null;
    },
    getByOpenAiCallId(callId) {
      return byOpenAiCallId.get(callId) || null;
    },
    attachCallSid(sessionId, callSid) {
      const session = byId.get(sessionId);
      if (!session) return;
      session.callSid = callSid;
      session.updatedAt = Date.now();
      byCallSid.set(callSid, session);
    },
    attachOpenAiCallId(sessionId, callId) {
      const session = byId.get(sessionId);
      if (!session) return;
      session.openAiCallId = callId;
      session.updatedAt = Date.now();
      byOpenAiCallId.set(callId, session);
    },
    setMonitor(sessionId, socket) {
      const session = byId.get(sessionId);
      if (!session) return;
      if (session.monitorSocket && session.monitorSocket !== socket) {
        try {
          session.monitorSocket.close(1000, 'monitor_replaced');
        } catch (err) {
          logger.warn('Failed to close existing OpenAI monitor socket', { sessionId, error: serializeError(err) });
        }
      }
      session.monitorSocket = socket || null;
      session.monitoring = Boolean(socket);
      session.updatedAt = Date.now();
    },
    clearMonitor(sessionId, socket) {
      const session = byId.get(sessionId);
      if (!session) return;
      if (session.monitorSocket && session.monitorSocket !== socket) {
        try {
          session.monitorSocket.close(1000, 'monitor_cleared');
        } catch (err) {
          logger.warn('Failed to close OpenAI monitor socket', { sessionId, error: serializeError(err) });
        }
      }
      session.monitorSocket = null;
      session.monitoring = false;
      session.updatedAt = Date.now();
    },
    updateStatus(sessionId, status, detail) {
      const session = byId.get(sessionId);
      if (!session) return;
      session.status = status;
      session.updatedAt = Date.now();
      if (detail) session.lastDetail = detail;
    },
    updateStatusByCallSid(callSid, status, detail) {
      const session = byCallSid.get(callSid);
      if (!session) return;
      this.updateStatus(session.sessionId, status, detail);
    },
    updateStatusByOpenAiCallId(callId, status, detail) {
      const session = byOpenAiCallId.get(callId);
      if (!session) return;
      this.updateStatus(session.sessionId, status, detail);
    },
    close(sessionId, detail) {
      const session = byId.get(sessionId);
      if (!session) return;
      if (detail) session.lastDetail = detail;
      session.status = 'closed';
      session.updatedAt = Date.now();
      if (session.monitorSocket) {
        try {
          session.monitorSocket.close(1000, 'session_closed');
        } catch (err) {
          logger.warn('Failed to close OpenAI monitor socket during session close', { sessionId, error: serializeError(err) });
        }
        session.monitorSocket = null;
      }
      session.monitoring = false;
    },
    closeByCallSid(callSid, detail) {
      const session = byCallSid.get(callSid);
      if (!session) return;
      this.close(session.sessionId, detail);
    },
    closeByOpenAiCallId(callId, detail) {
      const session = byOpenAiCallId.get(callId);
      if (!session) return;
      this.close(session.sessionId, detail);
    },
    prune(retentionMs) {
      const now = Date.now();
      let removed = 0;
      for (const [sessionId, session] of byId.entries()) {
        if (now - session.updatedAt > retentionMs) {
          if (session.monitorSocket) {
            try {
              session.monitorSocket.close(1000, 'session_pruned');
            } catch (err) {
              logger.warn('Failed to close OpenAI monitor socket during prune', { sessionId, error: serializeError(err) });
            }
          }
          byId.delete(sessionId);
          if (session.callSid) byCallSid.delete(session.callSid);
          if (session.openAiCallId) byOpenAiCallId.delete(session.openAiCallId);
          removed += 1;
        }
      }
      return removed;
    }
  };
}

function verifyOpenAiSignature(rawBody, signatureHeader, timestampHeader, secret) {
  if (!secret || !signatureHeader || !timestampHeader) return false;

  const signature = extractOpenAiSignature(signatureHeader);
  if (!signature) return false;

  const timestamp = Number.parseInt(String(timestampHeader), 10);
  if (!Number.isFinite(timestamp)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function extractOpenAiSignature(header) {
  if (!header) return null;
  const normalized = header.replace('v1,', 'v1=');
  const parts = normalized.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('v1=')) {
      return trimmed.slice(3).trim();
    }
  }
  if (normalized.startsWith('v1=')) {
    return normalized.slice(3).trim();
  }
  return normalized.trim();
}

function extractSessionIdFromSipHeaders(sipHeaders) {
  if (!Array.isArray(sipHeaders)) return null;
  const header = sipHeaders.find((item) => typeof item?.name === 'string' && item.name.toLowerCase() === SIP_SESSION_HEADER.toLowerCase());
  if (!header || typeof header.value !== 'string') return null;
  const value = header.value.trim();
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return value;
  }
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseInteger(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function sanitizeString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function sanitizePrompt(value, fallback) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function serializeError(err) {
  if (!err) return null;
  return {
    message: err.message,
    stack: err.stack,
    code: err.code,
    status: err.status,
    name: err.name
  };
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
