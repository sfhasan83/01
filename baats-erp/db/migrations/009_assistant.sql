-- =============================================================================
-- BAATS Enterprise ERP, Phase 5b: the AI assistant. A tenant chooses a model
-- provider (Claude by default, or any OpenAI-compatible service, including a
-- local model). Users chat with the assistant about one company at a time. The
-- assistant reads through the same services as the screens, so it sees only what
-- the user may see, and every change it proposes waits for the user to confirm.
-- =============================================================================

CREATE SCHEMA ai;

-- One row per tenant. The API key is kept apart (ai.provider_keys) so that it
-- never reaches the audit trail, even encrypted.
CREATE TABLE ai.settings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL DEFAULT 'anthropic' CHECK (provider IN ('anthropic','openai_compatible')),
  model text NOT NULL DEFAULT 'claude-opus-5-5',
  effort text DEFAULT 'medium' CHECK (effort IN ('low','medium','high','xhigh','max')),  -- Claude only; null for models without effort
  base_url text,                                      -- required for openai_compatible
  monthly_token_limit bigint CHECK (monthly_token_limit > 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE ai.provider_keys (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(id),
  key_enc text NOT NULL,                              -- AES-256-GCM, base64 of iv|tag|ciphertext
  key_hint text NOT NULL,                             -- last four characters, for display
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai.conversations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  title text NOT NULL,
  busy_until timestamptz,                             -- set while the assistant is answering
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id)
);
CREATE INDEX conversations_user ON ai.conversations (tenant_id, user_id, updated_at DESC);

-- The transcript in a provider-neutral form. An assistant turn also keeps the
-- provider's own content (native) so that it can be replayed to the same
-- provider exactly as it was returned.
CREATE TABLE ai.messages (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  seq int NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  blocks jsonb NOT NULL,
  native jsonb,
  provider text,
  model text,
  stop text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id), UNIQUE (conversation_id, seq),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai.conversations(tenant_id, id) ON DELETE CASCADE
);

-- Every tool the assistant called. Reads run at once; changes wait as
-- 'pending' until the user confirms or rejects them.
CREATE TABLE ai.tool_calls (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,                           -- the assistant turn that asked for it
  ord int NOT NULL,
  tool_use_id text NOT NULL,
  tool text NOT NULL,
  input jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read','change')),
  status text NOT NULL CHECK (status IN ('pending','done','failed','rejected')),
  result jsonb,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id), UNIQUE (message_id, ord),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai.conversations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES ai.messages(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (result IS NULL))
);
CREATE INDEX tool_calls_pending ON ai.tool_calls (tenant_id, conversation_id) WHERE status = 'pending';

-- Tokens used per tenant and month, for the optional monthly limit.
CREATE TABLE ai.usage (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  requests int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai.settings','ai.provider_keys','ai.conversations','ai.messages','ai.tool_calls','ai.usage']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  -- Settings and tool calls (what the assistant read and every change a user
  -- confirmed or rejected) are audited row by row. The transcript is its own
  -- record, usage is a counter, and keys must never be copied anywhere.
  FOREACH t IN ARRAY ARRAY['ai.settings','ai.tool_calls']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA ai TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('ai.assistant.use','ai','Chat with the AI assistant (it can only read and change what the user may)'),
  ('ai.assistant.manage','ai','Choose the AI provider and model, set the API key and the monthly limit');
