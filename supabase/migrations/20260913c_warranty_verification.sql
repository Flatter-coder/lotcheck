-- ============================================================================
-- The warranty catalogue records when it was last checked against its source.
--
-- Vic, 2026-09-13: "fix warranty catalog, 6am and midnight".
--
-- manufacturer_warranties holds 35 makes. Every figure in it was typed by hand
-- from a manufacturer's official Canadian page, and until today there was NO
-- refresh job of any kind -- not stale, never checked. Point 09 of the ten tells
-- a buyer what factory cover is left on a specific car and whether it transfers
-- to them. That claim rested on a row nobody had re-read since it was written.
--
-- The cost is on the record: the hand-written Tesla row read "8-year/160,000 km
-- (battery & drive unit, varies by model)". 160,000 km is the Extended Service
-- Agreement ceiling, not the battery term. On a 2020 Model X at 198,909 km we
-- told a buyer the cover was used up. It had 41,091 km left.
--
-- These four columns are what scripts/verify-warranty-catalog.mjs writes twice a
-- day. They record whether the manufacturer's own page still states our figures.
-- They never hold a corrected figure: a regex confident enough to overwrite a
-- warranty term is confident enough to invent one, and an invented warranty term
-- is a false statement about a named vehicle in a document a buyer carries into
-- a dealership. Drift goes red and a human fixes it by migration.
-- [[every-point-has-a-catalogue]] [[claims-must-stay-backed]]
-- ============================================================================

alter table public.manufacturer_warranties
  add column if not exists last_verified_at timestamptz,
  add column if not exists verify_status    text,
  add column if not exists verify_note      text,
  add column if not exists verify_http      integer;

comment on column public.manufacturer_warranties.last_verified_at is
  'When the manufacturer''s own page was last re-read and compared to these figures. NULL means never -- which is what every row was before 2026-09-13.';
comment on column public.manufacturer_warranties.verify_status is
  'confirmed | drifted | unreachable | no_source | unparsed | empty_row. "unreachable" is OUR failure to read the page and must never be presented as the manufacturer having changed anything.';
comment on column public.manufacturer_warranties.verify_note is
  'Human-readable result. On drift it names the field and the stored value, and says explicitly that nothing was auto-corrected.';

-- Which rows are least trustworthy right now: never checked first, then oldest.
create index if not exists ix_warranties_verified
  on public.manufacturer_warranties (last_verified_at nulls first);

-- ---- receipt ---------------------------------------------------------------
-- Applying this shows the starting position: every row unverified.
select count(*)                                             as makes,
       count(*) filter (where source_url is null)           as citing_nothing,
       count(*) filter (where last_verified_at is null)     as never_verified
  from public.manufacturer_warranties;
