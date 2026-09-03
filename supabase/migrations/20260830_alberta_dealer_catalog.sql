-- ============================================================================
-- THE ALBERTA DEALER-WEBSITE CATALOGUE
--
-- Vic, 2026-08-30, after a third consecutive single-site failure: "i want
-- catalog of all car websites in alberta the structure what ever we need to
-- stop fixing we should have them all listed on place track them daily and
-- read them on as soones lotcheck user makes request".
--
-- WHAT THIS CHANGES. `dealer_source` was built as the CRAWL roster: one row per
-- dealer we had already confirmed we could walk for inventory. It held 30 rows.
-- The Alberta universe is 1,639 distinct hosts (AMVIC licensees with a
-- website), so we knew 1.8% of the province and rediscovered the other 98% from
-- scratch on every single scan.
--
-- The table becomes the CATALOGUE: one row per Alberta car website, whether or
-- not we can crawl it, whether or not we can even read it. A host we cannot
-- read is a FACT worth recording, not a row to leave out — leaving it out is
-- how "EDealer: 0 across 1,639 Alberta hosts" got believed for a day when the
-- truth was that 452 of those hosts (28%) had refused our datacenter IP.
--
-- THE CRAWLER IS UNAFFECTED. crawl-alberta-inventory.mjs selects
-- `active = true AND platform IN (sm360, convertus, jsonld_itemlist, edealer)`,
-- so rows added here with platform 'unknown' are invisible to it. Cataloguing a
-- host is not crawling it, and the daily-crawl question stays exactly where it
-- was: off, pending the legal call.
--
-- WHAT FILLS IT IN. Two sources, neither of which touches a dealer's server on
-- our own initiative:
--   1. AMVIC's licensee roster, which we already hold — host, name, city.
--   2. EVERY LIVE SCAN. When a buyer asks us to read a page we learn whether a
--      plain fetch worked, whether the anti-bot pass was needed, and which
--      platform answered. That is a fact about a page the buyer asked for, and
--      it is written back so the NEXT buyer's scan starts knowing it.
-- ============================================================================

-- ---- 1) platform vocabulary -------------------------------------------------
-- 'unknown' is the honest default for a host we have catalogued but not yet
-- identified. 'd2c' has had a working reader (_shared/d2c-vdp.js) since
-- 2026-08-22 and was never a value this column could hold.
alter table public.dealer_source drop constraint if exists dealer_source_platform_check;
alter table public.dealer_source add constraint dealer_source_platform_check
  check (platform in ('sm360', 'convertus', 'jsonld_itemlist', 'edealer', 'd2c', 'unknown', 'other'));

alter table public.dealer_source alter column platform set default 'unknown';

-- A catalogue row is not automatically a crawl target. Existing rows keep
-- active = true; new catalogue rows come in inactive and are promoted only by
-- a run that confirmed a feed.
alter table public.dealer_source alter column active set default false;

-- ---- 2) where the row came from ---------------------------------------------
alter table public.dealer_source
  add column if not exists source          text not null default 'crawl',  -- amvic | osm | observed | crawl
  add column if not exists amvic_id        text,
  add column if not exists facility_type   text,
  add column if not exists licence_status  text;

-- ---- 3) how to READ this host, learned from real traffic --------------------
-- The single most valuable thing to know about a dealer host before fetching
-- it: does a plain GET work, or does its CDN refuse datacenter addresses? On a
-- walled host a scan that finds out the hard way spends its retry ladder, its
-- render budget and often the whole request discovering something we already
-- knew.
alter table public.dealer_source
  -- 'direct' | 'asp' | 'unknown'. Advisory ONLY: it changes which way we try
  -- FIRST, never whether we try. A wrong verdict costs one attempt.
  add column if not exists fetch_strategy      text not null default 'unknown',
  -- The last direct-read outcome, in fetchDirectHtml's own vocabulary:
  -- ok | http_error | challenged | empty | network | rate_limited
  add column if not exists last_direct_status  text,
  add column if not exists last_direct_ok_at   timestamptz,
  add column if not exists last_direct_fail_at timestamptz,
  add column if not exists last_asp_ok_at      timestamptz,
  add column if not exists observed_count      integer not null default 0,
  add column if not exists last_observed_at    timestamptz,
  -- WHAT LIVE TRAFFIC IS ALLOWED TO SAY ABOUT THE PLATFORM, kept apart from
  -- `platform`. `platform` is crawl-facing: crawl-alberta-inventory dispatches a
  -- code path off it, so a value written from ONE page's bytes -- and never
  -- correctable afterwards, since every writer here upserts with
  -- ignoreDuplicates -- would be a permanent claim from a single observation.
  -- A scan may say what it saw; only a run that confirmed a FEED may say what
  -- the host is.
  add column if not exists observed_platform   text;

