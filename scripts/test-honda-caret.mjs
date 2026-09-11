// GATE: the caret workaround must stay where it works, and a refusal must stay loud.
//
// WHAT HAPPENED. An Azure Application Gateway WAF rule 403s any request whose
// body contains a "^" byte. Honda's own default interior colour keys look like
// "bkblack_fabric_^2020_crv", so 49 of Honda's 55 trims and 14 of Acura's 14
// were refused at the gateway from 2026-08-21 onward. Rate rows dedupe on
// `model|term`, so the four surviving Honda models produced 20 finance rows
// against 60 held and 16 lease against 48 — exactly one third on two tables,
// which looked like a coincidence and was not: it is one per-trim loop split by
// PaymentMethod, both deduping to a model-level key. The collapse guard refused
// both writes, correctly, for three weeks.
//
// WHY THIS GATE EXISTS RATHER THAN A GREP. The correct fix and the WRONG fix
// contain the same regex. Only the position differs:
//
//   right: substitute in the request BODY, keep the real key above
//   wrong: substitute where interiorColorKey is READ, twenty lines earlier
//
// The wrong one is silently catastrophic. The line after the read is
// `if (!trimKey || … || !interiorColorKey) continue;` and an empty string is
// falsy, so substituting at the read site makes the loop skip exactly the 63
// trims the fix exists to rescue. Honda would report ok=6 / blocked=0 — no
// errors, no refusals, a clean green run — and the rate tables would collapse
// FURTHER than they did under the WAF block. A source grep cannot tell the two
// apart. Calling the builder can.
//
// Offline. No network, no database.
//
// Run: npm run test:honda-caret

import { readFileSync } from "node:fs";
import { paymentBody } from "./lib/honda-stack.mjs";

const STACK = "scripts/lib/honda-stack.mjs";

let failed = 0;
const fail = (msg, detail) => { failed++; console.error(`FAIL  ${msg}`); if (detail) console.error(`      ${detail}`); };
const pass = (msg) => console.log(`ok    ${msg}`);

const OPTS = [{ ClientRequestId: "f0", PaymentMethod: "Finance", Term: 60 }];
const base = {
  province: "AB", year: 2026, modelKey: "crv", trimKey: "lx2wd",
  transmissionKey: "cvt", exteriorColorKey: "white", paymentOptions: OPTS,
};

// ---- 1. a caret never reaches the wire ------------------------------------
// Real keys taken verbatim from today's Honda and Acura build pages. The caret
// sits in different places in each, so a fix that only handles one shape (say,
// a prefix strip) passes on one and fails on another.
const REAL_CARET_KEYS = [
  "bkblack_fabric_^2020_crv",
  "wzblack_combi__leatherette___fabric__^2021_civic_sedan",
  "bk_a_black_leather^2020_odyssey",                       // caret with no underscore before it
  "bkblack_fabric^2020_ridgeline",
  "kkblack_fabric_with_trailsport_embossed_lettering_^2026_crv",
];
{
  const leaked = REAL_CARET_KEYS.filter((k) => JSON.stringify(paymentBody({ ...base, interiorColorKey: k })).includes("^"));
  if (leaked.length) fail(`${leaked.length} caret key(s) reached the request body`, leaked.join("\n      "));
  else pass(`all ${REAL_CARET_KEYS.length} real caret keys are substituted out of the body`);

  // Belt and braces: the WAF decodes ^, so a body that "escapes" the caret
  // is refused just the same. Assert on the SERIALISED body, which is what is
  // actually sent, not on the property value.
  const wire = JSON.stringify(paymentBody({ ...base, interiorColorKey: REAL_CARET_KEYS[0] }));
  if (wire.includes("\\u005e") || wire.includes("\\u005E")) fail("the caret was escaped rather than removed", "the gateway decodes \\u005e and refuses it identically");
  else pass("no escaped caret on the wire either");
}

