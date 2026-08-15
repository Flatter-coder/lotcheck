-- ============================================================================
-- 2026 RAV4 Woodland — the fifth hybrid trim.
--
-- The file supplied earlier as "2026-rav4-Woodland.pdf" was a PRODUCT SUMMARY
-- with ZERO dollar figures in 16 pages, so Woodland was withheld. The Build &
-- Price summary has the pricing table, and it reconciles exactly:
--
--   MSRP $47,000 + $3,861.40 = $50,861.40  (printed cash subtotal, to the cent)
--
-- Same adds as every other RAV4 hybrid: $797.40 block heater + $1,930 freight
-- + $999 max dealer fee + $100 A/C + $25 tire levy + $10 AMVIC.
--
-- Round MSRP and no premium-paint line in the build, so unlike the XSE there is
-- no paint baked in — $47,000 is the trim price.
--
-- Completes the ladder, in the order Toyota's own comparison page lists it:
--   LE $37,500 · XLE $41,300 · WOODLAND $47,000 · XSE $50,900 · Limited $52,350
--
-- Seeded under BOTH model names for the same reason as the others: the 2026
-- RAV4 is hybrid-only, Toyota publishes both "RAV4" and "RAV4 Hybrid", and a
-- listing that says "Hybrid" or "HEV" cannot match a row called plain "RAV4".
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  (2026,'Toyota','RAV4','Woodland', 47000, 50861.40,'Hybrid',null,'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',797.40),
     'captured_from','toyota.ca Build & Price summary (Alberta)')),
  (2026,'Toyota','RAV4 Hybrid','Woodland', 47000, 50861.40,'Hybrid',null,'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,'alias_of','RAV4',
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',797.40),
     'captured_from','toyota.ca Build & Price summary (Alberta)'))
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

select model, "trim", msrp, all_in_price, all_in_price - msrp as adds
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model in ('RAV4','RAV4 Hybrid')
order by model, msrp;
