# Golden set — the correctness instrument

The benchmark (`scripts/benchmark-reports.mjs`) measures COVERAGE — its own
header says a present-but-wrong figure counts as present. This directory is
the CORRECTNESS instrument: answer keys read independently off each dealer's
own page, adversarially verified, and a grader that scores pipeline output
against them. All three shipped false accusations were caught by a human;
this is the machine that catches the next one.

## Files

- `url-pool.json` — listing URLs (6 Alberta dealers, 4 platform shapes:
  D2C/DealerOn, EDealer-family, inventory-VIN, Convertus).
- `answer-keys.json` — one key per listing: per-field `{value, source,
  confidence, evidence}`. Only `structured` / `cross` / `agent` confidence is
  ever graded; `text` is not gradable until verification promotes it.
  `meta.verifiedAt` + `meta.verification` record the adversarial pass.
- `verification-report.json` — raw agent verdicts the merge applied.

## The cycle (order matters)

1. `node scripts/harvest-listing-urls.mjs` → refresh the pool (optional).
2. `npm run golden:build` — rebuild keys. REFUSES to overwrite a verified
   key file without `--force`: rebuilding discards verification.
3. Adversarial verify: independent agents re-fetch every page and try to
   refute each key value → write `verification-report.json` →
   `node scripts/apply-golden-verification.mjs`.
4. Run the benchmark THE SAME DAY (it spends Scrapfly/LLM money — cost first),
   then `npm run golden:grade`. The grader warns when scan and keys are more
   than 24h apart: dealers move prices, and drift graded as defect is noise.

`npm run test:golden` (CI, offline) locks the grading semantics and
schema-validates the committed keys.

## Grading semantics (scripts/lib/golden.mjs)

correct / correct_absent / wrong / false_accusation / missed / not_gradable.
A false accusation (e.g. claiming price-gating on a page that advertises its
price) fails the whole report. `missed` is honest, not a pass. `not_gradable`
is never a pass. Identity is powertrain-strict: a hybrid never matches its
gas sibling. Dealer-stated MSRP is graded against the page; `basis=exact`
MSRP correctness belongs to the catalog value audit, not this key.
