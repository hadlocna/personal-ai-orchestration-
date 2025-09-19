const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { authenticateRequest, AUTH_CHALLENGE, INTERNAL_HEADER } = require('@repo/common');

function setupWebsocket(server) {
  const clients = new Set();
  const allowedOrigins = parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS);
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (request, socket, head) => {
    if (!request.url || !request.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    const { source: authSource, sanitizedUrl } = buildAuthContext(request);
    const authResult = authenticateRequest(authSource);
    if (!authResult.ok) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${AUTH_CHALLENGE}\r\n\r\n`);
      socket.destroy();
      return;
    }

    const origin = request.headers ? request.headers.origin : undefined;
    if (!isOriginAllowed(allowedOrigins, origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const originalUrl = request.url;
    if (sanitizedUrl && sanitizedUrl !== originalUrl) {
      request.url = sanitizedUrl;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (sanitizedUrl && sanitizedUrl !== originalUrl) {
        request.url = originalUrl;
      }
      ws.authUser = authResult.user;
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

function buildAuthContext(request) {
  const headers = Object.assign({}, request.headers || {});
  let sanitizedUrl = null;

  if (request.url) {
    try {
      const parsed = new URL(request.url, 'http://internal');
      const authParam = parsed.searchParams.get('auth');
      const internalKey = parsed.searchParams.get('internalKey');

      if (authParam && !headers.authorization) {
        headers.authorization = `Basic ${authParam}`;
      }

      if (internalKey && !headers[INTERNAL_HEADER]) {
        headers[INTERNAL_HEADER] = internalKey;
      }

      if (authParam || internalKey) {
        parsed.searchParams.delete('auth');
        parsed.searchParams.delete('internalKey');
        sanitizedUrl = `${parsed.pathname}${parsed.search}` || parsed.pathname;
      }
    } catch (err) {
      sanitizedUrl = null;
    }
  }

  return {
    source: { headers },
    sanitizedUrl
  };
}

module.exports = {
  setupWebsocket
};
