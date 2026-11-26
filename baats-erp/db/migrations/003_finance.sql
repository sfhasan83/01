-- BAATS Enterprise ERP: Phase 2 accounting engine and finance (schema fin)
--
-- The financial foundation carries over BAATS Accounting (UAE edition, v10.86): its chart of
-- accounts and account codes, its posting rules (invoice, receipt, bill, payment, credit note,
-- write-off), VAT on the balance sheet (1200 input, 2100 output, 2110 FTA settlement), and the
-- UAE corporate tax provision (9% above AED 375,000). What changes is the architecture:
-- BAATS Accounting derives its ledger in the browser from documents; here every posting is a
-- persisted, immutable, balanced journal validated by the database.

CREATE SCHEMA IF NOT EXISTS fin;

-- ---------------------------------------------------------------------------
-- Companies: a legal-entity org unit that keeps its own books
-- ---------------------------------------------------------------------------
CREATE TABLE fin.companies (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  unit_id uuid PRIMARY KEY,
  legal_name text NOT NULL,
  country_code char(2) NOT NULL REFERENCES ref.countries(code),
  base_currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  tax_registration_no text,                          -- UAE TRN
  vat_period text NOT NULL DEFAULT 'quarterly' CHECK (vat_period IN ('monthly','quarterly')),
  vat_quarter_start_month smallint NOT NULL DEFAULT 1 CHECK (vat_quarter_start_month BETWEEN 1 AND 3),
  corporate_tax_rate numeric(6,3) NOT NULL DEFAULT 9,
  corporate_tax_threshold numeric(20,2) NOT NULL DEFAULT 375000,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, unit_id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Chart of accounts (per company), BAATS codes and structure
-- ---------------------------------------------------------------------------
CREATE TABLE fin.accounts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  parent_id uuid,
  is_group boolean NOT NULL DEFAULT false,      -- headings (1, 11, 12 ...) cannot be posted to
  control text CHECK (control IN ('receivable','payable')),  -- needs a party on every line
  system_role text,                              -- what the engine looks the account up by
  allow_manual boolean NOT NULL DEFAULT true,    -- control and tax accounts are posted by documents only
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES fin.accounts(tenant_id, id)
);
CREATE UNIQUE INDEX accounts_role_uq ON fin.accounts (tenant_id, company_id, system_role) WHERE system_role IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fiscal periods (one per calendar month per company)
-- ---------------------------------------------------------------------------
CREATE TABLE fin.periods (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  company_id uuid NOT NULL,
  period date NOT NULL CHECK (extract(day FROM period) = 1),   -- first day of the month
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at timestamptz,
  closed_by uuid,
  PRIMARY KEY (tenant_id, company_id, period),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id)
);

-- ---------------------------------------------------------------------------
-- Tax codes (UAE VAT categories as in BAATS / PINT AE: S, Z, E, O, reverse charge)
-- ---------------------------------------------------------------------------
CREATE TABLE fin.tax_codes (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code char(2) NOT NULL REFERENCES ref.countries(code),
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('standard','zero','exempt','out_of_scope','reverse_charge')),
  rate numeric(6,3) NOT NULL CHECK (rate >= 0),
  einvoice_category char(2),                -- PINT AE / UNCL5305: S, Z, E, O, AE
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, country_code, code)
);

-- ---------------------------------------------------------------------------
-- Document numbering, gap-free per company, type and year
-- ---------------------------------------------------------------------------
CREATE TABLE fin.sequences (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  company_id uuid NOT NULL,
  doc_type text NOT NULL,
  year int NOT NULL,
  next_no int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, company_id, doc_type, year)
);

-- ---------------------------------------------------------------------------
-- Journals: the only way anything reaches the ledger
-- ---------------------------------------------------------------------------
CREATE TABLE fin.journals (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text,                                          -- assigned when posted
  type text NOT NULL CHECK (type IN ('manual','opening','sales_invoice','sales_credit','purchase_invoice',
    'purchase_credit','receipt','payment','write_off','vat_return','tax_provision','closing','reversal')),
  date date NOT NULL,
  memo text NOT NULL,
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fx_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),   -- base currency per 1 unit of currency
  source_type text,
  source_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','posted','rejected')),
  reversal_of uuid,
  reversed_by uuid,
  created_by uuid,
  posted_at timestamptz,
  posted_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, reversal_of) REFERENCES fin.journals(tenant_id, id),
  FOREIGN KEY (tenant_id, reversed_by) REFERENCES fin.journals(tenant_id, id)
);
CREATE UNIQUE INDEX journals_no_uq ON fin.journals (tenant_id, company_id, no) WHERE no IS NOT NULL;
CREATE UNIQUE INDEX journals_source_uq ON fin.journals (tenant_id, source_type, source_id, type)
  WHERE source_id IS NOT NULL AND status = 'posted';
