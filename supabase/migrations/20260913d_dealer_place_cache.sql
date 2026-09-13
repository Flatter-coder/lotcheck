-- ============================================================================
-- The one piece of Google Places data we are allowed to keep: place_id.
--
-- Vic asked whether point 10's catalogue could be free. The answer turned on a
-- licence, not a price: Google Maps Platform caps caching of Places data at 30
-- CONSECUTIVE DAYS, and place_id is the ONLY indefinite exemption. So a stored
-- catalogue of dealer ratings cannot lawfully exist, however cheap it gets.
-- Point 10 is therefore structurally different from the other nine: AMVIC
-- licences, warranty terms and MSRP are facts we may hold and re-verify; a
-- Google rating is licensed data with an expiry.
--   https://developers.google.com/maps/documentation/places/web-service/policies
-- [[every-point-has-a-catalogue]] [[always-check-legally-clear]]
--
-- WHAT THIS BUYS, AND IT IS NOT ONLY MONEY.
--
-- Resolving a dealer to a Google place today means a free-text Text Search with
-- `rating` in the field mask -- an ENTERPRISE-tier call, of which Google gives
-- 1,000 free per month and then charges $35/1,000 (the pooled $200 credit was
-- replaced by per-SKU caps on 2025-03-01, and they do not pool or roll over).
-- Every report re-runs that search from scratch, even for a dealer resolved
-- last week.
--
-- Caching place_id skips it. But the bigger win is CORRECTNESS: a free-text
-- search is re-run every time and can resolve DIFFERENTLY next month -- a new
-- rooftop opens, a name changes, Google reorders. A dealer resolved once, by
-- domain match, stays resolved. Identity stops being a coin toss we re-flip.
-- That is the same argument as the AMVIC matcher's determinism fix.
--
-- WHAT THIS TABLE MUST NEVER HOLD. No rating, no review count, no review text,
-- no display name, no formatted address. All of that is 30-day data and lives in
-- dealer_sentiment_cache. This table holds an identifier and OUR OWN keys, and
-- `match_basis` is a code we wrote ('domain', 'domain+city', 'name+city') rather
-- than an echo of Google's copy. scripts/test-dealer-place.mjs fails the build if
-- a licensed column ever appears here.
--
-- TWO KEYS, ONE DEALER. A scan that knows the listing host keys on the host; one
-- that does not keys on name+city. Both columns are unique and either may be
-- null, so the same dealer seen both ways fills in the missing key on the second
-- sighting instead of becoming two rows -- the duplicate-dealer shape that
-- already bit the AMVIC catalogue.
-- ============================================================================

create table if not exists public.dealer_place (
  place_id      text primary key,
  -- normHost() of the listing's own host, e.g. 'xpertsautos.com'
  host_key      text unique,
  -- normName(dealer) || '|' || normName(city)
  namecity_key  text unique,
  -- OUR words for how identity was established, never Google's data.
  match_basis   text not null check (match_basis in ('domain', 'domain+city', 'name+city')),
  confidence    numeric not null check (confidence > 0 and confidence <= 1),
  resolved_at   timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  -- At least one way in, or the row can never be found again.
  constraint dealer_place_has_a_key check (host_key is not null or namecity_key is not null)
);

alter table public.dealer_place enable row level security;   -- no policies: service role only
create index if not exists ix_dealer_place_basis on public.dealer_place(match_basis, resolved_at desc);

comment on table public.dealer_place is
  'Google place_id per dealer. place_id is the ONLY Places field exempt from the 30-day caching cap, so it is the only one that may live here. Rating, review count, review text, display name and address are licensed 30-day data and belong in dealer_sentiment_cache.';
comment on column public.dealer_place.match_basis is
  'How identity was established: domain (the place website matches the listing host), domain+city, or name+city. A name+city resolution is weaker and is recorded so it can be re-verified; a domain resolution is identity.';

-- ---- the other half of the licence: expiry is not optional ------------------
-- dealer_sentiment_cache holds rating, review_count, themes and display_name --
-- all 30-day data. Nothing has ever deleted a row from it. It is read with a
-- freshness check, which controls what we SHOW and not what we KEEP, so a stale
-- row sits there holding Google's licensed data indefinitely. Same shape as the
-- 6-hour listing_analysis_cache TTL that is also a read check and not a
-- retention policy.
--
-- THIS DELETES ROWS. It removes cache entries whose refreshed_at is older than
-- 30 days -- data we are not permitted to retain past that point and that the
-- code already refuses to use. Applying this migration is the approval for that.
--
-- Guarded on the table existing, because dealer_sentiment_cache is not defined
-- in any migration in this repo (it was created outside version control, like
-- listing_analysis_cache) and its shape cannot be verified from code.
do $$
declare n bigint := 0;
begin
  if to_regclass('public.dealer_sentiment_cache') is null then
    raise notice 'dealer_sentiment_cache does not exist -- nothing to expire.';
    return;
  end if;
  execute 'delete from public.dealer_sentiment_cache where refreshed_at < now() - interval ''30 days''';
  get diagnostics n = row_count;
  raise notice 'expired % dealer_sentiment_cache row(s) older than 30 days.', n;
exception when undefined_column then
  raise warning 'dealer_sentiment_cache has no refreshed_at column -- expiry NOT applied. Check the table shape before relying on the 30-day cap.';
end $$;

-- ---- receipt ---------------------------------------------------------------
select (select count(*) from public.dealer_place)                          as places_cached,
       (select count(*) from public.dealer_place where match_basis <> 'name+city') as resolved_by_domain,
       to_regclass('public.dealer_sentiment_cache') is not null            as sentiment_cache_exists;
