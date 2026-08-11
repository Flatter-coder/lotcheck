-- ============================================================================
-- LEGAL REGISTER — the single place that records every law, regulation and
-- regulator obligation LotCheck operates under, what we actually DO about each
-- one, and what is still waiting on counsel.
--
-- WHY A TABLE AND NOT A DOC. Legal constraints are already scattered across
-- alberta-scope.md, legal-brief-url-listing-scraping.md, legal-review-flywheel-
-- fee-data.md, dealer-tactics-safeguards.md and a dozen code comments. Scattered
-- means unqueryable: nobody can answer "what applies to marketing copy in
-- Alberta today, and is it covered?" without reading everything. This makes that
-- one SELECT, and makes the gaps visible instead of implicit.
--
-- THREE RULES THIS SCHEMA ENFORCES IN THE DATABASE, not in a habit:
--   1. NO RULE WITHOUT A SOURCE. legal_rule.source_id is NOT NULL — an
--      obligation can never exist here without the instrument it comes from.
--   2. NOTHING "APPROVED" WITHOUT A NAMED APPROVER AND A DATE. A CHECK
--      constraint rejects status='approved' unless approved_by and approved_at
--      are both set (see nothing-published-without-verification).
--   3. VERBATIM OR NOTHING. legal_rule.excerpt holds the source's ACTUAL words,
--      capped at 600 chars. Our paraphrase lives in plain_summary, in a separate
--      column, so the two can never be confused for one another.
--
-- SHIPS AS A REGISTER, NOT A GATE. No product code reads these tables yet.
-- Wiring report copy / retention / outreach to it is a later slice, and doing it
-- before counsel has approved rows would just automate unverified content.
--
-- SEED HONESTY — READ THIS BEFORE USING ANY ROW.
--   Every seeded source is marked verification='unverified' and its url is NULL
--   ON PURPOSE. The citations below are the instruments that apply, but the URL
--   and the section-level text must be filled in by a human reading the official
--   source (Justice Laws / King's Printer / the regulator), not copied from an
--   assistant's memory. Every seeded rule is status='draft' with excerpt NULL
--   for the same reason. Nothing here is legal advice, and nothing here should
--   be treated as confirmed until a row says counsel_verified / approved.
--
-- Depends on: 20260730_admin_economics.sql (fn_is_admin).
-- ============================================================================

-- ---- 1) sources — the instruments themselves --------------------------------
create table if not exists public.legal_source (
  id              bigint generated always as identity primary key,
  jurisdiction    text not null,                    -- 'CA', 'CA-AB', 'CA-ON', 'CA-BC', 'CA-QC', 'US-FL' (locale-abstraction-rule)
  regulator       text,                             -- 'AMVIC', 'OPC', 'Competition Bureau', 'CRTC', 'Service Alberta', ...
  instrument_type text not null check (instrument_type in ('statute','regulation','guidance','case','policy','standard','contract')),
  citation        text not null unique,             -- full legal citation, e.g. 'Consumer Protection Act, RSA 2000, c C-26.3'
  short_name      text,                             -- what we call it in conversation, e.g. 'Alberta CPA'
  url             text,                             -- official source ONLY (Justice Laws, King's Printer, regulator site)
  in_force_from   date,
  retrieved_at    date,                             -- when a human last actually opened `url` and read it
  verified_by     text,
  verification    text not null default 'unverified'
                    check (verification in ('unverified','self_verified','counsel_verified')),
  notes           text,
  created_at      timestamptz not null default now(),
  -- A source can only claim verification once someone is named against it.
  constraint legal_source_verified_has_owner
    check (verification = 'unverified' or (verified_by is not null and retrieved_at is not null))
);
alter table public.legal_source enable row level security;   -- no client policies: admin RPC only

-- ---- 2) rules — atomic obligations derived from a source --------------------
create table if not exists public.legal_rule (
  id            bigint generated always as identity primary key,
  source_id     bigint not null references public.legal_source(id) on delete restrict,
  rule_key      text not null unique,               -- stable slug, safe to reference from code/docs
  locator       text,                               -- 's. 6(1)', 'Part 3, Div 2', 'para 42' — where in the source
  excerpt       text,                               -- VERBATIM source text. Never a summary.
  plain_summary text not null,                      -- OUR words. Never presented as the law's words.
  obligation    text not null check (obligation in ('must','must_not','may','disclose','notify','retain','none')),
  risk          text not null default 'medium' check (risk in ('low','medium','high','blocking')),
  -- Which product surfaces this touches. Kept as an array so one rule can bind
  -- to several: 'report_copy','marketing_copy','pricing_display','data_storage',
  -- 'data_retention','dealer_outreach','reviews','email','scan_source','identity'.
  applies_to    text[] not null default '{}',
  status        text not null default 'draft'
                  check (status in ('draft','counsel_review','approved','superseded','not_applicable')),
  approved_by   text,
  approved_at   timestamptz,
  effective_from date,
  effective_to   date,
  supersedes    text,                               -- rule_key this replaces
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Rule 2: "approved" is meaningless without a name and a date against it.
  constraint legal_rule_approved_has_signoff
    check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  -- Rule 3: the source's own words stay short enough to be a quotation.
  constraint legal_rule_excerpt_len check (excerpt is null or length(excerpt) <= 600),
  constraint legal_rule_dates_sane check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
alter table public.legal_rule enable row level security;
create index if not exists ix_legal_rule_status  on public.legal_rule(status);
create index if not exists ix_legal_rule_applies on public.legal_rule using gin(applies_to);

-- ---- 3) controls — what LotCheck actually does about each rule --------------
create table if not exists public.legal_control (
  id               bigint generated always as identity primary key,
  rule_id          bigint not null references public.legal_rule(id) on delete cascade,
  control_key      text not null unique,
  description      text not null,                   -- the safeguard in one sentence
  implementation   text,                            -- where it lives, e.g. '_shared/invariants.ts#PRICE_NOT_ACCUSED_UNCONFIRMED'
  evidence_url     text,                            -- test run, screenshot, PR
  status           text not null default 'planned'
                     check (status in ('planned','partial','implemented','not_applicable')),
  last_verified_at date,                            -- when someone last confirmed it still works
  verified_by      text,
  owner            text,
  created_at       timestamptz not null default now()
);
alter table public.legal_control enable row level security;
create index if not exists ix_legal_control_rule on public.legal_control(rule_id);

