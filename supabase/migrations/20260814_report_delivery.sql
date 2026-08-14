-- ============================================================================
-- Report delivery ledger — proof that an email carrying the report was sent.
--
-- WHY. Until now the send was fire-and-forget: email-quote-report persisted
-- nothing, and the Resend response was discarded on success, so the provider
-- message id — the only token that correlates our send with Resend's own
-- record — was thrown away the instant it arrived. The single send-adjacent
-- row in the system is written by the BROWSER (App.jsx, quote_report_leads)
-- *after* the UI flips to "sent", so a failed send leaves no trace anywhere.
-- When a buyer said "I never got my report" the honest answer was: we cannot
-- tell. This table is that answer.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT STORE, AND WHY
--
-- LotCheck promises, in eleven places including the face of the PDF and the
-- email body, that nothing is stored:
--   email-quote-report/index.ts:375  "Keep this email — nothing is stored on our end"
--   email-quote-report/index.ts:380  "Sent once to the address you entered — not saved on our end"
--   App.jsx:7187                     "Tamper-proof · nothing stored"
--   App.jsx:9364                     "LotCheck never saves your quote ... nothing is stored"
--   App.jsx:7111                     a report ID "can't be checked on its own
--                                     (nothing is stored to look it up)"
-- and check-copy-compliance.mjs pins that promise as condition-bound.
--
-- So this ledger records the ACT of sending and nothing about the person or
-- the vehicle. Specifically absent, each for a stated reason:
--
--   recipient address     — "not saved on our end". Not the address, and not a
--                           hash of it either: a keyed hash is still derived
--                           from the address, and whether that counts as
--                           "saved" is counsel's call, not ours. We keep only
--                           the DOMAIN (gmail.com), which identifies nobody.
--   the quote / analysis  — "analyzed once, never stored". No analysis JSON,
--                           no uploaded-file hash, no vehicle, no dealer.
--   report_id             — App.jsx:7111 tells buyers a report ID cannot be
--                           looked up. Storing and indexing it would make that
--                           sentence false.
--   the PDF bytes         — we store only their SHA-256. We can prove WHICH
--                           bytes we sent; we cannot reproduce the document.
--
-- What survives is enough to settle the two disputes that actually happen:
--   "you never sent it"        -> the attempt row + the provider message id +
--                                 the provider's own delivered/bounced event
--   "you sent the wrong file"  -> the customer forwards their PDF, an admin
--                                 hashes it, and it matches a row or it does not
--
-- Lookup without an address: filter by domain + time window. The send guard
-- caps the system at a few hundred emails a day, so that is tractable.
--
-- ---------------------------------------------------------------------------
-- NOT YET CLEARED (see legal_question rows seeded at the bottom)
--   * CASL: the email carries a promotional CTA ("Check another quote →",
--     index.ts:381) and has NO unsubscribe and NO physical mailing address.
--     If the s.6(6) transactional exemption fails, s.6(2) requires both. This
--     ledger does not fix that and must not be read as making the send lawful.
--   * Whether recipient_domain + timestamp is personal information under PIPA.
-- ============================================================================

-- ---- 1) one immutable row per send ATTEMPT ---------------------------------
create table if not exists public.report_delivery (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- what was sent
  pdf_sha256        text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_bytes         integer not null check (pdf_bytes > 0),
  pdf_builder_ver   text not null,          -- the PDF is rebuilt per send; a later
                                            -- rebuild can hash differently. This makes
                                            -- that explainable rather than damning.
  html_sha256       text     check (html_sha256 ~ '^[0-9a-f]{64}$'),
  capture_attached  boolean not null default false,
  signature_ok      boolean not null default false,  -- was the analysis provably signed

  -- who, at the coarsest resolution that identifies nobody
  recipient_domain  text not null,

  -- provider correlation, filled from the Resend response
  provider          text not null default 'resend',
  provider_msg_id   text,

  -- terminal outcome of the attempt itself (not of delivery — see events)
  accepted          boolean not null default false,
  error_code        text,
  -- Write-once guard. Set when the provider's answer is sealed onto the row.
  -- NOT provider_msg_id: a provider ERROR carries no message id, so using that
  -- as the guard would leave every failed attempt permanently re-writable.
  sealed_at         timestamptz
);

create index if not exists report_delivery_created_idx  on public.report_delivery(created_at desc);
create index if not exists report_delivery_pdf_idx      on public.report_delivery(pdf_sha256);
create index if not exists report_delivery_msg_idx      on public.report_delivery(provider_msg_id)
  where provider_msg_id is not null;
