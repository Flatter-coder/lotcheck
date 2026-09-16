// FEE-CEILING PROVENANCE GATE — a brand-wide claim needs brand-wide evidence.
//
// WHY THIS EXISTS. On 2026-09-15 a Quote Check report told a 2026 Toyota 4Runner
// buyer that $999 was "Toyota's own published maximum dealer fee". The number was
// right. The RECORD behind it was not: fee-schedule.ts sourced it to
//
//     "Toyota Canada Build & Price — 2026 RAV4 (Alberta)"
//
// a line item on ONE model's configurator. Nothing in that capture says anything
// about a 4Runner, and nothing in it says "maximum" — the report was making a
// brand-wide claim off single-model evidence. Chasing it to Toyota Canada's own
// regional storefronts settled the figure ($999 in the Prairies and Ontario) and
// turned up something the old row could not have known: British Columbia & Yukon
// publish $990. A BC listing at $995 would have been told, in writing, that it
// was at "Toyota's published maximum" of $999. It is not, there.
//
// WHAT THIS CHECKS, offline and deterministically, over the catalog itself:
//
//   1. Every brand-scope ceiling row declares `provenance`.
//   2. A row claiming `provenance: "policy"` must QUOTE the brand's own policy
//      wording in `source` — "up to $X", "$0 to $X", "range ... $X" — and the
//      dollar figure inside that quote must equal the row's own `amount`. A
//      policy claim that cannot show the sentence is not a policy claim, and a
//      quote whose number disagrees with the row is a transcription error.
//   3. `provenance: "single-model"` rows are REPORTED, not failed. They are real
//      figures we may flag a fee above; they are simply not evidence of a
//      brand-wide maximum, and callers must not describe them as one. The gate
//      keeps the list visible so it shrinks instead of settling in.
//   4. Region-qualified rows must resolve ahead of the national row for their own
//      province, whatever order the catalog is written in.
//
// WHAT IT CANNOT SEE: whether the quoted sentence is still on the brand's site
// today. That is a live-source job (the twice-daily catalogue refresh), not an
// offline gate. This closes the class that shipped: a claim stronger than the
// record that backs it.
//
// Run:  npm run check:fee-ceiling-provenance
import { readFileSync } from "node:fs";

const FILE = "supabase/functions/_shared/fee-schedule.ts";
const src = readFileSync(FILE, "utf8");

// Pull the DEALER_FEE_CEILING array, then one row per `{ component: ... }`.
const start = src.indexOf("const DEALER_FEE_CEILING: Fee[] = [");
if (start < 0) {
  console.error("check:fee-ceiling-provenance: DEALER_FEE_CEILING not found in " + FILE);
  console.error("The catalog moved or was renamed. This gate reads it by name; fix the name here.");
  process.exit(1);
}
// NOTE the offset: the declaration itself contains `Fee[]`, so scanning from
// the first "[" after `start` brace-matches an empty pair and reads nothing.
// The blindness guard below caught exactly that on this gate's first run.
let i = src.indexOf("= [", start) + 2, depth = 0, end = i;
for (; end < src.length; end++) {
  if (src[end] === "[") depth++;
  else if (src[end] === "]") { depth--; if (depth === 0) break; }
}
const block = src.slice(i, end + 1);

