import { createApiClient, encodeBasicAuth } from './api/client.js';

const STORAGE_KEY = 'paio-dashboard-settings';
const MAX_ACTIVITY_ENTRIES = 200;

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
  configResults: document.getElementById('config-results')
};

const state = {
  tasks: new Map(),
  filters: { status: '', corrId: '', limit: 50 },
  selectedTaskId: null,
  selectedTaskDetail: null,
  events: [],
  configReports: []
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

function onSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(elements.settingsForm);
  settings = {
    orchestratorUrl: formData.get('orchestratorUrl')?.trim() || '',
    websocketUrl: formData.get('websocketUrl')?.trim() || '',
    loggingUrl: formData.get('loggingUrl')?.trim() || '',
    echoUrl: formData.get('echoUrl')?.trim() || '',
    renderctlUrl: formData.get('renderctlUrl')?.trim() || '',
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
    return {
      orchestratorUrl: '',
      websocketUrl: '',
      loggingUrl: '',
      echoUrl: '',
      renderctlUrl: '',
      username: '',
      password: ''
    };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        orchestratorUrl: '',
        websocketUrl: '',
        loggingUrl: '',
        echoUrl: '',
        renderctlUrl: '',
        username: '',
        password: ''
      };
    }
    const parsed = JSON.parse(raw);
    return {
      orchestratorUrl: parsed.orchestratorUrl || '',
      websocketUrl: parsed.websocketUrl || '',
      loggingUrl: parsed.loggingUrl || '',
      echoUrl: parsed.echoUrl || '',
      renderctlUrl: parsed.renderctlUrl || '',
      username: parsed.username || '',
      password: parsed.password || ''
    };
  } catch (err) {
    console.warn('Failed to load stored settings', err);
    return {
      orchestratorUrl: '',
      websocketUrl: '',
      loggingUrl: '',
      echoUrl: '',
      renderctlUrl: '',
      username: '',
      password: ''
    };
  }
}

function saveSettings(next) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('Failed to persist settings', err);
  }
}

function clearStoredSettings() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  settings = {
    orchestratorUrl: '',
    websocketUrl: '',
    loggingUrl: '',
    echoUrl: '',
    renderctlUrl: '',
    username: '',
    password: ''
  };
  applySettingsToForm(settings);
  disconnectWebsocket();
  orchestratorClient = null;
  loggingClient = null;
  state.tasks.clear();
  state.events = [];
  state.selectedTaskDetail = null;
  state.selectedTaskId = null;
  renderSummary();
  renderTaskTable();
  renderTaskDetail();
  renderActivity();
  renderConfigReports();
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

  await Promise.allSettled([refreshTasks(), refreshActivity(), refreshConfig()]);
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

function connectWebsocket() {
  const wsUrl = settings.websocketUrl || deriveWsUrl(settings.orchestratorUrl);
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
  };

  websocket.onerror = (event) => {
    console.warn('WebSocket error', event);
    setConnectionStatus('error', 'WebSocket error');
  };

  websocket.onclose = () => {
    setConnectionStatus('disconnected', 'Disconnected');
    scheduleReconnect();
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
