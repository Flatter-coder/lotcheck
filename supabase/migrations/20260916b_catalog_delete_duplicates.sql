-- ============================================================================
-- CATALOG HYGIENE, PART B — THIS FILE DELETES ROWS. READ IT BEFORE APPLYING.
--
-- REWRITTEN 2026-09-16, BEFORE IT WAS EVER APPLIED.
--
-- The original deleted eight rows by surrogate id. It was never run, and that is
-- the only reason it did no damage: by the time anyone went to apply it, SIX OF
-- ITS EIGHT TARGET IDS NO LONGER EXISTED. The daily catalog refresh had run at
-- 15:27 — 53 minutes after the PR merged — and replaceRows() deletes a make's
-- rows and re-inserts them, so the whole 479xx block was reassigned into 494xx.
-- Applying the file as written would have deleted two rows, silently missed six,
-- and reported success, because a DELETE that matches nothing is not an error.
--
-- Rewriting it in place (rather than adding a 20260916c) is deliberate: the
-- original is a live trap for anyone running `--all-since 20260916`, and since
-- it never applied, changing its contents changes nothing in production.
--
-- WHAT CHANGED
--   1. Rows are addressed by NATURAL KEY (year, make, model, trim) — also
--      msrp_catalog's UNIQUE constraint, and the key carry-forward and
--      supersede run on. Ids are not stable for the life of a pull request.
--   2. EVERY DELETE IS CONDITIONAL ON ITS TWIN EXISTING. A stub-named row is
--      removed only when the real-named row is actually present at the same
--      MSRP. Deleting a price we hold nowhere else is the one outcome that must
--      be impossible, so it raises instead.
--   3. Every statement raises when it matches nothing it expected to match, and
--      an EXISTS guard makes a re-run a clean no-op. "Already done" and
--      "matched nothing" are different answers and must not print the same.
--
-- APPLY 20260916a FIRST. Four of the surviving rows get their all_in_price from
-- their twin in that file. If B runs first, the twin is gone and the survivor is
-- left blind — worse than the state this started in.
--
-- WHY DELETE RATHER THAN LEAVE THEM. An exact-trim match is the precondition for
-- any over/under claim. With one car under two trim names, which row the matcher
-- lands on is arbitrary, and some of these pairs have a copy with no
-- all_in_price — so the arbitrary outcome decides whether the buyer gets a claim
-- or a refusal. That is not a tie-break anyone should be making at request time.
--
-- THIS FILE IS THE ONE-TIME CLEANUP. The recurrence is fixed on the write side:
-- resolveTrim() and dropStubDuplicates() in scripts/lib/tci-stack.mjs stop the
-- scraper manufacturing these rows in the first place. Without that fix, every
-- row deleted here would be back the next morning at 15:27.
-- ============================================================================

-- ── 1. Stub-named copies of a car already named by its real grade ───────────
-- "Standard Package" is Adobe AEM's default label for a base package with no
-- distinct name of its own — not a Canadian showroom trim, and not something a
-- dealer or a buyer ever writes. Verified against the live Toyota/Lexus
-- fragments on 2026-09-16: the real trim is the fragment's `grade`.
--
-- ONLY the rows below, and only where the named twin is present at the same
-- price. The other stub-named rows in the table are the SOLE row for their model
-- — Crown and GR86 have no other row at all — and removing them would take a
-- real published MSRP out of the catalogue. Those are left alone on purpose;
-- the scraper now logs them as unnamed base trims so the gap stays visible.
--
-- "Land Cruiser Premium Package" is here rather than in the rename file because
-- it is not merely mis-shaped, it is an exact duplicate: same $86,835, same
-- $90,601 all-in as "Premium Package".
do $$
declare
  r record;
  n int;
  removed int := 0;
