-- Mercedes-Benz / Audi / Volkswagen Canada MSRP catalog — base MSRP per model
-- (one NULL-trim row per model). Pre-freight base MSRP (CAD), researched
-- 2026-08-08. Source: The Car Guide (guideautoweb.com), whose "starting at"
-- figures were confirmed pre-freight (GLC $60,450 matches the dealer-itemized
-- "MSRP $60,450 / Freight & PDI $4,250" split). 2026 MY except rows marked 2025.
-- EQ / e-tron nameplates are BEV-only, stored under the bare nameplate.
-- Base gas trims of GLC/GLE/C/E/CLE are 48V mild-hybrid = "Gas" per convention.

DELETE FROM msrp_catalog WHERE make IN ('Mercedes-Benz','Audi','Volkswagen');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Mercedes-Benz
  (2026, 'Mercedes-Benz', 'GLC',                 NULL, 60450,  'Gas'),
  (2026, 'Mercedes-Benz', 'GLC Coupe',           NULL, 64600,  'Gas'),
  (2026, 'Mercedes-Benz', 'C-Class',             NULL, 54500,  'Gas'),
  (2026, 'Mercedes-Benz', 'E-Class',             NULL, 75550,  'Gas'),
  (2026, 'Mercedes-Benz', 'S-Class',             NULL, 149100, 'Gas'),
  (2026, 'Mercedes-Benz', 'CLA',                 NULL, 45000,  'Gas'),
  (2026, 'Mercedes-Benz', 'CLE',                 NULL, 64950,  'Gas'),
  (2026, 'Mercedes-Benz', 'GLA',                 NULL, 44500,  'Gas'),
  (2026, 'Mercedes-Benz', 'GLB',                 NULL, 48900,  'Gas'),
  (2026, 'Mercedes-Benz', 'GLE',                 NULL, 85400,  'Gas'),
  (2026, 'Mercedes-Benz', 'GLE Coupe',           NULL, 102800, 'Gas'),
  (2026, 'Mercedes-Benz', 'GLS',                 NULL, 121400, 'Gas'),
  (2026, 'Mercedes-Benz', 'G-Class',             NULL, 191900, 'Gas'),
  (2026, 'Mercedes-Benz', 'EQE',                 NULL, 83500,  'BEV'),
  (2026, 'Mercedes-Benz', 'EQE SUV',             NULL, 92800,  'BEV'),
  (2026, 'Mercedes-Benz', 'EQS',                 NULL, 133500, 'BEV'),
  (2026, 'Mercedes-Benz', 'EQS SUV',             NULL, 131800, 'BEV'),
  (2026, 'Mercedes-Benz', 'SL',                  NULL, 134550, 'Gas'),
  (2026, 'Mercedes-Benz', 'AMG GT',              NULL, 129900, 'Gas'),
  (2025, 'Mercedes-Benz', 'AMG GT 4-Door Coupe', NULL, 139900, 'Gas'),   -- (moderate) 2025 MY
  -- Audi
  (2026, 'Audi', 'A3',          NULL, 43950,  'Gas'),
  (2026, 'Audi', 'A5',          NULL, 59100,  'Gas'),
  (2026, 'Audi', 'A6',          NULL, 81700,  'Gas'),
  (2026, 'Audi', 'Q3',          NULL, 51800,  'Gas'),
  (2026, 'Audi', 'Q4 e-tron',   NULL, 59990,  'BEV'),
  (2026, 'Audi', 'Q5',          NULL, 59800,  'Gas'),
  (2026, 'Audi', 'Q7',          NULL, 77815,  'Gas'),
  (2026, 'Audi', 'Q8',          NULL, 94300,  'Gas'),
  (2026, 'Audi', 'e-tron GT',   NULL, 154000, 'BEV'),
  (2025, 'Audi', 'A6 e-tron',   NULL, 83645,  'BEV'),    -- (moderate) 2025 MY
  (2025, 'Audi', 'A7',          NULL, 88050,  'Gas'),    -- (moderate) discontinuation confirmed
  (2025, 'Audi', 'A8',          NULL, 106200, 'Gas'),    -- (moderate) orders ending
  (2025, 'Audi', 'Q6 e-tron',   NULL, 80445,  'BEV'),    -- (moderate) 2025 MY
  (2025, 'Audi', 'Q8 e-tron',   NULL, 97950,  'BEV'),    -- (moderate) being phased out
  -- Volkswagen
  (2026, 'Volkswagen', 'Jetta',             NULL, 27495, 'Gas'),
  (2026, 'Volkswagen', 'Golf GTI',          NULL, 37295, 'Gas'),
  (2026, 'Volkswagen', 'Golf R',            NULL, 51995, 'Gas'),
  (2026, 'Volkswagen', 'Taos',              NULL, 30595, 'Gas'),
  (2026, 'Volkswagen', 'Tiguan',            NULL, 36495, 'Gas'),
  (2026, 'Volkswagen', 'Atlas',             NULL, 55595, 'Gas'),
  (2026, 'Volkswagen', 'Atlas Cross Sport', NULL, 57495, 'Gas'),
  (2025, 'Volkswagen', 'ID. Buzz',          NULL, 77495, 'BEV');   -- (moderate) on hiatus for MY2026