const rows = [];
for (const m of block.matchAll(/\{\s*component:\s*"dealer_fee_ceiling"[\s\S]*?\},\s*(?=\n)/g)) {
  const t = m[0];
  // Built by concatenation, NOT a template literal. Inside a template literal
  // `\s` is a JS string escape and collapses to a bare "s", so the character
  // class reached RegExp as [s,{] and threw "Unterminated character class".
  const field = (k) => {
    const s = t.match(new RegExp("(?:^|[\\s,{])" + k + ':\\s*"((?:\\\\.|[^"\\\\])*)"'));
    return s ? s[1].replace(/\\"/g, '"') : null;
  };
  const amount = Number((t.match(/(?:^|[\s,{])amount:\s*(-?\d+(?:\.\d+)?)/) || [])[1]);
  rows.push({ make: field("make"), region: field("region"), amount, source: field("source") || "", provenance: field("provenance"), note: field("note") || "" });
}

// A blindness guard, the same one check:lineage carries: a regex that silently
// stops matching must fail loudly, not report the catalog clean.
const MIN_ROWS = 12;
if (rows.length < MIN_ROWS) {
  console.error(`check:fee-ceiling-provenance: parsed only ${rows.length} ceiling row(s); expected at least ${MIN_ROWS}.`);
  console.error(`The row regex has stopped matching the catalog. A gate that reads nothing passes everything.`);
  process.exit(1);
}

const failures = [];
const singleModel = [];

for (const r of rows) {
  const who = `${r.make}${r.region ? ` (${r.region})` : ""} $${r.amount}`;
  if (!r.provenance) {
    failures.push(
      `${who}: no \`provenance\`.\n` +
      `    Say how the figure is evidenced: "policy" (the brand's own "up to $X"\n` +
      `    wording, quoted in \`source\`) or "single-model" (one model's build sheet).`,
    );
    continue;
  }
  if (r.provenance === "single-model") {
    // A single-model row is allowed, but it must say whether anyone has LOOKED
    // for the brand-level wording. Without that the printed list is
    // indistinguishable from a backlog nobody has touched, and it stops being
    // read. "Checked <date>: ..." in the note turns an open question into an
    // answered one.
    if (!/checked\s+\d{4}-\d{2}-\d{2}/i.test(r.note)) {
      failures.push(
        `${who}: provenance "single-model" with no record of looking for the brand-level source.\n` +
        `    Add "Checked <YYYY-MM-DD>: ..." to the note saying what you found — including\n` +
        `    finding nothing, which is an answer. Lexus's note is the worked example.`,
      );
      continue;
    }
    singleModel.push(`${who} — ${r.source.slice(0, 80)}\n       ${r.note.replace(/\s+/g, " ").slice(0, 320)}`);
    continue;
  }
  if (r.provenance !== "policy") {
    failures.push(`${who}: unknown provenance "${r.provenance}" (expected "policy" or "single-model").`);
    continue;
  }

  // A policy row has to show the sentence. Find every dollar figure that appears
  // in a policy construction, and require the row's own amount among them.
  const quoted = [...r.source.matchAll(/(?:up to|to|range[^$]{0,20})\s*\$\s*([\d,]+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  if (!quoted.length) {
    failures.push(
      `${who}: claims provenance "policy" but \`source\` quotes no policy wording.\n` +
      `    source: ${r.source.slice(0, 140)}\n` +
      `    A policy row must carry the brand's own sentence verbatim — "dealer fees of\n` +
      `    up to $X", "which range $0 to $X". Without it this is a single-model figure\n` +
      `    wearing a brand-wide label, which is exactly what shipped on 2026-09-15.`,
    );
    continue;
  }
  if (!quoted.includes(r.amount)) {
    failures.push(
      `${who}: the quoted policy figure(s) ${quoted.map((n) => "$" + n).join(", ")} do not include the row's amount $${r.amount}.\n` +
      `    source: ${r.source.slice(0, 140)}\n` +
      `    The catalog and the sentence behind it must agree to the dollar.`,
    );
  }
}

// Region rows must win for their own province regardless of catalog order.
const byMake = new Map();
for (const r of rows) {
  if (!byMake.has(r.make)) byMake.set(r.make, []);
  byMake.get(r.make).push(r);
}
for (const [make, rs] of byMake) {
  const regional = rs.filter((r) => r.region);
  if (!regional.length) continue;
  const national = rs.find((r) => !r.region);
  for (const r of regional) {
    if (national && rs.indexOf(national) < rs.indexOf(r) && !/forMake\.find\(\(f\) => f\.region === r\)/.test(src)) {
      failures.push(
        `${make}: the ${r.region} row ($${r.amount}) is written after the national row ($${national.amount}),\n` +
        `    and dealerFeeCeiling no longer prefers an exact region match. A ${r.region} reader\n` +
        `    would be shown another province's figure as their own.`,
      );
    }
  }
}

if (failures.length) {
  console.error(`check:fee-ceiling-provenance: ${failures.length} ceiling row(s) claim more than the record shows.\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(`check:fee-ceiling-provenance: ${rows.length} ceiling rows, ${rows.length - singleModel.length} backed by the brand's own quoted policy wording.`);
if (singleModel.length) {
  console.log(`\n   ${singleModel.length} row(s) still evidenced by ONE model's build sheet. Real figures —`);
  console.log(`   safe to flag a fee above them — but NOT evidence of a brand-wide maximum,`);
  console.log(`   so no caller may call them "<Make>'s own published maximum":`);
  for (const s of singleModel) console.log(`     ${s}`);
}
process.exit(0);
