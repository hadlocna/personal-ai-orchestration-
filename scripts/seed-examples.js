#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REQUIRED_ENVS = ['ORCHESTRATOR_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];
const DEFAULT_COUNT = 1;
const POLL_LIMIT = 10;
const POLL_DELAY_MS = 1500;

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertEnv();

  const orchestratorUrl = process.env.ORCHESTRATOR_URL.replace(/\/$/, '');
  const loggingUrl = process.env.LOGGING_URL ? process.env.LOGGING_URL.replace(/\/$/, '') : null;
  const authHeader = buildAuthHeader();
  const example = loadExample(options.examplePath);

  runSeed({ orchestratorUrl, loggingUrl, authHeader, example, options }).catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  });
}

function parseArgs(argv) {
  const options = {
    count: DEFAULT_COUNT,
    wait: true,
    examplePath: path.resolve(process.cwd(), 'examples/echo-task.json')
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count' && i + 1 < argv.length) {
      options.count = Math.max(1, Number.parseInt(argv[++i], 10) || DEFAULT_COUNT);
    } else if (arg === '--skip-wait') {
      options.wait = false;
    } else if (arg === '--example' && i + 1 < argv.length) {
      options.examplePath = path.resolve(process.cwd(), argv[++i]);
    }
  }

  return options;
}

function assertEnv() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function buildAuthHeader() {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${token}`;
}

function loadExample(examplePath) {
  const raw = fs.readFileSync(examplePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.type || !parsed.source) {
    throw new Error('Example payload must include type and source');
  }
  return parsed;
}

async function runSeed({ orchestratorUrl, loggingUrl, authHeader, example, options }) {
  const created = [];

  for (let i = 0; i < options.count; i += 1) {
    const correlationId = `${example.correlationId || 'seed'}-${Date.now()}-${i}`;
    const payload = Object.assign({}, example, {
      correlationId,
      payload: Object.assign({}, example.payload, {
        seededAt: new Date().toISOString(),
        sequence: i
      })
    });

    const response = await postJson(`${orchestratorUrl}/task`, payload, authHeader);
    created.push({ id: response.id, traceId: response.traceId, correlationId });
    console.log(`Queued task ${response.id} (trace ${response.traceId})`);

    if (options.wait) {
      await waitForCompletion({ orchestratorUrl, authHeader, taskId: response.id });
    }
  }

  if (loggingUrl) {
    await emitSampleLog({ loggingUrl, authHeader });
  }

  console.log(`
Seeded ${created.length} task(s).`);
  created.forEach((entry) => {
    console.log(`- id=${entry.id} trace=${entry.traceId} corr=${entry.correlationId}`);
  });
}

async function waitForCompletion({ orchestratorUrl, authHeader, taskId }) {
  for (let attempt = 1; attempt <= POLL_LIMIT; attempt += 1) {
    await sleep(POLL_DELAY_MS);
    const detail = await getJson(`${orchestratorUrl}/task/${taskId}`, authHeader);
    const status = detail?.task?.status;
    if (!status) {
      continue;
    }
    console.log(`  attempt ${attempt}: status=${status}`);
    if (status === 'done' || status === 'error') {
      return status;
    }
  }
  console.warn('  task did not reach terminal state within polling window');
  return null;
}

async function emitSampleLog({ loggingUrl, authHeader }) {
  try {
    await postJson(`${loggingUrl}/log`, {
      service: 'examples.seed',
      level: 'info',
      message: 'Seed script executed',
      data: { timestamp: new Date().toISOString() }
    }, authHeader);
    console.log('Logged seed heartbeat to logging-svc.');
  } catch (err) {
    console.warn('Failed to write sample log:', err.message);
  }
}

async function postJson(target, body, authHeader) {
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${text}`.trim());
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getJson(target, authHeader) {
  const response = await fetch(target, {
    method: 'GET',
    headers: {
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${text}`.trim());
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main();
