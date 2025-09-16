const { URL } = require('url');

function toAbsoluteUrl(url) {
  try {
    return new URL(url).toString();
  } catch (err) {
    throw new Error(`Invalid URL provided to internalFetch: ${url}`);
  }
}

function normalizeBody(body) {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string' || body instanceof Buffer) {
    return body;
  }

  return JSON.stringify(body);
}

async function internalFetch(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this runtime');
  }

  const target = toAbsoluteUrl(url);
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      'X-INTERNAL-KEY': process.env.INTERNAL_KEY || ''
    },
    options.headers || {}
  );

  const response = await fetch(target, {
    method: options.method || 'GET',
    headers,
    body: normalizeBody(options.body)
  });

  return response;
}

module.exports = {
  internalFetch
};
