const INTERNAL_HEADER = 'x-internal-key';

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
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

function respondUnauthorized(res) {
  res.status(401).set('WWW-Authenticate', 'Basic realm="dev"').end();
}

function requireAuth(options = {}) {
  const { allowInternalKey = true } = options;

  return function authMiddleware(req, res, next) {
    const internalKey = process.env.INTERNAL_KEY;

    if (allowInternalKey && internalKey) {
      const headerKey = req.header(INTERNAL_HEADER);
      if (headerKey && headerKey === internalKey) {
        req.authUser = 'internal';
        return next();
      }
    }

    const creds = parseBasicCredentials(req.header('authorization'));
    const expectedUser = process.env.BASIC_AUTH_USER;
    const expectedPass = process.env.BASIC_AUTH_PASS;

    if (!creds || creds.username !== expectedUser || creds.password !== expectedPass) {
      return respondUnauthorized(res);
    }

    req.authUser = creds.username;
    return next();
  };
}

module.exports = {
  requireAuth
};
