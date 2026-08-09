-- Ford Canada MSRP catalog — base "starting-at" MSRP per model (one NULL-trim
-- row per model; the analyze-listing-url lookup resolves MSRP for a no-trim
-- listing when exactly one row exists for year/make/model).
--
-- Sources: cross-corroborated across Unhaggle, The Car Guide (guideautoweb),
-- AutoTrader.ca, CarCostCanada (ford.ca itself is bot-walled / times out).
-- All figures pre-freight base MSRP (CAD), researched 2026-08-08.
-- Notes: F-150 Lightning figure is the Pro base; Super Duty = F-250 gas base
-- (aliased as "F-250" too). Maverick/Ranger/Explorer had a small (<$500)
-- source spread; the higher-corroborated figure was used.

DELETE FROM msrp_catalog WHERE make = 'Ford';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  (2026, 'Ford', 'F-150',           NULL, 52690, 'Gas'),
  (2026, 'Ford', 'F-150 Lightning', NULL, 70995, 'BEV'),
  (2026, 'Ford', 'Super Duty',      NULL, 61239, 'Gas'),
  (2026, 'Ford', 'F-250',           NULL, 61239, 'Gas'),
  (2026, 'Ford', 'Ranger',          NULL, 43370, 'Gas'),
  (2026, 'Ford', 'Maverick',        NULL, 35600, 'Hybrid'),
  (2026, 'Ford', 'Bronco',          NULL, 51765, 'Gas'),
  (2026, 'Ford', 'Bronco Sport',    NULL, 39245, 'Gas'),
  (2026, 'Ford', 'Escape',          NULL, 33499, 'Gas'),
  (2026, 'Ford', 'Explorer',        NULL, 52500, 'Gas'),
  (2026, 'Ford', 'Expedition',      NULL, 83370, 'Gas'),
  (2026, 'Ford', 'Mustang',         NULL, 38930, 'Gas'),
  (2026, 'Ford', 'Mustang Mach-E',  NULL, 44995, 'BEV');
