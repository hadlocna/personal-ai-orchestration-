import { createApiClient, encodeBasicAuth } from './api/client.js';

const STORAGE_KEY = 'paio-dashboard-settings';
const MAX_ACTIVITY_ENTRIES = 200;
const MAX_LOG_ENTRIES = 300;
const SETTINGS_KEYS = [
  'orchestratorUrl',
  'websocketUrl',
  'loggingUrl',
  'echoUrl',
  'renderctlUrl',
  'username',
  'password',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioBaseUrl',
  'hubspotApiKey',
  'hubspotBaseUrl',
  'openaiApiKey',
  'openaiBaseUrl',
  'googleApiKey',
  'googleBaseUrl'
];

const BASE_DEFAULT_SETTINGS = Object.freeze({
  orchestratorUrl: 'https://personal-ai-orchestration.onrender.com',
  websocketUrl: '',
  loggingUrl: 'https://logging-svc.onrender.com',
  echoUrl: 'https://echo-agent-svc.onrender.com',
  renderctlUrl: 'https://renderctl-svc.onrender.com',
  username: '',
  password: '',
  twilioAccountSid: '',
  twilioAuthToken: '',
  twilioBaseUrl: 'https://api.twilio.com',
  hubspotApiKey: '',
  hubspotBaseUrl: 'https://api.hubapi.com',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com',
  googleApiKey: '',
  googleBaseUrl: 'https://www.googleapis.com'
});

const defaultSettings = buildDefaultSettings();

const elements = {
  connectionStatus: document.getElementById('connection-status'),
  toggleSettings: document.getElementById('toggle-settings'),
  settingsCard: document.getElementById('settings-card'),
  settingsForm: document.getElementById('settings-form'),
  clearSettings: document.getElementById('clear-settings'),
  refreshTasks: document.getElementById('refresh-tasks'),
  refreshConfig: document.getElementById('refresh-config'),
  summary: {
    total: document.getElementById('summary-total'),
    queued: document.getElementById('summary-queued'),
    running: document.getElementById('summary-running'),
    done: document.getElementById('summary-done'),
    error: document.getElementById('summary-error')
  },
  filterForm: document.getElementById('task-filter-form'),
  taskTableBody: document.getElementById('task-table-body'),
  taskDetail: document.getElementById('task-detail'),
  newTaskForm: document.getElementById('new-task-form'),
  newTaskFeedback: document.getElementById('new-task-feedback'),
  activityList: document.getElementById('activity-list'),
  activityTemplate: document.getElementById('activity-item-template'),
  configResults: document.getElementById('config-results'),
  runConnectivity: document.getElementById('run-connectivity'),
  connectivityResults: document.getElementById('connectivity-results'),
  logOutput: document.getElementById('log-output'),
  clearLogs: document.getElementById('clear-logs'),
  copyLogs: document.getElementById('copy-logs'),
  dbSnapshot: document.getElementById('db-snapshot'),
  refreshDbSnapshot: document.getElementById('refresh-db-snapshot')
};

const state = {
  tasks: new Map(),
  filters: { status: '', corrId: '', limit: 50 },
  selectedTaskId: null,
  selectedTaskDetail: null,
  events: [],
  configReports: [],
  connectivity: {
    running: false,
    results: [],
    lastRun: null,
    error: null,
    dbSummary: null
  },
  logs: [],
  dbSnapshot: {
    loading: false,
    error: null,
    tasks: [],
    logs: [],
    events: [],
    lastUpdated: null
  }
};

let settings = loadSettings();
let orchestratorClient = null;
let loggingClient = null;
let websocket = null;
let reconnectTimer = null;

applySettingsToForm(settings);
renderTaskTable();
renderActivity();
renderTaskDetail();
renderConfigReports();
renderSummary();
renderConnectivity();
renderLogs();
renderDatabaseSnapshot();

if (settings.orchestratorUrl) {
  initializeConnections();
}

elements.toggleSettings?.addEventListener('click', toggleSettingsCard);
elements.clearSettings?.addEventListener('click', clearStoredSettings);
elements.settingsForm?.addEventListener('submit', onSettingsSubmit);
elements.refreshTasks?.addEventListener('click', () => {
  refreshTasks();
});
elements.refreshConfig?.addEventListener('click', () => {
  refreshConfig();
});
elements.filterForm?.addEventListener('submit', onFilterSubmit);
elements.taskTableBody?.addEventListener('click', onTaskRowClick);
elements.newTaskForm?.addEventListener('submit', onNewTaskSubmit);
elements.runConnectivity?.addEventListener('click', () => {
  runConnectivityCheck();
});
elements.clearLogs?.addEventListener('click', clearLogs);
elements.copyLogs?.addEventListener('click', copyLogs);
elements.refreshDbSnapshot?.addEventListener('click', refreshDatabaseSnapshot);

function onSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(elements.settingsForm);
  settings = {
    orchestratorUrl: formData.get('orchestratorUrl')?.trim() || '',
    websocketUrl: formData.get('websocketUrl')?.trim() || '',
    loggingUrl: formData.get('loggingUrl')?.trim() || '',
    echoUrl: formData.get('echoUrl')?.trim() || '',
    renderctlUrl: formData.get('renderctlUrl')?.trim() || '',
    twilioAccountSid: formData.get('twilioAccountSid')?.trim() || '',
    twilioAuthToken: formData.get('twilioAuthToken')?.trim() || '',
    twilioBaseUrl: valueOrDefault(formData.get('twilioBaseUrl'), defaultSettings.twilioBaseUrl),
    hubspotApiKey: formData.get('hubspotApiKey')?.trim() || '',
    hubspotBaseUrl: valueOrDefault(formData.get('hubspotBaseUrl'), defaultSettings.hubspotBaseUrl),
    openaiApiKey: formData.get('openaiApiKey')?.trim() || '',
    openaiBaseUrl: valueOrDefault(formData.get('openaiBaseUrl'), defaultSettings.openaiBaseUrl),
    googleApiKey: formData.get('googleApiKey')?.trim() || '',
    googleBaseUrl: valueOrDefault(formData.get('googleBaseUrl'), defaultSettings.googleBaseUrl),
    username: formData.get('username')?.trim() || '',
    password: formData.get('password') || ''
  };

  if (!settings.orchestratorUrl) {
    alert('Orchestrator base URL is required to connect.');
    return;
  }

  saveSettings(settings);
  initializeConnections();
}

