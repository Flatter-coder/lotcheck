-- ============================================================================
-- 2026 Corolla Cross — official Canadian MSRP and Alberta all-in.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15.
-- Every all-in figure below is DERIVED FROM THE PRINTED CASH SUBTOTAL in its
-- own summary, not from a formula applied across the line. That distinction is
-- the whole point of this file.
--
-- THE BLOCK HEATER IS A THIRD DIFFERENT NUMBER. Toyota fits a Premium Plug-In
-- Block Heater as standard on Alberta builds and folds it into the published
-- all-in price. It is NOT one amount:
--
--     RAV4 Hybrid            $797.40
--     Corolla Cross (gas)    $707.00
--     Corolla Cross Hybrid   $712.00
--     RAV4 Plug-in Hybrid    none at all — a plug-in ships with a cord
--
-- Four models, four answers, and the gas/hybrid Corolla Cross differ by $5 on
-- the SAME nameplate. Anyone computing all-in as "MSRP + a constant" is wrong
-- on almost every row. Capture it per row or leave all_in_price null.
--
-- UNLIKE THE RAV4, DRIVETRAIN IS PUBLISHED HERE, and it is priced: L FWD is
-- $29,180 and L AWD is $30,580 — $1,400 apart on the same trim name. So
-- drivetrain lives BOTH in `trim` (because msrp_catalog is unique on
-- year+make+model+trim, and "L" alone would collide) and in the `drivetrain`
-- column, so the matcher can use it. Dealers list them the same way:
-- "Corolla Cross LE AWD".
--
-- GAS AND HYBRID ARE SEPARATE MODELS, and here that genuinely matters: unlike
-- the 2026 RAV4, the Corolla Cross is sold in BOTH. A hybrid must never reach
-- a gas row or vice versa — powertrainCompatible enforces it, and the $5,545
-- gap between LE AWD ($31,905) and Hybrid XSE AWD ($39,525) is why.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at)
values
  -- Gasoline. Alberta adds = $3,771 ($707 block heater + $1,930 freight
  -- + $999 max dealer fee + $100 A/C + $25 tire levy + $10 AMVIC).
  (2026,'Toyota','Corolla Cross','L FWD',   29180, 32951,'Gas','FWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross/',now()),
  (2026,'Toyota','Corolla Cross','L AWD',   30580, 34351,'Gas','AWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross/',now()),
  (2026,'Toyota','Corolla Cross','LE FWD',  31235, 35006,'Gas','FWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross/',now()),
  (2026,'Toyota','Corolla Cross','LE AWD',  31905, 35676,'Gas','AWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross/',now()),
  (2026,'Toyota','Corolla Cross','XLE AWD', 38485, 42256,'Gas','AWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross/',now()),

  -- Hybrid. Alberta adds = $3,776 — the block heater is $712 here, $5 more
  -- than the gas car's. Same nameplate, different number.
  (2026,'Toyota','Corolla Cross Hybrid','SE AWD',  37050, 40826,'Hybrid','AWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross-hybrid/',now()),
  (2026,'Toyota','Corolla Cross Hybrid','XSE AWD', 39525, 43301,'Hybrid','AWD','excl_freight','https://www.toyota.ca/en/build-price/corolla-cross-hybrid/',now())
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      fetched_at   = now();

update public.msrp_catalog set
  attrs = coalesce(attrs, '{}'::jsonb) || jsonb_build_object(
    'province', 'AB',
    'all_in_breakdown', jsonb_build_object(
      'delivery_destination', 1930, 'dealer_fees_max', 999,
      'air_conditioning', 100, 'tire_levy', 25, 'amvic', 10,
      'block_heater', case when model = 'Corolla Cross Hybrid' then 712 else 707 end),
    'block_heater_included', true,
    'captured_from', 'toyota.ca Build & Price summary (Alberta)')
where make ilike 'Toyota' and year = 2026
  and model in ('Corolla Cross','Corolla Cross Hybrid');

-- ---------------------------------------------------------------------------
-- WITHHELD: LE Premium AWD. The summary carries ONE line — "LE Premium AWD with
-- Premium Paint $2,575.00" — on top of the $31,905 LE AWD, so the package price
-- cannot be separated from the paint using published figures. Its cash subtotal
-- is $38,251, which reconciles exactly ($31,905 + $2,575 + $707 + $3,064), but
-- seeding $34,480 as a trim MSRP would embed a paint choice. Same shape as the
-- RAV4 XLE Premium.
--
-- Also supplied but unusable: "2026-corolla cross-LE FWD.pdf" is a PRODUCT
-- SUMMARY spec sheet with no pricing table.
-- ---------------------------------------------------------------------------
