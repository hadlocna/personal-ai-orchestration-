const state = {
  connection: {
    orchestratorUrl: '',
    loggingUrl: '',
    echoUrl: '',
    renderctlUrl: ''
  },
  auth: {
    username: '',
    password: ''
  },
  authHeader: null,
  tasks: new Map(),
  taskDetails: new Map(),
  taskEvents: new Map(),
  selectedTaskId: null,
  activity: [],
  logs: [],
  configReports: [],
  tasksFilter: 'all',
  ws: null,
  isConnected: false
};

const elements = {};

const STORAGE_KEY = 'pao-dashboard-settings';
const MAX_ACTIVITY = 80;
const MAX_LOGS = 80;
const MAX_EVENTS = 80;

document.addEventListener('DOMContentLoaded', init);

function init() {
  cacheElements();
  bindEvents();
  loadSettings();
  setDefaultPayload();
  renderTasks();
  renderTaskDetail();
  renderActivity();
  renderLogs();
  renderConfig();
}

function cacheElements() {
  elements.statusBanner = document.getElementById('status-banner');
  elements.connectionForm = document.getElementById('connection-form');
  elements.connectButton = document.getElementById('connect-button');
  elements.disconnectButton = document.getElementById('disconnect-button');
  elements.clearSettingsButton = document.getElementById('clear-settings');
  elements.orchestratorInput = document.getElementById('orchestrator-url');
  elements.loggingInput = document.getElementById('logging-url');
  elements.echoInput = document.getElementById('echo-url');
  elements.renderctlInput = document.getElementById('renderctl-url');
  elements.usernameInput = document.getElementById('auth-username');
  elements.passwordInput = document.getElementById('auth-password');
  elements.taskForm = document.getElementById('task-form');
  elements.taskTypeInput = document.getElementById('task-type');
  elements.taskSourceInput = document.getElementById('task-source');
  elements.taskCorrelationInput = document.getElementById('task-correlation');
  elements.taskPayloadInput = document.getElementById('task-payload');
  elements.taskFeedback = document.getElementById('task-feedback');
  elements.resetPayloadButton = document.getElementById('reset-payload');
  elements.taskFilter = document.getElementById('task-filter');
  elements.refreshTasksButton = document.getElementById('refresh-tasks');
  elements.tasksTableBody = document.getElementById('tasks-tbody');
  elements.refreshDetailButton = document.getElementById('refresh-detail');
  elements.taskDetail = document.getElementById('task-detail');
  elements.activityList = document.getElementById('activity-list');
  elements.logsList = document.getElementById('logs-list');
  elements.refreshConfigButton = document.getElementById('refresh-config');
  elements.configResults = document.getElementById('config-results');
}

function bindEvents() {
  elements.connectionForm?.addEventListener('submit', handleConnect);
  elements.disconnectButton?.addEventListener('click', handleDisconnect);
  elements.clearSettingsButton?.addEventListener('click', handleClearSettings);
  elements.taskForm?.addEventListener('submit', handleCreateTask);
  elements.resetPayloadButton?.addEventListener('click', (event) => {
    event.preventDefault();
    setDefaultPayload();
  });
  elements.taskFilter?.addEventListener('change', (event) => {
    state.tasksFilter = event.target.value;
    renderTasks();
  });
  elements.refreshTasksButton?.addEventListener('click', () => {
    refreshTasks();
  });
  elements.tasksTableBody?.addEventListener('click', handleTaskTableClick);
  elements.refreshDetailButton?.addEventListener('click', () => {
    if (state.selectedTaskId) {
      fetchTaskDetail(state.selectedTaskId, { showStatus: true });
    }
  });
  elements.taskDetail?.addEventListener('click', handleTaskDetailClick);
  elements.refreshConfigButton?.addEventListener('click', () => {
    refreshConfig();
  });
  window.addEventListener('beforeunload', () => {
    closeWebsocket();
  });
}