CREATE INDEX ON fin.journals (tenant_id, company_id, date);

CREATE TABLE fin.journal_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL,
  line_no int NOT NULL,
  account_id uuid NOT NULL,
  debit numeric(20,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),      -- base currency
  credit numeric(20,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  txn_amount numeric(20,2) NOT NULL DEFAULT 0,                    -- signed, journal currency (+ debit)
  party_id uuid,
  unit_id uuid,                                                   -- cost or profit center dimension
  tax_code_id uuid,
  tax_base numeric(20,2),                                         -- net amount the tax line is on (base ccy)
  description text,
  CHECK ((debit > 0) <> (credit > 0)),
  UNIQUE (journal_id, line_no),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES fin.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES fin.tax_codes(tenant_id, id)
);
CREATE INDEX ON fin.journal_lines (tenant_id, account_id);
CREATE INDEX ON fin.journal_lines (tenant_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX ON fin.journal_lines (tenant_id, journal_id);

-- Posting rules, enforced by the database whatever the caller:
-- balanced, at least two lines, open period, postable active accounts of the same company,
-- party on control-account lines, and posted journals are immutable.
CREATE FUNCTION fin.validate_posting(j fin.journals) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  dr numeric; cr numeric; n int; bad text;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO dr, cr, n
    FROM fin.journal_lines WHERE journal_id = j.id;
  IF n < 2 THEN RAISE EXCEPTION 'journal needs at least two lines'; END IF;
  IF dr <> cr THEN RAISE EXCEPTION 'journal is not balanced: debits % credits %', dr, cr; END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.periods WHERE tenant_id = j.tenant_id AND company_id = j.company_id
                   AND period = date_trunc('month', j.date)::date AND status = 'open') THEN
    RAISE EXCEPTION 'period % is not open for posting', to_char(j.date, 'YYYY-MM');
  END IF;
  SELECT a.code INTO bad FROM fin.journal_lines l JOIN fin.accounts a ON a.id = l.account_id
   WHERE l.journal_id = j.id AND (a.company_id <> j.company_id OR a.is_group OR a.status <> 'active') LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'account % cannot be posted to by this company', bad; END IF;
  SELECT a.code INTO bad FROM fin.journal_lines l JOIN fin.accounts a ON a.id = l.account_id
   WHERE l.journal_id = j.id AND a.control IS NOT NULL AND l.party_id IS NULL LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'control account % needs a customer or supplier on the line', bad; END IF;
  IF j.type = 'manual' THEN
    SELECT a.code INTO bad FROM fin.journal_lines l JOIN fin.accounts a ON a.id = l.account_id
     WHERE l.journal_id = j.id AND NOT a.allow_manual LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'account % is posted by documents only, not by manual journals', bad; END IF;
  END IF;
END $$;

CREATE FUNCTION fin.journals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted journals cannot be deleted; reverse them'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    -- The only change allowed after posting is linking the reversing journal.
    IF (to_jsonb(NEW) - 'reversed_by') <> (to_jsonb(OLD) - 'reversed_by') OR OLD.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'posted journals are immutable; reverse them instead';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'posted' THEN
    PERFORM fin.validate_posting(NEW);
    NEW.posted_at := coalesce(NEW.posted_at, now());
    NEW.posted_by := coalesce(NEW.posted_by, app.actor());
  END IF;
  RETURN NEW;
END $$;
-- AFTER-insert lines exist only once the header is updated, so posting is an UPDATE of status.
CREATE TRIGGER journals_guard BEFORE UPDATE OR DELETE ON fin.journals FOR EACH ROW EXECUTE FUNCTION fin.journals_guard();
CREATE FUNCTION fin.journals_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'posted' THEN RAISE EXCEPTION 'insert journals as draft, add lines, then post'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journals_insert_guard BEFORE INSERT ON fin.journals FOR EACH ROW EXECUTE FUNCTION fin.journals_insert_guard();

CREATE FUNCTION fin.lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM fin.journals WHERE id = coalesce(NEW.journal_id, OLD.journal_id);
  IF s = 'posted' THEN RAISE EXCEPTION 'lines of a posted journal cannot change'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER lines_guard BEFORE INSERT OR UPDATE OR DELETE ON fin.journal_lines FOR EACH ROW EXECUTE FUNCTION fin.lines_guard();

