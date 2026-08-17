# Fixing history

A running log of what broke, why, and the guard that now stops the **class** of
it recurring. Newest first.

The point of this file is not the list. It is the **class** column: nearly every
entry below is one of four recurring shapes, and naming the shape is what stops
the next instance.

| shape | what it looks like |
|---|---|
| **Green signal, no check** | a step reports success without verifying it did the thing |
| **Absence read as knowledge** | "we didn't look" rendered as "there is none" |
| **One-surface fix** | a shared bug fixed in one consumer, left in the others |
| **Optional step, fatal failure** | something non-essential takes down the whole request |

---

## 2026-08-17

| fix | what broke | class | guard now in place |
|---|---|---|---|
| `d48aaca` | RAV4 Woodland reported `$47,000 · starting at` when the catalog holds its exact price. **Not a matching bug** — the null drivetrain was deliberate (no Build & Price summary states AWD/FWD, so the seed refused to guess) and `rowConfirmsConfig` was right to refuse `exact`. The real cause: NRCan pinned `rav4 hybrid → AWD` but not plain `rav4`, and the report resolved to the un-pinned key. Second cost of the same alias pair, after the $6,299 floor | one-surface fix | enrichment propagates symmetrically across the alias pair — NULLs only, idempotent, in whichever direction the knowledge arrived |
| `3fec6a1` | Changed `analyze-quote` (analysis output) without bumping `CACHE_VER` — every cached report would replay old figures while the report id stayed the same, reading exactly like a failed deploy | green signal, no check | `check:cache-ver` caught it **on CI**, not locally; the gate diffs against the merge base |

## 2026-08-16

| fix | what broke | class | guard now in place |
|---|---|---|---|
| `1861202` | `analyze-quote` dropped `term_months` from the manufacturer rate and never computed reference financing — the identical line already fixed in `analyze-listing-url` | one-surface fix | — *(see Open, below)* |
| `5f4259d` | A refused MSRP write threw and skipped the finance + lease writes. 123 finance and 120 lease rows were ready and discarded because an unrelated table failed its guard | optional step, fatal failure | each table written independently; failures collect and rethrow together |
| `d638e91` | `ERR::ASP::SHIELD_PROTECTION_FAILED` treated as terminal. A blocked attempt costs **0 credits** and the exit geography varies per attempt, so giving up after one was free to avoid | green signal, no check | shield failures re-roll up to 3× within budget; 422 deliberately excluded |
| `2dc0c1f` | An optional manufacturer-MSRP lookup threw an `AbortError` and killed a scan that already had price, VIN, trim and recalls. Separately, a 422 on the fullpage screenshot returned null and never tried the viewport | optional step, fatal failure | `enrichAnalysis` guarded at the boundary (covers all six call sites and any future enricher); screenshot degrades on *any* failure |
| `9b9ba75` | `RAV4` (7 rows, floor $41,361) and `RAV4 Hybrid` (4 rows, floor $47,660) — same car, two keys, a point-in-time `INSERT…SELECT` that nothing re-ran. The report's floor depended on which name the lookup hit | green signal, no check | resync is total and idempotent: adds missing **and** deletes orphans |
| `c0eaeae` | Days-on-lot vanished from Sidebar, Scroll and Heatmap when the platform published no date. The **email had already been fixed** for exactly this | one-surface fix | always renders "Not published — ask the dealer"; heatmap no longer labels it "0 days" |
| `08ec24c` | One panel told three stories: "from $47,660", "$52,000 when new", "STARTS at $52,000 for the base version" — the last false twice over | absence read as knowledge | explanation defers to `qualifyMsrpClaim().refusal`, the same source the email already used; range scoped to trims we actually hold |
| `9255f62` | The counter-script told an Alberta buyer to cite "the FTC CARS Rule in the US" | — | `check:copy` extended to server-side copy; new rule blocks foreign-regulator citations |
| `a790eb4` | Dealer reputation said "NOT CHECKED" for a dealer with 3,369 Google reviews — the lookup was a browser-side progressive enhancement the report raced | absence read as knowledge | resolved server-side before any surface is built; city recovered from the hostname |
| `0f95d97` | Financing math printed "NO TERMS QUOTED" while both halves sat in our own tables. `resolveFinanceRates` selected a row carrying `term_months` and returned it without | green signal, no check | term carried; `computeReferenceFinancing` amortizes both prices at the same published rate |
| `d7b475b` | The Scrapfly render asked for `render_js` + `auto_scroll` + a **fullpage** screenshot in one call. A timeout lost the HTML — the part that actually rescues a page | optional step, fatal failure | viewport shot (bounded by construction) then an HTML-only retry |
| `d6610d6` | Vision rescue posted whatever screenshot the render produced and took an HTTP 400. A 17,729px capture is past the API ceiling *by construction* | green signal, no check | `visionImageVerdict()` decides before the request; the 400 body is logged |
| `ba36a38` | Two migrations inserted into tables created by later-sorting files — the history could not rebuild from empty | green signal, no check | renamed so filename order matches dependency order; allowlist deleted rather than grown |

