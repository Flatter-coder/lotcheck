-- ============================================================================
-- accessory_catalog — manufacturer-published accessory prices.
--
-- WHY THIS CLOSES A GAP WE CALLED STRUCTURAL. A catalogue row prices a TRIM;
-- the buyer is looking at a CAR. Until now, when an asking price sat above the
-- trim MSRP we could only say "options sit on top of this — ask the dealer
-- which ones", because option prices are not published as structured data
-- anywhere. That meant a $4,400 gap was indistinguishable from $4,400 of markup,
-- and under our own rules we had to decline to attribute it.
--
-- With this table the report can say: "$1,822 of that is the alloy wheels and
-- $1,631 is the tow hitch — here are Toyota's own prices." That is the
-- difference between refusing to answer and answering.
--
-- KEYED BY TRIM, and this is not optional. Proven from Toyota's own accessory
-- pages captured 2026-08-15: the SAME accessory carries DIFFERENT prices on
-- different trims of the same model —
--     Illuminated Front Emblem   $312.36 on one trim, $382.04 on another
--     Motion Sensor Alarm        $606.20 on one trim, $566.00 on another
-- A model-level accessory price would therefore be wrong roughly whenever it
-- mattered. `trim` NULL means "same price across every trim we captured", which
-- is a positive finding, never a default.
--
-- INSTALLATION IS A SEPARATE QUESTION. Toyota's own third-party items (Yakima)
-- are footnoted "Installation not included". A dealer may legitimately charge to
-- fit them, so the fee audit must not treat an install line as padding when
-- install_included is false.
-- ============================================================================

create table if not exists public.accessory_catalog (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),

  year             integer not null,
  make             text    not null,
  model            text    not null,
  -- NULL = price is identical across every trim we captured. Never a guess.
  trim             text,

  name             text    not null,
  price            numeric not null check (price >= 0),
  category         text,

  -- Fitted as standard in this market and already inside the manufacturer's
  -- all-in figure. The Alberta gas RAV4 block heater is the live example: it is
  -- named in Toyota's own pricing formula, so it is NOT an upsell.
  included         boolean not null default false,
  -- False for accessories the manufacturer footnotes "Installation not
  -- included" — a dealer install charge on one of these is legitimate.
  install_included boolean not null default true,

  source_url       text,
  captured_at      timestamptz not null default now()
);

-- One price per accessory per trim. A repeat capture updates rather than
-- duplicates, so a stale price can never sit alongside a fresh one.
create unique index if not exists accessory_catalog_uidx
  on public.accessory_catalog(year, make, model, coalesce(trim, ''), name);
create index if not exists accessory_catalog_lookup_idx
  on public.accessory_catalog(year, make, model);

alter table public.accessory_catalog enable row level security;
-- Service-role writes; the report reads it server-side. No client policy.

-- ---- 2026 RAV4 — accessories priced identically on every trim captured ------
-- Source: Toyota Canada Build & Price accessory pages, captured 2026-08-15.
-- ONLY items whose price was IDENTICAL across both captured trims are seeded at
-- model level. Items that appeared on one trim only, or at two different
-- prices, are deliberately withheld until the trim is identified — see the note
-- at the foot of this file. Missing beats wrong.
insert into public.accessory_catalog
  (year, make, model, trim, name, price, category, included, install_included, source_url)
