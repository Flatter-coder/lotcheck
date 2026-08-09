-- 2027 Cadillac VISTIQ per-trim MSRPs from Cadillac.ca Build & Price. Replaces
-- the single VISTIQ starting-price row with exact per-trim rows so a captured
-- trim resolves to its real MSRP (Luxury/Sport 96,633 · Premium Luxury 117,327 ·
-- Platinum 125,367). Exact-trim match runs first, so no containment mixups.
delete from public.msrp_catalog where make = 'Cadillac' and year = 2027 and model = 'VISTIQ';
insert into public.msrp_catalog (year, make, model, trim, msrp, fuel_type) values
  (2027,'Cadillac','VISTIQ','Luxury',        96633,  'BEV'),
  (2027,'Cadillac','VISTIQ','Sport',         96633,  'BEV'),
  (2027,'Cadillac','VISTIQ','Premium Luxury',117327, 'BEV'),
  (2027,'Cadillac','VISTIQ','Platinum',      125367, 'BEV');
