-- Fix: on cadillaccanada.ca the OPTIQ / VISTIQ / OPTIQ-V cards had the 2027 tab
-- selected, so their "Starting at" figures were 2027 prices — but the lineup seed
-- filed them under 2026. Move the MSRP to 2027 and clear the (unknown) 2026 MSRP,
-- keeping fuel_type on both years so EV-rebate still resolves. The 2026 MSRPs for
-- these three are simply not yet known (defer, don't guess).
update public.msrp_catalog set msrp = null
  where make = 'Cadillac' and year = 2026 and model in ('OPTIQ','VISTIQ','OPTIQ-V');
update public.msrp_catalog set msrp = 61033 where make='Cadillac' and year=2027 and model='OPTIQ';
update public.msrp_catalog set msrp = 96633 where make='Cadillac' and year=2027 and model='VISTIQ';
update public.msrp_catalog set msrp = 82533 where make='Cadillac' and year=2027 and model='OPTIQ-V';