## 2026-08-15

| fix | what broke | class | guard now in place |
|---|---|---|---|
| `71848f3` | Three false claims in one shipped report: "no public reviews" about a dealer with 5,930; a rebate contradiction the prompt itself caused; "$11,173 over MSRP" when the true gap was $8,095 | absence read as knowledge | `point-state.ts` three states; `settled-claims.ts` strips post-generation; jurisdiction resolved from every signal, refusing when unknown |
| `aa6183a` | Five seeded models were unreachable by the lookup, and **"Crown Signia Limited" resolved to "Crown"** — a different car that also has a "Limited" | green signal, no check | `test:reachable` — every seeded model must resolve to itself or to null |
| `d3dcc43` | Two rate seeds had been failing with 42703 since the morning; the APR half of the product had no data behind it | green signal, no check | `check:migrations` replays schema in filename order, catching 42703 **and** 42P01 |
| `2b51a2d` | Superseding a hand-verified row blanked the enrichment it carried, and the row sat outside the restore set — so a failed insert reported "restored all N" while it was gone | green signal, no check | `test:supersede` runs `replaceRows` end-to-end; its stub honours the query filter |
| `d05ca03` | A premium colour hid inside the MSRP line with no package line to flag it — the third nameplate in a row | one-surface fix | `bp-summary.mjs` refuses on **both** routes (package suffix *and* exterior) plus reconciliation |
| `a959d24` | #161 had sat conflicting for three days; "Accept current change" would have reverted the collapse guard | — | union merge: both fresh-write detectors, dedup moved ahead of the collapse check |

---

## Open

- **Toyota scraper reads a calculated price.** 68 of 75 rows come back fractional
  and the quality gate rightly rejects them, so the daily refresh refuses and
  Toyota goes stale. **The gate is correct; the field is wrong.** The fix is to
  source Toyota MSRP from Build & Price, where the figure is a whole-dollar
  published number that reconciles to the printed subtotal.
- **`country=ca` is not taking effect at Scrapfly.** Re-rolling makes it
  survivable, not deterministic.
- **`check:parity` checks report *surfaces*, not shared *helpers*.** It did not
  catch the dropped-term bug living in two functions. Extending it would close
  the one-surface class properly.
- **RAV4 and RAV4 Hybrid are still two keys for one car.** The resync converges
  their rows and `20260817` keeps their enrichment in step, but neither removes
  the duplication. The pair has now cost two distinct defects — a $6,299 wrong
  floor and an unearned `starting_at`. The permanent fix is to resolve both
  names to ONE row set in the matcher; it interacts with the powertrain guard,
  so it is a design call, not a patch.

---

## How to add an entry

Only add a fix once its guard exists. A row here without something in the
`guard` column is a note, not a fix — see the memory `fix-means-structural-fix`.
