-- 2026 Cadillac LYRIQ — msrp_catalog seed (MSRP + fuel type).
-- MSRPs: AutoTrader.ca research (2026 LYRIQ, CAD starting prices). Verify against
-- cadillaccanada.ca before relying on them. The LYRIQ is fully electric, so
-- fuel_type='BEV' makes applyVerifiedFuelType resolve it for EVERY trim -> the
-- EV/PHEV rebate check runs (previously 'NOT ELIGIBLE' because fuel type was unknown).
-- Idempotent: skips a (year,make,model,trim) row that already exists.
insert into public.msrp_catalog (year, make, model, trim, msrp, fuel_type)
select v.year, v.make, v.model, v.trim, v.msrp, v.fuel_type
from (values
  (2026,'Cadillac','LYRIQ','Luxury',70399,'BEV'),
  (2026,'Cadillac','LYRIQ','Sport',70399,'BEV'),
  (2026,'Cadillac','LYRIQ','Premium Luxury',78999,'BEV'),
  (2026,'Cadillac','LYRIQ','Premium Sport',78999,'BEV'),
  (2026,'Cadillac','LYRIQ','Signature Luxury',84499,'BEV'),
  (2026,'Cadillac','LYRIQ','Signature Sport',84499,'BEV'),
  (2026,'Cadillac','LYRIQ','LYRIQ-V',91299,'BEV'),
  (2026,'Cadillac','LYRIQ','LYRIQ-V Premium',97399,'BEV')
) as v(year, make, model, trim, msrp, fuel_type)
where not exists (
  select 1 from public.msrp_catalog m
  where m.year = v.year and m.make = v.make and m.model = v.model and m.trim = v.trim
);

-- Optional — Cadillac advertised finance rate. The listing showed 3.9% APR, but
-- confirm the current official rate/term at cadillaccanada.ca before enabling:
-- insert into public.finance_rate_catalog (make, model, apr, term_months, promo, effective_date)
-- values ('Cadillac', 'LYRIQ', 3.9, 60, 'advertised', '2026-08-06');
