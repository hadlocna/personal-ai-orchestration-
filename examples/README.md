# Examples

Curated sample payloads and walkthroughs for the Phase 1 smoke flows.

## Echo Task (`POST /task`)
- File: `echo-task.json`
- Purpose: enqueue the canonical demo task handled by `echo-agent-svc`.
- Usage (replace placeholders or export env vars first):

```bash
curl   -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS"   -H "Content-Type: application/json"   -X POST "$ORCHESTRATOR_URL/task"   --data-binary @examples/echo-task.json
```

## Log Ingestion (`POST /log`)
Quick sanity payload for `logging-svc`:

```bash
curl   -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS"   -H "Content-Type: application/json"   -X POST "$LOGGING_URL/log"   --data '{"service":"example","level":"info","message":"hello world"}'
```

## Task Event (`POST /task/event` on logging-svc)

```bash
curl   -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS"   -H "Content-Type: application/json"   -X POST "$LOGGING_URL/task/event"   --data '{"taskId":"00000000-0000-0000-0000-000000000000","actor":"examples","kind":"note","data":{"detail":"demo"}}'
```

> Tip: run `npm run test:smoke` afterwards to validate the full round-trip.