function loadSettings() {
  let stored = null;
  try {
    stored = window.localStorage?.getItem(STORAGE_KEY) || null;
  } catch (err) {
    console.warn('Failed to read stored settings', err);
  }
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.connection) {
        Object.assign(state.connection, parsed.connection);
      }
      if (parsed.username) {
        state.auth.username = parsed.username;
      }
    } catch (err) {
      console.warn('Stored settings were not valid JSON', err);
    }
  }
  applySettingsToForm();
}

function applySettingsToForm() {
  if (elements.orchestratorInput) {
    elements.orchestratorInput.value = state.connection.orchestratorUrl || 'http://localhost:4000';
  }
  if (elements.loggingInput) {
    elements.loggingInput.value = state.connection.loggingUrl || '';
  }
  if (elements.echoInput) {
    elements.echoInput.value = state.connection.echoUrl || '';
  }
  if (elements.renderctlInput) {
    elements.renderctlInput.value = state.connection.renderctlUrl || '';
  }
  if (elements.usernameInput) {
    elements.usernameInput.value = state.auth.username || '';
  }
  if (elements.passwordInput) {
    elements.passwordInput.value = '';
  }
}

function saveSettings() {
  try {
    window.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        connection: state.connection,
        username: state.auth.username || ''
      })
    );
  } catch (err) {
    console.warn('Failed to persist settings', err);
  }
}

function handleClearSettings(event) {
  event.preventDefault();
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Failed to clear stored settings', err);
  }
  state.connection = {
    orchestratorUrl: '',
    loggingUrl: '',
    echoUrl: '',
    renderctlUrl: ''
  };
  state.auth.username = '';
  state.auth.password = '';
  state.authHeader = null;
  applySettingsToForm();
  setDefaultPayload();
  setStatus('Saved settings cleared. Update the connection details to reconnect.', 'pending');
  addActivity({ label: 'Cleared saved connection settings', level: 'info' });
}

function setDefaultPayload() {
  if (!elements.taskPayloadInput) return;
  const example = {
    message: 'Hello from the dashboard',
    ts: new Date().toISOString()
  };
  elements.taskPayloadInput.value = JSON.stringify(example, null, 2);
}

async function handleConnect(event) {
  event.preventDefault();
  if (!elements.connectionForm) return;
  const formData = new FormData(elements.connectionForm);
  const orchestratorUrl = (formData.get('orchestratorUrl') || '').trim();

  if (!orchestratorUrl) {
    setStatus('Orchestrator URL is required to connect.', 'error');
    return;
  }

  state.connection.orchestratorUrl = orchestratorUrl;
  state.connection.loggingUrl = (formData.get('loggingUrl') || '').trim();
  state.connection.echoUrl = (formData.get('echoUrl') || '').trim();
  state.connection.renderctlUrl = (formData.get('renderctlUrl') || '').trim();
  state.auth.username = (formData.get('username') || '').trim();
  state.auth.password = formData.get('password') || '';
  state.authHeader = state.auth.username && state.auth.password ? encodeBasicAuth(state.auth.username, state.auth.password) : null;

  saveSettings();
  disableConnectionInputs(true);
  setStatus('Connecting to orchestrator…', 'pending');
  addActivity({ label: 'Attempting connection to orchestrator', level: 'info' });

  try {
    await checkOrchestratorHealth();
    state.isConnected = true;
    setStatus(`Connected to ${state.connection.orchestratorUrl}`, 'ok');
    addActivity({ label: 'Connected to orchestrator', level: 'success' });
    await Promise.allSettled([refreshTasks(), refreshConfig(), loadRecentLogs()]);
    startWebsocket();
  } catch (err) {
    console.error('Connection failed', err);
    state.isConnected = false;
    setStatus(`Connection failed: ${err.message}`, 'error');
    addActivity({ label: 'Connection failed', level: 'error', context: err.message });
  } finally {
    disableConnectionInputs(false);
  }
}

function handleDisconnect(event) {
  event?.preventDefault();
  if (!state.isConnected && !state.ws) {
    return;
  }
  disconnect();
  setStatus('Disconnected.', 'pending');
  addActivity({ label: 'Disconnected from orchestrator', level: 'warn' });
}

