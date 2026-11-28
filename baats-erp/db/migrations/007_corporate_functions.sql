-- =============================================================================
-- BAATS Enterprise ERP, Phase 4: corporate functions. Document management,
-- legal and contracts, governance, risk and compliance with internal audit,
-- IT and facilities service desk, quality, health and safety, and facilities.
-- Actions raised anywhere (audit findings, non-conformances, incidents, failed
-- control tests) share one tracked action list with maker-checker verification.
-- =============================================================================

CREATE SCHEMA dms;
CREATE SCHEMA lgl;
CREATE SCHEMA grc;
CREATE SCHEMA svc;
CREATE SCHEMA qms;
CREATE SCHEMA hse;
CREATE SCHEMA fac;

-- ---------------------------------------------------------------------------
-- Documents: versioned files attachable to any record, with retention
-- ---------------------------------------------------------------------------
CREATE TABLE dms.documents (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid,                                       -- who owns it; access follows the org tree
  title text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  entity_type text,                                   -- record it is attached to, e.g. lgl.contract
  entity_id uuid,
  confidential boolean NOT NULL DEFAULT false,
  retain_until date,
  current_version int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE INDEX ON dms.documents (tenant_id, entity_type, entity_id);

CREATE TABLE dms.versions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version int NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes int NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  note text,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (document_id, version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES dms.documents(tenant_id, id)
);
CREATE TRIGGER versions_append_only BEFORE UPDATE OR DELETE ON dms.versions FOR EACH ROW EXECUTE FUNCTION app.append_only();

-- ---------------------------------------------------------------------------
-- Legal: contracts with approval, obligations and renewal tracking
-- ---------------------------------------------------------------------------
CREATE TABLE lgl.contracts (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sales','purchase','nda','lease','employment','service','other')),
  party_id uuid,
  owner_employee_id uuid,
  value numeric(20,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  start_date date NOT NULL,
  end_date date,
  auto_renew boolean NOT NULL DEFAULT false,
  renewal_months int CHECK (renewal_months > 0),
  notice_days int NOT NULL DEFAULT 30 CHECK (notice_days >= 0),
  governing_law text NOT NULL DEFAULT 'UAE',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','rejected','expired','terminated')),
  terminated_on date,
  termination_reason text,
  created_by uuid,
  UNIQUE (tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (NOT auto_renew OR (end_date IS NOT NULL AND renewal_months IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);
CREATE UNIQUE INDEX contracts_no_uq ON lgl.contracts (tenant_id, company_id, no) WHERE no IS NOT NULL;

CREATE TABLE lgl.obligations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  description text NOT NULL,
  due_date date NOT NULL,
  responsible_employee_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','waived')),
  done_on date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES lgl.contracts(tenant_id, id),
  FOREIGN KEY (tenant_id, responsible_employee_id) REFERENCES org.employees(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Governance, risk, compliance and internal audit
-- ---------------------------------------------------------------------------
CREATE TABLE grc.risks (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('strategic','operational','financial','compliance','technology','hse','reputational')),
  likelihood int NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact int NOT NULL CHECK (impact BETWEEN 1 AND 5),
  owner_employee_id uuid,
  treatment text NOT NULL DEFAULT 'mitigate' CHECK (treatment IN ('mitigate','accept','transfer','avoid')),
  appetite int NOT NULL DEFAULT 9 CHECK (appetite BETWEEN 1 AND 25),     -- highest acceptable residual score
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE grc.controls (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'preventive' CHECK (kind IN ('preventive','detective','corrective')),
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('continuous','daily','weekly','monthly','quarterly','annual')),
  owner_employee_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, risk_id) REFERENCES grc.risks(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE grc.control_tests (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id uuid NOT NULL,
  engagement_id uuid,
  tested_on date NOT NULL,
  result text NOT NULL CHECK (result IN ('effective','ineffective')),
  sample_size int,
  exceptions int NOT NULL DEFAULT 0 CHECK (exceptions >= 0),
  notes text,
  tested_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, control_id) REFERENCES grc.controls(tenant_id, id)
);
CREATE TRIGGER control_tests_append_only BEFORE UPDATE OR DELETE ON grc.control_tests FOR EACH ROW EXECUTE FUNCTION app.append_only();

CREATE TABLE grc.obligations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  regulation text NOT NULL,                            -- e.g. UAE Federal Decree-Law 47/2022 (Corporate Tax)
  requirement text NOT NULL,
  frequency text NOT NULL DEFAULT 'annual' CHECK (frequency IN ('once','monthly','quarterly','annual')),
  next_due date NOT NULL,
  owner_employee_id uuid,
  last_done date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE grc.engagements (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,                               -- audited unit
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal','external','regulatory')),
  period_from date, period_to date,
  lead_user_id uuid,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','fieldwork','reporting','closed')),
  opinion text CHECK (opinion IN ('satisfactory','needs_improvement','unsatisfactory')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);
ALTER TABLE grc.control_tests ADD FOREIGN KEY (tenant_id, engagement_id) REFERENCES grc.engagements(tenant_id, id);

CREATE TABLE grc.findings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL,
  control_test_id uuid,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  condition text NOT NULL,                             -- what was found
  recommendation text NOT NULL,
  management_response text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES grc.engagements(tenant_id, id),
  FOREIGN KEY (tenant_id, control_test_id) REFERENCES grc.control_tests(tenant_id, id)
);

-- Corrective and preventive actions, whatever raised them.
CREATE TABLE grc.actions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('grc.finding','qms.ncr','hse.incident','grc.risk')),
  source_id uuid NOT NULL,
  unit_id uuid,
  title text NOT NULL,
  owner_employee_id uuid NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','verified')),
  completion_note text,
  done_by uuid, done_on date,
  verified_by uuid, verified_on date,
  created_by uuid,
  UNIQUE (tenant_id, id),
  CHECK (verified_by IS NULL OR verified_by IS DISTINCT FROM done_by),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);
CREATE INDEX ON grc.actions (tenant_id, source_type, source_id);

-- ---------------------------------------------------------------------------
-- Service desk (IT and facilities requests) with SLA clocks
-- ---------------------------------------------------------------------------
CREATE TABLE svc.tickets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no text NOT NULL,
  queue text NOT NULL CHECK (queue IN ('it','facilities','hr','finance')),
  category text NOT NULL,
  priority int NOT NULL CHECK (priority BETWEEN 1 AND 4),   -- 1 critical .. 4 low
  title text NOT NULL,
  description text NOT NULL,
  requester_user_id uuid NOT NULL,
  unit_id uuid,
  asset_id uuid,                                      -- fixed asset concerned (laptop, printer, room AC...)
  space_id uuid,
  assignee_user_id uuid,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','in_progress','waiting','resolved','closed')),
  response_due timestamptz NOT NULL,
  resolution_due timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  satisfaction int CHECK (satisfaction BETWEEN 1 AND 5),
  maintenance_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, no),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fin.assets(tenant_id, id),
  FOREIGN KEY (tenant_id, maintenance_order_id) REFERENCES mnt.work_orders(tenant_id, id)
);

CREATE TABLE svc.comments (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES svc.tickets(tenant_id, id)
);
CREATE TRIGGER comments_append_only BEFORE UPDATE OR DELETE ON svc.comments FOR EACH ROW EXECUTE FUNCTION app.append_only();

-- ---------------------------------------------------------------------------
-- Quality: inspections of receipts and production, non-conformances
-- ---------------------------------------------------------------------------
CREATE TABLE qms.inspections (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('pur.receipt','mfg.work_order','inv.stock')),
  source_id uuid,
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  supplier_id uuid,
  inspected_on date NOT NULL,
  qty_inspected numeric(20,4) NOT NULL CHECK (qty_inspected > 0),
  qty_rejected numeric(20,4) NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  result text NOT NULL CHECK (result IN ('pass','fail')),
  notes text,
  inspector_user_id uuid,
  UNIQUE (tenant_id, id),
  CHECK (qty_rejected <= qty_inspected),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES mdm.parties(tenant_id, id)
);

