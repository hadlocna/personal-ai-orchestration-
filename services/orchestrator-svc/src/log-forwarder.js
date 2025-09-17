const EventSource = require('eventsource');
const { queueMicrotask } = global;

function startLogForwarder({ wsHub, logger, loggingUrl }) {
  if (!loggingUrl) return;

  const normalizedUrl = loggingUrl.replace(/\/$/, '');
  const sseUrl = `${normalizedUrl}/logs/stream`;

  function connect() {
    const headers = buildHeaders();

    const source = new EventSource(sseUrl, { headers });

    source.onmessage = (event) => {
      queueMicrotask(() => {
        try {
          const payload = JSON.parse(event.data);
          wsHub.broadcast('LOG', payload);
        } catch (err) {
          console.error('Log forwarder parse error', err);
        }
      });
    };

    source.onerror = (err) => {
      console.error('Log stream error', err);
      logger?.error('LOG_STREAM_ERROR', { data: { message: err.message } });
      source.close();
      setTimeout(connect, 3000);
    };
  }

  connect();
}

function buildHeaders() {
  const headers = {
    'X-INTERNAL-KEY': process.env.INTERNAL_KEY || ''
  };
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (user && pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return headers;
}

module.exports = {
  startLogForwarder
};
