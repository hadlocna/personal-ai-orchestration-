#!/usr/bin/env node
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const REQUIRED_ENVS = ['RENDERCTL_URL', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    failOnError: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--fail-on-error':
      case '--fail':
        opts.failOnError = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--type':
        if (argv[i + 1] === undefined) {
          throw new Error('--type flag requires a value');
        }
        opts.type = argv[i + 1];
        i += 1;
        break;
      case '--name':
        if (argv[i + 1] === undefined) {
          throw new Error('--name flag requires a value');
        }
        opts.name = argv[i + 1];
        i += 1;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        break;
    }
  }

  return opts;
}

function ensureEnv() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function basicAuthHeader() {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function getJson(endpoint, { headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers
        },
        timeout
      },
      (res) => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = chunks.join('') || '';
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const snippet = body.length > 200 ? `${body.slice(0, 200)}...` : body;
            reject(new Error(`Request failed ${res.statusCode}: ${snippet}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (err) {
            reject(new Error(`Failed to parse JSON response: ${err.message}`));
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
    req.end();
  });
}

function classifyStatus(status) {
  if (!status) {
    return { level: 'warn', reason: 'no_status' };
  }

  if (status === 'live') {
    return { level: 'ok', reason: 'live' };
  }

  if (/failed/i.test(status)) {
    return { level: 'error', reason: status };
  }

  if (status === 'deactivated') {
    return { level: 'warn', reason: status };
  }

  return { level: 'warn', reason: status };
}

function printUsage() {
  console.log(`Usage: node scripts/render-status.js [options]\n\n` +
    'Options:\n' +
    '  --type <type>        Filter services by Render type (web_service, static_site, etc.)\n' +
    '  --name <substring>   Filter services by name (Render-side filtering)\n' +
    '  --json               Output raw JSON summary\n' +
    '  --fail-on-error      Exit with code 1 when any service shows a failed deploy\n' +
    '  -h, --help           Show this help message');
}

async function main() {
  let options;
  try {
    options = parseArgs();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  try {
    ensureEnv();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.RENDERCTL_URL.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (options.type) params.set('type', options.type);
  if (options.name) params.set('name', options.name);

  let servicesResponse;
  try {
    const query = params.toString();
    const endpoint = `${baseUrl}/render/services${query ? `?${query}` : ''}`;
    servicesResponse = await getJson(endpoint, {
      headers: { Authorization: basicAuthHeader() }
    });
  } catch (err) {
    console.error('Failed to fetch services:', err.message);
    process.exitCode = 1;
    return;
  }

  const services = Array.isArray(servicesResponse?.services)
    ? servicesResponse.services
    : [];

  if (services.length === 0) {
    console.log('No services returned. Check filters or renderctl configuration.');
    return;
  }

  const results = [];
  for (const service of services) {
    const id = service.id;
    let deployData;
    try {
      const endpoint = `${baseUrl}/render/services/${id}/deploys?limit=1`;
      deployData = await getJson(endpoint, {
        headers: { Authorization: basicAuthHeader() }
      });
    } catch (err) {
      console.error(`Failed to fetch deploys for ${service.name}:`, err.message);
      results.push({
        id,
        name: service.name,
        type: service.type,
        latestDeploy: null,
        status: 'unknown',
        attention: true,
        error: err.message
      });
      continue;
    }

    const deploys = Array.isArray(deployData?.deploys)
      ? deployData.deploys
      : Array.isArray(deployData)
        ? deployData
        : [];
    const latest = deploys[0] || null;
    const statusInfo = classifyStatus(latest?.status || null);

    results.push({
      id,
      name: service.name,
      type: service.type,
      repo: service.repo,
      branch: service.branch,
      updatedAt: service.updatedAt,
      latestDeploy: latest,
      status: latest?.status || null,
      attention: statusInfo.level === 'error',
      statusLevel: statusInfo.level,
      statusReason: statusInfo.reason
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ services: results }, null, 2));
  } else {
    console.log(`Render services (${results.length}):`);
    for (const result of results) {
      console.log(`- ${result.name} [${result.type}] (id: ${result.id})`);
      if (result.error) {
        console.log(`  latest deploy: error fetching deploys - ${result.error}`);
        continue;
      }
      if (!result.latestDeploy) {
        console.log('  latest deploy: none');
        continue;
      }
      console.log(
        `  latest deploy: ${result.latestDeploy.id} | status=${result.status} | finished=${result.latestDeploy.finishedAt || 'n/a'}`
      );
    }

    const failures = results.filter((svc) => svc.attention);
    if (failures.length > 0) {
      console.log('\nServices requiring attention:');
      failures.forEach((svc) => {
        console.log(`  - ${svc.name} - status=${svc.status || 'unknown'}`);
      });
      if (options.failOnError) {
        process.exitCode = 1;
      }
    } else {
      console.log('\nAll services report latest deploy status without failures.');
    }
  }
}

main().catch((err) => {
  console.error('render-status script failed:', err);
  process.exitCode = 1;
});