function onFilterSubmit(event) {
  event.preventDefault();
  const formData = new FormData(elements.filterForm);
  state.filters = {
    status: formData.get('status') || '',
    corrId: formData.get('corrId')?.trim() || '',
    limit: clampLimit(Number(formData.get('limit'))) || 50
  };
  refreshTasks();
}

function onTaskRowClick(event) {
  const row = event.target.closest('tr[data-task-id]');
  if (!row) return;
  const taskId = row.dataset.taskId;
  if (!taskId) return;
  state.selectedTaskId = taskId;
  highlightSelectedRow(taskId);
  loadTaskDetail(taskId);
}

async function onNewTaskSubmit(event) {
  event.preventDefault();
  if (!orchestratorClient) {
    setTaskFeedback('Connect to the orchestrator to create tasks.', 'error');
    return;
  }

  const formData = new FormData(elements.newTaskForm);
  const type = formData.get('type')?.trim();
  const source = formData.get('source')?.trim();
  const corrId = formData.get('corrId')?.trim() || undefined;
  const rawPayload = formData.get('payload')?.trim();

  if (!type || !source) {
    setTaskFeedback('Type and source are required.', 'error');
    return;
  }

  let payload;
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch (err) {
      setTaskFeedback('Payload must be valid JSON.', 'error');
      return;
    }
  }

  try {
    const result = await orchestratorClient.createTask({
      type,
      source,
      correlationId: corrId,
      payload: payload ?? {}
    });
    setTaskFeedback(`Task ${result?.id || ''} queued successfully.`, 'success');
    elements.newTaskForm.reset();
    refreshTasks();
  } catch (err) {
    console.error('Failed to create task', err);
    setTaskFeedback(err.message || 'Failed to queue task.', 'error');
  }
}

function loadSettings() {
  if (typeof localStorage === 'undefined') {
    return { ...defaultSettings };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...defaultSettings };
    }
    const parsed = JSON.parse(raw);
    const merged = {};
    SETTINGS_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        merged[key] = parsed[key];
      } else {
        merged[key] = defaultSettings[key] ?? '';
      }
    });
    return merged;
  } catch (err) {
    console.warn('Failed to load stored settings', err);
    return { ...defaultSettings };
  }
}

function saveSettings(next) {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = {};
    SETTINGS_KEYS.forEach((key) => {
      payload[key] = next[key] ?? '';
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to persist settings', err);
  }
}

function clearStoredSettings() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  settings = { ...defaultSettings };
  applySettingsToForm(settings);
  disconnectWebsocket();
  orchestratorClient = null;
  loggingClient = null;
  state.tasks.clear();
  state.events = [];
  state.selectedTaskDetail = null;
  state.selectedTaskId = null;
  state.connectivity = { running: false, results: [], lastRun: null, error: null, dbSummary: null };
  state.dbSnapshot = {
    loading: false,
    error: null,
    tasks: [],
    logs: [],
    events: [],
    lastUpdated: null
  };
  renderSummary();
  renderTaskTable();
  renderTaskDetail();
  renderActivity();
  renderConfigReports();
  renderConnectivity('Provide service URLs above to run connectivity checks.');
  renderDatabaseSnapshot('Connect to load database state.');
  appendLog('info', 'Settings', 'Connections reset to defaults.');
  setConnectionStatus('disconnected', 'Disconnected');
}

function applySettingsToForm(config) {
  const form = elements.settingsForm;
  if (!form) return;
  form.elements.orchestratorUrl.value = config.orchestratorUrl || '';
  form.elements.websocketUrl.value = config.websocketUrl || '';
  form.elements.loggingUrl.value = config.loggingUrl || '';
  form.elements.echoUrl.value = config.echoUrl || '';
  form.elements.renderctlUrl.value = config.renderctlUrl || '';
  if (form.elements.twilioAccountSid) form.elements.twilioAccountSid.value = config.twilioAccountSid || '';
  if (form.elements.twilioAuthToken) form.elements.twilioAuthToken.value = config.twilioAuthToken || '';
  if (form.elements.twilioBaseUrl) form.elements.twilioBaseUrl.value = config.twilioBaseUrl || '';
  if (form.elements.hubspotApiKey) form.elements.hubspotApiKey.value = config.hubspotApiKey || '';
  if (form.elements.hubspotBaseUrl) form.elements.hubspotBaseUrl.value = config.hubspotBaseUrl || '';
  if (form.elements.openaiApiKey) form.elements.openaiApiKey.value = config.openaiApiKey || '';
  if (form.elements.openaiBaseUrl) form.elements.openaiBaseUrl.value = config.openaiBaseUrl || '';
  if (form.elements.googleApiKey) form.elements.googleApiKey.value = config.googleApiKey || '';
  if (form.elements.googleBaseUrl) form.elements.googleBaseUrl.value = config.googleBaseUrl || '';
  form.elements.username.value = config.username || '';
  form.elements.password.value = config.password || '';
}

async function initializeConnections() {
  disconnectWebsocket();

  try {
    orchestratorClient = createApiClient({
      baseUrl: settings.orchestratorUrl,
      username: settings.username,
      password: settings.password
    });
  } catch (err) {
    console.error('Failed to create orchestrator client', err);
    setConnectionStatus('error', 'Invalid orchestrator URL');
    return;
  }

  try {
    loggingClient = settings.loggingUrl
      ? createApiClient({
          baseUrl: settings.loggingUrl,
          username: settings.username,
          password: settings.password
        })
      : null;
  } catch (err) {
    console.warn('Failed to create logging client', err);
    loggingClient = null;
  }

  setConnectionStatus('connecting', 'Connecting…');
  appendLog('info', 'Connections', `Connecting to orchestrator at ${settings.orchestratorUrl}`);

  await Promise.allSettled([refreshTasks(), refreshActivity(), refreshConfig()]);
  await runConnectivityCheck();
  await refreshDatabaseSnapshot();
  connectWebsocket();
}

async function refreshTasks() {
  if (!orchestratorClient) return;
  try {
    const { status, corrId, limit } = state.filters;
    const response = await orchestratorClient.listTasks({
      status: status || undefined,
      corrId: corrId || undefined,
      limit: limit || undefined
    });
    const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
    state.tasks.clear();
    tasks.forEach((task) => {
      state.tasks.set(task.id, task);
    });
    renderSummary();
    renderTaskTable();
  } catch (err) {
    console.error('Failed to fetch tasks', err);
    recordActivity({
      type: 'ERROR',
      ts: new Date().toISOString(),
      summary: 'Failed to load tasks',
      detail: err.message || 'unknown error'
    });
    renderTaskTable();
  }
}

