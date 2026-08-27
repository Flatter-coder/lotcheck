// The manufacturer's published fee stack must decompose EXACTLY, or be refused.
//
// WHAT THIS PROTECTS. A dealer's advertised price carries an addon block whose
// platform CAPTION ("Fees & Accessories") describes nothing. On the real 2026
// Lexus NX 350h that block was $3,330, of which $2,335 is manufacturer freight
// and government levies and $995 is Lexus's OWN published dealer fee. Reading
// the caption as dealer padding would be a false statement about a named
// AMVIC-licensed business. [[no-accusation-language]]
//
// This repo has made that exact error once already, at $11,173 of phantom
// markup -- see the S25 comment in analyze-listing-url ("printing Toyota's own
// $3,078 of freight as dealer markup"). So these cases are the safety contract,
// not a nicety.
//
// Fixtures are REAL payloads captured from the manufacturers on 2026-08-27
// (scripts/fixtures/fee-stacks.json), not hand-written shapes: the failure mode
// here is a real published line we never anticipated, and only real data has
// those.
import { readFileSync } from "node:fs";
import {
  parseFeeStack, feeLinesOnly, feeStackTotal, vehiclePrice, allInBreakdown, LINE_KIND, FEE_BASIS,
} from "./lib/tci-fees.mjs";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/fee-stacks.json", import.meta.url), "utf8"));

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const stackFor = (key, series, year) => {
  const payload = FIX[key];
  const code = Object.keys(payload[series][year])[0];
  return parseFeeStack(payload, series, year, code);
};

// ── the report that started this ────────────────────────────────────────────
console.log("\n2026 Lexus NX 350h, Alberta — the real decomposition");
{
  const st = stackFor("Lexus|AB", "NXH", "2026");
  check("the published stack parses", st.ok, st.refusal || "");
  check("vehicle price is MSRP + base package = $58,025", vehiclePrice(st) === 58025, `got ${vehiclePrice(st)}`);

  const byCode = Object.fromEntries(feeLinesOnly(st).map((l) => [l.code, l.amount]));
  check("freight is the manufacturer's $2,205", byCode.FPD === 2205, `got ${byCode.FPD}`);
  check("the A/C excise is $100", byCode.AC === 100);
  check("AMVIC is $10", byCode.AMVIC === 10);
  check("the tire levy is $20 on THIS vehicle (not the hardcoded $25)",
    byCode.TIR === 20, `got ${byCode.TIR} — fee-schedule.ts hardcodes 25, which is wrong for this series`);

  // The claim that matters.
  const dealerTotal = feeLinesOnly(st).filter((l) => l.kind === "dealer").reduce((s, l) => s + l.amount, 0);
  const notDealer = feeStackTotal(st) - dealerTotal;
  check("exactly ONE line is the dealer's", feeLinesOnly(st).filter((l) => l.kind === "dealer").length === 1);
  check("the dealer's own line is $995", dealerTotal === 995, `got ${dealerTotal}`);
  check("$2,337.18 of the block is NOT the dealer's",
    Math.abs(notDealer - 2337.18) < 0.005,
    `got ${notDealer} — this is the money that must never be called padding`);

  // The dealer advertised 3,330: DRF+FPD+AC+AMVIC+TIR, omitting the $2.18 of
  // environmental fees. The dealer charged LESS than the published stack.
  const advertisedBlock = 3330;
  check("the dealer's block is at or BELOW the published stack",
    advertisedBlock <= feeStackTotal(st) + 0.005,
    `dealer ${advertisedBlock} vs published ${feeStackTotal(st)}`);
}

// ── manufacturer accessories must never read as dealer padding ──────────────
console.log("\nfactory accessories are the manufacturer's, not the dealer's");
{
  const st = stackFor("Toyota|AB", "PRD", "2027");
  check("the stack parses despite a nested ACCESSORIES node", st.ok, st.refusal || "");
  const acc = st.lines.find((l) => l.code === "ACCESSORIES");
  check("ACCESSORIES is read at all", !!acc, "its amount lives in items[], not on the node");
  check("ACCESSORIES is classified as MANUFACTURER", acc?.kind === "manufacturer",
    "Toyota publishes and prices it; calling it dealer padding is the false accusation");
  check("the accessory is named, not just totalled",
    !!acc?.items?.length && /block heater/i.test(acc.items[0].label),
    `got ${JSON.stringify(acc?.items)}`);
  check("its amount comes from the nested item", acc?.amount === 702, `got ${acc?.amount}`);
  check("no accessory is ever classified as a dealer line",
    !feeLinesOnly(st).some((l) => l.kind === "dealer" && l.code === "ACCESSORIES"));
}

