// Stacked cash incentives, read from the dealer platform's own embedded data.
//
// WHY THIS EXISTS. A 10-URL accuracy run (2026-08-11) found a live Jack Carter
// listing where the report said "the cash price matches MSRP at $50,308 with no
// discount or added fees disclosed" — while the page's own <title> advertised
// the car "at $43246". The $7,062 gap was two stacked offers the page carried
// in an embedded JSON blob rather than in readable prose: a $2,300
// Non-Stackable Cash Delivery Allowance paid to the DEALER, and a $4,762
// Federal EVAP Rebate paid to the CUSTOMER and gated on eligibility.
//
// That gap is the whole product. The buyer walks in not knowing $7,062 exists,
// and not knowing the advertised number is conditional — the exact leverage
// LotCheck is built to hand them. A sibling platform (SM360) already has its
// incentives read via captureSm360Extras; this covers the EDealer-family shape,
// which is the one that was silently returning "no discount".
//
// NEVER FABRICATE: every figure returned here is copied from the page's own
// data. Nothing is inferred, and a shape we don't recognise returns null rather
// than a guess.

// Pull the balanced JSON value that follows `"key":` starting at `from`.
// Returns the raw substring, or null if the brackets never balance (truncated
// HTML, or a key that appears inside a string rather than as real structure).
function balancedAfterKey(html, key, from = 0) {
  const at = html.indexOf(`"${key}"`, from);
  if (at === -1) return null;
  const colon = html.indexOf(":", at + key.length + 2);
  if (colon === -1) return null;
  let i = colon + 1;
  while (i < html.length && /\s/.test(html[i])) i++;
  const open = html[i];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return html.slice(i, j + 1);
    }
  }
  return null;
}

// "$2,300" / "4,762" / 2300 / "$2,300.00" → 2300. Anything else → null.
// Deliberately strict: a value we can't read cleanly is dropped, not guessed.
function money(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[$\s,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read the stacked CASH incentives an EDealer-family page advertises.
 *
 * @param {string} html raw page source
 * @returns {{priceAfterIncentives:number|null,totalIncentives:number,offers:Array<{name:string,value:number|null,payee:string|null,expiry:string|null}>}|null}
 *          null when the page carries no recognisable cash-incentive block.
 */
export function extractCashIncentives(html) {
  if (typeof html !== "string" || !html) return null;

  // Scan every occurrence: these pages repeat the block per trim/payment mode,
  // and only some entries carry the stacked offers we want.
  let from = 0;
  let best = null;
  for (let guard = 0; guard < 40; guard++) {
    const at = html.indexOf('"cash_incentives"', from);
    if (at === -1) break;
    from = at + 1;
    const raw = balancedAfterKey(html, "cash_incentives", at);
    if (!raw) continue;
    let arr;
    try { arr = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(arr)) continue;

    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const stack = Array.isArray(entry.stackable_offers) ? entry.stackable_offers : [];
      if (!stack.length) continue;

      const offers = [];
      for (const o of stack) {
        const name = String(o?.name || "").trim();
        if (!name) continue;
        offers.push({
          name,
          value: money(o?.cash_value),
          payee: o?.payee ? String(o.payee).trim() : null,
          expiry: o?.expiryDate ? String(o.expiryDate).trim() : null,
        });
      }
      if (!offers.length) continue;

      // Prefer the platform's own total; fall back to summing what we read.
      const stated = money(entry.totalAmount);
      const summed = offers.reduce((t, o) => t + (o.value || 0), 0);
      const totalIncentives = stated ?? (summed > 0 ? summed : 0);
      if (!totalIncentives) continue;

      const candidate = {
        priceAfterIncentives: money(entry.amount),
        totalIncentives,
        offers,
      };
      // Keep the richest block on the page (most named offers, then largest).
      if (
        !best ||
        candidate.offers.length > best.offers.length ||
        (candidate.offers.length === best.offers.length &&
          candidate.totalIncentives > best.totalIncentives)
      ) best = candidate;
    }
  }
  return best;
}

/**
 * Turn extracted incentives into report add-on lines.
 *
 * Each offer becomes a NEGATIVE-priced "discount" line so it flows through the
 * existing add-ons audit and reconciliation unchanged. The `reason` states who
 * the money actually goes to and whether it is conditional — a dealer-payee
 * allowance is not money in the buyer's pocket, and an eligibility-gated rebate
 * is not guaranteed. Both are things the buyer must raise at the table.
 */
export function incentivesToAddOns(inc) {
  if (!inc || !Array.isArray(inc.offers) || !inc.offers.length) return [];
  return inc.offers.map((o) => {
    const conditional = /eligible|potential|qualif/i.test(o.name);
    const toDealer = String(o.payee || "").toUpperCase() === "DEALER";
    const bits = [];
    if (toDealer) bits.push("Paid to the dealer, not to you — confirm it actually comes off your price.");
    else if (o.payee) bits.push(`Paid to: ${o.payee.toLowerCase()}.`);
    if (conditional) bits.push("The dealer's own wording makes this conditional on eligibility — get written confirmation it applies to you before you rely on it.");
    if (o.expiry) bits.push(`Listed expiry: ${o.expiry}.`);
    return {
      name: o.name,
      price: o.value != null ? -o.value : null,
      kind: "discount",
      verdict: conditional || toDealer ? "watch" : "good",
      reason: bits.join(" ") || null,
    };
  });
}