async function loadTaskDetail(taskId) {
  if (!orchestratorClient) return;
  try {
    const detail = await orchestratorClient.getTask(taskId);
    state.selectedTaskDetail = detail;
    renderTaskDetail();
  } catch (err) {
    console.error('Failed to load task detail', err);
    state.selectedTaskDetail = null;
    renderTaskDetail('Unable to load task detail.');
  }
}

async function refreshActivity() {
  state.events = [];

  if (loggingClient) {
    try {
      const response = await loggingClient.fetchLogs({ limit: 50 });
      const logs = Array.isArray(response?.logs) ? response.logs : [];
      logs
        .sort((a, b) => new Date(a.ts_utc).getTime() - new Date(b.ts_utc).getTime())
        .forEach((log) => {
          recordActivity(buildActivityEntry('LOG', log.ts_utc || log.ts, log.message, log));
        });
    } catch (err) {
      console.warn('Failed to preload logs', err);
    }
  }

  // Include recent task snapshots as context
  const tasks = Array.from(state.tasks.values())
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
    .slice(-10);
  tasks.forEach((task) => {
    recordActivity(
      buildActivityEntry(
        'TASK_UPDATE',
        task.updated_at,
        `Task ${shortId(task.id)} is ${task.status}`,
        task
      )
    );
  });

  renderActivity();
}

async function refreshConfig() {
  const targets = [
    { key: 'orchestrator', name: 'Orchestrator', base: settings.orchestratorUrl },
    { key: 'logging', name: 'Logging', base: settings.loggingUrl },
    { key: 'echo', name: 'Echo Agent', base: settings.echoUrl },
    { key: 'renderctl', name: 'Render Control', base: settings.renderctlUrl }
  ].filter((target) => target.base);

  if (!targets.length) {
    state.configReports = [];
    renderConfigReports('Provide service URLs above to run config validation.');
    return;
  }

  const headers = buildAuthHeaders();
  const reports = await Promise.all(
    targets.map(async (target) => {
      try {
        const url = new URL('/config/validate', target.base).toString();
        const response = await fetch(url, { headers });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }
        const json = await response.json();
        return {
          key: target.key,
          name: target.name,
          status: json.status || 'unknown',
          required: json.required || {},
          optional: json.optional || {},
          errors: json.errors || []
        };
      } catch (err) {
        return {
          key: target.key,
          name: target.name,
          status: 'error',
          required: {},
          optional: {},
          errors: [{ message: err.message || 'Failed to fetch config report' }]
        };
      }
    })
  );

  state.configReports = reports;
  renderConfigReports();
}

async function refreshDatabaseSnapshot() {
  if (!orchestratorClient && !loggingClient) {
    state.dbSnapshot = {
      loading: false,
      error: 'Connect to orchestrator and logging services to inspect persisted records.',
      tasks: [],
      logs: [],
      events: [],
      lastUpdated: null
    };
    renderDatabaseSnapshot();
    appendLog('warn', 'Database Snapshot', 'Skipped snapshot refresh because API clients are not connected.');
    return;
  }

  state.dbSnapshot.loading = true;
  state.dbSnapshot.error = null;
  renderDatabaseSnapshot();
  appendLog('info', 'Database Snapshot', 'Fetching latest persisted records.');

  const tasksPromise = orchestratorClient
    ? orchestratorClient.listTasks({ limit: 5 })
    : Promise.resolve({ tasks: [] });
  const logsPromise = loggingClient
    ? loggingClient.fetchLogs({ limit: 5 })
    : Promise.resolve({ logs: [] });
  const eventsPromise = loggingClient
    ? loggingClient.fetchTaskEvents({ limit: 5 })
    : Promise.resolve({ events: [] });

  const [tasksResult, logsResult, eventsResult] = await Promise.allSettled([
    tasksPromise,
    logsPromise,
    eventsPromise
  ]);

  const snapshot = state.dbSnapshot;
  snapshot.loading = false;
  snapshot.lastUpdated = new Date().toISOString();

  const errors = [];

  if (tasksResult.status === 'fulfilled') {
    snapshot.tasks = Array.isArray(tasksResult.value?.tasks) ? tasksResult.value.tasks : [];
  } else {
    snapshot.tasks = [];
    errors.push(`tasks: ${inferNetworkError(tasksResult.reason)}`);
    appendLog('error', 'Database Snapshot', 'Failed to fetch tasks snapshot', inferNetworkError(tasksResult.reason));
  }

  if (logsResult.status === 'fulfilled') {
    snapshot.logs = Array.isArray(logsResult.value?.logs) ? logsResult.value.logs : [];
  } else {
    snapshot.logs = [];
    errors.push(`logs: ${inferNetworkError(logsResult.reason)}`);
    appendLog('error', 'Database Snapshot', 'Failed to fetch logs snapshot', inferNetworkError(logsResult.reason));
  }

  if (eventsResult.status === 'fulfilled') {
    snapshot.events = Array.isArray(eventsResult.value?.events) ? eventsResult.value.events : [];
  } else {
    snapshot.events = [];
    errors.push(`task events: ${inferNetworkError(eventsResult.reason)}`);
    appendLog('error', 'Database Snapshot', 'Failed to fetch task events snapshot', inferNetworkError(eventsResult.reason));
  }

  if (errors.length) {
    snapshot.error = `One or more queries failed: ${errors.join('; ')}`;
    state.connectivity.dbSummary = {
      key: 'database',
      name: 'Database (Postgres)',
      overall: 'error',
      category: 'database',
      checks: [
        {
          key: 'snapshot',
          label: 'Snapshot',
          status: 'error',
          detail: snapshot.error
        }
      ]
    };
  } else {
    snapshot.error = null;
    appendLog('info', 'Database Snapshot', 'Snapshot refreshed successfully.');
    state.connectivity.dbSummary = {
      key: 'database',
      name: 'Database (Postgres)',
      overall: 'ok',
      category: 'database',
      checks: [
        {
          key: 'tasks',
          label: 'Tasks',
          status: snapshot.tasks.length ? 'ok' : 'warn',
          detail: `${snapshot.tasks.length} recent`
        },
        {
          key: 'logs',
          label: 'Logs',
          status: snapshot.logs.length ? 'ok' : 'warn',
          detail: `${snapshot.logs.length} recent`
        },
        {
          key: 'events',
          label: 'Task Events',
          status: snapshot.events.length ? 'ok' : 'warn',
          detail: `${snapshot.events.length} recent`
        }
      ]
    };
  }

  renderDatabaseSnapshot();
  renderConnectivity();
}

