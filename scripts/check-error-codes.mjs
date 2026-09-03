// ERROR-CODE REACHABILITY GATE — every refusal the server can return must have
// a branch in the app that renders it.
//
// WHY THIS EXISTS. `subject_mismatch` was written server-side, with its own
// carefully-worded message explaining that the buyer had not been charged, and
// shipped with NO client branch. The client's 422 handler reads the body once
// into `body`, matches a few known codes, and anything it does not recognise
// fell through to `await res.json()` on an already-consumed stream — which
// throws "body stream already read" and lands in the generic network-error
// path. So the buyer would have seen "Something went wrong" instead of the
// message that tells them what happened and that their credit is safe.
//
// That is a one-surface fix waiting to happen every time anyone adds a code,
// and it is not something a human reviewer reliably catches: the server change
// looks complete on its own. This makes it mechanical.
//
// The check is deliberately loose about HOW the client handles a code — an
// explicit branch, a lookup table, a message map all pass — because pinning the
// shape would just make the gate brittle. What it refuses is a code that
// appears nowhere in the client at all.
//
// Run: node scripts/check-error-codes.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// The functions the browser app calls directly. A code returned by a function
// the app never calls has no client to reach.
const SERVERS = [
  "supabase/functions/analyze-listing-url/index.ts",
  "supabase/functions/analyze-quote/index.ts",
];
const CLIENTS = ["src/App.jsx"];

// Codes the client is not expected to special-case: they are handled by status
// alone, or they are internal. Each needs a reason, so the exemption list
// cannot quietly become the answer to a failing gate.
const EXEMPT = new Map([
  // (none today — every code the two functions return is rendered)
]);

const clientSrc = CLIENTS.map(read).join("\n");

const found = new Map();
for (const f of SERVERS) {
  const src = read(f);
  for (const m of src.matchAll(/\berror:\s*"([a-z0-9_]+)"/g)) {
    if (!found.has(m[1])) found.set(m[1], []);
    found.get(m[1]).push(f);
  }
}

const failures = [];
for (const [code, files] of found) {
  if (EXEMPT.has(code)) continue;
  if (!clientSrc.includes(`"${code}"`)) {
    failures.push(
      `${code} — returned by ${[...new Set(files)].join(", ")} but appears nowhere in ${CLIENTS.join(", ")}.\n` +
      `      The buyer would see a generic failure instead of the message written for them.\n` +
      `      Add a branch (see the 422 handler in src/App.jsx), or add it to EXEMPT here with the reason.`,
    );
  }
}

if (failures.length) {
  console.error("\n❌ error-code reachability:\n");
  for (const f of failures) console.error("  - " + f + "\n");
  process.exit(1);
}

console.log(`error-code reachability — clean (${found.size} server codes, all rendered by the app).`);
