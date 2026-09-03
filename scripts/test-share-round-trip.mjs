// A forwarded report must not say something different from the original.
//
// THE DEFECT THIS LOCKS (2026-08-27). A `#r=` share link ships TWO
// representations of one report: `vp`, the complete signed canonical that the
// "verified" banner checks, and a compact projection that the page actually
// RENDERS from. Nothing kept the second honest against the first, and two of
// its omissions inverted a safety rule:
//
//   * `recalls.confirmed` was never carried, and the decoder rebuilt the object
//     without it — while canonicalReport reads `confirmed: a.recalls.confirmed
//     !== false`. So an UNCONFIRMED recall match forwarded as CONFIRMED. The
//     shared copy made a FIRMER claim about the vehicle than the original did,
//     on the very link a buyer sends to a dealer. [[make-recalls-fail-safe]]
//
//   * the detail list was capped at 6 while the count was uncapped, so a
//     9-recall report forwarded as "9 open recalls" showing 6 — the exact
//     defect fixed on 2026-08-20, recurring on a surface that fix never
//     reached. [[recalls-detail-list-must-match-count]]
//
// check:canonical compares TOP-LEVEL `a.X` reads and structurally cannot see
// either of these, because `a.recalls` and `a.addOns` are both present. This
// file is the part that can.
//
// encodeReport/decodeReport live inside a 13,000-line JSX module, so they are
// extracted by source range and evaluated — the REAL functions, not a copy of
// their logic that can drift from them.
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`src/App.jsx: no ${name}()`);
  const end = src.indexOf("\nfunction ", at + 1);
  return src.slice(at, end < 0 ? src.length : end);
}
const constAt = (name) => {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
  if (!m) throw new Error(`src/App.jsx: no const ${name}`);
  return `const ${name} = ${m[1]};\n`;
};

// btoa/atob exist in node 16+; the encoder also uses escape/unescape, which are
// still standard-library globals in node.
const mod = new Function(
  constAt("RECALL_SHARE_MAX") +
  extract("encodeReport") + "\n" + extract("decodeReport") + "\n" +
  "return { encodeReport, decodeReport };",
)();
const { encodeReport, decodeReport } = mod;

const base = {
  vehicle: "2026 Lexus NX 350h Premium Hybrid AWD", year: 2026, make: "Lexus", model: "NX 350h",
  trim: "350h Premium Hybrid AWD", dealerName: "A Dealer", dealerCity: "Edmonton",
  vehicleCondition: "new", quotedPrice: 62005, msrp: 58675,
  vin: "2T2GKCEZ8TC072832", odometerKm: 5,
  sourceUrl: "https://example.invalid/vehicles/2026/lexus/nx/70080163/",
  capturedAt: "2026-08-27T04:00:00.000Z",
  marketValue: { low: 57000, high: 63000, note: "band", source: "LotCheck comps" },
  financingCheck: { reconciles: false, note: "payment does not reconcile at the stated rate" },
  addOns: [{ name: "Protection package", price: 1995, flagged: true, reason: "not itemised on the quote" }],
  summary: "s",
};

console.log("\nthe fields that were silently dropped");
{
  const r = decodeReport(encodeReport(base));
  check("VIN survives a forward", r?.vin === base.vin, `got ${r?.vin}`);
  check("odometer survives", Number(r?.odometerKm) === 5, `got ${r?.odometerKm}`);
  check("market value survives", Number(r?.marketValue?.low) === 57000 && Number(r?.marketValue?.high) === 63000);
  check("capture provenance survives", r?.sourceUrl === base.sourceUrl && r?.capturedAt === base.capturedAt);
  check("the financing-math result survives", r?.financingCheck?.reconciles === false);
  check("an add-on keeps the REASON it was flagged",
    r?.addOns?.[0]?.reason === "not itemised on the quote",
    "a flag with nothing behind it is a bare accusation");
}

console.log("\na forwarded report must never get MORE confident");
{
  const unconfirmed = { ...base, recalls: { checked: true, confirmed: false, count: 2, items: [{ system: "Brakes", date: "2026-01-01" }, { system: "Airbag", date: "2026-02-01" }] } };
  const r = decodeReport(encodeReport(unconfirmed));
  check("an UNCONFIRMED recall match stays unconfirmed",
    r?.recalls?.confirmed === false,
    `got confirmed=${r?.recalls?.confirmed} — this used to forward as CONFIRMED`);
}
{
  const confirmed = { ...base, recalls: { checked: true, confirmed: true, count: 1, items: [{ system: "Brakes", date: "2026-01-01" }] } };
  const r = decodeReport(encodeReport(confirmed));
  check("a CONFIRMED match still forwards as confirmed", r?.recalls?.confirmed === true);
}
{
  // A legacy link written before `cf` existed carries no confirmation flag.
  // It must land on the cautious side.
  const legacy = JSON.parse(JSON.stringify({ rc: { n: 3, it: [{ s: "Brakes", d: "2026-01-01" }] }, v: "x", sm: "s" }));
  const enc = Buffer.from(JSON.stringify(legacy), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = decodeReport(enc);
  check("a legacy link with no flag decodes as NOT confirmed",
    r?.recalls?.confirmed === false,
    "missing information must land on the cautious side of a claim about a vehicle");
}

console.log("\nthe count can never outrun the list");
{
  const items = Array.from({ length: 9 }, (_, i) => ({ system: `System ${i + 1}`, date: "2026-01-01" }));
  const nine = { ...base, recalls: { checked: true, confirmed: true, count: 9, items } };
  const r = decodeReport(encodeReport(nine));
  check("all 9 recall details survive a forward",
    r?.recalls?.items?.length === 9,
    `got ${r?.recalls?.items?.length} details for a count of ${r?.recalls?.count} — the 2026-08-20 defect`);
  check("count and detail list agree", r?.recalls?.count === r?.recalls?.items?.length);
  check("nothing is marked truncated when nothing was", r?.recalls?.detailsTruncated === false);
}
{
  // Past the bound, the link must SAY it truncated rather than quietly shipping
  // a count its own list cannot support.
  const many = Array.from({ length: 40 }, (_, i) => ({ system: `System ${i + 1}`, date: "2026-01-01" }));
  const r = decodeReport(encodeReport({ ...base, recalls: { checked: true, confirmed: true, count: 40, items: many } }));
  check("beyond the bound the truncation is DECLARED", r?.recalls?.detailsTruncated === true);
  check("the details that do ride are intact", r?.recalls?.items?.length > 0 && r.recalls.items.length < 40);
}

console.log("\nthe round trip itself still works");
{
  const r = decodeReport(encodeReport(base));
  check("core identity survives", r?.year === 2026 && r?.make === "Lexus" && r?.quotedPrice === 62005);
  check("the shared marker is set", r?.__shared === true);
  check("garbage decodes to null, never a partial report", decodeReport("!!!not-base64!!!") === null);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
