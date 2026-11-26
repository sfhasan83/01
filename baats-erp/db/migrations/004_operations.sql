-- =============================================================================
-- BAATS Enterprise ERP, Phase 2 operations: inventory, procurement, sales and
-- CRM, HR and payroll. Every module posts through the fin ledger, so stock,
-- purchases, sales and payroll land in the same books with no re-keying.
-- =============================================================================

CREATE SCHEMA inv;
CREATE SCHEMA pur;
CREATE SCHEMA sal;
CREATE SCHEMA crm;
CREATE SCHEMA hr;

-- New journal types posted by the operational modules.
ALTER TABLE fin.journals DROP CONSTRAINT journals_type_check;
ALTER TABLE fin.journals ADD CONSTRAINT journals_type_check CHECK (type IN ('manual','opening','sales_invoice','sales_credit',
  'purchase_invoice','purchase_credit','receipt','payment','write_off','vat_return','tax_provision','closing','reversal',
  'inventory','goods_receipt','delivery','payroll','payroll_payment','gratuity'));

-- Documents created by other modules point back to where they came from.
ALTER TABLE fin.invoices ADD COLUMN source_type text, ADD COLUMN source_id uuid;
ALTER TABLE fin.invoice_lines ADD COLUMN source_line_id uuid;
CREATE INDEX ON fin.invoice_lines (tenant_id, source_line_id) WHERE source_line_id IS NOT NULL;

