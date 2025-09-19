# Phase 2 Build Pack — Communications & Multi-Agent Expansion

## Goals
- Introduce multi-channel communications (voice, SMS/WhatsApp, email, dynamic content) powered by modular agents.
- Extend the platform foundations established in Phase 1 to support asynchronous agent workflows, richer telemetry, and improved operator tooling.
- Maintain Render-first deployment ergonomics and consistent configuration validation across all services.

## Implementation Tracks
1. **Platform Foundations for Multi-Agent Expansion**
   - Extend `infra/config.schema.json`, `.env.example`, and service config reports with Twilio/OpenAI credentials, webhook secrets, and agent URLs.
   - Author follow-on migrations for communication dossiers (calls, messages, emails, artifacts) and agent registry metadata.
   - Refactor the orchestrator to load handlers from a registry, enable dispatch-only handlers, and capture agent assignment metadata.
   - Add signature verification helpers to `@repo/common` for webhook-driven services.
   - Update local tooling and Render blueprints to include new agents out of the box.

2. **Real-Time Outbound Voice Agent (Twilio)**
   - Scaffold `services/call-agent-svc` with shared middleware, Dockerfile, and workspace wiring.
   - Implement `POST /call` dispatch, Twilio webhook intake, transcript storage, and orchestrator PATCH callbacks.
   - Support test vs production modes for local/CI runs.

3. **Messaging Agents (SMS / WhatsApp)**
   - Build `services/messaging-agent-svc` with outbound send + inbound webhook routes.
   - Add new task types (`sms.send`, `whatsapp.send`, `sms.inbound`) and persist provider message IDs.
   - Parameterize message bodies for template and LLM-backed content.

4. **Email & Rich Content Delivery**
   - Create `services/email-agent-svc` leveraging SendGrid/SMTP APIs with artifact storage.
   - Introduce dynamic content generation service/worker for AI-authored summaries with hosted URLs.
   - Extend orchestrator routing rules to select channels based on task metadata and policies.

5. **Logging, Dossier, and Audit Enhancements**
   - Enrich logging taxonomy with channel tags and handle large artifacts via blob references.
   - Deliver dossier query APIs for cross-channel history per contact/correlation ID.
   - Implement retention/redaction helpers and agent heartbeat tracking.

6. **Dashboard & Operator UX**
   - Surface channel filters, avatars, and artifacts in the task table/detail views.
   - Provide real-time call visualization and inbound queue management.
   - Add Phase 2 services to config + connectivity checks with Twilio sandbox support.

7. **DevOps, Deployment, and Tooling**
   - Expand `infra/render.blueprint.yaml` and `scripts/dev-services.js` to provision/run new agents.
   - Harden blueprint apply to guard against placeholder secrets and missing Phase 2 env vars.
   - Extend smoke tests and examples to cover asynchronous agent flows.
   - Enhance monitoring for new services and agent health metrics.

8. **Quality Assurance & Compliance**
   - Define contract and end-to-end tests across agents and fallback scenarios.
   - Update `docs/testing.md` with new manual regression steps and webhook verification.
   - Document PII handling, retention policies, and operational runbooks for Twilio outages and retries.

## Sequencing & Ownership
- **Phase 2.1** – Platform schema/migrations + orchestrator agent registry.
- **Phase 2.2** – Call agent service + Twilio webhooks + orchestrator integration.
- **Phase 2.3** – Messaging agent service + inbound task pipeline.
- **Phase 2.4** – Email/rich content delivery + routing rules.
- **Phase 2.5** – Logging/dossier enhancements + dashboard UX.
- **Phase 2.6** – DevOps/tooling updates, expanded smoke tests, monitoring.
- **Phase 2.7** – QA, compliance, and runbook updates.

Progress will be tracked via this document and commit history on `main`. Update sections as milestones land so downstream agents can pick up the next actionable work item.

