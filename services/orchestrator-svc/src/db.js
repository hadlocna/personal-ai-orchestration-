const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const useSsl = process.env.PGSSL_DISABLE !== 'true' && process.env.NODE_ENV !== 'development';

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: useSsl
    ? {
        rejectUnauthorized: false,
        require: true
      }
    : false
});

pool.on('error', (err) => {
  console.error('Postgres pool error', err);
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        payload JSONB NOT NULL,
        result JSONB,
        error JSONB,
        correlation_id TEXT,
        trace_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        agent_id UUID,
        agent_slug TEXT,
        agent_display_name TEXT,
        agent_channel TEXT
      )
    `);

    // Ensure columns exist before creating indexes that depend on them
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_id UUID');
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_slug TEXT');
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_display_name TEXT');
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_channel TEXT');

    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_corr ON tasks(correlation_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_agent_slug ON tasks(agent_slug)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_events (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        data JSONB,
        correlation_id TEXT,
        trace_id TEXT
      )
    `);

    await client.query('ALTER TABLE task_events ADD COLUMN IF NOT EXISTS correlation_id TEXT');
    await client.query('ALTER TABLE task_events ADD COLUMN IF NOT EXISTS trace_id TEXT');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_task_ts ON task_events(task_id, ts_utc DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_corr ON task_events(correlation_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_trace ON task_events(trace_id)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        id UUID PRIMARY KEY,
        agent TEXT NOT NULL,
        ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        meta JSONB
      )
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createTask({ type, payload, source, correlationId, traceId, actor, agent }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = uuidv4();

    const agentId = agent?.id || null;
    const agentSlug = agent?.slug || null;
    const agentDisplayName = agent?.displayName || null;
    const agentChannel = agent?.channel || null;

    const { rows } = await client.query(
      `INSERT INTO tasks (id, type, status, source, payload, correlation_id, trace_id, agent_id, agent_slug, agent_display_name, agent_channel)
       VALUES ($1, $2, 'queued', $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        type,
        source,
        JSON.stringify(payload ?? {}),
        correlationId || null,
        traceId,
        agentId,
        agentSlug,
        agentDisplayName,
        agentChannel
      ]
    );

    const task = rows[0];

    const event = await insertTaskEvent(client, {
      taskId: id,
      actor,
      kind: 'created',
      data: {
        type,
        source,
        correlationId: correlationId || null
      },
      correlationId: correlationId || null,
      traceId
    });

    let assignmentEvent = null;
    if (agentSlug) {
      assignmentEvent = await insertTaskEvent(client, {
        taskId: id,
        actor,
        kind: 'agent_assigned',
        data: {
          agentId,
          agentSlug,
          agentDisplayName,
          agentChannel
        },
        correlationId: correlationId || null,
        traceId
      });
    }

    await client.query('COMMIT');
    return { task, event, assignmentEvent };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getTaskWithEvents(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: taskRows } = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskRows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const task = taskRows[0];
    const { rows: eventRows } = await client.query(
      'SELECT * FROM task_events WHERE task_id = $1 ORDER BY ts_utc ASC',
      [id]
    );

    await client.query('COMMIT');
    return { task, events: eventRows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listTasks({ status, since, correlationId, limit = 50 }) {
  const clauses = [];
  const values = [];

  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }

  if (since) {
    values.push(since);
    clauses.push(`updated_at >= $${values.length}`);
  }

  if (correlationId) {
    values.push(correlationId);
    clauses.push(`correlation_id = $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT $${values.length}`,
    values
  );

  return rows;
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

async function applyTaskPatch({ id, ifVersion, patch, event }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { query, values } = buildPatchQuery({ id, ifVersion, patch });
    const { rows } = await client.query(query, values);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('Task version conflict');
    }
    const task = rows[0];

    let persistedEvent = null;
    if (event) {
      persistedEvent = await insertTaskEvent(client, {
        taskId: id,
        actor: event.actor,
        kind: event.kind,
        data: event.data || null,
        correlationId: task.correlation_id,
        traceId: task.trace_id
      });
    }

    await client.query('COMMIT');
    return { task, event: persistedEvent };
  } catch (err) {
    if (err instanceof ConflictError) {
      throw err;
    }
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function buildPatchQuery({ id, ifVersion, patch }) {
  const sets = [];
  const values = [id, ifVersion];
  let paramIndex = 3;

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    sets.push(`status = $${paramIndex++}`);
    values.push(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
    sets.push(`result = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(patch.result));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
    sets.push(`error = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(patch.error));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'payload')) {
    sets.push(`payload = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(patch.payload));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'correlationId')) {
    sets.push(`correlation_id = $${paramIndex++}`);
    values.push(patch.correlationId);
  }

  if (sets.length === 0) {
    throw new Error('No fields provided for task patch');
  }

  sets.push('version = version + 1');
  sets.push('updated_at = now()');

  const query = `
    UPDATE tasks
    SET ${sets.join(', ')}
    WHERE id = $1 AND version = $2
    RETURNING *
  `;

  return { query, values };
}

async function insertTaskEvent(client, { taskId, actor, kind, data, correlationId, traceId }) {
  const { rows } = await client.query(
    `INSERT INTO task_events (id, task_id, actor, kind, data, correlation_id, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id, task_id, actor, kind, data, ts_utc, correlation_id, trace_id`,
    [
      uuidv4(),
      taskId,
      actor,
      kind,
      data ? JSON.stringify(data) : null,
      correlationId || null,
      traceId || null
    ]
  );
  return rows[0];
}

async function listActiveAgents() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM agent_registry WHERE COALESCE(is_active, true) = true ORDER BY display_name'
    );
    return rows;
  } catch (err) {
    if (err.code === '42P01') {
      return [];
    }
    throw err;
  }
}

module.exports = {
  pool,
  initDb,
  createTask,
  getTask,
  getTaskWithEvents,
  listTasks,
  applyTaskPatch,
  ConflictError,
  insertTaskEvent,
  listActiveAgents
};