async function runConnectivityCheck() {
  const services = [
    { key: 'orchestrator', name: 'Orchestrator', base: settings.orchestratorUrl },
    { key: 'logging', name: 'Logging', base: settings.loggingUrl },
    { key: 'echo', name: 'Echo Agent', base: settings.echoUrl },
    { key: 'renderctl', name: 'Render Control', base: settings.renderctlUrl }
  ];

  const integrations = buildIntegrationTargets(settings);
  const hasServiceTargets = services.some((svc) => svc.base);
  const hasIntegrationTargets = integrations.some((integration) => integration.isConfigured);

  if (!hasServiceTargets && !hasIntegrationTargets) {
    state.connectivity = { running: false, results: [], lastRun: null, error: null };
    renderConnectivity('Provide service URLs above to run connectivity checks.');
    appendLog('warn', 'Connectivity', 'No service URLs configured; check skipped.');
    return;
  }

  state.connectivity.running = true;
  state.connectivity.error = null;
  state.connectivity.results = [];
  state.connectivity.dbSummary = null;
  renderConnectivity();
  appendLog('info', 'Connectivity', 'Starting connectivity diagnostic run.');

  try {
    const serviceResults = await Promise.all(
      services.map(async (service) => {
        if (!service.base) {
          return {
            ...service,
            overall: 'missing',
            checks: [],
            note: 'No base URL configured.',
            category: 'service'
          };
        }

        appendLog('info', service.name, `Checking ${service.base}`);
        const endpoints = [
          { key: 'health', label: 'Health', path: '/health', summarize: summarizeHealth },
          { key: 'config', label: 'Config', path: '/config/validate', summarize: summarizeConfig }
        ];

        const checks = [];
        let overall = 'ok';

        for (const endpoint of endpoints) {
          try {
            const payload = await fetchJsonish(service.base, endpoint.path);
            const summary = endpoint.summarize(payload);
            checks.push({
              key: endpoint.key,
              label: endpoint.label,
              status: summary.status,
              detail: summary.detail || ''
            });
            if (summary.status === 'error') {
              overall = 'error';
            } else if (summary.status === 'warn' && overall === 'ok') {
              overall = 'warn';
            }
            appendLog(summary.status === 'ok' ? 'info' : 'warn', service.name, `${endpoint.label} → ${summary.status.toUpperCase()}${summary.detail ? ` (${summary.detail})` : ''}`);
          } catch (err) {
            const errorDetail = inferNetworkError(err);
            checks.push({
              key: endpoint.key,
              label: endpoint.label,
              status: 'error',
              detail: errorDetail
            });
            overall = 'error';
            appendLog('error', service.name, `${endpoint.label} request failed`, errorDetail);
          }
        }

        return {
          ...service,
          overall,
          checks,
          category: 'service'
        };
      })
    );

    const integrationResults = await Promise.all(
      integrations.map(async (integration) => {
        if (!integration.isConfigured) {
          appendLog('warn', integration.name, integration.skipLog || 'Credentials missing; skipping.');
          return {
            name: integration.name,
            overall: 'missing',
            checks: [],
            note: integration.missingNote,
            category: 'integration'
          };
        }

        appendLog('info', integration.name, 'Checking API credentials');
        try {
          const outcome = await integration.run();
          const overall = outcome.overall || 'ok';
          const checks = outcome.checks || [];
          const logLevel = overall === 'ok' ? 'info' : overall === 'warn' ? 'warn' : 'error';
          appendLog(logLevel, integration.name, `Check completed with status ${overall.toUpperCase()}.`);
          return {
            name: integration.name,
            overall,
            checks,
            category: 'integration'
          };
        } catch (err) {
          const detail = inferNetworkError(err);
          appendLog('error', integration.name, 'Request failed', detail);
          return {
            name: integration.name,
            overall: 'error',
            checks: [
              {
                key: 'request',
                label: 'Request',
                status: 'error',
                detail
              }
            ],
            category: 'integration'
          };
        }
      })
    );

    state.connectivity.results = [...serviceResults, ...integrationResults];
    state.connectivity.lastRun = new Date().toISOString();
    appendLog('info', 'Connectivity', 'Connectivity run completed. Review results above.');
  } catch (err) {
    console.error('Connectivity check failed', err);
    const errorDetail = inferNetworkError(err);
    state.connectivity.error = errorDetail;
    appendLog('error', 'Connectivity', 'Connectivity run failed', errorDetail);
  } finally {
    state.connectivity.running = false;
    renderConnectivity();
  }
}

function connectWebsocket() {
  const wsUrl = buildWebsocketUrl();
  if (!wsUrl) {
    setConnectionStatus('error', 'Invalid WebSocket URL');
    return;
  }

  try {
    websocket = new WebSocket(wsUrl);
  } catch (err) {
    console.error('WebSocket connection failed', err);
    setConnectionStatus('error', 'WebSocket error');
    scheduleReconnect();
    return;
  }

  websocket.onopen = () => {
    setConnectionStatus('connected', 'Live');
    appendLog('info', 'WebSocket', 'Connected to orchestrator stream.');
  };

  websocket.onerror = (event) => {
    console.warn('WebSocket error', event);
    setConnectionStatus('error', 'WebSocket error');
    appendLog('error', 'WebSocket', 'WebSocket reported an error.', event?.message || '');
  };

  websocket.onclose = () => {
    setConnectionStatus('disconnected', 'Disconnected');
    scheduleReconnect();
    appendLog('warn', 'WebSocket', 'WebSocket connection closed. Retrying shortly.');
  };

  websocket.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data);
      handleWebsocketFrame(frame);
    } catch (err) {
      console.error('Failed to parse websocket frame', err);
    }
  };
}

function disconnectWebsocket() {
  if (websocket) {
    websocket.onopen = null;
    websocket.onclose = null;
    websocket.onerror = null;
    websocket.onmessage = null;
    websocket.close();
    websocket = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !settings.orchestratorUrl) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebsocket();
  }, 4000);
}

