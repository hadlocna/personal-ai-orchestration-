const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL
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

    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts_utc DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_corr ON logs(correlation_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)');

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
      data ? JSON.stringify(data) : null,
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

module.exports = {
  pool,
  initDb,
  insertLog,
  queryLogs
};
