// GATE: no surface may subtract an MSRP from an asking price by hand.
//
// AN OVER/UNDER FIGURE IS A CLAIM. It requires the right reference (an all-in
// advertised price must be measured against the manufacturer's ALL-IN figure,
// never the ex-freight one), a recorded price_basis on both sides, and a
// verified price. qualifyMsrpClaim owns all three and returns the delta. Its
// own type says so: "Signed delta (asking - reference) when comparable, else
// null. NEVER recompute this."
//
// WHY A GATE AND NOT A CONVENTION. This subtraction has had FOUR authors.
//
//   2026-08-15  a signed report printed "+$3,164 OVER MSRP" on a car nobody had
//               marked up. About $3,000 of it was Toyota's own freight and
//               Alberta's own levies, which sit INSIDE an advertised price by
//               law (AMVIC).
//   13o         removed it from the hero band, the on-screen gap bar and
//               counter-script move S14, and the changelog said "on ANY
//               surface".
//   2026-09-22  it was still in msrp-authority.js (PR #513) AND in the PDF --
//               the page-1 range bar and the "Price vs MSRP" prose -- gated on
//               `msrpBasis === "exact"` alone. Exact means we found the right
//               ROW; it says nothing about whether the two figures are measured
//               the same way. The on-screen report refused the comparison while
//               the PDF drew it, and the PDF is the artifact that gets
//               forwarded to the dealer.
//
// Measured on the same inputs, the PDF printed "+$3,164 OVER" where the gate
// returned -$29 -- a $3,193 swing that flips the sign of the headline figure.
//
// A convention did not hold for five weeks across three fixes. This does.
//
// Run: node scripts/test-no-raw-msrp-delta.mjs
import { readFileSync } from "node:fs";

// Files that RENDER a figure to a buyer. A raw subtraction here becomes a
// sentence in a signed report, so it must not appear at all — these surfaces
// take their delta from the gate.
const SURFACES = [
  "supabase/functions/email-quote-report/index.ts",
  "supabase/functions/_shared/report-bands.js",
  "supabase/functions/_shared/before-you-sign.ts",
];

// Files that MAY subtract, but only inside a comparability check.
//
// Banning the arithmetic outright here would be the wrong guard: deal.ts has to
// state a dollar figure in counter-script move S14, and msrp-authority.js has to
// compute `overBy` for a genuine padded sticker. What must never happen is the
// subtraction running WITHOUT a basis check — which is exactly how the PDF
// behaved, and how msrp-authority behaved until PR #513.
//
// So: the subtraction is allowed, and the guard is asserted to be right above
// it. Excluding these files instead would let the guard be deleted with this
// gate still green — the shape this whole suite exists to prevent.
const GUARDED = [
  { file: "supabase/functions/_shared/deal.ts", guard: /referenceBasis\([^)]*\)\.comparable/ },
  {
    file: "supabase/functions/_shared/msrp-authority.js",
    // Every subtraction here sits below `const comparable = basesComparable(...)`.
    // Naming a local as the guard would be circular on its own, so the two
    // chain assertions below prove (a) `comparable` is the basis check, not an
    // unrelated variable that happens to share the name, and (b) the flag that
    // authorises the published figure cannot be true without it.
    guard: /\bcomparable\b/,
    chains: [
      {
        of: /const comparable\s*=\s*([^;]+);/,
        mustContain: /basesComparable\(/,
        why: "`comparable` must come from the basis check itself",
      },
      {
        of: /const materiallyHigher\s*=\s*([^;]+);/,
        mustContain: /\bcomparable\b/,
        why: "materiallyHigher must require comparability, not just a big gap — a gap alone is what accused a dealer of padding by exactly the freight",
      },
      {
        of: /const overBy\s*=\s*([^;]+);/,
        mustContain: /materiallyHigher/,
        why: "the PUBLISHED figure must be gated, not merely computed near a gate",
      },
    ],
  },
];

// How far above a subtraction its guard may sit. Generous enough for a real
// multi-line condition, tight enough that a guard in an unrelated function
// cannot vouch for it.
const GUARD_WINDOW = 12;

// The one module allowed to do the arithmetic unconditionally: it IS the gate.
const OWNER = "supabase/functions/_shared/msrp-claim.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

