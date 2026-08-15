-- ============================================================================
-- 2026 4Runner HYBRID accessories — 60 items, and they PROVE the limitation I
-- wrote into the gas file an hour ago instead of leaving it hypothetical.
--
-- SOURCE: Toyota Canada accessory pages for the 4Runner Hybrid, Alberta,
-- captured 2026-08-15.
--
-- ---------------------------------------------------------------------------
-- THE SAME PART COSTS MORE ON THE HYBRID. Two rows, identical names, both from
-- Toyota's own page, same model year, same nameplate:
--
--     Rear Differential Skid Plate     gas $620.40    hybrid $680.40   (+$60)
--     Transfer Case Skid Plate         gas $620.40    hybrid $680.40   (+$60)
--
-- The gas migration said: "If a 4Runner trim prices any of these differently we
-- would not know it yet." Six hours later, it does. Had these been seeded at
-- nameplate level, a report on a hybrid would have quoted $620.40 for a part
-- Toyota sells at $680.40 — understating by $60 each, on a page whose entire
-- purpose is telling a buyer what the manufacturer charges.
--
-- So `model` is '4Runner Hybrid', not '4Runner'. Same discipline as the MSRP
-- rows: the powertrain boundary is a hard key, never a synonym.
--
-- THE CATALOGUE ALSO DIFFERS, not just the prices:
--     Bronze Badge Overlay Kit    gas: "SR5" $161.80  |  hybrid: "TRD Off Road" $196.80
--     Cargo Liner                 gas: "(7 Passenger)" |  hybrid: plain
-- The hybrid summaries all read SEATS 5, so a 7-passenger liner has nothing to
-- fit — the catalogue tracks what each powertrain is actually built as.
--
-- ---------------------------------------------------------------------------
-- WHAT I AM NOT CLAIMING. Four screenshots is a capture, not an inventory. Some
-- items in the gas set (Cargo Cover, Cargo Net, Yakima Stretch Net Large) are
-- not in these frames. That is NOT evidence Toyota stopped offering them on the
-- hybrid — an absent read is a gap in my capture, and recording a gap as a
-- finding is the exact mistake that emptied msrp_catalog every week. Nothing
-- below asserts absence.
--
-- THE BLOCK HEATER, AGAIN AT $682 AND AGAIN MARKED "✓ Included". It carries
-- included=true because it sits INSIDE Toyota's published all-in — it is named
-- in their own pricing formula. A dealer itemising it as an add-on is charging
-- for something the advertised price already contains, and that is a fee-audit
-- finding with the manufacturer's page behind it.
--
-- INSTALLATION. Every Yakima item is footnoted "Installation not included", so
-- a dealer fitting charge on those is LEGITIMATE and must not be flagged as
-- padding. Toyota's own parts carry no such footnote.
--
-- `trim` IS NULL, meaning "we hold one price for this powertrain" — not "the
-- price is the same on every trim". The RAV4 showed the same emblem at $312.36
-- and $382.04 on two trims. These attribute a gap; they never prove a dealer
-- overcharged for a part.
-- ============================================================================

insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','4Runner Hybrid',null,'Pro Series Paint Protection Film - Door Edge',133.44,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Pro Series Paint Protection Film - Door Cup',123.44,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Pro Series Paint Protection Film - Hood',578.00,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Pro Series Paint Protection Film - Roof',185.40,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Door Panel Scuff Protectors',208.60,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Illuminated Front Emblem: Dark Chrome',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Illuminated Front Emblem: Chrome',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Graphics - Black on Clear',877.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  -- Gas page shows the SR5 variant at $161.80. Different badge, different price.
  (2026,'Toyota','4Runner Hybrid',null,'Bronze Badge Overlay Kit: TRD Off Road',196.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Body Side Moulding',504.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Lower Door Moulding',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Cast Aluminum Running Boards: Black',1787.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Predator Tube Step',1117.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Oval Tube Steps: Black',1057.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Oval Tube Steps: Silver',1057.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Front Tow Hooks',341.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Rear Tow Hook',226.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'TRD 18" Alloy Wheel - Flat Black',2462.40,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Coin Holder / Ashtray Cup',54.80,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Console Vault',670.40,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Side Storage Case Kit',91.80,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Side Storage LED Lantern',216.81,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Universal Tablet Holder',127.68,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Rear Hatch Cargo Lamp',612.00,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Toyota Genuine Dash Camera Series 2.0 - Front Camera',847.21,'electronics',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'JBL Portable Speaker',282.68,'electronics',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Carpet Cargo Mat',186.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  -- Gas page lists this as "Cargo Liner (7 Passenger)". Hybrid is 5-seat.
  (2026,'Toyota','4Runner Hybrid',null,'Cargo Liner',216.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Cross Bars',779.01,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Roof Rack',2551.01,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  -- +$60 each against the gas page. The reason these rows are keyed by powertrain.
  (2026,'Toyota','4Runner Hybrid',null,'Rear Differential Skid Plate',680.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Transfer Case Skid Plate',680.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'TRD Front Skid Plate',786.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Front Skid Plate - Steel',726.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Performance Tail Pipe - Stainless Steel',2319.00,'performance',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'TRD Performance Air Filter',122.80,'performance',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  (2026,'Toyota','4Runner Hybrid',null,'Towing Hitch Ball 2 5/16"',81.80,'towing',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  -- Inside Toyota's published all-in — named in their own pricing formula.
  (2026,'Toyota','4Runner Hybrid',null,'Premium Plug-In Block Heater',682.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Premium Plug-In Block Heater - Optional 2.5m Home Power Cable',62.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Premium Plug-In Block Heater - Optional 5m Home Power Cable',92.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Premium Plug-In Block Heater - Optional 10m Home Power Cable',132.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Battery Trickle Charger',754.01,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'COMFORT+ Programmable Block Heater and Battery Trickle Charger',1477.01,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),

  -- Third-party (Yakima). All footnoted "Installation not included" — a dealer
  -- fitting charge on these is legitimate, so install_included is false.
  (2026,'Toyota','4Runner Hybrid',null,'Yakima FrontLoader Rooftop Upright Bike Mount',329.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima HighRoad Premium Rooftop Upright Bike Mount',429.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima FatCat EVO 6 Black Premium Ski & Snowboard Mount',499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima JayLow J-Cradle Rooftop Kayak Mount',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima KeelOver Canoe Carrier',249.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima MegaWarrior Cargo Basket',699.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima OffGrid Cargo Basket',779.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima SkinnyWarrior Cargo Basket',599.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima EXO OpenRange Leg Kit',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima EXO OpenRange Kitchen Cabinet',999.00,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima CBX LG Cargo Box',1349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima CBX XXL Premium Cargo Box',1499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima SkyBox NX XL',1099.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima RoadShower Portable Pressurized Water Storage',749.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima OverNOut Lightweight Roof Mounted Awning',579.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima SkinnyWarrior Stretch Net',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner Hybrid',null,'Yakima Stretch Net Medium',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

-- The same part, both powertrains, side by side — the check that would have
-- caught this if it had existed before the gas rows went in.
select a.name,
       max(price) filter (where model = '4Runner')        as gas,
       max(price) filter (where model = '4Runner Hybrid') as hybrid
from public.accessory_catalog a
where make ilike 'Toyota' and model in ('4Runner','4Runner Hybrid')
group by a.name
having count(distinct model) = 2
   and min(price) <> max(price)
order by a.name;

select model, count(*) as items,
       count(*) filter (where included) as included_in_all_in,
       count(*) filter (where not install_included) as install_extra
from public.accessory_catalog
group by model order by model;
