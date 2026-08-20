// Per-checkpoint outcomes for every report.
//
// WHY. api_usage_log records ONE boolean per run. A report that delivered a
// price and nothing else -- no MSRP, no VIN, no recalls -- was logged
// `success: true` and rendered on the admin panel identically to a complete
// one. "4 scans, 2 green, look at the things it missed, how can it be green?"
// A count is not a verdict.
//
// THE STANDARD (Vic, 2026-08-15): failure rate under 1%, measured PER
// CHECKPOINT, not per request. A checkpoint that did not resolve is RED, not
// neutral and not excused. If a report ships without an MSRP that is an MSRP
// failure whatever the reason -- catalog gap, unreadable page, missing trim.
// The buyer paid for 13 points and got 12.
//
// THE ONE RULE THAT KEEPS THIS HONEST. `not_applicable` is the only outcome
// excluded from the failure rate, so it is the only thing that could turn this
// panel back into decoration. It may therefore be returned ONLY on a POSITIVE
// fact we established -- "fuelType is Gas, so there is no EV rebate to find",
// "vehicleCondition is new, so there is no odometer history to check". Never
// on absence. Not knowing something is `not_attempted`, and `not_attempted` is
// RED. If you are tempted to write `not_applicable` because a value was
// missing, that is the bug this file exists to expose.

export type Outcome =
  | "verified"          // resolved, with a backed value            -> GREEN
  | "checked_no_match"  // looked authoritatively, answer is "none"  -> GREEN
  | "not_applicable"    // provably does not apply to this vehicle   -> excluded
  | "error"             // tried, and it broke                       -> RED
  | "not_attempted";    // never ran, or ran without enough input    -> RED

export const CHECKPOINTS = [
  "msrp", "odometer", "recalls", "fees", "ev_rebate", "vin", "warranty",
  "financing", "apr", "reputation", "leverage", "days_on_lot", "amvic",
] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export const GREEN: ReadonlySet<Outcome> = new Set(["verified", "checked_no_match"]);
export const RED: ReadonlySet<Outcome> = new Set(["error", "not_attempted"]);

export type CheckRow = { checkpoint: Checkpoint; outcome: Outcome; detail: string | null };

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v: unknown) => (num(v) ?? 0) > 0;
// fuelType casing differs between the two functions ("Hybrid"/"Gas" on the
// listing path, "hybrid"/"gas" on the quote path). Compare lowercased or the
// EV-rebate checkpoint silently mis-classifies half the fleet.
const fuel = (a: any) => String(a?.fuelType ?? "").trim().toLowerCase();
const isNew = (a: any) => String(a?.vehicleCondition ?? "").trim().toLowerCase() === "new";

/**
 * Pure. Given a finished analysis, say what each of the 13 checkpoints did.
 * `feature` is "quote" (uploaded PDF/photo) or "listing_url".
 */