// ---- 2. a clean key is passed through UNTOUCHED ---------------------------
// Substituting unconditionally would also "work" — every request would be
// accepted — but it would be a change to every configuration we ask about, on
// makes that never had the problem. Narrow is the point.
{
  const k = "bkblack_fabric_2020_crv";
  const got = paymentBody({ ...base, interiorColorKey: k }).InteriorColorKey;
  if (got !== k) fail(`a caret-free key was altered: sent ${JSON.stringify(got)} instead of ${JSON.stringify(k)}`,
    "the workaround must apply only to keys that would actually be refused");
  else pass("a caret-free key is sent unchanged");
}

// ---- 3. nothing else was collateral ---------------------------------------
// The configuration still has to resolve from Trim + Transmission + Exterior,
// or the response would be for a different vehicle than the one we asked about.
{
  const b = paymentBody({ ...base, interiorColorKey: REAL_CARET_KEYS[0] });
  const wrong = Object.entries({
    ProvinceKey: "AB", ModelYear: 2026, ModelKey: "crv", TrimKey: "lx2wd",
    TransmissionKey: "cvt", ExteriorColorKey: "white",
  }).filter(([k, v]) => b[k] !== v);
  if (wrong.length) fail("the substitution damaged another field", wrong.map(([k]) => k).join(", "));
  else if (b.PaymentOptions !== OPTS) fail("PaymentOptions did not survive the builder");
  else pass("trim, transmission, exterior, province, year and payment options all survive");
}

// ---- 4. THE SKIP TRAP -----------------------------------------------------
// This is the one a grep cannot catch. If the substitution is moved to where
// interiorColorKey is READ, the guard below it drops the trim entirely and the
// scrape gets QUIETER while still exiting 0 — worse than the bug it replaced.
// Assert the guard is still reading the real key, not a substituted one.
{
  const src = readFileSync(STACK, "utf8");
  const guard = /if \(!trimKey \|\| !transmissionKey \|\| !exteriorColorKey \|\| !interiorColorKey\) continue;/.test(src);
  if (!guard) fail("the truthiness guard on interiorColorKey is gone or changed",
    "it must keep the REAL key so a trim with genuinely no interior colour is still skipped");
  else pass("the truthiness guard still reads the real key");

  // The read site must not itself substitute. Everything between the read and
  // the guard has to be caret-free of any ternary on interiorColorKey.
  const readIdx = src.indexOf("const interiorColorKey = get(");
  const guardIdx = src.indexOf("|| !interiorColorKey) continue;");
  if (readIdx < 0 || guardIdx < 0) fail("could not locate the read site and the guard in honda-stack.mjs");
  else if (/\^/.test(src.slice(readIdx, guardIdx))) {
    fail("the caret substitution was moved to the READ site",
      "an empty string is falsy, so the guard below now skips the 63 trims this fix exists to rescue. " +
      "Substitute in the request body instead — see paymentBody().");
  } else pass("the read site is clean; substitution happens in the body");
}

// ---- 5. a refusal must not exit 0 -----------------------------------------
// Part two of the fix, and the part that closes the class. The catch around the
// payment POST turned 49 gateway refusals into 49 log lines and let the scrape
// exit 0 holding a third of the data, leaning on the downstream collapse guard
// to notice. It did notice — but it could only say "the row count halved",
// which reads as a lineup change, not as a network refusal. The scraper is the
// only thing that knows a request was REFUSED rather than answered.
{
  const src = readFileSync(STACK, "utf8");
  const counts = /payRefused\+\+/.test(src);
  const throws = /if \(payRefused\)[\s\S]{0,400}throw new Error\(/.test(src);
  const beforeWrite = src.indexOf("if (payRefused)") < src.indexOf("await writeCatalogs(") && src.indexOf("if (payRefused)") > 0;
  if (!counts) fail("gateway refusals are no longer counted", "a refusal would again be indistinguishable from a lineup change");
  else if (!throws) fail("refusals are counted but no longer throw", "this is the warn-not-refuse shape in repeat-fix-pattern");
  else if (!beforeWrite) fail("the refusal check runs AFTER writeCatalogs", "partial rates would already be written by then");
  else pass("a refused request counts, and refuses to write, before writeCatalogs");
}

console.log("");
if (failed) { console.error(`${failed} check(s) failed.`); process.exitCode = 1; }
else console.log("honda/acura caret workaround: in the body, narrow, and loud on refusal.");
