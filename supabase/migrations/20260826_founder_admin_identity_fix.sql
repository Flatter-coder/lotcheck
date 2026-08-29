-- ============================================================================
-- Fix: the admin login and Vic's founder-ledger identity drifted apart.
--
-- 20260814_statement_approval.sql changed founder.email for Vic from
-- vic.todorovic@gmail.com to vic@lotcheck.ca ("real addresses, all three
-- active"). That address is real (it's the dealer-facing contact in
-- dealer-portal.html) — but it is NOT the address Vic's admin session
-- authenticates with. admin_config.admin_emails, set in
-- 20260730_admin_economics.sql and never touched since, is still
-- vic.todorovic@gmail.com.
--
-- 20260815_founder_access.sql documents the assumption this broke, in its own
-- comment: "Vic is in BOTH sets: he is an admin and an active founder, so
-- nothing he could do before changes." Since that migration, fn_is_admin()
-- (vic.todorovic@gmail.com) and fn_is_founder()/fn_my_founder_id()
-- (vic@lotcheck.ca) check two different addresses — so an admin session no
-- longer satisfies the founder check. Symptom: the RECEIPTS panel, opened
-- from inside the admin session, tells Vic himself "Not a founder account."
--
-- Vic confirmed 2026-08-26: there is one account, not two — he signs into
-- both /admin and /founders with the same login. So the direct fix is to
-- point founder.email back at the address that login actually is
-- (vic.todorovic@gmail.com), matching admin_config.admin_emails again.
-- vic@lotcheck.ca remains his real dealer-facing contact address elsewhere
-- (dealer-portal.html, README) — it was just never a login.
--
-- On top of that direct fix, every place that resolves "which founder is
-- this?" also falls back to Vic's own founder row whenever the caller is
-- admin and no row matches the session email directly. That fallback is
-- redundant today (the email now matches directly) but is left in as the
-- structural guard: it is exactly what would have prevented this class of
-- bug the first time, if the next migration ever moves founder.email again
-- without touching admin_config in the same change. It does not weaken any
-- write gate — every fn_admin_* write still requires fn_is_admin() exactly
-- as before.
-- ============================================================================

update public.founder set email = 'vic.todorovic@gmail.com' where display_name = 'Vic';

create or replace function public.fn_is_founder()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    public.fn_is_admin()
    or exists (
      select 1 from founder f
       where f.active
         and length(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '')) > 0
         and lower(f.email) = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    );
$$;

create or replace function public.fn_my_founder_id()
returns uuid
language sql security definer stable set search_path = public as $$
  select coalesce(
    (select f.id from founder f
      where f.active
        and lower(f.email) = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
      limit 1),
    case when public.fn_is_admin() then
      (select f.id from founder f where f.display_name = 'Vic' and f.active limit 1)
    end
  );
$$;

-- fn_record_receipt() re-derives the founder id itself instead of calling
-- fn_my_founder_id() — same fallback has to be repeated here or the write
-- would still reject what the client, using the fixed fn_my_founder_id(),
-- just built a path for.
create or replace function public.fn_record_receipt(
  p_storage_path text,
  p_period_month date default null,
  p_mime         text default null,
  p_bytes        integer default null,
  p_amount_cad   numeric default null,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  v_fid uuid;
  v_id uuid;
begin
  select id into v_fid from founder where active and lower(email) = v_email;
  if v_fid is null and public.fn_is_admin() then
    select id into v_fid from founder where display_name = 'Vic' and active limit 1;
  end if;
  if v_fid is null then raise exception 'not a founder' using errcode = '42501'; end if;

  if split_part(p_storage_path, '/', 1) <> v_fid::text then
    raise exception 'receipt path does not belong to this founder' using errcode = '42501';
  end if;

  insert into payment_receipt (founder_id, period_month, storage_path, mime, bytes,
                               amount_cad, note, uploaded_by)
  values (v_fid, coalesce(p_period_month, date_trunc('month', now())::date),
          p_storage_path, p_mime, p_bytes, p_amount_cad, nullif(p_note,''), v_email)
  returning id into v_id;
  return v_id;
end $$;

-- The insert storage policy inlines the same email match rather than calling
-- fn_my_founder_id() — without this, the client would build a path in Vic's
-- founder folder (per the fixed RPC above) and storage would still refuse the
-- write because the admin session's JWT email isn't on that folder's founder
-- row.
drop policy if exists receipts_founder_insert on storage.objects;
create policy receipts_founder_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and (
    exists (
      select 1 from public.founder f
       where f.active
         and lower(f.email) = lower(auth.jwt() ->> 'email')
         and (storage.foldername(name))[1] = f.id::text
    )
    or (
      public.fn_is_admin()
      and (storage.foldername(name))[1] = (
        select f.id::text from public.founder f where f.display_name = 'Vic' and f.active limit 1
      )
    )
  )
);
