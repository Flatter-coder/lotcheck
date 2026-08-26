// Regression suite for the fee catalog (fee-schedule.ts).
// Run: node --experimental-strip-types supabase/functions/_shared/fee-schedule.test.ts
//
// Locks the SOURCED figures to the two Build & Price captures they came from, so
// a silent edit to a fee constant fails the build. The load-bearing invariant is
// Toyota's proven all-in: MSRP + $3,078 of adds = the B&P "From" price, exact to
// the dollar on three RAV4 trims (see 20260815_msrp_all_in_price.sql).

import {
  governmentFees,
  feeAmount,
  dealerFeeCeiling,
  freightFor,
  hasBrandFees,
  assessDealerFeeVsCeiling,
  explainAllIn,
} from "./fee-schedule.ts";

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const ok = (label: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

// ── The universal trio: brand-independent, identical Toyota vs Lexus ─────────
check("AB A/C charge is $100",   feeAmount("AB", "ac_charge"), 100);
check("AB AMVIC is $10",         feeAmount("AB", "amvic"), 10);
check("AB tire levy is $25",     feeAmount("AB", "tire_levy"), 25);
ok("A/C charge is federal, so it applies to any make in AB",
  governmentFees("AB").some((f) => f.component === "ac_charge" && f.scope === "federal"));

// ── PPSA is financing-conditional ────────────────────────────────────────────
check("no PPSA on a cash deal",            feeAmount("AB", "ppsa_fee"), null);
check("PPSA fee is $14 when financed",     feeAmount("AB", "ppsa_fee", { financed: true }), 14);
check("PPSA fee is $10 when leased",       feeAmount("AB", "ppsa_fee", { leased: true }), 10);
check("PPSA service fee $4 when financed", feeAmount("AB", "ppsa_service", { financed: true }), 4);

// ── Per-brand: freight (model) + dealer-fee ceiling (make) ───────────────────
check("Toyota RAV4 freight is $1,930", freightFor("Toyota", "RAV4")?.amount, 1930);
check("Lexus ES freight is $2,205",    freightFor("Lexus", "ES")?.amount, 2205);
// Folded-in freight (2026-08-26): verified via exa / batch-1 official captures.
check("Nissan Rogue freight is $2,080",         freightFor("Nissan", "Rogue")?.amount, 2080);
check("Chevrolet Silverado 1500 freight is $2,700", freightFor("Chevrolet", "Silverado 1500")?.amount, 2700);
check("Volvo XC60 freight is $2,770",           freightFor("Volvo", "XC60")?.amount, 2770);
check("Infiniti QX60 freight is $2,495",        freightFor("Infiniti", "QX60")?.amount, 2495);
check("Toyota dealer-fee ceiling is $999", dealerFeeCeiling("Toyota", "AB")?.amount, 999);
check("Lexus dealer-fee ceiling is $995",  dealerFeeCeiling("Lexus", "AB")?.amount, 995);
// Newly captured, verified verbatim at each official source (2026-08-25).
check("Hyundai dealer-fee ceiling is $799",    dealerFeeCeiling("Hyundai")?.amount, 799);
check("Mazda dealer-fee ceiling is $795",      dealerFeeCeiling("Mazda")?.amount, 795);
check("Volkswagen dealer-fee ceiling is $750", dealerFeeCeiling("Volkswagen")?.amount, 750);
check("Chevrolet dealer-fee ceiling is $699",  dealerFeeCeiling("Chevrolet")?.amount, 699);
check("Nissan dealer-fee ceiling is $621",     dealerFeeCeiling("Nissan")?.amount, 621);
// Batch 2 (2026-08-26): verified in-session / same-family corroborated.
check("MINI dealer-fee ceiling is $595",       dealerFeeCeiling("MINI")?.amount, 595);
check("BMW dealer-fee ceiling is $595",        dealerFeeCeiling("BMW")?.amount, 595);
check("Buick dealer-fee ceiling is $699",      dealerFeeCeiling("Buick")?.amount, 699);
check("Cadillac dealer-fee ceiling is $699",   dealerFeeCeiling("Cadillac")?.amount, 699);
// Held list cleared (2026-08-26): Volvo/Infiniti/Mitsubishi verified verbatim via
// exa fetch; GMC by GM corporate-disclaimer deduction (Akamai-blocked directly).
check("Volvo dealer-fee ceiling is $699",      dealerFeeCeiling("Volvo")?.amount, 699);
check("Infiniti dealer-fee ceiling is $921 (premium, not Nissan's $621)", dealerFeeCeiling("Infiniti")?.amount, 921);
check("Mitsubishi dealer-fee ceiling is $799", dealerFeeCeiling("Mitsubishi")?.amount, 799);
check("GMC dealer-fee ceiling is $699",        dealerFeeCeiling("GMC")?.amount, 699);
ok("ceilings are national — Hyundai resolves in ON as well as AB", dealerFeeCeiling("Hyundai", "ON")?.amount === 799);
check("Ford publishes no ceiling -> null (confirmed, not a gap)", dealerFeeCeiling("Ford"), null);
ok("make/model lookups are case-insensitive", freightFor("toyota", "rav4")?.amount === 1930);

// ── THE load-bearing identity: Toyota RAV4 financed = $3,078 of adds ─────────
// Exactly the six components Toyota itemises (proven to the dollar 2026-08-15).
const rav4Adds =
  (freightFor("Toyota", "RAV4")?.amount ?? 0) +
  (dealerFeeCeiling("Toyota", "AB")?.amount ?? 0) +
  (feeAmount("AB", "ac_charge") ?? 0) +
  (feeAmount("AB", "tire_levy") ?? 0) +
  (feeAmount("AB", "ppsa_fee", { financed: true }) ?? 0) +
  (feeAmount("AB", "amvic") ?? 0);
check("Toyota RAV4 financed adds reproduce the proven $3,078", rav4Adds, 3078);

// ── Dealer-fee-vs-ceiling: backed, neutral, fail-safe ───────────────────────
check("Lexus $1,295 admin fee is $300 over the $995 published max",
  assessDealerFeeVsCeiling("Lexus", "AB", 1295),
  { ceiling: 995, observed: 1295, over: true, overBy: 300, source: "Lexus Canada Build & Price — 2026 ES 350h (Alberta)", capturedOn: "2026-08-25" });
ok("a fee at the ceiling is not flagged over", assessDealerFeeVsCeiling("Toyota", "AB", 999)?.over === false);
ok("Hyundai $1,000 admin fee is $201 over the $799 max", assessDealerFeeVsCeiling("Hyundai", "AB", 1000)?.overBy === 201);
ok("Chevrolet $500 is under the $699 max -> not flagged (GM's $350 default is fine)", assessDealerFeeVsCeiling("Chevrolet", "AB", 500)?.over === false);
check("no ceiling for the make -> no claim (fail-safe)", assessDealerFeeVsCeiling("Honda", "AB", 1500), null);

// ── No fabrication: an uncaptured brand/model returns null, never a guess ────
check("uncaptured freight is null, not invented", freightFor("Honda", "Civic"), null);
check("uncaptured ceiling is null, not invented", dealerFeeCeiling("Honda", "AB"), null);
ok("hasBrandFees is true for a captured make",   hasBrandFees("Lexus") === true);
ok("hasBrandFees is false for an uncaptured make", hasBrandFees("Honda") === false);

// ── explainAllIn: an estimate that NEVER claims to be authoritative ─────────
const ex = explainAllIn({ make: "Lexus", model: "ES", region: "AB", financed: true, msrp: 59900 });
ok("explainAllIn is never authoritative", ex.authoritative === false);
ok("explainAllIn itemises freight + ceiling + gov fees", ex.items.some((i) => i.component === "freight") && ex.items.some((i) => i.component === "dealer_fee_ceiling"));
ok("explainAllIn estimate sits above MSRP", (ex.allInEstimate ?? 0) > 59900);

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
