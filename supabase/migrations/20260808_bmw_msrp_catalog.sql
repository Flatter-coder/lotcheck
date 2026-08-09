-- BMW Canada MSRP catalog — base MSRP per model (one NULL-trim row per model).
-- Pre-freight base MSRP (CAD), researched 2026-08-08. Source: The Car Guide
-- (guideautoweb.com), which lists pre-freight base MSRP; iX3 from the official
-- BMW Group Canada press release. bmw.ca itself is a bot-walled SPA (timeouts).
-- Figures are 2025 MY except iX3 (2027, BMW's first firmly-priced Neue Klasse EV).
-- Canadian freight+PDI (~$3,000) is added on top of these at the dealer.
-- Watch item: X6 shows $93,100 (Car Guide) vs ~$94,300 (dealers/AutoTrader).

DELETE FROM msrp_catalog WHERE make = 'BMW';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  (2025, 'BMW', '2 Series', NULL, 49300,  'Gas'),
  (2025, 'BMW', '3 Series', NULL, 56900,  'Gas'),
  (2025, 'BMW', '4 Series', NULL, 58700,  'Gas'),
  (2025, 'BMW', '5 Series', NULL, 71200,  'Gas'),
  (2025, 'BMW', '7 Series', NULL, 142800, 'PHEV'),
  (2025, 'BMW', '8 Series', NULL, 122500, 'Gas'),
  (2025, 'BMW', 'X1',       NULL, 47500,  'Gas'),
  (2025, 'BMW', 'X2',       NULL, 49400,  'Gas'),
  (2025, 'BMW', 'X3',       NULL, 58900,  'Gas'),
  (2025, 'BMW', 'X4',       NULL, 60800,  'Gas'),
  (2025, 'BMW', 'X5',       NULL, 87100,  'Gas'),
  (2025, 'BMW', 'X6',       NULL, 93100,  'Gas'),
  (2025, 'BMW', 'X7',       NULL, 113500, 'Gas'),
  (2025, 'BMW', 'Z4',       NULL, 69000,  'Gas'),
  (2025, 'BMW', 'i4',       NULL, 54990,  'BEV'),
  (2025, 'BMW', 'i5',       NULL, 83700,  'BEV'),
  (2025, 'BMW', 'i7',       NULL, 151800, 'BEV'),
  (2025, 'BMW', 'iX',       NULL, 82000,  'BEV'),
  (2027, 'BMW', 'iX3',      NULL, 75900,  'BEV');
