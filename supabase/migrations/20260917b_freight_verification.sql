-- ============================================================================
-- WHEN DID EACH FREIGHT FIGURE LAST AGREE WITH ITS SOURCE?
--
-- Vic, 2026-09-17, on a 2026 BMW X3 at BMW Royal Oak:
--
--     MSRP              $60,400.00
--     Freight and PDI    $4,395.00
--
-- 7.3% of MSRP -- $1,625 above the highest freight figure the catalogue held for
-- ANY make (Volvo XC60, $2,770) and 2.3x the lowest (Toyota RAV4, $1,930). His
-- read was that freight differs drastically between makers and nobody watches
-- it. He was right: the catalogue held 11 of 35 makes and had no refresh job.
--
-- WHY THE FIGURES THEMSELVES ARE NOT IN THIS TABLE. The freight catalogue lives
-- in supabase/functions/_shared/fee-schedule.ts as reviewed constants, each with
-- its source and capture date, locked by test:fee-schedule. That is deliberate
-- and it stays: these numbers feed a markup claim a buyer makes to a dealer's
-- face, and a value that can be auto-written by a scraper is a value nobody
-- reviewed. Compare warranty, where the same reasoning keeps 39 hand-typed
-- figures in a table that the verifier may READ and never WRITE.
--
-- What this table holds is the one thing code cannot: WHEN the manufacturer's
-- own page last agreed with the constant, and what it said if it did not. A row
-- nobody has re-read in six months is a claim with no current backing, and
-- without this the report cannot tell that apart from one checked this morning.
--
-- IT RECORDS, IT NEVER CORRECTS. verify-freight-catalog.mjs writes here and
-- never touches fee-schedule.ts. Drift is reported for a human to act on.
-- ============================================================================

create table if not exists public.freight_verification (
  make             text        not null,
  model            text        not null,
  last_verified_at timestamptz not null default now(),
  status           text        not null,
  amount_held      numeric,
  amounts_seen     numeric[],
  note             text,
  http             integer,
  primary key (make, model)
);

comment on table public.freight_verification is
  'One row per freight figure in fee-schedule.ts FREIGHT: when its source page was last re-read, and what that page said. The figures themselves live in code and are never written from here.';

comment on column public.freight_verification.status is
  'confirmed | drifted | not_stated | blocked | dead_link | unreachable | bad_url | no_source. "blocked" is the manufacturer refusing an identified request -- their decision, recorded and counted, never routed around by spoofing a browser. "not_stated" means the page loaded and named no freight figure, which is evidence we did not read it, NOT evidence the charge changed.';

comment on column public.freight_verification.amounts_seen is
  'Every plausible freight figure found near a freight/PDI/destination word on the page. Kept even when it agrees, so a drift can be read against what the page actually showed rather than a yes/no.';

comment on column public.freight_verification.note is
  'Human-readable result. On drift it names the amount we hold and the amount published, and says explicitly that nothing was auto-corrected.';

alter table public.freight_verification enable row level security;

-- Read-only to the public app for the same reason the warranty verification
-- columns are: a report may say WHEN a figure was last confirmed. Writes are
-- service-role only, from the daily job.
drop policy if exists freight_verification_read on public.freight_verification;
create policy freight_verification_read
  on public.freight_verification for select
  to anon, authenticated
  using (true);

create index if not exists ix_freight_verif_status
  on public.freight_verification (status, last_verified_at desc);
