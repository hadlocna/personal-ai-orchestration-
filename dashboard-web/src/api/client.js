const DEFAULT_HEADERS = {
  'Content-Type': 'application/json'
};

export function encodeBasicAuth(username, password) {
  if (!username || !password) return null;
  const value = `${username}:${password}`;
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return `Basic ${window.btoa(value)}`;
  }
  if (typeof Buffer !== 'undefined') {
    return `Basic ${Buffer.from(value, 'utf-8').toString('base64')}`;
  }
  return null;
}

export function createApiClient({ baseUrl, username, password }) {
  if (!baseUrl) throw new Error('API client requires baseUrl');
  const authHeader = encodeBasicAuth(username, password);

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl).toString();
    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    if (authHeader) headers.Authorization = authHeader;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Request failed: ${response.status} ${text}`.trim());
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return response.text();
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
      const query = search.toString();
      const path = query ? `/tasks?${query}` : '/tasks';
      return request(path);
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
      const basePath = params.baseLogsPath || '/logs';
      const query = search.toString();
      const path = query ? `${basePath}?${query}` : basePath;
      return request(path);
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