export function deriveCheckpoints(analysis: any, feature: "quote" | "listing_url"): CheckRow[] {
  const a = analysis ?? {};
  const isUrl = feature === "listing_url";
  const row = (checkpoint: Checkpoint, outcome: Outcome, detail: string | null = null): CheckRow =>
    ({ checkpoint, outcome, detail });

  // ---- 1. MSRP ------------------------------------------------------------
  // The one that exposes the catalog. A NEW vehicle with no MSRP is a failure,
  // full stop -- that is the whole comparison the report is built on. A USED
  // vehicle is different in kind: the report explicitly switches the over/under
  // comparison off, and the function records WHY, so that is a real N/A.
  let msrp: CheckRow;
  if (pos(a.msrp)) {
    msrp = row("msrp", "verified", `${a.msrpSource ?? "?"}/${a.msrpBasis ?? "?"}`);
  } else if (!isNew(a) && a.msrpUnavailable?.reason === "used_original_msrp_not_held") {
    msrp = row("msrp", "not_applicable", "used — original MSRP not held");
  } else if (!(a.year && a.make && a.model)) {
    msrp = row("msrp", "not_attempted", "year/make/model incomplete");
  } else {
    msrp = row("msrp", "error", `no catalog row for ${a.year} ${a.make} ${a.model}`);
  }

  // ---- 2. Odometer --------------------------------------------------------
  // A new vehicle has no odometer history to verify. That is a fact about the
  // vehicle, not a gap in our reading, so it is the rare honest N/A.
  const odometer: CheckRow = a.odometerCheck?.checked === true
    ? row("odometer", "verified", `${a.odometerKm ?? "?"} km`)
    : isNew(a)
      ? row("odometer", "not_applicable", "new vehicle")
      : row("odometer", "not_attempted", a.odometerKm == null ? "no odometer published" : "no year to judge against");

  // ---- 3. Open recalls ----------------------------------------------------
  // `confirmed` is load-bearing. {checked:true, count:0, confirmed:false} means
  // Transport Canada returned nothing AND we never proved it knows this model
  // -- indistinguishable from a typo in the model name. Reporting that as a
  // clean bill is the exact failure make-recalls-fail-safe exists to prevent,
  // so it is RED here even though the lookup "worked".
  let recalls: CheckRow;
  const rc = a.recalls;
  if (!rc) recalls = row("recalls", "not_attempted", "year/make/model incomplete");
  else if (rc.checked !== true) recalls = row("recalls", "error", String(rc.error ?? "registry unreachable"));
  else if (rc.confirmed !== true) recalls = row("recalls", "error", `unconfirmed model match (${rc.queriedModel ?? "?"}) — a zero here is not a clean bill`);
  else if (num(rc.count) && num(rc.count)! > 0) recalls = row("recalls", "verified", `${rc.count} open`);
  else recalls = row("recalls", "checked_no_match", `none open for ${rc.matchedModel ?? rc.queriedModel ?? "model"}`);

  // ---- 4. Fee audit -------------------------------------------------------
  // No path sets a `checked` flag, so this is inferred: an itemised add-on or a
  // doc-fee assessment proves we read the pricing block. An EMPTY add-on list
  // only proves it if we also got a price out of the same block -- otherwise
  // "no fees found" and "never read the fees" are the same value, and the
  // former is exactly the false all-clear we are trying to kill.
  const addOns = Array.isArray(a.addOns) ? a.addOns : null;
  const fees: CheckRow = (addOns && addOns.length > 0)
    ? row("fees", "verified", `${addOns.length} itemised`)
    : a.docFeeCheck
      ? row("fees", "verified", `doc fee ${a.docFeeCheck.kind ?? "assessed"}`)
      : (addOns && pos(a.quotedPrice))
        ? row("fees", "checked_no_match", "priced block read, no add-ons itemised")
        : row("fees", "not_attempted", addOns ? "no price read, so an empty fee list proves nothing" : "no add-on list returned");

  // ---- 5. EV rebate -------------------------------------------------------
  // Computed in the browser, but its resolvability is decided here: given a
  // known fuel type the outcome is deterministic. Gas/diesel/hybrid genuinely
  // have no federal EV rebate -- a positive fact, so N/A. An UNKNOWN fuel type
  // is not N/A, it is a miss, because we cannot say either way.
  const f = fuel(a);
  const ev: CheckRow = !f
    ? row("ev_rebate", "not_attempted", "fuel type unknown — cannot say either way")
    : (f === "bev" || f === "phev")
      ? row("ev_rebate", "verified", f.toUpperCase())
      : row("ev_rebate", "not_applicable", `${f} — no EV rebate exists`);

  // ---- 6. VIN -------------------------------------------------------------
  // A dealer who does not publish a VIN is still a miss for us: the report says
  // "Not published — ask the dealer", which is the right copy but not a passed
  // check. Keeping it RED is what drives recovery from vmsData/__vdpJSON.
  const vc = a.vinCheck;
  const vin: CheckRow = vc?.present && vc?.valid
    ? row("vin", "verified", String(a.vin ?? "").slice(-6) ? `…${String(a.vin).slice(-6)}` : null)
    : vc?.present
      ? row("vin", "error", `VIN present but invalid: ${vc.reason ?? "failed pattern"}`)
      : row("vin", "not_attempted", "no VIN published");

  // ---- 7. Warranty --------------------------------------------------------
  const warranty: CheckRow = a.standardWarranty?.verified === true
    ? row("warranty", "verified", String(a.standardWarranty.coverage ?? "").slice(0, 60) || null)
    : a.remainingWarranty?.make
      ? row("warranty", "verified", "remaining coverage computed")
      : a.standardWarranty?.verified === false
        ? row("warranty", "error", `no warranty on file for ${a.make ?? "make"}`)
        : row("warranty", "not_attempted", "no warranty resolved");

  // ---- 8. Financing math --------------------------------------------------
  // A listing that discloses no financing has no arithmetic to reconcile -- but
  // only if we actually READ the listing. "No financing found" and "we read
  // nothing at all" are the same absent value, so the N/A has to be earned by
  // a price coming out of the same page. Without one this is a miss, not a
  // pass. (Caught by the empty-analysis case in the test harness, which is
  // exactly the leak this vocabulary was designed to prevent.)
  // A dealer disclosing nothing is NOT the end of the check. Vic's rule: no
  // dealer terms -> use the manufacturer's published APR and the asking price
  // and do the math (computeReferenceFinancing, analyze-listing-url:2629). That
  // work was already being done and the checkpoint could not see it, so every
  // such listing scored not_applicable — 3 n/a, 0 judged, a checkpoint that had
  // never once been exercised while the arithmetic behind it ran fine.
  //
  // n/a now has to be EARNED twice over: no dealer terms AND no reference we
  // could compute from. Otherwise a checkpoint quietly excuses itself out of
  // the denominator, which is the failure mode this whole vocabulary exists to
  // stop — the same shape as a hollow row reading as a pass.
  const financing: CheckRow = a.financingCheck?.checked === true
    ? row("financing", "verified", a.financingCheck.consistent ? "reconciles" : "does NOT reconcile")
    : a.referenceFinancing?.apr != null && pos(a.quotedPrice)
      ? row("financing", "verified",
            `no dealer terms — computed from the manufacturer's ${a.referenceFinancing.apr}% over ${a.referenceFinancing.termMonths ?? "?"}mo`)
    : a.financing == null
      ? (pos(a.quotedPrice)
          ? row("financing", "not_applicable", "priced listing discloses no financing, and no manufacturer rate to compute from")
          : row("financing", "not_attempted", "nothing read from the listing — absence of financing proves nothing"))
      : row("financing", "not_attempted", "financing disclosed but incomplete (need payment, term, frequency, total)");

  // ---- 9. APR vs official ------------------------------------------------
  // Either side counts: when the dealer advertises no rate we fill the
  // manufacturer's published promo rate as a labelled reference, and that IS
  // the check resolving.
  // "verified" on the dealer side requires an EVIDENCED source (the feed, a
  // platform data blob, or matched page text -- see apr-extract.js). The
  // model's own unconfirmed read ("llm", or no source at all) resolving to
  // some number is not the same as the rate being right -- this checkpoint
  // logged green for a report that told a buyer to accuse a dealer of a 25%
  // rate the page never advertised (2026-08-19, easytermauto.ca). Falls
  // through to the manufacturer reference exactly as if the dealer had
  // disclosed nothing, matching every display surface's fallback.
  const dealerAprTrusted = pos(a.financeRates?.dealer?.apr) && ["sm360_feed", "convertus_vms", "page_text"].includes(a.financeRates.dealer.source)
    ? a.financeRates.dealer.apr : null;
  const apr: CheckRow = dealerAprTrusted != null
    ? row("apr", "verified", `dealer ${dealerAprTrusted}%`)
    : pos(a.financeRates?.manufacturer?.apr)
      ? row("apr", "verified", `manufacturer reference ${a.financeRates.manufacturer.apr}%`)
      : row("apr", "not_attempted", `no advertised rate and no ${a.make ?? "make"} row in finance_rate_catalog`);

  // ---- 10. Dealer reputation ---------------------------------------------
  // Fetched by the browser from get-dealer-sentiment, which writes its OWN row
  // against this report id. All that can be decided here is whether the lookup
  // was even possible; if it was, that function has the last word.
  // TWO WRITERS, ONE ROW — and that was the defect. This seeded a RED
  // ("awaiting get-dealer-sentiment") which only a LATER, browser-initiated
  // call to that function could clear. If the buyer closed the tab, or the
  // request failed, or the browser never fired it, the red stood forever. 3 of
  // 5 reputation checks were red for exactly that reason: nothing had gone
  // wrong with the lookup, it had simply never been answered.
  //
  // A checkpoint whose DEFAULT is failure and whose correction is best-effort
  // measures the browser, not the dealer. So: one owner per checkpoint.
  // get-dealer-sentiment writes reputation and this function does not — except
  // where the answer is already decided here, with no dealer name there is
  // nothing for anyone to look up and that is a real, final miss.
  const reputation: CheckRow | null = a.dealerName
    ? null
    : row("reputation", "not_attempted", "no dealer name — nothing to look up");

  // ---- 11. Leverage score -------------------------------------------------
  // The score is always emitted, so its presence proves nothing. An empty
  // `basis` means it was computed from no verified inputs at all -- a number
  // with nothing behind it, which under claims-must-stay-backed is a miss.
  const basis = Array.isArray(a.leverageScore?.basis) ? a.leverageScore.basis : [];
  const leverage: CheckRow = basis.length > 0
    ? row("leverage", "verified", `${basis.length} input(s), score ${a.leverageScore?.score ?? "?"}`)
    : row("leverage", "not_attempted", "score computed from no verified inputs");

  // ---- 12. Days on lot ----------------------------------------------------
  // An uploaded PDF has no listing to age -- genuinely N/A. On a URL, "this
  // dealer platform does not expose it" is NOT an excuse: days-on-lot is meant
  // to run on our own daily first-seen tracker with zero vendors. Until that
  // ships this reads RED on most platforms, which is the correct pressure.
  const days: CheckRow = !isUrl
    ? row("days_on_lot", "not_applicable", "uploaded document — no live listing to age")
    : pos(a.daysOnLot?.days)
      ? row("days_on_lot", "verified", `${a.daysOnLot.days} days (${a.daysOnLot.source ?? "?"})`)
      : row("days_on_lot", "not_attempted", "platform does not expose it — needs our own first-seen tracker");

  // ---- 13. AMVIC licence --------------------------------------------------
  // Implemented on the URL path only. On the upload path it is NOT run, and
  // that reads as a miss rather than N/A on purpose: every report feature is
  // supposed to ship to every surface, so this row is the standing reminder.
  const amvic: CheckRow = a.dealerLicence?.state
    ? row("amvic", "verified", `${a.dealerLicence.state}${a.dealerLicence.licenceNumber ? ` #${a.dealerLicence.licenceNumber}` : ""}`)
    : !isUrl
      ? row("amvic", "not_attempted", "not implemented on the upload path")
      : a.dealerName
        ? row("amvic", "not_attempted", `no confident AMVIC match for "${a.dealerName}"`)
        : row("amvic", "not_attempted", "no dealer name — nothing to match");

  // `reputation` is null when get-dealer-sentiment owns the answer. Filtered
  // rather than emitted as a placeholder: a row that exists only to be
  // overwritten is a red until it is, and unanswered is not the same as failed.
  return [msrp, odometer, recalls, fees, ev, vin, warranty, financing, apr, reputation, leverage, days, amvic]
    .filter((r): r is CheckRow => r !== null);
}

/**
 * Fail-open write. Telemetry must never break a buyer's report: every failure
 * here is swallowed after a warn. Uses the RPC so the table itself stays
 * closed to everything but service-role.
 */
export async function recordCheckpoints(
  supabase: any,
  opts: { reportId?: string | null; feature: "quote" | "listing_url"; analysis: any; listingHost?: string | null },
): Promise<void> {
  try {
    const rows = deriveCheckpoints(opts.analysis, opts.feature).map((r) => ({
      report_id: opts.reportId ?? null,
      feature: opts.feature,
      listing_host: opts.listingHost ?? null,
      checkpoint: r.checkpoint,
      outcome: r.outcome,
      detail: r.detail,
    }));
    const { error } = await supabase.rpc("fn_log_verification_checks", { p_rows: rows });
    if (error) console.warn("verification_check write failed:", error.message);
  } catch (e) {
    console.warn("verification_check write threw:", (e as Error)?.message);
  }
}
