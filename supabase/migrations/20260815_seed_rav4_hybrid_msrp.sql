-- ============================================================================
-- 2026 RAV4 (Hybrid) — official Canadian MSRP and Alberta all-in.
--
-- The 2026 RAV4 is hybrid-only, so `model = 'RAV4'` and the PHEV lives under
-- 'RAV4 Plug-in Hybrid'. Keeping them as separate models is deliberate: a
-- plug-in must never inherit the hybrid's price, which is the powertrain-
-- identity rule that produced a real false accusation once already.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15.
--
-- THE ALL-IN FORMULA IS DIFFERENT FROM THE PHEV'S, and this is the finding
-- worth remembering. Toyota's own Alberta pricing disclaimer on the GAS/HYBRID
-- RAV4 reads:
--
--   "...Delivery and Destination Charge of $1,930.00, Air Conditioning Charge
--    of $100.00, PREMIUM PLUG-IN BLOCK HEATER OF UP TO $797.40, AMVIC of
--    $10.00, Tire Levy of $25.00 ... and Dealer Fees of up to $999.00."
--
-- The PHEV disclaimer does not mention a block heater at all — a plug-in
-- already ships with a cord. So:
--
--   RAV4 Hybrid  all-in = MSRP + $3,861.40   (includes the $797.40 heater)
--   RAV4 PHEV    all-in = MSRP + $3,064.00
--
-- A single "adds" constant across the RAV4 line would therefore be wrong on
-- half of it by $797.40. This is exactly why all_in_price is stored PER ROW and
-- never computed.
--
-- Verified against the printed subtotals: LE $41,361.40, XLE $45,161.40,
-- Limited $56,211.40 all appear in their own PDFs to the cent.
--
-- DRIVETRAIN IS NULL ON PURPOSE. None of the summaries state AWD or FWD, and a
-- drivetrain-blind trim match has already shipped a wrong MSRP once. A null
-- means the matcher cannot grant an `exact` basis, which is the correct
-- conservative outcome until it is confirmed from an official source.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at)
values
  (2026,'Toyota','RAV4','LE',      37500, 41361.40,'Hybrid',null,'excl_freight','https://www.toyota.ca/en/build-price/rav4/',now()),
  (2026,'Toyota','RAV4','XLE',     41300, 45161.40,'Hybrid',null,'excl_freight','https://www.toyota.ca/en/build-price/rav4/',now()),
  -- Base XSE. The captured build read $51,805 because it carried "Wind Chill
  -- Pearl with Black Roof", listed on the same page as "+$905". Seeding the
  -- build figure would have baked one buyer's paint choice into the trim price
  -- — the precise config error this catalog exists to avoid.
  (2026,'Toyota','RAV4','XSE',     50900, 54761.40,'Hybrid',null,'excl_freight','https://www.toyota.ca/en/build-price/rav4/',now()),
  (2026,'Toyota','RAV4','Limited', 52350, 56211.40,'Hybrid',null,'excl_freight','https://www.toyota.ca/en/build-price/rav4/',now())
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      fetched_at   = now();

update public.msrp_catalog set
  attrs = coalesce(attrs, '{}'::jsonb) || jsonb_build_object(
    'province', 'AB',
    'all_in_breakdown', jsonb_build_object(
      'delivery_destination', 1930, 'dealer_fees_max', 999,
      'air_conditioning', 100, 'tire_levy', 25, 'amvic', 10,
      'block_heater', 797.40),
    'block_heater_included', true,
    'captured_from', 'toyota.ca Build & Price summary (Alberta)')
where make ilike 'Toyota' and model = 'RAV4' and year = 2026;

-- ---------------------------------------------------------------------------
-- WITHHELD, and why. Recorded so the work is not lost.
--
--   XLE Premium — the summary carries ONE line, "XLE Premium with Premium Paint
--     $2,849.00", on top of the $41,300 XLE. Package and paint are bundled, so
--     the package price alone cannot be separated (it is $1,944 if the paint is
--     the same $905, but that is arithmetic on an assumption, not a published
--     figure). Seeding $44,149 as a trim MSRP would embed a paint choice.
--
--   Woodland and "XSE - XSE Technology Package" — the files supplied are
--     PRODUCT SUMMARY spec sheets, not Build & Price summaries. Neither
--     contains a pricing table, so there is nothing to seed.
--
-- To close these, capture a Build & Price summary for each with STANDARD paint.
-- ---------------------------------------------------------------------------
