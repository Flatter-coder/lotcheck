-- ============================================================================
-- 2026 Crown accessories — and Toyota's OWN price for the F&I products.
--
-- SOURCE: Toyota Canada Build & Price "Suggestions For You", Crown Limited,
-- Alberta, 2026-08-15.
--
-- ---------------------------------------------------------------------------
-- THE PROTECTION PLANS ARE THE VALUABLE PART, and they are a different kind of
-- number from anything captured so far.
--
--     ECP Platinum Plan          60 months / 100,000 km     $2,644
--     ECP Tire & Rim Road Hazard 5 years                    $  589
--     Wear Pass Plus             lease only                 $1,299
--
-- These are the finance-office products — extended warranty, tire-and-rim,
-- lease wear protection — sold in the back room after the price is agreed,
-- where the buyer has no reference point and the markup is largest. Until now
-- a dealer quoting $4,200 for "the extended warranty" could not be answered
-- with anything better than "that sounds high".
--
-- Now it can be answered with Toyota's own published figure and a link. That is
-- the same move as MSRP-vs-asking, applied to the part of the deal nobody
-- publishes ([[reference-point-model]] — the manufacturer is always the
-- reference, and we never estimate one).
--
-- HOW THE REPORT MAY USE THEM, and the limit. Toyota's price is what TOYOTA
-- charges for THAT plan at THAT term. A dealer may sell a third-party product
-- that is not this plan at all, so the claim is "here is Toyota's published
-- price for their own equivalent coverage", never "you were overcharged". The
-- term/coverage string is stored with the price precisely so a report cannot
-- compare a 60/100,000 plan against a 96/160,000 one.
--
-- Stored in accessory_catalog under category 'protection_plan' rather than a
-- new table: same key, same provenance columns, and the report filters by
-- category. `install_included` is meaningless for these and left true.
--
-- ---------------------------------------------------------------------------
-- CARGO LINER, THIRD PRICE ON A THIRD MODEL: $196.80 here, $201.80 on the
-- Crown Signia, $216.80 on the 4Runner Hybrid. Same name, three numbers — the
-- reason `model` is a hard key on this table.
--
-- The block heater is $709 and marked included: it sits INSIDE Toyota's
-- published all-in, so a dealer itemising it is charging for something the
-- advertised price already contains.
-- ============================================================================

insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','Crown',null,'Pro Series Paint Protection Film - Hood',578.00,'protection',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown',null,'Cargo Liner',196.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown',null,'Premium Plug-In Block Heater',709.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/crown/'),

  -- Finance-office products. Term and coverage are IN THE NAME so a report can
  -- never compare unlike plans and call the difference a markup.
  (2026,'Toyota','Crown',null,'ECP Platinum Plan (60 months / 100,000 km)',2644.00,'protection_plan',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown',null,'ECP Tire & Rim Road Hazard Protection (5 years)',589.00,'protection_plan',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown',null,'Wear Pass Plus (lease only)',1299.00,'protection_plan',false,true,'https://www.toyota.ca/en/build-price/crown/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

-- The same part across models. Run this before assuming any price transfers.
select name,
       max(price) filter (where model = 'RAV4')           as rav4,
       max(price) filter (where model = '4Runner')        as runner_gas,
       max(price) filter (where model = '4Runner Hybrid') as runner_hyb,
       max(price) filter (where model = 'Crown Signia')   as signia,
       max(price) filter (where model = 'Crown')          as crown
from public.accessory_catalog
where make ilike 'Toyota'
group by name
having count(distinct model) > 1 and min(price) <> max(price)
order by name;

-- What the finance office will try to sell, with Toyota's own price beside it.
select model, name, price
from public.accessory_catalog
where category = 'protection_plan'
order by model, price desc;