-- ---- 4) open questions — what is sitting with counsel -----------------------
create table if not exists public.legal_question (
  id           bigint generated always as identity primary key,
  question     text not null,
  context      text,
  jurisdiction text,
  blocks       text[] not null default '{}',        -- what can't ship until this is answered
  counsel      text,                                -- who it's with
  status       text not null default 'open'
                 check (status in ('open','with_counsel','answered','closed')),
  raised_at    date not null default current_date,
  asked_at     date,
  answered_at  date,
  answer       text,
  created_at   timestamptz not null default now()
);
alter table public.legal_question enable row level security;
-- Without this, re-running the seed would silently duplicate every question:
-- `on conflict do nothing` only skips a real constraint conflict.
create unique index if not exists ux_legal_question_text on public.legal_question(question);

-- ---- 5) append-only change log ---------------------------------------------
-- Who changed which rule, when, and from what. A legal register you can silently
-- edit is not evidence of anything.
create table if not exists public.legal_change_log (
  id         bigint generated always as identity primary key,
  rule_key   text not null,
  changed_at timestamptz not null default now(),
  changed_by text not null default coalesce(current_setting('request.jwt.claim.email', true), current_user::text),
  field      text not null,
  old_value  text,
  new_value  text
);
alter table public.legal_change_log enable row level security;
create index if not exists ix_legal_change_rule on public.legal_change_log(rule_key, changed_at desc);

