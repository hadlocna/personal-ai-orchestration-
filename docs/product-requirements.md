# Product Requirements — Personal AI Orchestration

## Vision & Objectives
- Deliver a modular, continuously running agent framework that automates outbound communications, deployment workflows, and observability across services.
- Ship an MVP that can create and execute agent tasks end-to-end, auto-deploy code through Render, and expose real-time visibility to operators.
- Optimize for rapid iteration: infrastructure-as-code, schema-driven configuration, and developer-friendly debugging.

## User Stories
- **Operator** can create tasks, monitor progress, and inspect logs from a single dashboard.
- **Agent developer** can add new service capabilities without breaking existing modules thanks to stable internal APIs.
- **DevOps engineer** can roll out changes or adjust infrastructure via `renderctl` endpoints instead of manual dashboard work.
- **External signal** (e.g., Twilio inbound, GitHub webhook) can enqueue work that agents continue asynchronously.

## System Architecture
- **Services** (Node.js) deployed independently on Render, sharing a Postgres instance and common configuration schema.
- **Dashboard** static site consuming orchestrator REST + WebSocket APIs for live task/log streams.
- **Render Infrastructure** managed via `renderctl-svc`, powered by Render REST API, enabling GitHub auto-deploy hooks.
- **Observability** centralized in Postgres (logs + task events) with streaming updates to clients over WebSockets.

```
┌────────────────┐     ┌─────────────────┐     ┌────────────────┐
│ dashboard-web  │◀───▶│ orchestrator-svc │◀─┐  │ logging-svc    │
└────────────────┘ WS  └─────────────────┘  │  └────────────────┘
        ▲        ▲             ▲            │          ▲
        │ REST   │             │            │          │
        │        │             │            │          │
        │        │             │            │          │
        ▼        │             │            │          ▼
┌────────────────┐             │            │   ┌─────────────┐
│ humans / CLIs │             │            └──▶│ Postgres DB │
└────────────────┘             ▼                └─────────────┘
                        ┌─────────────────┐
                        │ echo-agent-svc  │
                        └─────────────────┘
                        ┌─────────────────┐
                        │ renderctl-svc   │
                        └─────────────────┘
```

## Module Specifications
### orchestrator-svc
- **Responsibilities**: task lifecycle management, async execution, WebSocket broadcasting, log proxying.
- **Key APIs**:
  - `POST /task` — create task (generates `id`, `trace_id`, writes task + task_event).
  - `PATCH /task/:id` — optimistic updates using `ifVersion` precondition.
  - `GET /task/:id`, `GET /tasks` — retrieval with filters (`status`, `correlationId`, `since`).
  - `GET /ws` — task/log streaming (secured via Basic Auth + allowed origins); dashboard clients append `?auth=<base64(user:pass)>` during the upgrade handshake.
  - `GET /config/validate`, `GET /health`.
- **Dependencies**: Postgres, `logging-svc`, shared config validator, internal key security.

### logging-svc
- **Responsibilities**: persistent structured log ingestion, querying, optional SSE feed.
- **Key APIs**:
  - `POST /log` — accepts frames with `level`, `service`, `traceId`, `correlationId`.
  - `GET /logs` — filterable query for dashboard and services.
  - `GET /logs/stream` (SSE) — near real-time log stream.
  - `GET /config/validate`, `GET /health`.
- **Storage**: `logs` table (timestamped entries, JSON payload).

### echo-agent-svc
- **Responsibilities**: simple external action executor, demo agent for MVP.
- **Key APIs**:
  - `POST /echo` — internal endpoint triggered by orchestrator to mirror message payloads.
  - `GET /config/validate`, `GET /health`.
- **Extensibility**: future agents (Twilio voice, CRM automations) follow same pattern: authenticated internal API, structured logging, DB instrumentation.

### renderctl-svc
- **Responsibilities**: Render infrastructure automation, eliminating manual dashboard steps.
- **Key APIs**:
  - `POST /render/services` — create services with repo metadata, build settings, and optional env payloads.
  - `PATCH /render/services/:id/env` — bulk apply env vars (mirrors `.env.example`), optionally clearing existing keys.
  - `POST /render/deploy/:id` — trigger manual deploys when auto-deploy is disabled or out-of-band redeploys are needed.
  - `GET /render/services` — list status metadata for dashboard filtering by name or type.
