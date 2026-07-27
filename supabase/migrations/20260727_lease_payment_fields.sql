-- lease_rate_catalog — Phase 2 payment fields (additive, nullable).
-- Adds the inputs/outputs needed to show a lease PAYMENT (not just APR):
--   • Track A (Convertus: Ford/Nissan) — residual_pct + cap_cost + down_payment,
--     from which the edge function COMPUTES the payment (money-factor formula).
--   • Track B (SM360: BMW/Mercedes/Infiniti/GM) — advertised_payment(_tax) +
--     selling_price, surfaced directly (dealer's advertised loaded-VIN example).
-- payment_source records which track produced the row's payment ('computed' |
-- 'advertised' | null). All columns nullable so existing APR-only rows are
-- untouched. Run once in the Supabase SQL editor (or `supabase db push`).

alter table public.lease_rate_catalog add column if not exists residual_pct           numeric; -- Track A: lease_residual/100 (e.g. 0.38)
alter table public.lease_rate_catalog add column if not exists cap_cost               numeric; -- Track A: capitalized cost (selling price, lease_initial_price)
alter table public.lease_rate_catalog add column if not exists down_payment           numeric; -- Track A: cash down at signing (lease_amount)
alter table public.lease_rate_catalog add column if not exists advertised_payment     numeric; -- Track B: pre-tax payment (paymentOptions.lease.term.payment)
alter table public.lease_rate_catalog add column if not exists advertised_payment_tax numeric; -- Track B: payment with tax (…term.totalPayment)
alter table public.lease_rate_catalog add column if not exists selling_price          numeric; -- Track B: loaded per-VIN selling price for the advertised example
alter table public.lease_rate_catalog add column if not exists payment_source         text;    -- 'computed' | 'advertised' | null
