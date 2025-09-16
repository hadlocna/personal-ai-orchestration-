const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth,
  internalFetch
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

const SERVICE_NAME = 'orchestrator-svc';
const PORT = process.env.PORT || 4000;
const ECHO_AGENT_BASE = process.env.ECHO_AGENT_URL;

async function createService() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  await initDb();

  const app = express();
  const server = http.createServer(app);
  const wsHub = setupWebsocket(server);

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
    const report = buildConfigReport(SERVICE_NAME);
    res.json(report);
  });

  app.get('/ws', (req, res) => {
    res.status(426).json({ error: 'Upgrade Required' });
  });

  app.post('/task', async (req, res) => {
    const { type, payload, source, correlationId } = req.body || {};

    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type is required' });
    }

    if (!source || typeof source !== 'string') {
      return res.status(400).json({ error: 'source is required' });
    }

    const traceId = uuidv4();

    try {
      const task = await createTask({
        type,
        payload: payload ?? {},
        source,
        correlationId,
        traceId,
        actor: deriveActor(req)
      });

      wsHub.broadcast('TASK_UPDATE', { task });

      queueMicrotask(() => processTask(task, wsHub));

      res.status(202).json({ id: task.id, traceId: task.trace_id, status: task.status });
    } catch (err) {
      console.error('Failed to create task', err);
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
      const task = await applyTaskPatch({
        id: req.params.id,
        ifVersion,
        patch,
        event: buildPatchEvent({ patch, actor: deriveActor(req) })
      });
      wsHub.broadcast('TASK_UPDATE', { task });
      res.json({ task });
    } catch (err) {
      if (err instanceof ConflictError) {
        return res.status(409).json({ error: 'Version conflict' });
      }
      console.error('Failed to patch task', err);
      res.status(500).json({ error: 'Failed to patch task' });
    }
  });

  return { app, server, wsHub };
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

async function processTask(task, wsHub) {
  let runningTask = task;
  try {
    runningTask = await applyTaskPatch({
      id: task.id,
      ifVersion: task.version,
      patch: { status: 'running' },
      event: {
        actor: 'orchestrator',
        kind: 'status_change',
        data: { from: 'queued', to: 'running' }
      }
    });
    wsHub.broadcast('TASK_UPDATE', { task: runningTask });

    const handler = getHandlerForType(task.type);
    const result = await handler({ task: runningTask });

    const completedTask = await applyTaskPatch({
      id: task.id,
      ifVersion: runningTask.version,
      patch: { status: 'done', result },
      event: {
        actor: 'orchestrator',
        kind: 'result',
        data: { preview: previewResult(result) }
      }
    });

    wsHub.broadcast('TASK_UPDATE', { task: completedTask });
  } catch (err) {
    console.error('Task processing failed', err);
    const latestVersion = runningTask?.version ?? task.version;
    try {
      const erroredTask = await applyTaskPatch({
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
      wsHub.broadcast('TASK_UPDATE', { task: erroredTask });
    } catch (patchErr) {
      console.error('Failed to mark task as error', patchErr);
    }
  }
}

function getHandlerForType(type) {
  switch (type) {
    case 'echo':
      return handleEchoTask;
    default:
      throw new Error(`UNSUPPORTED_TYPE:${type}`);
  }
}

async function handleEchoTask({ task }) {
  if (!ECHO_AGENT_BASE) {
    throw new Error('ECHO_AGENT_URL not configured');
  }

  const url = new URL('/echo', ECHO_AGENT_BASE).toString();
  const response = await internalFetch(url, {
    method: 'POST',
    body: {
      traceId: task.trace_id,
      payload: task.payload
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Echo agent error: ${response.status} ${text}`);
  }

  return response.json();
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
  processTask,
  handleEchoTask
};
