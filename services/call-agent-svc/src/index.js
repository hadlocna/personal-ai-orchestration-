const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth,
  createDashboardCors,
  verifyTwilioSignature
} = require('@repo/common');

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
  const authMiddleware = requireAuth();

  app.use(helmet());
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(morgan('combined'));
  app.use(dashboardCors);

  app.get('/health', authMiddleware, (req, res) => {
    res.json({ service: SERVICE_NAME, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/config/validate', authMiddleware, (req, res) => {
    res.json(buildConfigReport(SERVICE_NAME));
  });

  // Dispatch endpoint (test mode for now)
  app.post('/call', authMiddleware, (req, res) => {
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

  // Webhook placeholders with basic auth; signature verification to be added
  app.post('/webhooks/twilio/status', twilioSignatureMiddleware, (req, res) => {
    res.status(204).end();
  });

  app.post('/webhooks/twilio/media', twilioSignatureMiddleware, (req, res) => {
    res.status(204).end();
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

function twilioSignatureMiddleware(req, res, next) {
  const secret = process.env.TWILIO_WEBHOOK_SECRET;
  if (!secret) {
    return next();
  }

  const signature = req.get('X-Twilio-Signature');
  const url = buildFullUrl(req);
  const params = req.body || {};

  const valid = verifyTwilioSignature({
    authToken: secret,
    url,
    params,
    signature
  });

  if (!valid) {
    return res.status(403).json({ error: 'Invalid Twilio signature' });
  }

  return next();
}

function buildFullUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}${req.originalUrl}`;
}

