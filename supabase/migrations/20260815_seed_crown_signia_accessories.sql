-- ============================================================================
-- 2026 Crown Signia accessories — 22 items, and a one-cent proof.
--
-- SOURCE: Toyota Canada accessory page, Crown Signia, Alberta, 2026-08-15.
--
-- THE DASH CAMERA COSTS $847.20 HERE AND $847.21 ON THE 4RUNNER. One cent. It
-- would be easy to call that a rounding artifact and normalise it away, and
-- that would be the wrong instinct: it is direct evidence that Toyota prices
-- these PER MODEL rather than from one shared list. Anything built on "the same
-- part costs the same everywhere" is unsound, and today already produced a
-- $60 version of the same lesson (4Runner skid plates, gas vs hybrid).
--
-- Bigger spreads on the same names, all from Toyota's own pages:
--     Cargo Liner                     RAV4  —        4Runner $216.80   Signia $201.80
--     Front Illuminated Door Sills    RAV4 $378.60                     Signia $460.40
--     Towing Hitch/Ball/Harness       RAV4 $1,630.60                   Signia $2,006.00
--     Cross Bars                      RAV4 $567.21   4Runner $779.01   Signia $779.01
-- So model is a hard key. Cross Bars agreeing across two models is a FINDING,
-- not a licence to assume the next one agrees too.
--
-- THE BLOCK HEATER IS $717 AND MARKED "✓ Included" — inside Toyota's published
-- all-in, named in their own pricing formula. A dealer itemising it as an
-- add-on is charging for something the advertised price already contains.
--
-- Every Yakima item is footnoted "Installation not included", so a dealer
-- fitting charge on those is LEGITIMATE and the fee audit must not flag it.
--
-- `trim` is null meaning "we hold one price for this model" — not "every trim
-- charges this". A single capture cannot establish the second claim.
-- ============================================================================

insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','Crown Signia',null,'Pro Series Paint Protection Film - Hood',578.00,'protection',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Pro Series Paint Protection Film - Door Cup',123.44,'protection',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Pro Series Paint Protection Film - Door Edge',133.44,'protection',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Body Side Moulding - Black',404.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Front Illuminated Door Sill Protectors',460.40,'interior',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Key Glove',29.68,'interior',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Toyota Genuine Dash Camera Series 2.0 - Front Camera',847.20,'electronics',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Toyota Genuine Dash Camera Series 2.0 - Front and Rear Camera package',1553.21,'electronics',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Cargo Liner',201.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Cross Bars',779.01,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Activity Mount',977.00,'cargo',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Towing Hitch, Ball Platform & Wire Harness',2006.00,'towing',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Towing Hitch Ball 2"',61.80,'towing',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),

  -- Inside Toyota's published all-in — named in their own pricing formula.
  (2026,'Toyota','Crown Signia',null,'Premium Plug-In Block Heater',717.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Premium Plug-In Block Heater - Optional 2.5m Home Power Cable',62.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Premium Plug-In Block Heater - Optional 5m Home Power Cable',92.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Premium Plug-In Block Heater - Optional 10m Home Power Cable',132.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/crown-signia/'),

  -- Third-party (Yakima), all footnoted "Installation not included".
  (2026,'Toyota','Crown Signia',null,'Yakima CBX XXL Premium Cargo Box',1499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Yakima CBX LG Cargo Box',1349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Yakima SkinnyWarrior Cargo Basket',599.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Yakima SkinnyWarrior Stretch Net',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/crown-signia/'),
  (2026,'Toyota','Crown Signia',null,'Yakima Stretch Net Medium',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/crown-signia/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

-- Same part name, different models, different prices — run this before ever
-- assuming an accessory price transfers between models.
select name,
       max(price) filter (where model = 'RAV4')           as rav4,
       max(price) filter (where model = '4Runner')        as runner_gas,
       max(price) filter (where model = '4Runner Hybrid') as runner_hyb,
       max(price) filter (where model = 'Crown Signia')   as signia
from public.accessory_catalog
where make ilike 'Toyota'
group by name
having count(distinct model) > 1 and min(price) <> max(price)
order by name;
