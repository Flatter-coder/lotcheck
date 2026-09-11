-- ============================================================================
-- PERMISSION IS DATA, AND IT HAS A DATE ON IT.
--
-- Vic, 2026-09-11: "make list of dealers we can ran without v[i]siting there
-- terms of service, which btw needs to be track daily as well".
--
-- Before this, the only robots.txt data in the repo was two dealer names in a
-- code comment. The crawler read each dealer's robots.txt at crawl time, obeyed
-- it, and then threw it away — so we could obey a rule but never PROVE which
-- rule we obeyed, and we could not answer "which dealers can we read?" without
-- crawling all of them to find out.
--
-- WHY DAILY. A permission is not a fact about the world, it is a fact about a
-- document on a given day. robots.txt gets edited. Crawling today under a rule
-- read in August is working off a stale licence, and we would not know. The
-- strongest answer to a complaint is "we read your robots.txt at 06:04 on the
-- day we crawled, here is what it said, here is its hash". "We checked at some
-- point" is not an answer.
--
-- THE SHAPE, borrowed from listing history because the problem is identical:
--   * dealer_permission        -- current state, one row per host
--   * dealer_permission_check  -- the heartbeat: we looked on this day
--   * dealer_permission_history-- a row ONLY when the rule actually changed,
--                                 carrying what it changed FROM
--
-- A dealer who disallows is a permanent and CORRECT hole in coverage. This
-- table exists to record that hole honestly, not to find a way around it.
--
-- TERMS OF SERVICE ARE NOT JUDGED HERE. tos_url and tos_hash exist so a CHANGE
-- is detectable and a human can go read it. Nothing in this schema decides
-- whether a clause binds us; a machine that did would be the most dangerous
-- thing in this repo. [[always-check-legally-clear]]
-- ============================================================================

-- ---- 1) current state -------------------------------------------------------
create table if not exists public.dealer_permission (
  host              text primary key,
  verdict           text not null check (verdict in ('allowed','partial','disallowed','unknown')),
  robots_status     text,
  crawl_delay_s     numeric,
  allowed_paths     text[] not null default '{}',
  disallowed_paths  text[] not null default '{}',
  robots_hash       text,
  robots_bytes      integer,
  tos_url           text,
  tos_hash          text,
  note              text,
  first_checked_at  timestamptz not null default now(),
  last_checked_at   timestamptz not null default now(),
  checks            integer not null default 1
);
alter table public.dealer_permission enable row level security;
create index if not exists ix_dealer_permission_verdict on public.dealer_permission(verdict);

comment on table public.dealer_permission is
  'What each Alberta dealer host permits, as of last_checked_at. verdict=unknown means we could NOT confirm permission, and the crawler must treat that as no.';

-- ---- 2) the heartbeat: one row per host per day we looked -------------------
create table if not exists public.dealer_permission_check (
  host        text not null,
  checked_on  date not null default current_date,
  checked_at  timestamptz not null default now(),
  verdict     text not null,
  robots_hash text,
  primary key (host, checked_on)
);
alter table public.dealer_permission_check enable row level security;
create index if not exists ix_permission_check_day on public.dealer_permission_check(checked_on desc);

comment on table public.dealer_permission_check is
  'Proof we looked, per host per day. "We obeyed the rule" is only defensible alongside "and here is the day we read it".';

-- ---- 3) the change trail ----------------------------------------------------
create table if not exists public.dealer_permission_history (
  id          bigint generated always as identity primary key,
  host        text not null,
  changed_at  timestamptz not null default now(),
  field       text not null,
  old_value   text,
  new_value   text
);
alter table public.dealer_permission_history enable row level security;
create index if not exists ix_permission_hist_host on public.dealer_permission_history(host, changed_at desc);

comment on table public.dealer_permission_history is
  'A row only when a dealer actually changed their rules, carrying the old value AND the new. A tightened rule means stop crawling that dealer TODAY; a relaxed one is not a licence to silently resume.';

