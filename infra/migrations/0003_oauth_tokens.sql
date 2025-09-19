-- 0003_oauth_tokens.sql
-- Adds OAuth token storage for Google integrations (Gmail + Calendar)

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    scope_group TEXT NOT NULL, -- 'gmail', 'calendar', 'combined'
    user_identifier TEXT NOT NULL DEFAULT 'default', -- for future multi-user support
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    scopes TEXT[], -- actual granted scopes
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, scope_group, user_identifier)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens (provider, scope_group);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);

CREATE TRIGGER trg_oauth_tokens_updated_at
BEFORE UPDATE ON oauth_tokens
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

COMMIT;