-- ============================================================================
-- Free-check abuse: aliases, not housemates.
--
-- JC asked how we stop email abuse if five people live in one house. The
-- answer is that five people in one house are not abuse — they are five real
-- buyers with five real inboxes, and each one hands us a verified address. The
-- obvious defence, a per-IP limit, would block exactly them: housemates share
-- an IP, a determined abuser changes theirs in one tap. It punishes the honest
-- case and barely inconveniences the dishonest one. So there is deliberately NO
-- IP limit on the signed-in grant (free_check_ip_daily only ever guarded the
-- anonymous path, which is now closed).
--
-- The real hole is ONE person with many addresses that reach the SAME inbox:
--
--     vic+1@gmail.com     vic+2@gmail.com     v.i.c@gmail.com
--
-- All three deliver to vic@gmail.com. Gmail ignores dots entirely and treats
-- everything after '+' as a label. To Supabase they are three distinct users,
-- so before this migration one Gmail account was worth unlimited free checks —
-- and the disposable-domain blocklist never fired, because gmail.com is not
-- disposable.
--
-- Fix: normalise to the mailbox that actually receives the mail, and grant the
-- free check once per MAILBOX rather than once per string. Housemates are
-- untouched (five different mailboxes stay five grants); the alias farm gets
-- exactly one.
-- ============================================================================

-- Reduce an address to the inbox it actually lands in.
--   gmail / googlemail  drop dots in the local part, drop the +tag
--   everything else     drop the +tag only — it is near-universal (Outlook,
--                       Proton, Fastmail, iCloud) and dot-stripping is NOT,
--                       so stripping dots elsewhere would wrongly merge two
--                       genuinely different people.
create or replace function public.fn_normalize_email(p_email text)
returns text
language plpgsql immutable set search_path = public as $$
declare
  v text := lower(trim(coalesce(p_email, '')));
  v_local text;
  v_domain text;
begin
  if position('@' in v) = 0 then return v; end if;
  v_local  := split_part(v, '@', 1);
  v_domain := split_part(v, '@', 2);

  v_local := split_part(v_local, '+', 1);          -- drop the +tag

  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local  := replace(v_local, '.', '');         -- gmail ignores dots
    v_domain := 'gmail.com';                       -- googlemail is an alias of gmail
  end if;

  if v_local = '' then return v; end if;           -- never collapse to just '@domain'
  return v_local || '@' || v_domain;
end $$;

-- One free check per mailbox, ever. Append-only: rows are never removed, so a
-- deleted-and-recreated account cannot buy a second grant.
create table if not exists public.free_grant_identity (
  norm_email   text primary key,
  first_user   uuid,
  granted_at   timestamptz not null default now()
);
alter table public.free_grant_identity enable row level security;
-- No policies: only SECURITY DEFINER functions touch this.

-- Backfill from users who already have a signup grant, so today's holders keep
-- theirs and cannot claim again under an alias.
insert into public.free_grant_identity (norm_email, first_user, granted_at)
select distinct on (public.fn_normalize_email(u.email))
       public.fn_normalize_email(u.email), u.id, min(cl.created_at)
  from auth.users u
  join credit_ledger cl on cl.user_id = u.id and cl.reason = 'signup_free'
 where u.email is not null
 group by public.fn_normalize_email(u.email), u.id
 order by public.fn_normalize_email(u.email), min(cl.created_at)
on conflict (norm_email) do nothing;

-- The grant, now keyed on the mailbox.
--
-- A repeat mailbox still gets the SHAREABLE credit. It costs nothing to
-- deliver (it can only be spent by someone else, who must sign in themselves
-- and is therefore a new mailbox), and silently handing a returning user an
-- account with nothing in it reads as broken rather than as policy.
create or replace function public.fn_grant_signup(p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_norm  text;
  v_fresh boolean;
begin
  if exists (select 1 from credit_ledger where user_id = p_user and reason = 'signup_free') then
    return;                                        -- this auth user already granted
  end if;

  select email into v_email from auth.users where id = p_user;
  v_norm := public.fn_normalize_email(v_email);

  insert into free_grant_identity (norm_email, first_user)
  values (v_norm, p_user)
  on conflict (norm_email) do nothing;

  -- Did THIS call claim the mailbox? If the row was already there, an alias of
  -- the same inbox has had its free check.
  select exists (
    select 1 from free_grant_identity
     where norm_email = v_norm and first_user = p_user
  ) into v_fresh;

  if v_fresh then
    insert into credit_ledger(user_id, kind, delta, reason) values
      (p_user, 'personal',  1, 'signup_free'),
      (p_user, 'shareable', 1, 'signup_share');
  else
    insert into credit_ledger(user_id, kind, delta, reason) values
      (p_user, 'shareable', 1, 'signup_share');
    raise notice 'mailbox % already claimed its free check — shareable only', v_norm;
  end if;
end $$;

revoke all on function public.fn_normalize_email(text) from anon, authenticated, public;
grant execute on function public.fn_normalize_email(text) to service_role;

-- Admin view of how often this fires. If it is never non-zero the rule is
-- costing nothing; if it is large, it was load-bearing.
create or replace function public.fn_admin_alias_blocks()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  select jsonb_build_object(
    'mailboxes_granted', (select count(*) from free_grant_identity),
    'auth_users',        (select count(*) from auth.users where email is not null),
    -- Accounts beyond the first on the same mailbox: every one of these is a
    -- free check that alias-farming did NOT get.
    'alias_accounts',    greatest((select count(*) from auth.users where email is not null)
                                  - (select count(*) from free_grant_identity), 0)
  ) into v;
  return v;
end $$;

revoke all on function public.fn_admin_alias_blocks() from anon, public;
grant execute on function public.fn_admin_alias_blocks() to authenticated, service_role;