function handleWebsocketFrame(frame) {
  if (!frame || !frame.type) return;
  const { type, data, ts } = frame;

  switch (type) {
    case 'TASK_UPDATE': {
      if (data && data.id) {
        state.tasks.set(data.id, data);
        renderSummary();
        renderTaskTable();
        if (state.selectedTaskId === data.id) {
          // refresh detail from latest data if version changed
          loadTaskDetail(data.id);
        }
        recordActivity(
          buildActivityEntry(
            'TASK_UPDATE',
            ts || data.updated_at,
            `Task ${shortId(data.id)} is ${data.status}`,
            data
          )
        );
      }
      break;
    }
    case 'TASK_EVENT': {
      if (data && data.taskId && state.selectedTaskDetail?.task?.id === data.taskId) {
        const eventSnapshot = {
          id: data.id,
          task_id: data.taskId,
          actor: data.actor,
          kind: data.kind,
          data: data.data || null,
          ts_utc: data.ts || new Date().toISOString()
        };
        state.selectedTaskDetail.events = state.selectedTaskDetail.events || [];
        state.selectedTaskDetail.events.push(eventSnapshot);
        renderTaskDetail();
      }
      recordActivity(
        buildActivityEntry(
          'TASK_EVENT',
          data?.ts || ts,
          `${data?.kind || 'event'} from ${data?.actor || 'unknown'}`,
          data
        )
      );
      break;
    }
    case 'LOG': {
      recordActivity(
        buildActivityEntry(
          'LOG',
          data?.ts_utc || ts,
          `${data?.service || 'log'} • ${data?.message || ''}`.trim(),
          data
        )
      );
      break;
    }
    default:
      recordActivity(buildActivityEntry(type, ts, type, data));
      break;
  }
}

function renderSummary() {
  const totals = { total: 0, queued: 0, running: 0, done: 0, error: 0 };
  for (const task of state.tasks.values()) {
    totals.total += 1;
    if (task.status && totals[task.status] !== undefined) {
      totals[task.status] += 1;
    }
  }
  elements.summary.total.textContent = totals.total;
  elements.summary.queued.textContent = totals.queued;
  elements.summary.running.textContent = totals.running;
  elements.summary.done.textContent = totals.done;
  elements.summary.error.textContent = totals.error;
}

