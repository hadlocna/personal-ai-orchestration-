const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth,
  createServiceLogger,
  createDashboardCors
} = require('@repo/common');

const {
  initDb,
  createTask,
  getTaskWithEvents,
  listTasks,
  applyTaskPatch,
  ConflictError,
  pool
} = require('./db');
const { setupWebsocket } = require('./websocket');
const { startLogForwarder } = require('./log-forwarder');
const { HandlerRegistry } = require('./handler-registry');

const SERVICE_NAME = 'orchestrator-svc';
const PORT = process.env.PORT || 4000;

const AgentDispatchStatus = {
  DEFERRED: 'deferred',
  COMPLETED: 'completed'
};

let handlerRegistry = null;

async function createService() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  await initDb();
  handlerRegistry = await HandlerRegistry.build();

  const app = express();
  const server = http.createServer(app);
  const wsHub = setupWebsocket(server);
  const logger = createServiceLogger({
    service: SERVICE_NAME,
    loggingUrl: process.env.LOGGING_URL,
    broadcast: ({ type, data }) => wsHub.broadcast(type, data)
  });
  const dashboardCors = createDashboardCors();

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
  app.use(dashboardCors);
  app.use(requireAuth());

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ service: SERVICE_NAME, status: 'error', error: err.message });
    }
  });

  app.get('/config/validate', (req, res) => {
    const report = buildConfigReport(SERVICE_NAME);
    res.json(report);
  });

  // Integration diagnostics
  app.get('/integrations/twilio', async (req, res) => {
    try {
      const result = await testTwilio();
      res.json(result);
    } catch (err) {
      res.status(500).json({ overall: 'error', error: err.message });
    }
  });

  app.get('/integrations/hubspot', async (req, res) => {
    try {
      const result = await testHubspot();
      res.json(result);
    } catch (err) {
      res.status(500).json({ overall: 'error', error: err.message });
    }
  });

  app.get('/integrations/openai', async (req, res) => {
    try {
      const result = await testOpenAi();
      res.json(result);
    } catch (err) {
      res.status(500).json({ overall: 'error', error: err.message });
    }
  });

  app.get('/integrations/google', async (req, res) => {
    try {
      const result = await testGoogle();
      res.json(result);
    } catch (err) {
      res.status(500).json({ overall: 'error', error: err.message });
    }
  });

  app.get('/ws', (req, res) => {
    res.status(426).json({ error: 'Upgrade Required' });
  });

  app.post('/task', async (req, res) => {
    const { type, payload, source, correlationId, agentSlug } = req.body || {};

    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type is required' });
    }

    if (!source || typeof source !== 'string') {
      return res.status(400).json({ error: 'source is required' });
    }

    let handler = null;
    if (agentSlug && typeof agentSlug === 'string') {
      if (!handlerRegistry) {
        handlerRegistry = await HandlerRegistry.build();
      }
      const bySlug = handlerRegistry.getBySlug(agentSlug);
      if (bySlug && Array.isArray(bySlug.taskTypes) && bySlug.taskTypes.includes(type)) {
        handler = bySlug;
      }
    }
    if (!handler) {
      handler = await resolveHandlerForTaskType(type);
    }
    if (!handler) {
      logger.warn('TASK_TYPE_UNSUPPORTED', { data: { type } });
      return res.status(422).json({ error: `Unsupported task type: ${type}` });
    }
    const agentDescriptor = buildAgentDescriptor(handler);

    const traceId = uuidv4();

    try {
      const { task, event, assignmentEvent } = await createTask({
        type,
        payload: payload ?? {},
        source,
        correlationId,
        traceId,
        actor: deriveActor(req),
        agent: agentDescriptor
      });

      logger.info('TASK_RECEIVED', {
        data: {
          id: task.id,
          type,
          source,
          correlationId: correlationId || null,
          agent: agentDescriptor.slug || null,
          channel: agentDescriptor.channel || null
        }
      });
      if (event) {
        logger.taskEvent({
          taskId: task.id,
          actor: event.actor,
          kind: event.kind,
          data: event.data,
          traceId: task.trace_id,
          correlationId: task.correlation_id
        });
      }
      if (assignmentEvent) {
        logger.taskEvent({
          taskId: task.id,
          actor: assignmentEvent.actor,
          kind: assignmentEvent.kind,
          data: assignmentEvent.data,
          traceId: assignmentEvent.trace_id,
          correlationId: assignmentEvent.correlation_id
        });
      }

      wsHub.broadcast('TASK_UPDATE', { task });

      queueMicrotask(() => processTask(task, { wsHub, logger }));

      res.status(202).json({
        id: task.id,
        traceId: task.trace_id,
        status: task.status,
        agent: formatAgentMeta(task)
      });
    } catch (err) {
      console.error('Failed to create task', err);
      logger.error('TASK_CREATE_FAILED', {
        data: { error: err.message, type, source },
        correlationId: correlationId || null
      });
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  app.get('/task/:id', async (req, res) => {
    try {
      const result = await getTaskWithEvents(req.params.id);
      if (!result) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(result);
    } catch (err) {
      console.error('Failed to fetch task', err);
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  app.get('/tasks', async (req, res) => {
    try {
      if (req.query.since && Number.isNaN(Date.parse(req.query.since))) {
        return res.status(400).json({ error: 'Invalid since parameter' });
      }

      const since = req.query.since ? new Date(req.query.since).toISOString() : undefined;
      let limit;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isFinite(limit) || limit <= 0 || limit > 200) {
          return res.status(400).json({ error: 'Invalid limit parameter' });
        }
      }

      const tasks = await listTasks({
        status: req.query.status,
        since,
        correlationId: req.query.corrId,
        limit
      });

      res.json({ tasks });
    } catch (err) {
      console.error('Failed to list tasks', err);
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  app.patch('/task/:id', async (req, res) => {
    const { ifVersion, status, result, error, payload, correlationId } = req.body || {};

    if (typeof ifVersion !== 'number') {
      return res.status(400).json({ error: 'ifVersion (number) is required' });
    }

    const patch = {};
    if (status !== undefined) patch.status = status;
    if (result !== undefined) patch.result = result;
    if (error !== undefined) patch.error = error;
    if (payload !== undefined) patch.payload = payload;
    if (correlationId !== undefined) patch.correlationId = correlationId;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to patch' });
    }

    try {
      const { task, event: persistedEvent } = await applyTaskPatch({
        id: req.params.id,
        ifVersion,
        patch,
        event: buildPatchEvent({ patch, actor: deriveActor(req) })
      });
      wsHub.broadcast('TASK_UPDATE', { task });
      if (persistedEvent) {
        logger.taskEvent({
          taskId: task.id,
          actor: persistedEvent.actor,
          kind: persistedEvent.kind,
          data: persistedEvent.data,
          traceId: task.trace_id,
          correlationId: task.correlation_id
        });
      }
      res.json({ task });
    } catch (err) {
      if (err instanceof ConflictError) {
        logger.warn('TASK_PATCH_CONFLICT', {
          data: { id: req.params.id, requestedVersion: ifVersion }
        });
        return res.status(409).json({ error: 'Version conflict' });
      }
      console.error('Failed to patch task', err);
      logger.error('TASK_PATCH_FAILED', {
        data: { id: req.params.id, error: err.message }
      });
      res.status(500).json({ error: 'Failed to patch task' });
    }
  });

  // OAuth Routes
  app.get('/oauth/google/status', async (req, res) => {
    try {
      const scopes = req.query.scopes ? req.query.scopes.split(',') : ['gmail', 'calendar'];
      const tokens = await getOAuthTokens('google', scopes);

      logger.info('OAUTH_STATUS_CHECK', {
        data: {
          provider: 'google',
          requestedScopes: scopes,
          hasTokens: tokens.map(t => ({ scope: t.scope_group, hasToken: !!t.access_token, expires: t.expires_at }))
        }
      });

      res.json({
        provider: 'google',
        tokens: tokens.map(token => ({
          scope_group: token.scope_group,
          scopes: token.scopes || [],
          has_token: !!token.access_token,
          expires_at: token.expires_at,
          is_expired: token.expires_at ? new Date(token.expires_at) < new Date() : false
        }))
      });
    } catch (err) {
      logger.error('OAUTH_STATUS_ERROR', { data: { error: err.message } });
      res.status(500).json({ error: 'Failed to check OAuth status' });
    }
  });

  app.get('/oauth/google/authorize', async (req, res) => {
    try {
      const scope_group = req.query.scope_group || 'gmail';
      const state = crypto.randomBytes(32).toString('hex');

      // Store state for validation
      const stateKey = `oauth_state:${state}`;
      await pool.query(
        'INSERT INTO oauth_tokens (provider, scope_group, user_identifier, encrypted_access_token, metadata) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, scope_group, user_identifier) DO UPDATE SET metadata = $5, updated_at = NOW()',
        ['google', 'state', state, 'pending', { expires_at: new Date(Date.now() + 10 * 60 * 1000) }] // 10 min expiry
      );

      const scopes = getScopesForGroup(scope_group);
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
        scope: scopes.join(' '),
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        state: `${scope_group}:${state}`
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      logger.info('OAUTH_AUTHORIZE_REDIRECT', {
        data: {
          provider: 'google',
          scope_group,
          scopes,
          state: state.substring(0, 8) + '...' // Log partial state for debugging
        }
      });

      res.json({ auth_url: authUrl });
    } catch (err) {
      logger.error('OAUTH_AUTHORIZE_ERROR', { data: { error: err.message } });
      res.status(500).json({ error: 'Failed to generate authorization URL' });
    }
  });

  app.get('/oauth/google/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        logger.warn('OAUTH_CALLBACK_ERROR', { data: { error, state } });
        return res.status(400).send(`OAuth error: ${error}`);
      }

      if (!code || !state) {
        logger.warn('OAUTH_CALLBACK_MISSING_PARAMS', { data: { hasCode: !!code, hasState: !!state } });
        return res.status(400).send('Missing code or state parameter');
      }

      const [scope_group, stateToken] = state.split(':');
      if (!scope_group || !stateToken) {
        logger.warn('OAUTH_CALLBACK_INVALID_STATE', { data: { state } });
        return res.status(400).send('Invalid state parameter');
      }

      // Verify state
      const stateResult = await pool.query(
        'SELECT * FROM oauth_tokens WHERE provider = $1 AND scope_group = $2 AND user_identifier = $3',
        ['google', 'state', stateToken]
      );

      if (stateResult.rows.length === 0) {
        logger.warn('OAUTH_CALLBACK_STATE_NOT_FOUND', { data: { stateToken: stateToken.substring(0, 8) + '...' } });
        return res.status(400).send('Invalid or expired state');
      }

      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.error('OAUTH_TOKEN_EXCHANGE_FAILED', {
          data: {
            status: tokenResponse.status,
            error: errorText.substring(0, 200)
          }
        });
        return res.status(500).send('Failed to exchange authorization code');
      }

      const tokens = await tokenResponse.json();

      // Encrypt tokens
      const encryptedAccessToken = encryptToken(tokens.access_token);
      const encryptedRefreshToken = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null;
      const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

      // Store tokens
      await pool.query(
        `INSERT INTO oauth_tokens (provider, scope_group, user_identifier, encrypted_access_token, encrypted_refresh_token, expires_at, scopes, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider, scope_group, user_identifier)
         DO UPDATE SET
           encrypted_access_token = $4,
           encrypted_refresh_token = $5,
           expires_at = $6,
           scopes = $7,
           metadata = $8,
           updated_at = NOW()`,
        [
          'google',
          scope_group,
          'default',
          encryptedAccessToken,
          encryptedRefreshToken,
          expiresAt,
          tokens.scope ? tokens.scope.split(' ') : getScopesForGroup(scope_group),
          { token_type: tokens.token_type }
        ]
      );

      // Clean up state token
      await pool.query(
        'DELETE FROM oauth_tokens WHERE provider = $1 AND scope_group = $2 AND user_identifier = $3',
        ['google', 'state', stateToken]
      );

      logger.info('OAUTH_TOKEN_STORED', {
        data: {
          provider: 'google',
          scope_group,
          scopes: tokens.scope ? tokens.scope.split(' ') : getScopesForGroup(scope_group),
          expires_at: expiresAt
        }
      });

      res.send(`
        <html>
          <head><title>Authorization Complete</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>✅ Authorization Successful</h1>
            <p>Google ${scope_group} access has been granted and stored securely.</p>
            <p><a href="#" onclick="window.close()">Close this window</a></p>
            <script>
              setTimeout(() => window.close(), 3000);
              if (window.opener) {
                window.opener.postMessage({
                  type: 'oauth_complete',
                  provider: 'google',
                  scope_group: '${scope_group}',
                  success: true
                }, '*');
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      logger.error('OAUTH_CALLBACK_ERROR', { data: { error: err.message, stack: err.stack } });
      res.status(500).send(`
        <html>
          <head><title>Authorization Failed</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>❌ Authorization Failed</h1>
            <p>An error occurred while processing the authorization.</p>
            <p><a href="#" onclick="window.close()">Close this window</a></p>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'oauth_complete',
                  provider: 'google',
                  success: false,
                  error: 'Authorization processing failed'
                }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }
  });

  app.delete('/oauth/google/:scope_group', async (req, res) => {
    try {
      const { scope_group } = req.params;

      const result = await pool.query(
        'DELETE FROM oauth_tokens WHERE provider = $1 AND scope_group = $2 AND user_identifier = $3',
        ['google', scope_group, 'default']
      );

      logger.info('OAUTH_TOKEN_REVOKED', {
        data: {
          provider: 'google',
          scope_group,
          deleted_count: result.rowCount
        }
      });

      res.json({
        success: true,
        message: `Google ${scope_group} authorization revoked`,
        deleted_count: result.rowCount
      });
    } catch (err) {
      logger.error('OAUTH_REVOKE_ERROR', { data: { error: err.message } });
      res.status(500).json({ error: 'Failed to revoke authorization' });
    }
  });

  // Temporary migration endpoint - remove after OAuth table is created
  app.post('/admin/apply-oauth-migration', async (req, res) => {
    try {
      logger.info('ADMIN_OAUTH_MIGRATION_REQUESTED', { data: { requester: deriveActor(req) } });

      // Check if table already exists
      const checkResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'oauth_tokens'
      `);

      if (checkResult.rows.length > 0) {
        logger.info('ADMIN_OAUTH_MIGRATION_ALREADY_EXISTS');
        return res.json({
          success: true,
          message: 'oauth_tokens table already exists',
          action: 'none'
        });
      }

      // Apply the OAuth migration
      const migrationSQL = `
        BEGIN;

        CREATE EXTENSION IF NOT EXISTS "pgcrypto";

        CREATE TABLE IF NOT EXISTS oauth_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            provider TEXT NOT NULL,
            scope_group TEXT NOT NULL, -- 'gmail', 'calendar', 'combined'
            user_identifier TEXT NOT NULL DEFAULT 'default', -- for future multi-user support
            encrypted_access_token TEXT NOT NULL,
            encrypted_refresh_token TEXT,
            expires_at TIMESTAMPTZ,
            scopes TEXT[], -- actual granted scopes
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(provider, scope_group, user_identifier)
        );

        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens (provider, scope_group);
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);

        CREATE TRIGGER trg_oauth_tokens_updated_at
        BEFORE UPDATE ON oauth_tokens
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at_timestamp();

        COMMIT;
      `;

      await pool.query(migrationSQL);

      logger.info('ADMIN_OAUTH_MIGRATION_APPLIED');

      // Verify table creation
      const verifyResult = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'oauth_tokens'
        ORDER BY ordinal_position
      `);

      res.json({
        success: true,
        message: 'OAuth migration applied successfully',
        table_columns: verifyResult.rows.map(row => `${row.column_name} (${row.data_type})`)
      });

    } catch (err) {
      logger.error('ADMIN_OAUTH_MIGRATION_ERROR', { data: { error: err.message, stack: err.stack } });
      res.status(500).json({
        error: 'Failed to apply OAuth migration',
        details: err.message
      });
    }
  });

  startLogForwarder({ logger, wsHub, loggingUrl: process.env.LOGGING_URL });

  return { app, server, wsHub, logger };
}