/**
 * Strip comments so a described subtraction is not read as a performed one.
 * The history above NAMES the defect in prose; a gate that cannot tell the two
 * apart would fail on its own explanation.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

// asking-minus-msrp, in the shapes it has actually appeared in.
const RAW = [
  /\bqp\s*-\s*ms\b/,
  /\bqp\s*-\s*msrp\b/,
  /quotedPrice\s*\)?\s*-\s*Number\s*\(\s*[a-z]*\.?msrp/i,
  /Number\s*\(\s*[a-z]*\.?quotedPrice\s*\)\s*-\s*Number\s*\(\s*[a-z]*\.?msrp/i,
  /\basking\w*\s*-\s*\w*msrp\b/i,
  /\bstated\s*-\s*Number\s*\(\s*ref\.msrp\s*\)/,
];

for (const f of SURFACES) {
  let src;
  try { src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); }
  catch { check(`${f} exists`, false, "a surface on the list is missing — update the list or restore the file"); continue; }
  const body = code(src);
  const hits = RAW.filter((re) => re.test(body));
  check(`${f} performs no raw asking-minus-MSRP subtraction`, hits.length === 0,
    hits.length ? `matched: ${hits.map(String).join(", ")}` : "");
}

// ---- the guarded files: every subtraction sits inside its check ---------
for (const { file, guard, chains } of GUARDED) {
  let src;
  try { src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8"); }
  catch { check(`${file} exists`, false); continue; }

  check(`${file} still has its comparability guard`, guard.test(code(src)),
    "the guard was removed — the subtraction below it is now unconditional");

  // Where the guard is a named flag, prove the flag still depends on the basis
  // check. Otherwise "guarded by materiallyHigher" is satisfied by a
  // materiallyHigher that checks only the size of the gap — which is the
  // original defect wearing the guard's name.
  for (const chain of (chains || [])) {
    const m = chain.of.exec(code(src));
    check(`${file}: ${String(chain.of).slice(0,44)} is still defined`, !!m);
    if (m) check(`${file}: ${chain.why}`,
      chain.mustContain.test(m[1]), `found: ${m[1].trim().slice(0, 120)}`);
  }
  // Every line that subtracts must have the guard within the preceding window.
  const lines = code(src).split(/\r?\n/);
  const unguarded = [];
  lines.forEach((line, i) => {
    if (!RAW.some((re) => re.test(line))) return;
    const above = lines.slice(Math.max(0, i - GUARD_WINDOW), i + 1).join("\n");
    if (!guard.test(above)) unguarded.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
  check(`${file}: every subtraction sits inside the guard`, unguarded.length === 0,
    unguarded.join("\n       "));
}

// ---- the owner must still be able to do it ------------------------------
// A gate that bans the arithmetic everywhere, including where it belongs, would
// be switched off the first time someone needed it.
const owner = readFileSync(new URL(`../${OWNER}`, import.meta.url), "utf8");
check("the owning module is NOT on the banned list", !SURFACES.includes(OWNER));
check("the owning module still computes a delta", /delta/.test(owner));

// ---- the gate must be able to fail --------------------------------------
// Each pattern is proved against a string it must catch, so a regex that stops
// matching anything cannot pass silently.
const MUST_CATCH = [
  "const delta = qp && ms ? qp - ms : 0;",
  "const delta = (qp && ms) ? qp - ms : 0;",
  "const d = Number(a.quotedPrice) - Number(a.msrp);",
  "const gap = askingPrice - catalogMsrp;",
  "stated - Number(ref.msrp) > 800",
];
for (const s of MUST_CATCH) {
  check(`the patterns catch: ${s.slice(0, 48)}`, RAW.some((re) => re.test(s)));
}

// ---- and must NOT fire on the legitimate shapes -------------------------
const MUST_NOT_CATCH = [
  "const diff = claim.delta !== null ? Math.abs(claim.delta) : 0;",
  "const barDelta = barClaim.comparable ? barClaim.delta : null;",
  "const remaining = msrp - discount;",              // not an asking price
  "// the PDF used to do qp - ms here",              // a comment, stripped anyway
  "const pct = barRef ? Math.abs(barDelta / barRef * 100) : 0;",
];
for (const s of MUST_NOT_CATCH) {
  check(`no false positive on: ${s.slice(0, 48)}`, !RAW.some((re) => re.test(code(s))));
}

// ---- the PDF specifically must consult the gate -------------------------
// Removing the subtraction is not enough: the bar and the prose must ASK.
const pdf = readFileSync(new URL("../supabase/functions/email-quote-report/index.ts", import.meta.url), "utf8");
check("the PDF imports the claim gate", /import \{[^}]*qualifyMsrpClaim/.test(pdf));
check("the page-1 range bar gates on the claim", /barClaim\.comparable/.test(pdf),
  "the bar must not draw when the two figures are not comparable");
check("the range bar rails against the claim's OWN reference",
  /xFor\(barRef\)/.test(pdf),
  "marks drawn against ms while the number comes from the claim would disagree with each other");
check("the 'Price vs MSRP' prose gates on the claim",
  /exact && claim\.comparable/.test(pdf));
// Anchored on the EXACT-but-not-comparable branch, not on "claim.refusal"
// appearing somewhere in the file. The first version of this assertion matched
// the email HTML at two unrelated lines, so deleting the PDF's refusal branch
// left it green — a guard bound to spelling rather than substance, in the gate
// written to stop exactly that.
check("an exact match that cannot be compared prints the reason rather than nothing",
  /exact && claim\.refusal\) return/.test(code(pdf)),
  "an absence is NOTED, never silent: the PDF must print the gate's own sentence");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
