# Personal AI Orchestration

Modular monorepo for a continuously running agent framework that coordinates outbound communications, deployment automation, and observability. The layout is optimized for Render deployments and follows the phase-one plan:

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

## Next Steps

- Flesh out service implementations with Postgres integrations, WebSocket handling, and task orchestration logic.
- Create database migrations for tasks, task events, agent heartbeats, and logs tables.
- Implement the dashboard SPA and WebSocket client for unified visibility.
- Extend `render.blueprint.yaml` and `renderctl-svc` to manage Render resources via API.
