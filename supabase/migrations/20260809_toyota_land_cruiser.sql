-- 2027 Toyota Land Cruiser — returned to Canada; absent from the catalog
-- (Okotoks Toyota scan showed MSRP blank). Trims per toyota.ca Choose-Your
-- page (captured 2026-08-09): 1958 from $75,450; Cruiser from $84,240
-- Features page lists Premium Package as its own priced configuration
-- ($90,615), so it gets a trim row. i-FORCE MAX hybrid only.

DELETE FROM msrp_catalog WHERE make = 'Toyota' AND model = 'Land Cruiser';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  (2027, 'Toyota', 'Land Cruiser', '1958',    75450, 'Hybrid'),
  (2027, 'Toyota', 'Land Cruiser', 'Cruiser', 84240, 'Hybrid'),
  (2027, 'Toyota', 'Land Cruiser', 'Premium Package', 90615, 'Hybrid');
