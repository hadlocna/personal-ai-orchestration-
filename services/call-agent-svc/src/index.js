const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { ensureConfig, buildConfigReport, requireAuth, createDashboardCors } = require('@repo/common');

const SERVICE_NAME = 'call-agent-svc';
const PORT = process.env.PORT || 4020;

function bootstrap() {
  try {
    ensureConfig();
  } catch (err) {
    console.error(`${SERVICE_NAME}: configuration validation failed`, err.cause || err);
    process.exit(1);
  }

  const app = express();
  const dashboardCors = createDashboardCors();

  app.use(helmet());
  app.use(express.json({ limit: '512kb' }));
  app.use(morgan('combined'));
  app.use(dashboardCors);
  app.use(requireAuth());

  app.get('/health', (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  // Placeholder endpoint; Twilio integration to be added
  app.post('/call', (req, res) => {
    res.status(202).json({ status: 'accepted', echo: req.body || {} });
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