-- ---- 4) record one survey ---------------------------------------------------
-- Takes the survey rows whole. Same jsonb-diff approach as listing history: a
-- hand-written field list stops covering a column the day someone adds one.
create or replace function public.fn_record_dealer_permission(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_old public.dealer_permission%rowtype; f text;
  n_seen int := 0; n_new int := 0; n_changed int := 0;
  v_at timestamptz := now();
  k_tracked constant text[] := array['verdict','crawl_delay_s','robots_hash','tos_url','tos_hash','robots_status'];
  v_oldj jsonb; v_newj jsonb;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into v_old from dealer_permission where host = r->>'host';

    insert into dealer_permission as d (
      host, verdict, robots_status, crawl_delay_s, allowed_paths, disallowed_paths,
      robots_hash, robots_bytes, tos_url, tos_hash, note, last_checked_at
    ) values (
      r->>'host',
      coalesce(nullif(r->>'verdict',''), 'unknown'),
      nullif(r->>'robotsStatus',''),
      nullif(r->>'crawlDelay','')::numeric,
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(r->'allowedPaths','[]'::jsonb))), '{}'),
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(coalesce(r->'disallowedPaths','[]'::jsonb))), '{}'),
      nullif(r->>'robotsHash',''), nullif(r->>'robotsBytes','')::int,
      nullif(r->>'tosUrl',''), nullif(r->>'tosHash',''), nullif(r->>'note',''), v_at
    )
    on conflict (host) do update set
      verdict = excluded.verdict, robots_status = excluded.robots_status,
      crawl_delay_s = excluded.crawl_delay_s, allowed_paths = excluded.allowed_paths,
      disallowed_paths = excluded.disallowed_paths, robots_hash = excluded.robots_hash,
      robots_bytes = excluded.robots_bytes, tos_url = excluded.tos_url,
      tos_hash = excluded.tos_hash, note = excluded.note,
      last_checked_at = v_at, checks = d.checks + 1
    returning to_jsonb(d.*) into v_newj;

    if v_old.host is null then n_new := n_new + 1; else
      v_oldj := to_jsonb(v_old);
      foreach f in array k_tracked loop
        if (v_oldj->>f) is distinct from (v_newj->>f) then
          insert into dealer_permission_history(host, changed_at, field, old_value, new_value)
            values (r->>'host', v_at, f, v_oldj->>f, v_newj->>f);
          n_changed := n_changed + 1;
        end if;
      end loop;
    end if;

    -- The heartbeat fires every run, changed or not: "we looked today".
    insert into dealer_permission_check(host, checked_on, checked_at, verdict, robots_hash)
      values (r->>'host', v_at::date, v_at, coalesce(nullif(r->>'verdict',''),'unknown'), nullif(r->>'robotsHash',''))
      on conflict (host, checked_on) do update
        set checked_at = excluded.checked_at, verdict = excluded.verdict, robots_hash = excluded.robots_hash;

    n_seen := n_seen + 1;
  end loop;
  return jsonb_build_object('ok', true, 'seen', n_seen, 'new', n_new, 'changed', n_changed);
end; $$;
revoke all on function public.fn_record_dealer_permission(jsonb) from public;
grant execute on function public.fn_record_dealer_permission(jsonb) to service_role;

-- ---- 5) the list ------------------------------------------------------------
-- Anon-readable on purpose: "who may we read, and when did we last ask" should
-- not require the service key to answer. It exposes hosts and their published
-- rules — a dealer's own robots.txt, which is public by definition — and no
-- listing, price or buyer data.
create or replace function public.fn_dealer_permission_list(p_verdict text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'asOf', to_char(max(last_checked_at), 'YYYY-MM-DD"T"HH24:MI:SSZ'),
    'counts', (select jsonb_object_agg(verdict, n) from (
                 select verdict, count(*) as n from dealer_permission group by verdict) t),
    'staleCount', (select count(*) from dealer_permission where last_checked_at < now() - interval '48 hours'),
    'dealers', coalesce(jsonb_agg(jsonb_build_object(
        'host', host, 'verdict', verdict, 'crawlDelaySeconds', crawl_delay_s,
        'disallowedPaths', disallowed_paths, 'tosUrl', tos_url, 'note', note,
        'lastCheckedAt', to_char(last_checked_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
        'checks', checks
      ) order by verdict, host) filter (where p_verdict is null or verdict = p_verdict), '[]'::jsonb)
  ) from dealer_permission;
$$;
revoke all on function public.fn_dealer_permission_list(text) from public;
grant execute on function public.fn_dealer_permission_list(text) to anon, authenticated;

comment on function public.fn_dealer_permission_list(text) is
  'Which Alberta dealers permit the paths we read, with the date we last asked. staleCount is the number whose permission has not been re-read in 48h — crawling those is crawling on a stale licence.';
