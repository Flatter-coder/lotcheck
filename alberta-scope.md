# `/alberta` — Per-City MSRP Index & Dealer Map · Build Scope

**Status:** scope / not started · **Owner:** Vic · **Drafted:** 2026-07-29
**Prereq design (locked):** `map-alberta.html` (Signature 36°), calm dashboard v5, merged Reviews-vs-MSRP chart.

> **Governing principle:** data accuracy and defamation exposure are the *same* risk.
> A stale or mis-matched price shown as a markup next to a named dealer is both our
> worst data failure and our worst legal failure. Every requirement below is written
> so the safeguards are **structural** — enforced by the schema and the queries —
> not copy bolted on at the end.

---

## 1. What we're building

A public `/alberta` page in the React app that shows, per Alberta city with dealerships:

- a **local MSRP index** — how advertised prices in that city sit relative to national MSRP;
- the city's dealers as a **Reviews vs MSRP** view (third-party review score × advertised-price deviation);
- **cross-city comparison** — e.g. the same truck advertised closer to MSRP in Edmonton than in Fort McMurray — framed strictly as *local advertised pricing vs a national MSRP reference*, never as advice.

Entry surface: the locked 3D `map-alberta.html`; each pin opens a city panel (one of the 25 designs, TBD pick).

**Explicit non-goals:** no "best/worst dealer" verdicts, no "you'll pay $X" claims, no predicted out-the-door quotes, no scraping behind bot walls.

---

## 2. Vocabulary we hold the line on

| Term | Means | Never rendered as |
|---|---|---|
| **Advertised price** | The price a dealer publicly posts on their listing | "the price you'll pay" |
| **MSRP** | Manufacturer's suggested retail, from official OEM source, matched at trim | a price anyone charges |
| **Deviation** | advertised − MSRP, same trim | a "markup"/"gouge" verdict |
| **City index** | Aggregate deviation across ≥ N verified listings in a city | a per-dealer accusation |
| **Review score** | The review platform's *own* posted score, attributed + linked | a LotCheck "trust" rating |

The gap between advertised price and an actual quote is **fees** (freight/PDI, doc fee, AMVIC levy, add-ons) **+ tax**. We show advertised price and say so; we never imply we've priced the out-the-door number.

---

## 3. Data model (safeguards baked into the schema)

### 3.1 `dealer_listing` (raw, per-VIN, append-only history)
Every scraped listing row **must** carry provenance or it doesn't get written:

| column | notes |
|---|---|
| `vin` | = SM360 `serialNo`; primary match key |
| `dealer_id` | FK → `dealer` |
| `year, make, model, trim` | normalized |
| `advertised_price` | as posted |
| `msrp_matched` | MSRP for the *same trim* (see §4.2); null if no confident match |
| `source_url` | **required** — the exact listing page |
| `source_method` | `sm360_feed` \| `convertus_feed` \| `edealer` \| `page` |
| `scraped_at` | **required** timestamp |
| `is_stale` | derived: `scraped_at` older than `STALE_DAYS` |
| `match_confidence` | trim-match confidence (see §4.2) |

### 3.2 `dealer` (one row per rooftop)
`name, city, lat, lng, review_source, review_score, review_count, review_url, claimed_by` (for the correction workflow), `suppressed` (bool — honor a correction/removal).

### 3.3 `city_dealer_index` (aggregate — what the map reads)
Computed, never hand-edited:
`city, n_dealers, n_listings, index_value` (median deviation %), `p25, p75` (spread), `computed_at`, `min_scraped_at` / `max_scraped_at` (freshness window), `is_publishable` (see gate §5).

> **Gate, enforced in the aggregation query, not the UI:** a city row is `is_publishable = true`
> **only if** `n_dealers ≥ MIN_DEALERS` **and** `n_listings ≥ MIN_LISTINGS` **and** the freshness
> window is within `STALE_DAYS`. Non-publishable cities render as "not enough current data,"
> never as a number.

Proposed thresholds (tune with real data): `MIN_DEALERS = 3`, `MIN_LISTINGS = 12`, `STALE_DAYS = 7`.

