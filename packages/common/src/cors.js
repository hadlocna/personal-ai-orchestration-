const cors = require('cors');

function parseOrigins(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(parseOrigins);
  return String(input)
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
}

function normalizeOrigin(value) {
  if (!value) return null;
  let origin = value.trim();
  if (!origin) return null;
  if (!/^https?:\/\//i.test(origin)) {
    origin = `https://${origin}`;
  }
  return origin.replace(/\/?$/, '');
}

function createDashboardCors(options = {}) {
  const additional = parseOrigins(options.additionalOrigins || []);
  const envOrigins = [
    ...parseOrigins(process.env.DASHBOARD_ORIGIN || ''),
    ...parseOrigins(process.env.PUBLIC_DOMAIN || ''),
    ...parseOrigins(process.env.WS_ALLOWED_ORIGINS || '')
  ];
  const allowed = Array.from(new Set([...envOrigins, ...additional])).filter(Boolean);

  const corsOptions = {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = normalizeOrigin(origin);
      if (!allowed.length || allowed.includes(normalized)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-INTERNAL-KEY'],
    credentials: false,
    maxAge: 300
  };

  return cors(corsOptions);
}

module.exports = {
  createDashboardCors,
  parseOrigins,
  normalizeOrigin
};
