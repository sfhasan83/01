-- =============================================================================
-- BAATS Enterprise ERP, Phase 3: projects, manufacturing (BOM, routing, work
-- orders, MRP), maintenance and fleet. Like Phase 2, every module posts through
-- the one ledger: project time and costs, production, spare parts and fuel all
-- land in the same books, and projects are a ledger dimension of their own.
-- =============================================================================

CREATE SCHEMA prj;
CREATE SCHEMA mfg;
CREATE SCHEMA mnt;
CREATE SCHEMA flt;

ALTER TABLE fin.journals DROP CONSTRAINT journals_type_check;
ALTER TABLE fin.journals ADD CONSTRAINT journals_type_check CHECK (type IN ('manual','opening','sales_invoice','sales_credit',
  'purchase_invoice','purchase_credit','receipt','payment','write_off','vat_return','tax_provision','closing','reversal',
  'inventory','goods_receipt','delivery','payroll','payroll_payment','gratuity','bank','depreciation','asset_disposal',
  'timesheet','production','maintenance','fuel'));

ALTER TABLE inv.moves DROP CONSTRAINT moves_kind_check;
ALTER TABLE inv.moves ADD CONSTRAINT moves_kind_check CHECK (kind IN ('opening','receipt','delivery','adjustment','transfer_in',
  'transfer_out','production_issue','production_receipt','maintenance_issue'));

-- Reorder points per warehouse, used by MRP.
CREATE TABLE inv.reorder_rules (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  min_qty numeric(20,4) NOT NULL CHECK (min_qty >= 0),
  reorder_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, warehouse_id, item_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TABLE prj.projects (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  customer_id uuid,
  unit_id uuid,                                      -- cost center the project's costs are reported under
  manager_employee_id uuid,
  billing text NOT NULL DEFAULT 'time_material' CHECK (billing IN ('time_material','fixed_price','non_billable')),
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  contract_value numeric(20,2) NOT NULL DEFAULT 0 CHECK (contract_value >= 0),
  budget_cost numeric(20,2) NOT NULL DEFAULT 0 CHECK (budget_cost >= 0),
  budget_hours numeric(20,2) NOT NULL DEFAULT 0 CHECK (budget_hours >= 0),
  default_bill_rate numeric(20,2) NOT NULL DEFAULT 0 CHECK (default_bill_rate >= 0),
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','closed')),
  created_by uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (billing = 'non_billable' OR customer_id IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, manager_employee_id) REFERENCES org.employees(tenant_id, id)
);

-- Projects are a ledger and document dimension, next to cost centers.
ALTER TABLE fin.journal_lines ADD COLUMN project_id uuid,
  ADD CONSTRAINT journal_lines_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id);
CREATE INDEX ON fin.journal_lines (tenant_id, project_id) WHERE project_id IS NOT NULL;
ALTER TABLE fin.invoice_lines ADD COLUMN project_id uuid,
  ADD CONSTRAINT invoice_lines_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id);

