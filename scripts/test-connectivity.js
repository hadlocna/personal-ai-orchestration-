#!/usr/bin/env node
const { URL } = require('url');

const RESULTS = [];

async function main() {
  await checkInternalServices();
  await checkTwilio();
  await checkHubspot();
  await checkOpenAI();
  await checkGoogle();

  const hasError = RESULTS.some((item) => item.status === 'error');
  const summary = RESULTS.map(formatResult).join('\n');
  console.log(summary);

  if (hasError) {
    process.exitCode = 1;
  } else {
    console.log('\nAll requested connectivity checks completed.');
  }
}

function formatResult(entry) {
  const header = `[${entry.category}] ${entry.name}`;
  const status = entry.status.toUpperCase();
  const detail = entry.detail ? ` – ${entry.detail}` : '';
  return `${header}: ${status}${detail}`;
}

function recordResult({ category, name, status, detail }) {
  RESULTS.push({ category, name, status, detail });
}

async function checkInternalServices() {
  const basicUser = process.env.BASIC_AUTH_USER;
  const basicPass = process.env.BASIC_AUTH_PASS;
  const authHeader = basicUser && basicPass ? `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}` : null;

  const services = [
    { name: 'Orchestrator', base: inferUrl(process.env.ORCHESTRATOR_URL, process.env.PUBLIC_DOMAIN), category: 'service' },
    { name: 'Logging', base: process.env.LOGGING_URL, category: 'service' },
    { name: 'Echo Agent', base: process.env.ECHO_AGENT_URL, category: 'service' },
    { name: 'Render Control', base: process.env.RENDERCTL_URL, category: 'service' }
  ];

  for (const service of services) {
    if (!service.base) {
      recordResult({ category: service.category, name: service.name, status: 'missing', detail: 'No base URL configured' });
      continue;
    }

    try {
      await hitEndpoint(new URL('/health', service.base).toString(), { headers: authHeader ? { Authorization: authHeader } : {} });
      await hitEndpoint(new URL('/config/validate', service.base).toString(), { headers: authHeader ? { Authorization: authHeader } : {} });
      recordResult({ category: service.category, name: service.name, status: 'ok', detail: 'Health and config OK' });
    } catch (err) {
      recordResult({ category: service.category, name: service.name, status: 'error', detail: err.message });
    }
  }
}

async function checkTwilio() {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const baseUrl = (process.env.TWILIO_BASE_URL || process.env.TWILIO_API_BASE_URL || 'https://api.twilio.com').trim();

  if (!accountSid || !authToken) {
    recordResult({ category: 'integration', name: 'Twilio', status: 'missing', detail: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set' });
    return;
  }

  const target = new URL(`/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, baseUrl).toString();
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  try {
    const { data } = await hitEndpoint(target, {
      headers: {
        Authorization: authorization,
        Accept: 'application/json'
      }
    });
    const friendly = data?.friendly_name || data?.friendlyName || mask(accountSid);
    const status = data?.status || 'unknown';
    recordResult({ category: 'integration', name: 'Twilio', status: normalizeStatus(status), detail: `Account ${friendly} (status ${status})` });
  } catch (err) {
    recordResult({ category: 'integration', name: 'Twilio', status: 'error', detail: err.message });
  }
}

async function checkHubspot() {
  const token = (process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
  const baseUrl = (process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com').trim();

  if (!token) {
    recordResult({ category: 'integration', name: 'HubSpot', status: 'missing', detail: 'HUBSPOT_ACCESS_TOKEN not set' });
    return;
  }

  const target = new URL('/crm/v3/owners/?limit=1', baseUrl).toString();

  try {
    const { data } = await hitEndpoint(target, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    const status = count > 0 ? 'ok' : 'warn';
    const detail = count > 0 ? 'Owner data retrieved' : 'No owners returned';
    recordResult({ category: 'integration', name: 'HubSpot', status, detail });
  } catch (err) {
    recordResult({ category: 'integration', name: 'HubSpot', status: 'error', detail: err.message });
  }
}

async function checkOpenAI() {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com').trim();

  if (!apiKey) {
    recordResult({ category: 'integration', name: 'OpenAI', status: 'missing', detail: 'OPENAI_API_KEY not set' });
    return;
  }

  const target = new URL('/v1/models', baseUrl).toString();

  try {
    const { data } = await hitEndpoint(target, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    });
    const models = Array.isArray(data?.data) ? data.data.length : 0;
    const status = models > 0 ? 'ok' : 'warn';
    const detail = models > 0 ? `${models} model(s) available` : 'No models returned';
    recordResult({ category: 'integration', name: 'OpenAI', status, detail });
  } catch (err) {
    recordResult({ category: 'integration', name: 'OpenAI', status: 'error', detail: err.message });
  }
}

async function checkGoogle() {
  const apiKey = (process.env.GOOGLE_API_KEY || '').trim();
  const baseUrl = (process.env.GOOGLE_API_BASE_URL || 'https://www.googleapis.com').trim();

  if (!apiKey) {
    recordResult({ category: 'integration', name: 'Google', status: 'missing', detail: 'GOOGLE_API_KEY not set' });
    return;
  }

  const url = new URL('/discovery/v1/apis', baseUrl);
  url.searchParams.set('key', apiKey);

  try {
    const { data } = await hitEndpoint(url.toString(), { headers: { Accept: 'application/json' } });
    const items = Array.isArray(data?.items) ? data.items.length : 0;
    const status = items > 0 ? 'ok' : 'warn';
    const detail = items > 0 ? `${items} API(s) listed` : 'No APIs returned';
    recordResult({ category: 'integration', name: 'Google', status, detail });
  } catch (err) {
    recordResult({ category: 'integration', name: 'Google', status: 'error', detail: err.message });
  }
}

async function hitEndpoint(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(url, { ...options, signal: controller.signal });
  clearTimeout(timeout);

  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!response.ok) {
    const snippet = text ? text.slice(0, 200) : '';
    throw new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }

  if (contentType.includes('application/json')) {
    try {
      return { data: JSON.parse(text) };
    } catch (err) {
      throw new Error('Invalid JSON response');
    }
  }

  return { data: text };
}

function mask(value = '') {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 6) return `${str.slice(0, 1)}***${str.slice(-1)}`;
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}

function normalizeStatus(status = '') {
  const lower = String(status).toLowerCase();
  if (lower === 'active' || lower === 'ok') return 'ok';
  if (lower === 'suspended' || lower === 'closed') return 'error';
  return 'warn';
}

function inferUrl(primary, domain) {
  if (primary && primary.trim()) return primary.trim();
  if (domain && domain.trim()) {
    const trimmed = domain.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }
  return undefined;
}

if (typeof fetch !== 'function') {
  console.error('Global fetch is not available in this Node.js runtime.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Connectivity checks failed:', err);
  process.exitCode = 1;
});
