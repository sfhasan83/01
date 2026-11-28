-- =============================================================================
-- BAATS Enterprise ERP, Phase 6b: the rest of the GCC (Oman, Bahrain, Qatar,
-- Kuwait) and money in three decimals.
--   * every amount column keeps three decimals, so the Bahraini dinar, Kuwaiti
--     dinar and Omani rial (1,000 fils or baisa) are exact; the code rounds each
--     amount to its own currency, so two-decimal currencies are unchanged
--   * the countries and currencies of the new packs, and common trading partners
--   * social insurance rates that step up with years of service
-- =============================================================================

-- Three decimals for every amount -------------------------------------------------------
-- Widening numeric(20,2) to numeric(20,3) keeps every stored value as it is.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT table_schema, table_name, column_name
      FROM information_schema.columns
     WHERE data_type = 'numeric' AND numeric_precision = 20 AND numeric_scale = 2
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND (table_schema, table_name) IN (SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE')
     ORDER BY 1, 2, 3
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE numeric(20,3)', c.table_schema, c.table_name, c.column_name);
  END LOOP;
END $$;

-- Countries and currencies ---------------------------------------------------------------
INSERT INTO ref.currencies (code, name, minor_units) VALUES
  ('OMR','Omani Rial',3), ('BHD','Bahraini Dinar',3), ('QAR','Qatari Riyal',2), ('KWD','Kuwaiti Dinar',3),
  ('EGP','Egyptian Pound',2), ('JOD','Jordanian Dinar',3), ('TRY','Turkish Lira',2), ('CNY','Chinese Yuan',2),
  ('SGD','Singapore Dollar',2), ('HKD','Hong Kong Dollar',2), ('CHF','Swiss Franc',2), ('JPY','Japanese Yen',0),
  ('KRW','South Korean Won',0), ('BDT','Bangladeshi Taka',2), ('LKR','Sri Lankan Rupee',2), ('PHP','Philippine Peso',2),
  ('NPR','Nepalese Rupee',2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO ref.countries (code, name, currency_code) VALUES
  ('OM','Oman','OMR'), ('BH','Bahrain','BHD'), ('QA','Qatar','QAR'), ('KW','Kuwait','KWD'),
  ('EG','Egypt','EGP'), ('JO','Jordan','JOD'), ('TR','Turkey','TRY'), ('CN','China','CNY'),
  ('SG','Singapore','SGD'), ('HK','Hong Kong','HKD'), ('CH','Switzerland','CHF'), ('JP','Japan','JPY'),
  ('KR','South Korea','KRW'), ('BD','Bangladesh','BDT'), ('LK','Sri Lanka','LKR'), ('PH','Philippines','PHP'),
  ('NP','Nepal','NPR')
ON CONFLICT (code) DO NOTHING;

-- Stepped social insurance rates ------------------------------------------------------------
-- Bahrain's leaving indemnity for non-Bahrainis is 4.2% of wages for the first three
-- years of service and 8.4% after.
ALTER TABLE hr.contribution_rules
  ADD COLUMN after_years numeric(4,1) CHECK (after_years > 0),
  ADD COLUMN employer_pct_after numeric(6,3) CHECK (employer_pct_after >= 0 AND employer_pct_after <= 100),
  ADD CONSTRAINT contribution_step_complete CHECK ((after_years IS NULL) = (employer_pct_after IS NULL));
