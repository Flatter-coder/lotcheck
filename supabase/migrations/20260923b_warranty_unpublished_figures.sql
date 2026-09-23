-- Three figures we publish that the manufacturer does not.
--
-- These are DELETIONS, on a table that feeds a signed document a buyer hands to
-- a dealer, so the standard is not "we could not find it" -- it is "somebody
-- tried hard to find it and could not". Each one below was handed to an agent
-- whose instruction was to PROVE THE DELETION WRONG, and then to a second,
-- independent searcher told not to limit itself to the first one's URLs. The
-- URL counts are what those searches actually opened.
--
-- The same round SAVED one figure from being deleted -- see the Infiniti
-- corrosion note at the bottom -- which is the reason the round exists.
--
-- ============================================================================
-- 1. JAGUAR powertrain_coverage = '4-year/80,000 km'  ->  NULL
-- ============================================================================
-- Jaguar Canada publishes NO separate powertrain term. The word "powertrain"
-- appears on none of its Canadian warranty pages. What it publishes is one
-- term, verbatim:
--
--     "Every new Jaguar vehicle is covered by a New Vehicle Limited Warranty
--      for 4 years or 80,000 km, whichever comes first."
--
-- So our powertrain figure is the NVLW figure wearing a powertrain label. It is
-- not wrong about the car -- it is wrong about WHICH COVER it names, and point
-- 09 of the ten exists to tell a buyer what specific cover is left.
-- [[warranty-remaining-name-the-component]]
--
-- 23 URLs opened by the first search, then an independent second search that
-- started from web search rather than that list and added the French-Canadian
-- page, the CPO page and the US Passport to Service PDF as a cross-check.
-- Both concluded the same. Confirmed locally too: probe-warranty-page.mjs
-- reports powertrain_coverage as not_covered on BOTH Jaguar warranty pages.
update public.manufacturer_warranties
set powertrain_coverage = null,
    notes = coalesce(notes || ' ', '')
      || 'powertrain_coverage removed 2026-09-23: Jaguar Canada publishes no separate '
      || 'powertrain term. The word does not appear on any of its Canadian warranty '
      || 'pages; it publishes one New Vehicle Limited Warranty of 4 years/80,000 km, '
      || 'which basic_coverage already holds. The removed value was that same figure '
      || 'relabelled. Two independent searches, 23+ URLs.'
where make = 'Jaguar';

-- ============================================================================
-- 2. MINI powertrain_coverage = '4-year/80,000 km'  ->  NULL
-- ============================================================================
-- Same shape, with a sharper edge. MINI Canada publishes no NEW-car powertrain
-- term either. The only powertrain figure anywhere on mini.ca belongs to a
-- USED-car programme, verbatim from https://mini.ca/en/shopping/mini-next:
--
--     "all MINI Certified Pre-Owned vehicles include comprehensive coverage of
--      either a balance of the New Vehicle Limited Warranty for up to 4 years
--      or 80,000 kms, whichever comes first, or a 5-year and Unlimited
--      kilometres Powertrain Limited Warranty from the vehicle in-service date"
--
-- A CPO term printed as a new-car term is the defect class this catalogue was
-- built to stop: the right document, read correctly, about something else.
-- [[ai-defamation-entity-match-lesson]]
--
-- There is a second powertrain figure on mini.ca and it is worse -- MINI
-- Mechanical Breakdown Protection sells a tier literally named POWERTRAIN, up
-- to 7 years/200,000 km. It is a purchased plan, obligated by BMW Canada with
-- LGM Financial Services as administrator, and its own brochure says it applies
-- BEYOND the factory warranty and excludes what the factory covers. Neither
-- figure is a factory term.
--
-- 37 URLs opened across the two searches.
update public.manufacturer_warranties
set powertrain_coverage = null,
    notes = coalesce(notes || ' ', '')
      || 'powertrain_coverage removed 2026-09-23: MINI Canada publishes no separate '
      || 'new-car powertrain term. The only powertrain figures on mini.ca are a '
      || 'CERTIFIED PRE-OWNED term (5 years/unlimited km) and a purchased Mechanical '
      || 'Breakdown Protection tier (up to 7 years/200,000 km) -- neither is factory '
      || 'cover on a new vehicle. basic_coverage already holds the 4-year/80,000 km '
      || 'New Car Limited Warranty. Two independent searches, 37 URLs.'
