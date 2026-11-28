-- =============================================================================
-- Phase 6e: UK and EU country packs. Contributions charged between monthly
-- thresholds (UK National Insurance), contributions taken before income tax,
-- income tax withheld from pay (UK and Irish PAYE, or each employee's rate),
-- and the tax details on contracts the calculations need.
-- =============================================================================

ALTER TABLE hr.contribution_rules
  ADD COLUMN monthly_threshold numeric(20,3) CHECK (monthly_threshold IS NULL OR monthly_threshold >= 0),
  ADD COLUMN pre_tax boolean NOT NULL DEFAULT false;

ALTER TABLE hr.contracts
  ADD COLUMN tax_code text,                                  -- UK PAYE tax code, e.g. 1257L
  ADD COLUMN tax_credits numeric(20,3) CHECK (tax_credits IS NULL OR tax_credits >= 0),    -- Ireland: yearly tax credits (RPN)
  ADD COLUMN rate_cut_off numeric(20,3) CHECK (rate_cut_off IS NULL OR rate_cut_off >= 0), -- Ireland: yearly standard rate cut-off (RPN)
  ADD COLUMN withholding_pct numeric(6,3) CHECK (withholding_pct IS NULL OR (withholding_pct >= 0 AND withholding_pct <= 100)),
  ADD COLUMN previous_pay numeric(20,3) NOT NULL DEFAULT 0 CHECK (previous_pay >= 0),   -- pay this tax year from a previous employer (P45)
  ADD COLUMN previous_tax numeric(20,3) NOT NULL DEFAULT 0,                             -- income tax (PAYE) on it
  ADD COLUMN previous_usc numeric(20,3) NOT NULL DEFAULT 0;                             -- Ireland: USC on it

ALTER TABLE hr.payslips
  ADD COLUMN taxable_pay numeric(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN income_tax numeric(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN taxes jsonb NOT NULL DEFAULT '[]';

ALTER TABLE hr.payroll_runs
  ADD COLUMN income_tax_total numeric(20,3) NOT NULL DEFAULT 0;

-- The SEPA salary transfer file made when an EU payroll is paid, kept as made.
ALTER TABLE hr.payroll_runs ADD COLUMN payment_file text;

-- The rest of the EU (and Norway), so customers and suppliers there can be recorded
-- and EU supplies told apart from exports.
INSERT INTO ref.currencies (code, name, minor_units) VALUES
  ('CZK','Czech Koruna',2), ('DKK','Danish Krone',2), ('HUF','Hungarian Forint',2), ('PLN','Polish Zloty',2),
  ('RON','Romanian Leu',2), ('SEK','Swedish Krona',2), ('NOK','Norwegian Krone',2)
ON CONFLICT (code) DO NOTHING;
INSERT INTO ref.countries (code, name, currency_code) VALUES
  ('AT','Austria','EUR'), ('BG','Bulgaria','EUR'), ('HR','Croatia','EUR'), ('CY','Cyprus','EUR'), ('CZ','Czechia','CZK'),
  ('DK','Denmark','DKK'), ('EE','Estonia','EUR'), ('FI','Finland','EUR'), ('GR','Greece','EUR'), ('HU','Hungary','HUF'),
  ('LV','Latvia','EUR'), ('LT','Lithuania','EUR'), ('LU','Luxembourg','EUR'), ('MT','Malta','EUR'), ('PL','Poland','PLN'),
  ('PT','Portugal','EUR'), ('RO','Romania','RON'), ('SK','Slovakia','EUR'), ('SI','Slovenia','EUR'), ('SE','Sweden','SEK'),
  ('NO','Norway','NOK')
ON CONFLICT (code) DO NOTHING;
