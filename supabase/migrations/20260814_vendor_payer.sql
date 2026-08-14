-- ============================================================================
-- Two defects in the founder ledger, both from the same missing fact: ONE
-- FOUNDER PAYS THE VENDORS.
--
-- Vic's card is on file with Anthropic and Scrapfly, so he pays the whole
-- CA$375.71 and the other two reimburse him. The ledger did not know that, so:
--
--   1. VIC'S OWN SHARE READ AS UNPAID. He is charged like everyone else and no
--      payment was ever recorded against it — but he settled it the instant he
--      paid the vendor. The panel told him he owed money he had already paid.
--
--   2. NOTHING SHOWED WHAT HE IS OWED. The data was there (coverage rows record
--      who fronted what) but no view answered the question that actually
--      matters to the person out of pocket: who owes me, and how much.
--
-- Marking one founder as the vendor payer fixes both. His share auto-settles on
-- accrual, and every other founder's outstanding balance is, by definition,
-- money owed to him.
-- ============================================================================

alter table public.founder add column if not exists pays_vendors boolean not null default false;

update public.founder set pays_vendors = true where lower(email) = 'vic@lotcheck.ca';

-- Exactly one payer, or "who is owed" has no answer.
create unique index if not exists founder_single_payer_idx
  on public.founder((pays_vendors)) where pays_vendors;

-- ---- accrual auto-settles the payer's own share ----------------------------
create or replace function public.fn_accrue_statement_charges(p_run uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_run statement_run;
  v_f jsonb;
  v_id uuid;
  v_pays boolean;
  v_n int := 0;
begin
  select * into v_run from statement_run where id = p_run;
  if not found then raise exception 'no statement run %', p_run; end if;

  for v_f in select * from jsonb_array_elements(v_run.snapshot->'founders') loop
    select id, pays_vendors into v_id, v_pays from founder where email = v_f->>'email';
    if v_id is null then continue; end if;

    insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                vendor, line_label, note, recorded_by)
    select v_id, v_run.period_month, 'charge',
           round(
             (case when oc.currency = 'USD'
                   then oc.amount * coalesce((select nullif(text_value,'')::numeric
                                                from admin_config where key = 'fx_usd_cad'), 1.50)
                   else oc.amount end)
             * (v_f->>'share_bps')::numeric / 10000.0, 2),
           oc.vendor, oc.label,
           'Share of ' || oc.label, coalesce(v_run.approved_by, 'system')
      from operational_cost oc
     where oc.active and oc.cadence = 'monthly' and oc.amount > 0
    on conflict do nothing;

    -- The founder whose card pays the vendors settles his own share by paying
    -- them. Recording it here rather than making him tick a box every month is
    -- the difference between a ledger that is true and one that needs
    -- remembering to stay true.
    if v_pays then
      insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                  vendor, line_label, note, recorded_by)
      select v_id, v_run.period_month, 'payment',
             -round(
               (case when oc.currency = 'USD'
                     then oc.amount * coalesce((select nullif(text_value,'')::numeric
                                                  from admin_config where key = 'fx_usd_cad'), 1.50)
                     else oc.amount end)
               * (v_f->>'share_bps')::numeric / 10000.0, 2),
             oc.vendor, oc.label,
             'Own share — settled by paying the vendor directly',
             coalesce(v_run.approved_by, 'system')
        from operational_cost oc
       where oc.active and oc.cadence = 'monthly' and oc.amount > 0
         and not exists (
           select 1 from founder_ledger x
            where x.founder_id = v_id and x.period_month = v_run.period_month
              and x.line_label = oc.label and x.kind = 'payment');
    end if;

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Settle the payer's already-accrued August share the same way.
do $$
declare v_id uuid;
begin
  select id into v_id from founder where pays_vendors limit 1;
  if v_id is null then return; end if;

  insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                              vendor, line_label, note, recorded_by)
  select v_id, l.period_month, 'payment', -l.amount_cad, l.vendor, l.line_label,
         'Own share — settled by paying the vendor directly', 'backfill'
    from founder_ledger l
   where l.founder_id = v_id and l.kind = 'charge'
     and not exists (
       select 1 from founder_ledger x
        where x.founder_id = v_id and x.period_month = l.period_month
          and x.line_label = l.line_label and x.kind = 'payment');
end $$;

-- ---- who owes the payer ----------------------------------------------------
create or replace function public.fn_admin_owed_to_payer()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_payer uuid; v_name text;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select id, display_name into v_payer, v_name from founder where pays_vendors limit 1;
  if v_payer is null then return jsonb_build_object('payer', null, 'total_cad', 0, 'from', '[]'::jsonb); end if;

  select jsonb_build_object(
    'payer', v_name,
    'total_cad', round(coalesce(sum(x.bal), 0), 2),
    'from', coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'email', x.email,
                                                  'owes_cad', round(x.bal, 2))
                     order by x.bal desc) filter (where x.bal > 0.005), '[]'::jsonb)
  ) into v
  from (
    select f.display_name as name, f.email, coalesce(sum(l.amount_cad), 0) as bal
      from founder f left join founder_ledger l on l.founder_id = f.id
     where f.active and f.id <> v_payer
     group by f.display_name, f.email
  ) x;

  return v;
end $$;

revoke all on function public.fn_admin_owed_to_payer() from anon, public;
grant execute on function public.fn_admin_owed_to_payer() to authenticated, service_role;
