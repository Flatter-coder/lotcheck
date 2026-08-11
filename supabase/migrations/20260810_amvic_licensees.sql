-- AMVIC licensee snapshot (check #11 — "Dealer licence · AMVIC verified").
--
-- Source: AMVIC's public Online Search Portal (Thentia Cloud), the registry the
-- regulator publishes so consumers can verify a business before they buy. We
-- snapshot it weekly instead of querying per scan: no load on their portal
-- during a buyer's report, and the report stays fast.
--
-- Why it matters: in a 1,500-record sample of the "calgary" search, only ~54%
-- of listings were "Issued" (valid). ~46% were Expired / Closed / Cancelled /
-- Suspended — and 65 expired businesses still published a live website. A buyer
-- looking at an operating dealer site has no way to know the licence lapsed.
--
-- Defamation-safe by construction (see memory: defamation-proof-and-compliant):
-- we store the regulator's own status string verbatim and never editorialize.
-- A non-match must render as "couldn't confirm — verify at AMVIC", NEVER as
-- "unlicensed" (make-recalls-fail-safe: a miss is never an all-clear, and it is
-- never an accusation either).

create table if not exists amvic_licensees (
  id                  text primary key,          -- AMVIC/Thentia record id
  name                text,                      -- legal name (NULL in some records -- trade name only)
  trade_name          text,                      -- "N/A" is common in the source
  registration_number text,                      -- e.g. B2035585 — exact-match key when available
  facility_status     text,                      -- VERBATIM: "Issued" | "Expired - Required to Reapply" | ...
  facility_type       text,
  initial_date        text,
  effective_date      text,
  expiry_date         text,
  street1             text,
  city                text,
  province            text,
  postal_code         text,
  telephone           text,
  website             text,
  activities          jsonb,                     -- licenced business activities
  -- normalized match keys (generated so the matcher can index them)
  name_key            text,
  trade_key           text,
  city_key            text,
  synced_at           timestamptz not null default now()
);

-- Some registry records carry only a trade name; an older revision of this
-- table declared name NOT NULL and rejected them mid-load.
alter table amvic_licensees alter column name drop not null;

create index if not exists amvic_name_key_idx  on amvic_licensees (name_key);
create index if not exists amvic_trade_key_idx on amvic_licensees (trade_key);
create index if not exists amvic_city_key_idx  on amvic_licensees (city_key);
create index if not exists amvic_regnum_idx    on amvic_licensees (registration_number);

-- Read-only to the anon role: this is public regulator data, and the report
-- needs to read it. Writes happen only from the weekly job (service role).
alter table amvic_licensees enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'amvic_licensees' and policyname = 'amvic_public_read') then
    create policy amvic_public_read on amvic_licensees for select using (true);
  end if;
end $$;