async function handleCreateTask(event) {
  event.preventDefault();
  if (!state.connection.orchestratorUrl) {
    setTaskFeedback('Connect to the orchestrator first.', 'error');
    return;
  }
  if (!elements.taskForm) return;

  const formData = new FormData(elements.taskForm);
  const type = (formData.get('type') || '').trim();
  const source = (formData.get('source') || '').trim();
  const correlationId = (formData.get('correlationId') || '').trim();
  const payloadText = formData.get('payload') || '';

  if (!type) {
    setTaskFeedback('Task type is required.', 'error');
    return;
  }
  if (!source) {
    setTaskFeedback('Source is required.', 'error');
    return;
  }

  let payload = {};
  if (payloadText.trim()) {
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      setTaskFeedback(`Payload must be valid JSON: ${err.message}`, 'error');
      return;
    }
  }

  try {
    const result = await apiRequest(state.connection.orchestratorUrl, '/task', {
      method: 'POST',
      body: {
        type,
        source,
        payload,
        correlationId: correlationId || undefined
      }
    });
    const taskId = result?.id;
    setTaskFeedback(`Task ${taskId ? shortId(taskId) : ''} enqueued.`, 'success');
    addActivity({ label: `Created task ${taskId ? shortId(taskId) : ''}`, level: 'success', context: { type, source } });
    await refreshTasks({ silent: true });
  } catch (err) {
    console.error('Failed to create task', err);
    setTaskFeedback(`Failed to create task: ${err.message}`, 'error');
    addActivity({ label: 'Task creation failed', level: 'error', context: err.message });
  }
}


function handleTaskTableClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const taskId = target.getAttribute('data-task-id');
  if (!taskId) return;
  if (target.dataset.action === 'view-task') {
    selectTask(taskId);
  }
}

function handleTaskDetailClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const taskId = target.getAttribute('data-task-id');
  if (!taskId) return;
  if (target.dataset.action === 'refresh-detail') {
    fetchTaskDetail(taskId, { showStatus: true });
  }
}

function selectTask(taskId) {
  state.selectedTaskId = taskId;
  renderTasks();
  if (elements.taskDetail) {
    elements.taskDetail.innerHTML = '<p class="hint">Loading task detail…</p>';
  }
  fetchTaskDetail(taskId);
}

function disconnect() {
  state.isConnected = false;
  closeWebsocket();
  state.tasks.clear();
  state.taskDetails.clear();
  state.taskEvents.clear();
  state.selectedTaskId = null;
  renderTasks();
  renderTaskDetail();
}

function disableConnectionInputs(disabled) {
  const controls = [
    elements.connectButton,
    elements.disconnectButton,
    elements.clearSettingsButton,
    elements.orchestratorInput,
    elements.loggingInput,
    elements.echoInput,
    elements.renderctlInput,
    elements.usernameInput,
    elements.passwordInput
  ];
  controls.forEach((el) => {
    if (el) {
      el.disabled = disabled;
    }
  });
}

function encodeBasicAuth(username, password) {
  if (typeof btoa === 'function') {
    return `Basic ${btoa(`${username}:${password}`)}`;
  }
  return null;
}

async function checkOrchestratorHealth() {
  const response = await apiRequest(state.connection.orchestratorUrl, '/health');
  if (!response || response.status !== 'ok') {
    throw new Error('Health check failed');
  }
}

async function refreshTasks(options = {}) {
  if (!state.connection.orchestratorUrl) return;
  try {
    const result = await apiRequest(state.connection.orchestratorUrl, '/tasks?limit=50');
    const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
    state.tasks.clear();
    tasks.forEach((task) => {
      if (task?.id) {
        state.tasks.set(task.id, task);
      }
    });
    renderTasks();
    if (state.selectedTaskId) {
      renderTaskDetail(state.selectedTaskId);
    }
  } catch (err) {
    if (!options.silent) {
      setStatus(`Failed to fetch tasks: ${err.message}`, 'error');
      addActivity({ label: 'Failed to fetch tasks', level: 'error', context: err.message });
    }
  }
}

