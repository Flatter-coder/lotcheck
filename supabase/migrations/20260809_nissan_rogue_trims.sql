-- 2026 Nissan Rogue (gas) — per-trim MSRP ladder, replacing the single base row.
-- Source: Nissan Canada newsroom pricing release (live-crawled 2026-08-09):
-- canada.nissannews.com/en-CA/releases/2026-nissan-rogue-pricing-announced-for-canada
-- Pre-freight MSRP (freight/PDI CA$2,050 + $100 A/C excluded per the table's own
-- footnote). Canada's 2026 lineup is five trims, ALL AWD (no FWD; SL dropped).
-- Also corrects the old base figure: $34,848 was aggregator-inflated; Nissan's
-- true base is $34,598 (the newsroom page was revised in place — S +$200 etc.,
-- Dark Armor added). "Rogue Plug-in Hybrid" row is untouched ($58,698 confirmed).
-- Regression-locked: scripts/test-trim-match.mjs (Rock Creek -> 41798, etc.).

DELETE FROM msrp_catalog WHERE make = 'Nissan' AND model = 'Rogue';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type, drivetrain) VALUES
  (2026, 'Nissan', 'Rogue', 'S',          34598, 'Gas', 'AWD'),
  (2026, 'Nissan', 'Rogue', 'SV',         38498, 'Gas', 'AWD'),
  (2026, 'Nissan', 'Rogue', 'Dark Armor', 40798, 'Gas', 'AWD'),
  (2026, 'Nissan', 'Rogue', 'Rock Creek', 41798, 'Gas', 'AWD'),
  (2026, 'Nissan', 'Rogue', 'Platinum',   46298, 'Gas', 'AWD');
