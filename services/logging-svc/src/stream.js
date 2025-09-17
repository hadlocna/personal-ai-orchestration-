const dayjs = require('dayjs');

const clients = new Set();

function registerStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  sendEvent(res, 'heartbeat', { ts: dayjs().toISOString() });

  clients.add(res);

  reqOnClose(res, () => {
    clients.delete(res);
  });
}

function broadcastLog(log) {
  sendEventToAll('log', log);
}

function broadcastEvent(event) {
  sendEventToAll('event', event);
}

function sendEventToAll(type, payload) {
  for (const res of clients) {
    sendEvent(res, type, payload);
  }
}

function sendEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function reqOnClose(res, handler) {
  const cleanup = () => {
    res.removeListener('close', cleanup);
    res.removeListener('error', cleanup);
    handler();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

module.exports = {
  registerStream,
  broadcastLog,
  broadcastEvent
};
