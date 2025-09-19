const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

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
const {
  registerDefaultAgents,
  findAgentForType,
  AgentDispatchStatus
} = require('./agent-registry');

const SERVICE_NAME = 'orchestrator-svc';
const PORT = process.env.PORT || 4000;

async function createService() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  await initDb();
  registerDefaultAgents();

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
      const { task, event } = await createTask({
        type,
        payload: payload ?? {},
        source,
        correlationId,
        traceId,
        actor: deriveActor(req)
      });

      logger.info('TASK_RECEIVED', {
        data: { id: task.id, type, source, correlationId: correlationId || null }
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

      wsHub.broadcast('TASK_UPDATE', { task });

      queueMicrotask(() => processTask(task, { wsHub, logger }));

      res.status(202).json({ id: task.id, traceId: task.trace_id, status: task.status });
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

    agent = findAgentForType(task.type);
    if (!agent) {
      throw new Error(`UNSUPPORTED_TYPE:${task.type}`);
    }

    logger.info('TASK_RUNNING', {
      data: { id: task.id, type: task.type, agent: agent.slug, channel: agent.channel },
      traceId: task.trace_id,
      correlationId: task.correlation_id
    });

    logger.taskEvent({
      taskId: runningTask.id,
      actor: 'orchestrator',
      kind: 'assignment',
      data: {
        agent: agent.slug,
        channel: agent.channel
      },
      traceId: runningTask.trace_id,
      correlationId: runningTask.correlation_id
    });

    const agentResponse = await agent.dispatch({
      task: runningTask,
      logger,
      emitTaskEvent: (event) => emitAgentEvent({
        logger,
        baseTask: runningTask,
        agent,
        event
      })
    });

    const normalized = normalizeAgentResponse(agentResponse);

    if (normalized.status === AgentDispatchStatus.DEFERRED) {
      if (normalized.result || normalized.ack || normalized.metadata) {
        const agentResult = buildAgentResult(agent, normalized.result || null, {
          status: 'pending',
          ack: normalized.ack || null,
          metadata: normalized.metadata || null
        });

        const { task: pendingTask, event } = await applyTaskPatch({
          id: runningTask.id,
          ifVersion: runningTask.version,
          patch: { result: agentResult },
          event: {
            actor: agent.slug,
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
        data: { id: task.id, type: task.type, agent: agent.slug, channel: agent.channel },
        traceId: task.trace_id,
        correlationId: task.correlation_id
      });

      return;
    }

    const agentResult = buildAgentResult(agent, normalized.result, { status: 'completed' });

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
      data: { id: task.id, type: task.type, agent: agent.slug, channel: agent.channel },
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
