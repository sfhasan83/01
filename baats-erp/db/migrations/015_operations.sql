-- =============================================================================
-- Phase 7b: running BAATS as a service. Plans, subscriptions and the platform's
-- own invoices to each customer organization; usage per tenant; a register of
-- backup checks (restore drills). Imports of open orders and fixed assets use
-- the existing tables.
-- =============================================================================

-- What a customer organization can subscribe to. Prices are per month, in the
-- platform's currency. Included users are in the price; more users cost extra,
-- up to max_users (no limit when null).
CREATE TABLE platform.plans (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name text NOT NULL,
  monthly_price numeric(20,3) NOT NULL CHECK (monthly_price >= 0),
  currency char(3) NOT NULL REFERENCES ref.currencies(code),
  included_users int NOT NULL CHECK (included_users >= 0),
  extra_user_price numeric(20,3) NOT NULL DEFAULT 0 CHECK (extra_user_price >= 0),
  max_users int CHECK (max_users IS NULL OR max_users >= included_users),
  max_companies int CHECK (max_companies IS NULL OR max_companies > 0),
  trial_days int NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  billable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.plans (code, name, monthly_price, currency, included_users, extra_user_price, max_users, max_companies, trial_days, billable) VALUES
  ('TRIAL', 'Free trial', 0, 'AED', 5, 0, 5, 2, 30, false),
  ('STARTER', 'Starter', 750, 'AED', 10, 60, 25, 1, 0, true),
  ('BUSINESS', 'Business', 2500, 'AED', 50, 45, 250, 5, 0, true),
  ('ENTERPRISE', 'Enterprise', 9000, 'AED', 250, 35, NULL, NULL, 0, true),
  ('ONPREM', 'On-premises licence', 0, 'AED', 0, 0, NULL, NULL, 0, false);

-- One subscription per tenant. Trials end on trial_ends_at; an unpaid platform
-- invoice makes it past_due after its due date and suspended 14 days later. A
-- suspended or cancelled subscription, or an ended trial, leaves the data
-- readable (and exportable) but not changeable.
CREATE TABLE platform.subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(id),
  plan_code text NOT NULL REFERENCES platform.plans(code),
  status text NOT NULL CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  -- Why it is suspended: unpaid (lifted when the invoices are paid) or manual (by the operator).
  status_reason text CHECK (status_reason IN ('unpaid','manual')),
  billing_email text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'trial' OR trial_ends_at IS NOT NULL)
);

CREATE SEQUENCE platform.billing_invoice_seq;
-- The platform's invoice to a tenant for one month: the plan, plus users above
-- what the plan includes, counted when the month is billed.
CREATE TABLE platform.billing_invoices (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no text NOT NULL UNIQUE,
  period char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  plan_code text NOT NULL REFERENCES platform.plans(code),
  users int NOT NULL,
  companies int NOT NULL,
  base_amount numeric(20,3) NOT NULL,
  extra_users int NOT NULL DEFAULT 0,
  extra_amount numeric(20,3) NOT NULL DEFAULT 0,
  total numeric(20,3) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  issued_on date NOT NULL DEFAULT current_date,
  due_on date NOT NULL,
  paid_at timestamptz,
  payment_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

-- Every tenant, for the platform operator (the table itself shows each tenant only its own row).
CREATE FUNCTION platform.all_tenants() RETURNS TABLE (id uuid, code text, name text, status text, base_currency char(3), created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, pg_temp AS $$
  SELECT id, code, name, status, base_currency, created_at FROM platform.tenants ORDER BY created_at
$$;
REVOKE ALL ON FUNCTION platform.all_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.all_tenants() TO baats_app;

-- Tenants that existed before subscriptions were introduced keep working, unlimited.
INSERT INTO platform.subscriptions (tenant_id, plan_code, status) SELECT id, 'ONPREM', 'active' FROM platform.tenants;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform.subscriptions','platform.billing_invoices']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.tenant()) WITH CHECK (tenant_id = app.tenant())', t);
    EXECUTE format('CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON platform.plans, platform.subscriptions, platform.billing_invoices TO baats_app;
GRANT USAGE ON SEQUENCE platform.billing_invoice_seq TO baats_app;

INSERT INTO ref.permissions (code, engine, description) VALUES
  ('sys.subscription.read','sys','See the organization''s subscription, usage and invoices from the BAATS service'),
  ('sys.platform','sys','Operate the BAATS service from the Windows trial console: plans, subscriptions and billing of every organization on this PC');

-- More things to bring in when switching to BAATS.
ALTER TABLE mig.import_runs DROP CONSTRAINT import_runs_kind_check;
ALTER TABLE mig.import_runs ADD CONSTRAINT import_runs_kind_check CHECK (kind IN ('customers','suppliers','items','employees','open_invoices','open_bills',
  'opening_balances','fixed_assets','open_purchase_orders','open_sales_orders'));