function deriveActor(req) {
  if (req.authUser === 'internal') return 'internal';
  return `human:${req.authUser || 'unknown'}`;
}

function buildPatchEvent({ patch, actor }) {
  if (patch.status) {
    return {
      actor,
      kind: 'status_change',
      data: { status: patch.status }
    };
  }

  if (patch.result !== undefined) {
    return {
      actor,
      kind: 'result',
      data: { preview: previewResult(patch.result) }
    };
  }

  if (patch.error !== undefined) {
    return {
      actor,
      kind: 'error',
      data: patch.error
    };
  }

  if (patch.payload !== undefined) {
    return {
      actor,
      kind: 'log',
      data: { message: 'payload updated' }
    };
  }

  return null;
}

function previewResult(result) {
  const str = JSON.stringify(result);
  if (!str) return null;
  return str.slice(0, 256);
}

function emitAgentEvent({ logger, baseTask, agent, event }) {
  if (!event || !event.kind) return;

  logger.taskEvent({
    taskId: baseTask.id,
    actor: event.actor || agent.slug,
    kind: event.kind,
    data: event.data ?? null,
    traceId: baseTask.trace_id,
    correlationId: baseTask.correlation_id
  });
}

function normalizeAgentResponse(response) {
  if (!response || typeof response !== 'object') {
    return { status: AgentDispatchStatus.COMPLETED, result: response }; 
  }

  if (response.status === AgentDispatchStatus.DEFERRED || response.status === AgentDispatchStatus.COMPLETED) {
    return response;
  }

  if (response.status && typeof response.status === 'string') {
    return response;
  }

  return { status: AgentDispatchStatus.COMPLETED, result: response };
}

