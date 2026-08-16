-- ============================================================================
-- Proof of a paid share, attached to the payment it proves.
--
-- Receipts and the ledger have been two separate lists. A founder uploads a
-- screenshot into one; Vic records a payment in the other; nothing connects
-- them. So the panel could show "Josh paid CA$98" and, elsewhere, "Josh
-- uploaded a file", and a human had to hold both in their head and decide
-- whether they were the same event.
--
-- That is the same defect as everything else fixed today: a claim recorded
-- without the thing that backs it. A payment row is Vic's word for it. With a
-- receipt beside it, it is evidence.
--
-- MATCHED ON FOUNDER + MONTH, not by a foreign key, and deliberately. The
-- receipt is uploaded by the founder and the payment is recorded by Vic,
-- usually minutes or days apart and in either order. A hard link would demand
-- they be created together, and the append-only ledger cannot be edited later
-- to add one. Matching on the two facts they genuinely share means either can
-- arrive first, and neither has to know about the other.
--
-- WHAT IT DOES NOT DO: a receipt still does not settle anything. The balance
-- comes from the ledger alone. This only answers "is there proof behind that
-- payment", which is a different question from "was it paid".
-- ============================================================================

create or replace function public.fn_founder_balances()
returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'name',        f.display_name,
           'email',       f.email,
           'balance_cad', round(coalesce(b.total, 0), 2),
           'charged_cad', round(coalesce(b.charged, 0), 2),
           'paid_cad',    round(abs(coalesce(b.paid, 0)), 2),
           'oldest_unpaid_month', b.oldest,
           'lines', coalesce(b.lines, '[]'::jsonb),
           'unpaid_lines', coalesce(b.unpaid_lines, '[]'::jsonb),
           -- Months this founder has uploaded proof for, and how many files.
           -- The client marks a payment "receipt attached" when its month
           -- appears here — so proof shows up next to the payment it backs
           -- rather than in a separate list nobody cross-references.
           'receipt_months', coalesce(r.months, '[]'::jsonb),
           'receipts_total', coalesce(r.n, 0)
         ) order by f.display_name), '[]'::jsonb)
    from founder f
    left join lateral (
      select sum(amount_cad) as total,
             sum(amount_cad) filter (where kind = 'charge') as charged,
             sum(amount_cad) filter (where kind = 'payment') as paid,
             min(period_month) filter (where kind = 'charge') as oldest,
             jsonb_agg(jsonb_build_object('month', period_month, 'kind', kind,
                                          'vendor', vendor, 'line_label', line_label,
                                          'amount_cad', amount_cad, 'note', note)
                       order by period_month, created_at) as lines,
             (select jsonb_agg(jsonb_build_object('month', o.period_month,
                                                  'line', o.line_label,
                                                  'amount_cad', o.owed)
                      order by o.period_month, o.line_label)
                from (select period_month, line_label, sum(amount_cad) as owed
                        from founder_ledger x
                       where x.founder_id = f.id and x.line_label is not null
                       group by period_month, line_label
                      having sum(amount_cad) > 0.005) o) as unpaid_lines
        from founder_ledger l where l.founder_id = f.id
    ) b on true
    left join lateral (
      select count(*) as n,
             jsonb_agg(distinct to_char(pr.period_month, 'YYYY-MM-DD')) as months
        from payment_receipt pr where pr.founder_id = f.id
    ) r on true
   where f.active;
$$;

-- A payment with no receipt behind it is not wrong — it is just unevidenced,
-- and worth being able to see at a glance rather than reconstructing.
create or replace function public.fn_admin_unproven_payments()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.period_month desc), '[]'::jsonb) into v
    from (
      select f.display_name as founder, l.period_month,
             round(abs(sum(l.amount_cad)), 2) as paid_cad
        from founder_ledger l
        join founder f on f.id = l.founder_id
       where l.kind = 'payment'
         and not exists (
           select 1 from payment_receipt pr
            where pr.founder_id = l.founder_id
              and pr.period_month = l.period_month
         )
       group by f.display_name, l.period_month
    ) x;
  return v;
end $$;

revoke all on function public.fn_admin_unproven_payments() from anon, public;
grant execute on function public.fn_admin_unproven_payments() to authenticated, service_role;
