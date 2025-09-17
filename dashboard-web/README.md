# Dashboard Web

Static single-page app placeholder for monitoring tasks, logs, and service configuration.

The Render static site configuration publishes from the `dist/` directory. During development replace the placeholder files in `dist/` with the compiled dashboard build output.

## API helpers

- `src/api/contracts.js` documents task, event, log, and WebSocket frame shapes consumed by the UI.
- `src/api/client.js` exposes a fetch-based orchestrator client and WebSocket helper for the dashboard.
