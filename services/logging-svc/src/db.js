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
      CREATE TABLE IF NOT EXISTS logs (
        id UUID PRIMARY KEY,
        ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        service TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data JSONB,
        task_id UUID,
        correlation_id TEXT,
        trace_id TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_events (
        id UUID PRIMARY KEY,
        ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
        task_id UUID NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        data JSONB,
        correlation_id TEXT,
        trace_id TEXT
      )
    `);

    await client.query('ALTER TABLE logs ADD COLUMN IF NOT EXISTS trace_id TEXT');
    await client.query('ALTER TABLE task_events ADD COLUMN IF NOT EXISTS trace_id TEXT');

    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts_utc DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_corr ON logs(correlation_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_task_ts ON task_events(task_id, ts_utc DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_corr ON task_events(correlation_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_task_events_trace ON task_events(trace_id)');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertLog(entry) {
  const {
    service,
    level,
    message,
    data,
    taskId,
    correlationId,
    traceId
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO logs (id, service, level, message, data, task_id, correlation_id, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING *`,
    [
      uuidv4(),
      service,
      level,
      message,
      data === undefined || data === null ? null : JSON.stringify(data),
      taskId || null,
      correlationId || null,
      traceId || null
    ]
  );

  return rows[0];
}

async function queryLogs(filters) {
  const clauses = [];
  const values = [];

  if (filters.service) {
    values.push(filters.service);
    clauses.push(`service = $${values.length}`);
  }
  if (filters.level) {
    values.push(filters.level);
    clauses.push(`level = $${values.length}`);
  }
  if (filters.correlationId) {
    values.push(filters.correlationId);
    clauses.push(`correlation_id = $${values.length}`);
  }
  if (filters.traceId) {
    values.push(filters.traceId);
    clauses.push(`trace_id = $${values.length}`);
  }
  if (filters.taskId) {
    values.push(filters.taskId);
    clauses.push(`task_id = $${values.length}`);
  }
  if (filters.since) {
    values.push(filters.since);
    clauses.push(`ts_utc >= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters.limit || 100;
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM logs ${where} ORDER BY ts_utc DESC LIMIT $${values.length}`,
    values
  );

  return rows;
}

async function queryTaskEvents(filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.taskId) {
    values.push(filters.taskId);
    clauses.push(`task_id = $${values.length}`);
  }
  if (filters.traceId) {
    values.push(filters.traceId);
    clauses.push(`trace_id = $${values.length}`);
  }
  if (filters.correlationId) {
    values.push(filters.correlationId);
    clauses.push(`correlation_id = $${values.length}`);
  }
  if (filters.actor) {
    values.push(filters.actor);
    clauses.push(`actor = $${values.length}`);
  }
  if (filters.kind) {
    values.push(filters.kind);
    clauses.push(`kind = $${values.length}`);
  }
  if (filters.since) {
    values.push(filters.since);
    clauses.push(`ts_utc >= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters.limit || 200;
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM task_events ${where} ORDER BY ts_utc DESC LIMIT $${values.length}`,
    values
  );

  return rows;
}

async function insertTaskEvent({
  taskId,
  actor,
  kind,
  data,
  correlationId,
  traceId
}) {
  const { rows } = await pool.query(
    `INSERT INTO task_events (id, task_id, actor, kind, data, correlation_id, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      uuidv4(),
      taskId,
      actor,
      kind,
      data === undefined || data === null ? null : JSON.stringify(data),
      correlationId || null,
      traceId || null
    ]
  );

  return rows[0];
}

module.exports = {
  pool,
  initDb,
  insertLog,
  queryLogs,
  queryTaskEvents,
  insertTaskEvent
};
