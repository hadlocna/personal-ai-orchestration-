# Manual Test Plan — Personal AI Orchestration

This guide walks operators and developers through a repeatable manual regression pass covering the Phase 1 MVP scope. Run the suite before significant releases or infrastructure changes.

## 1. Test Environment
- Render: confirm the `personal-ai-orchestration` services (`orchestrator-svc`, `logging-svc`, `echo-agent-svc`, `renderctl-svc`) and the `dashboard-web` static site are using the latest commit on `main` and report `live` deploy status.
- Optional: run `npm run render:status -- --fail-on-error` to surface any failing Render deploys through `renderctl-svc` before beginning the suite.
- Database: apply `infra/migrations/0001_core_tables.sql` to the target Postgres instance.
- Credentials: ensure `.env` (local) or Render environment contains consistent `INTERNAL_KEY`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, and service URLs (`LOGGING_URL`, `ECHO_AGENT_URL`).
- Local tooling (optional): install dependencies with `npm install` and export the same environment variables when executing scripts.

## 2. Configuration & Health Checks
1. For each service (`orchestrator-svc`, `logging-svc`, `echo-agent-svc`, `renderctl-svc`):
   - Call `GET /config/validate` with Basic Auth. Expect `status: "ok"` and no missing keys.
   - Call `GET /health`. Expect HTTP 200 with `status: "ok"`.
2. Run `npm run config:doctor --workspace @repo/orchestrator-svc` (and equivalent for other services). Expect success output without missing keys.

## 3. Logging Service Regression
1. `POST /log` with a sample payload (`{ level: "info", service: "manual-test", message: "ping", payload: { marker: "test" } }`). Expect HTTP 202.
2. `GET /logs?service=manual-test` should include the entry above.
3. Start the SSE stream `GET /logs/stream`. Trigger another `POST /log` and ensure the event arrives on the stream.

## 4. Orchestrator Task Lifecycle
1. Queue a task: `POST /task` with body `{ "type": "echo", "source": "manual", "payload": { "message": "hello" } }`.
2. Immediately `GET /tasks?status=queued` to confirm the new task appears. Capture `id` and `version`.
3. Within a few seconds, poll `GET /task/:id` until `status` becomes `done` and `result.payload.message == "hello"`.
4. Ensure a `running` event and a `result` event are present in the `events` array.
5. Query `logging-svc` history:
   - `GET /logs?service=orchestrator-svc&corrId=<corr>` should include the orchestration log frames.
   - `GET /task/events?taskId=<id>` (or `corrId=<corr>`) returns the persisted event trail—look for `status_change` and `result` rows.
6. Negative case: `POST /task` with unsupported `type` and verify the task transitions to `error` with the expected message.

## 5. Echo Agent Verification
1. Direct call: `POST /echo` with Basic Auth and payload `{ "traceId": "manual-test", "payload": { "message": "echo" } }`. Expect HTTP 200 with the same payload returned.
2. Confirm the agent writes a log entry in `logging-svc` (`service=echo-agent-svc`).

## 6. Dashboard UX Pass
1. Open the deployed dashboard and configure connections using valid URLs and credentials.
2. Confirm connection status turns green and the activity stream starts updating.
3. Verify the task summary counts match `GET /tasks` results.
4. Use the dashboard form to queue an `echo` task. Observe live activity updates and confirm task detail view shows payload, result, and events.
5. Run the Config Inspector once orchestrator, logging, echo, and renderctl URLs are set; verify all services report `status: ok`.
6. Confirm settings persist after page refresh (localStorage).

## 7. Render Control Regression
1. List services via `GET /render/services` and confirm metadata reflects Render dashboard state (IDs, names, status).
2. Trigger a deploy with `POST /render/deploy/<serviceId>` on a non-critical service; watch Render dashboard for the manual deploy event.
3. Blueprint dry run: `POST /render/blueprint/apply` with `{ "dryRun": true }` and verify the diff output matches expectations without applying changes.
4. (Optional) Validate the static-site auto-remediation: intentionally break `dashboard-web` build settings on Render, wait for monitor to patch and redeploy, then revert.
5. Operator CLI sanity: run `node scripts/render-status.js --json` and `node scripts/renderctl-ops.js list` (with `RENDERCTL_URL` + auth envs exported) to confirm renderctl responds end-to-end.

## 8. Smoke Script (Optional)
- Execute `npm run test:smoke` with environment variables `ORCHESTRATOR_URL`, `LOGGING_URL`, `BASIC_AUTH_USER`, and `BASIC_AUTH_PASS`. Expect the script to queue an echo task, await completion, and exit with code 0.

## 9. Test Log & Sign-off
- Record test date, operator, commit SHA, and noted issues in the runbook or shared tracker.
- Any deviation or failure should capture logs, request/response payloads, and Render deploy IDs for debugging.

_Last updated: 2025-09-18_
