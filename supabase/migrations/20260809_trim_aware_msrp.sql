-- Trim-aware MSRP catalog — structural fix for the wrong-trim MSRP problem
-- (bZ XLE AWD showed the $45,990 base instead of $56,463). Adds the columns the
-- trim-fingerprinting matcher (_shared/trim-match.js) scores on, and loads
-- per-trim rows for the two proof models from toyota.ca Build & Price
-- (researched 2026-08-09, Vic's screenshots): bZ + Camry.
--
-- ORDER: deploy analyze-listing-url FIRST (its lookup handles both old and new
-- schema), then run this. Regression suite: node scripts/test-trim-match.mjs.

-- 1) Schema: drivetrain + distinctive-feature attrs (nullable, additive — no
--    existing row or code path breaks).
ALTER TABLE msrp_catalog ADD COLUMN IF NOT EXISTS drivetrain text;
ALTER TABLE msrp_catalog ADD COLUMN IF NOT EXISTS attrs jsonb;

-- 2) Toyota bZ — per-trim (was a single wrong $45,990 base row).
--    "bZ Woodland" stays its own model row (the model-split fix reunites it).
DELETE FROM msrp_catalog WHERE make = 'Toyota' AND model = 'bZ';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type, drivetrain) VALUES
  (2026, 'Toyota', 'bZ', 'XLE FWD',     49063, 'BEV', 'FWD'),
  (2026, 'Toyota', 'bZ', 'XLE AWD',     56463, 'BEV', 'AWD'),
  (2026, 'Toyota', 'bZ', 'Limited AWD', 64763, 'BEV', 'AWD');

-- 3) Toyota Camry — per-trim, hybrid-only lineup. Digital Key 2.0 is standard
--    ONLY on XLE/XSE (the distinctive feature separating the $49k tier).
DELETE FROM msrp_catalog WHERE make = 'Toyota' AND model = 'Camry';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type, drivetrain, attrs) VALUES
  (2026, 'Toyota', 'Camry', 'SE FWD',                  38792, 'Hybrid', 'FWD', NULL),
  (2026, 'Toyota', 'Camry', 'SE Upgrade FWD',          40842, 'Hybrid', 'FWD', NULL),
  (2026, 'Toyota', 'Camry', 'SE Upgrade AWD',          42487, 'Hybrid', 'AWD', NULL),
  (2026, 'Toyota', 'Camry', 'SE Upgrade Nightshade',   43614, 'Hybrid', 'AWD', NULL),
  (2026, 'Toyota', 'Camry', 'XLE AWD',                 49442, 'Hybrid', 'AWD', '{"digitalKey2": true}'),
  (2026, 'Toyota', 'Camry', 'XSE AWD',                 49547, 'Hybrid', 'AWD', '{"digitalKey2": true}');
