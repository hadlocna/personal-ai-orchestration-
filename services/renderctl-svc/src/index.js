const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');

const SERVICE_NAME = 'renderctl-svc';
const PORT = process.env.PORT || 4010;

function bootstrap() {
  try {
    ensureConfig();
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

  app.post('/render/services', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.patch('/render/services/:id/env', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.post('/render/deploy/:id', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/render/services', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  const server = app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on port ${PORT}`);
  });

  return server;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
