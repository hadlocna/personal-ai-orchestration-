# Phase 1 Build Pack — Execution Guide

## Goals
- Stand up the Render-friendly monorepo with baseline services, dashboard, and infra assets.
- Enforce shared configuration, authentication, and deployment patterns across all modules.
- Deliver a thin but complete loop: create tasks, execute via agents, log and observe outcomes in real time.

## Current Status Snapshot
- ✅ Monorepo structure with service folders, dashboard stub, and infra configs.
- ✅ Shared config validation (`packages/common`) with Ajv + formats.
- ✅ Render static site build pipeline (`render-build.sh`, `publishPath: dist`).
- ✅ Postgres schema + migrations for tasks/logs/events.
- ✅ Service implementations (orchestrator, logging, echo agent) using the shared config package.
- ✅ Dashboard views (activity stream, task table, config inspector).
- ✅ renderctl service endpoints for Render automation.
- ✅ Postgres bootstrap + migration definitions kept in sync (tasks/logs/events schema with trace + correlation indices).
- ✅ Render blueprint enumerates dashboard + service deployments for renderctl reconciliation.

## Deliverables & Tasks
1. **Monorepo Foundations** *(done)*
   - Directory layout (`services/*`, `dashboard-web/`, `infra/`).
   - `.env.example` enumerating all required keys (ensure secrets remain sample-only).
   - `infra/config.schema.json` maintained as single source of truth.

2. **Auth Everywhere** *(done)*
   - Basic Auth middleware for human endpoints (`BASIC_AUTH_USER/PASS`).
   - `X-INTERNAL-KEY` checks for inter-service calls.
   - WebSocket upgrades enforce Basic Auth or internal key before accepting connections.
   - Dashboard websocket clients append `?auth=base64(user:pass)` to satisfy the handshake.
   - Shared helpers in `packages/common` to avoid duplication.

3. **Configuration Discipline** *(done)*
   - Boot-time `ensureConfig()` in every service; fail fast on missing env vars.
   - `/config/validate` endpoint leveraging `buildConfigReport()`.
   - Config doctor CLI command per service (`npm run config:doctor` in each workspace, now exposed via package scripts).

4. **Persistent Task Engine**
   - Author migrations for `tasks`, `task_events`, `logs`, optionally `agent_heartbeats`.
   - Implement optimistic locking (`version` column) and event logging on changes.
   - WebSocket broadcasts for task state transitions and log entries.

5. **Service Implementations**
   - `logging-svc`: REST ingest + query + SSE stream, writes to Postgres.
   - `orchestrator-svc`: task lifecycle, async handlers, WS hub, log proxy.
   - `echo-agent-svc`: internal demo agent invoked by orchestrator.
   - Health + config endpoints consistent across services.

6. **Dashboard Web**
   - Replace placeholder HTML with SPA (framework optional) consuming orchestrator APIs.
   - Views: activity stream, tasks table, new-task form, config validation matrix.
   - Authentication handling (Basic Auth prompt or credential storage).

7. **Render Automation** *(done)*
   - `renderctl-svc` minimal API wrapping Render REST: create service, apply env, trigger deploy.
   - Automated build failure monitor fixes common static site misconfiguration and redeploys.
   - Support reading definitions from `infra/render.blueprint.yaml` (apply/sync).
   - CLI scripts for operators: `scripts/render-status.js` (deploy status summary) and `scripts/renderctl-ops.js` (list, deploy, env patch, blueprint apply).

8. **Ops & QA**
   - ✅ Local dev scripts to run services (npm scripts or docker-compose) via `npm run dev:services` (Codex agent, 2025-09-18).
   - ✅ Seed data + sample payloads for smoke testing (`examples/`, `npm run seed:examples`) (Codex agent, 2025-09-18).
   - ✅ Document manual test plan in `docs/testing.md` (Codex agent, 2025-09-18).

## Milestones & Sequencing
1. **Week 1**
   - Config + auth foundations across all services.
   - Task/log DB schema + migrations committed.
2. **Week 2**
   - logging-svc + orchestrator-svc MVP, WebSocket broadcasting logs to dashboard stub.
3. **Week 3**
   - echo-agent integration, task lifecycle end-to-end.
   - Dashboard minimal UX for task creation + monitoring.
4. **Week 4**
   - renderctl-svc endpoints, blueprint sync, documentation polish.
   - Non-functional hardening (metrics, error handling, user docs).

## Acceptance Criteria
- Deploying `main` to Render spins up all services with passing config validation.
- Operators can submit a task (echo) and watch it progress to completion in the dashboard.
- Log entries and task events persist in Postgres and stream live over WebSocket.
- Render environments can be created/updated via renderctl (no manual secret copying).

_Last updated: 2025-09-19_
