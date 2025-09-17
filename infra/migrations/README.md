# Database Migrations

This directory stores the canonical Postgres migrations for the Personal AI Orchestration platform. The current baseline (`0001_core_tables.sql`) provisions the task pipeline, log storage, and agent heartbeat tables described in the Phase 1 Build Pack.

## Applying Migrations

1. Export your database connection string (the same value used for `POSTGRES_URL`).

   ```bash
   export DATABASE_URL="postgresql://user:pass@host:5432/db"
   ```

2. Apply the migrations in order using `psql` (or your preferred client).

   ```bash
   psql "$DATABASE_URL" -f infra/migrations/0001_core_tables.sql
   ```

The migration is idempotent; rerunning it will not error thanks to `IF NOT EXISTS` safeguards.

## Tables Created

- `tasks` — persisted queue of work items with optimistic locking support (`version`) and tracing metadata.
- `task_events` — append-only audit log for each task state change or emitted event.
- `logs` — structured service log entries enriched with correlation identifiers.
- `agent_heartbeats` — lightweight heartbeat records for long-running agents.

Keep subsequent migrations in this directory using a zero-padded numeric prefix (e.g., `0002_add_task_index.sql`) to maintain ordering.