alter table public.dealer_source drop constraint if exists dealer_source_fetch_strategy_check;
alter table public.dealer_source add constraint dealer_source_fetch_strategy_check
  check (fetch_strategy in ('direct', 'asp', 'unknown'));

-- Lookup happens on EVERY listing scan, keyed on the origin with any leading
-- "www." dropped — AMVIC records the bare domain, the site redirects to www,
-- and the buyer pastes whichever their browser shows. Without one key the same
-- dealer files twice and neither lookup finds the other.
create or replace function public.catalog_key(p_host text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(p_host, '')), '^https://www\.', 'https://')
$$;

create index if not exists dealer_source_catalog_key_idx
  on public.dealer_source (public.catalog_key(host));

create index if not exists dealer_source_platform_active_idx
  on public.dealer_source (platform, active);

-- ---- 4) the read the scanner makes ------------------------------------------
-- Read-only, one row, keyed the tolerant way. Returns null rather than raising
-- when a host is unknown: an uncatalogued host must fall back to the existing
-- ladder, never fail. [[no-single-point-of-failure]]
create or replace function public.fn_dealer_catalog_lookup(p_host text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (
    select host, platform, fetch_strategy, last_direct_status,
           last_direct_ok_at, last_direct_fail_at, last_asp_ok_at, observed_count
    from public.dealer_source
    where public.catalog_key(host) = public.catalog_key(p_host)
    order by (last_direct_ok_at is not null) desc, observed_count desc
    limit 1
  ) x
$$;

-- ---- 5) the write one scan makes --------------------------------------------
-- EVERY SCAN TEACHES THE CATALOGUE, and this is the only way it writes. It
-- records what happened on a page the buyer asked us to read; it never causes a
-- request to anyone.
--
-- p_direct_status NULL means the direct path was not attempted on that scan, so
-- nothing about the wall is recorded. Writing a failure there would let a scan
-- that skipped the direct path confirm the very verdict that sent it to ASP —
-- self-fulfilling, forever.
--
-- fetch_strategy is derived here, not passed in, so the rule lives in one place
-- and a caller cannot pin a host to the paid path by accident.
create or replace function public.fn_dealer_catalog_observe(
  p_host           text,
  p_direct_status  text default null,
  p_used_asp       boolean default false,
  p_platform       text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_origin text;
  v_walled boolean;
begin
  if p_host is null or p_host !~ '^https://[^/]+$' then return; end if;
  -- A WALL IS A REFUSAL TO SERVE US, not a bad page. 'http_error' used to cover
  -- every non-OK status except 429/503, so a 404 on a vehicle that had just sold
  -- was indistinguishable from a Cloudflare 403 -- and one buyer pasting a
  -- delisted listing would pin that dealer's whole site to the paid render path
  -- for a week. The caller now resolves the code into 'refused' before it gets
  -- here (see directVerdict in _shared/dealer-catalog.ts).
  v_walled := p_direct_status in ('challenged', 'refused');

  -- RESOLVE THROUGH THE TOLERANT KEY FIRST. AMVIC records "dealer.ca" and the
  -- site redirects to "www.dealer.ca"; inserting on the raw host would file the
  -- same dealer twice, and the unique constraint (on host, not on the key)
  -- would not stop it. Update the row we already have, whichever spelling it
  -- was catalogued under; only insert when the dealer is genuinely new.
  select host into v_origin from public.dealer_source
   where public.catalog_key(host) = public.catalog_key(p_host)
   order by (last_direct_ok_at is not null) desc, observed_count desc
   limit 1;

  if v_origin is null then
    -- ONLY A LICENSED ALBERTA DEALER GETS A NEW ROW. dealer_source is not just
    -- our cache: it is the roster the standing crawl would run against, and its
    -- licence invariant is part of what the pending legal sign-off would be
    -- given for. Letting live traffic file whatever host a buyer pasted -- with
    -- province defaulting to 'AB' and no licence check -- would route around the
    -- gate discover-dealer-feeds applies deliberately, and the audit that
    -- re-checks licences cannot see rows it did not create.
    --
    -- An unlicensed or out-of-province host simply teaches us nothing. It takes
    -- the default ladder, exactly as it does today.
    if not exists (
      select 1 from public.amvic_licensees
       where public.catalog_key(website) = public.catalog_key(p_host)
         and facility_status ~* 'issued'
    ) then
      return;
    end if;
    v_origin := p_host;
    insert into public.dealer_source (host, platform, observed_platform, source, active, observed_count, last_observed_at)
    values (v_origin, 'unknown', nullif(p_platform, ''), 'observed', false, 1, now())
    on conflict (host) do nothing;
  else
    update public.dealer_source set
      observed_count    = observed_count + 1,
      last_observed_at  = now(),
      -- The latest thing a scan actually saw. Correctable by definition, and
      -- never the column the crawler dispatches on.
      observed_platform = coalesce(nullif(p_platform, ''), observed_platform)
    where host = v_origin;
  end if;

  update public.dealer_source set
    last_direct_status  = coalesce(p_direct_status, last_direct_status),
    last_direct_ok_at   = case when p_direct_status = 'ok' then now() else last_direct_ok_at end,
    -- STAMPED WHEN THE WALL WAS FIRST SEEN, not on every scan that meets it.
    -- Re-stamping would make the age this verdict expires on reset every time
    -- the verdict was acted upon, so the 7-day re-test could never fire for any
    -- host anyone actually scans -- a safeguard that exists only for hosts
    -- nobody visits is not a safeguard.
    last_direct_fail_at = case
                            when v_walled and (last_direct_fail_at is null or fetch_strategy <> 'asp')
                              then now()
                            else last_direct_fail_at
                          end,
    last_asp_ok_at      = case when p_used_asp then now() else last_asp_ok_at end,
    fetch_strategy      = case
                            when p_direct_status = 'ok' then 'direct'
                            when v_walled then 'asp'
                            else fetch_strategy
                          end
  where host = v_origin;
end
$$;

-- SERVICE ROLE ONLY, AND REVOKED FROM THE NAMED ROLES -- not just PUBLIC.
--
-- `revoke ... from public` alone is the pattern 20260814_lock_service_role_
-- functions.sql exists to correct: PUBLIC is the implicit pseudo-role, Supabase
-- separately holds EXPLICIT grants to anon and authenticated, and revoking from
-- PUBLIC does not remove those. That file found fn_capture_quote -- the CREDIT
-- CAPTURE function -- reachable with the anon key shipped in the client bundle.
-- Writing the same three lines again here would have left a SECURITY DEFINER
-- writer that lets anyone pin any Alberta dealer to the paid render path.
revoke all on function public.fn_dealer_catalog_lookup(text) from public, anon, authenticated;
revoke all on function public.fn_dealer_catalog_observe(text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_dealer_catalog_lookup(text) to service_role;
grant execute on function public.fn_dealer_catalog_observe(text, text, boolean, text) to service_role;

-- ---- 6) coverage, so "how much of Alberta do we know" is one query ----------
create or replace function public.fn_catalog_coverage()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'hosts',         (select count(*) from public.dealer_source),
    'crawlable',     (select count(*) from public.dealer_source
                       where active and platform in ('sm360','convertus','jsonld_itemlist','edealer')),
    'platformKnown', (select count(*) from public.dealer_source where platform <> 'unknown'),
    'platformSeen',  (select count(*) from public.dealer_source where observed_platform is not null),
    'directOk',      (select count(*) from public.dealer_source where fetch_strategy = 'direct'),
    'walled',        (select count(*) from public.dealer_source where fetch_strategy = 'asp'),
    'unprobed',      (select count(*) from public.dealer_source where fetch_strategy = 'unknown'),
    'observed',      (select count(*) from public.dealer_source where observed_count > 0),
    'bySource',      (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
                        from (select source, count(*) n from public.dealer_source group by source) s),
    'byPlatform',    (select coalesce(jsonb_object_agg(platform, n), '{}'::jsonb)
                        from (select platform, count(*) n from public.dealer_source group by platform) p)
  )
$$;
revoke all on function public.fn_catalog_coverage() from public, anon, authenticated;
grant execute on function public.fn_catalog_coverage() to service_role;

-- PROVE IT TOOK. A revoke that silently failed is exactly how the anon key kept
-- reaching these for weeks, and a migration whose security depends on a
-- statement having worked must check that it did rather than assume it.
do $$
declare
  r record;
  leaked text[] := '{}';
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('fn_dealer_catalog_lookup', 'fn_dealer_catalog_observe', 'fn_catalog_coverage')
  loop
    if has_function_privilege('anon', r.sig, 'EXECUTE')
       or has_function_privilege('authenticated', r.sig, 'EXECUTE') then
      leaked := leaked || r.sig::text;
    end if;
  end loop;
  if array_length(leaked, 1) > 0 then
    raise exception 'catalogue functions still executable by anon/authenticated: %', array_to_string(leaked, ', ');
  end if;
  raise notice 'catalogue functions are service-role only.';
end $$;
