-- Cadillac advertised finance rates (from cadillaccanada.ca offers, Aug 2026).
-- OEM advertised APR/term per model, used as the "manufacturer rate" the report
-- compares the dealer's rate against. promo is BOOLEAN (all these are advertised/
-- subvented offers -> true). No year column, so these are the CURRENT 2026 offers
-- (bulk of inventory); the 2027 EVs advertise different rates (2027 LYRIQ 0.99%/60,
-- 2027 OPTIQ 1.99%/60) that this schema can't distinguish. Escalade ESV/IQL inherit
-- their nameplate's offer; VISTIQ is a cash offer (no finance rate). Idempotent.
delete from public.finance_rate_catalog where make = 'Cadillac';
insert into public.finance_rate_catalog (make, model, apr, term_months, promo, effective_date) values
  ('Cadillac','LYRIQ',        0.00, 72, true, '2026-08-06'),
  ('Cadillac','LYRIQ-V',      0.00, 72, true, '2026-08-06'),
  ('Cadillac','OPTIQ',        0.00, 72, true, '2026-08-06'),
  ('Cadillac','XT5',          0.00, 60, true, '2026-08-06'),
  ('Cadillac','Escalade',     5.49, 84, true, '2026-08-06'),
  ('Cadillac','Escalade ESV', 5.49, 84, true, '2026-08-06'),
  ('Cadillac','Escalade IQ',  5.49, 84, true, '2026-08-06'),
  ('Cadillac','Escalade IQL', 5.49, 84, true, '2026-08-06'),
  ('Cadillac','CT4',          1.99, 84, true, '2026-08-06'),
  ('Cadillac','CT5',          1.99, 84, true, '2026-08-06');
