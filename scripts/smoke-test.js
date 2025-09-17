#!/usr/bin/env node
const crypto = require('crypto');
const url = require('url');

const REQUIRED_ENVS = ['ORCHESTRATOR_URL', 'LOGGING_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

function assertEnv() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function basicAuthHeader() {
  const u = process.env.BASIC_AUTH_USER;
  const p = process.env.BASIC_AUTH_PASS;
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

async function fetchJson(endpoint, options = {}) {
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      Authorization: basicAuthHeader()
    },
    options.headers || {}
  );

  const response = await fetch(endpoint, Object.assign({}, options, { headers }));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }
  return response.json();
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  assertEnv();
  const orchBase = process.env.ORCHESTRATOR_URL.replace(/\/$/, '');
  const logBase = process.env.LOGGING_URL.replace(/\/$/, '');

  console.log('Checking orchestrator health...');
  const health = await fetchJson(`${orchBase}/health`);
  console.log('Health OK:', health.status);

  const correlationId = `smoke-${Date.now()}`;
  const payload = {
    type: 'echo',
    payload: {
      message: 'smoke-test',
      ts: new Date().toISOString()
    },
    source: 'smoke-test',
    correlationId
  };

  console.log('Creating echo task...');
  const createResp = await fetchJson(`${orchBase}/task`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  const taskId = createResp.id;
  const traceId = createResp.traceId;
  console.log('Task created:', taskId, 'trace:', traceId);

  let status = createResp.status;
  let attempts = 0;
  const maxAttempts = 15;
  let taskDetail = null;

  while (attempts < maxAttempts) {
    await wait(2000);
    attempts += 1;
    const result = await fetchJson(`${orchBase}/task/${taskId}`);
    taskDetail = result.task;
    status = taskDetail.status;
    console.log(`Attempt ${attempts}: status=${status}`);
    if (status === 'done' || status === 'error') break;
  }

  if (!taskDetail) {
    throw new Error('Failed to retrieve task details');
  }

  if (status !== 'done') {
    throw new Error(`Task did not complete successfully; final status=${status}`);
  }

  console.log('Task completed. Fetching logs for trace:', traceId);
  const logs = await fetchJson(`${logBase}/logs?traceId=${encodeURIComponent(traceId)}&limit=20`);
  if (!logs.logs || !logs.logs.length) {
    throw new Error('No logs returned for traceId');
  }
  console.log(`Retrieved ${logs.logs.length} log entries.`);

  console.log('Smoke test succeeded.');
}

run().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exitCode = 1;
});
