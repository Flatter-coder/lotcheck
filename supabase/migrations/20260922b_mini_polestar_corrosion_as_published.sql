-- MINI and Polestar corrosion: the 12 years are theirs, the kilometres were ours.
--
-- WHAT HAPPENED. Both rows drifted on 2026-09-21 with the same note:
-- corrosion_coverage="12-year/unlimited km" no longer found on the
-- manufacturer's page. Both pages were re-read on 2026-09-22 and both DO state
-- the coverage -- just not the distance.
--
-- MINI (https://mini.ca/en/owners/mini-service):
--   "our standard 4-year/80,000 km New Car Limited Warranty and 12-year Rust
--    Perforation Warranty*"
--   The term is stated. No kilometre figure appears anywhere near it. The word
--   "unlimited" appears eight times on that page -- every one of them about
--   maintenance packages or parts warranties, never about rust perforation.
--   That is very likely how it got attached in the first place.
--
-- POLESTAR (https://www.polestar.com/en-ca/polestar-2/warranty-and-service/):
--   "Corrosion warranty: covers the repair or replacement of affected panel(s)
--    perforated by corrosion ... Coverage lasts for the first 12 years after
--    delivery, regardless of a change in ownership, with possible regional
--    variations."
--   The word "unlimited" appears ZERO times on that page. Polestar states a
--   distance limit explicitly for its other two warranties -- "or 80,000 km,
--   whichever comes first" for the vehicle, "8 years or 160,000 kilometres" for
--   the battery -- and deliberately gives none for corrosion.
--
-- SO THE YEARS STAY AND THE KILOMETRES GO. "Unlimited" is a reasonable reading
-- of a rust-through warranty with no stated ceiling, and it is still a reading.
-- We publish what the manufacturer published.
--
-- THE BEHAVIOUR DOES NOT CHANGE BY ACCIDENT. parseCoverage() returned km = null
-- for BOTH "unlimited km" and "no km mentioned", and RemainingTerm turned
-- km == null into kmUnlimited, which the report rendered as "(distance
-- unlimited)". Dropping the text alone would have left the report making the
-- same unsourced claim from a shorter string. parseCoverage now carries
-- kmExplicitlyUnlimited and the report says, for these two, that the maker
-- publishes no kilometre limit and the terms should be confirmed with the
-- dealer. Absence stops reading as knowledge.
--
-- Polestar's own hedge -- "with possible regional variations" -- is captured in
-- notes rather than dropped, per the fine-print rule.

update public.manufacturer_warranties
set
  corrosion_coverage = '12-year rust perforation',
  notes = 'Corrosion term as MINI Canada publishes it: "12-year Rust Perforation Warranty". MINI states no kilometre limit for this coverage; the previous "/unlimited km" was not supported by the source. Captured 2026-09-22.',
  verify_status = null,
  verify_note = null
where make = 'MINI';

update public.manufacturer_warranties
set
  corrosion_coverage = '12-year corrosion perforation',
  notes = 'Corrosion term as Polestar publishes it: "Coverage lasts for the first 12 years after delivery, regardless of a change in ownership, with possible regional variations." Polestar states no kilometre limit for corrosion, though it does state one for the vehicle (80,000 km) and battery (160,000 km) warranties; the previous "/unlimited km" was not supported by the source. REGIONAL VARIATIONS ARE POSSIBLE per Polestar''s own wording. Captured 2026-09-22.',
  verify_status = null,
  verify_note = null
where make = 'Polestar';
