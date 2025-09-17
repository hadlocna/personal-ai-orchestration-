const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');
const {
  createClient,
  createService,
  listServices,
  updateEnvVars,
  triggerDeploy
} = require('./renderApi');
const { startMonitor } = require('./monitor');
const { applyBlueprint } = require('./blueprint');

const SERVICE_NAME = 'renderctl-svc';
const PORT = process.env.PORT || 4010;

function assertToken() {
  if (!process.env.RENDER_API_TOKEN) {
    console.error(`${SERVICE_NAME}: RENDER_API_TOKEN is not set`);
    process.exit(1);
  }
}

function bootstrap() {
  try {
    ensureConfig();
    assertToken();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '512kb' }));
  app.use(morgan('combined'));
  app.use(requireAuth());

  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  app.post('/render/services', asyncHandler(async (req, res) => {
    const { service, env, clearEnv } = req.body || {};

    if (!service || typeof service !== 'object') {
      return res.status(400).json({ error: 'service payload is required' });
    }

    if (!service.name || !service.type) {
      return res.status(400).json({ error: 'service.name and service.type are required' });
    }

    const client = getClient();
    const created = await createService(client, service);

    let envResult = null;
    if (env && typeof env === 'object' && Object.keys(env).length > 0) {
      envResult = await updateEnvVars(client, created.id, env, { clearOtherVars: Boolean(clearEnv) });
    }

    res.status(201).json({ service: created, env: envResult });
  }));

  app.patch('/render/services/:id/env', asyncHandler(async (req, res) => {
    const { env, clear } = req.body || {};
    if (!env || typeof env !== 'object' || Object.keys(env).length === 0) {
      return res.status(400).json({ error: 'env object is required' });
    }

    const client = getClient();
    const result = await updateEnvVars(client, req.params.id, env, { clearOtherVars: Boolean(clear) });
    res.json({ env: result });
  }));

  app.post('/render/deploy/:id', asyncHandler(async (req, res) => {
    const client = getClient();
    const response = await triggerDeploy(client, req.params.id, req.body || {});
    res.status(202).json({ deploy: response });
  }));

  app.get('/render/services', asyncHandler(async (req, res) => {
    const client = getClient();
    const services = await listServices(client, {
      type: req.query.type,
      name: req.query.name
    });
    res.json({ services });
  }));

  app.post('/render/blueprint/apply', asyncHandler(async (req, res) => {
    const { blueprintPath, dryRun } = req.body || {};
    const result = await applyBlueprint({
      getClient,
      blueprintPath,
      dryRun: Boolean(dryRun),
      logger: console
    });
    res.status(dryRun ? 200 : 202).json(result);
  }));

  const server = app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on port ${PORT}`);
  });

  startMonitor({ getClient, logger: console });

  return server;
}

function getClient() {
  return createClient({
    token: process.env.RENDER_API_TOKEN,
    baseURL: process.env.RENDER_API_BASE_URL || undefined
  });
}

function asyncHandler(fn) {
  return function handler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (err.status) {
        res.status(err.status).json({ error: err.message, details: err.data });
        return;
      }
      console.error('renderctl handler error', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  };
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap, getClient };
