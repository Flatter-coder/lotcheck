-- 2026 Cadillac lineup — official "Starting at" MSRPs from cadillaccanada.ca.
-- Resets the earlier Cadillac seed (the LYRIQ rows used AutoTrader figures that
-- disagreed with Cadillac.ca — e.g. LYRIQ base 74,033 not 70,399) and reseeds
-- from the authoritative source. trim NULL = the model's starting MSRP: it
-- matches listings where the trim wasn't captured (the common walled-page case)
-- and never over-states a higher trim's overage (which would be a disputable,
-- unfair comparison). fuel_type fixes EV-rebate eligibility. Per-trim MSRPs would
-- need Cadillac.ca Build & Price and can be layered on later.
delete from public.msrp_catalog where make = 'Cadillac' and year in (2026, 2027);

insert into public.msrp_catalog (year, make, model, trim, msrp, fuel_type) values
  (2026,'Cadillac','OPTIQ',            null, 61033,  'BEV'),
  (2026,'Cadillac','LYRIQ',            null, 74033,  'BEV'),
  (2026,'Cadillac','VISTIQ',           null, 96633,  'BEV'),
  (2026,'Cadillac','Escalade IQ',      null, 161033, 'BEV'),
  (2026,'Cadillac','Escalade IQL',     null, 164533, 'BEV'),
  (2026,'Cadillac','OPTIQ-V',          null, 82533,  'BEV'),
  (2026,'Cadillac','LYRIQ-V',          null, 94933,  'BEV'),
  (2026,'Cadillac','XT5',              null, 54933,  'Gas'),
  (2026,'Cadillac','Escalade',         null, 130047, 'Gas'),
  (2026,'Cadillac','Escalade ESV',     null, 134247, 'Gas'),
  (2026,'Cadillac','Escalade-V',       null, 236870, 'Gas'),
  (2026,'Cadillac','CT5',              null, 62333,  'Gas'),
  (2026,'Cadillac','CT5-V',            null, 74233,  'Gas'),
  (2026,'Cadillac','CT5-V Blackwing',  null, 118407, 'Gas'),
  (2026,'Cadillac','CT4',              null, 47433,  'Gas'),
  (2026,'Cadillac','CT4-V',            null, 61533,  'Gas'),
  (2026,'Cadillac','CT4-V Blackwing',  null, 76533,  'Gas'),
  -- 2027 EVs (fuel type only; add 2027 MSRPs when available)
  (2027,'Cadillac','OPTIQ',            null, null,   'BEV'),
  (2027,'Cadillac','LYRIQ',            null, null,   'BEV'),
  (2027,'Cadillac','VISTIQ',           null, null,   'BEV'),
  (2027,'Cadillac','Escalade IQ',      null, null,   'BEV'),
  (2027,'Cadillac','Escalade IQL',     null, null,   'BEV'),
  (2027,'Cadillac','OPTIQ-V',          null, null,   'BEV'),
  (2027,'Cadillac','LYRIQ-V',          null, null,   'BEV');