create index if not exists report_delivery_domain_idx   on public.report_delivery(recipient_domain, created_at desc);

-- ---- 2) append-only event stream (ours + provider webhooks) ----------------
-- Current status is DERIVED from these, never stored as a mutable column. A
-- mutable status column is the usual way a ledger destroys the history it was
-- built to keep.
create table if not exists public.report_delivery_event (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid references public.report_delivery(id) on delete restrict,
  created_at    timestamptz not null default now(),
  kind          text not null check (kind in (
                  'queued','accepted','provider_error',
                  'delivered','bounced','complained','opened')),
  -- Provider events arrive signed; ours do not. This records WHERE the event
  -- came from so a query can weigh it. It must never be used to filter our own
  -- events out of the status view (that bug was caught in review).
  origin        text not null default 'internal' check (origin in ('internal','provider')),
  sig_verified  boolean not null default false,
  provider_msg_id text,
  detail        text,
  unique (delivery_id, kind, created_at)
);
create index if not exists rde_delivery_idx on public.report_delivery_event(delivery_id, created_at);
create index if not exists rde_msg_idx      on public.report_delivery_event(provider_msg_id)
  where provider_msg_id is not null;

-- ---- 3) append-only enforcement -------------------------------------------
-- Tamper-EVIDENT, not immutable: a superuser can drop a trigger. Never
-- describe this as immutable in customer-facing or legal copy.
-- Strictly append-only: used for the event stream, which never changes.
create or replace function public.fn_delivery_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'report delivery ledger is append-only (attempted % on %)', TG_OP, TG_TABLE_NAME
    using errcode = '42501';
end $$;

-- The attempt row needs exactly ONE post-insert write: the provider's answer,
-- which is unknown until the Resend call returns. Rather than disabling the
-- trigger to do it (that needs table ownership and takes an ACCESS EXCLUSIVE
-- lock, and leaks if the function raises between disable and re-enable), the
-- trigger itself permits that single transition and refuses everything else.
-- Write-once is enforced by `OLD.provider_msg_id is null`.
create or replace function public.fn_delivery_seal_once()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'report_delivery is append-only (attempted DELETE)' using errcode = '42501';
  end if;
  if OLD.sealed_at is null
     and NEW.sealed_at        is not null
     and NEW.id               =  OLD.id
     and NEW.created_at       =  OLD.created_at
     and NEW.pdf_sha256       =  OLD.pdf_sha256
     and NEW.pdf_bytes        =  OLD.pdf_bytes
     and NEW.pdf_builder_ver  =  OLD.pdf_builder_ver
     and NEW.recipient_domain =  OLD.recipient_domain
     and NEW.provider         =  OLD.provider
     and NEW.capture_attached =  OLD.capture_attached
     and NEW.signature_ok     =  OLD.signature_ok
     and NEW.html_sha256      is not distinct from OLD.html_sha256
  then
    return NEW;   -- sealing the provider answer onto an unsealed attempt
  end if;
  raise exception 'report_delivery is append-only; only the provider result may be sealed, once'
    using errcode = '42501';
end $$;

drop trigger if exists report_delivery_append_only on public.report_delivery;
create trigger report_delivery_append_only
  before update or delete on public.report_delivery
  for each row execute function public.fn_delivery_seal_once();

drop trigger if exists rde_append_only on public.report_delivery_event;
create trigger rde_append_only
  before update or delete on public.report_delivery_event
  for each row execute function public.fn_delivery_append_only();

alter table public.report_delivery       enable row level security;
alter table public.report_delivery_event enable row level security;
-- No policies at all: nothing but SECURITY DEFINER functions and the service
-- role can see these rows. Buyers never read this table.

