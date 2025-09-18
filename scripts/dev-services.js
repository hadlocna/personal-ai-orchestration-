#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

// Load local .env for convenience (optional if already exported)
try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
} catch (err) {
  // dotenv optional; ignore when unavailable
}

const SERVICE_DEFS = [
  { id: 'orchestrator', workspace: '@repo/orchestrator-svc' },
  { id: 'logging', workspace: '@repo/logging-svc' },
  { id: 'echo', workspace: '@repo/echo-agent-svc' },
  { id: 'renderctl', workspace: '@repo/renderctl-svc' }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { services: SERVICE_DEFS.map((svc) => svc.id) };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--only' || arg === '--services') {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`${arg} flag requires a comma-separated list of service ids`);
      }
      options.services = value.split(',').map((item) => item.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  const ids = SERVICE_DEFS.map((svc) => svc.id).join(', ');
  console.log(`Usage: node scripts/dev-services.js [options]\n\n` +
    `Starts Render-bound services locally with prefixed logs.\n\n` +
    `Options:\n` +
    `  --only a,b,c    Start a subset of services (${ids})\n` +
    `  -h, --help      Show this message\n`);
}

function selectServices(requestedIds) {
  const all = new Map(SERVICE_DEFS.map((svc) => [svc.id, svc]));
  const invalid = requestedIds.filter((id) => !all.has(id));
  if (invalid.length) {
    throw new Error(`Unknown service id(s): ${invalid.join(', ')}`);
  }
  return requestedIds.map((id) => all.get(id));
}

function formatLine(label, text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[${label}] ${line}\n`)
    .join('');
}

async function main() {
  let options;
  try {
    options = parseArgs();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  let targets;
  try {
    targets = selectServices(options.services);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  const children = new Map();
  let shuttingDown = false;

  function stopAll(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children.values()) {
      if (!child.killed) {
        child.kill('SIGINT');
      }
    }
    setTimeout(() => process.exit(code), 200);
  }

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down services...');
    stopAll();
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down services...');
    stopAll();
  });

  targets.forEach((svc) => {
    const label = svc.id.toUpperCase();
    const child = spawn('npm', ['run', '--workspace', svc.workspace, 'start'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    children.set(label, child);

    child.stdout.on('data', (chunk) => {
      process.stdout.write(formatLine(label, chunk.toString()));
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(formatLine(`${label}!`, chunk.toString()));
    });

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      if (code === 0) {
        console.log(`[${label}] exited cleanly`);
      } else {
        console.error(`[${label}] exited with code=${code} signal=${signal || 'none'}`);
        stopAll(code || 1);
      }
    });
  });

  console.log(`Started services: ${targets.map((svc) => svc.id).join(', ')}`);
  console.log('Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('dev-services script failed:', err);
  process.exit(1);
});
