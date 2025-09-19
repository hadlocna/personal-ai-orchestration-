const { URL } = require('url');
const { listActiveAgents } = require('./db');

const CACHE_TTL_MS = 60_000;
let cache = {
  expiresAt: 0,
  registry: null
};

async function loadAgentRegistry() {
  const now = Date.now();
  if (cache.registry && cache.expiresAt > now) {
    return cache.registry;
  }

  const dbAgents = await fetchAgentsFromDatabase();
  const fallbackAgents = buildFallbackAgents();

  const agents = mergeAgents(dbAgents, fallbackAgents);
  const bySlug = new Map();
  const byTaskType = new Map();

  for (const agent of agents) {
    if (!agent || !agent.slug) continue;
    bySlug.set(agent.slug, agent);
    for (const type of agent.taskTypes) {
      if (!byTaskType.has(type)) {
        byTaskType.set(type, []);
      }
      byTaskType.get(type).push(agent);
    }
  }

  const registry = { agents, bySlug, byTaskType };
  cache = {
    expiresAt: now + CACHE_TTL_MS,
    registry
  };
  return registry;
}

async function fetchAgentsFromDatabase() {
  try {
    const rows = await listActiveAgents();
    return rows
      .map((row) => normalizeAgentRow(row))
      .filter(Boolean);
  } catch (err) {
    console.warn('Failed to load agents from database', err.message || err);
    return [];
  }
}

function normalizeAgentRow(row) {
  if (!row) return null;
  let config = {};
  if (row.config) {
    try {
      config = typeof row.config === 'object' ? row.config : JSON.parse(row.config);
    } catch (err) {
      console.warn('Failed to parse agent config', row.slug, err.message || err);
      config = {};
    }
  }

  const slug = row.slug || config.slug;
  if (!slug) return null;

  const endpoint = config.endpoint || row.endpoint || null;
  if (!endpoint) return null;

  const taskTypes = Array.isArray(config.taskTypes) && config.taskTypes.length
    ? config.taskTypes
    : Array.isArray(config.task_types) && config.task_types.length
      ? config.task_types
      : [];
  if (!taskTypes.length) return null;

  const mode = config.mode || row.mode || 'dispatch';
  const method = (config.method || 'POST').toUpperCase();
  const channel = row.channel || config.channel || null;
  const auth = config.auth || 'internal';

  return {
    id: row.id || null,
    slug,
    displayName: row.display_name || config.displayName || slug,
    channel,
    endpoint,
    mode,
    method,
    taskTypes,
    auth
  };
}

function buildFallbackAgents() {
  const definitions = [];
  pushIfValid(definitions, buildFallbackAgent({
    slug: 'echo-agent',
    displayName: 'Echo Agent',
    envVar: 'ECHO_AGENT_URL',
    channel: 'internal',
    mode: 'request-response',
    taskTypes: ['echo'],
    auth: 'internal'
  }));

  pushIfValid(definitions, buildFallbackAgent({
    slug: 'call-agent',
    displayName: 'Call Agent',
    envVar: 'CALL_AGENT_URL',
    channel: 'voice',
    mode: 'dispatch',
    taskTypes: ['call.start', 'call.retry'],
    auth: 'internal'
  }));

  pushIfValid(definitions, buildFallbackAgent({
    slug: 'messaging-agent',
    displayName: 'Messaging Agent',
    envVar: 'MESSAGING_AGENT_URL',
    channel: 'sms',
    mode: 'dispatch',
    taskTypes: ['sms.send', 'whatsapp.send'],
    auth: 'internal'
  }));

  pushIfValid(definitions, buildFallbackAgent({
    slug: 'email-agent',
    displayName: 'Email Agent',
    envVar: 'EMAIL_AGENT_URL',
    channel: 'email',
    mode: 'dispatch',
    taskTypes: ['email.send'],
    auth: 'internal'
  }));

  pushIfValid(definitions, buildFallbackAgent({
    slug: 'content-agent',
    displayName: 'Content Agent',
    envVar: 'CONTENT_AGENT_URL',
    channel: 'content',
    mode: 'dispatch',
    taskTypes: ['content.generate'],
    auth: 'internal'
  }));

  return definitions;
}

function buildFallbackAgent({ slug, displayName, envVar, channel, mode, taskTypes, auth }) {
  const value = process.env[envVar];
  if (!value) return null;
  try {
    // Validate URL
    new URL(value);
  } catch (err) {
    console.warn(`Invalid URL for ${envVar}:`, err.message || err);
    return null;
  }
  return {
    id: null,
    slug,
    displayName,
    channel,
    endpoint: value,
    mode,
    method: 'POST',
    taskTypes: taskTypes || [],
    auth: auth || 'internal'
  };
}

function mergeAgents(dbAgents, fallbackAgents) {
  const map = new Map();
  for (const agent of fallbackAgents) {
    if (!agent) continue;
    map.set(agent.slug, agent);
  }
  for (const agent of dbAgents) {
    if (!agent) continue;
    map.set(agent.slug, agent);
  }
  return Array.from(map.values());
}

async function resolveAgentForTask(taskType) {
  if (!taskType) return null;
  const registry = await loadAgentRegistry();
  const candidates = registry.byTaskType.get(taskType) || [];
  return candidates.length ? candidates[0] : null;
}

async function getAgentBySlug(slug) {
  if (!slug) return null;
  const registry = await loadAgentRegistry();
  return registry.bySlug.get(slug) || null;
}

module.exports = {
  loadAgentRegistry,
  resolveAgentForTask,
  getAgentBySlug
};
