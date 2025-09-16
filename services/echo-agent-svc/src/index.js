const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth
} = require('@repo/common');

const SERVICE_NAME = 'echo-agent-svc';
const PORT = process.env.PORT || 4002;

function bootstrap() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '256kb' }));
  app.use(morgan('combined'));
  app.use(requireAuth());

  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  app.post('/echo', (req, res) => {
    if (req.authUser !== 'internal') {
      return res.status(403).json({ error: 'internal access only' });
    }

    const { payload = null } = req.body || {};
    res.json({
      service: SERVICE_NAME,
      received: payload,
      timestamp: new Date().toISOString()
    });
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
