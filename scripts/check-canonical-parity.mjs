// canonicalReport() exists TWICE and the two copies must project the same shape.
//
// The SERVER copy is the one that gets signed: analyze-* stamps the id, builds
// the payload and signs it, and finalizeReport() on the client returns that
// verbatim (`if(analysis?.verifyPayload && analysis?.reportId) return analysis`).
// The CLIENT copy is the fallback used only when the server did not finalize --
// older responses and local demos -- and that path is explicitly unsigned.
//
// So drift does NOT break signature verification, and this gate does not claim
// it does. What drift actually costs is quieter: a field on one copy only is
// either MISSING FROM THE SIGNED RECORD -- computed, shown in the report, and
// absent from the thing a buyer can prove -- or invented by the unsigned
// fallback, so the same analysis yields two different report ids.
//
// Not hypothetical. This gate found `fcx` and `source` live on main. 4e3a733
// ("Flag when the advertised price depends on financing with the dealer") added
// them to the client copy and never touched report-sign.ts. The server COMPUTED
// financeContingent the whole time and simply never projected it, so the
// finance-contingent flag -- a dealer tactic this product exists to surface --
// could not appear on /verify for any signed report. That is the same defect
// the v2 bump existed to fix, two fields further down.
//
// JSON.stringify emits insertion order, so KEY NAMES AND ORDER both matter.
// report-sign.ts says it "Mirrors the client's canonicalReport()" and, until
// this gate, that sentence was the entire enforcement mechanism.
//
// Note what this does NOT check: the VALUES. Two copies can agree on shape and
// still disagree on how a field is computed. Shape drift is the failure that is
// both silent and total, so it is the one worth a gate.
//
// Run: node scripts/check-canonical-parity.mjs
import { readFileSync } from "node:fs";

const SOURCES = [
  { label: "server", file: "supabase/functions/_shared/report-sign.ts" },
  { label: "client", file: "src/App.jsx" },
];

// Walk the object literal returned by canonicalReport and collect its top-level
// keys in order. Brace-depth aware, and skips strings, template literals and
// comments so a colon or brace inside one cannot be mistaken for structure.
function topLevelKeys(src, file) {
  const at = src.indexOf("function canonicalReport");
  if (at < 0) throw new Error(`${file}: no canonicalReport() found`);
  const open = src.indexOf("{", src.indexOf("return", at));
  if (open < 0) throw new Error(`${file}: canonicalReport() has no returned object`);

  const keys = [];
  let depth = 0, i = open, token = "";
  while (i < src.length) {
    const c = src[i], next = src[i + 1];

    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i) + 2; continue; }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c; i++;
      while (i < src.length && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
      i++; token = ""; continue;
    }

    if (c === "{" || c === "[" || c === "(") { depth++; i++; token = ""; continue; }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) break;
      i++; token = ""; continue;
    }

    if (c === ":" && depth === 1) {
      const k = token.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
      token = ""; i++; continue;
    }
    if (c === ",") { token = ""; i++; continue; }

    token += c;
    i++;
  }
  if (!keys.length) throw new Error(`${file}: parsed 0 keys -- the shape moved and this gate went blind`);
  return keys;
}

let shapes;
try {
  shapes = SOURCES.map((s) => ({ ...s, keys: topLevelKeys(readFileSync(s.file, "utf8"), s.file) }));
} catch (e) {
  console.error(`canonical-parity: ${e.message}`);
  process.exit(1);
}

const [server, client] = shapes;
const same = server.keys.length === client.keys.length &&
             server.keys.every((k, i) => k === client.keys[i]);

if (same) {
  console.log(`canonical-parity: both copies project the same ${server.keys.length} keys in the same order.`);
  console.log(`   ${server.keys.join(", ")}`);
  if (!shareLinkCarriesEverything()) process.exit(1);
  process.exit(0);
}

// ── THE SHARE LINK IS A THIRD COPY, AND NOTHING WAS POLICING IT ──────────────
//
// A `#r=` link ships TWO representations of one report: `vp`, the complete
// signed canonical the banner verifies, and a hand-maintained compact
// projection that the page actually RENDERS from. The gate above keeps the two
// canonicalReport copies honest with each other and never looked at the third.
//
// It had drifted badly. Eight fields the canonical carries were absent from the
// encoder — vin, odometer, market value, capture provenance, financing math,
// add-on reasons — so a forwarded report contradicted the very payload its own
// "verified" banner had just checked. Two of those absences INVERTED a safety
// rule: `recalls.confirmed` was not carried and the decoder rebuilt the object
// without it, so an UNCONFIRMED recall match forwarded as CONFIRMED; and the
// detail list was capped at six while the count was not, reviving a defect
// fixed on 2026-08-20 on a surface that fix never reached.
//
// This compares the analysis fields canonicalReport READS against the fields
// encodeReport reads. It is deliberately a READ comparison, not a key
// comparison: the two use different key names by design (the share encoder is
// compact on purpose), but they must draw on the same source facts.
function shareLinkCarriesEverything() {
  const appSrc = readFileSync("src/App.jsx", "utf8");
  const bodyOf = (name) => {
    const at = appSrc.indexOf(`function ${name}`);
    if (at < 0) throw new Error(`src/App.jsx: no ${name}() found`);
    const end = appSrc.indexOf("\nfunction ", at + 1);
    return appSrc.slice(at, end < 0 ? appSrc.length : end);
  };
  const reads = (body) => new Set([...body.matchAll(/\ba\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

  let canonical, encoder;
  try { canonical = reads(bodyOf("canonicalReport")); encoder = reads(bodyOf("encodeReport")); }
  catch (e) { console.error(`canonical-parity: ${e.message}`); return false; }

  // Fields the canonical reads that the share link legitimately need not carry.
  // Each needs a REASON, not just an entry.
  const EXEMPT = new Map([
    ["listingShot",   "the capture image is far too large for a URL fragment; its SHA-256 (`sh`) rides instead"],
    ["verifyPayload", "carried verbatim as `vp` -- it IS the signed canonical, not a projection of it"],
    ["sig",           "carried verbatim as `sg`"],
    ["keyId",         "carried verbatim as `kid`"],
  ]);

  // WHAT THIS DOES NOT CATCH, stated plainly so nobody reads its green line as
  // more than it is: this compares TOP-LEVEL `a.X` reads. A field dropped from
  // INSIDE an object the encoder already touches -- `recalls.confirmed` and
  // `addOns[].reason`, both real omissions found on 2026-08-27 -- still reads
  // as covered, because `a.recalls` and `a.addOns` are present. Those two are
  // pinned by their own cases in test:share-round-trip. A gate that overstates
  // its coverage is exactly how the last one stayed green for weeks.
  const missing = [...canonical].filter((f) => !encoder.has(f) && !EXEMPT.has(f)).sort();
  if (!missing.length) {
    console.log(`canonical-parity: the share encoder reads every one of the ${canonical.size} analysis fields the canonical does.`);
    return true;
  }
  console.error(`\ncanonical-parity: the SHARE LINK drops ${missing.length} field(s) the signed canonical carries.\n`);
  for (const f of missing) console.error(`  x  a.${f}`);
  console.error(`\nA forwarded report renders from the compact projection, NOT from \`vp\` -- so a`);
  console.error(`field missing here is a field the shared copy does not show, while its own banner`);
  console.error(`says the payload verified. Add it to encodeReport AND decodeReport, or add it to`);
  console.error(`EXEMPT in this file with the reason it cannot ride.`);
  return false;
}

process.exit(1);