CREATE TABLE prj.members (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  project_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  role text,
  bill_rate numeric(20,2),                            -- per hour; the project's default when empty
  PRIMARY KEY (tenant_id, project_id, employee_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE prj.milestones (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reached')),
  reached_date date,
  invoice_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id) ON DELETE SET NULL (invoice_id)
);

CREATE TABLE prj.timesheets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  date date NOT NULL,
  hours numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description text NOT NULL,
  billable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  cost_rate numeric(20,4),                           -- fixed at approval from the employee's contract
  cost numeric(20,2),
  bill_rate numeric(20,2),
  journal_id uuid,
  invoice_id uuid,
  entered_by uuid,
  approved_by uuid,
  UNIQUE (tenant_id, id),
  CHECK (status <> 'approved' OR (journal_id IS NOT NULL AND cost IS NOT NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES fin.invoices(tenant_id, id) ON DELETE SET NULL (invoice_id)
);
CREATE INDEX ON prj.timesheets (tenant_id, project_id, status);

-- ---------------------------------------------------------------------------
-- Manufacturing: work centers, bills of materials with routing, work orders
-- ---------------------------------------------------------------------------
CREATE TABLE mfg.work_centers (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  unit_id uuid,
  hourly_rate numeric(20,2) NOT NULL CHECK (hourly_rate >= 0),   -- labour and overhead absorbed per hour
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);

CREATE TABLE mfg.boms (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  item_id uuid NOT NULL,                              -- what the BOM makes
  code text NOT NULL,
  output_qty numeric(20,4) NOT NULL DEFAULT 1 CHECK (output_qty > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','obsolete')),
  notes text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);
-- One active BOM per product and company.
CREATE UNIQUE INDEX boms_active_uq ON mfg.boms (tenant_id, company_id, item_id) WHERE status = 'active';

CREATE TABLE mfg.bom_lines (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL,
  line_no int NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),         -- per output_qty of the product
  scrap_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),
  UNIQUE (tenant_id, id), UNIQUE (bom_id, line_no),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES mfg.boms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);

CREATE TABLE mfg.bom_operations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL,
  seq int NOT NULL,
  name text NOT NULL,
  work_center_id uuid NOT NULL,
  setup_minutes numeric(10,2) NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  run_minutes numeric(10,4) NOT NULL DEFAULT 0 CHECK (run_minutes >= 0),   -- per unit of product
  UNIQUE (tenant_id, id), UNIQUE (bom_id, seq),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES mfg.boms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES mfg.work_centers(tenant_id, id)
);

CREATE TABLE mfg.work_orders (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text NOT NULL,
  bom_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  warehouse_id uuid NOT NULL,                         -- components come from and products go to
  due_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','completed','cancelled')),
  completed_qty numeric(20,4),
  completed_date date,
  material_cost numeric(20,2) NOT NULL DEFAULT 0,
  conversion_cost numeric(20,2) NOT NULL DEFAULT 0,
  sales_order_id uuid,
  created_by uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES mfg.boms(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_order_id) REFERENCES sal.orders(tenant_id, id)
);

-- Materials and operations are copied from the BOM when the order is released.
CREATE TABLE mfg.wo_materials (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  required_qty numeric(20,4) NOT NULL CHECK (required_qty > 0),
  issued_qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
  issued_value numeric(20,2) NOT NULL DEFAULT 0 CHECK (issued_value >= 0),
  UNIQUE (tenant_id, id), UNIQUE (work_order_id, item_id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id)
);