values
  (2026,'Toyota','RAV4',null,'Pro Series Paint Protection Film - Door Edge',133.44,'protection',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Pro Series Paint Protection Film - Door Cup',123.44,'protection',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Pro Series Paint Protection Film - Hood',578.00,'protection',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Door Panel Scuff Protectors',173.60,'protection',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Front Illuminated Door Sill Protectors',378.60,'interior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Coin Holder / Ashtray Cup',54.80,'interior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Console Vault',551.80,'interior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Rear Hatch Cargo Lamp',652.20,'interior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Hood Deflector',367.60,'exterior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Hood Graphics: Black',315.40,'exterior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Hood Graphics: Grey',315.40,'exterior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Lower Body Graphics: Black',270.40,'exterior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Lower Body Graphics: Grey',270.40,'exterior',false,true,'https://www.toyota.ca/en/build-price/rav4/'),

  -- Cold-weather. The block heater is INCLUDED on the Alberta gas RAV4: Toyota's
  -- own pricing formula reads "...Premium Plug-In Block Heater of up to $797.40,
  -- AMVIC of $10.00...". It is inside the all-in figure, not an upsell — and it
  -- is absent from the PHEV formula entirely, which is why gas and PHEV all-in
  -- adds differ by exactly this amount ($3,861.40 vs $3,064.00).
  (2026,'Toyota','RAV4',null,'Premium Plug-In Block Heater',797.40,'cold_weather',true,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Premium Plug-In Block Heater - Optional 2.5m Home Power Cable',62.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Premium Plug-In Block Heater - Optional 5m Home Power Cable',92.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Premium Plug-In Block Heater - Optional 10m Home Power Cable',132.68,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Battery Trickle Charger',778.81,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'COMFORT+ Programmable Block Heater and Battery Trickle Charger',1471.81,'cold_weather',false,true,'https://www.toyota.ca/en/build-price/rav4/'),

  -- Third-party (Yakima). Toyota footnotes every one "Installation not
  -- included", so a dealer fitting charge on these is legitimate and the fee
  -- audit must not flag it as padding.
  (2026,'Toyota','RAV4',null,'Yakima FrontLoader Rooftop Upright Bike Mount',329.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima HighRoad Premium Rooftop Upright Bike Mount',429.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima FatCat EVO 6 Black Premium Ski & Snowboard Mount',499.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima CBX LG Cargo Box',1349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima SkyBox NX XL',1099.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima SkinnyWarrior Stretch Net',99.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima SkinnyWarrior Cargo Basket',599.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima JayLow J-Cradle Rooftop Kayak Mount',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima KeelOver Canoe Carrier',249.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima EXO OpenRange Leg Kit',349.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima EXO OpenRange Kitchen Cabinet',999.00,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima RoadShower Portable Pressurized Water Storage',749.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/'),
  (2026,'Toyota','RAV4',null,'Yakima OverNOut Lightweight Roof Mounted Awning',579.99,'cargo',false,false,'https://www.toyota.ca/en/build-price/rav4/')
on conflict (year, make, model, coalesce(trim, ''), name) do update
  set price            = excluded.price,
      category         = excluded.category,
      included         = excluded.included,
      install_included = excluded.install_included,
      source_url       = excluded.source_url,
      captured_at      = now();

-- ---------------------------------------------------------------------------
-- DELIBERATELY WITHHELD, pending trim identification. Recorded here so the
-- work is not lost, NOT seeded because attributing them to the wrong trim would
-- put a wrong number in a buyer's report.
--
-- Two prices, two trims — the reason this table is trim-keyed at all:
--   Illuminated Front Emblem            $312.36  |  $382.04
--   Motion Sensor Alarm                 $606.20  |  $566.00
--
-- Captured on ONE trim only (which trim is not yet established):
--   Side Storage LED Lantern              $216.81
--   Side Storage Case Kit                  $91.80
--   Roof Rack                           $1,434.01
--   Cross Bars                            $567.21
--   18" Alloy Wheel - Gunmetal          $1,822.40
--   18" Alloy Wheel - Satin Grey        $1,822.40
--   18" Alloy Wheel - Satin Black       $1,822.40
--   18" Alloy Wheel - Satin Bronze      $1,822.40
--   Blackout Badges                       $116.80
--   Illuminated Trunk Sill                $463.60
--   Body Side Moulding                    $399.00
--   Fog Light Accent: Grey                $183.60
--   Fog Light Accent: Black               $183.60
--   Toyota Genuine Dash Camera Series 2.0 $874.01
--   Towing Hitch Ball Platform            $102.68
--   Towing Hitch Ball 2"                   $61.80
--   Towing Hitch, Ball Platform & Wire Harness $1,630.60
--
-- To seed these, capture the accessory page per trim from
-- toyota.ca/en/build-price/rav4/?year=2026&model=<TRIM CODE> and record which
-- trim each price belongs to.
-- ---------------------------------------------------------------------------
