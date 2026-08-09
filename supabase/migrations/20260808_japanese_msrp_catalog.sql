-- Honda / Nissan / Mazda / Subaru Canada MSRP catalog — base MSRP per model
-- (one NULL-trim row per model). Pre-freight base MSRP (CAD), researched
-- 2026-08-08. Sources: Nissan Canada newsroom (primary); Honda Canada dealer
-- build pages (live Honda MSRP feed); mazda.ca media + subaru.ca / OEM releases;
-- a few from guideautoweb/auto123/carcostcanada (the trims marked below).
-- Compound names normalized to how listings parse ("Civic Sedan"->"Civic",
-- "Mazda3 Sedan"->"Mazda3").

DELETE FROM msrp_catalog WHERE make IN ('Honda','Nissan','Mazda','Subaru');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Honda
  (2026, 'Honda', 'Civic',            NULL, 28440, 'Gas'),
  (2026, 'Honda', 'Civic Hybrid',     NULL, 34200, 'Hybrid'),
  (2026, 'Honda', 'Civic Hatchback',  NULL, 32300, 'Gas'),
  (2026, 'Honda', 'Civic Si',         NULL, 36700, 'Gas'),
  (2026, 'Honda', 'Civic Type R',     NULL, 53850, 'Gas'),
  (2026, 'Honda', 'Accord',           NULL, 38600, 'Gas'),
  (2026, 'Honda', 'Accord Hybrid',    NULL, 45730, 'Hybrid'),
  (2026, 'Honda', 'CR-V',             NULL, 37075, 'Gas'),
  (2026, 'Honda', 'CR-V Hybrid',      NULL, 46000, 'Hybrid'),
  (2026, 'Honda', 'HR-V',             NULL, 30400, 'Gas'),
  (2026, 'Honda', 'Passport',         NULL, 57090, 'Gas'),
  (2026, 'Honda', 'Pilot',            NULL, 57750, 'Gas'),
  (2026, 'Honda', 'Ridgeline',        NULL, 53090, 'Gas'),
  (2026, 'Honda', 'Odyssey',          NULL, 51520, 'Gas'),
  (2026, 'Honda', 'Prologue',         NULL, 60090, 'BEV'),
  (2026, 'Honda', 'Prelude',          NULL, 49990, 'Hybrid'),
  -- Nissan
  (2026, 'Nissan', 'Sentra',                NULL, 25268, 'Gas'),
  (2026, 'Nissan', 'Rogue',                 NULL, 34848, 'Gas'),
  (2026, 'Nissan', 'Rogue Plug-in Hybrid',  NULL, 58698, 'PHEV'),
  (2026, 'Nissan', 'Pathfinder',            NULL, 55398, 'Gas'),
  (2026, 'Nissan', 'Frontier',              NULL, 56498, 'Gas'),
  (2026, 'Nissan', 'Armada',                NULL, 85748, 'Gas'),
  (2027, 'Nissan', 'Z',                     NULL, 49998, 'Gas'),
  (2026, 'Nissan', 'Ariya',                 NULL, 52898, 'BEV'),
  (2026, 'Nissan', 'LEAF',                  NULL, 44998, 'BEV'),
  (2026, 'Nissan', 'Kicks',                 NULL, 27198, 'Gas'),
  (2026, 'Nissan', 'Murano',                NULL, 58498, 'Gas'),
  -- Mazda
  (2026, 'Mazda', 'Mazda3',        NULL, 25250, 'Gas'),
  (2026, 'Mazda', 'Mazda3 Sport',  NULL, 26000, 'Gas'),
  (2026, 'Mazda', 'CX-30',         NULL, 29300, 'Gas'),
  (2026, 'Mazda', 'CX-5',          NULL, 36300, 'Gas'),
  (2026, 'Mazda', 'CX-70',         NULL, 49750, 'Gas'),
  (2026, 'Mazda', 'CX-70 PHEV',    NULL, 48999, 'PHEV'),
  (2026, 'Mazda', 'CX-90',         NULL, 47100, 'Gas'),
  (2026, 'Mazda', 'CX-90 PHEV',    NULL, 49999, 'PHEV'),
  (2026, 'Mazda', 'MX-5',          NULL, 35700, 'Gas'),
  (2026, 'Mazda', 'MX-5 RF',       NULL, 42700, 'Gas'),
  -- Subaru
  (2026, 'Subaru', 'Forester',        NULL, 34195, 'Gas'),
  (2026, 'Subaru', 'Forester Hybrid', NULL, 48695, 'Hybrid'),
  (2026, 'Subaru', 'Outback',         NULL, 40895, 'Gas'),
  (2026, 'Subaru', 'Uncharted',       NULL, 42995, 'BEV'),
  (2026, 'Subaru', 'Solterra',        NULL, 52495, 'BEV'),
  (2026, 'Subaru', 'Trailseeker',     NULL, 54995, 'BEV'),
  (2026, 'Subaru', 'Impreza',         NULL, 28295, 'Gas'),
  (2026, 'Subaru', 'Crosstrek',       NULL, 30595, 'Gas'),
  (2026, 'Subaru', 'BRZ',             NULL, 33395, 'Gas'),
  (2026, 'Subaru', 'WRX',             NULL, 38595, 'Gas');