create or replace function public.fn_legal_rule_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into legal_change_log(rule_key, field, old_value, new_value) values (new.rule_key, 'status', old.status, new.status);
    end if;
    if new.plain_summary is distinct from old.plain_summary then
      insert into legal_change_log(rule_key, field, old_value, new_value) values (new.rule_key, 'plain_summary', left(old.plain_summary, 500), left(new.plain_summary, 500));
    end if;
    if new.excerpt is distinct from old.excerpt then
      insert into legal_change_log(rule_key, field, old_value, new_value) values (new.rule_key, 'excerpt', left(coalesce(old.excerpt,''), 500), left(coalesce(new.excerpt,''), 500));
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_legal_rule_audit on public.legal_rule;
create trigger trg_legal_rule_audit before update on public.legal_rule
  for each row execute function public.fn_legal_rule_audit();

-- ---- 6) the only view product code should ever read -------------------------
-- Approved, counsel-verified, in force TODAY. A draft row can never leak into
-- anything user-facing by accident.
create or replace view public.legal_rules_active as
  select r.rule_key, r.plain_summary, r.excerpt, r.locator, r.obligation, r.risk, r.applies_to,
         s.jurisdiction, s.regulator, s.citation, s.short_name, s.url,
         r.approved_by, r.approved_at
    from public.legal_rule r
    join public.legal_source s on s.id = r.source_id
   where r.status = 'approved'
     and s.verification = 'counsel_verified'
     and (r.effective_from is null or r.effective_from <= current_date)
     and (r.effective_to   is null or r.effective_to   >= current_date);

-- A view normally runs as its OWNER, which would sail straight past the RLS on
-- the tables underneath it. security_invoker makes it run as the CALLER, so the
-- "no policies" lock on legal_rule/legal_source actually applies here too.
alter view public.legal_rules_active set (security_invoker = on);

-- Belt and braces: Supabase grants anon/authenticated broad default privileges
-- in the public schema. This register is internal — take them back explicitly
-- rather than relying on RLS alone.
revoke all on public.legal_source, public.legal_rule, public.legal_control,
              public.legal_question, public.legal_change_log, public.legal_rules_active
  from anon, authenticated;

-- ---- 7) the gap report — admin-only ----------------------------------------
-- Answers the question the register exists for: what applies to us that we have
-- no implemented safeguard for, worst risk first.
create or replace function public.fn_legal_gaps()
returns table (
  rule_key text, jurisdiction text, risk text, status text,
  applies_to text[], controls int, implemented int, plain_summary text
) language plpgsql stable security definer set search_path = public as $$
begin
  if not fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select r.rule_key, s.jurisdiction, r.risk, r.status, r.applies_to,
           count(c.id)::int,
           count(c.id) filter (where c.status = 'implemented')::int,
           r.plain_summary
      from legal_rule r
      join legal_source s on s.id = r.source_id
      left join legal_control c on c.rule_id = r.id
     where r.status <> 'not_applicable'
     group by r.id, s.jurisdiction
    having count(c.id) filter (where c.status = 'implemented') = 0
     order by case r.risk when 'blocking' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
              r.rule_key;
end; $$;
revoke all on function public.fn_legal_gaps() from public;
grant execute on function public.fn_legal_gaps() to authenticated;

-- ============================================================================
-- SEED — the instruments that apply. UNVERIFIED BY CONSTRUCTION (see header).
-- Fill url + retrieved_at + verified_by from the official text, then move
-- verification to 'self_verified', and only counsel moves it to
-- 'counsel_verified'.
-- ============================================================================