function buildAgentResult(agent, payload, extras = {}) {
  const envelope = {
    agent: {
      slug: agent.slug,
      channel: agent.channel
    },
    ...cleanExtras(extras)
  };

  if (payload !== undefined) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      envelope.output = payload;
    } else {
      envelope.output = payload ?? null;
    }
  } else if (envelope.output === undefined) {
    envelope.output = null;
  }

  return envelope;
}

function cleanExtras(extras) {
  if (!extras || typeof extras !== 'object') return {};
  return Object.fromEntries(
    Object.entries(extras).filter(([, value]) => value !== undefined)
  );
}

async function resolveHandlerForTaskType(taskType) {
  if (!taskType) return null;
  if (!handlerRegistry) {
    handlerRegistry = await HandlerRegistry.build();
  }
  let handler = handlerRegistry.resolve(taskType);
  if (handler) return handler;

  handlerRegistry = await HandlerRegistry.build();
  handler = handlerRegistry.resolve(taskType);
  return handler || null;
}

async function resolveHandlerForExistingTask(task) {
  if (!handlerRegistry) {
    handlerRegistry = await HandlerRegistry.build();
  }

  let handler = null;
  if (task.agent_slug) {
    handler = handlerRegistry.getBySlug(task.agent_slug);
  }
  if (!handler) {
    handler = handlerRegistry.resolve(task.type);
  }
  if (handler) return handler;

  handlerRegistry = await HandlerRegistry.build();
  if (task.agent_slug) {
    handler = handlerRegistry.getBySlug(task.agent_slug);
  }
  if (!handler) {
    handler = handlerRegistry.resolve(task.type);
  }
  return handler || null;
}

