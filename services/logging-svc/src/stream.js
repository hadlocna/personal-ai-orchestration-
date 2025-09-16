const clients = new Set();

function registerStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  clients.add(res);

  reqOnClose(res, () => {
    clients.delete(res);
  });
}

function broadcastLog(log) {
  const frame = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
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
  broadcastLog
};
