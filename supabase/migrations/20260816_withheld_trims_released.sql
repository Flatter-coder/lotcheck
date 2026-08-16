-- ============================================================================
-- The four withheld trims, released — every package line came back BARE.
--
-- SOURCE: Toyota Canada Build & Price pricing tables, Alberta, 2026-08-16.
-- All four reconcile to their printed CASH subtotal to the cent.
--
--   Crown Platinum            64,660 +     0 + 679 + 2,994 = 68,333  ✓
--   4Runner Hyb Platinum      69,207 + 5,922 + 682 + 3,064 = 78,875  ✓
--   4Runner Hyb TRD PRO       69,207 +12,731 + 682 + 3,064 = 85,684  ✓
--   Land Cruiser Premium Pkg  80,460 + 6,375 + 702 + 3,064 = 90,601  ✓
--
-- ---------------------------------------------------------------------------
-- THE PAINT RULE HELD, AND NOW PAYS OUT. Each of these was withheld because its
-- earlier capture read "<package> with Premium Paint". Recaptured in a no-cost
-- colour, the same package lines are BARE — which both releases the trim and
-- isolates the colour by subtraction:
--
--   4Runner Hyb Platinum   6,272 - 5,922 = $350   Supersonic Red
--   4Runner Hyb TRD PRO   13,501 -12,731 = $770   Wave Maker
--   Land Cruiser Premium   6,765 - 6,375 = $390   Heritage Blue two-tone
--
-- THAT $390 IS THE CONFIRMATION WORTH NOTING. It was derived this morning from
-- two Land Cruiser builds differing only in colour, and recorded as a
-- derivation. Toyota's own bare package line now produces the identical figure
-- from a different document. The method is sound, not just internally
-- consistent ([[msrp-exact-must-pin-config]]).
--
-- ---------------------------------------------------------------------------
-- AN EIGHTH BLOCK-HEATER VALUE, AND IT BREAKS THE PER-MODEL ASSUMPTION.
--
--   Crown Limited    $709.00
--   Crown Platinum   $679.00     <- SAME MODEL, $30 apart
--
-- Every prior value differed by NAMEPLATE. This one differs by TRIM inside one
-- nameplate, so "capture it per model" was too coarse. The full tally is now
-- $679 / $682 / $702 / $707 / $709 / $712 / $717 / $797.40, plus none at all on
-- a plug-in. There is no constant at any level; it is captured per build or it
-- is not recorded.
--
-- Freight is per model and holds: $1,860 on both Crowns, $1,930 on the rest.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  -- Crown Platinum. No package line and no paint line, and Toyota's own trim
  -- card reads "From $68,347" — exactly this build's LEASE subtotal — so this
  -- IS the configuration Toyota advertises, with no paid colour inside it.
  (2026,'Toyota','Crown','Platinum', 64660, 68333,'Hybrid','AWD','excl_freight',
   'https://www.toyota.ca/en/build-price/crown/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'engine','Hybrid MAX 2.4L turbo',
     'all_in_breakdown', jsonb_build_object('delivery_destination',1860,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',679),
     'build_code','UC7IH9',
     'captured_from','toyota.ca Build & Price pricing table (Alberta); trim card From $68,347 equals this build''s lease subtotal')),

  (2026,'Toyota','4Runner Hybrid','Platinum', 75129, 78875,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/4runner/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,'seats',5,
     'base_msrp',69207,'package_price',5922,'package_line','Platinum',
     'premium_paint_supersonic_red',350,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',682),
     'captured_from','toyota.ca Build & Price, bare package line (no-cost colour)')),

  (2026,'Toyota','4Runner Hybrid','TRD PRO', 81938, 85684,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/4runner/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,'seats',5,
     'base_msrp',69207,'package_price',12731,'package_line','TRD PRO',
     'premium_paint_wave_maker',770,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',682),
     'captured_from','toyota.ca Build & Price, bare package line (no-cost colour)')),

  (2027,'Toyota','Land Cruiser','Premium Package', 86835, 90601,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/land-cruiser/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'base_msrp',80460,'package_price',6375,'package_line','Land Cruiser Premium Package',
     'premium_paint_two_tone',390,
     'paint_premium_confirmed_two_ways','derived from a colour-pair on 2026-08-15, confirmed by this bare package line',
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',702),
     'captured_from','toyota.ca Build & Price, bare package line (no-cost colour)'))
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- Rates, per model line and per product. The 4Runner Hybrid and Land Cruiser
-- share 6.89/60 lease and 5.69/72 finance; the Crown is 5.49/60 and 4.89/72.
insert into public.finance_rate_catalog
  (make, model, apr, term_months, promo, effective_date, source_url)
