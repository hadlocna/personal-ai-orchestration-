const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');

const SERVICE_NAME = 'logging-svc';
const PORT = process.env.PORT || 4001;

function bootstrap() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
  app.use(requireAuth());

  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  app.post('/log', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/logs', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/logs/stream', (req, res) => {
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
