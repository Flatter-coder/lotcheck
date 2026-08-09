-- Lexus / Acura / Infiniti / Lincoln / Volvo Canada MSRP catalog — base MSRP per
-- model (one NULL-trim row per model). Pre-freight base MSRP (CAD), researched
-- 2026-08-08. Lexus from franchised-dealer build pages that split the "MSRP" line
-- from freight (+ official Lexus Canada releases for ES/RZ); Acura/Infiniti/Lincoln
-- from dealer build pages + AutoTrader.ca; Volvo from AutoTrader.ca research MSRP
-- only (volvocars.com is a JS build&price app) — all Volvo rows are (moderate).

DELETE FROM msrp_catalog WHERE make IN ('Lexus','Acura','Infiniti','Lincoln','Volvo');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Lexus (UX & ES are hybrid-only nameplates; RZ is BEV-only)
  (2026, 'Lexus', 'UX',        NULL, 45045,  'Hybrid'),
  (2026, 'Lexus', 'NX',        NULL, 55080,  'Gas'),
  (2026, 'Lexus', 'RX',        NULL, 60885,  'Gas'),
  (2026, 'Lexus', 'ES',        NULL, 59900,  'Hybrid'),
  (2026, 'Lexus', 'IS',        NULL, 56855,  'Gas'),
  (2026, 'Lexus', 'TX',        NULL, 69855,  'Gas'),
  (2026, 'Lexus', 'GX',        NULL, 87390,  'Gas'),
  (2026, 'Lexus', 'LX',        NULL, 124300, 'Gas'),
  (2026, 'Lexus', 'RZ',        NULL, 59990,  'BEV'),
  (2026, 'Lexus', 'LC',        NULL, 118180, 'Gas'),
  (2026, 'Lexus', 'LS',        NULL, 126800, 'Gas'),
  -- Acura
  (2026, 'Acura', 'Integra',   NULL, 41175,  'Gas'),
  (2026, 'Acura', 'ADX',       NULL, 46080,  'Gas'),
  (2026, 'Acura', 'RDX',       NULL, 54700,  'Gas'),
  (2026, 'Acura', 'MDX',       NULL, 68480,  'Gas'),
  -- Infiniti (entire Canadian lineup is gas)
  (2025, 'Infiniti', 'QX50',   NULL, 51745,  'Gas'),   -- final-year 2025
  (2025, 'Infiniti', 'QX55',   NULL, 57675,  'Gas'),   -- final-year 2025
  (2026, 'Infiniti', 'QX60',   NULL, 66945,  'Gas'),
  (2026, 'Infiniti', 'QX80',   NULL, 109590, 'Gas'),
  -- Lincoln
  (2026, 'Lincoln', 'Corsair', NULL, 50190,  'Gas'),
  (2026, 'Lincoln', 'Nautilus',NULL, 60850,  'Gas'),
  (2026, 'Lincoln', 'Aviator', NULL, 77700,  'Gas'),
  (2026, 'Lincoln', 'Navigator',NULL, 119495,'Gas'),
  -- Volvo (all rows moderate — AutoTrader.ca research MSRP; "Hybrid" = B4/B5/B6 48V mild-hybrid)
  (2025, 'Volvo', 'XC40',      NULL, 46900,  'Hybrid'),
  (2025, 'Volvo', 'XC60',      NULL, 55450,  'Hybrid'),
  (2025, 'Volvo', 'XC90',      NULL, 75550,  'Hybrid'),
  (2025, 'Volvo', 'S90',       NULL, 66700,  'Hybrid'),
  (2025, 'Volvo', 'EX30',      NULL, 53700,  'BEV'),
  (2025, 'Volvo', 'EX40',      NULL, 59950,  'BEV'),
  (2025, 'Volvo', 'EC40',      NULL, 59950,  'BEV'),
  (2025, 'Volvo', 'EX90',      NULL, 107985, 'BEV');