- **Security**: Basic Auth + `RENDER_API_TOKEN`. Optionally restricted by IP in later phases.
- **Configuration**: accepts `RENDER_API_BASE_URL` override for staging/mocked Render environments.
- **Automation**: background monitor (configurable via `RENDER_MONITOR_SERVICES`) inspects recent deploys, recognizes common static-site build failures (missing publish directory, empty build command), applies standardized fixes (`rootDir`, `buildCommand`, `publishPath`) and triggers a redeploy.
- **Infrastructure as Code**: `/render/blueprint/apply` consumes `infra/render.blueprint.yaml` to reconcile service details and env vars against Render, with `dryRun` support for previewing changes.

### dashboard-web
- **Responsibilities**: operator UI for monitoring, manual task creation, configuration health.
- **Core Views**:
  - Activity stream merging WebSocket log frames + task updates.
  - Task table with filters (status, correlation, trace).
  - `/new-task` form for manual submission.
  - Config validation panel hitting each service's `/config/validate` endpoint.
- **Build**: placeholder SPA currently copying static assets to `dist/`; integrate chosen framework later.

### Common Package (`packages/common`)
- **Responsibilities**: shared env validation, HTTP helpers, Base64 Basic Auth utilities, logging client.
- **Key Functions**:
  - `ensureConfig()` — loads/validates env on boot using `infra/config.schema.json` (Ajv + formats).
  - `buildConfigReport()` — used by `/config/validate` endpoints.
  - Future additions: shared WebSocket frame schema, task DTOs.

## Data Model
- `tasks` — persisted with optimistic `version`, `status`, `payload`, `result`, `error`, `correlation_id`, `trace_id`.
- `task_events` — append-only audit trail keyed by `task_id`, capturing lifecycle changes.
- `agent_heartbeats` — optional table for liveness metrics.
- `logs` — structured key/value payloads for debugging; indexed by `service`, `trace_id`, `correlation_id`.

## Security & Auth
- **Global Basic Auth** on all human-facing HTTP endpoints (`BASIC_AUTH_USER/PASS`).
- **X-INTERNAL-KEY** for service-to-service requests (shared secret enforced in middleware).
- **CORS** limited to `WS_ALLOWED_ORIGINS` derived from config.
- **Secret Management**: `.env.example` enumerates keys, `infra/config.schema.json` enforces presence and format.

## Deployment & Infrastructure
- Target platform: Render (Web Services + Static Site + Managed Postgres).
- Each service ships with its own Dockerfile (Render-native build) and uses `render-build.sh` for the dashboard.
- `infra/render.blueprint.yaml` documents desired infrastructure; `renderctl-svc` will apply updates via API.
- CI/CD: GitHub auto-deploy (Render), optional `.github/workflows/deploy.yml` future automation.

## Monitoring & Observability
- `logging-svc` collects logs; orchestrator proxies new records to WebSocket clients.
- Task updates broadcast via WebSocket, enabling real-time dashboards.
- `/config/validate` surfaces configuration drift or missing env vars.

## Risks & Mitigations
- **Configuration drift**: mitigated via schema validation, renderctl environment sync.
- **Agent failures**: optimistic task updates + event log capture errors with context.
- **WebSocket scalability**: phase 1 targets limited operator traffic; future enhancements might fan out via Redis pub/sub.
- **Secret leakage**: keep `.env.example` sanitized; rely on Render secrets manager.

## Roadmap & Phases
1. **Phase 1 — Build Pack (MVP)**
   - Scaffold monorepo (services, dashboard, infra) with shared config utilities.
   - Enforce authentication, environment validation, and Render-friendly deployment.
   - Implement Postgres-backed tasks, events, and logs.
   - Deliver basic dashboard with task list, log stream, config validation, manual task creation.
   - Provide renderctl service hooks for env management and manual deploy triggers.
2. **Phase 2 — Comms Expansion**
   - Integrate Twilio outbound (voice/SMS) agents with orchestrator tasks.
   - Add external webhooks (GitHub, Calendars) to enqueue tasks.
   - Enhance logging with structured tracing, correlation across agents.
3. **Phase 3 — Automation & Scale**
   - Expand renderctl to manage blueprints, scaling policies, and secret propagation.
   - Add analytics dashboards (task SLA, agent effectiveness).
   - Introduce role-based auth and event-based notifications (email/Slack).

## Definitions of Done
- All services boot only when `ensureConfig` passes.
- Tasks lifecycle is testable via API (create, run, complete, error, human patch).
- Dashboard renders live updates from orchestrator WebSocket and surfaces config state.
- Render deployment can be driven entirely via repo (no manual steps) thanks to renderctl + blueprint.

---

_Last updated: 2025-09-17_