-- ---- 4) writes (called by the edge function, service role) -----------------
-- Returns the new delivery id. Callers MUST treat a failure here as non-fatal:
-- a ledger outage must never stop a buyer receiving their report. That makes
-- gaps possible, which is why fn_admin_delivery_ledger reports an attempt/row
-- reconciliation instead of assuming completeness.
create or replace function public.fn_record_delivery_attempt(
  p_pdf_sha256       text,
  p_pdf_bytes        integer,
  p_pdf_builder_ver  text,
  p_recipient_domain text,
  p_html_sha256      text default null,
  p_capture_attached boolean default false,
  p_signature_ok     boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into report_delivery (
    pdf_sha256, pdf_bytes, pdf_builder_ver, recipient_domain,
    html_sha256, capture_attached, signature_ok
  ) values (
    lower(p_pdf_sha256), p_pdf_bytes, p_pdf_builder_ver, lower(p_recipient_domain),
    lower(nullif(p_html_sha256,'')), coalesce(p_capture_attached,false), coalesce(p_signature_ok,false)
  ) returning id into v_id;

  insert into report_delivery_event (delivery_id, kind, origin) values (v_id, 'queued', 'internal');
  return v_id;
end $$;

-- Records the provider's answer. `accepted` and `provider_msg_id` live on the
-- attempt row too, because the attempt row is what a dispute lookup starts
-- from; the event stream is the history.
create or replace function public.fn_record_delivery_result(
  p_delivery_id     uuid,
  p_accepted        boolean,
  p_provider_msg_id text default null,
  p_error_code      text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Permitted by fn_delivery_seal_once, and only while sealed_at is still
  -- null — so the provider answer is written exactly once, ever.
  update report_delivery
     set accepted        = coalesce(p_accepted, false),
         provider_msg_id = nullif(p_provider_msg_id,''),
         error_code      = nullif(p_error_code,''),
         sealed_at       = now()
   where id = p_delivery_id
     and sealed_at is null;

  insert into report_delivery_event (delivery_id, kind, origin, provider_msg_id, detail)
  values (
    p_delivery_id,
    case when p_accepted then 'accepted' else 'provider_error' end,
    'internal',
    nullif(p_provider_msg_id,''),
    nullif(p_error_code,'')
  );
end $$;

-- Provider webhook events. Correlates by message id; if we have no matching
-- attempt the row is still recorded with a null delivery_id rather than being
-- dropped, because a delivered event we cannot correlate is still evidence
-- that something was delivered.
create or replace function public.fn_record_delivery_webhook(
  p_provider_msg_id text,
  p_kind            text,
  p_sig_verified    boolean,
  p_detail          text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_delivery uuid;
begin
  select id into v_delivery from report_delivery
   where provider_msg_id = p_provider_msg_id
   order by created_at desc limit 1;

  insert into report_delivery_event (delivery_id, kind, origin, sig_verified, provider_msg_id, detail)
  values (v_delivery, p_kind, 'provider', coalesce(p_sig_verified,false),
          p_provider_msg_id, nullif(p_detail,''));
  return v_delivery;
end $$;

-- ---- 5) derived status -----------------------------------------------------
-- Note the absence of any `sig_verified` filter: our own accepted/queued
-- events carry no signature, and filtering on it would silently hide every
-- send from its own status view.
create or replace view public.v_report_delivery_status as
select d.id,
       d.created_at,
       d.recipient_domain,
       d.pdf_sha256,
       d.pdf_bytes,
       d.provider_msg_id,
       d.accepted,
       d.error_code,
       d.capture_attached,
       d.signature_ok,
       max(e.created_at) filter (where e.kind = 'delivered')  as delivered_at,
       max(e.created_at) filter (where e.kind = 'bounced')    as bounced_at,
       max(e.created_at) filter (where e.kind = 'complained') as complained_at,
       -- Opens are recorded but are NOT evidence: image blocking suppresses
       -- them and Apple Mail Privacy Protection manufactures them. The absence
       -- of an open proves nothing. Never argue from this column.
       max(e.created_at) filter (where e.kind = 'opened')     as opened_at_weak
  from report_delivery d
  left join report_delivery_event e on e.delivery_id = d.id
 group by d.id;

-- ---- 6) admin reads --------------------------------------------------------
create or replace function public.fn_admin_delivery_ledger(p_hours integer default 24)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_since timestamptz := now() - make_interval(hours => greatest(1, p_hours));
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select jsonb_build_object(
    'window_hours', p_hours,
    'attempts',     count(*),
    'accepted',     count(*) filter (where accepted),
    'provider_err', count(*) filter (where not accepted),
    'no_msg_id',    count(*) filter (where accepted and provider_msg_id is null),
    'delivered',    count(*) filter (where delivered_at   is not null),
    'bounced',      count(*) filter (where bounced_at     is not null),
    'complained',   count(*) filter (where complained_at  is not null),
    'stalled_1h',   count(*) filter (
                      where accepted and delivered_at is null and bounced_at is null
                        and created_at < now() - interval '1 hour'),
    'with_capture', count(*) filter (where s.capture_attached),
    'signed',       count(*) filter (where s.signature_ok)
  ) into v
  from v_report_delivery_status s
  where s.created_at >= v_since;

  return v;
end $$;

-- Dispute lookup 1: the customer forwards the PDF they received. Hash it and
-- ask whether those exact bytes are what we sent.
create or replace function public.fn_admin_delivery_by_pdf(p_pdf_sha256 text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) into v
    from v_report_delivery_status s where s.pdf_sha256 = lower(p_pdf_sha256);
  return v;
end $$;

-- Dispute lookup 2: no PDF to hash. Filter by the domain they gave us and the
-- day they say they requested it. Coarse on purpose — we hold nothing finer.
create or replace function public.fn_admin_delivery_by_domain(
  p_domain text, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) into v
    from v_report_delivery_status s
   where s.recipient_domain = lower(p_domain)
     and s.created_at >= p_from and s.created_at < p_to;
  return v;
end $$;

-- ---- 7) grants -------------------------------------------------------------
revoke all on function public.fn_record_delivery_attempt(text,integer,text,text,text,boolean,boolean) from public;
revoke all on function public.fn_record_delivery_result(uuid,boolean,text,text)                       from public;
revoke all on function public.fn_record_delivery_webhook(text,text,boolean,text)                      from public;
revoke all on function public.fn_admin_delivery_ledger(integer)                                       from public;
revoke all on function public.fn_admin_delivery_by_pdf(text)                                          from public;
revoke all on function public.fn_admin_delivery_by_domain(text,timestamptz,timestamptz)               from public;

