-- ============================================================================
-- Receipt uploads — a founder can attach proof they paid their share.
--
-- Until now a payment existed because Vic typed it in. That is fine between
-- three people who trust each other and useless the moment anyone needs to
-- check. JC asked to be able to upload a screenshot of the e-transfer, which
-- turns "Vic says I paid" into "here is the receipt, dated, next to the entry".
--
-- WHO CAN DO WHAT
--   a founder   uploads their OWN receipts and sees their OWN
--   an admin    sees everyone's, and is the only one who can record the
--               matching ledger payment
--
-- Uploading a receipt does NOT move a balance. It is evidence attached to a
-- claim, not the claim itself — Vic still records the payment after looking at
-- it. Letting an upload settle a debt would mean a screenshot of anything at
-- all clears money owed.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create table if not exists public.payment_receipt (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  founder_id    uuid not null references public.founder(id) on delete restrict,
  period_month  date not null,
  storage_path  text not null unique,
  mime          text,
  bytes         integer,
  amount_cad    numeric(10,2),
  note          text,
  uploaded_by   text
);
create index if not exists payment_receipt_founder_idx on public.payment_receipt(founder_id, period_month desc);
alter table public.payment_receipt enable row level security;

-- ---- storage policies -------------------------------------------------------
-- Path convention: receipts/<founder_id>/<filename>. The first path segment is
-- the founder's id, so a policy can check it belongs to the caller without a
-- join — and a founder cannot write into someone else's folder by renaming.
drop policy if exists receipts_founder_insert on storage.objects;
create policy receipts_founder_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and exists (
    select 1 from public.founder f
     where f.active
       and lower(f.email) = lower(auth.jwt() ->> 'email')
       and (storage.foldername(name))[1] = f.id::text
  )
);

drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and (
    public.fn_is_admin()
    or exists (
      select 1 from public.founder f
       where f.active
         and lower(f.email) = lower(auth.jwt() ->> 'email')
         and (storage.foldername(name))[1] = f.id::text
    )
  )
);

-- No update/delete policy at all: a receipt is evidence, and evidence you can
-- quietly swap after the fact is not evidence.

-- ---- metadata rows ----------------------------------------------------------
-- The caller's own founder id, so the client can build a storage path in its
-- own folder. Returns null for anyone who is not an active founder.
create or replace function public.fn_my_founder_id()
returns uuid
language sql security definer stable set search_path = public as $$
  select f.id from founder f
   where f.active
     and lower(f.email) = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
   limit 1;
$$;
revoke all on function public.fn_my_founder_id() from anon, public;
grant execute on function public.fn_my_founder_id() to authenticated, service_role;

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
  if v_fid is null then raise exception 'not a founder' using errcode = '42501'; end if;

  -- The path must live in the caller's own folder. Without this a founder
  -- could register a row pointing at someone else's receipt.
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

-- Admin sees all; a founder sees their own. Same function, different scope,
-- so the panel does not need to know which one it is talking to.
create or replace function public.fn_list_receipts(p_limit integer default 40)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_email text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  v_admin boolean := public.fn_is_admin();
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v
    from (
      select r.id, r.created_at, r.period_month, r.storage_path, r.amount_cad,
             r.note, r.bytes, f.display_name as founder
        from payment_receipt r
        join founder f on f.id = r.founder_id
       where v_admin or lower(f.email) = v_email
       order by r.created_at desc
       limit greatest(1, least(coalesce(p_limit,40), 200))
    ) x;
  return v;
end $$;

revoke all on function public.fn_record_receipt(text,date,text,integer,numeric,text) from anon, public;
revoke all on function public.fn_list_receipts(integer)                              from anon, public;
grant execute on function public.fn_record_receipt(text,date,text,integer,numeric,text) to authenticated, service_role;
grant execute on function public.fn_list_receipts(integer)                              to authenticated, service_role;
