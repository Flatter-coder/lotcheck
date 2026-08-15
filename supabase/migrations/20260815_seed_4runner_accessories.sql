-- ============================================================================
-- 2026 4Runner accessories — 59 items, Toyota Canada's published prices.
--
-- WHY THIS MATTERS TO A REPORT: an asking price above the trim MSRP used to draw
-- only "options sit on top of this, ask the dealer which ones". With these, the
-- report can attribute the gap — "$1,787 of that is the running boards, $2,551
-- the roof rack, here are Toyota's own prices" — instead of declining to.
--
-- THE BLOCK HEATER CROSS-CHECKS THE MSRP WORK. Toyota's accessory page shows
-- "Premium Plug-In Block Heater $682.00 ✓ Included", and $682 is exactly the
-- figure derived independently from the Build & Price cash subtotal
-- ($55,520 + $682 + $3,064 = $59,266). Two different documents, same number —
-- which is also why `included` is true on that row: it is inside Toyota's all-in
-- price already, so a dealer listing it as an add-on is charging for something
-- the published price contains.
--
-- INSTALLATION. Every Yakima item is footnoted "Installation not included", so a
-- dealer fitting charge on those is LEGITIMATE and the fee audit must not flag
-- it as padding. Toyota's own parts carry no such footnote.
--
-- HONEST LIMITATION: this is a SINGLE capture, so `trim` is null meaning "we
-- hold one price". The RAV4 proved accessory prices can vary by trim
-- (Illuminated Front Emblem $312.36 vs $382.04). If a 4Runner trim prices any of
-- these differently we would not know it yet — treat these as a reference for
-- attributing a gap, never as proof a dealer overcharged for a part.
-- ============================================================================

insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','4Runner',null,'Pro Series Paint Protection Film - Door Edge',133.44,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Pro Series Paint Protection Film - Door Cup',123.44,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Pro Series Paint Protection Film - Hood',578.00,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Pro Series Paint Protection Film - Roof',185.40,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Door Panel Scuff Protectors',208.60,'protection',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Illuminated Front Emblem: Dark Chrome',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Illuminated Front Emblem: Chrome',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Graphics - Black on Clear',877.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Bronze Badge Overlay Kit: SR5',161.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Body Side Moulding',504.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Lower Door Moulding',414.00,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Cast Aluminum Running Boards: Black',1787.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Predator Tube Step',1117.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Oval Tube Steps: Black',1057.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Oval Tube Steps: Silver',1057.20,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Front Tow Hooks',341.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Rear Tow Hook',226.80,'exterior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Coin Holder / Ashtray Cup',54.80,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Console Vault',670.40,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Side Storage Case Kit',91.80,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Side Storage LED Lantern',216.81,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Universal Tablet Holder',127.68,'interior',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Toyota Genuine Dash Camera Series 2.0 - Front Camera',847.21,'electronics',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Cargo Cover',241.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Carpet Cargo Mat',186.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Cargo Net',91.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Cargo Liner (7 Passenger)',216.80,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Cross Bars',779.01,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Roof Rack',2551.01,'cargo',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Rear Differential Skid Plate',620.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Transfer Case Skid Plate',620.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'TRD Front Skid Plate',786.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Front Skid Plate - Steel',726.40,'underbody',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Performance Tail Pipe - Stainless Steel',2319.00,'performance',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'TRD Performance Air Filter',122.80,'performance',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Premium Plug-In Block Heater',682.00,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Premium Plug-In Block Heater - Optional 2.5m Home Power Cable',62.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Premium Plug-In Block Heater - Optional 5m Home Power Cable',92.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Premium Plug-In Block Heater - Optional 10m Home Power Cable',132.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Battery Trickle Charger',754.01,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'COMFORT+ Programmable Block Heater and Battery Trickle Charger',1477.01,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima JayLow J-Cradle Rooftop Kayak Mount',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima KeelOver Canoe Carrier',249.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima MegaWarrior Cargo Basket',699.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima OffGrid Cargo Basket',779.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima SkinnyWarrior Cargo Basket',599.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima EXO OpenRange Kitchen Cabinet',999.00,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima EXO OpenRange Leg Kit',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima FrontLoader Rooftop Upright Bike Mount',329.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima HighRoad Premium Rooftop Upright Bike Mount',429.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima FatCat EVO 6 Black Premium Ski & Snowboard Mount',499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima CBX LG Cargo Box',1349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima CBX XXL Premium Cargo Box',1499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima SkyBox NX XL',1099.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima RoadShower Portable Pressurized Water Storage',749.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima OverNOut Lightweight Roof Mounted Awning',579.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima Stretch Net Large',114.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima Stretch Net Medium',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/'),
  (2026,'Toyota','4Runner',null,'Yakima SkinnyWarrior Stretch Net',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/4runner/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

select model, count(*) as items,
       count(*) filter (where included) as included_in_all_in,
       count(*) filter (where not install_included) as install_extra,
       min(price) as cheapest, max(price) as dearest
from public.accessory_catalog
group by model order by model;
