const axios = require('axios');
const {
  listServices,
  getServiceDeploys,
  updateService,
  triggerDeploy
} = require('./renderApi');

const DEFAULT_INTERVAL = Number(process.env.RENDER_MONITOR_INTERVAL_MS || 60000);
const DEFAULT_STATIC_FIX = {
  rootDir: process.env.RENDER_STATIC_SITE_ROOT_DIR || '.',
  publishPath: process.env.RENDER_STATIC_SITE_PUBLISH_PATH || 'dashboard-web/dist',
  buildCommand: process.env.RENDER_STATIC_SITE_BUILD_COMMAND || './render-build.sh'
};

function parseMonitorConfig() {
  const raw = process.env.RENDER_MONITOR_SERVICES;
  if (!raw) {
    return [{ name: 'dashboard-web' }];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry.toLowerCase() !== 'none')
    .map((entry) => {
      if (entry.startsWith('id:')) {
        return { id: entry.slice(3).trim() };
      }
      return { name: entry };
    });
}

function startMonitor({ getClient, logger = console, intervalMs = DEFAULT_INTERVAL } = {}) {
  const watchList = parseMonitorConfig();
  if (!watchList.length) {
    logger.info('[renderctl] monitor disabled: no services configured');
    return null;
  }

  const handledDeploys = new Map();

  async function poll() {
    try {
      const client = getClient();
      const servicesResponse = await listServices(client, { limit: 200 });
      const services = normalizeServicesList(servicesResponse);

      for (const target of watchList) {
        const service = findService(services, target);
        if (!service) {
          continue;
        }
        await inspectService({ client, service, target, handledDeploys, logger });
      }
    } catch (err) {
      logger.error('[renderctl] monitor poll failed', err);
    } finally {
      schedule();
    }
  }

  function schedule() {
    setTimeout(() => {
      poll().catch((err) => logger.error('[renderctl] monitor tick error', err));
    }, intervalMs);
  }

  logger.info('[renderctl] starting Render deploy monitor', {
    watch: watchList.map((item) => item.id || item.name || 'unknown'),
    intervalMs
  });
  schedule();
  return { stop: () => handledDeploys.clear() };
}

async function inspectService({ client, service, target, handledDeploys, logger }) {
  const serviceId = service.id || service.serviceId || service.service?.id;
  if (!serviceId) {
    return;
  }

  const deploysResponse = await getServiceDeploys(client, serviceId, { limit: 1 });
  const latestDeploy = normalizeDeploysList(deploysResponse)[0];
  if (!latestDeploy) {
    return;
  }

  const deployId = latestDeploy.id;
  if (!deployId) {
    return;
  }

  if (handledDeploys.get(serviceId) === deployId) {
    return;
  }

  if (!isFailedDeploy(latestDeploy)) {
    return;
  }

  handledDeploys.set(serviceId, deployId);

  const logText = await fetchDeployLog(client, latestDeploy.logUrl);

  const fixResult = await attemptFix({
    client,
    service,
    deploy: latestDeploy,
    logText,
    logger
  });

  if (fixResult && fixResult.patched) {
    logger.info('[renderctl] applied fix for failed deploy', {
      serviceId,
      reason: fixResult.reason
    });
    await triggerDeploy(client, serviceId, {});
  } else {
    logger.warn('[renderctl] build failure detected with no automated fix', {
      serviceId,
      deployId,
      status: latestDeploy.status
    });
  }
}

async function attemptFix({ client, service, deploy, logText, logger }) {
  const serviceType = getServiceType(service);

  if (serviceType === 'static_site') {
    return fixStaticSite({ client, service, deploy, logText, logger });
  }

  return null;
}

async function fixStaticSite({ client, service, logText }) {
  const serviceId = service.id || service.service?.id;
  if (!serviceId) return null;

  const needsPublishFix = /publish directory .* does not exist/i.test(logText || '');
  const missingBuildScript = /render-build\.sh: No such file or directory/i.test(logText || '');
  const emptyBuild = /Empty build command/i.test(logText || '');

  if (!needsPublishFix && !missingBuildScript && !emptyBuild) {
    return null;
  }

  const payload = {
    serviceDetails: {
      rootDir: DEFAULT_STATIC_FIX.rootDir,
      publishPath: DEFAULT_STATIC_FIX.publishPath,
      buildCommand: DEFAULT_STATIC_FIX.buildCommand
    }
  };

  await updateService(client, serviceId, payload);
  return { patched: true, reason: 'static_site_publish_path' };
}

function normalizeServicesList(response) {
  if (Array.isArray(response)) {
    return response.map((item) => item.service || item);
  }
  if (response && Array.isArray(response.services)) {
    return response.services.map((item) => item.service || item);
  }
  return [];
}

function normalizeDeploysList(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && Array.isArray(response.deploys)) {
    return response.deploys;
  }
  return [];
}

function findService(services, target) {
  return services.find((service) => {
    const name = service.name || service.service?.name;
    const id = service.id || service.service?.id;
    if (target.id) {
      return id === target.id;
    }
    return name === target.name;
  });
}

function getServiceType(service) {
  return service.type || service.serviceType || service.service?.type || service.service?.serviceType;
}

function isFailedDeploy(deploy) {
  if (!deploy || !deploy.status) return false;
  const status = String(deploy.status).toLowerCase();
  return status.includes('fail');
}

async function fetchDeployLog(client, logUrl) {
  if (!logUrl) return '';
  try {
    const headers = client.defaults?.headers?.common ? { ...client.defaults.headers.common } : {};
    const response = await axios.get(logUrl, { headers });
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  } catch (err) {
    return '';
  }
}

module.exports = {
  startMonitor
};
