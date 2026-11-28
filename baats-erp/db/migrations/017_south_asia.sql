-- =============================================================================
-- Phase 6f: India and Pakistan. Contributions that cover only employees paid up
-- to a ceiling (India's ESI covers monthly wages up to INR 21,000).
-- =============================================================================

ALTER TABLE hr.contribution_rules
  ADD COLUMN eligible_up_to numeric(20,3) CHECK (eligible_up_to IS NULL OR eligible_up_to > 0);

-- Pakistan: the company's province, which FBR digital invoices state for the seller.
ALTER TABLE fin.companies ADD COLUMN province text;
