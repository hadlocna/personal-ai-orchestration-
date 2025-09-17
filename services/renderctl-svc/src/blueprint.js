const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
  listServices,
  updateService,
  updateEnvVars
} = require('./renderApi');

const DEFAULT_BLUEPRINT_PATH = path.resolve(process.cwd(), 'infra/render.blueprint.yaml');

function loadBlueprint({ blueprintPath = DEFAULT_BLUEPRINT_PATH } = {}) {
  const resolved = path.resolve(blueprintPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Blueprint file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== 'object') {
    throw new Error('Blueprint file must contain a YAML object');
  }

  const services = Array.isArray(doc.services) ? doc.services : [];
  return {
    version: doc.version || '1',
    services,
    path: resolved
  };
}

async function applyBlueprint({ getClient, blueprintPath, dryRun = false, logger = console } = {}) {
  const blueprint = loadBlueprint({ blueprintPath });
  const client = getClient();
  const servicesResponse = await listServices(client, { limit: 200 });
  const remoteServices = normalizeServicesList(servicesResponse);

  const summary = {
    blueprint: blueprint.path,
    version: blueprint.version,
    dryRun,
    services: []
  };

  for (const serviceDef of blueprint.services) {
    if (!serviceDef || typeof serviceDef !== 'object') continue;
    const name = serviceDef.name;
    if (!name) {
      summary.services.push({ status: 'skipped', reason: 'missing_name', entry: serviceDef });
      continue;
    }

    const remote = findService(remoteServices, serviceDef);
    if (!remote) {
      summary.services.push({ name, status: 'missing_remote' });
      continue;
    }

    const serviceId = remote.id || remote.service?.id;
    const actions = [];

    if (serviceDef.serviceDetails && Object.keys(serviceDef.serviceDetails).length > 0) {
      actions.push('serviceDetails');
      if (!dryRun) {
        await updateService(client, serviceId, { serviceDetails: serviceDef.serviceDetails });
      }
    }

    if (serviceDef.env && Object.keys(serviceDef.env).length > 0) {
      actions.push('env');
      if (!dryRun) {
        await updateEnvVars(client, serviceId, serviceDef.env, { clearOtherVars: Boolean(serviceDef.clearEnv) });
      }
    }

    summary.services.push({
      name,
      serviceId,
      status: actions.length ? (dryRun ? 'would_update' : 'updated') : 'noop',
      actions
    });
  }

  logger.info('[renderctl] blueprint apply complete', summary);
  return summary;
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

function findService(services, target) {
  const targetId = target.id || target.serviceId;
  return services.find((service) => {
    const name = service.name || service.service?.name;
    const id = service.id || service.service?.id;
    if (targetId) {
      return id === targetId;
    }
    return name === target.name;
  });
}

module.exports = {
  loadBlueprint,
  applyBlueprint
};