function buildAgentDescriptor(handler, fallback = {}) {
  if (!handler) {
    return {
      id: fallback.agent_id || null,
      slug: fallback.agent_slug || null,
      displayName: fallback.agent_display_name || fallback.agent_slug || null,
      channel: fallback.agent_channel || null
    };
  }

  return {
    id: handler.id || null,
    slug: handler.slug || null,
    displayName: handler.displayName || handler.slug || null,
    channel: handler.channel || null
  };
}

function formatAgentMeta(task) {
  if (!task) return null;
  const meta = {
    id: task.agent_id || null,
    slug: task.agent_slug || null,
    displayName: task.agent_display_name || task.agent_slug || null,
    channel: task.agent_channel || null
  };
  if (!meta.id && !meta.slug && !meta.displayName && !meta.channel) {
    return null;
  }
  return meta;
}

async function processTask(task, { wsHub, logger }) {
  let runningTask = task;
  let agent = null;
  try {
    const runningResult = await applyTaskPatch({
      id: task.id,
      ifVersion: task.version,
      patch: { status: 'running' },
      event: {
        actor: 'orchestrator',
        kind: 'status_change',
        data: { from: 'queued', to: 'running' }
      }
    });
    runningTask = runningResult.task;
    wsHub.broadcast('TASK_UPDATE', { task: runningTask });
    if (runningResult.event) {
      logger.taskEvent({
        taskId: runningTask.id,
        actor: runningResult.event.actor,
        kind: runningResult.event.kind,
        data: runningResult.event.data,
        traceId: runningTask.trace_id,
        correlationId: runningTask.correlation_id
      });
    }

    const handler = await resolveHandlerForExistingTask(runningTask);
    if (!handler) {
      throw new Error(`UNSUPPORTED_TYPE:${task.type}`);
    }
    agent = handler;

    logger.info('TASK_RUNNING', {
      data: {
        id: task.id,
        type: task.type,
        agent: handler.slug,
        channel: handler.channel
      },
      traceId: task.trace_id,
      correlationId: task.correlation_id
    });

    let agentResponse;
    if (handler.mode === 'inline' && typeof handler.execute === 'function') {
      agentResponse = await handler.execute({ task: runningTask, logger });
    } else if (typeof handler.dispatch === 'function') {
      agentResponse = await handler.dispatch({
        task: runningTask,
        logger,
        emitTaskEvent: (event) => emitAgentEvent({
          logger,
          baseTask: runningTask,
          agent: handler,
          event
        })
      });
    } else {
      throw new Error(`Agent for ${task.type} does not implement execute/dispatch`);
    }

    const normalized = normalizeAgentResponse(agentResponse);

    if (normalized.status === AgentDispatchStatus.DEFERRED) {
      if (normalized.result || normalized.ack || normalized.metadata) {
        const agentResult = buildAgentResult(handler, normalized.result || null, {
          status: 'pending',
          ack: normalized.ack || null,
          metadata: normalized.metadata || null
        });

        const { task: pendingTask, event } = await applyTaskPatch({
          id: runningTask.id,
          ifVersion: runningTask.version,
          patch: { result: agentResult },
          event: {
            actor: handler.slug,
            kind: 'dispatch_ack',
            data: agentResult
          }
        });

        runningTask = pendingTask;
        wsHub.broadcast('TASK_UPDATE', { task: pendingTask });

        if (event) {
          logger.taskEvent({
            taskId: pendingTask.id,
            actor: event.actor,
            kind: event.kind,
            data: event.data,
            traceId: pendingTask.trace_id,
            correlationId: pendingTask.correlation_id
          });
        }
      }

      logger.info('TASK_DISPATCHED', {
        data: { id: task.id, type: task.type, agent: handler.slug, channel: handler.channel },
        traceId: task.trace_id,
        correlationId: task.correlation_id
      });

      return;
    }

    const agentResult = buildAgentResult(handler, normalized.result, { status: 'completed' });

    const completedResult = await applyTaskPatch({
      id: task.id,
      ifVersion: runningTask.version,
      patch: { status: 'done', result: agentResult },
      event: {
        actor: 'orchestrator',
        kind: 'result',
        data: { preview: previewResult(agentResult) }
      }
    });

    const completedTask = completedResult.task;

    wsHub.broadcast('TASK_UPDATE', { task: completedTask });
    logger.info('TASK_COMPLETED', {
      data: { id: task.id, type: task.type, agent: handler.slug, channel: handler.channel },
      traceId: task.trace_id,
      correlationId: task.correlation_id
    });
    if (completedResult.event) {
      logger.taskEvent({
        taskId: completedTask.id,
        actor: completedResult.event.actor,
        kind: completedResult.event.kind,
        data: completedResult.event.data,
        traceId: completedTask.trace_id,
        correlationId: completedTask.correlation_id
      });
    }
  } catch (err) {
    console.error('Task processing failed', err);
    logger.error('TASK_FAILED', {
      data: { id: task.id, type: task.type, agent: agent?.slug || null, error: err.message },
      traceId: task.trace_id,
      correlationId: task.correlation_id
    });
    const latestVersion = runningTask?.version ?? task.version;
    try {
      const erroredResult = await applyTaskPatch({
        id: task.id,
        ifVersion: latestVersion,
        patch: {
          status: 'error',
          error: { message: err.message }
        },
        event: {
          actor: 'orchestrator',
          kind: 'error',
          data: { message: err.message }
        }
      });
      const erroredTask = erroredResult.task;
      wsHub.broadcast('TASK_UPDATE', { task: erroredTask });
      if (erroredResult.event) {
        logger.taskEvent({
          taskId: erroredTask.id,
          actor: erroredResult.event.actor,
          kind: erroredResult.event.kind,
          data: erroredResult.event.data,
          traceId: erroredTask.trace_id,
          correlationId: erroredTask.correlation_id
        });
      }
    } catch (patchErr) {
      console.error('Failed to mark task as error', patchErr);
      logger.error('TASK_ERROR_PATCH_FAILED', {
        data: { id: task.id, error: patchErr.message }
      });
    }
  }
}

