// Regression suite for the VALUE report's signing canonical (report-sign.ts).
// Run: node --experimental-strip-types supabase/functions/_shared/value-report.test.ts
//
// Locks two things: (1) canonicalValueReport() projects only what Phase 1 can
// back — the retail-asking band + market CPO premium — under its own additive
// namespace (t:'value', v:1); (2) finalizeServerSide's new canonicalFn param
// leaves the QUOTE path byte-identical when called with the default. Silent
// drift here breaks signatures and /verify, so this must stay green.

import { canonicalValueReport, canonicalReport, finalizeServerSide } from "./report-sign.ts";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };
const idOf = (canon: any): string => {
  const h = createHash("sha256").update(JSON.stringify(canon), "utf8").digest("hex");
  return "LC-" + h.slice(0, 4).toUpperCase() + "-" + h.slice(4, 7).toUpperCase();
};

const valueA: any = {
  year: 2022, make: "Honda", model: "Odyssey", trim: "EX-L", odometerKm: 148000,
  saleCondition: "used", province: "ab", vin: "5FNRL6H61NB502518",
  marketValue: {
    average: 30000, below: 28000, above: 32000, low: 27000, high: 34000, mileage: 148000,
    source: "LotCheck market · same trim · 7 comparable listings", comps: 7, asOf: "2026-08-18",
    cpoPremium: { premium: 3000, nonCertifiedMedian: 31000, certifiedMedian: 34000, nNonCertified: 6, nCertified: 3, basis: "same trim" },
  },
};

// ---- shape ----
const c = canonicalValueReport(valueA);
ok("discriminator t === 'value'", c.t === "value");
ok("own additive version v === 1", c.v === 1);
ok("province upper-cased", c.prov === "AB");
ok("band projected (avg/lo/hi/n)", !!c.band && c.band.avg === 30000 && c.band.lo === 27000 && c.band.hi === 34000 && c.band.n === 7);
ok("market CPO premium projected", !!c.cpo && c.cpo.prem === 3000 && c.cpo.base === 31000 && c.cpo.cmed === 34000);
ok("vehicle string composed", c.vehicle === "2022 Honda Odyssey");
ok("NO trade/private tiering is signed (only band + cpo)", !("trade" in c) && !("private" in c) && !("spread" in c));

// ---- determinism (parity) ----
ok("canonical is deterministic", JSON.stringify(canonicalValueReport(valueA)) === JSON.stringify(canonicalValueReport(valueA)));

// ---- null-safety: thin/no coverage never invents a band ----
const thin = canonicalValueReport({ year: 2022, make: "Honda", model: "Civic", province: "BC" });
ok("no marketValue -> band null", thin.band === null);
ok("no cpoPremium -> cpo null", thin.cpo === null);
ok("still tagged as a value report", thin.t === "value");

// ---- finalize dispatches to the value canonical when passed ----
const vCopy: any = JSON.parse(JSON.stringify(valueA));
await finalizeServerSide(vCopy, canonicalValueReport);
ok("value finalize stamps a LC- reportId", typeof vCopy.reportId === "string" && vCopy.reportId.startsWith("LC-"));
ok("value finalize stamps a verifyPayload", typeof vCopy.verifyPayload === "string" && vCopy.verifyPayload.length > 0);
ok("value reportId == sha256 of the VALUE canonical", vCopy.reportId === idOf(canonicalValueReport(vCopy)));
ok("no signing key in test -> unsigned (no sig)", vCopy.sig === undefined);

// ---- REGRESSION: default finalize still uses canonicalReport (quote byte-identical) ----
const quoteA: any = { year: 2023, make: "Toyota", model: "RAV4", quotedPrice: 45000, msrp: 42000, priceVerified: true };
const qCopy: any = JSON.parse(JSON.stringify(quoteA));
await finalizeServerSide(qCopy); // default canonicalFn = canonicalReport
ok("quote finalize reportId == sha256 of the QUOTE canonical (path unchanged)", qCopy.reportId === idOf(canonicalReport(qCopy)));
ok("quote canonical carries NO value discriminator", canonicalReport(qCopy).t === undefined);

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
