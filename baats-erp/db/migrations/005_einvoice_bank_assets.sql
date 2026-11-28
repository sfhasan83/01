-- =============================================================================
-- Phase 2 finance, continued from BAATS Accounting: UAE e-invoicing (PINT AE),
-- bank statement import and reconciliation, fixed assets and depreciation.
-- =============================================================================

-- Seller details an e-invoice needs (PINT AE ibr-143/150/172/192).
ALTER TABLE fin.companies
  ADD COLUMN street text, ADD COLUMN city text,
  ADD COLUMN emirate text CHECK (emirate IN ('AUH','DXB','SHJ','UAQ','FUJ','AJM','RAK')),
  ADD COLUMN email text, ADD COLUMN phone text, ADD COLUMN iban text,
  ADD COLUMN trade_licence_no text, ADD COLUMN licence_authority text;

-- ---------------------------------------------------------------------------
-- E-invoices: the PINT AE XML generated from a posted sales document
-- ---------------------------------------------------------------------------
CREATE TABLE fin.einvoices (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  uuid uuid NOT NULL DEFAULT gen_random_uuid(),     -- BTAE-07, stays the same for the document
  profile text NOT NULL,                             -- profile id and version used
  xml text NOT NULL,
  xml_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','submitted','accepted','rejected')),
  asp_reference text,                                -- reference given by the accredited service provider
  asp_message text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, invoice_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id)
);
CREATE FUNCTION fin.einvoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoices are kept; they cannot be deleted'; END IF;
  IF NEW.xml <> OLD.xml OR NEW.uuid <> OLD.uuid OR NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'an issued e-invoice cannot change; issue a credit note';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER einvoices_guard BEFORE UPDATE OR DELETE ON fin.einvoices FOR EACH ROW EXECUTE FUNCTION fin.einvoices_guard();

-- ---------------------------------------------------------------------------
-- Bank statements and reconciliation
-- ---------------------------------------------------------------------------
ALTER TABLE fin.journal_lines ADD CONSTRAINT journal_lines_tenant_id_uq UNIQUE (tenant_id, id);

CREATE TABLE fin.bank_statements (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  account_id uuid NOT NULL,                          -- the bank ledger account
  file_name text,
  date_from date NOT NULL,
  date_to date NOT NULL,
  closing_balance numeric(20,2),
  imported_by uuid,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES fin.accounts(tenant_id, id)
);

CREATE TABLE fin.bank_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL,
  line_no int NOT NULL,
  date date NOT NULL,
  description text NOT NULL,
  reference text,
  amount numeric(20,2) NOT NULL CHECK (amount <> 0),  -- + money in, - money out
  fingerprint text NOT NULL,                          -- date|amount|description|reference, to skip re-imports
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched')),
  journal_line_id uuid,                               -- the ledger line it reconciles with
  matched_by uuid,
  matched_at timestamptz,
  UNIQUE (tenant_id, id), UNIQUE (statement_id, line_no),
  CHECK ((status = 'matched') = (journal_line_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, statement_id) REFERENCES fin.bank_statements(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_line_id) REFERENCES fin.journal_lines(tenant_id, id)
);
-- A ledger line reconciles with one statement line at most.
CREATE UNIQUE INDEX bank_lines_journal_uq ON fin.bank_lines (tenant_id, journal_line_id) WHERE journal_line_id IS NOT NULL;
CREATE INDEX ON fin.bank_lines (tenant_id, fingerprint);

-- ---------------------------------------------------------------------------
-- Fixed assets (BAATS 1500 / 1590 / 5800)
-- ---------------------------------------------------------------------------
CREATE TABLE fin.assets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  unit_id uuid,                                       -- cost center charged with depreciation
  acquisition_date date NOT NULL,
  depreciation_start date NOT NULL,
  cost numeric(20,2) NOT NULL CHECK (cost > 0),
  residual_value numeric(20,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months int NOT NULL CHECK (useful_life_months > 0),
  opening_accumulated numeric(20,2) NOT NULL DEFAULT 0 CHECK (opening_accumulated >= 0),
  source_invoice_line_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')),
  disposal_date date,
  disposal_proceeds numeric(20,2),
  disposal_journal_id uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  CHECK (residual_value < cost),
  CHECK (opening_accumulated <= cost - residual_value),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, disposal_journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE UNIQUE INDEX assets_source_uq ON fin.assets (tenant_id, source_invoice_line_id) WHERE source_invoice_line_id IS NOT NULL;

CREATE TABLE fin.asset_depreciation (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL,
  period char(7) NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  journal_id uuid NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (asset_id, period),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fin.assets(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE TRIGGER depreciation_append_only BEFORE UPDATE OR DELETE ON fin.asset_depreciation FOR EACH ROW EXECUTE FUNCTION app.append_only();

ALTER TABLE fin.journals DROP CONSTRAINT journals_type_check;
ALTER TABLE fin.journals ADD CONSTRAINT journals_type_check CHECK (type IN ('manual','opening','sales_invoice','sales_credit',
  'purchase_invoice','purchase_credit','receipt','payment','write_off','vat_return','tax_provision','closing','reversal',
  'inventory','goods_receipt','delivery','payroll','payroll_payment','gratuity','bank','depreciation','asset_disposal'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin.einvoices','fin.bank_statements','fin.bank_lines','fin.assets','fin.asset_depreciation']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fin.einvoices','fin.bank_statements','fin.bank_lines','fin.assets']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fin TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('fin.einvoice.manage','fin','Issue PINT AE e-invoices and record the service provider''s response'),
  ('fin.bank.reconcile','fin','Import bank statements, reconcile them and post bank charges'),
  ('fin.asset.manage','fin','Register fixed assets, run depreciation and record disposals');