async function start() {
  const { server } = await createService();
  server.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal orchestrator error', err);
    process.exit(1);
  });
}

module.exports = {
  createService,
  processTask
};

// -------- Integration Tests (server-side) --------
async function testTwilio() {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const baseUrl = (process.env.TWILIO_API_BASE_URL || process.env.TWILIO_BASE_URL || 'https://api.twilio.com').trim();
  if (!accountSid || !authToken) {
    return { overall: 'missing', checks: [], note: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN not configured' };
  }
  const url = new URL(`/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, baseUrl).toString();
  const credentials = Buffer.from(`${accountSid}:${authToken}`, 'utf-8').toString('base64');
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' }
  });
  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 160) : '';
    throw new Error(`Twilio HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Invalid JSON from Twilio'); }
  const friendly = data.friendly_name || data.friendlyName || accountSid;
  const status = typeof data.status === 'string' && data.status.toLowerCase() !== 'active' ? 'warn' : 'ok';
  return {
    overall: status,
    checks: [{ key: 'credentials', label: 'Credentials', status, detail: `Account ${friendly}` }]
  };
}

async function testHubspot() {
  const token = (process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
  const base = (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').trim();
  if (!token) {
    return { overall: 'missing', checks: [], note: 'HUBSPOT_ACCESS_TOKEN not configured' };
  }
  const url = new URL('/crm/v3/owners/?limit=1', base).toString();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    // If scopes are missing, report as warn with detail rather than hard error
    if (response.status === 403) {
      let detail = 'Missing required scopes';
      try {
        const data = JSON.parse(text || '{}');
        if (data && data.message) detail = data.message;
      } catch (_) {}
      return {
        overall: 'warn',
        checks: [
          { key: 'scopes', label: 'Scopes', status: 'warn', detail }
        ]
      };
    }
    const snippet = text ? text.slice(0, 160) : '';
    throw new Error(`HubSpot HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Invalid JSON from HubSpot'); }
  const count = Array.isArray(data.results) ? data.results.length : 0;
  const status = count > 0 ? 'ok' : 'warn';
  const detail = count > 0 ? 'Owner data retrieved' : 'No owners returned';
  return { overall: status, checks: [{ key: 'owners', label: 'Owners', status, detail }] };
}

async function testOpenAi() {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  const base = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com').trim();
  if (!key) {
    return { overall: 'missing', checks: [], note: 'OPENAI_API_KEY not configured' };
  }
  const url = new URL('/v1/models', base).toString();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 160) : '';
    throw new Error(`OpenAI HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Invalid JSON from OpenAI'); }
  const models = Array.isArray(data.data) ? data.data.length : 0;
  const status = models > 0 ? 'ok' : 'warn';
  const detail = models > 0 ? `${models} model(s) available` : 'No models returned';
  return { overall: status, checks: [{ key: 'models', label: 'Models', status, detail }] };
}

async function testGoogle() {
  const key = (process.env.GOOGLE_API_KEY || '').trim();
  const base = (process.env.GOOGLE_API_BASE_URL || process.env.GOOGLE_BASE_URL || 'https://www.googleapis.com').trim();
  const url = new URL('/discovery/v1/apis', base);
  if (key) {
    url.searchParams.set('key', key);
  }
  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 160) : '';
    throw new Error(`Google HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Invalid JSON from Google'); }
  const apis = Array.isArray(data.items) ? data.items.length : 0;
  const status = apis > 0 ? 'ok' : 'warn';
  const detail = apis > 0 ? `${apis} API(s) listed` : 'No APIs returned';
  // If no key was provided but call succeeded, surface a warn to encourage adding a key
  const overall = key ? status : (status === 'ok' ? 'warn' : status);
  const checks = [{ key: 'discovery', label: 'Discovery', status, detail }];
  if (!key) {
    checks.push({ key: 'key', label: 'API Key', status: 'warn', detail: 'No GOOGLE_API_KEY set; using unauthenticated request' });
  }
  return { overall, checks };
}

// OAuth Helper Functions
function getScopesForGroup(scope_group) {
  const scopeMap = {
    gmail: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose'
    ],
    calendar: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    combined: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events'
    ]
  };
  return scopeMap[scope_group] || scopeMap.gmail;
}

function encryptToken(token) {
  if (!token) return null;
  const key = process.env.OAUTH_ENCRYPTION_KEY;
  if (!key || key.length < 16) {
    throw new Error('OAUTH_ENCRYPTION_KEY must be at least 16 characters');
  }
  const cipher = crypto.createCipher('aes-256-cbc', key);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;
  const key = process.env.OAUTH_ENCRYPTION_KEY;
  if (!key || key.length < 16) {
    throw new Error('OAUTH_ENCRYPTION_KEY must be at least 16 characters');
  }
  const decipher = crypto.createDecipher('aes-256-cbc', key);
  let decrypted = decipher.update(encryptedToken, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function getOAuthTokens(provider, scopeGroups) {
  const scopes = Array.isArray(scopeGroups) ? scopeGroups : [scopeGroups];
  const placeholders = scopes.map((_, i) => `$${i + 2}`).join(',');

  const result = await pool.query(
    `SELECT * FROM oauth_tokens
     WHERE provider = $1 AND scope_group IN (${placeholders}) AND user_identifier = 'default'
     ORDER BY scope_group`,
    [provider, ...scopes]
  );

  return result.rows.map(row => ({
    ...row,
    access_token: row.encrypted_access_token ? decryptToken(row.encrypted_access_token) : null,
    refresh_token: row.encrypted_refresh_token ? decryptToken(row.encrypted_refresh_token) : null
  }));
}
