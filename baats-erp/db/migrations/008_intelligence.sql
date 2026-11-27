-- =============================================================================
-- BAATS Enterprise ERP, Phase 5: intelligence. Saved reports over a governed
-- dataset catalogue, strategy scorecards with KPI targets, ESG readings and
-- emission factors, and reviews of anomaly findings. KPIs themselves are
-- computed live from the ledger and the modules, so nothing here duplicates
-- transactional data.
-- =============================================================================

CREATE SCHEMA bi;

-- Saved report definitions: a dataset from the catalogue plus a validated spec
-- (columns, grouping, measures, filters, sort). Running a report always checks
-- the dataset's permission and filters rows to the units the user may see.
CREATE TABLE bi.reports (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  dataset text NOT NULL,
  spec jsonb NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  owner_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES iam.users(tenant_id, id)
);

-- Strategy: objectives per company in balanced scorecard perspectives, each
-- measured by KPI targets for a year.
CREATE TABLE bi.objectives (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  perspective text NOT NULL CHECK (perspective IN ('financial','customer','process','people','sustainability')),
  owner_employee_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_employee_id) REFERENCES org.employees(tenant_id, id)
);

CREATE TABLE bi.targets (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id uuid NOT NULL,
  kpi_code text NOT NULL,
  year int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  target numeric(20,4) NOT NULL,
  tolerance_pct numeric(6,2) NOT NULL DEFAULT 10 CHECK (tolerance_pct >= 0 AND tolerance_pct <= 100),  -- amber band
  UNIQUE (tenant_id, id), UNIQUE (objective_id, kpi_code, year),
  FOREIGN KEY (tenant_id, objective_id) REFERENCES bi.objectives(tenant_id, id) ON DELETE CASCADE
);

-- ESG: monthly readings that are not in the books (meters, waste tickets) and
-- emission factors a company can override.
CREATE TABLE bi.esg_readings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  unit_id uuid,                                      -- site, if known
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  metric text NOT NULL CHECK (metric IN ('electricity_kwh','water_m3','waste_kg','recycled_kg','lpg_kg','refrigerant_kg','solar_kwh')),
  value numeric(20,3) NOT NULL CHECK (value >= 0),
  note text,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE UNIQUE INDEX esg_readings_uq ON bi.esg_readings (tenant_id, company_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), month, metric);

CREATE TABLE bi.esg_factors (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  key text NOT NULL,                                 -- e.g. diesel_kg_per_l, grid_kg_per_kwh
  value numeric(20,6) NOT NULL CHECK (value >= 0),
  source text,
  PRIMARY KEY (tenant_id, company_id, key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id)
);

-- Anomaly findings are computed on demand; a reviewer's conclusion is kept
-- against the finding's stable key so it is not raised again as new.
CREATE TABLE bi.anomaly_reviews (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  rule text NOT NULL,
  finding_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('explained','confirmed')),
  note text NOT NULL,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, company_id, rule, finding_key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES org.units(tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bi.reports','bi.objectives','bi.targets','bi.esg_readings','bi.esg_factors','bi.anomaly_reviews']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA bi TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bi TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('bi.dashboard','bi','See the executive dashboard (each KPI still needs its own module permission)'),
  ('bi.report.manage','bi','Build, save and share reports (each dataset still needs its own permission)'),
  ('bi.scorecard.manage','bi','Maintain strategic objectives and KPI targets'),
  ('bi.esg.manage','bi','Record ESG readings and emission factors, see the ESG report'),
  ('bi.anomaly.review','bi','Run anomaly checks on the books and record review outcomes');
