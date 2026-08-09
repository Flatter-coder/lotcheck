-- Porsche / MINI / Land Rover / Jaguar Canada MSRP catalog — base MSRP per model
-- (one NULL-trim row per model). Sources: GuideAutoWeb Canadian model pages
-- (manufacturer-sourced starting MSRP), cross-checked where possible. Pre-freight
-- base MSRP (CAD), researched 2026-08-08. Manufacturer build&price pages are
-- JS/bot-gated, so GuideAutoWeb was the readable verification source.
-- Notes: 718 Cayman/Boxster are the last-year 2025 (no 2026). Porsche Cayenne
-- Electric omitted (couldn't isolate a clean pre-freight base for the SUV body).
-- Jaguar is down to the F-PACE in Canada during its EV-relaunch pause.

DELETE FROM msrp_catalog WHERE make IN ('Porsche','MINI','Land Rover','Jaguar');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Porsche
  (2026, 'Porsche', '911',                 NULL, 143600, 'Gas'),
  (2025, 'Porsche', '718 Cayman',          NULL, 79500,  'Gas'),
  (2025, 'Porsche', '718 Boxster',         NULL, 81900,  'Gas'),
  (2026, 'Porsche', 'Panamera',            NULL, 122000, 'Gas'),
  (2026, 'Porsche', 'Macan',               NULL, 67700,  'Gas'),
  (2026, 'Porsche', 'Macan Electric',      NULL, 98000,  'BEV'),
  (2026, 'Porsche', 'Cayenne',             NULL, 95300,  'Gas'),
  (2026, 'Porsche', 'Taycan',              NULL, 136200, 'BEV'),
  -- MINI
  (2026, 'MINI', 'Cooper 3 Door',          NULL, 35990,  'Gas'),
  (2026, 'MINI', 'Cooper 5 Door',          NULL, 36990,  'Gas'),
  (2026, 'MINI', 'Cooper Convertible',     NULL, 43990,  'Gas'),
  (2026, 'MINI', 'Countryman',             NULL, 45990,  'Gas'),
  (2026, 'MINI', 'Countryman Electric',    NULL, 59990,  'BEV'),
  -- Land Rover
  (2026, 'Land Rover', 'Range Rover',        NULL, 133000, 'Gas'),
  (2026, 'Land Rover', 'Range Rover Sport',  NULL, 94950,  'Gas'),
  (2026, 'Land Rover', 'Range Rover Velar',  NULL, 69500,  'Gas'),
  (2026, 'Land Rover', 'Range Rover Evoque', NULL, 57600,  'Gas'),
  (2026, 'Land Rover', 'Defender',           NULL, 74100,  'Gas'),
  (2026, 'Land Rover', 'Discovery',          NULL, 79900,  'Gas'),
  (2026, 'Land Rover', 'Discovery Sport',    NULL, 59800,  'Gas'),
  -- Jaguar
  (2026, 'Jaguar', 'F-PACE',               NULL, 67000,  'Gas');
