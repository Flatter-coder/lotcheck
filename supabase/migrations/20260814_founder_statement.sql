-- ============================================================================
-- Founder cost statement — on the 1st, what each of the three owes this month.
--
-- Three founders (Vic, JC, Josh) split the operating bill. The month has two
-- known due dates: the 8th (Claude subscription) and the 10th (Scrapfly), so a
-- statement on the 1st gives a week of notice before the first debit.
--
-- SHARES IN BASIS POINTS, not thirds. CA$414.00 / 3 is exactly 138.00, but the
-- moment the total is not divisible by 3 someone has to absorb a cent, and
-- three rounded thirds famously do not sum to the whole. Basis points summing
-- to 10000 (3333/3333/3334) make the split exact by construction, and they also
-- make an uneven split a data change rather than a code change.
--
-- Nothing here sends anything. The statement is computed; the edge function
-- decides whether to deliver it, and only to addresses in this table.
-- ============================================================================

create table if not exists public.founder (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  email        text not null unique,
  -- Basis points of the monthly bill. Must total 10000 across active founders;
  -- fn_admin_monthly_statement refuses to report if they do not, rather than
  -- quietly producing a split that does not add up to what is owed.
  share_bps    integer not null check (share_bps between 0 and 10000),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.founder enable row level security;

-- Only Vic's address is known. JC's and Josh's are placeholders and are
-- INACTIVE on purpose: an inactive founder is excluded from the split and from
-- delivery, so this cannot email a made-up address or report a two-thirds
-- statement as if it were whole. Set the real addresses, flip active to true,
-- and the split becomes a true third each.
insert into public.founder (display_name, email, share_bps, active) values
  ('Vic',  'vic.todorovic@gmail.com',     3334, true),
  ('JC',   'jc@lotcheck.invalid',         3333, false),
  ('Josh', 'josh@lotcheck.invalid',       3333, false)
on conflict (email) do nothing;

-- ---- the statement ---------------------------------------------------------
create or replace function public.fn_founder_statement()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_fx numeric := 1.50;
  v_total numeric := 0;
  v_bps int := 0;
  v_active int := 0;
begin
  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx
    from admin_config where key = 'fx_usd_cad';

  select coalesce(sum(case when currency = 'USD' then amount * v_fx else amount end), 0)
    into v_total
    from operational_cost where active and cadence = 'monthly';

  select count(*), coalesce(sum(share_bps), 0) into v_active, v_bps
    from founder where active;

  select jsonb_build_object(
    'month',            to_char(now(), 'FMMonth YYYY'),
    'monthly_total_cad', round(v_total, 2),
    'active_founders',  v_active,
    'shares_total_bps', v_bps,
    -- Surfaced rather than swallowed: while JC and Josh are inactive the shares
    -- do not total 10000, and a statement that splits the bill among fewer
    -- people than actually owe it must announce that, not just be wrong.
    'shares_balanced',  (v_bps = 10000),
    'due_dates', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', billing_day, 'label', label,
               'cad', round(case when currency='USD' then amount*v_fx else amount end, 2))
             order by billing_day), '[]'::jsonb)
        from operational_cost where active and cadence='monthly' and billing_day is not null
    ),
    'founders', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name',  display_name,
               'email', email,
               'share_bps', share_bps,
               'owes_cad', round(v_total * share_bps / 10000.0, 2))
             order by display_name), '[]'::jsonb)
        from founder where active
    )
  ) into v;

  return v;
end $$;

create or replace function public.fn_admin_monthly_statement()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.fn_founder_statement();
end $$;

revoke all on function public.fn_founder_statement()        from anon, authenticated, public;
grant execute on function public.fn_founder_statement()        to service_role;
revoke all on function public.fn_admin_monthly_statement()  from anon, public;
grant execute on function public.fn_admin_monthly_statement()  to authenticated, service_role;
