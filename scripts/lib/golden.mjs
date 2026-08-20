// Golden-set shared helpers: VIN check digit, URL normalization, and the
// grader that scores a pipeline analysis object against an answer key.
//
// THE POINT OF THIS FILE is measuring CORRECTNESS, not coverage — the
// benchmark already counts what resolved; this grades whether what resolved
// was RIGHT, against values independently read off the dealer's own page
// (scripts/build-golden-set.mjs). Grading rules are deliberately conservative:
// a point the key cannot prove from the page is `not_gradable`, never assumed
// correct — an assumed pass here would be the same false all-clear this whole
// instrument exists to kill.
//
// INDEPENDENCE RULE: nothing in scripts/lib/golden.mjs or the golden-set
// builder may import from supabase/functions/_shared. The pipeline's own
// parsers must never grade themselves — a shared bug would score as a match.

// ── VIN check digit (ISO 3779) ───────────────────────────────────────────────
const VIN_MAP = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function vinValid(vin) {
  if (typeof vin !== "string") return false;
  const v = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = v[i];
    const val = ch >= "0" && ch <= "9" ? Number(ch) : VIN_MAP[ch];
    if (val === undefined) return false;
    sum += val * VIN_WEIGHTS[i];
  }
  const rem = sum % 11;
  const check = rem === 10 ? "X" : String(rem);
  return v[8] === check;
}

