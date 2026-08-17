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
  process.exit(0);
}

console.error("canonical-parity: the two canonicalReport() copies have DRIFTED.\n");
console.error(`  ${server.label} (${server.file})`);
console.error(`    ${server.keys.join(", ")}\n`);
console.error(`  ${client.label} (${client.file})`);
console.error(`    ${client.keys.join(", ")}\n`);

const onlyServer = server.keys.filter((k) => !client.keys.includes(k));
const onlyClient = client.keys.filter((k) => !server.keys.includes(k));
if (onlyServer.length) console.error(`  only in ${server.label}: ${onlyServer.join(", ")}`);
if (onlyClient.length) console.error(`  only in ${client.label}: ${onlyClient.join(", ")}`);
if (!onlyServer.length && !onlyClient.length) {
  console.error(`  same keys, DIFFERENT ORDER -- JSON.stringify emits insertion order, so the bytes differ.`);
}

console.error(`\nThe server copy is what gets SIGNED; the client copy is the unsigned fallback.`);
console.error(`A key on one side only is either missing from the signed record -- computed and`);
console.error(`shown, but absent from what a buyer can prove -- or invented by the fallback, so`);
console.error(`the same analysis yields two different report ids.`);
console.error(`\nFix by projecting the same keys in the same order on both, and bump v.`);
process.exit(1);
