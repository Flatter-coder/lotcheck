-- ============================================================================
-- Vendor invoice ingest — stop reading consoles to keep the cost panel true.
--
-- Anthropic and Scrapfly both email invoices. Forward them to an inbound
-- address and this parses the amount, currency, period and invoice number, then
-- stages the result against the matching operational_cost line.
--
-- STAGED, NOT APPLIED — and this is the whole security design.
--
-- A FORWARDED email loses its original envelope sender, so "this genuinely came
-- from Anthropic" is not cryptographically provable at the point we receive it.
-- An endpoint that silently rewrites what LotCheck believes it spends, from an
-- email, is a forgery target with a very quiet failure mode: you would plan
-- against a number someone else chose. So an ingested invoice lands as
-- `pending` and changes nothing until an admin applies it. One click, with the
-- parsed figures and the raw subject line in front of you.
--
-- Costs are also append-only history: every invoice ever ingested stays, so
-- "what did we actually pay in May" is answerable later, not just "what is the
-- current monthly figure".
-- ============================================================================

create table if not exists public.vendor_invoice (
  id             uuid primary key default gen_random_uuid(),
  received_at    timestamptz not null default now(),

  vendor         text not null check (vendor in ('anthropic','scrapfly','nimble','other')),
  invoice_no     text,
  amount         numeric(10,2) check (amount >= 0),
  currency       text check (currency in ('CAD','USD')),
  period_start   date,
  period_end     date,
  paid_at        date,

  -- What arrived, kept verbatim so a bad parse is diagnosable rather than a
  -- mystery. No message body: the subject and sender are enough to identify an
  -- invoice, and the body can carry account details we have no reason to hold.
  from_address   text,
  subject        text,
  parse_note     text,

  status         text not null default 'pending'
                   check (status in ('pending','applied','rejected','duplicate')),
  applied_at     timestamptz,
  applied_by     text
);

-- Same invoice forwarded twice is a duplicate, not a second charge.
create unique index if not exists vendor_invoice_no_idx
  on public.vendor_invoice(vendor, invoice_no) where invoice_no is not null;
create index if not exists vendor_invoice_status_idx on public.vendor_invoice(status, received_at desc);

alter table public.vendor_invoice enable row level security;

-- Applied/rejected rows are terminal: the audit value is that a decision, once
-- made, is not quietly re-made. Only pending -> {applied,rejected,duplicate}.
create or replace function public.fn_vendor_invoice_terminal()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'vendor_invoice is append-only' using errcode = '42501';
  end if;
  if OLD.status <> 'pending' then
    raise exception 'vendor_invoice %: already %, decisions are final', OLD.id, OLD.status
      using errcode = '42501';
  end if;
  return NEW;
end $$;

drop trigger if exists vendor_invoice_terminal on public.vendor_invoice;
create trigger vendor_invoice_terminal
  before update or delete on public.vendor_invoice
  for each row execute function public.fn_vendor_invoice_terminal();

-- ---- ingest (edge function, service role) ----------------------------------
-- Returns the row id, or null when it is a duplicate we have already seen.
create or replace function public.fn_ingest_vendor_invoice(
  p_vendor       text,
  p_invoice_no   text default null,
  p_amount       numeric default null,
  p_currency     text default null,
  p_period_start date default null,
  p_period_end   date default null,
  p_paid_at      date default null,
  p_from         text default null,
  p_subject      text default null,
  p_parse_note   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into vendor_invoice (vendor, invoice_no, amount, currency, period_start,
                              period_end, paid_at, from_address, subject, parse_note)
  values (p_vendor, nullif(p_invoice_no,''), p_amount, nullif(p_currency,''),
          p_period_start, p_period_end, p_paid_at, nullif(p_from,''),
          left(nullif(p_subject,''), 300), nullif(p_parse_note,''))
  on conflict (vendor, invoice_no) where invoice_no is not null do nothing
  returning id into v_id;
  return v_id;
end $$;

-- ---- admin: review + apply -------------------------------------------------
create or replace function public.fn_admin_pending_invoices()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc), '[]'::jsonb) into v
    from (select id, received_at, vendor, invoice_no, amount, currency,
                 period_start, period_end, paid_at, from_address, subject, parse_note, status
            from vendor_invoice
           where status = 'pending'
           order by received_at desc limit 25) x;
  return v;
end $$;

-- Applying writes the invoice amount onto the matching operational_cost line.
-- Matching is by vendor + currency, and it refuses rather than guesses when a
-- vendor has more than one line in that currency: silently updating the wrong
-- line is worse than asking.
create or replace function public.fn_admin_apply_invoice(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv vendor_invoice;
  v_line_id uuid;
  v_n int;
  v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select * into v_inv from vendor_invoice where id = p_id and status = 'pending';
  if not found then raise exception 'no pending invoice %', p_id; end if;
  if v_inv.amount is null or v_inv.currency is null then
    raise exception 'invoice % has no parsed amount/currency — reject it and enter the line by hand', p_id;
  end if;

  select count(*), min(id) into v_n, v_line_id
    from operational_cost
   where active and vendor = v_inv.vendor and currency = v_inv.currency and cadence = 'monthly';

  if v_n = 0 then
    raise exception 'no operational_cost line for % in %', v_inv.vendor, v_inv.currency;
  elsif v_n > 1 then
    raise exception '% has % lines in % — apply by hand rather than guess', v_inv.vendor, v_n, v_inv.currency;
  end if;

  update operational_cost
     set amount = v_inv.amount,
         billing_day = coalesce(extract(day from v_inv.period_start)::int, billing_day),
         note = coalesce('Invoice ' || v_inv.invoice_no, note),
         updated_at = now()
   where id = v_line_id;

  update vendor_invoice
     set status = 'applied', applied_at = now(), applied_by = v_actor
   where id = p_id;

  return jsonb_build_object('applied', true, 'line_id', v_line_id,
                            'amount', v_inv.amount, 'currency', v_inv.currency);
end $$;

create or replace function public.fn_admin_reject_invoice(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  update vendor_invoice set status = 'rejected', applied_at = now(), applied_by = v_actor
   where id = p_id and status = 'pending';
end $$;

-- ---- grants (explicit roles — see 20260814_lock_service_role_functions.sql) --
revoke all on function public.fn_ingest_vendor_invoice(text,text,numeric,text,date,date,date,text,text,text) from anon, authenticated, public;
grant execute on function public.fn_ingest_vendor_invoice(text,text,numeric,text,date,date,date,text,text,text) to service_role;

revoke all on function public.fn_admin_pending_invoices() from anon, public;
revoke all on function public.fn_admin_apply_invoice(uuid) from anon, public;
revoke all on function public.fn_admin_reject_invoice(uuid) from anon, public;
grant execute on function public.fn_admin_pending_invoices() to authenticated, service_role;
grant execute on function public.fn_admin_apply_invoice(uuid) to authenticated, service_role;
grant execute on function public.fn_admin_reject_invoice(uuid) to authenticated, service_role;
