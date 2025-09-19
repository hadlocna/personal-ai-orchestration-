# Dashboard Web

Operator-focused SPA for the Personal AI Orchestration stack. The dashboard covers the Phase 1 control loop:

- save connection settings (Basic Auth + service URLs) locally and reconnect with one click
- list tasks with filtering, inspect payload/result/event timelines, and queue new jobs
- stream activity via the orchestrator WebSocket and logging fan-out so operators see live updates
- validate service configuration using `/config/validate` endpoints for orchestrator, logging, echo, and renderctl
- run connectivity checks against each service (`/health` + `/config/validate`) to confirm the dashboard can reach orchestrator, logging, echo, and renderctl before kicking off workflows

## Development

```
# install dependencies from repo root
npm install

# build static assets into dashboard-web/dist/
npm run build --prefix dashboard-web

# serve locally for manual testing
npx serve dashboard-web/dist
```

The build script (`scripts/build.js`) copies everything from `src/` to `dist/`, which Render serves as a static site.

## Code Map

- `src/app.js` — vanilla JS controller that manages state, orchestrator/logging API calls, and WebSocket events.
- `src/api/client.js` — thin fetch-based helper reused across the dashboard; supports Basic Auth and query helpers.
- `src/api/contracts.js` — JSDoc typedefs documenting task/log/event shapes for editor tooling.
- `src/styles.css` — handcrafted Tailwind-inspired dark theme for the operator interface.

## Deployment

Render static site services run `./render-build.sh` from the repo root, which invokes the build step above and publishes `dashboard-web/dist/`. No extra bundling is required.
