-- ============================================================================
-- listing_observation must be as closed as the table it describes.
--
-- Caught by probing production straight after applying 20260903_listing_observation:
--
--   listing_observation   HTTP 200  []          <- anon HAS select
--   vehicle_listing       HTTP 401  42501       <- anon revoked
--
-- Row-level security is enabled on the new table and it carries no policy, so
-- anon reads back an empty set today and nothing leaks. But that is one guard
-- deep, and it is the ONLY guard: add a permissive policy later for some
-- unrelated reason and the whole observation trail becomes public in the same
-- commit. Its three siblings from 20260811 are revoked at the grant level as
-- well, and this table is strictly more sensitive than any of them -- it is a
-- day-by-day record of what every dealer we crawl had on the lot.
--
-- Same revoke, same roles, so the four tables of the inventory archive are
-- closed the same way and nobody has to remember which one is the exception.
-- ============================================================================

revoke all on public.listing_observation from anon, authenticated;

comment on table public.listing_observation is
  'One row per listing per crawl day. The evidence behind every days-on-lot claim: a duration is a claim about time, so it needs at least two observations separated in time. One sighting is a date, not a duration. Closed to anon and authenticated at the grant level, like the rest of the inventory archive; reached only through security-definer functions.';
