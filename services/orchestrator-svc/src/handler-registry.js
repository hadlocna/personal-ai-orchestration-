const { internalFetch } = require('@repo/common');
const { listActiveAgents } = require('./db');
const { executeEchoTask } = require('./handlers/echo');

function sanitizeArray(maybeArray, fallback = []) {
  if (!Array.isArray(maybeArray)) return fallback;
  return maybeArray.map((value) => String(value)).filter(Boolean);
}

function normalizeMode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === 'inline' || mode === 'dispatch') {
    return mode;
  }
  return 'dispatch';
}

class HandlerRegistry {
  constructor({ inlineHandlers = [], agents = [] } = {}) {
    this._handlers = new Map();
    this._taskTypeIndex = new Map();

    [...inlineHandlers, ...agents].forEach((def) => {
      this.register(def);
    });
  }

  static async build() {
    const inlineHandlers = [createEchoInlineHandler()];
    const agentRows = await listActiveAgents();
    const agentHandlers = agentRows
      .map(createHandlerFromAgentRow)
      .filter(Boolean);

    return new HandlerRegistry({ inlineHandlers, agents: agentHandlers });
  }

  register(definition) {
    if (!definition) return;
    const taskTypes = sanitizeArray(definition.taskTypes);
    if (!taskTypes.length) return;

    const normalized = {
      slug: definition.slug,
      displayName: definition.displayName,
      channel: definition.channel,
      mode: definition.mode || 'inline',
      execute: definition.execute,
      dispatch: definition.dispatch,
      metadata: definition.metadata || {},
      source: definition.source || 'inline'
    };

    this._handlers.set(normalized.slug, normalized);
    taskTypes.forEach((type) => {
      this._taskTypeIndex.set(type, normalized);
    });
  }

  resolve(taskType) {
    return this._taskTypeIndex.get(taskType) || null;
  }

  list() {
    return Array.from(this._handlers.values());
  }
}

function createEchoInlineHandler() {
  return {
    slug: 'agent:echo-inline',
    displayName: 'Echo Agent (Inline)',
    channel: 'demo',
    mode: 'inline',
    taskTypes: ['echo'],
    execute: executeEchoTask,
    metadata: {
      description: 'Development echo handler used for smoke tests.'
    },
    source: 'built-in'
  };
}

function createHandlerFromAgentRow(row) {
  try {
    const config = row.config || {};
    const taskTypes = sanitizeArray(config.taskTypes);
    if (!taskTypes.length) return null;

    const mode = normalizeMode(config.mode);
    const dispatchConfig = mode === 'dispatch' ? buildDispatchExecutor(row, config) : null;

    return {
      slug: row.slug,
      displayName: row.display_name,
      channel: row.channel,
      mode,
      taskTypes,
      execute: mode === 'inline' ? null : undefined,
      dispatch: dispatchConfig,
      metadata: config.metadata || {},
      source: 'agent_registry'
    };
  } catch (err) {
    console.error('Failed to parse agent registry entry', row?.slug, err);
    return null;
  }
}

function buildDispatchExecutor(row, config) {
  const dispatch = config.dispatch || {};
  const url = dispatch.url || dispatch.endpoint || config.endpoint;
  if (!url) {
    return null;
  }

  const method = (dispatch.method || 'POST').toUpperCase();
  const includeTask = dispatch.includeTask !== false;
  const includeInternalKey = dispatch.includeInternalKey !== false;
  const additionalHeaders = dispatch.headers || {};

  return async function dispatchTask({ task, logger }) {
    const headers = {
      'Content-Type': 'application/json',
      ...additionalHeaders
    };

    if (includeInternalKey && process.env.INTERNAL_KEY) {
      headers['X-INTERNAL-KEY'] = process.env.INTERNAL_KEY;
    }

    if (dispatch.basicAuthEnv) {
      const [userEnv, passEnv] = dispatch.basicAuthEnv;
      const user = process.env[userEnv];
      const pass = process.env[passEnv];
      if (user && pass) {
        headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      }
    }

    if (dispatch.bearerTokenEnv) {
      const token = process.env[dispatch.bearerTokenEnv];
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const body = includeTask ? { task } : dispatch.body || {};

    const response = await internalFetch(url, {
      method,
      headers,
      body
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Dispatch failed (agent ${row.slug}): ${response.status} ${text}`.trim());
    }

    if (dispatch.expectJson === false) {
      await response.text().catch(() => '');
      return null;
    }

    return response.json().catch(() => null);
  };
}

module.exports = {
  HandlerRegistry
};