CREATE TABLE mfg.wo_operations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  seq int NOT NULL,
  name text NOT NULL,
  work_center_id uuid NOT NULL,
  planned_minutes numeric(12,2) NOT NULL,
  actual_minutes numeric(12,2),
  hourly_rate numeric(20,2) NOT NULL,
  cost numeric(20,2),
  UNIQUE (tenant_id, id), UNIQUE (work_order_id, seq),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES mfg.work_centers(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------------
CREATE TABLE flt.vehicles (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  plate_no text NOT NULL,
  make text, model text, year int,
  fuel_type text NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('petrol','diesel','electric','hybrid')),
  asset_id uuid,                                      -- the fixed asset it is booked as
  unit_id uuid,                                       -- cost center its running costs go to
  driver_employee_id uuid,
  odometer numeric(12,1) NOT NULL DEFAULT 0 CHECK (odometer >= 0),
  registration_expiry date,
  insurance_expiry date,
  insurance_policy text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','disposed')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code), UNIQUE (tenant_id, plate_no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fin.assets(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, driver_employee_id) REFERENCES org.employees(tenant_id, id)
);
CREATE UNIQUE INDEX vehicles_asset_uq ON flt.vehicles (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE flt.fuel_logs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL,
  date date NOT NULL,
  odometer numeric(12,1) NOT NULL,
  litres numeric(10,2) NOT NULL CHECK (litres > 0),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),   -- paid, VAT included
  vat_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  station text,
  journal_id uuid NOT NULL,
  created_by uuid,
  UNIQUE (tenant_id, id),
  CHECK (vat_amount < amount),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES flt.vehicles(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE TRIGGER fuel_append_only BEFORE UPDATE OR DELETE ON flt.fuel_logs FOR EACH ROW EXECUTE FUNCTION app.append_only();

CREATE TABLE flt.trips (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL,
  driver_employee_id uuid,
  date date NOT NULL,
  start_km numeric(12,1) NOT NULL,
  end_km numeric(12,1) NOT NULL,
  purpose text NOT NULL,
  project_id uuid,
  created_by uuid,
  UNIQUE (tenant_id, id),
  CHECK (end_km > start_km),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES flt.vehicles(tenant_id, id),
  FOREIGN KEY (tenant_id, driver_employee_id) REFERENCES org.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES prj.projects(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Maintenance: preventive plans by date or distance, work orders, spare parts
-- ---------------------------------------------------------------------------
CREATE TABLE mnt.plans (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  asset_id uuid,
  vehicle_id uuid,
  name text NOT NULL,
  interval_days int CHECK (interval_days > 0),
  interval_km numeric(12,1) CHECK (interval_km > 0),
  last_done_date date,
  last_done_km numeric(12,1),
  next_due_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  UNIQUE (tenant_id, id),
  CHECK ((asset_id IS NOT NULL) <> (vehicle_id IS NOT NULL)),
  CHECK (interval_days IS NOT NULL OR interval_km IS NOT NULL),
  CHECK (interval_km IS NULL OR vehicle_id IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fin.assets(tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES flt.vehicles(tenant_id, id)
);

CREATE TABLE mnt.work_orders (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text NOT NULL,
  asset_id uuid,
  vehicle_id uuid,
  plan_id uuid,
  kind text NOT NULL CHECK (kind IN ('preventive','corrective','breakdown')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  description text NOT NULL,
  unit_id uuid,                                       -- cost center charged with parts
  scheduled_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  completed_date date,
  odometer numeric(12,1),
  downtime_hours numeric(10,2) CHECK (downtime_hours >= 0),
  parts_cost numeric(20,2) NOT NULL DEFAULT 0,
  resolution text,
  created_by uuid,
  completed_by uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, no),
  CHECK ((asset_id IS NOT NULL) <> (vehicle_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fin.assets(tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES flt.vehicles(tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES mnt.plans(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);
-- A plan has one open work order at a time.
CREATE UNIQUE INDEX mnt_wo_plan_open_uq ON mnt.work_orders (tenant_id, plan_id) WHERE plan_id IS NOT NULL AND status IN ('open','in_progress');

CREATE TABLE mnt.wo_parts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  cost numeric(20,2) NOT NULL CHECK (cost >= 0),
  date date NOT NULL,
  journal_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mnt.work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES fin.journals(tenant_id, id)
);
CREATE TRIGGER wo_parts_append_only BEFORE UPDATE OR DELETE ON mnt.wo_parts FOR EACH ROW EXECUTE FUNCTION app.append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv.reorder_rules','prj.projects','prj.members','prj.milestones','prj.timesheets',
    'mfg.work_centers','mfg.boms','mfg.bom_lines','mfg.bom_operations','mfg.work_orders','mfg.wo_materials','mfg.wo_operations',
    'flt.vehicles','flt.fuel_logs','flt.trips','mnt.plans','mnt.work_orders','mnt.wo_parts']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inv.reorder_rules','prj.projects','prj.members','prj.milestones','prj.timesheets',
    'mfg.work_centers','mfg.boms','mfg.work_orders','flt.vehicles','flt.fuel_logs','flt.trips','mnt.plans','mnt.work_orders','mnt.wo_parts']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA prj, mfg, mnt, flt TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA prj, mfg, mnt, flt, inv TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('prj.manage','prj','Set up projects, teams, budgets and milestones, and invoice projects'),
  ('prj.time.approve','prj','Approve or reject timesheets, which posts their cost to the project'),
  ('mfg.manage','mfg','Maintain work centers and bills of materials, and plan with MRP'),
  ('mfg.produce','mfg','Create, release and complete work orders, issuing materials'),
  ('mnt.manage','mnt','Maintenance plans and work orders, including spare parts issues'),
  ('flt.manage','flt','Vehicles, fuel, trips and fleet compliance');
