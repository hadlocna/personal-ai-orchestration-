-- 0002_comm_dossiers.sql
-- Introduces communication dossier tables to support Phase 2 multi-channel agents.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS agent_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    config JSONB,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communication_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT,
    channel TEXT NOT NULL,
    display_name TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agent_registry(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES communication_contacts(id) ON DELETE SET NULL,
    provider_call_sid TEXT,
    status TEXT NOT NULL,
    direction TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    transcript JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agent_registry(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES communication_contacts(id) ON DELETE SET NULL,
    provider_message_sid TEXT,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    body JSONB,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agent_registry(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES communication_contacts(id) ON DELETE SET NULL,
    provider_message_id TEXT,
    status TEXT NOT NULL,
    direction TEXT NOT NULL,
    subject TEXT,
    body_url TEXT,
    body_preview TEXT,
    sent_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agent_registry(id) ON DELETE SET NULL,
    artifact_type TEXT NOT NULL,
    uri TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_registry_channel ON agent_registry (channel);
CREATE INDEX IF NOT EXISTS idx_contacts_external ON communication_contacts (external_id, channel);
CREATE INDEX IF NOT EXISTS idx_call_sessions_task ON call_sessions (task_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_sid ON call_sessions (provider_call_sid);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_task ON message_deliveries (task_id);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_provider_sid ON message_deliveries (provider_message_sid);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_task ON email_deliveries (task_id);
CREATE INDEX IF NOT EXISTS idx_content_artifacts_task ON content_artifacts (task_id);

CREATE OR REPLACE FUNCTION set_updated_at_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_registry_updated_at
BEFORE UPDATE ON agent_registry
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

CREATE TRIGGER trg_contacts_updated_at
BEFORE UPDATE ON communication_contacts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

CREATE TRIGGER trg_call_sessions_updated_at
BEFORE UPDATE ON call_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

CREATE TRIGGER trg_message_deliveries_updated_at
BEFORE UPDATE ON message_deliveries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

CREATE TRIGGER trg_email_deliveries_updated_at
BEFORE UPDATE ON email_deliveries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

CREATE TRIGGER trg_content_artifacts_updated_at
BEFORE UPDATE ON content_artifacts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

COMMIT;