async function fetchTaskDetail(taskId, options = {}) {
  if (!taskId || !state.connection.orchestratorUrl) return;
  try {
    const detail = await apiRequest(state.connection.orchestratorUrl, `/task/${encodeURIComponent(taskId)}`);
    if (detail?.task) {
      state.tasks.set(detail.task.id, detail.task);
      state.taskDetails.set(taskId, detail);
      mergeTaskEvents(taskId, detail.events || []);
      renderTasks();
      renderTaskDetail(taskId);
      if (options.showStatus) {
        setStatus(`Task ${shortId(taskId)} refreshed.`, 'ok');
      }
    }
  } catch (err) {
    console.error('Failed to fetch task detail', err);
    setStatus(`Failed to fetch task detail: ${err.message}`, 'error');
    addActivity({ label: 'Failed to fetch task detail', level: 'error', context: err.message });
  }
}

function mergeTaskEvents(taskId, events) {
  if (!Array.isArray(events)) return;
  const existing = state.taskEvents.get(taskId) || [];
  const map = new Map(existing.map((evt) => [evt.id, evt]));
  events.map((evt) => normalizeTaskEvent(evt)).forEach((evt) => {
    if (evt) {
      map.set(evt.id, evt);
    }
  });
  const merged = Array.from(map.values()).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const trimmed = merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
  state.taskEvents.set(taskId, trimmed);
}

function startWebsocket() {
  if (!state.connection.orchestratorUrl) return;
  closeWebsocket();
  let wsUrl;
  try {
    wsUrl = buildWsUrl(state.connection.orchestratorUrl);
  } catch (err) {
    console.error('Failed to construct websocket URL', err);
    addActivity({ label: 'WebSocket URL invalid', level: 'error', context: err.message });
    return;
  }
  const socket = new WebSocket(wsUrl);
  socket.onopen = () => {
    addActivity({ label: 'WebSocket connected', level: 'success' });
  };
  socket.onmessage = (event) => {
    handleWebsocketMessage(event.data);
  };
  socket.onerror = (event) => {
    console.error('WebSocket error', event);
    addActivity({ label: 'WebSocket error', level: 'error' });
  };
  socket.onclose = () => {
    addActivity({ label: 'WebSocket disconnected', level: 'warn' });
    state.ws = null;
  };
  state.ws = socket;
}

function closeWebsocket() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch (err) {
      console.warn('Error closing websocket', err);
    }
  }
  state.ws = null;
}