insert into public.legal_source (jurisdiction, regulator, instrument_type, citation, short_name, notes) values
  ('CA-AB', 'Service Alberta / AMVIC', 'statute',    'Consumer Protection Act, RSA 2000, c C-26.3', 'Alberta CPA',
     'Renamed from the Fair Trading Act. Unfair-practice provisions are the backbone of the Alberta posture.'),
  ('CA-AB', 'AMVIC',                   'regulation', 'Automotive Business Regulation, Alta Reg 192/1999', 'ABR',
     'Business-licensing + advertising rules for automotive businesses, including the all-in advertised price requirement. Also the instrument behind the broker-registration question.'),
  ('CA-AB', 'AMVIC',                   'guidance',   'AMVIC advertising and business-practice guidance (Alberta)', 'AMVIC guidance',
     'Regulator guidance, not law, but it is what an AMVIC complaint is measured against in practice.'),
  ('CA-AB', 'OIPC Alberta',            'statute',    'Personal Information Protection Act, SA 2003, c P-6.5', 'Alberta PIPA',
     'Private-sector privacy law in Alberta. Governs anything we store about a buyer.'),
  ('CA',    'OPC',                     'statute',    'Personal Information Protection and Electronic Documents Act, SC 2000, c 5', 'PIPEDA',
     'Federal privacy law. Applies to interprovincial/commercial activity. A VIN tied to a person is personal information.'),
  ('CA',    'Competition Bureau',      'statute',    'Competition Act, RSC 1985, c C-34', 'Competition Act',
     'Misleading-representations provisions, including the drip-pricing rules. Governs how WE advertise, not only dealers.'),
  ('CA',    'CRTC',                    'statute',    'An Act to promote the efficiency and adaptability of the Canadian economy by regulating certain activities that discourage reliance on electronic means of carrying out commercial activities (CASL), SC 2010, c 23', 'CASL',
     'Consent, identification and unsubscribe for commercial electronic messages. Binds MSRP Alerts and the Consent Bridge.'),
  ('CA-AB', 'Courts of Alberta',       'statute',    'Defamation Act, RSA 2000, c D-7', 'Alberta Defamation Act',
     'A report that names a dealer''s conduct has to survive this. Canada has no s.230 equivalent.'),
  ('CA',    'Courts',                  'statute',    'Copyright Act, RSC 1985, c C-42', 'Copyright Act',
     'Relevant to reading and reproducing listing content.'),
  ('CA-BC', 'Courts',                  'case',       'Century 21 Canada Ltd Partnership v Rogers Communications Inc, 2011 BCSC 1196', 'Century 21',
     'The Canadian authority on website terms of use and automated access. Directly on point for the URL-scan posture.'),
  ('CA-ON', 'OMVIC',                   'statute',    'Motor Vehicle Dealers Act, 2002, SO 2002, c 30, Sch B', 'MVDA',
     'Expansion locale. Not yet in scope — seeded so the register is jurisdiction-complete.'),
  ('CA-BC', 'VSA BC',                  'statute',    'Business Practices and Consumer Protection Act, SBC 2004, c 2', 'BPCPA',
     'Expansion locale. Not yet in scope.'),
  ('CA-QC', 'OPC Québec',              'statute',    'Consumer Protection Act, CQLR c P-40.1', 'Quebec CPA',
     'Expansion locale. All-in pricing province. Not yet in scope.')
on conflict (citation) do nothing;

