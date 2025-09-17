const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const {
  insertLog
} = require('./db');
const { broadcastLog, broadcastEvent } = require('./stream');

async function recordLog(payload) {
  const log = await insertLog(payload);
  broadcastLog(log);
  return log;
}

async function recordTaskEvent({ taskId, actor, kind, data, correlationId, traceId }) {
  const event = {
    id: uuidv4(),
    taskId,
    actor,
    kind,
    data: data || null,
    correlationId: correlationId || null,
    traceId: traceId || null,
    ts: dayjs().toISOString()
  };
  broadcastEvent(event);
  return event;
}

module.exports = {
  recordLog,
  recordTaskEvent
};
