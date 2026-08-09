-- Cadillac EV fuel types (fact-only, no MSRP) — makes applyVerifiedFuelType
-- resolve 'BEV' for Cadillac's electric models so the EV/PHEV rebate check runs
-- instead of defaulting to 'NOT ELIGIBLE'. LYRIQ is seeded with its trims+MSRPs
-- separately; these are fuel-type-only rows (msrp NULL) for the other EVs, which
-- are EXCLUDED from MSRP lookups (that path requires msrp NOT NULL). Gas Cadillacs
-- (XT5/CT4/CT5/Escalade) need no row — non-BEV already reads as N/A (gas).
-- MSRPs for these are intentionally omitted: AutoTrader shows dealer-listing
-- prices, not official MSRP, and Cadillac.ca blocks automated access. Seed real
-- MSRPs from an authoritative source before adding them. Idempotent.
insert into public.msrp_catalog (year, make, model, trim, msrp, fuel_type)
select v.year, v.make, v.model, null::text, null::numeric, 'BEV'
from (values
  (2026,'Cadillac','Optiq'),(2027,'Cadillac','Optiq'),
  (2026,'Cadillac','Escalade IQ'),(2027,'Cadillac','Escalade IQ'),
  (2026,'Cadillac','Escalade IQL'),(2027,'Cadillac','Escalade IQL')
) as v(year, make, model)
where not exists (
  select 1 from public.msrp_catalog m
  where m.year=v.year and m.make=v.make and m.model=v.model and m.trim is null
);