---

## 4. Pipeline

```
scrape (feed-first) → normalize → trim-match to msrp_catalog → write dealer_listing (+provenance)
   → aggregate city_dealer_index (with publishable gate) → React /alberta reads only publishable rows
```

### 4.1 Scrape — feed-first, bot-wall-respecting
- Reuse the existing feed scrapers: **SM360** (`/en/new-inventory/api/listing`), **Convertus/AutoSync**. Feed > page always (structured, VIN-keyed, less fragile).
- **Hard rule:** respect `robots.txt` + rate limits; **do not circumvent Cloudflare or any bot wall** (we already stopped at Convertus's wall — that discipline stays). A dealer we can't fetch cleanly is simply absent, not force-scraped.
- Every write includes `source_url`, `source_method`, `scraped_at` or it is rejected.

### 4.2 Trim-match integrity (kills false markups)
- Match `advertised_price` to MSRP **at the same trim**, keyed on VIN where the feed exposes it (`serialNo`). Base-vs-loaded mismatches manufacture fake "markups" — the exact accuracy+defamation convergence we're avoiding.
- Emit `match_confidence`; **low-confidence matches are excluded from the index** (kept in raw for audit, not shown).

### 4.3 Break detection (a silent parser is the nightmare)
- Golden-record tests per feed shape (SM360, Convertus): known dealer → expected fields.
- Alert when a feed's schema shifts or a scrape returns implausible values (e.g. price < 50% MSRP). Broken parse → **freeze** that dealer's rows, don't publish garbage.

### 4.4 Where it runs
- New Supabase edge function `build-alberta-index` (Deno/TS), reusing the SM360/Convertus libs already in `scripts/lib/`. Scheduled via a GitHub Actions workflow like the existing `catalog-rates-daily.yml`. Aggregation as a SQL view/materialized table so the gate lives in one place.

### 4.5 Reviews — passive-intermediary posture (distinct from the index)

> **Keep these two liability models separate:**
> - **Review snippets** → we are a **passive conduit**. The author + Google carry liability; we don't author or edit. Our job is to *stay* a conduit.
> - **The MSRP-deviation number** → **we author and publish it.** No intermediary defense applies. Our only shield there is *provable accuracy* (§3–4). This is why the price side is built the way it is.

Rules for how reviews are displayed:

- **Source via the official Google Places API only.** Never scrape, never edit, never re-word a review to read worse. Editing content is how you *become* the publisher.
- **Snippet + link out, don't host the rant.** Store a short attributed snippet, render **"Read full review on Google →"** linking to the source. Reinforces conduit status.
- **Google Places API ToS is binding, not optional:** required attribution, no modification of review text, caching limits. Snippet-plus-link isn't just prudent — the API terms partly *require* it. Review the current ToS before shipping.
- **Disclaimer wording (live version):** *"Review snippets are automatically sourced from Google user reviews and do not reflect the opinions or endorsements of LotCheck."* (Replaces the mockup's "illustrative sample data" line once real data is wired.)
- **We do not police reviews (chosen posture).** LotCheck is *not* the arbiter of whether a review is fair, true, or accurate — we do not moderate, curate, rank by "trust," or edit. We mirror Google's live API and re-sync, so anything Google removes drops from LotCheck automatically. Curating review *quality* would weaken the conduit defense, so we don't.
- **Notice handling — flagged for counsel.** Default response to a complaint: *"we display public Google reviews unmodified; petition Google to remove it and it disappears here on the next sync."* **Open legal question (lawyer gate):** Canada has **no Section 230**, and the "innocent dissemination" defense can be **lost once formally put on notice and still publishing**. So counsel must decide whether the pure auto-mirror is sufficient, or whether we also need a narrow **suppress-on-notice valve** (a `suppressed` flag used *only* on a credible legal notice — not a quality judgment, not policing) to preserve that defense in the interim before Google acts. Record the decision here before launch.
- **Aggregate keyword signal = macro trend, neutrally named.** If we surface a pricing-language signal (e.g. "hidden fees" mentions), it is an **aggregate "pricing-mention rate"**, not a per-dealer accusation and not a "Frustration Index." Aggregate framing is the legal shield; neutral naming (per [neutral-factual-language]) keeps it credible and non-loaded.

---

## 5. Launch gates (all must be green to publish named-dealer content)

**Accuracy**
- [ ] Every published figure carries an on-screen **"advertised · as of [date]"** label.
- [ ] Publishable gate live in the query (`MIN_DEALERS`/`MIN_LISTINGS`/`STALE_DAYS`).
- [ ] Sample size (`n = X dealers`) shown wherever a city index appears.
- [ ] VIN/trim matching in place; low-confidence rows excluded.
- [ ] Golden-record tests + break alerting wired for SM360 + Convertus.
- [ ] Spot-check: pipeline price == live dealer page for a random sample of N listings.

**Fairness / legal**
- [ ] Copy audited against the [neutral-factual-language] rule — no "overpriced/avoid/punished/rip-off," no advice imperatives, anywhere on `/alberta`.
- [ ] Review snippets: **Google Places API only**, unedited, short snippet + **"Read full review on Google →"** link; API ToS (attribution/no-modify/caching) reviewed and complied with (§4.5).
- [ ] Review scores show the **platform's own** number, attributed + linked; no LotCheck-authored "trust" verdict.
- [ ] Review disclaimer live: *"Review snippets are automatically sourced from Google user reviews and do not reflect the opinions or endorsements of LotCheck."*
- [ ] **Reviews posture: no policing** — mirror Google unmodified, auto-resync; default complaint response redirects to Google (§4.5).
- [ ] **Counsel to rule** on notice handling: pure auto-mirror vs. adding a narrow suppress-on-notice valve (no-§230 / innocent-dissemination question) — decision recorded before launch.
- [ ] **Correction / right-of-reply workflow** shipped: a dealer can claim/flag a *price* listing and request a fix. (Reviews → redirect to Google.)
- [ ] Price disclaimer present: *advertised prices as posted, subject to change, exclude taxes; LotCheck aggregates public data and is not affiliated with any dealer.*
- [ ] Any keyword signal is **aggregate ("pricing-mention rate")**, never a per-dealer accusation.
- [ ] **Canadian media/defamation lawyer sign-off** on the named-dealer comparison UI **and the notice-and-takedown policy** before public launch. (Not optional; not something I can substitute for.)
- [ ] **Verify AMVIC's all-in advertised-price rule** — if current, note it (advertised ≈ closer to real quote in AB); if not, don't lean on it.

**Scraping**
- [ ] robots.txt + rate limits respected; no bot-wall circumvention; ToS reviewed per source.

---

## 6. Phases

1. **Dealer census** — enumerate Alberta cities *with* dealerships and each rooftop (name, city, lat/lng, review source). Output: seed `dealer` table. *(Design already assumes ~33 pins — confirm the real list.)*
2. **Pipeline MVP** — `build-alberta-index` scraping 2–3 cities feed-first, full provenance, trim-matching, writing `dealer_listing` + `city_dealer_index`. No UI yet.
3. **Accuracy hardening** — golden records, break alerts, spot-check harness, stale/gate logic. *Gate must pass before any UI ships.*
4. **UI** — wire `map-alberta.html` + chosen city panel + Reviews-vs-MSRP into the React app at `/alberta`, reading **only publishable** rows; wire the "as-of"/`n=`/disclaimer chrome.
5. **Correction workflow** — dealer claim/flag/fix path + suppression.
6. **Legal review → launch** — counsel sign-off, then enable.

---

## 7. Open questions
- Authoritative source for the AB dealer census (OEM locators? AMVIC registry? Google Places?).
- Review source of record — Google, DealerRater, or both — and its ToS for display.
- Materialized table vs live view for `city_dealer_index` (refresh cadence vs read cost).
- Which of the 25 city-panel designs is the pick.
- Does `/alberta` launch province-wide or start with a 2–3 city pilot behind the same gates.
