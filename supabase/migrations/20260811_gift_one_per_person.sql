-- ============================================================================
-- One gift per person — enforced by the DATABASE, not by policy.
--
-- THE HOLE. fn_redeem_gift checked that THE CODE was unused. It never checked
-- whether THIS USER had already redeemed a different one. Single-use per code
-- is not the same promise as one per person: hand out ten links and one
-- recipient could redeem all ten into their own account, and nothing in the
-- schema objected. Free checks cost real money per scan (Nimble + Claude), so
-- that is a spend leak as well as an unfairness.
--
-- WHY A UNIQUE INDEX AND NOT AN `if exists` CHECK IN THE FUNCTION. A read-then-
-- write check races: two redemptions landing together both read "no prior gift"
-- and both insert. The partial unique index makes a second redemption
-- physically impossible regardless of concurrency, transaction isolation, or a
-- future code path that forgets the rule. The function-level check below is
-- kept as well, purely so the USER sees a clear message instead of a 500 — the
-- index is the guarantee, the check is the manners.
--
-- Deliberately partial (`where redeemed_by is not null`): un-redeemed codes all
-- carry NULL, and a plain unique index would let only one of them exist.
--
-- IF THIS MIGRATION FAILS: someone already holds two gifts. The DO block below
-- names them before the index is attempted, so you get a readable error instead
-- of a raw constraint violation. Decide which redemption to keep, clear the
-- other's redeemed_by (and its credit_ledger row), then re-run.
--
-- Depends on: 20260731_admin_share_gifts.sql.
-- ============================================================================

-- ---- 1) fail loudly and readably if existing data already violates the rule --
do $$
declare v_dupes text;
begin
  select string_agg(redeemed_by::text || ' (' || n || ' gifts)', ', ')
    into v_dupes
    from (select redeemed_by, count(*) as n
            from public.gift_code
           where redeemed_by is not null
           group by redeemed_by
          having count(*) > 1) d;
  if v_dupes is not null then
    raise exception
      'Cannot enforce one-gift-per-person: these users already hold more than one: %. Clear the extra gift_code.redeemed_by (and its credit_ledger gift_received row), then re-run.', v_dupes;
  end if;
end $$;

-- ---- 2) the guarantee -------------------------------------------------------
create unique index if not exists ux_gift_code_one_per_person
  on public.gift_code(redeemed_by)
  where redeemed_by is not null;

-- ---- 3) the manners: a clear message instead of a constraint violation ------
-- Identical to the shipped function except for the new "already had one" branch
-- and the unique_violation handler that catches the race the index closes.
create or replace function public.fn_redeem_gift(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
  v_redeemed uuid;
  v_revoked  boolean;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_prior uuid;
begin
  if v_user is null then
    raise exception 'sign in to claim this free check' using errcode = '42501';
  end if;
  if v_code = '' then
    raise exception 'invalid code' using errcode = '22023';
  end if;

  select id, redeemed_by, revoked
    into v_id, v_redeemed, v_revoked
    from gift_code where code = v_code for update;

  if v_id is null then
    raise exception 'this link is not valid' using errcode = 'P0002';
  end if;
  if v_revoked then
    raise exception 'this link was cancelled' using errcode = 'P0002';
  end if;
  if v_redeemed is not null then
    -- idempotent for the SAME user (double-tap); a different user is rejected.
    if v_redeemed = v_user then
      return jsonb_build_object('ok', true, 'personal',
        public.fn_available_credits(v_user, 'personal'), 'already', true);
    end if;
    raise exception 'this link was already used' using errcode = 'P0002';
  end if;

  -- NEW: one per person. Checked here so the buyer reads a sentence, not a 500.
  select id into v_prior from gift_code
    where redeemed_by = v_user and id <> v_id limit 1;
  if v_prior is not null then
    raise exception 'you''ve already claimed a free check' using errcode = 'P0002';
  end if;

  update gift_code set redeemed_by = v_user, redeemed_at = now() where id = v_id;
  insert into credit_ledger(user_id, kind, delta, reason, gift_id)
    values (v_user, 'personal', 1, 'gift_received', v_id);

  return jsonb_build_object('ok', true,
    'personal', public.fn_available_credits(v_user, 'personal'), 'already', false);
exception
  -- The index fired: a concurrent redemption won the race between the check
  -- above and this update. Same message, so the two paths are indistinguishable
  -- to the buyer.
  when unique_violation then
    raise exception 'you''ve already claimed a free check' using errcode = 'P0002';
end; $$;

revoke all on function public.fn_redeem_gift(text) from public;
grant execute on function public.fn_redeem_gift(text) to authenticated;
