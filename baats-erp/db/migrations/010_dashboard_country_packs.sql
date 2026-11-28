-- =============================================================================
-- BAATS Enterprise ERP, Phase 6a: the interactive dashboard and the country-pack
-- layer, with Saudi Arabia as the second pack after the UAE.
--   * each user's own dashboard layout per company
--   * Saudi seller and buyer address fields for ZATCA e-invoices
--   * tax exemption reasons on tax codes (ZATCA VATEX codes)
--   * the ZATCA invoice counter and hash chain on issued e-invoices
--   * employee nationality, end-of-service reason, social insurance contributions
-- =============================================================================

-- Personal dashboard layouts ----------------------------------------------------------
CREATE TABLE bi.dashboard_layouts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  layout jsonb NOT NULL,                              -- {tiles: [kpi codes], period, compare, from, to}
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, company_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id)
);
ALTER TABLE bi.dashboard_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.dashboard_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bi.dashboard_layouts USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON bi.dashboard_layouts TO baats_app;

-- Company address fields used outside the UAE (Saudi national address) ----------------
ALTER TABLE fin.companies
  ADD COLUMN building_no text,                        -- Saudi national address: 4-digit building number
  ADD COLUMN district text,
  ADD COLUMN postal_code text;

-- Exemption reasons on tax codes (ZATCA requires one on zero-rated, exempt and out-of-scope lines)
ALTER TABLE fin.tax_codes
  ADD COLUMN exemption_reason_code text,
  ADD COLUMN exemption_reason text;

-- Which return form a filed VAT return used
ALTER TABLE fin.vat_returns ADD COLUMN form text NOT NULL DEFAULT 'AE-VAT201';

-- ZATCA: invoice counter value (ICV), this invoice's hash and the previous one's (PIH), the QR code
ALTER TABLE fin.einvoices
  ADD COLUMN counter int,
  ADD COLUMN invoice_hash text,
  ADD COLUMN previous_hash text,
  ADD COLUMN qr text,
  ADD COLUMN invoice_type text CHECK (invoice_type IN ('standard','simplified'));
CREATE UNIQUE INDEX einvoices_counter_uq ON fin.einvoices (tenant_id, company_id, counter) WHERE counter IS NOT NULL;

CREATE OR REPLACE FUNCTION fin.einvoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoices are kept; they cannot be deleted'; END IF;
  IF NEW.xml <> OLD.xml OR NEW.uuid <> OLD.uuid OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.counter IS DISTINCT FROM OLD.counter OR NEW.invoice_hash IS DISTINCT FROM OLD.invoice_hash
     OR NEW.previous_hash IS DISTINCT FROM OLD.previous_hash OR NEW.qr IS DISTINCT FROM OLD.qr THEN
    RAISE EXCEPTION 'an issued e-invoice cannot change; issue a credit note';
  END IF;
  RETURN NEW;
END $$;

-- People: nationality decides social insurance; the end reason decides end-of-service pay
ALTER TABLE org.employees ADD COLUMN nationality char(2) REFERENCES ref.countries(code);
ALTER TABLE hr.contracts ADD COLUMN end_reason text
  CHECK (end_reason IN ('contract_end','termination','resignation','retirement','death','mutual'));

-- Social insurance contributions (Saudi GOSI first). Rates are kept per company so
-- that a change in the law is a data change, not a code change.
CREATE TABLE hr.contribution_rules (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  applies_to text NOT NULL CHECK (applies_to IN ('nationals','non_nationals','all')),
  employee_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (employee_pct >= 0 AND employee_pct <= 100),
  employer_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (employer_pct >= 0 AND employer_pct <= 100),
  base text NOT NULL DEFAULT 'basic_housing' CHECK (base IN ('basic','basic_housing','gross')),
  monthly_cap numeric(20,2) CHECK (monthly_cap > 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id)
);
ALTER TABLE hr.contribution_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.contribution_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr.contribution_rules USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant());
CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON hr.contribution_rules FOR EACH ROW EXECUTE FUNCTION audit.capture();
GRANT SELECT, INSERT, UPDATE, DELETE ON hr.contribution_rules TO baats_app;

ALTER TABLE hr.payslips
  ADD COLUMN employee_contributions numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN employer_contributions numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN contributions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE hr.payroll_runs
  ADD COLUMN employee_contributions_total numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN employer_contributions_total numeric(20,2) NOT NULL DEFAULT 0;
