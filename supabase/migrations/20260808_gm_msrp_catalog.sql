-- Chevrolet / GMC / Buick Canada MSRP catalog — base MSRP per model (one
-- NULL-trim row per model). Cadillac is intentionally NOT touched here: it was
-- populated with per-trim detail in an earlier pass; overwriting with base-only
-- rows would regress it.
--
-- Sources: GMC from Canadian GMC dealer build pages (GM's official configurator
-- MSRP, 2026); Chevrolet + Buick from guideautoweb.com (The Car Guide, publishes
-- manufacturer base MSRP), cross-checked to AutoTrader.ca where possible. All
-- pre-freight base MSRP (CAD), researched 2026-08-08. GM's own .ca sites are
-- bot-walled (HTTP 403), hence the readable secondary/dealer sources.
-- Watch items: Buick Envista ($29,399 guideautoweb vs a dealer's $32,533 —
-- verify on chevrolet/buick config) and GMC Sierra EV (trim baseline varies by
-- source/year; using the 2026 dealer-config base).

DELETE FROM msrp_catalog WHERE make IN ('Chevrolet','GMC','Buick');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Chevrolet
  (2026, 'Chevrolet', 'Trax',             NULL, 26699, 'Gas'),
  (2026, 'Chevrolet', 'Trailblazer',      NULL, 28499, 'Gas'),
  (2026, 'Chevrolet', 'Equinox',          NULL, 33999, 'Gas'),
  (2026, 'Chevrolet', 'Equinox EV',       NULL, 46199, 'BEV'),
  (2025, 'Chevrolet', 'Blazer',           NULL, 42999, 'Gas'),
  (2026, 'Chevrolet', 'Blazer EV',        NULL, 55699, 'BEV'),
  (2026, 'Chevrolet', 'Traverse',         NULL, 51499, 'Gas'),
  (2026, 'Chevrolet', 'Colorado',         NULL, 39099, 'Gas'),
  (2026, 'Chevrolet', 'Silverado 1500',   NULL, 48499, 'Gas'),
  (2025, 'Chevrolet', 'Silverado 2500HD', NULL, 62499, 'Gas'),
  (2026, 'Chevrolet', 'Silverado EV',     NULL, 63999, 'BEV'),
  (2025, 'Chevrolet', 'Corvette',         NULL, 87699, 'Gas'),
  -- GMC
  (2026, 'GMC', 'Terrain',                NULL, 36199, 'Gas'),
  (2026, 'GMC', 'Acadia',                 NULL, 54699, 'Gas'),
  (2026, 'GMC', 'Canyon',                 NULL, 51799, 'Gas'),
  (2026, 'GMC', 'Sierra 1500',            NULL, 49999, 'Gas'),
  (2026, 'GMC', 'Sierra 2500HD',          NULL, 66799, 'Gas'),
  (2026, 'GMC', 'Sierra 3500HD',          NULL, 68799, 'Gas'),
  (2026, 'GMC', 'Sierra EV',              NULL, 80999, 'BEV'),
  (2026, 'GMC', 'Yukon',                  NULL, 94699, 'Gas'),
  (2026, 'GMC', 'Yukon XL',               NULL, 98199, 'Gas'),
  (2026, 'GMC', 'Hummer EV Pickup',       NULL, 131198, 'BEV'),
  (2026, 'GMC', 'Hummer EV SUV',          NULL, 131198, 'BEV'),
  -- Buick
  (2026, 'Buick', 'Envista',              NULL, 29399, 'Gas'),
  (2026, 'Buick', 'Encore GX',            NULL, 30999, 'Gas'),
  (2025, 'Buick', 'Envision',             NULL, 44199, 'Gas'),
  (2026, 'Buick', 'Enclave',              NULL, 60699, 'Gas');