-- ---- rules — DRAFT, our plain-language reading, excerpt deliberately NULL ----
-- Each one is the QUESTION counsel needs to close, phrased as the obligation we
-- believe applies. Fill locator + excerpt from the source before review.
insert into public.legal_rule (source_id, rule_key, plain_summary, obligation, risk, applies_to, status, notes)
select s.id, v.rule_key, v.plain_summary, v.obligation, v.risk, v.applies_to, 'draft', v.notes
  from (values
    ('Automotive Business Regulation, Alta Reg 192/1999', 'ab-all-in-advertised-price',
     'In Alberta an advertised vehicle price must be the all-in price: every fee and charge the dealer requires is included, with only GST, and licensing/registration and insurance, added after. LotCheck must label a scanned asking price accordingly and must not compare an all-in advertised price against a pre-freight catalogue MSRP without saying so.',
     'must', 'high', array['pricing_display','report_copy'],
     'Basis-aware MSRP comparison is the known open gap here.'),

    ('Automotive Business Regulation, Alta Reg 192/1999', 'ab-amvic-business-registration',
     'An automotive business operating in Alberta must hold the correct AMVIC licence class for what it actually does. AMVIC has told us LotCheck may need to register; until the class is confirmed, no copy may characterise our regulatory status either way.',
     'must', 'blocking', array['marketing_copy','identity'],
     'Ties to the paused "not a broker" copy. Nothing ships describing our status until this closes.'),

    ('Consumer Protection Act, RSA 2000, c C-26.3', 'ab-no-unfair-practice-in-our-own-claims',
     'The unfair-practice provisions bind LotCheck''s own representations to consumers, not just dealers''. Every claim we make about what a report verifies must be literally true of what the product actually does.',
     'must', 'high', array['marketing_copy','report_copy'],
     'This is the legal backing for claims-must-stay-backed.'),

    ('Competition Act, RSC 1985, c C-34', 'ca-no-misleading-representations',
     'Materially false or misleading representations to promote a product are prohibited, including the general impression they create, not only their literal wording. Applies to our marketing and to the framing of report findings.',
     'must_not', 'high', array['marketing_copy','report_copy'],
     'The "general impression" test is why a technically-true claim can still fail.'),

    ('Competition Act, RSC 1985, c C-34', 'ca-drip-pricing',
     'Advertising a price that is not attainable because of mandatory add-on charges is a misleading representation. Relevant both to what we flag on a dealer listing and to how we price credit packs.',
     'must_not', 'medium', array['pricing_display','marketing_copy'],
     'Our own credit-pack pricing is in scope, not only the dealer''s.'),

    ('Personal Information Protection Act, SA 2003, c P-6.5', 'ab-pipa-consent-and-purpose',
     'Personal information may only be collected, used or disclosed with consent and for a purpose a reasonable person would consider appropriate. A VIN linked to an identifiable person is personal information.',
     'must', 'high', array['data_storage','identity'],
     'Governs the quote-data flywheel and anything the Consent Bridge shares.'),

    ('Personal Information Protection and Electronic Documents Act, SC 2000, c 5', 'ca-pipeda-deidentification',
     'Anonymised and de-identified are not the same standard, and data that can be re-identified is still personal information. Any "we store nothing" or "de-identified" statement must remain literally true of the running system.',
     'must', 'high', array['data_storage','marketing_copy'],
     'The k-anonymity gate on fee observations is the current control.'),

    ('An Act to promote the efficiency and adaptability of the Canadian economy by regulating certain activities that discourage reliance on electronic means of carrying out commercial activities (CASL), SC 2010, c 23', 'ca-casl-consent-and-unsubscribe',
     'A commercial electronic message needs consent, clear sender identification, and a working unsubscribe. Consent for one purpose is not consent for another — an alert signup is not consent to be contacted by a dealer.',
     'must', 'high', array['email','dealer_outreach'],
     'The separate consent gate on MSRP Alerts to Consent Bridge exists for this.'),

    ('Defamation Act, RSA 2000, c D-7', 'ab-defamation-safe-findings',
     'A statement that lowers a named business''s reputation is actionable unless it is true, fair comment on fact, or otherwise protected. Report findings about a named dealer must be factual, sourced, and never state an accusation the evidence does not support.',
     'must', 'high', array['report_copy','reviews'],
     'This is the legal backing for the accusation gate in _shared/invariants.ts.'),

    ('Century 21 Canada Ltd Partnership v Rogers Communications Inc, 2011 BCSC 1196', 'ca-website-terms-automated-access',
     'Website terms of use can bind an automated visitor where notice is adequate, and unauthorised automated copying of site content can found a claim. Our URL-scan posture depends on which sites we read and how.',
     'must', 'blocking', array['scan_source'],
     'Marketplace hosts are currently blocked client- and server-side; dealer-own sites are read. Risk accepted pending counsel.'),

    ('Copyright Act, RSC 1985, c C-42', 'ca-listing-content-reproduction',
     'Reproducing a listing''s original expression can engage copyright. Facts and figures are not protected; the page''s wording may be. Verbatim capture must stay short, attributed, and used as evidence rather than republished.',
     'must', 'medium', array['scan_source','report_copy'],
     'Relevant to the verbatim pricing fine-print capture.')
  ) as v(citation, rule_key, plain_summary, obligation, risk, applies_to, notes)
  join public.legal_source s on s.citation = v.citation
