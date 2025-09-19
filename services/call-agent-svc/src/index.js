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

  // Dispatch endpoint (test mode for now)
  app.post('/call', (req, res) => {
    const { to, from, message } = req.body || {};
    const testMode = (process.env.TWILIO_TEST_MODE || 'true').toLowerCase() !== 'false';
    const callSid = `CA${Math.random().toString(36).slice(2, 10)}${Date.now()}`;
    const payload = {
      status: testMode ? 'simulated' : 'queued',
      to: to || 'unknown',
      from: from || process.env.TWILIO_CALLER_ID || 'unknown',
      message: message || null,
      callSid
    };
    res.status(202).json(payload);
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