function renderTaskTable() {
  const tbody = elements.taskTableBody;
  if (!tbody) return;

  const rows = Array.from(state.tasks.values());
  rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="5">No tasks available.</td></tr>';
    return;
  }

  const parts = rows.map((task) => {
    const statusClass = `status-pill status-${task.status || 'queued'}`;
    const correlation = task.correlation_id || '—';
    return `
      <tr data-task-id="${task.id}" class="${state.selectedTaskId === task.id ? 'active' : ''}">
        <td class="mono">${shortId(task.id)}</td>
        <td>${escapeHtml(task.type)}</td>
        <td><span class="${statusClass}">${escapeHtml(task.status || 'queued')}</span></td>
        <td>${formatTimestamp(task.updated_at)}</td>
        <td class="mono">${escapeHtml(correlation)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = parts.join('');
}

function renderTaskDetail(errorMessage) {
  const container = elements.taskDetail;
  if (!container) return;

  if (errorMessage) {
    container.classList.remove('empty');
    container.innerHTML = `<div class="section">${escapeHtml(errorMessage)}</div>`;
    return;
  }

  const detail = state.selectedTaskDetail;
  if (!detail || !detail.task) {
    container.classList.add('empty');
    container.textContent = 'Select a task to inspect payload, result, and events.';
    return;
  }

  container.classList.remove('empty');
  const task = detail.task;
  const events = Array.isArray(detail.events) ? detail.events.slice().reverse() : [];

  container.innerHTML = `
    <div class="section">
      <h3>${escapeHtml(task.type)} • <span class="status-pill status-${task.status}">${escapeHtml(task.status)}</span></h3>
      <p>Task ID: <span class="mono">${escapeHtml(task.id)}</span></p>
      <p>Correlation ID: <span class="mono">${escapeHtml(task.correlation_id || '—')}</span></p>
      <p>Trace ID: <span class="mono">${escapeHtml(task.trace_id)}</span></p>
      <p>Updated: ${formatTimestamp(task.updated_at)}</p>
    </div>
    <div class="section">
      <h3>Payload</h3>
      <pre class="json-block">${escapeHtml(formatJson(task.payload))}</pre>
    </div>
    <div class="section">
      <h3>Result</h3>
      <pre class="json-block">${escapeHtml(formatJson(task.result))}</pre>
    </div>
    <div class="section">
      <h3>Error</h3>
      <pre class="json-block">${escapeHtml(formatJson(task.error))}</pre>
    </div>
    <div class="section">
      <h3>Events</h3>
      ${events.length ? renderEvents(events) : '<p class="hint">No events recorded.</p>'}
    </div>
  `;
}

function renderEvents(events) {
  const items = events.map((event) => {
    return `
      <li>
        <header>
          <span>${escapeHtml(event.kind)}</span>
          <time>${formatTimestamp(event.ts_utc || event.ts)}</time>
        </header>
        <div>Actor: <span class="mono">${escapeHtml(event.actor)}</span></div>
        ${event.data ? `<pre class="json-block">${escapeHtml(formatJson(event.data))}</pre>` : ''}
      </li>
    `;
  });
  return `<ul class="events-list">${items.join('')}</ul>`;
}

function renderActivity() {
  const list = elements.activityList;
  if (!list) return;

  if (!state.events.length) {
    list.innerHTML = '<li class="empty">No activity yet.</li>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.events.forEach((entry) => {
    const template = elements.activityTemplate?.content?.firstElementChild;
    const node = template ? template.cloneNode(true) : document.createElement('li');
    node.className = `activity-item activity-${entry.type.toLowerCase()}`;

    const typeEl = node.querySelector('.activity-type');
    const timeEl = node.querySelector('time');
    const summaryEl = node.querySelector('.activity-summary');
    const detailEl = node.querySelector('.activity-detail');

    if (typeEl) typeEl.textContent = entry.typeLabel;
    if (timeEl) timeEl.textContent = formatTimestamp(entry.ts);
    if (summaryEl) summaryEl.textContent = entry.summary;
    if (detailEl) {
      detailEl.textContent = entry.detail || '';
      if (!entry.detail) {
        detailEl.classList.add('hidden');
      } else {
        detailEl.classList.remove('hidden');
      }
    }

    fragment.appendChild(node);
  });

  list.innerHTML = '';
  list.appendChild(fragment);
}

function renderConfigReports(fallbackMessage) {
  const container = elements.configResults;
  if (!container) return;

  if (fallbackMessage) {
    container.textContent = fallbackMessage;
    return;
  }

  if (!state.configReports.length) {
    container.textContent = 'No config reports yet.';
    return;
  }

  container.innerHTML = state.configReports
    .map((report) => {
      const statusClass = report.status === 'ok' ? 'success' : 'error';
      const requiredList = Object.entries(report.required || {})
        .map(([key, value]) => `<li>${escapeHtml(key)}: ${escapeHtml(String(value))}</li>`)
        .join('');
      const optionalList = Object.entries(report.optional || {})
        .map(([key, value]) => `<li>${escapeHtml(key)}: ${escapeHtml(String(value))}</li>`)
        .join('');
      const errors = (report.errors || [])
        .map((err) => `<li>${escapeHtml(err.message || JSON.stringify(err))}</li>`)
        .join('');

      return `
        <div class="config-entry ${statusClass}">
          <header>
            <span>${escapeHtml(report.name)}</span>
            <span>${escapeHtml(report.status)}</span>
          </header>
          ${requiredList ? `<div><strong>Required</strong><ul>${requiredList}</ul></div>` : ''}
          ${optionalList ? `<div><strong>Optional</strong><ul>${optionalList}</ul></div>` : ''}
          ${errors ? `<div><strong>Errors</strong><ul>${errors}</ul></div>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderConnectivity(message) {
  const container = elements.connectivityResults;
  if (!container) return;

  if (message) {
    container.textContent = message;
    return;
  }

  if (state.connectivity.running) {
    container.textContent = 'Checking connectivity...';
    return;
  }

  if (state.connectivity.error) {
    container.textContent = `Connectivity check failed: ${state.connectivity.error}`;
    return;
  }

  const results = [...state.connectivity.results];
  if (state.connectivity.dbSummary) {
    results.push(state.connectivity.dbSummary);
  }

  if (!results.length) {
    container.textContent = 'Run connectivity check to verify service reachability.';
    return;
  }

  const markup = results
    .map((service) => {
      if (service.overall === 'missing') {
        const note = service.note ||
          (service.category === 'integration'
            ? 'Provide credentials to test this integration.'
            : service.category === 'database'
              ? 'Run a database snapshot to verify connectivity.'
              : 'Provide a base URL to test this service.');
        return `
          <div class="connectivity-entry missing">
            <header>
              <span>${escapeHtml(service.name)}</span>
              <span>${escapeHtml(formatOverallStatus('missing'))}</span>
            </header>
            <p class="connectivity-note">${escapeHtml(note)}</p>
          </div>
        `;
      }

      const checks = (service.checks || [])
        .map((check) => {
          const detail = check.detail ? ` (${escapeHtml(check.detail)})` : '';
          return `<li><strong>${escapeHtml(check.label)}</strong>: ${escapeHtml(formatCheckStatus(check.status))}${detail}</li>`;
        })
        .join('');

      return `
        <div class="connectivity-entry ${service.overall}">
          <header>
            <span>${escapeHtml(service.name)}</span>
            <span>${escapeHtml(formatOverallStatus(service.overall))}</span>
          </header>
          <ul>${checks}</ul>
        </div>
      `;
    })
    .join('');

  const lastRun = state.connectivity.lastRun
    ? `<p class="connectivity-meta">Last run ${escapeHtml(formatTimestamp(state.connectivity.lastRun))}</p>`
    : '';

  container.innerHTML = `${markup}${lastRun}`;
}

function formatOverallStatus(status) {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'Check';
    case 'error':
      return 'Error';
    case 'missing':
      return 'Not configured';
    default:
      return status || 'Unknown';
  }
}

function formatCheckStatus(status) {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'Check';
    case 'error':
      return 'Error';
    default:
      return status || 'Unknown';
  }
}

function summarizeHealth(result) {
  if (!result) {
    return { status: 'warn', detail: 'No response' };
  }

  if (result.json && result.data && typeof result.data === 'object') {
    const status = result.data.status || 'unknown';
    if (status === 'ok') {
      return { status: 'ok', detail: 'status=ok' };
    }
    return { status: 'warn', detail: `status=${status}` };
  }

  if (!result.json && typeof result.data === 'string' && result.data.trim().length) {
    return { status: 'warn', detail: 'Non-JSON response' };
  }

  return { status: 'ok', detail: 'Request succeeded' };
}

function summarizeConfig(result) {
  if (!result || !result.json || !result.data || typeof result.data !== 'object') {
    return { status: 'warn', detail: 'Non-JSON response' };
  }

  const data = result.data;
  const missingRequired = Object.entries(data.required || {}).filter(([, value]) => value !== 'present');
  const validationErrors = Array.isArray(data.errors) ? data.errors.length : 0;

  const details = [];
  if (missingRequired.length) {
    details.push(`missing: ${missingRequired.map(([key]) => key).join(', ')}`);
  }
  if (validationErrors) {
    details.push(`${validationErrors} validation error(s)`);
  }

  if (data.status && data.status !== 'ok' && !details.length) {
    details.push(`status=${data.status}`);
  }

  if (data.status !== 'ok' || missingRequired.length || validationErrors) {
    const level = data.status === 'error' || missingRequired.length || validationErrors ? 'error' : 'warn';
    return {
      status: level,
      detail: details.join('; ') || `status=${data.status}`
    };
  }

  return {
    status: 'ok',
    detail: 'All required env vars present'
  };
}

function buildIntegrationTargets(config) {
  return [
    {
      key: 'twilio',
      name: 'Twilio API',
      isConfigured: Boolean(config.twilioAccountSid && config.twilioAuthToken),
      missingNote: 'Provide Twilio Account SID and Auth Token to test this integration.',
      skipLog: 'Twilio credentials missing; skipping check.',
      run: () => checkTwilioIntegration(config)
    },
    {
      key: 'hubspot',
      name: 'HubSpot API',
      isConfigured: Boolean(config.hubspotApiKey),
      missingNote: 'Provide a HubSpot private app token to test this integration.',
      skipLog: 'HubSpot token missing; skipping check.',
      run: () => checkHubspotIntegration(config)
    },
    {
      key: 'openai',
      name: 'OpenAI API',
      isConfigured: Boolean(config.openaiApiKey),
      missingNote: 'Provide an OpenAI API key to test this integration.',
      skipLog: 'OpenAI API key missing; skipping check.',
      run: () => checkOpenAiIntegration(config)
    },
    {
      key: 'google',
      name: 'Google APIs',
      isConfigured: Boolean(config.googleApiKey),
      missingNote: 'Provide a Google API key to test this integration.',
      skipLog: 'Google API key missing; skipping check.',
      run: () => checkGoogleIntegration(config)
    }
  ];
}

async function checkTwilioIntegration(config) {
  const accountSid = (config.twilioAccountSid || '').trim();
  const authToken = (config.twilioAuthToken || '').trim();
  if (!accountSid || !authToken) {
    throw new Error('Missing Twilio credentials');
  }

  const baseUrl = resolveBaseUrl(config.twilioBaseUrl, defaultSettings.twilioBaseUrl);
  const targetUrl = new URL(`/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, baseUrl).toString();
  const credentials = encodeBasicToken(accountSid, authToken);

  const response = await fetch(targetUrl, {
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json'
    }
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const snippet = bodyText ? bodyText.slice(0, 120) : '';
    throw new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }

  let data = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      throw new Error('Invalid JSON response from Twilio');
    }
  }

  const accountStatus = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  const friendly = data.friendly_name || data.friendlyName || accountSid;
  const status = accountStatus && accountStatus !== 'active' ? 'warn' : 'ok';
  const detail = accountStatus && accountStatus !== 'active'
    ? `Account ${friendly} (status ${accountStatus})`
    : `Account ${friendly}`;

  return {
    overall: status,
    checks: [
      {
        key: 'credentials',
        label: 'Credentials',
        status,
        detail
      }
    ]
  };
}

