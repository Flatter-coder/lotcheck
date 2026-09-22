-- Toyota's warranty row cites the page that does not carry its figures.
--
-- WHAT HAPPENED. On 2026-09-21 the warranty verification job reported DRIFT:
-- hybrid_ev_coverage "no longer found on the manufacturer's page. NOT
-- auto-corrected -- a human must re-read the source and update the row."
--
-- A human re-read the source. THE FIGURES ARE CORRECT. Toyota's 2026 Owner's
-- Manual Supplement states, verbatim:
--
--     Hybrid-Related Components Warranty    96 months or 160,000 km
--     Hybrid Battery Warranty              120 months or 240,000 km
--     ELECTRIC VEHICLE TRACTION BATTERY WARRANTY
--       ... in effect for 96 months or 160,000 km
--
-- which is exactly what the row holds. The cited source_url was toyota.ca's
-- warranty landing page, and that page carries ONLY a BEV/Electric Vehicle
-- summary: "96 Months / 160,000 km BEV Specific Components Warranty" and
-- "96 Months / 160,000 km Electric Vehicle Battery Warranty". The string
-- "240,000" does not appear on it, and neither does the word "hybrid" anywhere
-- in its coverage block. The row's own notes field already said the figures
-- came from the Owner's Manual Supplement; the source_url never did.
--
-- WHY THIS MATTERED. Taking the DRIFT at face value and updating the row to
-- match the page would have cut the hybrid battery term from 120 months /
-- 240,000 km to 96 months / 160,000 km -- TWO YEARS AND 80,000 KM removed from
-- every Toyota hybrid report, silently, by a verification job behaving
-- correctly. For a used Prius buyer that is the single most valuable fact in
-- the report. The job's refusal to auto-correct is the only reason it did not
-- happen on its own.
--
-- THE FIGURES ARE NOT CHANGED HERE. Only the citation, so that what we publish
-- points at the document that actually states it. scripts/lib/pdf-text.mjs now
-- lets the verification job read that document, which should also reach Ford,
-- Nissan and Subaru -- all three currently report "cites a printed booklet,
-- not a web page", and all three booklets are published online as PDFs.

update public.manufacturer_warranties
set
  source_url = 'https://www.toyota.ca/content/dam/toyota/pdf/2026_owners_supplement_en.pdf',
  notes = 'Hybrid and EV figures are stated in Toyota Canada''s Owner''s Manual Supplement, not on the warranty landing page: Hybrid-Related Components 96 months/160,000 km, Hybrid Battery 120 months/240,000 km, Electric Vehicle Traction Battery 96 months/160,000 km. Captured 2026-09-22.',
  -- Not "confirmed": this row has not been verified against the NEW citation
  -- yet. Claiming a verification that has not run is the defect the whole
  -- catalogue exists to prevent. The next scheduled run decides.
  verify_status = null,
  verify_note = null
where make = 'Toyota';