values
  ('Toyota','4Runner Hybrid', 5.69, 72, false, date '2026-08-30','https://www.toyota.ca/en/build-price/4runner/'),
  ('Toyota','4Runner Hybrid', 6.89, 60, false, date '2026-08-30','https://www.toyota.ca/en/build-price/4runner/'),
  ('Toyota','Land Cruiser',   5.69, 72, false, date '2026-08-30','https://www.toyota.ca/en/build-price/land-cruiser/'),
  ('Toyota','Land Cruiser',   6.89, 60, false, date '2026-08-30','https://www.toyota.ca/en/build-price/land-cruiser/')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- ACCESSORY CORRECTION. 20260815_seed_crown_accessories.sql seeded the Crown
-- block heater at $709 with trim NULL, which accessory_catalog defines as "the
-- price is identical across every trim we captured". The Platinum charges $679,
-- so that claim is false and the NULL row is replaced by two trim-keyed rows.
--
-- The dash camera is $847.20 on the Limited and $847.21 on the Platinum — one
-- cent, same model, different trim. Trivially dismissible and wrong to dismiss:
-- it is the clearest possible evidence that these are per-BUILD price lists.
-- ---------------------------------------------------------------------------
delete from public.accessory_catalog
 where year = 2026 and make = 'Toyota' and model = 'Crown' and trim is null
   and name in ('Premium Plug-In Block Heater','Toyota Genuine Dash Camera Series 2.0 - Front Camera');

insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','Crown','Limited', 'Premium Plug-In Block Heater',709.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Platinum','Premium Plug-In Block Heater',679.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Limited', 'Toyota Genuine Dash Camera Series 2.0 - Front Camera',847.20,'electronics',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Platinum','Toyota Genuine Dash Camera Series 2.0 - Front Camera',847.21,'electronics',false,true,'https://www.toyota.ca/en/build-price/crown/'),

  -- Crown Platinum accessories captured in full (14 items on the page).
  (2026,'Toyota','Crown','Platinum','Cargo Mat',206.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Platinum','Cargo Net',106.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Platinum','Rear Bumper Applique',153.44,'exterior',false,true,'https://www.toyota.ca/en/build-price/crown/'),
  (2026,'Toyota','Crown','Platinum','Pro Series Paint Protection Film - Door Cup',123.44,'protection',false,true,'https://www.toyota.ca/en/build-price/crown/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

-- Toyota's full 2026/2027 ladder as we now hold it.
select year, model, "trim", msrp, all_in_price,
       attrs->'all_in_breakdown'->>'delivery_destination' as freight,
       attrs->'all_in_breakdown'->>'block_heater' as block_heater
from public.msrp_catalog
where make ilike 'Toyota' and year in (2026, 2027)
order by model, msrp;

-- Anything still keyed trim-NULL that we now know varies by trim.
select model, "trim", name, price
from public.accessory_catalog
where make ilike 'Toyota' and name in ('Premium Plug-In Block Heater','Toyota Genuine Dash Camera Series 2.0 - Front Camera')
order by model, name, "trim" nulls first;
