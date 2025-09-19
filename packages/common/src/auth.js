const INTERNAL_HEADER = 'x-internal-key';
const BASIC_REALM = 'dev';
const AUTH_CHALLENGE = `Basic realm="${BASIC_REALM}"`;

function decodeBase64(str) {
  try {
    return Buffer.from(str, 'base64').toString('utf-8');
  } catch (err) {
    return '';
  }
}

function parseBasicCredentials(header) {
  if (!header || typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !value) return null;
  const decoded = decodeBase64(value).split(':');
  if (decoded.length < 2) return null;
  const [username, ...rest] = decoded;
  return { username, password: rest.join(':') };
}

function parseBasicToken(token) {
  if (!token) return null;
  const decoded = decodeBase64(token).split(':');
  if (decoded.length < 2) return null;
  const [username, ...rest] = decoded;
  return { username, password: rest.join(':') };
}

function getHeader(source, name) {
  if (!source) return undefined;

  if (typeof source.header === 'function') {
    return source.header(name);
  }

  const headers = source.headers || source;
  if (!headers) return undefined;

  const lowerName = name.toLowerCase();

  if (typeof headers.get === 'function') {
    const direct = headers.get(name) ?? headers.get(lowerName);
    if (direct !== undefined) return direct;
  }

  if (Object.prototype.hasOwnProperty.call(headers, name)) {
    return headers[name];
  }
  if (Object.prototype.hasOwnProperty.call(headers, lowerName)) {
    return headers[lowerName];
  }

  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowerName) {
        return headers[key];
      }
    }
  }

  return undefined;
}

function getQueryParam(source, key) {
  if (!source) return undefined;
  if (source.query && Object.prototype.hasOwnProperty.call(source.query, key)) {
    return source.query[key];
  }
  if (source.url) {
    try {
      const url = new URL(source.url, 'http://localhost');
      if (url.searchParams.has(key)) {
        return url.searchParams.get(key);
      }
    } catch (err) {
      return undefined;
    }
  }
  return undefined;
}

function authenticateRequest(source, options = {}) {
  const { allowInternalKey = true } = options;
  const internalKey = process.env.INTERNAL_KEY;

  if (allowInternalKey && internalKey) {
    const headerKey = getHeader(source, INTERNAL_HEADER);
    if (headerKey && headerKey === internalKey) {
      return { ok: true, user: 'internal', strategy: 'internal' };
    }
  }

  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;

  if (!expectedUser || !expectedPass) {
    return { ok: false, reason: 'missing_expected_credentials' };
  }

  let creds = parseBasicCredentials(getHeader(source, 'authorization'));
  if (!creds) {
    const token = getQueryParam(source, 'auth');
    if (token) {
      creds = parseBasicToken(token);
    }
  }

  if (!creds || creds.username !== expectedUser || creds.password !== expectedPass) {
    return { ok: false, reason: 'invalid_basic_credentials' };
  }

  return { ok: true, user: creds.username, strategy: 'basic' };
}

function respondUnauthorized(res) {
  res.status(401).set('WWW-Authenticate', AUTH_CHALLENGE).end();
}

function requireAuth(options = {}) {
  const { allowInternalKey = true } = options;

  return function authMiddleware(req, res, next) {
    if (req.method && req.method.toUpperCase() === 'OPTIONS') {
      return next();
    }
    const result = authenticateRequest(req, { allowInternalKey });
    if (!result.ok) {
      return respondUnauthorized(res);
    }

    req.authUser = result.user;
    return next();
  };
}

module.exports = {
  requireAuth,
  authenticateRequest,
  AUTH_CHALLENGE,
  INTERNAL_HEADER
};
