-- ============================================================================
-- Expand manufacturer_warranties from 11 makes to 35 — covers essentially every
-- brand sold new in Canada, so a report can VERIFY the included warranty on any
-- uploaded quote/URL instead of falling back to an AI guess.
--
-- EVERY figure below was sourced from the manufacturer's OFFICIAL Canadian
-- warranty page (source_url) — see memory: warranty-catalog-all-makes,
-- claims-must-stay-backed, defamation-proof-and-compliant. Do NOT edit a
-- coverage value without updating source_url to a page that states it.
--
-- Make-level notes:
--  * Ram powertrain kept at the STANDARD 5yr/100,000 km — the 10yr/160,000 km
--    figure applies only to specific 2026/2027 models, so it would over-claim
--    for a general Ram lookup.
--  * German/UK brands (BMW, MB, Audi, Volvo, MINI, Porsche, Jaguar, Land Rover,
--    Alfa) do not publish a separate powertrain term → powertrain = basic.
--  * EV-only brands (Tesla, Polestar) have no ICE powertrain → powertrain holds
--    the battery/drive-unit warranty so the coverage line renders sensibly.
--  * Fields the official page did not state are left NULL rather than guessed
--    (e.g. Mitsubishi/Porsche corrosion, Tesla roadside).
-- ============================================================================
create table if not exists public.manufacturer_warranties (
  make                text primary key,
  basic_coverage      text,
  powertrain_coverage text,
  corrosion_coverage  text,
  roadside_assistance text,
  hybrid_ev_coverage  text,
  source_url          text
);

delete from public.manufacturer_warranties where make in (
  'Lexus','Acura','Infiniti','Genesis','Mitsubishi','BMW','Mercedes-Benz','Audi',
  'Volvo','MINI','Porsche','Jeep','Ram','Dodge','Chrysler','Fiat','Alfa Romeo',
  'Cadillac','Buick','Lincoln','Tesla','Jaguar','Land Rover','Polestar'
);

insert into public.manufacturer_warranties
  (make, basic_coverage, powertrain_coverage, corrosion_coverage, roadside_assistance, hybrid_ev_coverage, source_url) values
  ('Lexus',        '4-year/80,000 km',  '6-year/110,000 km', '6-year/unlimited km', '4-year/unlimited km', '8-year/160,000 km (components), 10-year/240,000 km (battery)', 'https://www.lexus.ca/en/know-your-lexus/coverage/new-vehicle-warranty/'),
  ('Acura',        '4-year/80,000 km',  '5-year/100,000 km', '5-year/unlimited km', '4-year/unlimited km', '8-year/160,000 km', 'https://www.acura.ca/en/acura-plus/standard-warranty'),
  ('Infiniti',     '4-year/100,000 km', '6-year/110,000 km', '7-year/unlimited km', '4-year/unlimited km', null, 'https://www.infiniti.ca/owners/vehicle-resources/warranty.html'),
  ('Genesis',      '5-year/100,000 km', '5-year/100,000 km', '5-year/unlimited km', '5-year/unlimited km', '8-year/160,000 km', 'https://www.genesis.com/ca/en/owners/owners-experience/warranty.html'),
  ('Mitsubishi',   '5-year/100,000 km', '10-year/160,000 km', null, '5-year/unlimited km', '10-year/160,000 km', 'https://www.mitsubishi-motors.ca/en/owners/warranty'),
  ('BMW',          '4-year/80,000 km',  '4-year/80,000 km',  '12-year/unlimited km', null, null, 'https://www.bmw.ca/en/topics/owners/parts_service_warranty/warranties.html'),
  ('Mercedes-Benz','4-year/80,000 km',  '4-year/80,000 km',  '5-year/unlimited km', '4-year/80,000 km', '6-year/100,000 km', 'https://www.mercedes-benz.ca/en/owners/service-maintenance/vehicle-warranty'),
  ('Audi',         '4-year/80,000 km',  '4-year/80,000 km',  '12-year/unlimited km', '4-year/80,000 km', '8-year/160,000 km', 'https://www.audi.ca/en/customer-area/warranty-audi-after-care/audi-warranty/layer/warranty-new/'),
  ('Volvo',        '4-year/80,000 km',  '4-year/80,000 km',  '12-year/unlimited km', '4-year/80,000 km', '8-year/160,000 km', 'https://www.volvocars.com/en-ca/support/'),
  ('MINI',         '4-year/80,000 km',  '4-year/80,000 km',  '12-year/unlimited km', '4-year/80,000 km', null, 'https://mini.ca/en/owners/mini-service'),
  ('Porsche',      '4-year/80,000 km',  '4-year/80,000 km',  null, null, '8-year/160,000 km', 'https://www.porsche.com/canada/en/accessoriesandservice/porscheservice/vehicleinformation/'),
  ('Jeep',         '3-year/60,000 km',  '5-year/100,000 km', '3-year/unlimited km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.jeep.ca/en/mopar/protection'),
  ('Ram',          '3-year/60,000 km',  '5-year/100,000 km', '3-year/unlimited km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.ramtruck.ca/en/mopar/protection'),
  ('Dodge',        '3-year/60,000 km',  '5-year/100,000 km', '3-year/unlimited km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.dodge.ca/en/mopar/protection'),
  ('Chrysler',     '3-year/60,000 km',  '5-year/100,000 km', '3-year/unlimited km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.chrysler.ca/en/mopar/protection'),
  ('Fiat',         '3-year/60,000 km',  '5-year/100,000 km', '3-year/unlimited km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.fiatcanada.com/en/mopar/protection'),
  ('Alfa Romeo',   '4-year/80,000 km',  '4-year/80,000 km',  '5-year/160,000 km', '4-year/80,000 km', null, 'https://www.alfaromeo.ca/en/owners/warranty'),
  ('Cadillac',     '4-year/80,000 km',  '6-year/110,000 km', '6-year/unlimited km', '6-year/110,000 km', null, 'https://www.cadillaccanada.ca/en/ownership/warranty'),
  ('Buick',        '3-year/60,000 km',  '5-year/100,000 km', '6-year/160,000 km', '5-year/100,000 km', '8-year/160,000 km', 'https://www.buick.ca/en/ownership/warranty'),
  ('Lincoln',      '4-year/80,000 km',  '6-year/110,000 km', '5-year/unlimited km', '6-year/110,000 km', '8-year/160,000 km', 'https://www.lincolncanada.com/warranty/new-vehicle/'),
  ('Tesla',        '4-year/80,000 km',  '8-year/160,000 km (battery & drive unit, varies by model)', '12-year/unlimited km', null, '8-year/160,000-240,000 km (varies by model)', 'https://www.tesla.com/en_ca/support/vehicle-warranty'),
  ('Jaguar',       '4-year/80,000 km',  '4-year/80,000 km',  '6-year/unlimited km', '4-year/80,000 km', null, 'https://www.jaguar.com/en-ca/jdx/ownership/warranties/new-vehicle-limited-warranty.html'),
  ('Land Rover',   '4-year/80,000 km',  '4-year/80,000 km',  '6-year/unlimited km', '4-year/80,000 km', '8-year/160,000 km', 'https://www.landrover.ca/en/ownership/warranty/warranty-and-roadside-assistance.html'),
  ('Polestar',     '4-year/80,000 km',  '8-year/160,000 km (battery & motors)', '12-year/unlimited km', '4-year', '8-year/160,000 km', 'https://www.polestar.com/en-ca/polestar-2/warranty-and-service/');
