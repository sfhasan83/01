-- =============================================================================
-- BAATS Enterprise ERP, Phase 6c: the mobile app and integrations.
--   * expense claims: an employee's claim with receipts, approved by the line
--     manager, posted to the ledger and paid from the bank
--   * API keys for other systems, acting as a named user with that user's roles
--   * webhooks: business events written in the same transaction as the change
--     (an outbox), delivered signed to the subscriber, retried with backoff
-- =============================================================================

-- Expense claims -----------------------------------------------------------------------
CREATE TABLE hr.expense_claims (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  no text,                                            -- EC-2026-00001 once submitted
  title text NOT NULL,
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','paid')),
  net_total numeric(20,3) NOT NULL DEFAULT 0,
  tax_total numeric(20,3) NOT NULL DEFAULT 0,
  gross_total numeric(20,3) NOT NULL DEFAULT 0,
  journal_id uuid,
  payment_journal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id)
);
CREATE INDEX expense_claims_employee ON hr.expense_claims (tenant_id, employee_id, created_at DESC);

CREATE TABLE hr.expense_receipts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 750000),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES hr.expense_claims(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE hr.expense_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  line_no int NOT NULL,
  date date NOT NULL,
  category text NOT NULL,
  account_id uuid NOT NULL,
  description text NOT NULL,
  gross_amount numeric(20,3) NOT NULL CHECK (gross_amount > 0),   -- what the employee paid, VAT included
  tax_code_id uuid NOT NULL,
  tax_amount numeric(20,3) NOT NULL DEFAULT 0,
  net_amount numeric(20,3) NOT NULL,
  receipt_id uuid,
  UNIQUE (tenant_id, id), UNIQUE (claim_id, line_no),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES hr.expense_claims(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES hr.expense_receipts(tenant_id, id)
);

-- Expense journals carry input VAT like a purchase invoice.
ALTER TABLE fin.journals DROP CONSTRAINT journals_type_check;
ALTER TABLE fin.journals ADD CONSTRAINT journals_type_check CHECK (type IN ('manual','opening','sales_invoice','sales_credit',
  'purchase_invoice','purchase_credit','receipt','payment','write_off','vat_return','tax_provision','closing','reversal',
  'inventory','goods_receipt','delivery','payroll','payroll_payment','gratuity','bank','depreciation','asset_disposal',
  'timesheet','production','maintenance','fuel','expense_claim','expense_payment'));

-- API keys ------------------------------------------------------------------------------
CREATE TABLE iam.api_keys (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  user_id uuid NOT NULL,                              -- the key acts as this user, with that user's roles
  prefix text NOT NULL,                               -- shown so people can tell keys apart
  key_hash text NOT NULL UNIQUE,                      -- sha256 of the whole key; the key itself is shown once
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id)
);

-- Webhooks ------------------------------------------------------------------------------
CREATE SCHEMA int;

CREATE TABLE int.webhooks (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- The signing secret is kept apart, sealed with the server key, and never audited.
CREATE TABLE int.webhook_secrets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  webhook_id uuid PRIMARY KEY,
  sealed text NOT NULL,
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES int.webhooks(tenant_id, id) ON DELETE CASCADE
);

-- Events are written in the transaction that made the change, so an event exists
-- exactly when the change was committed.
CREATE TABLE int.events (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  company_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX events_recent ON int.events (tenant_id, created_at DESC);

CREATE TABLE int.deliveries (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (webhook_id, event_id),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES int.webhooks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id) REFERENCES int.events(tenant_id, id)
);
CREATE INDEX deliveries_due ON int.deliveries (tenant_id, next_attempt_at) WHERE status = 'pending';

-- Security --------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr.expense_claims','hr.expense_lines','hr.expense_receipts','iam.api_keys',
                           'int.webhooks','int.webhook_secrets','int.events','int.deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  -- Claims, their lines, keys (hashes only) and webhook settings are audited. Receipt
  -- images, sealed secrets, the event outbox and delivery attempts are not: the
  -- first two must not be copied, the last two are logs in their own right.
  FOREACH t IN ARRAY ARRAY['hr.expense_claims','hr.expense_lines','iam.api_keys','int.webhooks']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON hr.expense_claims, hr.expense_lines, hr.expense_receipts, iam.api_keys TO baats_app;
GRANT USAGE ON SCHEMA int TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA int TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('hr.expense.manage','hr','See every expense claim in the company and pay approved claims'),
  ('int.manage','int','Create and revoke API keys and manage webhooks');
