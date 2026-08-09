-- Hyundai / Kia / Genesis / Mitsubishi Canada MSRP catalog — base MSRP per model
-- (one NULL-trim row per model). Pre-freight base MSRP (CAD), researched
-- 2026-08-08. Mitsubishi confirmed on mitsubishi-motors.ca; Kia from unhaggle
-- (mirrors kia.ca starting MSRP) + kia.ca for EV4; Hyundai from Canadian
-- editorial/press (hyundaicanada.com renders prices via JS); Genesis from
-- AutoTrader.ca MSRP tables (genesis config bundles freight/fees).
-- Single-powertrain nameplates stored under the bare name: Santa Fe & Sonata are
-- HYBRID-ONLY in Canada for 2026, so a "Santa Fe"/"Sonata" listing resolves here.
-- Rows tagged (moderate) are aggregator/dealer figures, not OEM-confirmed.

DELETE FROM msrp_catalog WHERE make IN ('Hyundai','Kia','Genesis','Mitsubishi');

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  -- Hyundai
  (2026, 'Hyundai', 'Venue',                NULL, 21999, 'Gas'),
  (2026, 'Hyundai', 'Kona',                 NULL, 26749, 'Gas'),
  (2026, 'Hyundai', 'Kona Electric',        NULL, 43999, 'BEV'),
  (2026, 'Hyundai', 'Elantra',              NULL, 22999, 'Gas'),
  (2026, 'Hyundai', 'Elantra N',            NULL, 40199, 'Gas'),
  (2026, 'Hyundai', 'Tucson',               NULL, 35099, 'Gas'),
  (2026, 'Hyundai', 'Tucson Hybrid',        NULL, 43799, 'Hybrid'),      -- (moderate) verify vs Santa Fe overlap
  (2026, 'Hyundai', 'Tucson Plug-in Hybrid',NULL, 52297, 'PHEV'),        -- (moderate) dealer all-in, likely ~$50k pre-freight
  (2026, 'Hyundai', 'Santa Fe',             NULL, 43799, 'Hybrid'),      -- hybrid-only 2026
  (2026, 'Hyundai', 'Sonata',               NULL, 36199, 'Hybrid'),      -- hybrid-only in Canada
  (2026, 'Hyundai', 'Elantra Hybrid',       NULL, 31999, 'Hybrid'),      -- (moderate) base Preferred may be ~$30,999
  (2026, 'Hyundai', 'Ioniq 5',              NULL, 58490, 'BEV'),
  (2025, 'Hyundai', 'Ioniq 6',              NULL, 54999, 'BEV'),         -- (moderate) no 2026 MY; 2025 base
  (2026, 'Hyundai', 'Ioniq 9',              NULL, 59999, 'BEV'),
  (2026, 'Hyundai', 'Palisade',             NULL, 53699, 'Gas'),
  (2026, 'Hyundai', 'Palisade Hybrid',      NULL, 60499, 'Hybrid'),
  -- Kia
  (2026, 'Kia', 'K4',                       NULL, 24295, 'Gas'),
  (2026, 'Kia', 'Seltos',                   NULL, 26095, 'Gas'),
  (2026, 'Kia', 'Niro',                     NULL, 30845, 'Hybrid'),
  (2026, 'Kia', 'Niro PHEV',                NULL, 36845, 'PHEV'),
  (2026, 'Kia', 'Niro EV',                  NULL, 45595, 'BEV'),
  (2026, 'Kia', 'Sportage',                 NULL, 32295, 'Gas'),
  (2026, 'Kia', 'Sportage Hybrid',          NULL, 41495, 'Hybrid'),
  (2026, 'Kia', 'Sportage Plug-in Hybrid',  NULL, 46395, 'PHEV'),
  (2026, 'Kia', 'Sorento Hybrid',           NULL, 43695, 'Hybrid'),
  (2026, 'Kia', 'Sorento Plug-in Hybrid',   NULL, 48695, 'PHEV'),
  (2025, 'Kia', 'Sorento',                  NULL, 38995, 'Gas'),         -- (moderate) no 2026 gas MY; 2025 base
  (2026, 'Kia', 'Carnival',                 NULL, 42445, 'Gas'),
  (2026, 'Kia', 'Carnival Hybrid',          NULL, 48395, 'Hybrid'),
  (2026, 'Kia', 'EV4',                      NULL, 38995, 'BEV'),
  (2026, 'Kia', 'EV6',                      NULL, 56495, 'BEV'),         -- (moderate) base Light may be ~$48,995
  (2026, 'Kia', 'EV9',                      NULL, 59995, 'BEV'),
  (2025, 'Kia', 'Telluride',                NULL, 50995, 'Gas'),         -- (moderate) no 2026 MY; 2025 base
  -- Genesis
  (2026, 'Genesis', 'G70',                  NULL, 56000, 'Gas'),
  (2026, 'Genesis', 'G80',                  NULL, 74500, 'Gas'),
  (2026, 'Genesis', 'G90',                  NULL, 118000,'Gas'),
  (2026, 'Genesis', 'GV60',                 NULL, 75600, 'BEV'),         -- (moderate)
  (2026, 'Genesis', 'GV70',                 NULL, 60000, 'Gas'),
  (2026, 'Genesis', 'Electrified GV70',     NULL, 78500, 'BEV'),
  (2026, 'Genesis', 'GV80',                 NULL, 76500, 'Gas'),
  (2026, 'Genesis', 'GV80 Coupe',           NULL, 87000, 'Gas'),
  -- Mitsubishi
  (2026, 'Mitsubishi', 'RVR',               NULL, 24998, 'Gas'),
  (2026, 'Mitsubishi', 'Eclipse Cross',     NULL, 29798, 'Gas'),
  (2026, 'Mitsubishi', 'Outlander',         NULL, 36398, 'Gas'),
  (2026, 'Mitsubishi', 'Outlander PHEV',    NULL, 49998, 'PHEV');