async function checkHubspotIntegration(config) {
  const token = (config.hubspotApiKey || '').trim();
  if (!token) {
    throw new Error('Missing HubSpot token');
  }

  const baseUrl = resolveBaseUrl(config.hubspotBaseUrl, defaultSettings.hubspotBaseUrl);
  const requestUrl = new URL('/crm/v3/owners/', baseUrl);
  requestUrl.searchParams.set('limit', '1');

  const response = await fetch(requestUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });

  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 120) : '';
    throw new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }

  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON response from HubSpot');
    }
  }

  const count = Array.isArray(data.results) ? data.results.length : 0;
  const status = count > 0 ? 'ok' : 'warn';
  const detail = count > 0 ? 'Owner data retrieved' : 'No owners returned';

  return {
    overall: status,
    checks: [
      {
        key: 'owners',
        label: 'Owners',
        status,
        detail
      }
    ]
  };
}

async function checkOpenAiIntegration(config) {
  const apiKey = (config.openaiApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing OpenAI API key');
  }

  const baseUrl = resolveBaseUrl(config.openaiBaseUrl, defaultSettings.openaiBaseUrl);
  const requestUrl = new URL('/v1/models', baseUrl).toString();

  const response = await fetch(requestUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 120) : '';
    throw new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }

  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON response from OpenAI');
    }
  }

  const models = Array.isArray(data.data) ? data.data.length : 0;
  const status = models > 0 ? 'ok' : 'warn';
  const detail = models > 0 ? `${models} model(s) available` : 'No models returned';

  return {
    overall: status,
    checks: [
      {
        key: 'models',
        label: 'Models',
        status,
        detail
      }
    ]
  };
}

