-- ============================================================================
-- 2026 Lexus NX 350 (GAS) — official Canadian MSRP + Alberta all-in, captured
-- from Lexus Canada's own Build & Price pricing panel on 2026-09-15.
--
-- WHY THIS EXISTS. msrp_catalog held ELEVEN 2026 Lexus NX rows and not one of
-- them was a gas car: six NX Hybrid, five NX Plug-in Hybrid, zero NX 350. A
-- real listing exposed it — a 2023 NX 350 F SPORT, the 2.4L turbo — and the
-- only "NX" ladder we could have matched it against was a different powertrain.
-- [[powertrain-identity-rule]] is a HARD RULE precisely because that match is
-- how the IONIQ 9 false accusation happened, so the honest answer on that
-- report was "we hold nothing comparable". This closes the hole.
--
-- The tell is visible in the existing rows: every gas Lexus RX and TX row has
-- all_in_price NULL while every hybrid row has one. The gas capture was a
-- separate, later pass that did not compute the all-in — and the NX simply was
-- not in it.
--
-- WHY A MIGRATION AND NOT A SCRAPE. Lexus's Build & Price is client-rendered
-- and its pricing panel needs three clicks (Summary -> PRICING -> Cash) before
-- the itemisation exists in the DOM. Until the capture job can drive that, a
-- hand-verified row with provenance outranks a scraper that returns nothing.
-- These rows carry source_url, so replaceRows' delete guard
-- (`&source_url=is.null`) will never remove them.
--
-- THE CAPTURE, verbatim. Lexus itemises a CONSTANT base MSRP plus a separate
-- package line, then the fees. For Premium (no package line):
--
--     MSRP                                    $55,080.00
--     Dealer Fees                                $995.00
--     Delivery and Destination Charge          $2,205.00
--     Air Conditioning Charge                    $100.00
--     AMVIC                                       $10.00
--     Tire Levy                                   $20.00
--     Environmental Handling Fee - Filters         $1.10
--     Environmental Handling Fee - Lube Oil        $1.08
--     SUBTOTAL                                $58,412.18
--
-- So the Alberta adds are $3,332.18, which is EXACTLY the difference our
-- existing Lexus rows already carry between msrp and all_in_price. Each row
-- below records the SUBTOTAL read off the panel, not a figure computed here;
-- the arithmetic is shown only so the next reader can check it.
--
-- PAYMENT TYPE MATTERS, and this is worth writing down. The same vehicle shows
-- three different totals on Lexus's own site:
--
--     $58,412.18   Cash        <- what is stored
--     $58,426.18   Lease       (+$14.00 PPSA Fee)
--     $58,430.18   model page  (+$14.00 PPSA + $4.00 PPSA Service Fee)
--
-- They are not a discrepancy; PPSA is a lien-registration fee that exists only
-- when the car is financed or leased. Cash is the basis that matches an
-- advertised all-in price, so Cash is what a listing may be compared against.
-- Storing the lease figure would put $14-$18 of financing cost into every
-- over/under claim.
--
-- SOURCE URL — MODEL LEVEL, DELIBERATELY. The builder does mint per-package
-- URLs (?model=HGCEZT&package=P|L|G|M|E|H), but they DO NOT ROUND-TRIP: a cold
-- load of `package=H` — which the app itself wrote for F SPORT 3 — renders
-- EXECUTIVE. Verified in a clean tab on 2026-09-15. Shipping those links would
-- send a buyer to the wrong configuration, which is the exact hazard
-- 20260815_seed_rav4_phev_msrp.sql refused to take. `?year=2026&series=NX`
-- cold-loads to the NX 350 gas builder with all six packages priced, so that is
-- the link a buyer gets.
--
-- BASIS: `excl_freight` for msrp (Lexus's own MSRP line is before every fee
-- listed above); all_in_price carries the Alberta all-in.
-- DRIVETRAIN: AWD across the NX 350 line ("Full-Time AWD", Lexus key features).
-- POWERTRAIN: Gas. It must never inherit NX Hybrid or NX Plug-in Hybrid money.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at)
values
  -- trim MSRP = $55,080 base + Lexus's own package line; all_in = panel SUBTOTAL.
  (2026, 'Lexus', 'NX', 'Premium',      55080, 58412.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now()),
  (2026, 'Lexus', 'NX', 'Luxury',       59219, 62551.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now()),
  (2026, 'Lexus', 'NX', 'F SPORT 2',    62262, 65594.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now()),
  (2026, 'Lexus', 'NX', 'Ultra Luxury', 63187, 66519.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now()),
  (2026, 'Lexus', 'NX', 'Executive',    68453, 71785.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now()),
  (2026, 'Lexus', 'NX', 'F SPORT 3',    68653, 71985.18, 'Gas', 'AWD', 'excl_freight',
   'https://www.lexus.ca/en/build-price/nx/?year=2026&series=NX', now())
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      fetched_at   = now();

-- ---------------------------------------------------------------------------
-- The package lines Lexus publishes, recorded so the next capture can check
-- that the ladder still adds up rather than re-deriving it:
--
--   Premium      + $0.00        Ultra Luxury + $8,107.00
--   Luxury       + $4,139.00    Executive    + $13,373.00
--   F SPORT 2    + $7,182.00    F SPORT 3    + $13,573.00
--
-- Package codes observed in the builder's own URL after selecting each one:
-- P / L / G / M / E / H. Recorded for the capture job to use INSIDE a session;
-- they are not safe as cold links (see above).
--
-- STILL OPEN after this file: the other 52 model families that hold
-- electrified rows and no gas row, and the 1,321 rows across 28 makes with no
-- all_in_price at all. Those need the capture job, not more migrations.
-- ---------------------------------------------------------------------------