// ── incentives are negative, after tax, and must not enter the stack ────────
console.log("\ncustomer incentives are excluded, not subtracted from the fees");
{
  const st = stackFor("Lexus|AB", "NX", "2026");
  check("a stack carrying INCENTIVES still reconciles", st.ok, st.refusal || "");
  check("INCENTIVES never appears as a fee line",
    !st.lines.some((l) => l.code === "INCENTIVES"),
    "it is negative and applied after tax at TOTAL; counting it makes every stack short");
  check("no fee line is negative", feeLinesOnly(st).every((l) => l.amount >= 0));
  // The gas NX base — the very figure the bad report anchored a HYBRID to.
  check("the gas NX base is $55,080", vehiclePrice(st) === 55080, `got ${vehiclePrice(st)}`);
}

// ── financing lines are not part of a cash advertised price ────────────────
console.log("\nPPSA is finance-only");
{
  const cash = stackFor("Lexus|AB", "NXH", "2026");
  check("PPSA is absent from the cash basis", !feeLinesOnly(cash).some((l) => l.code === "PPSA"));
  const payload = FIX["Lexus|AB"];
  const code = Object.keys(payload.NXH["2026"])[0];
  const fin = parseFeeStack(payload, "NXH", "2026", code, "finance");
  check("the finance basis parses too", fin.ok, fin.refusal || "");
  check("PPSA appears only when financed",
    !feeLinesOnly(fin).some((l) => l.code === "PPSA") &&
    feeLinesOnly(fin, { financed: true }).some((l) => l.code === "PPSA"),
    "an advertised all-in price is a CASH price");
  check("the financed total is higher by exactly the PPSA lines",
    Math.abs((feeStackTotal(fin, { financed: true }) - feeStackTotal(fin)) - 18) < 0.005,
    "PPSA 14 + PPSASF 4");
}

// ── province shape: Ontario uses OMVIC, not AMVIC ──────────────────────────
console.log("\nthe stack is province-shaped");
{
  const on = stackFor("Toyota|ON", Object.keys(FIX["Toyota|ON"])[0], "2026");
  check("an Ontario stack parses", on.ok, on.refusal || "");
  const codes = feeLinesOnly(on).map((l) => l.code);
  check("Ontario carries OMVIC and not AMVIC",
    codes.includes("OMVIC") && !codes.includes("AMVIC"), codes.join(","));
  check("the regulator line is government, never dealer",
    feeLinesOnly(on).find((l) => l.code === "OMVIC")?.kind === "government");
}

// ── refusal: an unproven stack must never be stored ────────────────────────
console.log("\nan unproven stack is refused, never stored");
{
  const good = FIX["Lexus|AB"];
  const code = Object.keys(good.NXH["2026"])[0];
  const clone = () => JSON.parse(JSON.stringify(good));

  // A line the manufacturer added that we have never classified.
  const withNew = clone();
  withNew.NXH["2026"][code].push({ name: "NEW_MYSTERY_CHARGE", label: { en: "Mystery" }, cash: { amount: 500 } });
  const r1 = parseFeeStack(withNew, "NXH", "2026", code);
  check("an UNRECOGNISED published line refuses the stack", !r1.ok && /unrecognised/i.test(r1.refusal || ""),
    "silently dropping it understates the real charges, which manufactures a residual pointed at the dealer");

  // A stack whose parts do not add up to the manufacturer's own SUBTOTAL.
  const bent = clone();
  const fpd = bent.NXH["2026"][code].find((x) => x.name === "FPD");
  fpd.cash.amount = 9999;
  const r2 = parseFeeStack(bent, "NXH", "2026", code);
  check("a stack that does not reconcile is refused", !r2.ok && /does not reconcile/i.test(r2.refusal || ""),
    r2.refusal || "");

  // No SUBTOTAL to check against.
  const noSub = clone();
  noSub.NXH["2026"][code] = noSub.NXH["2026"][code].filter((x) => x.name !== "SUBTOTAL");
  const r3 = parseFeeStack(noSub, "NXH", "2026", code);
  check("no SUBTOTAL means no proof, so it is refused", !r3.ok && /SUBTOTAL/i.test(r3.refusal || ""));

  check("a missing series refuses rather than throwing",
    !parseFeeStack(good, "NOPE", "2026", "X").ok);
  check("junk input refuses rather than throwing",
    !parseFeeStack(null, "NXH", "2026", code).ok && !parseFeeStack(undefined, undefined, undefined, undefined).ok);
}

