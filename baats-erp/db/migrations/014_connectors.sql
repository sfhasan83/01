-- =============================================================================
-- Phase 6d: connectors. Bank statement files (MT940, CAMT.053) and supplier
-- payment files (ISO 20022 pain.001); sign-in with Microsoft 365, Google or any
-- OpenID Connect provider; email through the company's own mail service; card
-- payment links on invoices (Stripe).
-- =============================================================================

-- The bank behind each bank account in the ledger: statement files are matched to
-- the account by IBAN or account number, and payment files are drawn on it.
CREATE TABLE fin.bank_details (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  account_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  bank_name text NOT NULL,
  iban text,
  bic text CHECK (bic IS NULL OR bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  account_no text,
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES fin.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id)
);
CREATE UNIQUE INDEX bank_details_iban_uq ON fin.bank_details (tenant_id, iban) WHERE iban IS NOT NULL;

ALTER TABLE fin.bank_statements ADD COLUMN format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','mt940','camt053')),
  ADD COLUMN opening_balance numeric(20,3), ADD COLUMN statement_ref text;

-- A supplier payment file: payments already posted, sent to the bank once.
CREATE TABLE fin.payment_files (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  no text NOT NULL,
  message_id text NOT NULL,
  execution_date date NOT NULL,
  payments int NOT NULL CHECK (payments > 0),
  total numeric(20,3) NOT NULL,
  currency char(3) NOT NULL,
  xml text NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','sent','cancelled')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES fin.accounts(tenant_id, id)
);
CREATE TABLE fin.payment_file_items (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  file_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  end_to_end_id text NOT NULL,
  creditor_name text NOT NULL,
  creditor_iban text NOT NULL,
  creditor_bic text,
  amount numeric(20,3) NOT NULL,
  PRIMARY KEY (file_id, payment_id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES fin.payment_files(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES fin.payments(tenant_id, id)
);
-- A payment can be in one live file only; a cancelled file frees its payments.
ALTER TABLE fin.payment_file_items ADD COLUMN live boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX payment_file_items_once ON fin.payment_file_items (tenant_id, payment_id) WHERE live;

-- Sign-in with another identity provider. Users are matched by their email; nobody is
-- created by signing in.
CREATE TABLE iam.sso_providers (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('microsoft','google','oidc')),
  name text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE iam.sso_secrets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  provider_id uuid PRIMARY KEY,
  sealed text NOT NULL,
  FOREIGN KEY (tenant_id, provider_id) REFERENCES iam.sso_providers(tenant_id, id) ON DELETE CASCADE
);
-- A sign-in on its way through the provider: the state, nonce and PKCE verifier, for ten minutes.
CREATE TABLE iam.sso_attempts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  state_hash text PRIMARY KEY,
  provider_id uuid NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  redirect_uri text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, provider_id) REFERENCES iam.sso_providers(tenant_id, id) ON DELETE CASCADE
);
-- The provider a session came from (null: password).
ALTER TABLE iam.sessions ADD COLUMN sso_provider_id uuid;

-- Email: one mail service per tenant, and an outbox sent in the background.
CREATE TABLE int.mail_settings (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(id),
  transport text NOT NULL CHECK (transport IN ('smtp','microsoft365')),
  host text, port int, security text CHECK (security IN ('starttls','tls','none')),
  username text,
  ms_tenant text, ms_client_id text,
  from_address text NOT NULL,
  from_name text NOT NULL,
  reply_to text,
  notify_approvals boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE int.mail_secrets (
  tenant_id uuid PRIMARY KEY REFERENCES int.mail_settings(tenant_id) ON DELETE CASCADE,
  sealed text NOT NULL
);
CREATE TABLE int.mails (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  entity_type text, entity_id uuid,
  to_addresses text[] NOT NULL CHECK (cardinality(to_addresses) BETWEEN 1 AND 20),
  cc_addresses text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  attachments jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX mails_due ON int.mails (tenant_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX mails_entity ON int.mails (tenant_id, entity_type, entity_id);

-- Card payments: a gateway account per company, and a payment link per invoice.
CREATE TABLE int.payment_gateways (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  company_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('stripe')),
  clearing_account_id uuid NOT NULL,
  live boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, clearing_account_id) REFERENCES fin.accounts(tenant_id, id)
);
CREATE TABLE int.payment_gateway_secrets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  company_id uuid PRIMARY KEY,
  sealed_key text NOT NULL,
  sealed_webhook text,
  FOREIGN KEY (tenant_id, company_id) REFERENCES int.payment_gateways(tenant_id, company_id) ON DELETE CASCADE
);
CREATE TABLE fin.payment_links (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  url text NOT NULL,
  amount numeric(20,3) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  payment_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (provider, provider_ref),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES fin.payments(tenant_id, id)
);
CREATE UNIQUE INDEX payment_links_open_once ON fin.payment_links (tenant_id, invoice_id) WHERE status = 'open';

-- A gateway's notice reaches BAATS without a tenant: this finds the tenant of a link.
CREATE FUNCTION fin.payment_link_tenant(p_provider text, p_ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
  $$ SELECT tenant_id FROM fin.payment_links WHERE provider = p_provider AND provider_ref = p_ref $$;
REVOKE ALL ON FUNCTION fin.payment_link_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin.payment_link_tenant(text, text) TO baats_app;
-- Open links across tenants, for the background check that confirms payments.
CREATE FUNCTION fin.open_payment_link_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
  $$ SELECT DISTINCT tenant_id FROM fin.payment_links WHERE status = 'open' $$;
REVOKE ALL ON FUNCTION fin.open_payment_link_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin.open_payment_link_tenants() TO baats_app;
-- Tenants with mail waiting.
CREATE FUNCTION int.pending_mail_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
  $$ SELECT DISTINCT tenant_id FROM int.mails WHERE status = 'pending' AND next_attempt_at <= now() $$;
REVOKE ALL ON FUNCTION int.pending_mail_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION int.pending_mail_tenants() TO baats_app;

-- Security --------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin.bank_details','fin.payment_files','fin.payment_file_items','iam.sso_providers','iam.sso_secrets',
                           'iam.sso_attempts','int.mail_settings','int.mail_secrets','int.mails','int.payment_gateways',
                           'int.payment_gateway_secrets','fin.payment_links']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  -- Settings and documents are audited; sealed secrets, sign-ins in progress and the mail
  -- outbox are not (secrets must not be copied; the outbox is a log in its own right).
  FOREACH t IN ARRAY ARRAY['fin.bank_details','fin.payment_files','fin.payment_file_items','iam.sso_providers',
                           'int.mail_settings','int.payment_gateways','fin.payment_links']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON fin.bank_details, fin.payment_files, fin.payment_file_items, fin.payment_links,
  iam.sso_providers, iam.sso_secrets, iam.sso_attempts TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA int TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('fin.payment.file','fin','Make supplier payment files for the bank and mark them sent'),
  ('fin.payment.link','fin','Make card payment links for invoices and set up the card payment gateway'),
  ('iam.sso.manage','iam','Set up sign-in with Microsoft 365, Google or another identity provider'),
  ('int.mail.manage','int','Set up the mail service and see the mail sent'),
  ('int.mail.send','int','Send documents by email');
