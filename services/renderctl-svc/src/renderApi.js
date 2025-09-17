const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.render.com/v1';

function createClient({ token = process.env.RENDER_API_TOKEN, baseURL = DEFAULT_BASE_URL } = {}) {
  if (!token) {
    throw new Error('RENDER_API_TOKEN is required to call Render API');
  }

  const client = axios.create({
    baseURL,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response) {
        const { status, data } = error.response;
        const err = new Error(`Render API error ${status}`);
        err.status = status;
        err.data = data;
        throw err;
      }
      throw error;
    }
  );

  return client;
}

async function createService(client, payload) {
  const response = await client.post('/services', payload);
  return response.data;
}

async function listServices(client, params = {}) {
  const response = await client.get('/services', { params });
  return response.data;
}

async function updateEnvVars(client, serviceId, envVars, options = {}) {
  const { clearOtherVars = false } = options;

  if (!serviceId) {
    throw new Error('serviceId is required');
  }

  const items = Object.entries(envVars || {}).map(([key, value]) => ({
    key,
    value,
    type: inferEnvType(key)
  }));

  const response = await client.put(`/services/${serviceId}/env-vars`, {
    envVars: items,
    clearExisting: Boolean(clearOtherVars)
  });

  return response.data;
}

async function triggerDeploy(client, serviceId, body = {}) {
  if (!serviceId) {
    throw new Error('serviceId is required');
  }

  const response = await client.post(`/services/${serviceId}/deploys`, body);
  return response.data;
}

function inferEnvType(key) {
  return /token|secret|key|pass/i.test(key) ? 'secret' : 'plain';
}

module.exports = {
  createClient,
  createService,
  listServices,
  updateEnvVars,
  triggerDeploy
};