grant execute on function public.fn_record_delivery_attempt(text,integer,text,text,text,boolean,boolean) to service_role;
grant execute on function public.fn_record_delivery_result(uuid,boolean,text,text)                       to service_role;
grant execute on function public.fn_record_delivery_webhook(text,text,boolean,text)                      to service_role;
grant execute on function public.fn_admin_delivery_ledger(integer)                                       to authenticated, service_role;
grant execute on function public.fn_admin_delivery_by_pdf(text)                                          to authenticated, service_role;
grant execute on function public.fn_admin_delivery_by_domain(text,timestamptz,timestamptz)               to authenticated, service_role;

-- ---- 8) open questions for counsel ----------------------------------------
-- Seeded as drafts in the legal register so they cannot be forgotten. The
-- ledger is safe to run without answers; the SEND may not be.
-- Guarded on purpose. legal_question comes from 20260810_legal_register.sql,
-- which is in the repo but was never applied to production — and a migration
-- that creates the delivery ledger must not fail because an OPTIONAL
-- bookkeeping seed has an unmet dependency. The tables above are the point;
-- these two rows are a note to counsel. If the register is absent we say so
-- and carry on, and re-running this after the register lands picks them up.
--
-- legal_question is keyed by the question TEXT (ux_legal_question_text), not by
-- a slug — `on conflict (question)` is what makes re-running this idempotent.
do $$
begin
  if to_regclass('public.legal_question') is null then
    raise notice 'legal_question is not present — skipping the counsel-question seed. Apply 20260810_legal_register.sql, then re-run this migration to record them.';
    return;
  end if;

  insert into public.legal_question (question, jurisdiction, blocks, status)
  values
  ('The Quote Check report email is buyer-initiated and one-off: the buyer types their own address on the results screen to receive that specific report. There is no subscription, no list, and no recurring send - each email is delivered once, in response to a request the buyer just made. On that basis it is treated as transactional delivery (and arguably express consent under CASL s.10, since the buyer solicited it). Residual question for counsel: the footer carries a link to the paid product ("Check another quote", email-quote-report/index.ts:381), and the function sets no unsubscribe header and no physical mailing address. Does that link affect the s.6(6) analysis, and if the message is a CEM, do the s.6(2) form requirements apply notwithstanding that the buyer asked for it?',
   'CA-federal',
   array['report email send path'],
   'open'),
  ('report_delivery stores the recipient email DOMAIN (e.g. gmail.com) and a timestamp, never the address or a hash of it. Is domain + timestamp personal information under Alberta PIPA, and does storing it contradict the shipped promise "Sent once to the address you entered - not saved on our end"?',
   'CA-AB',
   array['report_delivery.recipient_domain'],
   'open')
  on conflict (question) do nothing;
end $$;
