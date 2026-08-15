-- ============================================================================
-- 2026 RAV4 Plug-in Hybrid — official Canadian MSRP, hand-verified.
--
-- WHY THIS IS A MIGRATION AND NOT A SCRAPE. msrp_catalog held NO RAV4 of any
-- kind on 2026-08-15: the Toyota scraper returned 7 rows (bZ, bZ Woodland,
-- C-HR) instead of the lineup, the old code deleted the make on the strength of
-- it, and the run reported success. The refresh bugs are fixed
-- (scripts/lib/catalog-io.mjs, 2026-08-15) but the Toyota SOURCE still only
-- yields those 7 models, so the gap does not close by itself.
--
-- These rows carry a `source_url`, which means replaceRows' delete guard
-- (`&source_url=is.null`) will never remove them. Hand-verified provenance
-- outranks a scraper.
--
-- SOURCE: Toyota Canada's pricing announcement, confirmed against three Build &
-- Price summaries (SE AWD, XSE AWD, GR SPORT AWD).
-- https://media.toyota.ca/en/releases/2026/toyota-canada-announces-pricing-for-the-all-new-2026-toyota-rav4.html
--
-- source_url points at the BUILD & PRICE page rather than the press release,
-- because that is the page a buyer can open and check the number on themselves.
-- The report links it, so a claim is never something the reader has to take on
-- trust: https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/
--
-- BASIS: `excl_freight`. Toyota's release states the MSRP column is the vehicle
-- price BEFORE freight/PDI, A/C charge, dealer fees and other charges — those
-- appear in a separate "Vehicle Price" column. Recording the basis is the whole
-- point: comparing an AMVIC all-in advertised price against an ex-freight MSRP
-- invents a markup that is not there.
--
-- Alberta all-in, from the Build & Price summary for this model line
-- (msrp-source-build-and-price.md): MSRP + $1,930 delivery & destination +
-- $100 A/C + $10 AMVIC + $25 tire levy + up to $999 dealer fees = MSRP + $3,064.
--
-- DRIVETRAIN: the RAV4 Plug-in Hybrid is AWD across the lineup — the rear axle
-- is driven by its own electric motor. It is recorded explicitly so the trim
-- matcher can never grant an `exact` match drivetrain-blind, which is a defect
-- that has already shipped once.
--
-- POWERTRAIN: fuel_type is PHEV. A plug-in hybrid must NEVER inherit the gas
-- RAV4's MSRP; they are different vehicles at different prices.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, fuel_type, drivetrain, price_basis, source_url, fetched_at)
values
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'SE',                     48750, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/', now()),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'XSE',                    56400, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/', now()),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'GR SPORT',               57500, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/', now()),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'XSE Technology Package', 59350, 'PHEV', 'AWD', 'excl_freight',
   'https://media.toyota.ca/en/releases/2026/toyota-canada-announces-pricing-for-the-all-new-2026-toyota-rav4.html', now())
on conflict (year, make, model, trim) do update
  set msrp        = excluded.msrp,
      fuel_type   = excluded.fuel_type,
      drivetrain  = excluded.drivetrain,
      price_basis = excluded.price_basis,
      source_url  = excluded.source_url,
      fetched_at  = now();

-- ---------------------------------------------------------------------------
-- Worth recording, because it is the config problem in one line:
--
-- The Build & Price summary Vic generated for a GR SPORT AWD came back at
-- $58,405 — $905 above the $57,500 published trim MSRP above. The build carried
-- "Supersonic Red with Black Roof", a two-tone finish. The catalog prices a
-- TRIM; the buyer is looking at a CAR, and options sit on top.
--
-- This is exactly why an over/under claim is only made from an `exact` basis,
-- and why even then the report must invite the dealer to account for options
-- rather than assert the whole gap is markup.
-- ---------------------------------------------------------------------------
