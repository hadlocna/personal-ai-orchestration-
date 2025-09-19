# Personal AI Orchestration

Modular monorepo for a continuously running agent framework that coordinates outbound communications, deployment automation, and observability. The layout is optimized for Render deployments with **Phase 1 completed** and **Phase 2 (communications agents) in progress** as defined in [`docs/product-requirements.md`](docs/product-requirements.md).

## Current Status: Phase 2 Communications Build-out

**✅ Phase 1 Complete** - Foundation, orchestrator, logging, dashboard, and deployment automation all operational.

**🚧 Phase 2 In Progress** - Multi-channel communications with specialized agents:
- **✅ Real-Time Voice Agent** — `call-agent-svc` with Twilio + OpenAI SIP realtime integration, supports outbound calls with AI conversation
- **⬜ Messaging Agents** — SMS/WhatsApp agents for text communications (pending)
- **⬜ Email Agent** — SendGrid/SMTP integration for email delivery (pending)
- **⬜ Dynamic Content** — AI-authored content generation with hosted URLs (pending)

## Architecture

- **services/** — Each backend service (orchestrator, logging, echo agent, render control, **call agent**) bundles its own source and Dockerfile.
- **dashboard-web/** — Interactive dashboard with activity stream, task management, config validation, and **voice call tester UI**.
- **infra/** — Shared configuration schema, Render blueprint, migrations, and deployment automation assets.
- **.github/workflows/** — CI/CD workflows. `deploy.yml` currently mirrors the monorepo and is ready for future automation.

## Getting Started

1. Copy `.env.example` to `.env` and adjust credentials/secrets for your environment.
2. Install dependencies with `npm install`. This wires up local workspace packages (e.g. `@repo/common`).
3. Run individual services with `npm run --workspace @repo/orchestrator-svc start` (replace with the desired workspace). All HTTP endpoints currently require Basic Auth or the internal header.
4. Hit `GET /config/validate` on any service—or run `npm run --workspace @repo/<service> config:doctor`—to confirm environment variables match `infra/config.schema.json`.
5. Build Docker images from the repo root; each service Dockerfile expects the full monorepo context and executes `npm install --omit=dev` during build.
6. Apply the baseline Postgres migration with `psql "$POSTGRES_URL" -f infra/migrations/0001_core_tables.sql` before running services that depend on persistence.
7. Apply the Phase 2 dossier migration with `psql "$POSTGRES_URL" -f infra/migrations/0002_comm_dossiers.sql` to provision communication artifacts (calls, messages, emails, content).
8. Populate Phase 2 credentials (Twilio account + auth tokens, OpenAI key/model, new agent URLs, webhook secrets, and channel defaults) in `.env` so the upcoming communication services can pass config validation.

## Documentation
- [`docs/product-requirements.md`](docs/product-requirements.md) — comprehensive PRD covering architecture, module specs, APIs, data model, security, and roadmap.
- [`docs/phase-1-build-pack.md`](docs/phase-1-build-pack.md) — execution guide for Phase 1 with status, deliverables, milestones, and acceptance criteria.
- [`docs/phase-2-build-pack.md`](docs/phase-2-build-pack.md) — roadmap and task list for the communications-focused Phase 2 rollout.
- [`docs/testing.md`](docs/testing.md) — manual regression checklist spanning services, dashboard, and Render automation.

## Phase 2 Implementation Status

### ✅ Completed Components
- **Platform Foundations** — Extended config schema, migrations for communication dossiers, agent registry refactoring, Google OAuth integration, signature verification helpers
- **Real-Time Voice Agent** — `call-agent-svc` with full Twilio + OpenAI SIP realtime integration
- **Dashboard Enhancements** — Voice call tester UI with real-time call progression monitoring

### 🚧 In Progress / Next Priorities
- **Messaging Agent Service** — Build `services/messaging-agent-svc` for SMS/WhatsApp outbound/inbound communications
- **Email Agent Service** — Create `services/email-agent-svc` with SendGrid/SMTP integration
- **Dynamic Content Generation** — Implement AI-authored content service with hosted URLs
- **Enhanced Orchestrator Routing** — Channel selection logic based on task metadata and policies
- **Expanded Dashboard UX** — Channel filters, artifact display, inbound queue management

### 📋 Remaining Phase 2 Tasks
1. **Services to Build:**
   - `messaging-agent-svc` (SMS/WhatsApp via Twilio)
   - `email-agent-svc` (SendGrid/SMTP delivery)
   - Dynamic content generation service/worker

2. **Platform Enhancements:**
   - Multi-channel routing rules in orchestrator
   - Logging taxonomy with channel tags and artifact references
   - Dossier query APIs for cross-channel contact history

3. **DevOps & Quality:**
   - Update Render blueprints and dev tooling for new services
   - Extend smoke tests for asynchronous agent flows
   - Enhanced monitoring and health metrics
   - End-to-end testing across agents and fallback scenarios

Refer to the documentation above for detailed requirement breakdowns, user stories, and the complete phased roadmap.

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
- `npm run test:connectivity` — sanity check internal services plus Twilio, HubSpot, OpenAI, and Google integrations using the current environment variables.
- `npm run seed:examples` — post sample echo tasks (optionally wait for completion) and emit a demo log.
- `npm run render:status` — leverage `renderctl-svc` to list services and report the latest deploy status (use `--fail-on-error` to exit non-zero when any deploy failed).
- `npm run dev:services` — launch orchestrator, logging, echo, renderctl, and call agent services locally with prefixed logs (pass `--only orchestrator,logging` to limit scope).

## Deployment notes
- After every push to `main`, confirm each Render web service in the personal-ai-orchestration environment shows the latest deploy as `live`. Use `renderctl-svc` (`GET /render/services`) or the Render dashboard, and trigger a redeploy if any service reports `update_failed`.
- Ensure every service is configured with the same `INTERNAL_KEY`, `BASIC_AUTH_USER`, and `BASIC_AUTH_PASS` so internal calls and Basic Auth succeed.
- Set `LOGGING_URL` to the deployed logging-svc endpoint; orchestrator subscribes to `/logs/stream` to rebroadcast log frames over WebSocket.
- Before deploying new environments, run `npm run config:doctor` (or `npm run --workspace @repo/<service> config:doctor`) or hit each service’s `/config/validate` endpoint to confirm env keys match `infra/config.schema.json`.
- The shared migration and service bootstraps now agree on the `trace_id`/`correlation_id` columns and supporting indexes; run `infra/migrations/0001_core_tables.sql` once per environment so services can start cleanly.
- Validate deployed environments with `npm run test:smoke` (requires `ORCHESTRATOR_URL`, `LOGGING_URL`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` in your shell) to ensure the echo task round-trip succeeds.
