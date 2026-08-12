-- ============================================================================
-- Seed the confirmed Convertus dealers.
--
-- WHY THIS IS NEEDED FOR THE CHART. The first real crawl pulled 1,051 units
-- from the three seeded dealers and the market reading still came back n=0 —
-- correctly. All three are SM360, and SM360's listing feed states no MSRP, so
-- there is nothing for an asking price to be measured against. Convertus does
-- publish MSRP on new inventory, so the Alberta-vs-MSRP chart cannot show a
-- reading until Convertus dealers are in the seed.
--
-- EVERY HOST BELOW WAS PROBED, not guessed. Each returned a Convertus feed and
-- yielded its cp (the page's inventoryId) on 2026-08-11. denhamford and
-- northhillmazda were additionally confirmed to return valid 17-character VINs
-- with populated msrp; the rest matched the platform and resolved a cp but
-- their feeds were not read end to end. A dealer whose feed fails is skipped
-- and recorded in dealer_source.last_error rather than breaking the crawl, so
-- seeding them is safe.
--
-- NOT SEEDED: any host discovery detected without a cp. Convertus is addressed
-- by cp, so a row without one is a nightly no-op that looks like coverage.
--
-- Depends on: 20260811_alberta_inventory.sql (dealer_source.platform_id).
-- ============================================================================

insert into public.dealer_source (host, platform, platform_id, name, city, province, sections) values
  ('https://www.denhamford.ca',        'convertus', '1285', 'Denham Ford',        'Wetaskiwin', 'AB', '{new,used}'),
  ('https://www.northhillmazda.com',   'convertus', '2246', 'North Hill Mazda',   'Calgary',    'AB', '{new,used}'),
  ('https://www.canyoncreektoyota.com','convertus', '1207', 'Canyon Creek Toyota','Calgary',    'AB', '{new,used}'),
  ('https://www.albertahonda.com',     'convertus', '3664', 'Alberta Honda',      'Edmonton',   'AB', '{new,used}'),
  ('https://www.brentridge.com',       'convertus', '1373', 'Brentridge Ford',    'Wetaskiwin', 'AB', '{new,used}'),
  ('https://www.lakewoodchev.com',     'convertus', '394',  'Lakewood Chevrolet', 'Edmonton',   'AB', '{new,used}'),
  ('https://varsitychrysler.com',      'convertus', '610',  'Varsity Chrysler',   'Calgary',    'AB', '{new,used}')
on conflict (host) do update
  set platform    = excluded.platform,
      platform_id = coalesce(excluded.platform_id, dealer_source.platform_id),
      sections    = excluded.sections,
      active      = true;