async function checkGoogleIntegration(config) {
  const apiKey = (config.googleApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing Google API key');
  }

  const baseUrl = resolveBaseUrl(config.googleBaseUrl, defaultSettings.googleBaseUrl);
  const requestUrl = new URL('/discovery/v1/apis', baseUrl);
  requestUrl.searchParams.set('key', apiKey);

  const response = await fetch(requestUrl.toString(), {
    headers: {
      Accept: 'application/json'
    }
  });

  const text = await response.text();
  if (!response.ok) {
    const snippet = text ? text.slice(0, 120) : '';
    throw new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ''}`.trim());
  }

  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON response from Google APIs');
    }
  }

  const apis = Array.isArray(data.items) ? data.items.length : 0;
  const status = apis > 0 ? 'ok' : 'warn';
  const detail = apis > 0 ? `${apis} API(s) listed` : 'No APIs returned';

  return {
    overall: status,
    checks: [
      {
        key: 'discovery',
        label: 'Discovery',
        status,
        detail
      }
    ]
  };
}

function resolveBaseUrl(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return fallback;
  try {
    const normalized = new URL(candidate);
    const output = normalized.toString();
    return output.endsWith('/') ? output.slice(0, -1) : output;
  } catch (err) {
    return fallback;
  }
}

async function fetchJsonish(baseUrl, path) {
  const url = new URL(path, baseUrl).toString();
  const headers = buildAuthHeaders();
  headers.Accept = 'application/json';
  const response = await fetch(url, { headers });
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const snippet = text ? ` ${text.slice(0, 200)}` : '';
    throw new Error(`HTTP ${response.status}${snippet}`.trim());
  }

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return { json: true, data };
    } catch (err) {
      throw new Error('Invalid JSON response');
    }
  }

  const text = await response.text().catch(() => '');
  if (!text) {
    return { json: false, data: '' };
  }
  try {
    const data = JSON.parse(text);
    return { json: true, data };
  } catch (err) {
    return { json: false, data: text };
  }
}

function toggleSettingsCard() {
  if (!elements.settingsCard || !elements.toggleSettings) return;
  elements.settingsCard.classList.toggle('collapsed');
  elements.toggleSettings.textContent = elements.settingsCard.classList.contains('collapsed')
    ? 'Expand'
    : 'Collapse';
}

function setConnectionStatus(stateValue, label) {
  const el = elements.connectionStatus;
  if (!el) return;
  el.dataset.state = stateValue;
  el.textContent = label;
}

function recordActivity(entry) {
  if (!entry) return;
  state.events.unshift(entry);
  if (state.events.length > MAX_ACTIVITY_ENTRIES) {
    state.events.length = MAX_ACTIVITY_ENTRIES;
  }
  renderActivity();
}

function appendLog(level, scope, message, detail) {
  const entry = {
    level,
    scope,
    message,
    detail: detail || '',
    ts: new Date().toISOString()
  };
  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOG_ENTRIES) {
    state.logs.length = MAX_LOG_ENTRIES;
  }
  renderLogs();
}

function clearLogs() {
  state.logs = [];
  renderLogs('Logs cleared.');
}

function copyLogs() {
  if (!state.logs.length) {
    appendLog('info', 'Diagnostics', 'No logs to copy.');
    return;
  }

  const text = state.logs
    .slice()
    .reverse()
    .map(formatLogLine)
    .join('\n\n');

  const write = async () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };

  write()
    .then(() => {
      appendLog('info', 'Diagnostics', 'Diagnostics log copied to clipboard.');
    })
    .catch((err) => {
      appendLog('error', 'Diagnostics', 'Failed to copy diagnostics log', err?.message || String(err));
    });
}

function renderLogs(message) {
  const container = elements.logOutput;
  if (!container) return;

  if (message) {
    container.textContent = message;
    return;
  }

  if (!state.logs.length) {
    container.textContent = 'No logs yet.';
    return;
  }

  const html = state.logs
    .map((entry) => {
      const detail = entry.detail ? `\n  ${escapeHtml(entry.detail)}` : '';
      return `
        <div class="log-entry log-${escapeHtml(entry.level)}">
          <span class="log-time">${escapeHtml(formatTimestamp(entry.ts))}</span>
          <strong>[${escapeHtml(entry.level.toUpperCase())}] ${escapeHtml(entry.scope)}</strong>
          <div>${escapeHtml(entry.message)}${detail}</div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function formatLogLine(entry) {
  const ts = formatTimestamp(entry.ts);
  const detail = entry.detail ? `\n  ${entry.detail}` : '';
  return `${ts} [${entry.level.toUpperCase()}] ${entry.scope} - ${entry.message}${detail}`;
}

function renderDatabaseSnapshot(message) {
  const container = elements.dbSnapshot;
  if (!container) return;

  if (message) {
    container.textContent = message;
    return;
  }

  const snapshot = state.dbSnapshot;
  if (snapshot.loading) {
    container.textContent = 'Loading latest records...';
    return;
  }

  if (snapshot.error) {
    container.textContent = snapshot.error;
    return;
  }

  const hasData = snapshot.tasks.length || snapshot.logs.length || snapshot.events.length;
  if (!hasData) {
    container.textContent = 'No records returned yet. Queue a task or emit logs to populate the database.';
    return;
  }

  const sections = [];
  sections.push(renderDbSection('Tasks', snapshot.tasks, renderTaskRecord));
  sections.push(renderDbSection('Logs', snapshot.logs, renderLogRecord));
  sections.push(renderDbSection('Task Events', snapshot.events, renderEventRecord));

  const meta = snapshot.lastUpdated
    ? `<p class="db-meta">Last checked ${escapeHtml(formatTimestamp(snapshot.lastUpdated))}</p>`
    : '';

  container.innerHTML = `${sections.join('')}${meta}`;
}

function renderDbSection(title, records, renderItem) {
  if (!records || !records.length) {
    return `
      <div class="db-section">
        <header><h3>${escapeHtml(title)}</h3><span>0 records</span></header>
        <p class="db-empty">No records found.</p>
      </div>
    `;
  }

  const items = records.map((record) => `<li>${renderItem(record)}</li>`).join('');
  return `
    <div class="db-section">
      <header><h3>${escapeHtml(title)}</h3><span>${records.length} shown</span></header>
      <ol class="db-list">${items}</ol>
    </div>
  `;
}

function renderTaskRecord(task) {
  const id = task?.id ? shortId(task.id) : 'n/a';
  const status = task?.status || 'unknown';
  const updated = task?.updated_at || task?.created_at || null;
  const ts = updated ? formatTimestamp(updated) : 'unknown time';
  return `${escapeHtml(id)} • ${escapeHtml(status)} • ${escapeHtml(ts)}`;
}

function renderLogRecord(log) {
  const service = log?.service || 'unknown';
  const level = (log?.level || 'info').toUpperCase();
  const message = log?.message || '(no message)';
  const ts = formatTimestamp(log?.ts_utc || log?.ts || log?.created_at);
  return `${escapeHtml(service)} • ${escapeHtml(level)} • ${escapeHtml(ts)} • ${escapeHtml(message)}`;
}

function renderEventRecord(event) {
  const taskId = event?.task_id ? shortId(event.task_id) : 'n/a';
  const kind = event?.kind || 'event';
  const ts = formatTimestamp(event?.ts_utc || event?.ts || event?.created_at);
  return `${escapeHtml(taskId)} • ${escapeHtml(kind)} • ${escapeHtml(ts)}`;
}

function buildActivityEntry(type, ts, summary, data) {
  return {
    type,
    typeLabel: formatActivityType(type),
    ts: ts || new Date().toISOString(),
    summary: summary || type,
    detail: data ? formatJson(data) : '',
    raw: data
  };
}

function formatActivityType(type) {
  switch (type) {
    case 'LOG':
      return 'Log';
    case 'TASK_UPDATE':
      return 'Task';
    case 'TASK_EVENT':
      return 'Task Event';
    case 'ERROR':
      return 'Error';
    default:
      return type.replace(/_/g, ' ');
  }
}

function clampLimit(value) {
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(200, Math.max(1, Math.floor(value)));
}

function highlightSelectedRow(taskId) {
  const rows = elements.taskTableBody?.querySelectorAll('tr[data-task-id]');
  if (!rows) return;
  rows.forEach((row) => {
    if (row.dataset.taskId === taskId) {
      row.classList.add('active');
    } else {
      row.classList.remove('active');
    }
  });
}

function setTaskFeedback(message, variant) {
  if (!elements.newTaskFeedback) return;
  elements.newTaskFeedback.textContent = message;
  elements.newTaskFeedback.className = `form-feedback ${variant}`;
}

function formatJson(value) {
  if (value === undefined || value === null) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

function inferNetworkError(err) {
  if (!err) return 'Unknown error';
  const message = err.message || String(err);
  if (err.name === 'TypeError' && message.toLowerCase().includes('fetch')) {
    return `${message} (possible CORS or network issue)`;
  }
  return message;
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (err) {
    return value;
  }
}

function shortId(id) {
  if (!id) return '';
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function buildAuthHeaders() {
  const header = encodeBasicAuth(settings.username, settings.password);
  const headers = { 'Content-Type': 'application/json' };
  if (header) headers.Authorization = header;
  return headers;
}

function encodeBasicToken(username, password) {
  if (!username || !password) return null;
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(`${username}:${password}`);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(`${username}:${password}`, 'utf-8').toString('base64');
  }
  return null;
}

function buildWebsocketUrl() {
  const rawUrl = settings.websocketUrl || deriveWsUrl(settings.orchestratorUrl);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    const authToken = encodeBasicToken(settings.username, settings.password);
    if (authToken) {
      url.searchParams.set('auth', authToken);
    }
    return url.toString();
  } catch (err) {
    console.error('Failed to construct websocket URL', err);
    return null;
  }
}

function deriveWsUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (err) {
    console.warn('Failed to derive websocket url', err);
    return null;
  }
}

function valueOrDefault(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function buildDefaultSettings() {
  const runtimeDefaults = getRuntimeDefaults();
  const merged = { ...BASE_DEFAULT_SETTINGS };
  SETTINGS_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(runtimeDefaults, key) && runtimeDefaults[key] !== undefined) {
      merged[key] = runtimeDefaults[key];
    }
  });
  return merged;
}

function getRuntimeDefaults() {
  if (typeof window === 'undefined') return {};
  const payload = window.__APP_DEFAULTS__;
  if (!payload || typeof payload !== 'object') return {};
  const sanitized = {};
  SETTINGS_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  });
  return sanitized;
}
