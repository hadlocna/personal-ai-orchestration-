const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

// ------------------------------
// Service constants
// ------------------------------
const SERVICE_NAME = 'voice-rt-svc';
const SIP_SESSION_HEADER = 'X-Session-Id';

// ------------------------------
// State
// ------------------------------
let pool = null; // pg Pool
let cfg = null;  // active config (loaded from DB)
let server = null; // http server
const wsSubscribers = new Map(); // callId -> Set<WebSocket>

// ------------------------------
// Utilities
// ------------------------------
function log(level, msg, extra = {}) {
  const line = { ts: new Date().toISOString(), svc: SERVICE_NAME, level, msg, ...extra };
  // Keep simple console logs; Render logs capture stdout/stderr
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(line));
}

function redactConfig(o) {
  const clone = JSON.parse(JSON.stringify(o || {}));
  try {
    if (clone.twilio) {
      if (clone.twilio.auth_token) clone.twilio.auth_token = '***';
    }
    if (clone.openai) {
      if (clone.openai.api_key) clone.openai.api_key = '***';
      if (clone.openai.webhook_secret) clone.openai.webhook_secret = '***';
    }
  } catch (_) {}
  return clone;
}

function required(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return false;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null && (typeof cur !== 'string' || cur.trim() !== '');
}

function validateConfig(conf) {
  const missing = [];
  const must = [
    'basic_auth.user',
    'basic_auth.pass',
    'internal_key',
    'db_url',
    'allowed_origins',
    'twilio.account_sid',
    'twilio.auth_token',
    'twilio.from_number',
    'openai.api_key',
    'openai.webhook_secret',
    // We require project_id for SIP URI
    'openai.project_id',
    'openai.realtime.model'
  ];
  for (const path of must) {
    if (!required(conf, path)) missing.push(path);
  }
  if (!Array.isArray(conf.allowed_origins)) missing.push('allowed_origins (array)');
  return { ok: missing.length === 0, missing };
}

function basicAuthMiddleware(req, res, next) {
  // Public endpoints skip auth
  if (isPublicPath(req)) return next();
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="voice-rt"');
    return res.status(401).send('Auth required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user === cfg.basic_auth.user && pass === cfg.basic_auth.pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="voice-rt"');
  return res.status(401).send('Invalid credentials');
}

function isPublicPath(req) {
  const p = req.path || req.url || '';
  return (
    p === '/health' ||
    p === '/healthz' ||
    p === '/openai/webhook' ||
    p.startsWith('/openai/webhook') ||
    p === '/twiml/outbound' ||
    p.startsWith('/twilio/status') ||
    (req.method === 'GET' && p.startsWith('/static/'))
  );
}

function requireInternalKey(req, res, next) {
  const k = req.get('X-INTERNAL-KEY') || req.get('x-internal-key');
  if (!k || k !== cfg.internal_key) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  return next();
}

function withCors() {
  const origins = Array.isArray(cfg.allowed_origins) ? cfg.allowed_origins : [];
  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl / server-to-server
      if (origins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  });
}

