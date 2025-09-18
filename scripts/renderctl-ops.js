#!/usr/bin/env node
const http = require('http');
const https = require('https');
const { URL } = require('url');

const REQUIRED_ENVS = ['RENDERCTL_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

async function main() {
  try {
    ensureEnv();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case 'list':
        await handleList(args);
        break;
      case 'deploy':
        await handleDeploy(args);
        break;
      case 'env':
        await handleEnv(args);
        break;
      case 'blueprint':
        await handleBlueprint(args);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

function ensureEnv() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function baseUrl() {
  return process.env.RENDERCTL_URL.replace(/\/$/, '');
}

function basicAuthHeader() {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function request(method, path, { query = {}, body, headers = {}, timeout = 15000 } = {}) {
  const url = new URL(path, baseUrl());
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const payload = body !== undefined ? JSON.stringify(body) : null;
  const defaultHeaders = {
    Authorization: basicAuthHeader(),
    Accept: 'application/json'
  };
  if (payload !== null) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method,
        headers: { ...defaultHeaders, ...headers },
        timeout
      },
      (res) => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = chunks.join('');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const snippet = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
            reject(new Error(`HTTP ${res.statusCode}: ${snippet || 'Request failed'}`));
            return;
          }

          if (!raw) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            resolve(raw);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
}

async function handleList(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--type':
        options.type = argv[++i];
        break;
      case '--name':
        options.name = argv[++i];
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown flag for list: ${arg}`);
    }
  }

  const response = await request('GET', '/render/services', {
    query: { type: options.type, name: options.name }
  });
  const services = Array.isArray(response?.services) ? response.services : [];

  if (options.json) {
    console.log(JSON.stringify(services, null, 2));
    return;
  }

  if (!services.length) {
    console.log('No services returned.');
    return;
  }

  services.forEach((service) => {
    const latest = service.latestDeploy || service.deploy || {};
    const status = latest.status || service.status || 'unknown';
    console.log(`- ${service.name} (${service.id})`);
    console.log(`  type: ${service.type || service.serviceType || 'unknown'}`);
    console.log(`  status: ${status}`);
    if (latest.finishedAt || latest.updatedAt) {
      console.log(`  last updated: ${latest.finishedAt || latest.updatedAt}`);
    }
    console.log('');
  });
}

async function handleDeploy(argv) {
  if (!argv.length) {
    throw new Error('Usage: deploy <serviceId> [--message "Optional note"]');
  }
  const serviceId = argv[0];
  let note;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--message' || arg === '--note') {
      note = argv[++i];
    } else {
      throw new Error(`Unknown flag for deploy: ${arg}`);
    }
  }

  const body = note ? { message: note } : {};
  const response = await request('POST', `/render/deploy/${serviceId}`, { body });
  console.log('Deploy triggered:', JSON.stringify(response, null, 2));
}

async function handleEnv(argv) {
  if (argv.length < 2) {
    throw new Error('Usage: env <serviceId> KEY=VALUE [KEY=VALUE ...] [--clear]');
  }

  const serviceId = argv[0];
  const envPairs = {};
  let clear = false;

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--clear') {
      clear = true;
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex === -1) {
      throw new Error(`Invalid env assignment: ${token}`);
    }
    const key = token.slice(0, equalsIndex);
    const value = token.slice(equalsIndex + 1);
    envPairs[key] = value;
  }

  if (!Object.keys(envPairs).length) {
    throw new Error('Provide at least one KEY=VALUE pair.');
  }

  const response = await request('PATCH', `/render/services/${serviceId}/env`, {
    body: {
      env: envPairs,
      clear
    }
  });

  console.log('Env update response:', JSON.stringify(response, null, 2));
}

async function handleBlueprint(argv) {
  let blueprintPath;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--path':
        blueprintPath = argv[++i];
        break;
      case '--dry-run':
      case '--dry':
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag for blueprint: ${arg}`);
    }
  }

  const body = {
    dryRun
  };
  if (blueprintPath) {
    body.blueprintPath = blueprintPath;
  }

  const response = await request('POST', '/render/blueprint/apply', { body });
  console.log(JSON.stringify(response, null, 2));
}

function printUsage() {
  console.log(`Usage: node scripts/renderctl-ops.js <command> [options]\n\n` +
    'Commands:\n' +
    '  list [--type TYPE] [--name NAME] [--json]   List Render services via renderctl\n' +
    '  deploy <serviceId> [--message TEXT]         Trigger a deploy for the given service\n' +
    '  env <serviceId> KEY=VALUE [--clear]         Patch environment variables\n' +
    '  blueprint [--path FILE] [--dry-run]         Apply the render.blueprint (optionally dry-run)\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
