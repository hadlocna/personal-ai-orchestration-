const crypto = require('crypto');

function timingSafeEqual(a, b) {
  const aBuffer = Buffer.from(String(a ?? ''), 'utf8');
  const bBuffer = Buffer.from(String(b ?? ''), 'utf8');
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function createHmacSignature({ secret, payload = '', algorithm = 'sha256', encoding = 'hex' }) {
  if (!secret) {
    throw new Error('HMAC secret is required');
  }

  const hmac = crypto.createHmac(algorithm, secret);
  const normalizedPayload = normalizePayload(payload);
  hmac.update(normalizedPayload);
  return hmac.digest(encoding);
}

function verifyHmacSignature({ secret, payload = '', signature, algorithm = 'sha256', encoding = 'hex' }) {
  if (!signature) return false;
  try {
    const expected = createHmacSignature({ secret, payload, algorithm, encoding });
    return timingSafeEqual(expected, signature);
  } catch (err) {
    return false;
  }
}

function createTwilioSignature({ authToken, url, params = {} }) {
  if (!authToken) {
    throw new Error('Twilio auth token is required');
  }
  if (!url) {
    throw new Error('Request URL is required to compute Twilio signature');
  }

  let data = String(url);
  const entries = buildSortedParamEntries(params);
  for (const [key, value] of entries) {
    data += key + String(value ?? '');
  }

  const hmac = crypto.createHmac('sha1', authToken);
  hmac.update(data);
  return hmac.digest('base64');
}

function verifyTwilioSignature({ authToken, url, params = {}, signature }) {
  if (!signature) return false;
  try {
    const expected = createTwilioSignature({ authToken, url, params });
    return timingSafeEqual(expected, signature.trim());
  } catch (err) {
    return false;
  }
}

function normalizePayload(payload) {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string' || Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'object') return JSON.stringify(payload);
  return String(payload);
}

function buildSortedParamEntries(params) {
  const entries = [];
  const keys = Object.keys(params || {});
  keys.sort();
  keys.forEach((key) => {
    const value = params[key];
    if (Array.isArray(value)) {
      value.forEach((item) => entries.push([key, item]));
    } else {
      entries.push([key, value]);
    }
  });
  return entries;
}

module.exports = {
  createHmacSignature,
  verifyHmacSignature,
  createTwilioSignature,
  verifyTwilioSignature,
  timingSafeEqual
};