async function pgQuery(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  await pgQuery(`CREATE TABLE IF NOT EXISTS app_config (
    config_id  TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);

  await pgQuery(`CREATE TABLE IF NOT EXISTS scenarios (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    params        JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);

  await pgQuery(`CREATE TABLE IF NOT EXISTS calls (
    id             UUID PRIMARY KEY,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    to_number      TEXT NOT NULL,
    from_number    TEXT NOT NULL,
    scenario_id    TEXT,
    guidelines     TEXT,
    status         TEXT NOT NULL,
    twilio_sid     TEXT,
    openai_call_id TEXT,
    error          JSONB,
    corr_id        TEXT,
    trace_id       TEXT NOT NULL
  );`);

  await pgQuery(`CREATE INDEX IF NOT EXISTS calls_updated_idx ON calls(updated_at DESC);`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS calls_status_idx  ON calls(status);`);

  await pgQuery(`CREATE TABLE IF NOT EXISTS call_events (
    id        UUID PRIMARY KEY,
    call_id   UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    ts_utc    TIMESTAMPTZ NOT NULL DEFAULT now(),
    src       TEXT NOT NULL,
    kind      TEXT NOT NULL,
    data      JSONB
  );`);

  await pgQuery(`CREATE INDEX IF NOT EXISTS call_events_call_idx ON call_events(call_id, ts_utc);`);
}

async function loadConfigFromDbOrEnv() {
  await ensureSchema();
  const existing = await pgQuery('SELECT data FROM app_config WHERE config_id=$1', ['default']);
  if (existing.rows.length > 0) {
    return existing.rows[0].data;
  }
  const env = process.env.APP_CONFIG;
  if (!env) {
    throw new Error('APP_CONFIG not set and database empty');
  }
  let parsed;
  try { parsed = JSON.parse(env); } catch (e) { throw new Error('APP_CONFIG is not valid JSON'); }
  const v = validateConfig(parsed);
  if (!v.ok) {
    throw new Error('APP_CONFIG missing keys: ' + v.missing.join(', '));
  }
  await pgQuery('INSERT INTO app_config(config_id, data) VALUES ($1, $2)', ['default', parsed]);
  return parsed;
}

async function replaceConfig(newConfig) {
  const v = validateConfig(newConfig);
  if (!v.ok) {
    const err = new Error('Config invalid');
    err.missing = v.missing;
    throw err;
  }
  await pgQuery('UPDATE app_config SET data=$2, updated_at=now() WHERE config_id=$1', ['default', newConfig]);
  cfg = newConfig;
}

function verifyOpenAiSignature(rawBody, signatureHeader, timestampHeader, secret) {
  if (!secret || !signatureHeader || !timestampHeader) return false;
  // Accept either "v1=..." or "v1,..." formats
  const sig = extractOpenAiSignature(signatureHeader);
  if (!sig) return false;
  const ts = Number.parseInt(String(timestampHeader), 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 5 * 60) return false;
  const payload = `${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractOpenAiSignature(header) {
  if (!header) return null;
  const normalized = header.replace('v1,', 'v1=');
  const parts = normalized.split(',');
  for (const part of parts) {
    const t = part.trim();
    if (t.startsWith('v1=')) return t.slice(3);
  }
  if (normalized.startsWith('v1=')) return normalized.slice(3);
  return normalized.trim();
}

function parseSipHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const h = headers.find((x) => String(x?.name || '').toLowerCase() === String(name).toLowerCase());
  return h ? String(h.value || '') : null;
}

function parseE164Maybe(s) {
  if (!s) return null;
  const m = s.match(/\+\d{8,15}/);
  return m ? m[0] : null;
}

async function emit(callId, kind, src, data) {
  const id = uuidv4();
  await pgQuery(
    'INSERT INTO call_events(id, call_id, src, kind, data) VALUES ($1,$2,$3,$4,$5)',
    [id, callId, src, kind, data || null]
  );
  broadcast(callId, { id, call_id: callId, ts_utc: new Date().toISOString(), src, kind, data });
}

function broadcast(callId, payload) {
  const subs = wsSubscribers.get(String(callId));
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of subs) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch (_) {}
  }
}

function wsSubscribe(callId, ws) {
  const key = String(callId);
  let set = wsSubscribers.get(key);
  if (!set) { set = new Set(); wsSubscribers.set(key, set); }
  set.add(ws);
  ws.on('close', () => {
    const s = wsSubscribers.get(key);
    if (s) { s.delete(ws); if (s.size === 0) wsSubscribers.delete(key); }
  });
}

function buildTwimlOpenAiSip(projectId, sessionId) {
  const resp = new twilio.twiml.VoiceResponse();
  const dial = resp.dial({ answerOnBridge: true });
  const headerValue = sessionId ? encodeURIComponent(sessionId) : '';
  const sipUrl = `sip:${projectId}@sip.api.openai.com;transport=tls${headerValue ? `?${SIP_SESSION_HEADER}=${headerValue}` : ''}`;
  dial.sip(sipUrl);
  return resp.toString();
}

function openAiRealtimeWsUrl(callId) {
  const u = new URL('/v1/realtime', 'https://api.openai.com');
  u.searchParams.set('call_id', callId);
  u.protocol = 'wss:';
  return u.toString();
}

// ------------------------------
// Server bootstrap
// ------------------------------
async function main() {
  // 1) Connect DB (using APP_CONFIG.db_url only after initial parse for connection)
  const envConfigRaw = process.env.APP_CONFIG;
  if (!envConfigRaw) {
    throw new Error('APP_CONFIG must be set (JSON string)');
  }
  let bootstrapCfg = null;
  try { bootstrapCfg = JSON.parse(envConfigRaw); } catch (e) { throw new Error('APP_CONFIG invalid JSON'); }
  if (!bootstrapCfg.db_url) throw new Error('APP_CONFIG.db_url is required to connect to Postgres');
  pool = new Pool({ connectionString: bootstrapCfg.db_url, max: 10 });

  // 2) Load config from DB or persist from env
  cfg = await loadConfigFromDbOrEnv();
  log('log', 'CONFIG_READY', { cfg: redactConfig(cfg) });

  // 3) Init Twilio client
  const twilioClient = twilio(cfg.twilio.account_sid, cfg.twilio.auth_token, { lazyLoading: true });

  const app = express();
  server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });

  // HTTP upgrades for /ws/calls/:id
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/ws/calls/')) return socket.destroy();
    // Public WS for live event view (dashboard convenience)
    wss.handleUpgrade(req, socket, head, (ws) => {
      const callId = url.pathname.split('/').pop();
      wsSubscribe(callId, ws);
      (async () => {
        try {
          const rows = (await pgQuery('SELECT id, call_id, ts_utc, src, kind, data FROM call_events WHERE call_id=$1 ORDER BY ts_utc ASC LIMIT 200', [callId])).rows;
          for (const e of rows) ws.send(JSON.stringify(e));
        } catch (err) { /* noop */ }
      })();
    });
  });

  // Security & logging
  app.use(helmet());
  app.use(morgan('combined'));

  // CORS
  app.use(withCors());

  // Raw body for OpenAI webhook signature verification
  app.use('/openai/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.post('/openai/webhook', async (req, res) => {
    const signature = req.get('webhook-signature');
    const timestamp = req.get('webhook-timestamp');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!verifyOpenAiSignature(rawBody, signature, timestamp, cfg.openai.webhook_secret)) {
      await safeEmitUnknown('openai', 'error', { reason: 'invalid_signature' });
      return res.status(400).send('Invalid signature');
    }
    let event = null;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { return res.status(400).send('Bad JSON'); }
    const type = event?.type || 'unknown';
    if (type === 'realtime.call.incoming') {
      const openaiCallId = event?.data?.call_id;
      const fromHdr = parseSipHeader(event?.data?.sip_headers, 'From');
      const toHdr = parseSipHeader(event?.data?.sip_headers, 'To');
      const toNum = parseE164Maybe(toHdr);
      const fromNum = parseE164Maybe(fromHdr);

      // find candidate call: latest dialing/ringing in last 30 min matching to_number if possible
      const { rows } = await pgQuery(
        `SELECT * FROM calls WHERE (status IN ('dialing','ringing','bridged'))
         ${toNum ? 'AND to_number = $1' : ''}
         ORDER BY created_at DESC LIMIT 1`,
        toNum ? [toNum] : []
      );
      let callId;
      if (rows.length > 0) {
        callId = rows[0].id;
        await pgQuery('UPDATE calls SET openai_call_id=$2, status=$3, updated_at=now() WHERE id=$1', [callId, openaiCallId, 'bridged']);
      } else {
        // create stub
        callId = uuidv4();
        await pgQuery(
          'INSERT INTO calls(id,to_number,from_number,scenario_id,guidelines,status,twilio_sid,openai_call_id,error,corr_id,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [callId, toNum || '', fromNum || '', null, null, 'bridged', null, openaiCallId, null, null, uuidv4()]
        );
      }
      await emit(callId, 'openai.webhook', 'openai', { openai_call_id: openaiCallId, sip_headers: event?.data?.sip_headers || [] });

      // Resolve instructions
      let instructions = null;
      let scenarioParams = {};
      if (rows.length > 0) {
        const call = rows[0];
        if (call.guidelines && call.guidelines.trim()) instructions = call.guidelines.trim();
        if (!instructions && call.scenario_id) {
          const s = await pgQuery('SELECT system_prompt, params FROM scenarios WHERE id=$1', [call.scenario_id]);
          if (s.rows.length > 0) {
            instructions = s.rows[0].system_prompt;
            scenarioParams = s.rows[0].params || {};
          }
        }
      }
      if (!instructions) instructions = 'You are a helpful AI voice assistant.';

      // Accept the call
      const acceptBody = {
        type: 'realtime',
        model: cfg.openai.realtime.model,
        instructions,
        voice: cfg.openai.realtime.voice || undefined,
        modalities: ['audio', 'text'],
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        ...(scenarioParams.session || {})
      };

      try {
        const url = `https://api.openai.com/v1/realtime/calls/${openaiCallId}/accept`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.openai.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(acceptBody)
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          await pgQuery('UPDATE calls SET status=$2, error=$3, updated_at=now() WHERE id=$1', [callId, 'failed', { http_status: r.status, body: t }]);
          await emit(callId, 'error', 'svc', { at: 'accept', status: r.status, body: t });
          return res.status(502).send('OpenAI accept failed');
        }
        await pgQuery('UPDATE calls SET status=$2, updated_at=now() WHERE id=$1', [callId, 'accepted']);
        await emit(callId, 'accept', 'svc', { model: cfg.openai.realtime.model });

        // Optional monitor
        setImmediate(() => monitorRealtime(callId, openaiCallId).catch((e) => log('error', 'monitor_failed', { error: e.message })));

        return res.status(200).end();
      } catch (err) {
        await emit(rows[0]?.id || 'unknown', 'error', 'svc', { at: 'accept', error: err?.message });
        return res.status(500).send('accept error');
      }
    }
    return res.status(200).end();
  });

  // JSON for all other routes
  app.use(express.json({ limit: '512kb' }));

  // Health
  app.get('/health', (req, res) => res.json({ service: SERVICE_NAME, status: 'ok', ts: new Date().toISOString() }));
  app.get('/healthz', (req, res) => res.json({ service: SERVICE_NAME, status: 'ok', ts: new Date().toISOString() }));

  // Public TwiML for outbound bridge
  app.get('/twiml/outbound', async (req, res) => {
    const callId = req.query.callId;
    if (!callId) return res.status(400).send('Missing callId');
    const twiml = buildTwimlOpenAiSip(cfg.openai.project_id, callId);
    await emit(callId, 'twilio.twiml.served', 'svc', {});
    res.type('text/xml').send(twiml);
  });

  // Twilio status callback (optional)
  app.post('/twilio/status', express.urlencoded({ extended: false }), async (req, res) => {
    const callId = req.query.callId;
    const status = req.body?.CallStatus || 'unknown';
    if (callId) {
      await emit(callId, 'twilio.status', 'twilio', { status, raw: req.body });
      if (status === 'ringing') await pgQuery('UPDATE calls SET status=$2, updated_at=now() WHERE id=$1', [callId, 'ringing']);
      if (status === 'answered') await pgQuery('UPDATE calls SET status=$2, updated_at=now() WHERE id=$1', [callId, 'in_progress']);
      if (status === 'completed') await pgQuery('UPDATE calls SET status=$2, updated_at=now() WHERE id=$1', [callId, 'completed']);
    }
    res.status(200).end();
  });

  // Admin config endpoints (Basic auth)
  app.use(basicAuthMiddleware);

  app.get('/admin/config', (req, res) => {
    res.json(redactConfig(cfg));
  });
  app.get('/admin/config/validate', (req, res) => {
    const v = validateConfig(cfg);
    res.json({ ok: v.ok, missing: v.missing, config: redactConfig(cfg) });
  });
  app.put('/admin/config', async (req, res) => {
    try {
      await replaceConfig(req.body || {});
      res.json({ status: 'updated' });
    } catch (err) {
      res.status(400).json({ error: 'INVALID_CONFIG', missing: err.missing || [] });
    }
  });

  // Calls (Basic) and Internal (X-INTERNAL-KEY)
  app.post('/test-call', createCallHandler(twilioClient));
  app.post('/api/calls', requireInternalKey, createCallHandler(twilioClient));

  app.get('/calls/:id', async (req, res) => {
    const id = req.params.id;
    const callRes = await pgQuery('SELECT * FROM calls WHERE id=$1', [id]);
    if (callRes.rows.length === 0) return res.status(404).send('Not found');
    const events = (await pgQuery('SELECT id, ts_utc, src, kind, data FROM call_events WHERE call_id=$1 ORDER BY ts_utc ASC LIMIT 300', [id])).rows;
    res.json({ call: callRes.rows[0], events });
  });

  app.get('/calls', async (req, res) => {
    const status = req.query.status;
    const since = req.query.since;
    const params = [];
    const where = [];
    if (status) { where.push('status=$' + (params.length + 1)); params.push(status); }
    if (since) { where.push('updated_at >= $' + (params.length + 1)); params.push(new Date(since)); }
    const sql = `SELECT * FROM calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 100`;
    const rows = (await pgQuery(sql, params)).rows;
    res.json({ calls: rows });
  });

  // Scenarios
  app.post('/api/scenarios', requireInternalKey, async (req, res) => {
    const { id, title, system_prompt, params } = req.body || {};
    if (!id || !title || !system_prompt) return res.status(400).json({ error: 'MISSING_FIELDS' });
    await pgQuery('INSERT INTO scenarios(id,title,system_prompt,params) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, system_prompt=EXCLUDED.system_prompt, params=EXCLUDED.params, updated_at=now()', [id, title, system_prompt, params || null]);
    res.json({ status: 'ok' });
  });
  app.get('/api/scenarios', requireInternalKey, async (_req, res) => {
    const rows = (await pgQuery('SELECT * FROM scenarios ORDER BY updated_at DESC LIMIT 100', [])).rows;
    res.json({ scenarios: rows });
  });

  // Dashboard (simple static page)
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  const PORT = Number(process.env.PORT) || 8080;
  server.listen(PORT, () => log('log', 'SERVICE_READY', { port: PORT }));

  // --- helpers inside main ---
  async function safeEmitUnknown(src, kind, data) {
    try {
      broadcast('unknown', { ts_utc: new Date().toISOString(), src, kind, data });
    } catch (_) {}
  }

  function createCallHandler(client) {
    return async (req, res) => {
      const { to, scenarioId, guidelines, corrId } = req.body || {};
      if (!to || typeof to !== 'string' || !/^\+\d{8,15}$/.test(to)) {
        return res.status(400).json({ error: 'INVALID_TO', message: 'Provide E.164 number in `to`.' });
      }
      const from = cfg.twilio.from_number;
      const id = uuidv4();
      const trace = uuidv4();
      await pgQuery(
        'INSERT INTO calls(id,to_number,from_number,scenario_id,guidelines,status,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, to, from, scenarioId || null, guidelines || null, 'dialing', trace]
      );
      await emit(id, 'created', 'api', { to, from, scenarioId: scenarioId || null, corrId: corrId || null });

      try {
        const tw = await client.calls.create({
          to,
          from,
          url: publicUrl(`/twiml/outbound?callId=${encodeURIComponent(id)}`),
          statusCallback: publicUrl(`/twilio/status?callId=${encodeURIComponent(id)}`),
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });
        await pgQuery('UPDATE calls SET twilio_sid=$2, updated_at=now() WHERE id=$1', [id, tw.sid]);
        await emit(id, 'twilio.rest.out', 'svc', { sid: tw.sid });
        return res.status(202).json({ id, traceId: trace });
      } catch (err) {
        await pgQuery('UPDATE calls SET status=$2, error=$3, updated_at=now() WHERE id=$1', [id, 'failed', { message: err?.message }]);
        await emit(id, 'error', 'svc', { at: 'twilio.create', error: err?.message });
        return res.status(502).json({ error: 'TWILIO_FAILED', message: err?.message });
      }
    };
  }

  function publicUrl(path) {
    // Render sets RENDER_EXTERNAL_URL sometimes; fallback to service URL env if provided
    const base = process.env.PUBLIC_BASE_URL || process.env.WEBHOOK_PUBLIC_BASE_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'voice-rt-svc.onrender.com'}`;
    const u = new URL(path, base);
    return u.toString();
  }

  async function monitorRealtime(callId, openaiCallId) {
    const url = openAiRealtimeWsUrl(openaiCallId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.openai.api_key}` } });
    ws.on('open', async () => { await emit(callId, 'ws.open', 'openai', {}); });
    ws.on('message', async (raw) => {
      try {
        const ev = JSON.parse(raw.toString());
        const type = ev?.type || 'unknown';
        // store summarized frames to avoid huge payloads
        let summary = ev;
        if (type === 'response.output_text.delta' && ev?.delta) {
          summary = { type, delta: String(ev.delta).slice(0, 160) };
        } else if (type === 'audio.buffer.append') {
          summary = { type, bytes: (ev?.audio?.length || 0) };
        }
        await emit(callId, 'ws.msg', 'openai', summary);
      } catch (_) {
        await emit(callId, 'ws.msg', 'openai', { raw: String(raw).slice(0, 200) });
      }
    });
    ws.on('error', async (e) => { await emit(callId, 'ws.error', 'openai', { message: e.message }); });
    ws.on('close', async () => { await emit(callId, 'ws.close', 'openai', {}); });
  }
}

