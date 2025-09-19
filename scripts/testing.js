#!/usr/bin/env node
const REQUIRED_ENVS = ['ORCHESTRATOR_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

function basicAuthHeader() {
  const u = process.env.BASIC_AUTH_USER;
  const p = process.env.BASIC_AUTH_PASS;
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

async function fetchJson(endpoint) {
  const response = await fetch(endpoint, {
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader() }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

async function run() {
  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    process.exit(1);
  }

  const base = process.env.ORCHESTRATOR_URL.replace(/\/$/, '');
  const targets = ['twilio', 'hubspot', 'openai', 'google'];
  let failures = 0;

  for (const key of targets) {
    const url = `${base}/integrations/${key}`;
    process.stdout.write(`Checking ${key}... `);
    try {
      const res = await fetchJson(url);
      if (!res.ok) {
        failures += 1;
        console.log(`ERROR (HTTP ${res.status})`);
        continue;
      }
      const overall = res.data.overall || 'unknown';
      console.log(overall.toUpperCase());
    } catch (err) {
      failures += 1;
      console.log('ERROR', err.message);
    }
  }

  if (failures) {
    console.error(`${failures} integration(s) failed.`);
    process.exit(1);
  }
  console.log('All integrations OK.');
}

run().catch((err) => {
  console.error('Integration tests failed:', err.message || err);
  process.exit(1);
});
