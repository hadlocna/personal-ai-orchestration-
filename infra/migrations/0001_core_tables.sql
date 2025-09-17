-- 0001_core_tables.sql
-- Creates core tables for the Personal AI Orchestration platform.
-- Applies task management, event logging, service logs, and agent heartbeat schemas.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    payload JSONB NOT NULL,
    result JSONB,
    error JSONB,
    correlation_id TEXT,
    trace_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_correlation_id ON tasks (correlation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_trace_id ON tasks (trace_id);

CREATE TABLE IF NOT EXISTS task_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    ts_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    data JSONB,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events (task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_ts ON task_events (ts_utc DESC);

CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT,
    data JSONB,
    trace_id TEXT,
    correlation_id TEXT,
    task_id UUID
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs (trace_id);
CREATE INDEX IF NOT EXISTS idx_logs_correlation_id ON logs (correlation_id);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent TEXT NOT NULL,
    ts_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_ts ON agent_heartbeats (agent, ts_utc DESC);

-- Helper function to automatically bump updated_at on tasks.
CREATE OR REPLACE FUNCTION set_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_updated_at
BEFORE UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_tasks_updated_at();

COMMIT;