-- Immutable ledgers (stock moves, payslips once posted...) share one guard.
CREATE FUNCTION app.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a correcting entry instead', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- Inventory: warehouses, perpetual stock at moving average cost
-- ---------------------------------------------------------------------------
CREATE TABLE inv.warehouses (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  unit_id uuid,                                  -- branch or site it belongs to
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

CREATE TABLE inv.stock (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  value numeric(20,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (tenant_id, warehouse_id, item_id),
  CHECK (qty > 0 OR value = 0),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);

CREATE TABLE inv.moves (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening','receipt','delivery','adjustment','transfer_in','transfer_out')),
  qty numeric(20,4) NOT NULL CHECK (qty <> 0),   -- positive in, negative out
  value numeric(20,2) NOT NULL,                  -- base currency, same sign as qty
  source_type text,
  source_id uuid,
  journal_id uuid,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE INDEX ON inv.moves (tenant_id, item_id, date);
CREATE TRIGGER moves_append_only BEFORE UPDATE OR DELETE ON inv.moves FOR EACH ROW EXECUTE FUNCTION app.append_only();

-- ---------------------------------------------------------------------------
-- Procurement: purchase orders (approved by workflow), goods receipts, bills
-- ---------------------------------------------------------------------------
CREATE TABLE pur.orders (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text,
  supplier_id uuid NOT NULL,
  date date NOT NULL,
  expected_date date,
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fx_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  warehouse_id uuid,
  requesting_unit_id uuid,                        -- the department that asked for it
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','rejected','closed','cancelled')),
  net_total numeric(20,2) NOT NULL DEFAULT 0,
  tax_total numeric(20,2) NOT NULL DEFAULT 0,
  gross_total numeric(20,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, requesting_unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE UNIQUE INDEX pur_orders_no_uq ON pur.orders (tenant_id, company_id, no) WHERE no IS NOT NULL;

CREATE TABLE pur.order_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  line_no int NOT NULL,
  item_id uuid,
  description text NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  tax_code text NOT NULL,
  account text,                                   -- expense account for non-stock lines
  unit_id uuid,
  net_amount numeric(20,2) NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pur.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

CREATE FUNCTION pur.order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM pur.orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'order lines can only change while the order is a draft'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON pur.order_lines FOR EACH ROW EXECUTE FUNCTION pur.order_lines_guard();

CREATE TABLE pur.receipts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  no text NOT NULL,
  date date NOT NULL,
  warehouse_id uuid,
  journal_id uuid,
  delivery_note text,
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pur.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE TABLE pur.receipt_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  value numeric(20,2) NOT NULL,                   -- base currency, stock lines only
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES pur.receipts(tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES pur.order_lines(tenant_id, id)
);
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON pur.receipt_lines FOR EACH ROW EXECUTE FUNCTION app.append_only();

-- ---------------------------------------------------------------------------
-- CRM: leads, opportunities, activities
-- ---------------------------------------------------------------------------
CREATE TABLE crm.leads (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_unit_id uuid NOT NULL,
  owner_user_id uuid,
  name text NOT NULL,
  company_name text,
  email text,
  phone text,
  country_code char(2) REFERENCES ref.countries(code),
  source text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','disqualified','converted')),
  party_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id)
);

CREATE TABLE crm.opportunities (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_unit_id uuid NOT NULL,
  owner_user_id uuid,
  lead_id uuid,
  party_id uuid,
  title text NOT NULL,
  stage text NOT NULL DEFAULT 'prospecting'
    CHECK (stage IN ('prospecting','qualification','proposal','negotiation','won','lost')),
  amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  probability int NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  expected_close date,
  lost_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (lead_id IS NOT NULL OR party_id IS NOT NULL),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES crm.leads(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id)
);

CREATE TABLE crm.activities (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('lead','opportunity','party')),
  entity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('call','meeting','email','task','note')),
  subject text NOT NULL,
  due_at timestamptz,
  done_at timestamptz,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id)
);
CREATE INDEX ON crm.activities (tenant_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Sales: quotations and orders, deliveries, invoicing
-- ---------------------------------------------------------------------------
CREATE TABLE sal.orders (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  quote_no text,
  no text,
  customer_id uuid NOT NULL,
  opportunity_id uuid,
  date date NOT NULL,
  valid_until date,
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  fx_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  warehouse_id uuid,
  selling_unit_id uuid,                            -- profit center
  status text NOT NULL DEFAULT 'quotation'
    CHECK (status IN ('quotation','confirmed','closed','cancelled')),
  net_total numeric(20,2) NOT NULL DEFAULT 0,
  tax_total numeric(20,2) NOT NULL DEFAULT 0,
  gross_total numeric(20,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm.opportunities(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, selling_unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE UNIQUE INDEX sal_orders_no_uq ON sal.orders (tenant_id, company_id, no) WHERE no IS NOT NULL;
CREATE UNIQUE INDEX sal_orders_quote_uq ON sal.orders (tenant_id, company_id, quote_no) WHERE quote_no IS NOT NULL;

CREATE TABLE sal.order_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  line_no int NOT NULL,
  item_id uuid,
  description text NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount numeric(20,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_code text NOT NULL,
  account text,
  net_amount numeric(20,2) NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sal.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);

CREATE FUNCTION sal.order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM sal.orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
  IF s IS NOT NULL AND s <> 'quotation' THEN RAISE EXCEPTION 'order lines can only change while it is a quotation'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON sal.order_lines FOR EACH ROW EXECUTE FUNCTION sal.order_lines_guard();

CREATE TABLE sal.deliveries (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  order_id uuid NOT NULL,
  no text NOT NULL,
  date date NOT NULL,
  warehouse_id uuid,
  journal_id uuid,
  created_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sal.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE TABLE sal.delivery_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  cost numeric(20,2) NOT NULL,                    -- base currency, at moving average
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES sal.deliveries(tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sal.order_lines(tenant_id, id)
);
CREATE TRIGGER delivery_append_only BEFORE UPDATE OR DELETE ON sal.delivery_lines FOR EACH ROW EXECUTE FUNCTION app.append_only();

-- ---------------------------------------------------------------------------
-- HR: contracts, leave, payroll (UAE WPS), end-of-service gratuity
-- ---------------------------------------------------------------------------
CREATE TABLE hr.contracts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  company_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date,
  contract_type text NOT NULL DEFAULT 'unlimited' CHECK (contract_type IN ('limited','unlimited')),
  basic numeric(20,2) NOT NULL CHECK (basic > 0),
  housing numeric(20,2) NOT NULL DEFAULT 0 CHECK (housing >= 0),
  transport numeric(20,2) NOT NULL DEFAULT 0 CHECK (transport >= 0),
  other_allowances numeric(20,2) NOT NULL DEFAULT 0 CHECK (other_allowances >= 0),
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  annual_leave_days int NOT NULL DEFAULT 30 CHECK (annual_leave_days >= 0),
  wps_person_id text,                              -- MOHRE personal number (14 digits)
  bank_routing_code text,                          -- 9-digit agent / bank routing code
  iban text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  UNIQUE (tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id)
);
CREATE UNIQUE INDEX contracts_active_uq ON hr.contracts (tenant_id, employee_id) WHERE status = 'active';

CREATE TABLE hr.leave_requests (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  leave_type text NOT NULL CHECK (leave_type IN ('annual','sick','unpaid','maternity','parental','compassionate','hajj')),
  date_from date NOT NULL,
  date_to date NOT NULL,
  days numeric(6,1) NOT NULL CHECK (days > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','cancelled')),
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (date_to >= date_from),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE hr.payroll_runs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  period char(7) NOT NULL,                         -- YYYY-MM
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','paid')),
  gross_total numeric(20,2) NOT NULL DEFAULT 0,
  deductions_total numeric(20,2) NOT NULL DEFAULT 0,
  net_total numeric(20,2) NOT NULL DEFAULT 0,
  gratuity_change numeric(20,2) NOT NULL DEFAULT 0,
  journal_id uuid,
  gratuity_journal_id uuid,
  payment_journal_id uuid,
  created_by uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, period),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id),
  FOREIGN KEY (tenant_id, gratuity_journal_id) REFERENCES fin.journals(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_journal_id) REFERENCES fin.journals(tenant_id, id)
);

CREATE TABLE hr.payslips (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  unit_id uuid NOT NULL,                            -- cost center charged
  days_in_period int NOT NULL,
  paid_days numeric(6,1) NOT NULL,
  unpaid_leave_days numeric(6,1) NOT NULL DEFAULT 0,
  basic numeric(20,2) NOT NULL,
  allowances numeric(20,2) NOT NULL,
  additions numeric(20,2) NOT NULL DEFAULT 0,       -- overtime, bonus (variable pay)
  deductions numeric(20,2) NOT NULL DEFAULT 0,      -- advance recovery and other deductions
  gross numeric(20,2) NOT NULL,
  net numeric(20,2) NOT NULL,
  gratuity_balance numeric(20,2) NOT NULL,          -- accrued end-of-service benefit at period end
  UNIQUE (tenant_id, id), UNIQUE (run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES hr.payroll_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES hr.contracts(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

CREATE FUNCTION hr.payslips_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM hr.payroll_runs WHERE id = coalesce(NEW.run_id, OLD.run_id);
  IF s IS NOT NULL AND s <> 'draft' THEN RAISE EXCEPTION 'payslips of a posted payroll cannot change'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON hr.payslips FOR EACH ROW EXECUTE FUNCTION hr.payslips_guard();

-- ---------------------------------------------------------------------------
-- Security, audit and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv.warehouses','inv.stock','inv.moves','pur.orders','pur.order_lines','pur.receipts','pur.receipt_lines',
    'crm.leads','crm.opportunities','crm.activities','sal.orders','sal.order_lines','sal.deliveries','sal.delivery_lines',
    'hr.contracts','hr.leave_requests','hr.payroll_runs','hr.payslips']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inv.warehouses','inv.moves','pur.orders','pur.receipts','crm.leads','crm.opportunities',
    'sal.orders','sal.deliveries','hr.contracts','hr.leave_requests','hr.payroll_runs']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA inv, pur, sal, crm, hr TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inv, pur, sal, crm, hr TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('inv.manage','inv','Set up warehouses, record opening stock, adjustments and transfers'),
  ('inv.read','inv','See stock levels, movements and valuation'),
  ('pur.order.manage','pur','Prepare purchase orders and submit them for approval'),
  ('pur.order.approve','pur','Approve purchase orders (approval limits apply)'),
  ('pur.receive','pur','Record goods and services received against purchase orders'),
  ('crm.manage','crm','Manage leads, opportunities and sales activities'),
  ('sal.order.manage','sal','Prepare quotations and confirm sales orders'),
  ('sal.deliver','sal','Deliver goods against sales orders'),
  ('hr.manage','hr','Manage employment contracts, and record leave for employees'),
  ('hr.payroll.run','hr','Prepare, post and pay payroll, and produce WPS files');
