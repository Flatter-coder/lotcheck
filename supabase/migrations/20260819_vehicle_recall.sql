-- ============================================================================
-- DAILY RECALL CHECK — state for scripts/check-recalls-daily.mjs
--
-- WHY ANYTHING IS STORED AT ALL. Until now the Transport Canada lookup ran only
-- inside a live report (analyze-quote / analyze-listing-url / search-recalls),
-- and its answer was never kept. That is correct for a report — it is always
-- fresh — but it means a recall issued the day AFTER a buyer's report is
-- invisible to them: they hold a signed document saying "no open recalls" that
-- was true when signed and is not true now. Detecting "NEW" requires yesterday
-- to still exist somewhere, so it lives here.
--
-- WHAT IS **NOT** STORED HERE. No buyer, no report, no VIN, no listing, nothing
-- that identifies a person. These rows are public Government of Canada facts
-- about vehicle MODELS, keyed by make/model/year. The "nothing is stored"
-- promise in the product copy is about the buyer's data and is untouched by
-- this table — a recall on a 2024 RAV4 is a fact about the RAV4, not about
-- anyone who looked one up.
--
-- STAYS RLS-LOCKED WITH NO ANON GRANT. Same posture as city_dealer_index and
-- vehicle_listing: the sweep script (service role) writes it, and the edge
-- functions keep querying TC live rather than reading a cache — a cached recall
-- answer in a buyer's report would be a staler claim than the one we make
-- today, which is the opposite of the point.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One row per (recall, make, model, year). A single recall number covers many
-- models and years; a buyer only cares about the intersection that is theirs,
-- so that intersection is the key rather than the recall number alone.
-- ---------------------------------------------------------------------------
create table if not exists public.vehicle_recall (
  id             bigint generated always as identity primary key,
  recall_number  text    not null,
  make           text    not null,          -- our canonical make (makes.ts)
  tc_make        text,                      -- exactly what TC called it
  manufacturer   text,
  model          text    not null,          -- exactly what TC called it
  year           integer not null,
  recall_date    date,                      -- null when TC's date is unparseable; never guessed
  -- Provenance of our knowledge, not of the recall. first_seen_at is what makes
  -- "new" meaningful; it is set once and never moved by a later sweep.
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (recall_number, make, model, year)
);
alter table public.vehicle_recall enable row level security;
revoke all on public.vehicle_recall from anon, authenticated;

create index if not exists ix_vehicle_recall_lookup
  on public.vehicle_recall(make, model, year);
-- The "what landed recently" query the staged alert is built from.
create index if not exists ix_vehicle_recall_first_seen
  on public.vehicle_recall(first_seen_at desc);

-- ---------------------------------------------------------------------------
-- Per-make audit of every sweep. This table is the reason a green run can be
-- believed: without it, "the job succeeded" only means the process exited 0,
-- which is exactly the green-signal-no-check shape that let a daily StatCan job
-- sit dead in a dotless directory for 46 days.
--
-- A make that could not be read is recorded as such. It is NOT recorded as
-- "0 recalls" and it does NOT overwrite that make's rows, because an
-- unreachable registry and a registry with nothing in it must never render the
-- same way — that is the fail-safe contract in _shared/recalls.ts, applied to
-- the sweep.
-- ---------------------------------------------------------------------------
create table if not exists public.recall_sweep (
  id             bigint generated always as identity primary key,
  swept_at       timestamptz not null default now(),
  make           text    not null,
  -- ok | unreachable | http_error | bad_json | bad_shape | truncated | refused
  status         text    not null,
  detail         text,
  rows_returned  integer,                   -- raw rows TC handed back
  recalls_total  integer,                   -- distinct (recall,model,year) after parsing
  recalls_new    integer,                   -- newly seen this sweep
  wrote          boolean not null default false
);
alter table public.recall_sweep enable row level security;
revoke all on public.recall_sweep from anon, authenticated;

create index if not exists ix_recall_sweep_recent
  on public.recall_sweep(swept_at desc, make);

comment on table public.vehicle_recall is
  'Transport Canada VRDB recalls by make/model/year. Public government facts about vehicle models — contains no buyer, report, VIN or listing data.';
comment on table public.recall_sweep is
  'Per-make audit of each daily sweep. An unreachable make is recorded as unreachable and its rows are left untouched — never rewritten as zero recalls.';
