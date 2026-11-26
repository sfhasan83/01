-- BAATS Enterprise ERP: Phase 1 core schema
-- Engines: platform (tenants), org, iam, audit, mdm, wf
-- Every tenant-owned table carries tenant_id and is protected by PostgreSQL row-level security.
-- Cross-tenant references are impossible because foreign keys are composite (tenant_id, id).

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ref;
CREATE SCHEMA IF NOT EXISTS org;
CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS mdm;
CREATE SCHEMA IF NOT EXISTS wf;

-- ---------------------------------------------------------------------------
-- Session context helpers. The application sets these per transaction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
CREATE FUNCTION app.actor() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Reference data shared by all tenants (read-only to the application)
-- ---------------------------------------------------------------------------
CREATE TABLE ref.countries (
  code char(2) PRIMARY KEY,
  name text NOT NULL,
  currency_code char(3) NOT NULL
);
CREATE TABLE ref.currencies (
  code char(3) PRIMARY KEY,
  name text NOT NULL,
  minor_units smallint NOT NULL DEFAULT 2
);
CREATE TABLE ref.permissions (
  code text PRIMARY KEY,
  engine text NOT NULL,
  description text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Platform: tenants (one row per customer organization)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  base_currency char(3) NOT NULL REFERENCES ref.currencies(code),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Login needs to find a tenant by code before a tenant context exists.
CREATE FUNCTION platform.tenant_id_by_code(p_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, pg_temp AS $$
  SELECT id FROM platform.tenants WHERE code = p_code AND status = 'active'
$$;

-- The scheduler sweeps every active tenant (escalations and other timed jobs).
CREATE FUNCTION platform.active_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, pg_temp AS $$
  SELECT id FROM platform.tenants WHERE status = 'active' ORDER BY id
$$;

-- ---------------------------------------------------------------------------
-- Audit engine: append-only, hash-chained per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE audit.entries (
  tenant_id uuid NOT NULL,
  seq bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid,
  category text NOT NULL CHECK (category IN ('data','security','workflow','system')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX ON audit.entries (tenant_id, entity_type, entity_id);
CREATE INDEX ON audit.entries (tenant_id, occurred_at);

-- Canonical text that the hash covers. Shared by append and by verification.
CREATE FUNCTION audit.payload(e audit.entries) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', e.tenant_id::text, e.seq::text, to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(e.actor_user_id::text,''), e.category, e.action, e.entity_type, coalesce(e.entity_id,''),
    coalesce(e.before::text,''), coalesce(e.after::text,''), e.prev_hash)
$$;

CREATE FUNCTION audit.append(p_category text, p_action text, p_entity_type text, p_entity_id text,
                             p_before jsonb, p_after jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, app, pg_temp AS $$
DECLARE
  t uuid := app.tenant();
  last audit.entries;
  e audit.entries;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'audit.append requires a tenant context'; END IF;
  -- Serialize appends per tenant so the chain has no forks.
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text, 42));
  SELECT * INTO last FROM audit.entries WHERE tenant_id = t ORDER BY seq DESC LIMIT 1;
  e.tenant_id := t;
  e.seq := coalesce(last.seq, 0) + 1;
  e.occurred_at := date_trunc('microseconds', clock_timestamp());
  e.actor_user_id := app.actor();
  e.category := p_category; e.action := p_action; e.entity_type := p_entity_type; e.entity_id := p_entity_id;
  e.before := p_before; e.after := p_after;
  e.prev_hash := coalesce(last.hash, repeat('0', 64));
  e.hash := encode(sha256(convert_to(audit.payload(e), 'UTF8')), 'hex');
  INSERT INTO audit.entries VALUES (e.*);
  RETURN e.seq;
END $$;

CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit entries are immutable'; END $$;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- Generic row-change capture for audited tables. Secrets are stripped.
CREATE FUNCTION audit.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, app, pg_temp AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) - 'password_hash' - 'mfa_secret' - 'token_hash' END;
  n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) - 'password_hash' - 'mfa_secret' - 'token_hash' END;
BEGIN
  IF TG_OP = 'UPDATE' AND o = n THEN RETURN NULL; END IF;
  PERFORM audit.append('data', lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
                       coalesce(n->>'id', o->>'id'), o, n);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Organization engine
