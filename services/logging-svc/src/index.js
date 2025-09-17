const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');

const {
  pool,
  initDb,
  queryLogs
} = require('./db');
const { registerStream } = require('./stream');
const { recordLog, recordTaskEvent } = require('./events');

const SERVICE_NAME = 'logging-svc';
const PORT = process.env.PORT || 4001;

async function createService() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  await initDb();

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
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
    res.json(buildConfigReport(SERVICE_NAME));
  });

  app.post('/log', async (req, res) => {
    const body = req.body || {};
    const normalized = normalizeLogBody(body);

    if (!normalized.valid) {
      return res.status(400).json({ error: normalized.error });
    }

    try {
      const log = await recordLog(normalized.value);
      res.status(202).json({ log });
    } catch (err) {
      console.error('Failed to insert log', err);
      res.status(500).json({ error: 'Failed to record log' });
    }
  });

  app.get('/logs', async (req, res) => {
    if (req.query.since && Number.isNaN(Date.parse(req.query.since))) {
      return res.status(400).json({ error: 'Invalid since parameter' });
    }

    let limit;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
        return res.status(400).json({ error: 'Invalid limit parameter' });
      }
    }

    try {
      const logs = await queryLogs({
        service: req.query.service,
        level: req.query.level,
        correlationId: req.query.corrId,
        traceId: req.query.traceId,
        taskId: req.query.taskId,
        since: req.query.since ? new Date(req.query.since).toISOString() : undefined,
        limit
      });
      res.json({ logs });
    } catch (err) {
      console.error('Failed to fetch logs', err);
      res.status(500).json({ error: 'Failed to fetch logs' });
    }
  });

  app.get('/logs/stream', (req, res) => {
    registerStream(res);
  });

  app.post('/task/event', async (req, res) => {
    const normalized = normalizeTaskEvent(req.body || {});
    if (!normalized.valid) {
      return res.status(400).json({ error: normalized.error });
    }

    try {
      const event = await recordTaskEvent(normalized.value);
      res.status(202).json({ event });
    } catch (err) {
      console.error('Failed to record task event', err);
      res.status(500).json({ error: 'Failed to record task event' });
    }
  });

  return app;
}

function normalizeLogBody(body) {
  const { service, level = 'info', message, data, taskId, correlationId, traceId } = body;

  if (!service || typeof service !== 'string') {
    return { valid: false, error: 'service is required' };
  }

  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'message is required' };
  }

  const allowedLevels = new Set(['debug', 'info', 'warn', 'error']);
  if (level && !allowedLevels.has(level)) {
    return { valid: false, error: 'level must be one of debug|info|warn|error' };
  }

  return {
    valid: true,
    value: {
      service,
      level,
      message,
      data: data ?? null,
      taskId,
      correlationId,
      traceId
    }
  };
}

async function start() {
  const app = await createService();
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal logging service error', err);
    process.exit(1);
  });
}

module.exports = {
  createService
};

function normalizeTaskEvent(body) {
  const { taskId, actor, kind, data, correlationId, traceId } = body;

  if (!taskId || typeof taskId !== 'string') {
    return { valid: false, error: 'taskId is required' };
  }

  if (!actor || typeof actor !== 'string') {
    return { valid: false, error: 'actor is required' };
  }

  if (!kind || typeof kind !== 'string') {
    return { valid: false, error: 'kind is required' };
  }

  return {
    valid: true,
    value: {
      taskId,
      actor,
      kind,
      data: data ?? null,
      correlationId: correlationId || null,
      traceId: traceId || null
    }
  };
}
