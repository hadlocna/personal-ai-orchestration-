const { WebSocketServer } = require('ws');

function setupWebsocket(server) {
  const clients = new Set();
  const allowedOrigins = parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS);
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (request, socket, head) => {
    if (!request.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    const { origin } = request.headers;
    if (!isOriginAllowed(allowedOrigins, origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);

      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  };

  server.on('upgrade', handleUpgrade);

  function broadcast(type, data) {
    if (!clients.size) return;
    const frame = JSON.stringify({ ts: new Date().toISOString(), type, data });

    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
      }
    }
  }

  return {
    broadcast
  };
}

function parseAllowedOrigins(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(allowedOrigins, origin) {
  if (!allowedOrigins.length) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

module.exports = {
  setupWebsocket
};
