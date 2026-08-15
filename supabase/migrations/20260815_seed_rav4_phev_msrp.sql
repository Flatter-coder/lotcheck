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
-- source_url is a DEEP LINK to the exact configuration, not the model page, so
-- a buyer clicking it lands on this precise trim rather than having to find it.
-- The report renders the link, which is what makes a claim checkable instead of
-- something the reader takes on trust.
--
-- THE URL PATTERN (Vic, 2026-08-15) — this is the important discovery:
--
--   /en/build-price/rav4-plug-in-hybrid/?year=2026&model=<TRIM>&package=<P>&exterior=<COLOUR>
--
--   model=SERAPC   SE          package=A   Standard Package
--   model=XERAPC   XSE         exterior=02VP  Pearl White  (+$905)
--   model=GRRAPC   GR SPORT    exterior=0M22
--
-- The configuration space is ENUMERABLE: trim code x package x exterior, each
-- URL yielding one deterministic price. And it decodes the other direction too
-- — a Build & Price PDF's "REFERENCE CODE: GRRAPC AE 02TB" is the same three
-- fields, so a PDF a buyer forwards us identifies its exact configuration.
--
-- Caveat measured the same day: the page is CLIENT-RENDERED. A plain fetch
-- returns navigation and no dollar figures, so harvesting prices from these
-- URLs needs a rendered page (or the JSON endpoint behind it), not a cheap GET.
-- That is the cost question for any enumeration plan.
--
-- Premium paint is +$905, which is exactly the gap between the published
-- GR SPORT MSRP ($57,500) and the Build & Price summary Vic generated
-- ($58,405). The catalog prices a TRIM; the buyer is looking at a CAR.
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
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/?year=2026&model=SERAPC&package=A', now()),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'XSE',                    56400, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/?year=2026&model=XERAPC&package=A', now()),
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'GR SPORT',               57500, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/?year=2026&model=GRRAPC&package=A', now()),
  -- No package param: the Technology Package code is not known, and inventing
  -- one would send a buyer to the wrong configuration. This lands them on the
  -- XSE where both packages are shown. Missing beats wrong, links included.
  (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'XSE Technology Package', 59350, 'PHEV', 'AWD', 'excl_freight',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/?year=2026&model=XERAPC', now())
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