export function normUrl(u) {
  try {
    const x = new URL(String(u));
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

// ── model identity ───────────────────────────────────────────────────────────
// Tolerate wording variants (dealer-model-name-variants) but NEVER blur
// powertrain: "RAV4 Hybrid" and "RAV4" are different cars with a ~$5,500 gap
// (powertrain-identity-rule). A marker on one side only is a mismatch.
const PT_RE = /\b(plug[\s-]?in[\s-]?hybrid|phev|hybrid|hev|prime|electric|\bev\b|e:hev|etron|e-tron)\b/i;

function ptMarker(s) {
  const m = String(s || "").match(PT_RE);
  if (!m) return "";
  const t = m[0].toLowerCase().replace(/[\s-]/g, "");
  if (t === "pluginhybrid" || t === "phev" || t === "prime") return "phev";
  if (t === "hybrid" || t === "hev" || t === "e:hev") return "hybrid";
  return "ev";
}

function baseName(s) {
  return String(s || "").toLowerCase().replace(PT_RE, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function modelsMatch(keyModel, aModel) {
  if (!keyModel || !aModel) return null;
  if (ptMarker(keyModel) !== ptMarker(aModel)) return false;
  const k = baseName(keyModel);
  const a = baseName(aModel);
  if (!k || !a) return null;
  return k === a || k.includes(a) || a.includes(k);
}

// ── grading ──────────────────────────────────────────────────────────────────
// Grades: correct | correct_absent | wrong | false_accusation | missed | not_gradable
//   correct         delivered value matches the page truth
//   correct_absent  the value truly is not on the page and the report said so honestly
//   wrong           delivered value contradicts the page truth
//   false_accusation an accusatory claim (price-gating) contradicted by the page
//   missed          the page publishes it (proven) and the report delivered nothing
//   not_gradable    the key cannot prove this point from the page — NEVER counts as pass
const GRADABLE = new Set(["structured", "cross", "agent"]);

function field(key, name) {
  const f = key?.fields?.[name];
  if (!f || f.value === undefined || f.value === null) return null;
  if (!GRADABLE.has(f.confidence)) return null;
  return f;
}

function numEq(a, b, tol = 1) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tol;
}

export function gradeListing(key, a) {
  const points = {};
  const reasons = [];
  const grade = (name, g, why) => {
    points[name] = g;
    if (why) reasons.push(`${name}: ${why}`);
  };

  // identity — year + make + model, powertrain-strict
  const kYear = field(key, "year");
  const kMake = field(key, "make");
  const kModel = field(key, "model");
  if (kYear || kMake || kModel) {
    let bad = null;
    if (kYear && a?.year && Number(a.year) !== Number(kYear.value)) bad = `year ${a.year} vs page ${kYear.value}`;
    if (!bad && kMake && a?.make && String(a.make).toLowerCase().replace(/[^a-z0-9]/g, "") !== String(kMake.value).toLowerCase().replace(/[^a-z0-9]/g, "")) {
      bad = `make ${a.make} vs page ${kMake.value}`;
    }
    if (!bad && kModel && a?.model) {
      const m = modelsMatch(kModel.value, a.model);
      if (m === false) bad = `model ${a.model} vs page ${kModel.value} (powertrain-strict)`;
    }
    const compared = (kYear && a?.year) || (kMake && a?.make) || (kModel && a?.model);
    grade("identity", !compared ? "not_gradable" : bad ? "wrong" : "correct", bad);
  } else grade("identity", "not_gradable");

  // condition — new vs used (certified counts as used)
  const kCond = field(key, "condition");
  if (kCond && a?.vehicleCondition) {
    const norm = (s) => (/used|certified|pre-?owned/i.test(String(s)) ? "used" : "new");
    grade("condition", norm(kCond.value) === norm(a.vehicleCondition) ? "correct" : "wrong",
      norm(kCond.value) !== norm(a.vehicleCondition) ? `${a.vehicleCondition} vs page ${kCond.value}` : "");
  } else grade("condition", "not_gradable");

  // price + price_gating
  const kPrice = field(key, "askingPrice");
  const keyGated = key?.priceGated === true;
  const aPrice = a?.quotedPrice;
  const aSaysGated = /hidden|contact|gated|not[_ ]?shown/i.test(String(a?.priceDisclosure || "")) ||
    (aPrice == null && /contact|call|inquire/i.test(String(a?.summary || "")) && /price/i.test(String(a?.summary || "")));
  if (kPrice) {
    if (aPrice != null) grade("price", numEq(kPrice.value, aPrice) ? "correct" : "wrong", numEq(kPrice.value, aPrice) ? "" : `$${aPrice} vs page $${kPrice.value}`);
    else grade("price", "missed", `page advertises $${kPrice.value}, report has none`);
    // accusing a dealer of hiding a price they advertise is the class-c error
    if (aSaysGated) grade("price_gating", "false_accusation", `report claims price-gating; page advertises $${kPrice.value}`);
    else grade("price_gating", "correct");
  } else if (keyGated) {
    if (aPrice != null) grade("price", "wrong", `report shows $${aPrice} but the page gates its price`);
    else grade("price", "correct_absent");
    grade("price_gating", aSaysGated ? "correct" : "not_gradable");
  } else {
    grade("price", "not_gradable");
    grade("price_gating", "not_gradable");
  }

  // vin
  const kVin = field(key, "vin");
  if (kVin) {
    if (a?.vin) grade("vin", String(a.vin).toUpperCase() === String(kVin.value).toUpperCase() ? "correct" : "wrong",
      String(a.vin).toUpperCase() !== String(kVin.value).toUpperCase() ? `${a.vin} vs page ${kVin.value}` : "");
    else grade("vin", "missed", `page publishes ${kVin.value}`);
  } else if (key?.vinAbsentConfirmed === true) {
    grade("vin", a?.vin ? "not_gradable" : "correct_absent");
  } else grade("vin", "not_gradable");

  // odometer
  const kOdo = field(key, "odometerKm");
  if (kOdo && a?.odometerKm != null) {
    grade("odometer", numEq(kOdo.value, a.odometerKm) ? "correct" : "wrong",
      numEq(kOdo.value, a.odometerKm) ? "" : `${a.odometerKm} km vs page ${kOdo.value} km`);
  } else if (kOdo && a?.odometerKm == null && /used/i.test(String(kCond?.value || ""))) {
    grade("odometer", "missed", `page publishes ${kOdo.value} km`);
  } else grade("odometer", "not_gradable");

  // dealer-stated MSRP only — an "exact" basis is catalog authority, graded by
  // the catalog value audit, not by the page.
  const kMsrp = field(key, "msrpStated");
  if (kMsrp && a?.msrpBasis === "dealer_stated" && a?.msrp != null) {
    grade("msrp_dealer_stated", numEq(kMsrp.value, a.msrp) ? "correct" : "wrong",
      numEq(kMsrp.value, a.msrp) ? "" : `$${a.msrp} vs page $${kMsrp.value}`);
  } else if (kMsrp && a?.msrp == null) {
    grade("msrp_dealer_stated", "missed", `page states MSRP $${kMsrp.value}`);
  } else grade("msrp_dealer_stated", "not_gradable");

  const vals = Object.values(points);
  const verdict = vals.includes("false_accusation") ? "FAIL_FALSE_ACCUSATION"
    : vals.includes("wrong") ? "FAIL"
    : vals.every((v) => v === "not_gradable") ? "NOT_GRADABLE"
    : "PASS";
  return { url: key?.url, verdict, points, reasons };
}

export function summarize(grades) {
  const graded = grades.filter((g) => g.verdict !== "NOT_GRADABLE");
  const byPoint = {};
  for (const g of grades) {
    for (const [p, v] of Object.entries(g.points)) {
      byPoint[p] = byPoint[p] || {};
      byPoint[p][v] = (byPoint[p][v] || 0) + 1;
    }
  }
  const fails = graded.filter((g) => g.verdict !== "PASS");
  const falseAcc = graded.filter((g) => g.verdict === "FAIL_FALSE_ACCUSATION");
  const n = graded.length;
  return {
    listings: grades.length,
    graded: n,
    pass: n - fails.length,
    fail: fails.length,
    false_accusations: falseAcc.length,
    accuracyPct: n ? Math.round(((n - fails.length) / n) * 1000) / 10 : null,
    // rule of three: 0 fails in n graded reports bounds the true failure
    // rate below 3/n at 95% confidence — the number 99% claims need.
    ruleOfThree95UpperPct: n && fails.length === 0 ? Math.round((3 / n) * 1000) / 10 : null,
    byPoint,
  };
}
