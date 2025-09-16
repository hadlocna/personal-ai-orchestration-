const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');

const SERVICE_NAME = 'orchestrator-svc';
const PORT = process.env.PORT || 4000;

function bootstrap() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  const app = express();
  const server = http.createServer(app);

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
  app.use(requireAuth());

  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    const report = buildConfigReport(SERVICE_NAME);
    res.json(report);
  });

  app.post('/task', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/task/:id', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.patch('/task/:id', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/tasks', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  app.get('/ws', (req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  server.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on port ${PORT}`);
  });

  return server;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
