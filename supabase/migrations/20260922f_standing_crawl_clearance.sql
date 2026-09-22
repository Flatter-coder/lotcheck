-- What cleared the standing Alberta crawl, and the limits it came with.
--
-- crawl-inventory.yml says, in its own header: "To enable after sign-off:
-- uncomment the schedule block, and add the legal_rule + legal_control rows
-- recording what cleared it." This is that record, written before the cron.
--
-- WHAT THIS IS, STATED PLAINLY. The clearance is a VERBAL one, relayed by Vic
-- on 2026-09-22 after speaking with counsel. There is no written opinion to
-- quote, so the excerpt below is VIC'S OWN WORDS VERBATIM and is labelled as
-- such — not counsel's, not a document. The register requires the excerpt to
-- be verbatim source text and never a summary, and inventing a quotation from
-- a lawyer to fill that field would be worse than the gap it hides.
--
-- The source is therefore recorded as verification='unverified' with no
-- verified_by. When a written scope arrives it supersedes this row and the
-- excerpt is replaced with what the document actually says.
--
-- THE CONDITION IS ENFORCED IN CODE, NOT IN THIS TABLE. A permission whose
-- limits live only in a register nobody reads at runtime is a permission with
-- no limits. scripts/lib/crawl-blocklist.mjs refuses Facebook, AutoTrader,
-- Kijiji and CarGurus (and their subdomains, and other aggregators) before a
-- single request is made, the run prints what it dropped, and
-- scripts/test-crawl-blocklist.mjs fails the build if the crawler stops
-- consulting it.

insert into public.legal_source
  (jurisdiction, regulator, instrument_type, citation, short_name, url,
   retrieved_at, verification, notes)
values (
  'CA-AB', null, 'guidance',
  'Counsel review of the LotCheck business model — standing Alberta inventory crawl (verbal, relayed 2026-09-22)',
  'Crawl clearance (verbal)',
  null,
  '2026-09-22',
  'unverified',
  'VERBAL. Relayed by Vic Todorovic on 2026-09-22 following a conversation with counsel engaged on the business-model review. No written opinion has been provided, so nothing here is quoted from counsel. Replace this row when a written scope arrives.'
)
on conflict (citation) do nothing;

insert into public.legal_rule
  (source_id, rule_key, locator, excerpt, plain_summary, obligation, risk,
   applies_to, status, approved_by, approved_at, effective_from)
select s.id,
  'crawl_scope_dealer_sites_only',
  null,
  -- VERBATIM, and it is VIC'S sentence, not counsel's. Recorded exactly as
  -- written so that what authorised this is checkable against what was said.
  'Vic Todorovic, 2026-09-22: "just spoke with John we can track all vehicle''s cross Alberta" and, on scope: "yes run the dry run no FB,Autotrader,Kijiji,Car Gurs".',
  'A standing daily crawl of Alberta DEALER websites is cleared. Marketplaces and aggregators are not: Facebook, AutoTrader, Kijiji and CarGurus are excluded by name, and other aggregators are treated the same way. This is our reading of a verbal clearance, not counsel''s written words.',
  'may',
  'high',
  array['scan_source','data_storage'],
  'draft',
  'Vic Todorovic',
  '2026-09-22',
  '2026-09-22'
from public.legal_source s
where s.citation = 'Counsel review of the LotCheck business model — standing Alberta inventory crawl (verbal, relayed 2026-09-22)'
on conflict (rule_key) do nothing;

-- The safeguards that make the permission checkable at runtime.
insert into public.legal_control
  (rule_id, control_key, description, implementation, evidence_url, status,
   last_verified_at, verified_by, owner)
select r.id, v.control_key, v.description, v.implementation, v.evidence_url,
       v.status, v.last_verified_at, v.verified_by, v.owner
from public.legal_rule r
cross join (values
  ('crawl_marketplace_blocklist',
   'Facebook, AutoTrader, Kijiji, CarGurus and other aggregators are refused before any request is made, including their subdomains; a host we cannot parse is refused rather than allowed.',
   'scripts/lib/crawl-blocklist.mjs#isCrawlAllowed, called from scripts/crawl-alberta-inventory.mjs before the per-run bound',
   'scripts/test-crawl-blocklist.mjs — 60 assertions, and it fails the build if the crawler stops calling it',
   'implemented', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic'),
  ('crawl_reports_exclusions',
   'Every run prints the hosts it excluded as out of scope. A silent exclusion is indistinguishable from a missing adapter.',
   'scripts/crawl-alberta-inventory.mjs — "OUT OF SCOPE for this crawl and skipped"',
   null, 'implemented', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic'),
  ('crawl_honours_robots',
   'robots.txt is read before each dealer: a Disallow on a path we would fetch skips that section and marks the crawl partial so nothing is delisted, a Crawl-delay raises the between-page delay, and an unreadable robots.txt skips the dealer for the day.',
   'scripts/lib/robots.mjs, called from scripts/crawl-alberta-inventory.mjs',
   'PR #315', 'implemented', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic'),
  ('crawl_identifies_itself',
   'The crawler sends an honest User-Agent naming LotCheck and where to complain. It never presents itself as a browser or a person, so a dealer who chooses to block it can, and that refusal reaches us as a signal.',
   'scripts/crawl-alberta-inventory.mjs#UA — "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)"',
   null, 'implemented', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic'),
  ('crawl_no_personal_data',
   'Per unit the crawl takes the VIN, the dealer''s own inventory dates, prices and condition facts. Nothing about a person: no buyer, no owner, no contact details.',
   'scripts/crawl-alberta-inventory.mjs#normalizeSm360 and the vehicle_listing migration header',
   null, 'implemented', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic'),
  ('crawl_written_scope_outstanding',
   'The clearance is verbal. A written scope from counsel has not been provided, so the rule above is status=draft and its excerpt quotes Vic rather than a document.',
   null, null, 'planned', date '2026-09-22', 'Claude Opus 5', 'Vic Todorovic')
) as v(control_key, description, implementation, evidence_url, status, last_verified_at, verified_by, owner)
where r.rule_key = 'crawl_scope_dealer_sites_only'
on conflict (control_key) do nothing;

-- POST-CONDITIONS. Re-runnable, and checked by scripts/apply-migrations.mjs after
-- the statements above have run. Every insert here is `on conflict do nothing`,
-- which prints the same green tick whether it wrote a row or skipped one — so
-- without these, "applied" would mean only "parsed".
-- @assert: (select count(*) from public.legal_source where citation like 'Counsel review of the LotCheck business model%') = 1
-- @assert: (select count(*) from public.legal_rule where rule_key = 'crawl_scope_dealer_sites_only') = 1
-- @assert: (select status from public.legal_rule where rule_key = 'crawl_scope_dealer_sites_only') = 'draft'
-- @assert: (select excerpt like '%Vic Todorovic%' from public.legal_rule where rule_key = 'crawl_scope_dealer_sites_only')
-- @assert: (select verification from public.legal_source where short_name = 'Crawl clearance (verbal)') = 'unverified'
-- @assert: (select count(*) from public.legal_control c join public.legal_rule r on r.id = c.rule_id where r.rule_key = 'crawl_scope_dealer_sites_only') = 6
-- @assert: (select count(*) from public.legal_control c join public.legal_rule r on r.id = c.rule_id where r.rule_key = 'crawl_scope_dealer_sites_only' and c.status = 'implemented') = 5
-- @assert: (select count(*) from public.legal_control where control_key = 'crawl_written_scope_outstanding' and status = 'planned') = 1