-- ---------------------------------------------------------------------------
-- Hierarchy levels are data, so each tenant shapes its own structure.
CREATE TABLE org.unit_types (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  rank smallint NOT NULL,           -- lower rank sits higher in the tree
  is_legal_entity boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE org.units (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id uuid NOT NULL,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  path text NOT NULL DEFAULT '',     -- '/<root id>/.../<id>/', maintained by trigger
  depth int NOT NULL DEFAULT 0,
  country_code char(2) REFERENCES ref.countries(code),
  currency_code char(3) REFERENCES ref.currencies(code),
  is_cost_center boolean NOT NULL DEFAULT false,
  is_profit_center boolean NOT NULL DEFAULT false,
  head_employee_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  attributes jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, type_id) REFERENCES org.unit_types(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES org.units(tenant_id, id)
);
CREATE INDEX units_path_idx ON org.units (tenant_id, path text_pattern_ops);
CREATE UNIQUE INDEX units_one_root ON org.units (tenant_id) WHERE parent_id IS NULL;

CREATE FUNCTION org.units_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p org.units;
  child_rank smallint; parent_rank smallint;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := '/' || NEW.id || '/'; NEW.depth := 0;
  ELSE
    SELECT * INTO p FROM org.units WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
    IF p.path LIKE '%/' || NEW.id || '/%' THEN
      RAISE EXCEPTION 'moving unit % under % would create a cycle', NEW.id, NEW.parent_id;
    END IF;
    SELECT rank INTO child_rank FROM org.unit_types WHERE id = NEW.type_id;
    SELECT rank INTO parent_rank FROM org.unit_types WHERE id = p.type_id;
    IF child_rank <= parent_rank THEN
      RAISE EXCEPTION 'a unit of rank % cannot sit under a unit of rank %', child_rank, parent_rank;
    END IF;
    NEW.path := p.path || NEW.id || '/'; NEW.depth := p.depth + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER units_path BEFORE INSERT OR UPDATE OF parent_id, type_id ON org.units
  FOR EACH ROW EXECUTE FUNCTION org.units_set_path();

CREATE FUNCTION org.units_cascade_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only the unit that was moved rewrites its subtree; the rewritten rows do not cascade again.
  IF pg_trigger_depth() = 1 THEN
    UPDATE org.units SET path = NEW.path || substr(path, length(OLD.path) + 1),
                         depth = depth + (NEW.depth - OLD.depth)
     WHERE tenant_id = NEW.tenant_id AND path LIKE OLD.path || '%' AND id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER units_cascade AFTER UPDATE ON org.units
  FOR EACH ROW WHEN (OLD.path IS DISTINCT FROM NEW.path) EXECUTE FUNCTION org.units_cascade_path();

CREATE TABLE org.designations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  title text NOT NULL,
  grade text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE org.employees (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  unit_id uuid NOT NULL,
  designation_id uuid,
  manager_id uuid,
  hire_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','terminated')),
  attributes jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, employee_no),
  CHECK (manager_id IS NULL OR manager_id <> id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES org.units(tenant_id, id),
  FOREIGN KEY (tenant_id, designation_id) REFERENCES org.designations(tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES org.employees(tenant_id, id)
);
CREATE INDEX ON org.employees (tenant_id, manager_id);
CREATE INDEX ON org.employees (tenant_id, unit_id);
ALTER TABLE org.units ADD FOREIGN KEY (tenant_id, head_employee_id) REFERENCES org.employees(tenant_id, id);

-- Reject reporting-line cycles (A reports to B reports to A).
CREATE FUNCTION org.employees_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manager_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE chain(id, manager_id) AS (
      SELECT id, manager_id FROM org.employees WHERE tenant_id = NEW.tenant_id AND id = NEW.manager_id
      UNION ALL
      SELECT e.id, e.manager_id FROM org.employees e JOIN chain c ON e.id = c.manager_id
       WHERE e.tenant_id = NEW.tenant_id
    ) SELECT 1 FROM chain WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'reporting line cycle: employee % cannot report to %', NEW.id, NEW.manager_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employees_no_cycle BEFORE INSERT OR UPDATE OF manager_id ON org.employees
  FOR EACH ROW EXECUTE FUNCTION org.employees_no_cycle();

-- ---------------------------------------------------------------------------
-- Identity and access engine
-- ---------------------------------------------------------------------------
CREATE TABLE iam.users (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text,
  employee_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_secret text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES org.employees(tenant_id, id)
);
CREATE UNIQUE INDEX users_email_uq ON iam.users (tenant_id, lower(email));
CREATE UNIQUE INDEX users_employee_uq ON iam.users (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE iam.sessions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id)
);

CREATE TABLE iam.roles (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

-- A grant of one permission to one role, optionally narrowed by ABAC conditions,
-- for example {"amount": {"lte": 50000}, "currency": {"in": ["AED","USD"]}}.
CREATE TABLE iam.role_permissions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES ref.permissions(code),
  conditions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES iam.roles(tenant_id, id) ON DELETE CASCADE
);

-- Who holds which role, over which part of the organization, and when.
CREATE TABLE iam.role_assignments (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  scope_unit_id uuid NOT NULL,
  include_descendants boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  UNIQUE (tenant_id, user_id, role_id, scope_unit_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES iam.roles(tenant_id, id),
  FOREIGN KEY (tenant_id, scope_unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE INDEX ON iam.role_assignments (tenant_id, user_id);

-- Segregation of duties: no one user may hold both permissions.
CREATE TABLE iam.sod_rules (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  permission_a text NOT NULL REFERENCES ref.permissions(code),
  permission_b text NOT NULL REFERENCES ref.permissions(code),
  CHECK (permission_a <> permission_b)
);

-- Delegation of authority for approvals (holidays, absences).
CREATE TABLE iam.delegations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_user_id uuid NOT NULL,
  delegate_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  reason text,
  CHECK (delegator_user_id <> delegate_user_id),
  CHECK (valid_to > valid_from),
  FOREIGN KEY (tenant_id, delegator_user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, delegate_user_id) REFERENCES iam.users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Master data engine
-- ---------------------------------------------------------------------------
CREATE TABLE mdm.uoms (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);

-- Customers, suppliers or both. Activation goes through the workflow engine.
CREATE TABLE mdm.parties (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  is_customer boolean NOT NULL DEFAULT false,
  is_supplier boolean NOT NULL DEFAULT false,
  country_code char(2) NOT NULL REFERENCES ref.countries(code),
  currency_code char(3) NOT NULL REFERENCES ref.currencies(code),
  tax_registration_no text,
  credit_limit numeric(20,4),
  owner_unit_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','rejected','blocked')),
  attributes jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  CHECK (is_customer OR is_supplier),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE UNIQUE INDEX parties_tax_uq ON mdm.parties (tenant_id, country_code, tax_registration_no)
  WHERE tax_registration_no IS NOT NULL;
CREATE INDEX ON mdm.parties (tenant_id, normalized_name);

CREATE TABLE mdm.items (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('stock','service','non_stock','asset')),
  base_uom_id uuid NOT NULL,
  barcode text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  attributes jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, base_uom_id) REFERENCES mdm.uoms(tenant_id, id)
);
CREATE UNIQUE INDEX items_barcode_uq ON mdm.items (tenant_id, barcode) WHERE barcode IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Workflow and approval engine
-- ---------------------------------------------------------------------------
CREATE TABLE wf.definitions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version int NOT NULL,
  name text NOT NULL,
  entity_type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code, version)
);
CREATE UNIQUE INDEX definitions_one_active ON wf.definitions (tenant_id, code) WHERE is_active;

CREATE TABLE wf.instances (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  requester_user_id uuid NOT NULL,
  subject_unit_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  current_step int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES wf.definitions(tenant_id, id),
  FOREIGN KEY (tenant_id, requester_user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, subject_unit_id) REFERENCES org.units(tenant_id, id)
);
CREATE UNIQUE INDEX instances_one_pending ON wf.instances (tenant_id, entity_type, entity_id) WHERE status = 'pending';

CREATE TABLE wf.tasks (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL,
  step_index int NOT NULL,
  step_key text NOT NULL,
  assignee_user_id uuid NOT NULL,
  on_behalf_of_user_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','closed','escalated')),
  due_at timestamptz,
  acted_at timestamptz,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, instance_id) REFERENCES wf.instances(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES iam.users(tenant_id, id),
  FOREIGN KEY (tenant_id, on_behalf_of_user_id) REFERENCES iam.users(tenant_id, id)
);
CREATE INDEX ON wf.tasks (tenant_id, assignee_user_id) WHERE status = 'open';
CREATE INDEX ON wf.tasks (tenant_id, due_at) WHERE status = 'open';

CREATE TABLE wf.history (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid,
  step_index int,
  action text NOT NULL,
  comment text,
  detail jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (tenant_id, instance_id) REFERENCES wf.instances(tenant_id, id)
);
CREATE INDEX ON wf.history (tenant_id, instance_id);

-- ---------------------------------------------------------------------------
-- Row-level security: one policy per tenant table
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org.unit_types','org.units','org.designations','org.employees',
    'iam.users','iam.sessions','iam.roles','iam.role_permissions','iam.role_assignments','iam.sod_rules','iam.delegations',
    'mdm.uoms','mdm.parties','mdm.items',
    'wf.definitions','wf.instances','wf.tasks','wf.history','audit.entries']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
  END LOOP;
END $$;
ALTER TABLE platform.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.tenants USING (id = app.tenant()) WITH CHECK (id = app.tenant());

-- Audited tables (sessions are audited as security events by the application instead).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'platform.tenants','org.unit_types','org.units','org.designations','org.employees',
    'iam.users','iam.roles','iam.role_permissions','iam.role_assignments','iam.sod_rules','iam.delegations',
    'mdm.uoms','mdm.parties','mdm.items','wf.definitions','wf.instances','wf.tasks']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime role: no ownership, no BYPASSRLS, audit is read-only
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'baats_app') THEN
    CREATE ROLE baats_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app, platform, ref, org, iam, audit, mdm, wf TO baats_app;
GRANT SELECT ON ALL TABLES IN SCHEMA ref TO baats_app;
GRANT SELECT, INSERT, UPDATE ON platform.tenants TO baats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA org, iam, mdm, wf TO baats_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA wf TO baats_app;
GRANT SELECT ON audit.entries TO baats_app;
REVOKE ALL ON FUNCTION audit.capture() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.append(text,text,text,text,jsonb,jsonb) TO baats_app;
