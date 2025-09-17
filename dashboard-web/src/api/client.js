const DEFAULT_HEADERS = {
  'Content-Type': 'application/json'
};

function encodeBasicAuth(username, password) {
  if (!username || !password) return null;
  const value = `${username}:${password}`;
  if (typeof Buffer !== 'undefined') {
    return `Basic ${Buffer.from(value).toString('base64')}`;
  }
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return `Basic ${window.btoa(value)}`;
  }
  return null;
}

function createApiClient({ baseUrl, username, password }) {
  if (!baseUrl) throw new Error('API client requires baseUrl');
  const authHeader = encodeBasicAuth(username, password);

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl).toString();
    const headers = Object.assign({}, DEFAULT_HEADERS, options.headers);
    if (authHeader) headers.Authorization = authHeader;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  return {
    async listTasks(params = {}) {
      const search = new URLSearchParams();
      if (params.status) search.set('status', params.status);
      if (params.corrId) search.set('corrId', params.corrId);
      if (params.since) search.set('since', params.since);
      if (params.limit) search.set('limit', String(params.limit));
      return request(`/tasks?${search.toString()}`);
    },

    async getTask(id) {
      return request(`/task/${id}`);
    },

    async createTask(payload) {
      return request('/task', {
        method: 'POST',
        body: payload
      });
    },

    async patchTask(id, patch) {
      return request(`/task/${id}`, {
        method: 'PATCH',
        body: patch
      });
    },

    async fetchLogs(params = {}) {
      const search = new URLSearchParams();
      if (params.service) search.set('service', params.service);
      if (params.level) search.set('level', params.level);
      if (params.corrId) search.set('corrId', params.corrId);
      if (params.traceId) search.set('traceId', params.traceId);
      if (params.taskId) search.set('taskId', params.taskId);
      if (params.since) search.set('since', params.since);
      if (params.limit) search.set('limit', String(params.limit));
      return request(`${params.baseLogsPath || '/logs'}?${search.toString()}`);
    },

    openWebsocket({ wsUrl, onMessage }) {
      if (!wsUrl) throw new Error('wsUrl is required');
      const socket = new WebSocket(wsUrl);
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (onMessage) onMessage(frame);
        } catch (err) {
          console.error('Failed to parse websocket frame', err);
        }
      };
      return socket;
    }
  };
}

module.exports = {
  createApiClient
};