function dashboardHtml() {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>voice-rt-svc dashboard</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 20px; }
    .row { margin: 12px 0; }
    textarea, input, select { width: 100%; padding: 8px; }
    .log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f7f7f7; padding: 8px; border: 1px solid #ddd; height: 260px; overflow: auto; }
    .ok { color: #0a0; }
    .bad { color: #a00; }
    .flex { display: flex; gap: 12px; }
    .col { flex: 1; }
    .small { font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <h2>voice-rt-svc</h2>
  <div class="row small">Basic-auth protected pages; configure via APP_CONFIG</div>

  <div class="flex">
    <div class="col">
      <h3>Create test call</h3>
      <div class="row"><label>To (E.164): <input id="to" placeholder="+15551234567" /></label></div>
      <div class="row"><label>Scenario ID (optional): <input id="scenarioId" placeholder="mql_qualify_v1" /></label></div>
      <div class="row"><label>Guidelines (optional): <textarea id="guidelines" rows="4" placeholder="Per-call prompt overrides"></textarea></label></div>
      <div class="row"><button id="btnCall">Place Call</button></div>
      <div class="row small">After creating the call, this page opens a WS to stream events.</div>
    </div>
    <div class="col">
      <h3>Config doctor</h3>
      <div id="doctor" class="row small">Loading…</div>
      <h3>Live events</h3>
      <div class="log" id="log"></div>
      <div class="row"><button id="btnCopy">Copy NDJSON</button></div>
    </div>
  </div>

  <script>
  const logEl = document.getElementById('log');
  let currentCallId = null;
  let ndjson = [];

  function appendLog(obj) {
    const line = JSON.stringify(obj);
    ndjson.push(line);
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 5;
    logEl.textContent += (logEl.textContent ? '\n' : '') + line;
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  async function loadDoctor() {
    try {
      const r = await fetch('/admin/config/validate');
      const j = await r.json();
      const el = document.getElementById('doctor');
      el.innerHTML = '';
      const ok = document.createElement('div');
      ok.className = j.ok ? 'ok' : 'bad';
      ok.textContent = j.ok ? 'CONFIG OK' : 'CONFIG MISSING KEYS';
      el.appendChild(ok);
      if (!j.ok) {
        const miss = document.createElement('div');
        miss.textContent = 'Missing: ' + j.missing.join(', ');
        el.appendChild(miss);
      }
    } catch (e) {
      document.getElementById('doctor').textContent = 'Error loading config: ' + e.message;
    }
  }

  async function createCall() {
    const to = document.getElementById('to').value.trim();
    const scenarioId = document.getElementById('scenarioId').value.trim() || undefined;
    const guidelines = document.getElementById('guidelines').value.trim() || undefined;
    const r = await fetch('/test-call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, scenarioId, guidelines }) });
    if (!r.ok) { alert('Failed to create call'); return; }
    const j = await r.json();
    currentCallId = j.id;
    openWs(j.id);
  }

  function openWs(id) {
    appendLog({ kind: 'debug', msg: 'Opening WS for call ' + id });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws/calls/' + id);
    ws.onmessage = (ev) => {
      try { appendLog(JSON.parse(ev.data)); } catch (_) { appendLog({ raw: String(ev.data) }); }
    };
    ws.onopen = () => appendLog({ kind: 'ws', msg: 'open' });
    ws.onclose = () => appendLog({ kind: 'ws', msg: 'close' });
    ws.onerror = (e) => appendLog({ kind: 'ws', msg: 'error', error: e.message });
  }

  document.getElementById('btnCall').addEventListener('click', createCall);
  document.getElementById('btnCopy').addEventListener('click', () => {
    const text = ndjson.join('\n');
    navigator.clipboard.writeText(text).then(() => alert('Copied NDJSON to clipboard'));
  });

  loadDoctor();
  </script>
  </body></nhtml>`;
  return html;
}

// Start
main().catch((err) => {
  log('error', 'FATAL', { error: err?.message });
  process.exit(1);
});
