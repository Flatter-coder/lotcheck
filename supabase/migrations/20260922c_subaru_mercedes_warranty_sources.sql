-- Subaru and Mercedes-Benz: cite the documents that actually state the figures.
--
-- Both rows reported "cites a printed booklet, not a web page, so there is
-- nothing to re-read". Both booklets are published online as PDFs, which
-- scripts/lib/pdf-text.mjs can now read. Verified by running verifyRow against
-- the extracted text on 2026-09-22.
--
-- SUBARU -> confirmed, all fields, against the Subaru Warranty Booklet
-- (617,109 characters of extractable text). Its source_url previously held
-- "https://www.subaru.ca (Subaru Warranty Coverage Booklet)" -- the title
-- jammed into the URL field, which is why every run logged a URL parse failure.
--
-- MERCEDES-BENZ -> the MY2027 Passenger Car Warranty Book states, verbatim:
--
--     BASIC WARRANTY 4 YEARS/80,000 KM
--     SURFACE CORROSION 4 YEARS/80,000 KM
--     PERFORATION CORROSION 5 YEARS/UNLIMITED KM
--     PLUG-IN HYBRID HIGH VOLTAGE BATTERY 6 YEARS/100,000 KM
--
-- which confirms basic, powertrain, corrosion and hybrid. Note that Mercedes
-- publishes TWO corrosion terms; the row holds the PERFORATION one, which is
-- the rust-through figure the report labels, not the 4-year surface term.
--
-- ROADSIDE ASSISTANCE IS REMOVED, NOT KEPT. The row held "4-year/80,000 km".
-- The warranty book names the 24-Hour Roadside Assistance Program and states
-- NO term for it, and nothing else we hold cites one. A figure we cannot point
-- at is a figure we invented, however plausible -- that is the whole lesson of
-- MINI's and Polestar's "unlimited km" earlier today. Ford and Nissan already
-- carry null here, so the report handles its absence.
--
-- FORD AND NISSAN ARE NOT FIXED HERE, and are deliberately left as they are.
-- Ford's owner-manuals page requires a VIN or model selection before it will
-- show a warranty guide; Nissan's warranties-and-coverage page loads 191KB and
-- states no term at all, for the same reason. Neither publishes a booklet at a
-- stable URL we could find. "cites a printed booklet" remains the truthful
-- status for both, and inventing a URL to silence it would be worse than the
-- warning.

update public.manufacturer_warranties
set
  source_url = 'https://www.subaru.ca/content/7907/Media/General/webimage/whybuy/Subaru_Warranty_Booklet_EN.pdf',
  notes = 'Verified against the Subaru Warranty Booklet PDF, which states all stored terms. Corrosion is the perforation figure and Subaru publishes no distance limit for it. Captured 2026-09-22.',
  verify_status = null,
  verify_note = null
where make = 'Subaru';

update public.manufacturer_warranties
set
  source_url = 'https://www.mercedes-benz.ca/content/dam/mb-nafta/ca/my27-content-request/MY2027_FINAL_PC_Warranty_Book_E_A_EN.pdf',
  -- Unsourced. See the note above: the warranty book names the programme and
  -- states no term, so we publish none.
  roadside_assistance = null,
  notes = 'Verified against the MY2027 Mercedes-Benz Passenger Car Warranty Book: BASIC 4 YEARS/80,000 KM, PERFORATION CORROSION 5 YEARS/UNLIMITED KM, PLUG-IN HYBRID HIGH VOLTAGE BATTERY 6 YEARS/100,000 KM. Mercedes publishes a SEPARATE surface-corrosion term of 4 years/80,000 km; the corrosion field here holds the PERFORATION figure, which is the rust-through one the report labels. Roadside assistance removed: the book names the 24-Hour Roadside Assistance Program and states no term for it. Captured 2026-09-22.',
  verify_status = null,
  verify_note = null
where make = 'Mercedes-Benz';
