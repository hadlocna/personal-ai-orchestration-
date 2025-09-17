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
4. Hit `GET /config/validate` on any service to confirm environment variable validation using `infra/config.schema.json`.
5. Build Docker images from the repo root; each service Dockerfile expects the full monorepo context and executes `npm install --omit=dev` during build.
6. Apply the baseline Postgres migration with `psql "$POSTGRES_URL" -f infra/migrations/0001_core_tables.sql` before running services that depend on persistence.

## Documentation
- [`docs/product-requirements.md`](docs/product-requirements.md) — comprehensive PRD covering architecture, module specs, APIs, data model, security, and roadmap.
- [`docs/phase-1-build-pack.md`](docs/phase-1-build-pack.md) — execution guide for Phase 1 with status, deliverables, milestones, and acceptance criteria.

## Phase 1 Focus Areas
- Implement database-backed task and log storage with optimistic locking and event trails.
- Finish service endpoints (`logging-svc`, `orchestrator-svc`, `echo-agent-svc`) using shared config + auth primitives.
- Build out dashboard views (activity stream, task manager, config inspector) and hook up WebSocket updates.
- Deliver `renderctl-svc` endpoints to automate Render service provisioning and environment synchronization.

Refer to the documentation above for detailed requirement breakdowns, user stories, and the phased roadmap.
