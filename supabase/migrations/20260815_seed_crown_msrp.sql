-- ============================================================================
-- 2026 Crown Limited — and the summary that broke the freight constant.
--
-- SOURCE: Toyota Canada Build & Price pricing table, Alberta, 2026-08-15.
-- Reconciles to the printed CASH subtotal exactly:
--
--     55,227 + 709 block heater + 999 + 1,860 + 100 + 10 + 25 = 58,930   ✓ printed
--
-- ---------------------------------------------------------------------------
-- DELIVERY AND DESTINATION IS $1,860 HERE. Every other model captured today
-- prints $1,930. It was a hardcoded constant in scripts/lib/bp-summary.mjs, so
-- every Crown figure computed from it was $70 wrong before this row existed.
--
-- Freight is now REQUIRED input to reconciles() and corroborateWithLineup() —
-- an absent figure refuses rather than borrowing another model's. That is the
-- second constant to fall today; the block heater was the first, and is now on
-- its SEVENTH distinct value:
--
--     RAV4 Hybrid            $797.40        Corolla Cross (gas)    $707.00
--     Crown Signia           $717.00        Land Cruiser           $702.00
--     Corolla Cross Hybrid   $712.00        4Runner / 4Runner Hyb  $682.00
--     Crown                  $709.00        RAV4 Plug-in           none
--
-- The pattern worth naming: EVERY figure in Toyota's Alberta formula is
-- per-model until proven otherwise. Only the dealer-fee cap ($999), A/C ($100),
-- AMVIC ($10) and tire levy ($25) have held across all eight captures, and
-- those are treated as observed-stable rather than guaranteed — reconciles()
-- fails loudly if one moves, which is exactly how the freight difference
-- surfaced instead of being absorbed into the MSRP.
--
-- ON THE COLOUR, honestly. The screenshots do not show the exterior, so the
-- gate's normal rule would refuse. What licenses this row is a bound, not an
-- assumption: Toyota's own trim card prints "From $58,914" for the Crown
-- Limited, and this build's subtotals are $58,930 cash / $58,948 finance. At
-- most $16–$34 separates this build from Toyota's published floor, and the
-- smallest premium colour ever observed is $350 (RAV4 Ruby Flare Pearl). A
-- premium colour therefore cannot be hiding in the $55,227.
--
-- THAT $16–$34 IS NOT EXPLAINED, and is recorded rather than rounded away. On
-- the Crown Signia and Land Cruiser the trim card sat exactly at
-- MSRP + block heater + adds + $18 PPSA. Here it does not, by a small amount,
-- so the lineup-corroboration formula is NOT claimed for this row. Worth
-- resolving before that formula is relied on more widely.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  (2026,'Toyota','Crown','Limited', 55227, 58930,'Hybrid','AWD','excl_freight',
   'https://www.toyota.ca/en/build-price/crown/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1860,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',709),
     'all_in_basis','printed CASH subtotal, read directly from the summary',
     'engine','2.5L Dynamic Force 4-cyl THS',
     'unexplained_trim_card_delta','Toyota trim card reads From $58,914 vs $58,930 cash / $58,948 finance',
     'captured_from','toyota.ca Build & Price pricing table (Alberta)'))
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- Toyota's published rates for this line, both with the Aug 30 2026 expiry.
-- Note they DIFFER by product: 4.89% finance / 72 against 5.49% lease / 60. A
-- report comparing a dealer's finance rate to a lease rate would be wrong by
-- 60 basis points, so term and product are stored, never just "the APR".
insert into public.finance_rate_catalog
  (make, model, apr, term_months, promo, effective_date, source_url)
values
  ('Toyota', 'Crown', 4.89, 72, false, date '2026-08-30', 'https://www.toyota.ca/en/build-price/crown/'),
  ('Toyota', 'Crown', 5.49, 60, false, date '2026-08-30', 'https://www.toyota.ca/en/build-price/crown/')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- WITHHELD: Crown Platinum. The trim card gives "From $68,347" but no pricing
-- table, so its MSRP line, its block heater and its freight are all unread.
-- It is also a DIFFERENT ENGINE — Hybrid MAX 2.4L turbo against the Limited's
-- 2.5L THS — so nothing about the Limited transfers to it.
--
-- LEASE DETAIL worth capturing when the lease side is built out: 60 months,
-- 20,000 km/yr, lease-end value $16,732.20 PLUS a $300 dealer lease-end option
-- fee. That $300 is the kind of line a buyer never sees until the end.
-- ---------------------------------------------------------------------------

select year, model, "trim", msrp, all_in_price,
       attrs->'all_in_breakdown'->>'delivery_destination' as freight,
       attrs->'all_in_breakdown'->>'block_heater' as block_heater
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026
order by model, msrp;
