-- 2027 Toyota Land Cruiser — returned to Canada; absent from the catalog
-- (Okotoks Toyota scan showed MSRP blank). Trims per toyota.ca Choose-Your
-- page (captured 2026-08-09): 1958 from $75,450; Cruiser from $84,240
-- (Premium Package +$6,375 is an option, not a trim). i-FORCE MAX hybrid only.

DELETE FROM msrp_catalog WHERE make = 'Toyota' AND model = 'Land Cruiser';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  (2027, 'Toyota', 'Land Cruiser', '1958',    75450, 'Hybrid'),
  (2027, 'Toyota', 'Land Cruiser', 'Cruiser', 84240, 'Hybrid');
