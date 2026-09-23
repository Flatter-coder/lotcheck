-- One source_url per row cannot express how manufacturers actually publish.
--
-- WHAT THIS IS FOR. manufacturer_warranties holds five coverage figures per make
-- and ONE url to back all five. Measured on 2026-09-23 with
-- scripts/probe-warranty-page.mjs, which runs a live page through the nightly
-- job's own reader rather than a browser:
--
--   LEXUS
--     https://www.lexus.ca/en/know-your-lexus/coverage/new-vehicle-warranty/
--       -> basic, powertrain, corrosion   CONFIRMED
--       -> roadside                       not covered on that page at all
--     https://www.lexus.ca/en/know-your-lexus/coverage/roadside-assistance/
--       -> "roadside assistance covers 48 months with unlimited kms"
--       -> and, in the coverage table: "new vehicles 48 months/unlimited kms"
--
--   JAGUAR
--     .../jdx/ownership/warranties/new-vehicle-limited-warranty.html
--       -> basic CONFIRMED, corrosion CONFIRMED (6-year/unlimited-mileage
--          corrosion perforation), roadside NOT covered
--     .../jdx/ownership/warranty/index.html
--       -> "fully comprehensive manufacturer warranty and roadside assistance
--          for 4 years or 80,000 km, whichever comes first"
--       -> roadside CONFIRMED, corrosion NOT covered
--
-- Neither make publishes one page carrying everything. So moving source_url to
-- the page that states roadside UN-cites the other figures: it trades one false
-- "uncited" for three. Both were reported as OUR data to fix, and neither was.
--
-- WHAT IT DOES NOT DO. It does not change a single coverage figure. Every value
-- in this table still comes from a human reading a manufacturer page, and the
-- verifier still refuses to rewrite one. This only records WHICH document backs
-- WHICH figure, which is a fact we already knew and had nowhere to put.
--
-- THE FALLBACK IS THE POINT. field_sources is null for 37 of 39 makes and stays
-- null. sourceForField() returns source_url whenever a field has no entry, so
-- the behaviour of every other row is unchanged, including the ones blocked by
-- a WAF and the two that cite a printed booklet.
--
-- COST: two extra HTTP requests per run, both to pages we already had reason to
-- read. The request ledger printed at the end of every run accounts for them.

alter table public.manufacturer_warranties
  add column if not exists field_sources jsonb;

comment on column public.manufacturer_warranties.field_sources is
  'Per-figure source URL, as {"roadside_assistance": "https://..."}. Null, or a '
  'missing key, means the figure is backed by source_url. Exists because a maker '
  'may publish one warranty on one page and another on a second page, and a row '
  'with a single url reports the second figure as uncited -- which reads as our '
  'data being wrong when it is not. Never used to store a figure, only a citation.';

-- LEXUS: roadside is on the roadside page, verbatim "48 months with unlimited kms".
update public.manufacturer_warranties
set field_sources = jsonb_build_object(
      'roadside_assistance',
      'https://www.lexus.ca/en/know-your-lexus/coverage/roadside-assistance/'),
    notes = coalesce(notes || ' ', '')
      || 'Roadside is cited separately: the new-vehicle-warranty page states basic, '
      || 'powertrain and corrosion but no roadside term, and Lexus publishes '
      || '"48 months with unlimited kms" on its roadside-assistance page. Captured 2026-09-23.'
where make = 'Lexus';

-- JAGUAR: roadside is on the warranty index; basic and corrosion stay on the
-- New Vehicle Limited Warranty page, which is where source_url already points.
update public.manufacturer_warranties
set field_sources = jsonb_build_object(
      'roadside_assistance',
      'https://www.jaguar.com/en-ca/jdx/ownership/warranty/index.html'),
    notes = coalesce(notes || ' ', '')
      || 'Roadside is cited separately: the New Vehicle Limited Warranty page states '
      || 'basic and corrosion but no roadside term, and Jaguar publishes "roadside '
      || 'assistance for 4 years or 80,000 km, whichever comes first" on its warranty '
      || 'index. Captured 2026-09-23. Jaguar Canada publishes NO separate powertrain '
      || 'term -- the word does not appear on any of its Canadian warranty pages -- so '
      || 'powertrain_coverage remains unsourced and is deliberately NOT given a '
      || 'field_source here; it is a data question, not a citation one.'
where make = 'Jaguar';
