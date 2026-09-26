-- The per-dealer comparison: for one year, make and model, each Alberta dealer's
-- asking prices beside the fees that same dealer publishes -- and the fee facts
-- split by new and used, because a dealer's two ladders differ.
--
-- WHY THE CONDITION COLUMN. 20260925c keyed a dealer's fees without it. Taza
-- Park Volkswagen's feed, 2026-09-25: Admin Fee $500 on every new car, Doc Fee
-- $899 on every used one. Keyed without condition, a used-car comparison would
-- have carried the new-car admin fee. Rows written before the crawler tagged
-- condition read 'unknown' and are never offered as either.
--
-- WHY (Vic 2026-09-25): "i need comparing catalogs pricing for each dealers to
-- compare price, fees, freight & pdi, ready for new and used cars". Freight &
-- PDI rides in the same fee statement where a dealer itemises it (label
-- freight_pdi), so it is compared the same way -- per dealer, in its own words.

alter table public.dealer_fee_observation
  add column if not exists condition text not null default 'unknown'
  check (condition in ('new', 'used', 'unknown'));

alter table public.dealer_fee_observation drop constraint if exists dealer_fee_observation_pkey;
alter table public.dealer_fee_observation
  add constraint dealer_fee_observation_pkey primary key (dealer_id, observed_on, condition, basis, fee_name, amount);

-- The fee catalogue, now per condition.
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
             'fees', jsonb_agg(jsonb_build_object('condition', r.condition, 'basis', r.basis, 'name', r.fee_name,
                                                  'label', r.fee_label, 'amount', r.amount, 'vehicles', r.vehicles)
                               order by r.condition, r.basis, r.fee_label, r.vehicles desc),
             'source', min(r.source)) as x
      from rows r join public.dealer_source ds on ds.id = r.dealer_id
     group by ds.id, ds.name, ds.city, ds.host
  ) t
$$;

revoke all on function public.fn_dealer_fee_catalog() from public;
grant execute on function public.fn_dealer_fee_catalog() to anon, authenticated, service_role;

-- One row per dealer listing this year/make/model (and condition, when given):
-- how many cars, the lowest and middle asking price, the odometer range, and the
-- cash-price fees that dealer states for that condition on its latest day read.
-- Cars come from fn_listing_once (one car once, group feeds excluded); a car two
-- dealers list has no single dealer and is left out here rather than guessed.
create or replace function public.fn_dealer_price_compare(p_year integer, p_make text, p_model text, p_condition text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with cars as (
    select c.dealer_id, c.condition, coalesce(c.sale_price, c.list_price) as price, c.odometer_km
      from public.fn_listing_once(null) c
     where c.year = p_year and lower(c.make) = lower(p_make) and lower(c.model) = lower(p_model)
       and (p_condition is null or c.condition = p_condition)
       and c.dealer_id is not null and coalesce(c.sale_price, c.list_price) > 0
  ),
  per_dealer as (
    select dealer_id, condition, count(*) as cars, min(price) as lowest,
           round((percentile_cont(0.5) within group (order by price))::numeric) as middle,
           min(odometer_km) as km_low, max(odometer_km) as km_high
      from cars group by dealer_id, condition
  ),
  latest as (
    select dealer_id, max(observed_on) as d from public.dealer_fee_observation group by dealer_id
  ),
  fees as (
    select o.dealer_id, o.condition,
           jsonb_agg(jsonb_build_object('name', o.fee_name, 'label', o.fee_label, 'amount', o.amount, 'vehicles', o.vehicles)
                     order by o.fee_label, o.vehicles desc) as fees
      from public.dealer_fee_observation o join latest l on l.dealer_id = o.dealer_id and l.d = o.observed_on
     where o.basis = 'cash' and o.condition in ('new', 'used')
     group by o.dealer_id, o.condition
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'dealer', ds.name, 'city', ds.city, 'condition', p.condition, 'cars', p.cars,
           'lowest', p.lowest, 'middle', p.middle, 'kmLow', p.km_low, 'kmHigh', p.km_high,
           'fees', f.fees, 'feesRead', f.fees is not null)
         order by p.lowest), '[]'::jsonb)
    from per_dealer p
    join public.dealer_source ds on ds.id = p.dealer_id
    left join fees f on f.dealer_id = p.dealer_id and f.condition = p.condition
$$;

revoke all on function public.fn_dealer_price_compare(integer, text, text, text) from public;
grant execute on function public.fn_dealer_price_compare(integer, text, text, text) to anon, authenticated, service_role;