on conflict (rule_key) do nothing;

-- ---- controls — what already exists, so the gap report is honest ------------
insert into public.legal_control (rule_id, control_key, description, implementation, status)
select r.id, v.control_key, v.description, v.implementation, v.status
  from (values
    ('ab-defamation-safe-findings', 'accusation-gate',
     'Price-gating is named only when the rendered page was inspected and confirmed price-less; unconfirmed downgrades to "not shown".',
     'supabase/functions/_shared/invariants.ts#PRICE_NOT_ACCUSED_UNCONFIRMED', 'implemented'),
    ('ab-defamation-safe-findings', 'price-claim-consistency',
     'A captured asking price and a "contact for price" claim can never both appear on one report.',
     'supabase/functions/_shared/invariants.ts#PRICE_DISCLOSURE_MATCHES_PRICE', 'implemented'),
    ('ab-all-in-advertised-price', 'all-in-label',
     'Reports label the asking price all-in in all-in provinces and state the no-extra-fees safeguard.',
     'supabase/functions/_shared/docfee.ts#resolveAllInAuthority', 'partial'),
    ('ab-all-in-advertised-price', 'msrp-basis-label',
     'A catalogue "starting at" floor is never displayed as the exact trim MSRP.',
     'supabase/functions/_shared/invariants.ts#CATALOG_MSRP_BASIS_LABELLED', 'partial'),
    ('ca-pipeda-deidentification', 'fee-observation-k-anonymity',
     'Fee benchmarks return no figure below the k-anonymity threshold, and capture ships disabled by default.',
     'supabase/migrations/20260806_flywheel_capture.sql#fn_fee_benchmark', 'implemented'),
    ('ca-website-terms-automated-access', 'marketplace-block',
     'Marketplace hosts are refused client-side and rejected server-side; only dealers'' own sites are read.',
     'supabase/functions/analyze-listing-url/index.ts#aggregatorHost', 'implemented')
  ) as v(rule_key, control_key, description, implementation, status)
  join public.legal_rule r on r.rule_key = v.rule_key
on conflict (control_key) do nothing;

-- ---- open questions — what is genuinely blocked -----------------------------
insert into public.legal_question (question, context, jurisdiction, blocks, counsel, status) values
  ('Which AMVIC licence class, if any, must LotCheck hold?',
   'AMVIC has advised that LotCheck may need to register as a broker. All copy describing our regulatory status is paused until the class is confirmed.',
   'CA-AB', array['marketing_copy','identity'], null, 'open'),
  ('Does reading a dealer''s own public listing page on a buyer''s instruction create ToS or copyright exposure, and does the marketplace block adequately contain it?',
   'Hybrid posture is live in production: dealer-own sites are read, marketplaces are blocked. Century 21 is the closest Canadian authority.',
   'CA', array['scan_source'], 'John Sanche (BD&P)', 'with_counsel'),
  ('Can de-identified dealer fee observations be stored and benchmarked under PIPA/PIPEDA, and does that change the "nothing stored" copy?',
   'Capture ships disabled. Enabling it requires written sign-off plus reworded copy, because "analyzed once, nothing stored" must stay literally true.',
   'CA-AB', array['data_storage','marketing_copy'], null, 'open'),
  ('Is the reviews conduit posture (snippet plus link, no editing) sufficient given Canada has no s.230 equivalent?',
   'Current position is conduit for third-party reviews, accuracy shield for indexes we author ourselves, and suppress-on-notice.',
   'CA', array['reviews'], null, 'open'),
  ('What is the defensible scope of the days-on-lot first-seen sweep?',
   'Own daily first-seen tracker over sitemaps and platform feeds. Claims are stated as honest "listed at least N days" floors.',
   'CA-AB', array['scan_source','report_copy'], null, 'open')
on conflict do nothing;