CREATE TABLE qms.ncrs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  no text NOT NULL,
  inspection_id uuid,
  item_id uuid,
  warehouse_id uuid,
  supplier_id uuid,
  qty numeric(20,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  severity text NOT NULL CHECK (severity IN ('minor','major','critical')),
  description text NOT NULL,
  root_cause text,
  disposition text CHECK (disposition IN ('use_as_is','rework','return_to_supplier','scrap')),
  disposition_journal_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dispositioned','closed')),
  raised_by uuid,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, no),
  FOREIGN KEY (tenant_id, company_id) REFERENCES fin.companies(tenant_id, unit_id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES qms.inspections(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES mdm.items(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES inv.warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES mdm.parties(tenant_id, id),
  FOREIGN KEY (tenant_id, disposition_journal_id) REFERENCES fin.journals(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Health, safety and environment
-- ---------------------------------------------------------------------------
CREATE TABLE hse.incidents (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no text NOT NULL,
  unit_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('injury','near_miss','property_damage','environmental','fire','vehicle')),
  severity text NOT NULL CHECK (severity IN ('minor','moderate','serious','major','fatal')),
  location text NOT NULL,
  description text NOT NULL,
  employee_id uuid,                                   -- person hurt, if any
  vehicle_id uuid,
  lost_days int NOT NULL DEFAULT 0 CHECK (lost_days >= 0),
  root_cause text,
  reported_by uuid,
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','investigating','closed')),
  closed_on date,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, no),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES flt.vehicles(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Facilities: spaces and bookings
-- ---------------------------------------------------------------------------
CREATE TABLE fac.spaces (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,                              -- site or branch
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('meeting_room','desk','office','parking','warehouse','other')),
  capacity int NOT NULL DEFAULT 1 CHECK (capacity > 0),
  bookable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);
ALTER TABLE svc.tickets ADD FOREIGN KEY (tenant_id, space_id) REFERENCES fac.spaces(tenant_id, id);

CREATE TABLE fac.bookings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL,
  booked_by uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  purpose text NOT NULL,
  attendees int NOT NULL DEFAULT 1 CHECK (attendees > 0),
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, space_id) REFERENCES fac.spaces(tenant_id, id)
);
CREATE INDEX ON fac.bookings (tenant_id, space_id, starts_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dms.documents','dms.versions','lgl.contracts','lgl.obligations','grc.risks','grc.controls','grc.control_tests',
    'grc.obligations','grc.engagements','grc.findings','grc.actions','svc.tickets','svc.comments','qms.inspections','qms.ncrs',
    'hse.incidents','fac.spaces','fac.bookings']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
  -- File contents stay out of the audit trail; the version row's hash is recorded instead by dms.documents changes.
  FOREACH t IN ARRAY ARRAY['dms.documents','lgl.contracts','lgl.obligations','grc.risks','grc.controls','grc.control_tests',
    'grc.obligations','grc.engagements','grc.findings','grc.actions','svc.tickets','qms.inspections','qms.ncrs',
    'hse.incidents','fac.spaces','fac.bookings']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA dms, lgl, grc, svc, qms, hse, fac TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA dms, lgl, grc, svc, qms, hse, fac TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('dms.read','dms','Read documents filed under a unit'),
  ('dms.manage','dms','File, version and archive documents'),
  ('dms.confidential','dms','Read documents marked confidential'),
  ('lgl.contract.manage','lgl','Draft contracts, track obligations and renewals'),
  ('lgl.contract.approve','lgl','Approve contracts (with value limits)'),
  ('grc.manage','grc','Maintain the risk register, controls and compliance obligations'),
  ('grc.audit','grc','Run audit engagements, test controls and raise findings'),
  ('grc.action.verify','grc','Verify that corrective actions were done (not your own)'),
  ('svc.agent','svc','Work service desk tickets in a queue'),
  ('qms.manage','qms','Inspect goods, raise and disposition non-conformances'),
  ('hse.manage','hse','Investigate and close incidents, see safety statistics'),
  ('fac.manage','fac','Maintain spaces and manage all bookings');
