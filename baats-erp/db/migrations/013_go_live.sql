-- =============================================================================
-- BAATS Enterprise ERP, Phase 7a: getting ready to go live.
--   * a record of every data import (what, from which file, by whom)
--   * where each session signed in from, so users can see and end their sessions
--   * permissions for importing data and for backups
-- =============================================================================

CREATE SCHEMA mig;

CREATE TABLE mig.import_runs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customers','suppliers','items','employees','open_invoices','open_bills','opening_balances')),
  file_name text,
  sha256 text NOT NULL,                    -- fingerprint of the file as imported
  as_of date NOT NULL,                     -- the cut-over date
  rows int NOT NULL,
  created int NOT NULL,
  skipped int NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]',
  journal_no text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id)
);
CREATE INDEX import_runs_company ON mig.import_runs (tenant_id, company_id, created_at DESC);

ALTER TABLE mig.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mig.import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mig.import_runs USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant());
CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON mig.import_runs FOR EACH ROW EXECUTE FUNCTION audit.capture();

GRANT USAGE ON SCHEMA mig TO baats_app;
GRANT SELECT, INSERT ON mig.import_runs TO baats_app;

ALTER TABLE iam.sessions ADD COLUMN ip text, ADD COLUMN user_agent text;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('mig.import','mig','Import customers, suppliers, items, employees and opening balances into a company'),
  ('sys.backup','sys','Make and restore backups of the whole BAATS installation');