where make = 'MINI';

-- ============================================================================
-- 3. INFINITI roadside_assistance = '4-year/unlimited km'  ->  '4-year'
-- ============================================================================
-- The four years are Infiniti's. The kilometres are ours.
--
-- The 2027 Warranty Information Booklet states the term and no distance:
--
--     "INFINITI Roadside Assistance is provided for all INFINITI vehicles from
--      the date the vehicle is delivered to the first retail buyer or put into
--      service (whichever occurs first) for a period of 48 months"
--
-- and on its opening page, "Our standard 4-year Roadside Assistance program".
-- Neither carries a distance. Verified here rather than taken on report: the
-- booklet was fetched through politeFetch and read with lib/pdf-text.mjs --
-- 255,448 characters of text layer, and the word "unlimited" appears ZERO
-- times in it.
--
-- Roadside is also not part of the New Vehicle Limited Warranty coverage chart,
-- so the chart discussed below does not state a distance for it either.
--
-- This is the MINI and Polestar rust rows again (migration 20260922b): silence
-- about distance read as "unlimited". parseCoverage already carries
-- kmExplicitlyUnlimited so the report says the maker publishes no kilometre
-- limit rather than implying the distance is uncapped.
update public.manufacturer_warranties
set roadside_assistance = '4-year',
    notes = coalesce(notes || ' ', '')
      || 'roadside_assistance distance removed 2026-09-23: the 2027 INFINITI Warranty '
      || 'Information Booklet states "for a period of 48 months" and "our standard '
      || '4-year Roadside Assistance program" and publishes NO distance limit for it. '
      || 'The word "unlimited" does not appear anywhere in the booklet text (255,448 '
      || 'characters read via lib/pdf-text.mjs). The years stay; the "/unlimited km" '
      || 'was ours, not theirs.'
where make = 'Infiniti';

-- ============================================================================
-- WHAT IS DELIBERATELY NOT CHANGED HERE
-- ============================================================================
-- INFINITI corrosion_coverage = '7-year/unlimited km' STAYS, and the round that
-- produced the three deletions above is what saved it.
--
-- The first pass concluded "unlimited appears nowhere in the booklet, delete
-- it" -- and that is true of the TEXT LAYER, which is the evidence the deletion
-- was built on. The adversarial searcher rendered page 5 at 500 dpi and found
-- the New Vehicle Limited Warranty coverage chart, which reads:
--
--     Corrosion Surface        4 years/100,000 kms
--     Corrosion Perforation    7 years/unlimited kms
--
-- The chart is an embedded JPEG 2000 image (XObject /Im0, /JPXDecode), so
-- pdftotext and our own pdf-text.mjs both return nothing from it. The figure is
-- published, it is against PERFORATION rather than surface, and it matches what
-- we hold exactly. Deleting it would have removed a correct figure on the
-- strength of our reader's blind spot. [[supervised-correctness-is-not-correctness]]
--
-- INFINITI source_url IS STILL A 404, and is left that way on purpose. Pointing
-- it at the booklet fixes the dead link but makes corrosion report DRIFTED --
-- an accusation that Infiniti dropped a term they still publish, every twelve
-- hours -- because the only place the distance appears is that raster chart.
-- Trading a dead citation for a false accusation is the wrong trade.
--
-- There is also an unresolved conflict between two Infiniti pages: the booklet
-- supports 48 months/100,000 km basic, while
-- /owners/warranties-and-protection/overview.html states that MY2027 QX60 and
-- QX65 carry 48 months or 48,000 km and MY2027 QX80 carries 48 months or
-- 64,000 km. If the web page is right we are OVERSTATING a QX60 buyer's
-- remaining cover by 52,000 km, which is the direction that hurts a buyer. The
-- schema already has the model/year_from/year_to dimension added for Tesla in
-- 20260912, so it can express this -- but which figure binds is a question
-- about Infiniti's own documents, not a schema question, and it is not being
-- guessed at here.
--
-- ACURA roadside_assistance is untouched. Its stored page states no roadside
-- term and Acura's dedicated roadside page is client-rendered: 6,241 characters
-- of extractable body text containing no year, month or distance at all.
-- "uncited" is the truthful status, and a research pass that claimed the term
-- was server-rendered there was wrong -- checked with probe-warranty-page.mjs
-- before it could become a migration citing a page that states nothing.
