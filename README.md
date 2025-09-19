# Personal AI Orchestration

Modular monorepo for a continuously running agent framework that coordinates outbound communications, deployment automation, and observability. The layout is optimized for Render deployments and implements the Phase 1 "Build Pack" plan defined in [`docs/product-requirements.md`](docs/product-requirements.md).

- **services/** — Each backend service (orchestrator, logging, echo agent, render control) bundles its own source and Dockerfile.
- **dashboard-web/** — Static dashboard that surfaces task activity, logs, config validation, and manual task triggers.
- **infra/** — Shared configuration schema, Render blueprint, and other deployment automation assets.
- **.github/workflows/** — CI/CD workflows. `deploy.yml` currently mirrors the monorepo and is ready for future automation.

## Getting Started

1. Copy `.env.example` to `.env` and adjust credentials/secrets for your environment.
2. Install dependencies with `npm install`. This wires up local workspace packages (e.g. `@repo/common`).
3. Run individual services with `npm run --workspace @repo/orchestrator-svc start` (replace with the desired workspace). All HTTP endpoints currently require Basic Auth or the internal header.
4. Hit `GET /config/validate` on any service—or run `npm run --workspace @repo/<service> config:doctor`—to confirm environment variables match `infra/config.schema.json`.
5. Build Docker images from the repo root; each service Dockerfile expects the full monorepo context and executes `npm install --omit=dev` during build.
6. Apply the baseline Postgres migration with `psql "$POSTGRES_URL" -f infra/migrations/0001_core_tables.sql` before running services that depend on persistence.
7. Populate Phase 2 credentials (Twilio account + auth tokens, OpenAI key/model, new agent URLs, webhook secrets, and channel defaults) in `.env` so the upcoming communication services can pass config validation.

## Documentation
- [`docs/product-requirements.md`](docs/product-requirements.md) — comprehensive PRD covering architecture, module specs, APIs, data model, security, and roadmap.
- [`docs/phase-1-build-pack.md`](docs/phase-1-build-pack.md) — execution guide for Phase 1 with status, deliverables, milestones, and acceptance criteria.
- [`docs/phase-2-build-pack.md`](docs/phase-2-build-pack.md) — roadmap and task list for the communications-focused Phase 2 rollout.
- [`docs/testing.md`](docs/testing.md) — manual regression checklist spanning services, dashboard, and Render automation.

## Phase 1 Focus Areas
- Implement database-backed task and log storage with optimistic locking and event trails.
- Finish service endpoints (`logging-svc`, `orchestrator-svc`, `echo-agent-svc`) using shared config + auth primitives.
- Build out dashboard views (activity stream, task manager, config inspector) and hook up WebSocket updates.
- Deliver `renderctl-svc` endpoints to automate Render service provisioning and environment synchronization.

Refer to the documentation above for detailed requirement breakdowns, user stories, and the phased roadmap.

## Render Control Quickstart
- Ensure `RENDER_API_TOKEN` (and optional `RENDER_API_BASE_URL`) are set for `renderctl-svc`.
- `POST /render/services` accepts a `service` payload mirroring Render's API and an optional `env` object for initial secrets.
- `PATCH /render/services/:id/env` bulk-updates environment variables with optional `clear` flag to wipe existing keys.
- `POST /render/deploy/:id` triggers a deploy immediately; `GET /render/services` lists current services with optional `type` and `name` filters.
- Background monitoring can be enabled via `RENDER_MONITOR_SERVICES` (comma-separated names or `id:<serviceId>`). When a monitored static site build fails with missing publish directory or build command, renderctl patches the service to use `rootDir`=`.` / `buildCommand`=`./render-build.sh` / `publishPath`=`dashboard-web/dist` and reruns the deploy. Tune via `RENDER_STATIC_SITE_*` env vars.
- `POST /render/blueprint/apply` reads `infra/render.blueprint.yaml` (or a supplied `blueprintPath`) and updates each listed service's `serviceDetails` and env vars. The blueprint now enumerates every Phase 1 service—replace the `__REPLACE__` placeholders with live credentials before applying—and `{ "dryRun": true }` previews changes without touching Render.
- `GET /task/events` on logging-svc surfaces the persisted event timeline for any task (filter by `taskId`, `corrId`, `traceId`, `actor`, or `kind`).
- Operator CLI helpers: `node scripts/render-status.js` summarizes service deploy state, and `node scripts/renderctl-ops.js` exposes `list`, `deploy`, `env`, and `blueprint` commands against renderctl-svc.

## CLI Utilities
- `npm run config:doctor` — print config validation status for the current environment (pass a service name when needed). Each workspace also exposes `npm run --workspace @repo/<service> config:doctor` for convenience.
- `npm run test:smoke` — enqueue an echo task, await completion, and verify logs end-to-end.
- `npm run seed:examples` — post sample echo tasks (optionally wait for completion) and emit a demo log.
- `npm run render:status` — leverage `renderctl-svc` to list services and report the latest deploy status (use `--fail-on-error` to exit non-zero when any deploy failed).
- `npm run dev:services` — launch orchestrator, logging, echo, and renderctl services locally with prefixed logs (pass `--only orchestrator,logging` to limit scope).

## Deployment notes
- After every push to `main`, confirm each Render web service in the personal-ai-orchestration environment shows the latest deploy as `live`. Use `renderctl-svc` (`GET /render/services`) or the Render dashboard, and trigger a redeploy if any service reports `update_failed`.
- Ensure every service is configured with the same `INTERNAL_KEY`, `BASIC_AUTH_USER`, and `BASIC_AUTH_PASS` so internal calls and Basic Auth succeed.
- Set `LOGGING_URL` to the deployed logging-svc endpoint; orchestrator subscribes to `/logs/stream` to rebroadcast log frames over WebSocket.
- Before deploying new environments, run `npm run config:doctor` (or `npm run --workspace @repo/<service> config:doctor`) or hit each service’s `/config/validate` endpoint to confirm env keys match `infra/config.schema.json`.
- The shared migration and service bootstraps now agree on the `trace_id`/`correlation_id` columns and supporting indexes; run `infra/migrations/0001_core_tables.sql` once per environment so services can start cleanly.
- Validate deployed environments with `npm run test:smoke` (requires `ORCHESTRATOR_URL`, `LOGGING_URL`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` in your shell) to ensure the echo task round-trip succeeds.