begin
  for r in
    select * from (values
      -- year, make,    model,                stub trim to remove,             twin that must exist,  twin MSRP
      (2026, 'Toyota', 'Crown Signia',        'Standard Package',              'Limited',             58555),
      (2026, 'Toyota', 'GR Corolla',          'Standard Package',              'Core',                50295),
      (2026, 'Toyota', 'RAV4',                'Standard Package',              'LE',                  37500),
      (2026, 'Toyota', 'RAV4 Plug-in Hybrid', 'Standard Package',              'SE',                  48750),
      (2026, 'Toyota', '4Runner',             'Standard Package',              '4Runner',             55520),
      (2027, 'Toyota', 'Land Cruiser',        'Land Cruiser Premium Package',  'Premium Package',     86835)
    ) as t(yr, mk, md, stub, twin, twin_msrp)
  loop
    if exists (select 1 from public.msrp_catalog c
                where c.year = r.yr and c.make = r.mk
                  and c.model = r.md and c.trim = r.stub) then

      -- THE REFUSAL THAT MATTERS. Without a named twin at the same price, this
      -- stub row is the only record of that car's MSRP, and deleting it would
      -- remove a published figure we hold nowhere else.
      if not exists (select 1 from public.msrp_catalog c
                      where c.year = r.yr and c.make = r.mk and c.model = r.md
                        and c.trim = r.twin and c.msrp = r.twin_msrp) then
        raise exception
          'refusing to remove % % % "%": its named twin "%" at $% is not in the table, so this row is the only price we hold for that car',
          r.yr, r.mk, r.md, r.stub, r.twin, r.twin_msrp;
      end if;

      delete from public.msrp_catalog c
       where c.year = r.yr and c.make = r.mk
         and c.model = r.md and c.trim = r.stub;
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'delete: % % % "%" matched nothing after EXISTS said it would',
          r.yr, r.mk, r.md, r.stub;
      end if;
      removed := removed + n;
      raise notice 'removed % stub row(s): % % % "%" (kept "%")', n, r.yr, r.mk, r.md, r.stub, r.twin;
    else
      raise notice 'already removed: % % % "%"', r.yr, r.mk, r.md, r.stub;
    end if;
  end loop;
  raise notice 'stub duplicates removed: %', removed;
end $$;

-- ── 2. Trim-less rows written more than once by successive capture passes ───
-- Same year, make, model, blank trim, same price, same source_url; one row per
-- pass. The FRESHEST row is kept, because in a price catalogue the newer read is
-- the one to trust.
--
-- A CORRECTION TO THE ORIGINAL FILE. It described these as pairs — "one from the
-- 2026-08-11 pass and one from 2026-08-18" — and deleted the row it had pinned
-- as the older one. By 2026-09-16 the Trax was at THREE copies: a third landed
-- that morning at 15:27. This is not a historical pair to tidy, it is an ongoing
-- duplication, because UNIQUE(year, make, model, trim) DOES NOT CONSTRAIN NULL
-- TRIMS — Postgres treats every NULL as distinct, so the constraint that stops
-- this everywhere else is silent here. Deleting "the 08-11 row" would have left
-- two. Keeping max(fetched_at) is correct at any count.
--
-- (Deduplicating them does not make them matchable: a blank trim can never
-- satisfy an exact-config match. 104 rows across six makes have no trim at all.
-- That is a capture gap, listed at the end.)
do $$
declare
  n int;
  dupes int;
begin
  select count(*) - count(distinct (year, make, model, msrp)) into dupes
    from public.msrp_catalog
   where trim is null
     and (year, make, model, msrp) in (
       (2027, 'Chevrolet', 'Trax',  30192),
       (2026, 'Cadillac',  'LYRIQ', 74042)
     );

  if dupes > 0 then
    delete from public.msrp_catalog c
     where c.trim is null
       and (c.year, c.make, c.model, c.msrp) in (
         (2027, 'Chevrolet', 'Trax',  30192),
         (2026, 'Cadillac',  'LYRIQ', 74042)
       )
       and c.fetched_at < (
         select max(c2.fetched_at)
           from public.msrp_catalog c2
          where c2.trim is null
            and c2.year = c.year and c2.make = c.make
            and c2.model = c.model and c2.msrp = c.msrp
       );
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'blank-trim dedupe: % duplicate(s) counted but none deleted — the fetched_at comparison is wrong', dupes;
    end if;
    raise notice 'blank-trim duplicates removed: % (of % counted)', n, dupes;
  else
    raise notice 'blank-trim dedupe: nothing to do';
  end if;
end $$;

-- ============================================================================
-- NOT ADDRESSED, and named so nobody reads this as "the catalogue is clean":
--
--   104 rows have a BLANK trim and can never produce an exact-config match:
--        Mercedes-Benz 77, Porsche 10, Volvo 7, Mini 6, Chevrolet 2, Cadillac 2.
--   1,105 rows across 28 makes still have NO all_in_price, so in an all-in
--        province msrp-claim.ts refuses the over/under claim for all of them.
--   3 rows (2026 4Runner TRD Sport / TRD Off Road Premium / Limited 7
--        Passenger) carry fuel_type 'Hybrid' at gas prices, contradicting the
--        hand-verified 'Gas' row for the same nameplate. A wrong powertrain is
--        the IONIQ 9 defect; settling it needs a capture, not an argument from
--        price. See the note at the end of 20260916a.
--   1 row (2026 RAV4 Plug-in Hybrid XSE) has no all-in and no twin to take one
--        from.
--   21 stub-named base trims remain, because their fragment `grade` is an
--        internal code (Crown Signia HI, Land Cruiser BX, LC NONE, ES STD …) and
--        nothing in the source can name the car. They are KEPT — for Crown and
--        GR86 the stub row is the only row that model has — and the scraper now
--        logs them on every run so the gap does not go quiet.
-- ============================================================================
