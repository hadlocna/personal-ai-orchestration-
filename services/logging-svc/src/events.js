const {
  insertLog,
  insertTaskEvent
} = require('./db');
const { broadcastLog, broadcastEvent } = require('./stream');

async function recordLog(payload) {
  const log = await insertLog(payload);
  broadcastLog(log);
  return log;
}

async function recordTaskEvent({ taskId, actor, kind, data, correlationId, traceId }) {
  const persisted = await insertTaskEvent({
    taskId,
    actor,
    kind,
    data,
    correlationId,
    traceId
  });

  const event = {
    id: persisted.id,
    taskId: persisted.task_id,
    actor: persisted.actor,
    kind: persisted.kind,
    data: persisted.data ?? null,
    correlationId: persisted.correlation_id ?? null,
    traceId: persisted.trace_id ?? null,
    ts: persisted.ts_utc
  };

  broadcastEvent(event);
  return event;
}

module.exports = {
  recordLog,
  recordTaskEvent
};
