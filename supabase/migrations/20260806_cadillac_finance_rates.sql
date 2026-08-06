-- Cadillac advertised finance rates (from cadillaccanada.ca offers, Aug 2026).
-- The OEM advertised APR/term per model, used as the "manufacturer rate" the
-- report compares the dealer's rate against. finance_rate_catalog has no year
-- column, so these are the CURRENT 2026 offers (the bulk of inventory). Note the
-- 2027 EVs advertise different rates right now (2027 LYRIQ 0.99%/60, 2027 OPTIQ
-- 1.99%/60) that this schema can't distinguish — add a year column later if per-
-- year accuracy is needed. Escalade ESV / IQL inherit their nameplate's offer.
-- VISTIQ is a cash offer (no finance rate). Idempotent via delete-then-insert.
delete from public.finance_rate_catalog where make = 'Cadillac';
insert into public.finance_rate_catalog (make, model, apr, term_months, promo, effective_date) values
  ('Cadillac','LYRIQ',        0.00, 72, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','LYRIQ-V',      0.00, 72, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','OPTIQ',        0.00, 72, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','XT5',          0.00, 60, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','Escalade',     5.49, 84, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','Escalade ESV', 5.49, 84, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','Escalade IQ',  5.49, 84, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','Escalade IQL', 5.49, 84, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','CT4',          1.99, 84, 'advertised finance (2026)', '2026-08-06'),
  ('Cadillac','CT5',          1.99, 84, 'advertised finance (2026)', '2026-08-06');
