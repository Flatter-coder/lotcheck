#!/usr/bin/env node
// A KEY CHECK MAY ONLY PROBE AN ENDPOINT THE PRODUCT ACTUALLY CALLS.
//
// WHY THIS GATE EXISTS. key-health shipped on 2026-08-31 to stop a dead API key
// going unnoticed. On its first two runs it reported FOUR working credentials as
// REJECTED, because each probe called a plausible endpoint instead of the real
// one:
//
//   Nimble    probed api.webit.live with Basic auth;
//             analyze-listing-url calls sdk.nimbleway.com with Bearer.
//   Google    probed the LEGACY maps.googleapis.com Places endpoint;
//             get-dealer-sentiment uses places.googleapis.com (Places API New).
//             Google replied "you are calling a legacy API, which is not
//             enabled for your project" -- true about the probe, false about
//             the key.
//   Supabase  probed /rest/v1/ root, then a POST to a table. BOTH answer 401 to
//   anon      a perfectly good anon key -- confirmed against the key shipped in
//             App.jsx that serves real customers.
//
// Four false accusations from the tool built to prevent one. A comment saying
// "probe what the product calls" is not a fix; the mechanism has to make the
// drift impossible to ship. [[fix-means-structural-fix]]
//
// WHAT IT CHECKS. Every external host key-health probes must also appear in the
// edge function that actually uses that key. A probe pointing somewhere the
// product never calls fails the build.
//
// It cannot verify the auth SCHEME or the path -- those still need care -- but
// it catches the whole-cloth wrong-vendor-endpoint mistake, which is three of
// the four above.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const KEY_HEALTH = "supabase/functions/key-health/index.ts";
const FUNCTIONS_DIR = "supabase/functions";

// Which function is the real caller for each key. If a key is added to
// key-health without a line here, the gate fails: an unmapped probe is one
// nobody has checked against a call site.
const OWNER = {
  SCRAPFLY_API_KEY: ["_shared/scrapfly.ts", "render-page/index.ts"],
  ANTHROPIC_API_KEY: ["analyze-listing-url/index.ts", "analyze-quote/index.ts", "get-dealer-sentiment/index.ts"],
  RESEND_API_KEY: ["email-quote-report/index.ts"],
  NIMBLE_API_KEY: ["analyze-listing-url/index.ts"],
  GOOGLE_PLACES_API_KEY: ["get-dealer-sentiment/index.ts"],
  // Supabase's own host comes from SUPABASE_URL at runtime, so there is no
  // literal host to compare. Exempt, and named here so the exemption is a
  // decision on the record rather than a silent gap.
  SUPABASE_SERVICE_ROLE_KEY: null,
  SUPABASE_ANON_KEY: null,
};

const src = readFileSync(KEY_HEALTH, "utf8");

/** Every check("KEY", ...) block, with the external hosts it fetches. */
function probes(text) {
  const out = [];
  const re = /check\(\s*"([A-Z0-9_]+)"/g;
  let m;
  const starts = [];
  while ((m = re.exec(text))) starts.push({ key: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const body = text.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : text.length);
    const hosts = new Set();
    for (const h of body.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(h[1].toLowerCase());
    out.push({ key: starts[i].key, hosts: [...hosts] });
  }
  return out;
}

function allFunctionSources() {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(e) && !p.includes("key-health")) files.push(p);
    }
  };
  walk(FUNCTIONS_DIR);
  return files;
}

const sources = allFunctionSources().map((f) => ({ f, text: readFileSync(f, "utf8") }));
const found = probes(src);
let bad = 0;

console.log("key-health probes vs the endpoints the product actually calls\n");

for (const { key, hosts } of found) {
  if (!(key in OWNER)) {
    console.log(`  FAIL  ${key} — probed, but no owning call site is declared in this gate.`);
    console.log(`        Add it to OWNER, or the probe is unverified by construction.`);
    bad++;
    continue;
  }
  const owners = OWNER[key];
  if (owners === null) {
    console.log(`  ok    ${key} — host comes from SUPABASE_URL at runtime (declared exempt)`);
    continue;
  }
  const ownerText = sources.filter((s) => owners.some((o) => s.f.replace(/\\/g, "/").endsWith(o))).map((s) => s.text).join("\n");
  if (!ownerText) {
    console.log(`  FAIL  ${key} — declared owner(s) ${owners.join(", ")} not found on disk`);
    bad++;
    continue;
  }
  const external = hosts.filter((h) => !h.includes("lotcheck"));
  if (!external.length) {
    console.log(`  FAIL  ${key} — the probe fetches no external host at all`);
    bad++;
    continue;
  }
  for (const h of external) {
    if (ownerText.includes(h)) {
      console.log(`  ok    ${key} — probes ${h}, which ${owners[0]} also calls`);
    } else {
      console.log(`  FAIL  ${key} — probes ${h}, which NONE of ${owners.join(", ")} calls.`);
      console.log(`        A probe against a host the product never uses cannot report on that key.`);
      bad++;
    }
  }
}

// Every key the product reads should BE probed. A key with no probe is the
// silent half of the same problem: it cannot be reported as broken at all.
const probed = new Set(found.map((p) => p.key));
for (const key of Object.keys(OWNER)) {
  if (!probed.has(key)) {
    console.log(`  FAIL  ${key} — declared here but key-health does not probe it`);
    bad++;
  }
}

console.log("");
if (bad) {
  console.error(`key-health-endpoints: ${bad} problem(s). A health check that probes the wrong`);
  console.error("endpoint does not fail safe -- it invents REJECTED verdicts for working keys");
  console.error("and sends someone to rotate credentials that were fine.");
  process.exit(1);
}
console.log(`key-health-endpoints — clean (${found.length} probes, every external host matched to a real call site).`);