function buildWsUrl(baseUrl) {
  const url = new URL(resolveUrl(baseUrl, 'ws'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function handleWebsocketMessage(payload) {
  let frame;
  try {
    frame = JSON.parse(payload);
  } catch (err) {
    console.error('Failed to parse websocket payload', err);
    return;
  }
  if (!frame || !frame.type) return;
  const timestamp = frame.ts || new Date().toISOString();

  if (frame.type === 'TASK_UPDATE' && frame.data?.task) {
    const task = frame.data.task;
    state.tasks.set(task.id, task);
    renderTasks();
    if (state.selectedTaskId === task.id) {
      renderTaskDetail(task.id);
    }
    addActivity({
      ts: timestamp,
      label: `Task ${shortId(task.id)} → ${task.status}`,
      level: task.status === 'error' ? 'error' : task.status === 'done' ? 'success' : 'info',
      context: { id: task.id, status: task.status }
    });
    return;
  }

  if (frame.type === 'TASK_EVENT' && frame.data) {
    storeTaskEvent(frame.data, timestamp);
    return;
  }

  if (frame.type === 'LOG' && frame.data) {
    storeLogEntry(frame.data, timestamp);
    return;
  }

  addActivity({ ts: timestamp, label: `Received ${frame.type} frame`, level: 'info' });
}

function storeTaskEvent(rawEvent, fallbackTs) {
  const event = normalizeTaskEvent(rawEvent, fallbackTs);
  if (!event) return;
  const events = state.taskEvents.get(event.taskId) || [];
  if (!events.find((existing) => existing.id === event.id)) {
    events.push(event);
    events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    state.taskEvents.set(event.taskId, events);
  }
  addActivity({
    ts: event.ts,
    label: `Event · ${event.kind} (${shortId(event.taskId)})`,
    level: event.kind === 'error' ? 'error' : 'info',
    context: event.data || null
  });
  if (state.selectedTaskId === event.taskId) {
    renderTaskDetail(event.taskId);
  }
}

function normalizeTaskEvent(rawEvent, fallbackTs) {
  if (!rawEvent) return null;
  const taskId = rawEvent.taskId || rawEvent.task_id;
  if (!taskId) return null;
  const ts = rawEvent.ts || rawEvent.ts_utc || fallbackTs || new Date().toISOString();
  const id = rawEvent.id || `${taskId}-${rawEvent.kind || 'event'}-${ts}`;
  return {
    id,
    taskId,
    ts,
    actor: rawEvent.actor || 'unknown',
    kind: rawEvent.kind || 'event',
    data: rawEvent.data ?? null
  };
}

function storeLogEntry(rawLog, fallbackTs) {
  const log = normalizeLog(rawLog, fallbackTs);
  if (!log) return;
  if (!state.logs.find((existing) => existing.id === log.id)) {
    state.logs.unshift(log);
    if (state.logs.length > MAX_LOGS) {
      state.logs.length = MAX_LOGS;
    }
    renderLogs();
  }
  addActivity({
    ts: log.ts,
    label: `Log · ${log.service || 'unknown'} (${log.level})`,
    level: log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'info',
    context: log.message
  });
}

function normalizeLog(rawLog, fallbackTs) {
  if (!rawLog) return null;
  const ts = rawLog.ts_utc || rawLog.ts || fallbackTs || new Date().toISOString();
  const id = rawLog.id || `${rawLog.service || 'log'}-${ts}-${rawLog.message || ''}`;
  return {
    id,
    ts,
    service: rawLog.service || 'log',
    level: (rawLog.level || 'info').toLowerCase(),
    message: rawLog.message || '',
    traceId: rawLog.trace_id || rawLog.traceId || null,
    correlationId: rawLog.correlation_id || rawLog.correlationId || null,
    taskId: rawLog.task_id || rawLog.taskId || null,
    data: rawLog.data ?? null
  };
}

async function loadRecentLogs() {
  if (!state.connection.loggingUrl) return;
  try {
    const response = await apiRequest(state.connection.loggingUrl, '/logs?limit=50');
    const logs = Array.isArray(response?.logs) ? response.logs.map((item) => normalizeLog(item)).filter(Boolean) : [];
    logs.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    state.logs = logs.slice(0, MAX_LOGS);
    renderLogs();
  } catch (err) {
    console.warn('Failed to load log history', err);
    addActivity({ label: 'Failed to load log history', level: 'warn', context: err.message });
  }
}


async function refreshConfig() {
  const services = gatherServiceEndpoints();
  if (!services.length) {
    state.configReports = [];
    renderConfig();
    return;
  }

  const results = await Promise.all(
    services.map(async (service) => {
      try {
        const report = await apiRequest(service.baseUrl, '/config/validate');
        return { serviceName: report?.service || service.name, baseUrl: service.baseUrl, report };
      } catch (err) {
        return { serviceName: service.name, baseUrl: service.baseUrl, error: err };
      }
    })
  );

  state.configReports = results;
  renderConfig();
}

function gatherServiceEndpoints() {
  const endpoints = [];
  if (state.connection.orchestratorUrl) {
    endpoints.push({ name: 'orchestrator-svc', baseUrl: state.connection.orchestratorUrl });
  }
  if (state.connection.loggingUrl) {
    endpoints.push({ name: 'logging-svc', baseUrl: state.connection.loggingUrl });
  }
  if (state.connection.echoUrl) {
    endpoints.push({ name: 'echo-agent-svc', baseUrl: state.connection.echoUrl });
  }
  if (state.connection.renderctlUrl) {
    endpoints.push({ name: 'renderctl-svc', baseUrl: state.connection.renderctlUrl });
  }
  return endpoints;
}

function renderTasks() {
  if (!elements.tasksTableBody) return;
  const tasks = Array.from(state.tasks.values());
  tasks.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const filtered = state.tasksFilter === 'all' ? tasks : tasks.filter((task) => task.status === state.tasksFilter);

  if (!filtered.length) {
    elements.tasksTableBody.innerHTML =
      '<tr class="empty"><td colspan="7">No tasks yet. Create one above to get started.</td></tr>';
    return;
  }

  const rows = filtered
    .map((task) => {
      const rowClass = state.selectedTaskId === task.id ? 'is-selected' : '';
      return `<tr data-task-id="${task.id}" class="${rowClass}">
          <td><span class="mono" title="${escapeHtml(task.id)}">${escapeHtml(shortId(task.id))}</span></td>
          <td>${renderStatusPill(task.status)}</td>
          <td>${escapeHtml(task.type || '—')}</td>
          <td>${escapeHtml(task.source || '—')}</td>
          <td>${escapeHtml(formatDateTime(task.updated_at || task.created_at))}</td>
          <td>${typeof task.version === 'number' ? task.version : '—'}</td>
          <td><button class="button ghost" data-action="view-task" data-task-id="${task.id}">Inspect</button></td>
        </tr>`;
    })
    .join('');

  elements.tasksTableBody.innerHTML = rows;
}

function renderStatusPill(status) {
  const normalized = sanitizeStatus(status);
  return `<span class="pill status-${normalized}">${escapeHtml(normalized)}</span>`;
}

function renderTaskDetail(taskId = state.selectedTaskId) {
  if (!elements.taskDetail) return;
  if (!taskId) {
    elements.taskDetail.innerHTML = '<p class="hint">Select a task from the table to inspect payloads, results, and event history.</p>';
    return;
  }
  const task = state.tasks.get(taskId) || state.taskDetails.get(taskId)?.task;
  if (!task) {
    elements.taskDetail.innerHTML = '<p class="hint">Task not found. Refresh tasks to sync the dashboard.</p>';
    return;
  }
  const events = getTaskEvents(taskId);
  const eventsMarkup = events.length
    ? `<ul class="bullet-list">${events
        .map(
          (event) => `<li>
              <strong>${escapeHtml(event.kind)}</strong> · ${escapeHtml(event.actor)} · ${escapeHtml(formatDateTime(event.ts))}
              ${event.data !== null && event.data !== undefined ? `<pre class="json-block">${escapeHtml(formatJson(event.data))}</pre>` : ''}
            </li>`
        )
        .join('')}</ul>`
    : '<p class="hint">No events recorded yet.</p>';
  const payloadBlock = `<pre class="json-block">${escapeHtml(formatJson(task.payload || {}))}</pre>`;
  const resultBlock =
    task.result !== null && task.result !== undefined
      ? `<pre class="json-block">${escapeHtml(formatJson(task.result))}</pre>`
      : '<p class="hint">No result recorded.</p>';
  const errorBlock =
    task.error !== null && task.error !== undefined
      ? `<pre class="json-block">${escapeHtml(formatJson(task.error))}</pre>`
      : '<p class="hint">No error payload.</p>';

  elements.taskDetail.innerHTML = `
    <div class="detail-meta">
      <div class="detail-row"><span class="label">ID</span><span class="mono">${escapeHtml(task.id)}</span></div>
      <div class="detail-row"><span class="label">Status</span><span>${renderStatusPill(task.status)}</span></div>
      <div class="detail-row"><span class="label">Trace ID</span><span class="mono">${escapeHtml(task.trace_id || task.traceId || '—')}</span></div>
      <div class="detail-row"><span class="label">Correlation</span><span class="mono">${escapeHtml(task.correlation_id || task.correlationId || '—')}</span></div>
      <div class="detail-row"><span class="label">Created</span><span>${escapeHtml(formatDateTime(task.created_at))}</span></div>
      <div class="detail-row"><span class="label">Updated</span><span>${escapeHtml(formatDateTime(task.updated_at))}</span></div>
    </div>
    <div class="detail-actions">
      <button class="button" data-action="refresh-detail" data-task-id="${task.id}">Refresh</button>
    </div>
    <div class="detail-section">
      <h3>Payload</h3>
      ${payloadBlock}
    </div>
    <div class="detail-section">
      <h3>Result</h3>
      ${resultBlock}
    </div>
    <div class="detail-section">
      <h3>Error</h3>
      ${errorBlock}
    </div>
    <div class="detail-section">
      <h3>Events</h3>
      ${eventsMarkup}
    </div>
  `;
}

function getTaskEvents(taskId) {
  const detailEvents = state.taskDetails.get(taskId)?.events || [];
  const normalizedDetail = detailEvents.map((evt) => normalizeTaskEvent(evt)).filter(Boolean);
  const streamEvents = state.taskEvents.get(taskId) || [];
  const map = new Map();
  normalizedDetail.forEach((evt) => map.set(evt.id, evt));
  streamEvents.forEach((evt) => map.set(evt.id, evt));
  return Array.from(map.values()).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

function renderActivity() {
  if (!elements.activityList) return;
  if (!state.activity.length) {
    elements.activityList.innerHTML = '<li class="timeline__item timeline__item--empty">No activity yet.</li>';
    return;
  }
  const items = state.activity
    .map(
      (entry) => `<li class="timeline__item">
          <div class="timeline__ts">${escapeHtml(formatTime(entry.ts))}</div>
          <div class="timeline__content">
            <div class="timeline__label">${escapeHtml(entry.label)}</div>
            ${renderActivityContext(entry.context)}
          </div>
        </li>`
    )
    .join('');
  elements.activityList.innerHTML = items;
}

function addActivity(entry) {
  const normalized = {
    ts: entry.ts || new Date().toISOString(),
    label: entry.label || 'Activity',
    level: entry.level || 'info',
    context: entry.context ?? null
  };
  state.activity.unshift(normalized);
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity.length = MAX_ACTIVITY;
  }
  renderActivity();
}

function renderActivityContext(context) {
  if (context === null || context === undefined || context === '') {
    return '';
  }
  if (typeof context === 'string') {
    return `<p class="timeline__text">${escapeHtml(context)}</p>`;
  }
  return `<details class="timeline__details"><summary>Details</summary><pre>${escapeHtml(formatJson(context))}</pre></details>`;
}

function renderLogs() {
  if (!elements.logsList) return;
  if (!state.logs.length) {
    elements.logsList.innerHTML = '<li class="timeline__item timeline__item--empty">No logs yet.</li>';
    return;
  }
  const items = state.logs
    .map(
      (log) => `<li class="timeline__item">
          <div class="timeline__ts">${escapeHtml(formatTime(log.ts))}</div>
          <div class="timeline__content">
            <div class="timeline__label">
              <span class="pill log-level-${escapeHtml(log.level)}">${escapeHtml(log.level)}</span>
              <span class="mono">${escapeHtml(log.service || 'log')}</span>
            </div>
            <p class="timeline__text">${escapeHtml(log.message || '')}</p>
            ${renderLogDetails(log)}
          </div>
        </li>`
    )
    .join('');
  elements.logsList.innerHTML = items;
}


function renderLogDetails(log) {
  const meta = [];
  if (log.traceId) meta.push(`trace ${log.traceId}`);
  if (log.correlationId) meta.push(`corr ${log.correlationId}`);
  if (log.taskId) meta.push(`task ${log.taskId}`);
  const metaHtml = meta.length ? `<p class="timeline__text">${escapeHtml(meta.join(' · '))}</p>` : '';
  const dataHtml =
    log.data !== null && log.data !== undefined
      ? `<details class="timeline__details"><summary>Payload</summary><pre>${escapeHtml(formatJson(log.data))}</pre></details>`
      : '';
  return `${metaHtml}${dataHtml}`;
}

function renderConfig() {
  if (!elements.configResults) return;
  if (!state.configReports.length) {
    elements.configResults.innerHTML =
      '<p class="hint">Provide base URLs above and run validation to inspect each service's configuration status.</p>';
    return;
  }
  const cards = state.configReports
    .map((entry) => {
      if (entry.error) {
        return `<div class="config-card config-card--error">
            <div class="config-card__header">
              <div>
                <h3>${escapeHtml(entry.serviceName)}</h3>
                <p class="config-card__url">${escapeHtml(entry.baseUrl)}</p>
              </div>
              <span class="pill status-error">ERROR</span>
            </div>
            <p class="timeline__text">${escapeHtml(entry.error.message || 'Unable to fetch report')}</p>
          </div>`;
      }
      const report = entry.report || {};
      const missingRequired = Object.entries(report.required || {})
        .filter(([, status]) => status !== 'present')
        .map(([key]) => key);
      const errors = Array.isArray(report.errors) ? report.errors : [];
      const status = sanitizeStatus(report.status || 'unknown');
      return `<div class="config-card ${report.status === 'ok' ? '' : 'config-card--error'}">
          <div class="config-card__header">
            <div>
              <h3>${escapeHtml(entry.serviceName)}</h3>
              <p class="config-card__url">${escapeHtml(entry.baseUrl)}</p>
            </div>
            <span class="pill status-${status}">${escapeHtml(status.toUpperCase())}</span>
          </div>
          <div class="detail-section">
            <h3>Required keys</h3>
            ${
              missingRequired.length
                ? `<ul class="bullet-list">${missingRequired.map((key) => `<li>${escapeHtml(key)}</li>`).join('')}</ul>`
                : '<p class="hint">All required keys present.</p>'
            }
          </div>
          <div class="detail-section">
            <h3>Validation errors</h3>
            ${
              errors.length
                ? `<ul class="bullet-list">${errors
                    .map((err) => `<li>${escapeHtml(`${err.instancePath || '/'} ${err.message || ''}`.trim())}</li>`)
                    .join('')}</ul>`
                : '<p class="hint">No schema violations detected.</p>'
            }
          </div>
        </div>`;
    })
    .join('');
  elements.configResults.innerHTML = cards;
}

function setTaskFeedback(message, variant) {
  if (!elements.taskFeedback) return;
  const classes = ['feedback', 'is-visible'];
  if (variant === 'success') classes.push('success');
  if (variant === 'error') classes.push('error');
  elements.taskFeedback.className = classes.join(' ');
  elements.taskFeedback.textContent = message;
}

function setStatus(message, variant) {
  if (!elements.statusBanner) return;
  const classes = ['status-banner'];
  if (variant === 'ok') classes.push('status-ok');
  if (variant === 'error') classes.push('status-error');
  if (variant === 'pending') classes.push('status-pending');
  elements.statusBanner.className = classes.join(' ');
  elements.statusBanner.textContent = message;
}

async function apiRequest(baseUrl, path, options = {}) {
  if (!baseUrl) {
    throw new Error('Base URL is not configured');
  }
  const target = resolveUrl(baseUrl, path || '');
  const headers = Object.assign({}, options.headers || {});
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  headers.Accept = headers.Accept || 'application/json';
  if (state.authHeader) {
    headers.Authorization = state.authHeader;
  }

  const response = await fetch(target, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  if (!text) return null;

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('Failed to parse JSON response');
    }
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function resolveUrl(baseUrl, path) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase).toString();
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })}`;
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortId(value) {
  if (!value) return '—';
  const str = String(value);
  if (str.length <= 12) return str;
  return `${str.slice(0, 6)}…${str.slice(-4)}`;
}

function sanitizeStatus(status) {
  return String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}