// ── taxes and totals may never be stored as fees ──────────────────────────
console.log("\ntaxes and totals are never fees");
{
  const st = stackFor("Lexus|AB", "NXH", "2026");
  for (const banned of ["GST", "PST", "QST", "HST", "TOTAL", "SUBTOTAL", "DOWN_PAYMENT", "INCENTIVES"]) {
    check(`${banned} never appears as a fee line`, !st.lines.some((l) => l.code === banned));
    check(`${banned} is classified excluded`, LINE_KIND[banned] === "excluded");
  }
  check("the default basis is cash", FEE_BASIS === "cash");
}

// ── the stored shape matches what is already in the table ─────────────────
console.log("\nthe stored breakdown matches the hand-seeded convention");
{
  const st = stackFor("Lexus|AB", "NXH", "2026");
  const b = allInBreakdown(st);
  // These key names are not invented here: 38 rows in msrp_catalog already
  // carry attrs.all_in_breakdown in exactly this shape, seeded by hand from
  // Build & Price summaries. The capture is a drop-in replacement for that
  // hand-seeding, not a second competing convention.
  check("the keys are the ones already in the table",
    JSON.stringify(Object.keys(b).sort()) ===
    JSON.stringify(["air_conditioning", "amvic", "dealer_fees_max", "delivery_destination", "env_filters", "env_lube", "tire_levy"]),
    JSON.stringify(Object.keys(b)));
  check("freight is stored under delivery_destination", b.delivery_destination === 2205);
  check("the dealer fee is stored under dealer_fees_max", b.dealer_fees_max === 995);
  check("the breakdown sums to the fee total",
    Math.abs(Object.entries(b).filter(([, v]) => typeof v === "number").reduce((sm, [, v]) => sm + v, 0) - feeStackTotal(st)) < 0.005);
  check("a refused stack yields no breakdown at all",
    allInBreakdown({ ok: false }) === null, "a breakdown we cannot prove must not be written");
}

console.log("\na factory accessory is named, not buried");
{
  const st = stackFor("Toyota|AB", "PRD", "2027");
  const b = allInBreakdown(st);
  check("the block heater gets its own key", b.block_heater === 702, JSON.stringify(b));
  check("and the flag the seeded rows already use", b.block_heater_included === true);
  check("it is never folded into the dealer fee", b.dealer_fees_max === 999);
}

// ── attrs must never be clobbered by a fresh capture ─────────────────────
console.log("\na fresh capture adds to hand-verified attrs, never replaces them");
{
  const { mergeCarryForward } = await import("./lib/catalog-io.mjs");
  const prev = [{
    year: 2026, make: "Toyota", model: "4Runner Hybrid", trim: "Platinum with Fixed Running Board",
    attrs: { seats: 5, base_msrp: 69207, package_line: "Platinum with Fixed Running Board",
             block_heater_included: true, captured_from: "toyota.ca B&P screenshot (2026-08-16)",
             captured_on: "2026-08-16" },
  }];
  const fresh = [{
    year: 2026, make: "Toyota", model: "4Runner Hybrid", trim: "Platinum with Fixed Running Board",
    msrp: 74014, attrs: { province: "AB", all_in_breakdown: { delivery_destination: 1930 }, captured_on: "2026-08-27" },
  }];
  const { rows } = mergeCarryForward(fresh, prev);
  const a = rows[0].attrs;
  check("hand-verified keys survive", a.seats === 5 && a.base_msrp === 69207 && a.package_line);
  check("the fresh capture is added", a.province === "AB" && a.all_in_breakdown.delivery_destination === 1930);
  check("a key present on BOTH sides takes the fresh value",
    a.captured_on === "2026-08-27", "a fresh scrape still wins per key");
  check("nothing is lost in either direction",
    Object.keys(a).length === 8, JSON.stringify(Object.keys(a)));
  check("the hand-seeded provenance is still there alongside the new one",
    a.captured_from === "toyota.ca B&P screenshot (2026-08-16)");
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
