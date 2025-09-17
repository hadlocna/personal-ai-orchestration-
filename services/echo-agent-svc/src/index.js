const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  ensureConfig,
  buildConfigReport,
  requireAuth,
  createServiceLogger
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
  const logger = createServiceLogger({
    service: SERVICE_NAME,
    loggingUrl: process.env.LOGGING_URL
  });

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
    logger.info('ECHO_REQUEST', {
      data: { payload },
      traceId: req.body?.traceId || null
    });

    const responseBody = {
      service: SERVICE_NAME,
      received: payload,
      timestamp: new Date().toISOString()
    };

    logger.info('ECHO_RESPONSE', {
      data: { payload: responseBody.received },
      traceId: req.body?.traceId || null
    });

    res.json(responseBody);
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