-- ---------------------------------------------------------------------------
-- Sales and purchase documents (AR and AP subledgers)
-- ---------------------------------------------------------------------------
CREATE TABLE fin.invoices (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sales_invoice','sales_credit','purchase_invoice','purchase_credit')),
  no text,                                   -- our number, assigned on posting
  supplier_ref text,                          -- the supplier's own invoice number (purchases)
  party_id uuid NOT NULL,
  date date NOT NULL,
  due_date date,
  tax_date date,                              -- VAT period the document belongs to (defaults to date)
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fx_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  credit_of uuid,                             -- credit note: the original invoice
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  net_total numeric(20,2) NOT NULL DEFAULT 0,  -- document currency
  tax_total numeric(20,2) NOT NULL DEFAULT 0,
  gross_total numeric(20,2) NOT NULL DEFAULT 0,
  journal_id uuid,
  notes text,
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, credit_of) REFERENCES fin.invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE UNIQUE INDEX invoices_no_uq ON fin.invoices (tenant_id, company_id, kind, no) WHERE no IS NOT NULL;
CREATE UNIQUE INDEX invoices_supplier_ref_uq ON fin.invoices (tenant_id, company_id, party_id, supplier_ref)
  WHERE supplier_ref IS NOT NULL AND kind = 'purchase_invoice' AND status <> 'void';
CREATE INDEX ON fin.invoices (tenant_id, party_id);

CREATE TABLE fin.invoice_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  line_no int NOT NULL,
  item_id uuid,
  description text NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount numeric(20,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  account_id uuid NOT NULL,                  -- revenue (sales) or expense/asset (purchases)
  tax_code_id uuid NOT NULL,
  unit_id uuid,                              -- cost / profit center
  net_amount numeric(20,2) NOT NULL,
  tax_amount numeric(20,2) NOT NULL,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES fin.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES fin.tax_codes(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

CREATE FUNCTION fin.invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM fin.invoices WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id);
  IF s <> 'draft' THEN RAISE EXCEPTION 'lines can only change while the document is a draft'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON fin.invoice_lines FOR EACH ROW EXECUTE FUNCTION fin.invoice_lines_guard();

CREATE FUNCTION fin.invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft documents can be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND
     (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'posted documents are immutable; issue a credit note';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'void' THEN RAISE EXCEPTION 'void documents are immutable'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON fin.invoices FOR EACH ROW EXECUTE FUNCTION fin.invoices_guard();

-- Receipts from customers and payments to suppliers, allocated to documents.
CREATE TABLE fin.payments (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','payment')),
  no text,
  party_id uuid NOT NULL,
  date date NOT NULL,
  bank_account_id uuid NOT NULL,             -- cash or bank ledger account
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fx_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  reference text,
  journal_id uuid,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES fin.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE UNIQUE INDEX payments_no_uq ON fin.payments (tenant_id, company_id, kind, no) WHERE no IS NOT NULL;

CREATE TABLE fin.allocations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid,                          -- a payment settling a document, or
  credit_id uuid,                           -- a credit note settling a document
  invoice_id uuid NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),   -- document currency
  date date NOT NULL,
  CHECK ((payment_id IS NULL) <> (credit_id IS NULL)),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES fin.payments(tenant_id, id),
  FOREIGN KEY (tenant_id, credit_id) REFERENCES fin.invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id)
);
CREATE INDEX ON fin.allocations (tenant_id, invoice_id);
CREATE INDEX ON fin.allocations (tenant_id, payment_id);

-- VAT returns filed (BAATS: VAT return periods and reconciliation)
CREATE TABLE fin.vat_returns (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  output_tax numeric(20,2) NOT NULL,
  input_tax numeric(20,2) NOT NULL,
  net_payable numeric(20,2) NOT NULL,
  boxes jsonb NOT NULL,
  journal_id uuid NOT NULL,
  filed_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, period_from),
  CHECK (period_to >= period_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Security, audit and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin.companies','fin.accounts','fin.periods','fin.tax_codes','fin.sequences','fin.journals',
    'fin.journal_lines','fin.invoices','fin.invoice_lines','fin.payments','fin.allocations','fin.vat_returns']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  -- Journal lines are audited through their journal header and the lines' own immutability.
  FOREACH t IN ARRAY ARRAY['fin.companies','fin.accounts','fin.periods','fin.tax_codes','fin.journals',
    'fin.invoices','fin.payments','fin.allocations','fin.vat_returns']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA fin TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fin TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('fin.company.manage','fin','Set up a company''s books, chart of accounts and tax settings'),
  ('fin.account.manage','fin','Add and change ledger accounts'),
  ('fin.period.manage','fin','Open and close accounting periods and run year-end close'),
  ('fin.journal.create','fin','Prepare manual journals and submit them for approval'),
  ('fin.journal.approve','fin','Approve manual journals (approval limits apply)'),
  ('fin.journal.reverse','fin','Reverse posted journals'),
  ('fin.invoice.manage','fin','Prepare sales and purchase invoices and credit notes'),
  ('fin.invoice.post','fin','Post invoices and credit notes to the ledger'),
  ('fin.payment.post','fin','Record receipts and payments'),
  ('fin.tax.manage','fin','Record VAT returns and the corporate tax provision'),
  ('fin.report.read','fin','Read financial statements, ledgers and ageing');
