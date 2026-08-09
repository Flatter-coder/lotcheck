-- Jeep / Ram / Dodge / Chrysler / Fiat / Alfa Romeo Canada MSRP catalog — base
-- MSRP per model (one NULL-trim row per model). Pre-freight base MSRP (CAD),
-- researched 2026-08-08. Sources: Le Guide de l'auto (guideautoweb), Unhaggle,
-- and dealer pages that itemize "MSRP" separately. NOTE: jeep.ca/ramtruck.ca
-- "Starting At" figures were deliberately NOT used — they bundle freight and
-- subtract current discounts (thousands below true MSRP).

DELETE FROM msrp_catalog WHERE make IN ('Jeep','Ram','Dodge','Chrysler','Fiat','Alfa Romeo');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Jeep
  (2026, 'Jeep', 'Wrangler',           NULL, 41600, 'Gas'),
  (2026, 'Jeep', 'Cherokee',           NULL, 39995, 'Hybrid'),
  (2026, 'Jeep', 'Compass',            NULL, 34700, 'Gas'),
  (2026, 'Jeep', 'Gladiator',          NULL, 50495, 'Gas'),
  (2026, 'Jeep', 'Grand Cherokee',     NULL, 59995, 'Gas'),
  (2026, 'Jeep', 'Grand Cherokee L',   NULL, 62495, 'Gas'),
  (2025, 'Jeep', 'Grand Cherokee 4xe', NULL, 59995, 'PHEV'),
  (2026, 'Jeep', 'Grand Wagoneer',     NULL, 88995, 'Gas'),
  (2026, 'Jeep', 'Grand Wagoneer L',   NULL, 92495, 'Gas'),
  (2025, 'Jeep', 'Wagoneer S',         NULL, 82995, 'BEV'),
  (2026, 'Jeep', 'Recon',              NULL, 84995, 'BEV'),
  -- Ram
  (2026, 'Ram', '1500',                NULL, 59495, 'Gas'),
  (2026, 'Ram', '2500',                NULL, 65945, 'Gas'),
  (2026, 'Ram', '3500',                NULL, 66945, 'Gas'),
  (2026, 'Ram', 'ProMaster',           NULL, 58520, 'Gas'),
  (2026, 'Ram', 'ProMaster EV',        NULL, 77965, 'BEV'),
  -- Dodge
  (2025, 'Dodge', 'Hornet',            NULL, 41495, 'Gas'),
  (2025, 'Dodge', 'Hornet R/T',        NULL, 55995, 'PHEV'),
  (2025, 'Dodge', 'Charger Daytona',   NULL, 54995, 'BEV'),
  (2026, 'Dodge', 'Charger Sixpack',   NULL, 59995, 'Gas'),
  (2025, 'Dodge', 'Durango',           NULL, 59995, 'Gas'),
  -- Chrysler
  (2025, 'Chrysler', 'Pacifica',        NULL, 52700, 'Gas'),
  (2025, 'Chrysler', 'Pacifica Hybrid', NULL, 59995, 'PHEV'),
  -- Fiat
  (2026, 'Fiat', '500e',               NULL, 39995, 'BEV'),
  -- Alfa Romeo
  (2026, 'Alfa Romeo', 'Giulia',       NULL, 62995, 'Gas'),
  (2026, 'Alfa Romeo', 'Stelvio',      NULL, 64995, 'Gas'),
  (2026, 'Alfa Romeo', 'Tonale',       NULL, 49995, 'Gas');
