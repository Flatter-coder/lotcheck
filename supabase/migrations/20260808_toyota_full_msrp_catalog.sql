-- Full Toyota Canada MSRP catalog — base "starting-at" MSRP per model.
-- One NULL-trim row per model: the analyze-listing-url lookup resolves MSRP for
-- a no-trim listing only when exactly one row exists for (year, make, model)
-- (lookupCatalogMsrp "pool.length===1 && !trim"). Bot-walled dealer pages rarely
-- expose a trim, so the base MSRP is the reliable fallback.
--
-- Sources: Toyota Canada press releases (media.toyota.ca "Starting MSRP") +
-- auto123 pricing announcements. All figures are pre-freight/PDI base MSRP (CAD),
-- researched 2026-08-08. Model years are the years each price was published for.
--
-- Notes: for MY2026 both Camry and RAV4 are hybrid-only (no gas trims). "RAV4"
-- and "RAV4 Hybrid" both point at the hybrid base; "RAV4 Prime"/"RAV4 Plug-in
-- Hybrid" both point at the PHEV base — same price, so name-variant parsing still
-- resolves. bZ Woodland ($59,900) was loaded separately and is preserved below.

DELETE FROM msrp_catalog WHERE make = 'Toyota' AND model <> 'bZ Woodland';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Cars
  (2026, 'Toyota', 'Corolla',                 NULL, 24520, 'Gas'),
  (2026, 'Toyota', 'Corolla Hybrid',          NULL, 27740, 'Hybrid'),
  (2025, 'Toyota', 'Corolla Hatchback',       NULL, 24075, 'Gas'),
  (2026, 'Toyota', 'Camry',                   NULL, 34575, 'Hybrid'),
  (2026, 'Toyota', 'Prius',                   NULL, 38365, 'Hybrid'),
  (2026, 'Toyota', 'Crown',                   NULL, 54937, 'Hybrid'),
  (2025, 'Toyota', 'GR86',                    NULL, 32355, 'Gas'),
  (2026, 'Toyota', 'GR Corolla',              NULL, 50045, 'Gas'),
  -- SUVs / crossovers
  (2026, 'Toyota', 'Corolla Cross',           NULL, 28580, 'Gas'),
  (2026, 'Toyota', 'Corolla Cross Hybrid',    NULL, 35810, 'Hybrid'),
  (2026, 'Toyota', 'RAV4',                    NULL, 37500, 'Hybrid'),
  (2026, 'Toyota', 'RAV4 Hybrid',             NULL, 37500, 'Hybrid'),
  (2026, 'Toyota', 'RAV4 Prime',              NULL, 48750, 'PHEV'),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid',     NULL, 48750, 'PHEV'),
  (2026, 'Toyota', 'Highlander',              NULL, 51285, 'Gas'),
  (2026, 'Toyota', 'Highlander Hybrid',       NULL, 54485, 'Hybrid'),
  (2026, 'Toyota', 'Grand Highlander',        NULL, 51635, 'Gas'),
  (2026, 'Toyota', 'Grand Highlander Hybrid', NULL, 54935, 'Hybrid'),
  (2026, 'Toyota', '4Runner',                 NULL, 55270, 'Gas'),
  (2026, 'Toyota', 'bZ',                      NULL, 45990, 'BEV'),
  -- Trucks / van
  (2026, 'Toyota', 'Tacoma',                  NULL, 48895, 'Gas'),
  (2026, 'Toyota', 'Tundra',                  NULL, 54340, 'Gas'),
  (2026, 'Toyota', 'Sienna',                  NULL, 49370, 'Hybrid'),
  -- Moderate confidence (from CarCostCanada / motorz.ca — verify on Toyota.ca
  -- Build & Price if a report ever looks off):
  (2026, 'Toyota', 'Sequoia',                 NULL, 84940, 'Hybrid'),
  (2026, 'Toyota', 'Crown Signia',            NULL, 61963, 'Hybrid');
