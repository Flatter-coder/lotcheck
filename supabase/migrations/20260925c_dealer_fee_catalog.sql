-- Dealer fees, per named dealer, as each dealer publishes them.
--
-- WHY. Vic, 2026-09-25: "i need catalog for dealers fees". The fee a buyer is
-- quoted at the desk should be compared with what that same dealer publishes
-- on its own listings. SM360 dealers state it on every vehicle, in the dealer's
-- own words ("Cash purchase selling price ($49,990.00) includes: Doc Fee
-- ($899.00), AMVIC Levies ($10.00)"), read by the nightly crawl and parsed by
-- _shared/sm360-fees.js.
--
-- WHY NAMED, when fee_observation (20260806) is de-identified: that table holds
-- what USERS' quotes showed, which is theirs. This one holds what a dealer
-- advertises to the public on its own site -- a business's published price
-- terms, not anyone's personal information.
--
-- ONE ROW per dealer, day, payment basis, fee name and amount, with how many
-- of that day's vehicles stated it -- so "$899 on 24 of 24 cars" and "$899 on
-- 3, $499 on 21" read as the different facts they are.

create table if not exists public.dealer_fee_observation (
  dealer_id    bigint  not null references public.dealer_source(id) on delete cascade,
  observed_on  date    not null,
  basis        text    not null check (basis in ('cash', 'finance', 'lease')),
  fee_name     text    not null check (length(btrim(fee_name)) > 0),
  fee_label    text    not null,
  amount       numeric not null check (amount > 0 and amount < 100000),
  vehicles     integer not null check (vehicles > 0),
  source       text    not null,
  primary key (dealer_id, observed_on, basis, fee_name, amount)
);

alter table public.dealer_fee_observation enable row level security;
revoke all on table public.dealer_fee_observation from anon, authenticated;

-- The catalogue: each dealer's fees on the latest day it was read, most-stated
-- amount per fee first. Readable by the app and the report at scan time.
create or replace function public.fn_dealer_fee_catalog()
returns jsonb language sql stable security definer set search_path = public as $$
  with latest as (
    select dealer_id, max(observed_on) as d from public.dealer_fee_observation group by dealer_id
  ),
  rows as (
    select o.* from public.dealer_fee_observation o join latest l on l.dealer_id = o.dealer_id and l.d = o.observed_on
  )
  select coalesce(jsonb_agg(x order by x->>'city', x->>'dealer'), '[]'::jsonb) from (
    select jsonb_build_object(
             'dealerId', ds.id, 'dealer', ds.name, 'city', ds.city, 'host', ds.host,
             'observedOn', max(r.observed_on),
             'fees', jsonb_agg(jsonb_build_object('basis', r.basis, 'name', r.fee_name, 'label', r.fee_label,
                                                  'amount', r.amount, 'vehicles', r.vehicles)
                               order by r.basis, r.fee_label, r.vehicles desc),
             'source', min(r.source)) as x
      from rows r join public.dealer_source ds on ds.id = r.dealer_id
     group by ds.id, ds.name, ds.city, ds.host
  ) t
$$;

revoke all on function public.fn_dealer_fee_catalog() from public;
grant execute on function public.fn_dealer_fee_catalog() to anon, authenticated, service_role;

comment on table public.dealer_fee_observation is
  'Fees each named dealer publishes on its own listings, per day and payment basis, with how many vehicles stated each amount. Read via fn_dealer_fee_catalog().';
