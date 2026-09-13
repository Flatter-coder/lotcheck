// THE TEN POINTS MUST BE THE SAME TEN EVERYWHERE.
//
// We advertise a 10-point verification, so the ten we advertise and the ten we
// deliver have to be one list. They were not: two hand-maintained arrays in
// different files, neither derived from the other, differing by a swap — the
// landing page promised "Negotiation leverage score" (the verdict computed FROM
// the points, never one of them) and never mentioned "Financing APR", which the
// report does deliver.
//
// WHY A STRUCTURAL GATE AND NOT A COPY RULE. check:copy already pins how many
// times the phrase "10-point" appears. A regex occurrence count cannot observe
// an array's length, so that rule stayed green across every commit that grew the
// on-screen grid from 10 tiles to 16 — it was counting the CLAIM, not the thing
// claimed. This gate reads the arrays.
import { readFileSync } from "node:fs";
import { REPORT_POINTS, REPORT_POINT_SHORT, POINT_TITLES } from "../supabase/functions/_shared/report-points.js";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "\n         " + detail : ""}`); }
};
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const uniqInOrder = (arr) => arr.filter((v, i) => arr.indexOf(v) === i);

console.log("\nthe canonical list");
check("exactly ten points", POINT_TITLES.length === 10, `got ${POINT_TITLES.length}`);
check("ten short labels", REPORT_POINT_SHORT.length === 10);
check("no duplicate titles", uniqInOrder(POINT_TITLES).length === 10);
check("no duplicate keys", uniqInOrder(REPORT_POINTS.map((p) => p.key)).length === 10);
check("every point has marketing copy", REPORT_POINTS.every((p) => p.marketing && p.marketing.length > 3));

// ── the on-screen report (src/App.jsx) ─────────────────────────────────────
// Sidebar/Heatmap retired 2026-09-09 (Vic: "lets go with #02, you can remove
// Sidebar/Heatmap") in favour of one glass-console report view. The old
// checks here policed a two-band rail (pointItems/extraItems, a shared
// `sel`-indexed detail panel, a `point:true/false` flag) that no longer
// exists -- replaced with checks against the array the new view actually
// builds (`PG`, the canonical ten) and the separate `extraDefs` array
// ("also checked", never merged into PG).
console.log("\nthe report on screen");
{
  const src = read("src/App.jsx");
  // COMMENTS STRIPPED BEFORE ANY ASSERTION. Three separate checks today have
  // passed or failed on PROSE rather than code: one matched the word `reason`
  // inside `reason: data?.reason`, one matched `reputationChecked()` inside the
  // comment explaining the fix, and the caption rule below failed on a comment
  // QUOTING the very string it forbids. A gate that reads the explanation
  // instead of the code passes when the code is deleted and the comment is not.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  // THE APP NO LONGER BUILDS THE TEN. It renders reportBands(), which derives
  // them from REPORT_POINTS and throws on a count or order mismatch -- so the
  // canonical ten is enforced in the model rather than re-asserted by scraping
  // a title out of each of ten hand-written pushes. What this gate has to check
  // is that the app still goes through the model and has not grown its own
  // second copy, which is the defect the model exists to end.
  // [[two-authors-per-fact]]
  check("App.jsx renders the shared band model", /\breportBands\s*\(/.test(code),
    "the on-screen ten must come from report-bands.js, not be hand-built here");
  check("App.jsx does NOT hand-build the ten any more",
    !/PG\.push\(\{\s*title:/.test(code),
    "a second author for the ten points is exactly what report-bands.js replaced");

  // THE OLD RULE HERE WAS THE BUG, NOT THE GUARD.
  //
  // It required the caption to read `{PG.length} / 10 backed` -- written to stop
  // someone hardcoding "10". There were exactly ten PG.push calls and not one
  // was conditional, so the rule GUARANTEED the number was computed and the
  // computation always returned ten. A report whose ten points all read
  // NOT CHECKED passed this gate and printed "10 / 10 backed" above them.
  //
  // A count that cannot be anything but ten is not a measurement. The caption
  // must now name STATES, which differ between two scans of two cars.
  // [[claims-must-stay-backed]]
  check("the ten-point caption is gone -- it could only ever read ten",
    !/\/ 10 backed/.test(code),
    'the literal "/ 10 backed" is back; it is true by construction and says nothing');
  check("the caption names states from the real tally",
    /TALLY\.raise/.test(code) && /TALLY\.clear/.test(code) && /TALLY\.unchecked/.test(code),
    "the heading must render bandTally() states, not a count");
  // "Also checked" is a SEPARATE array (extraDefs), built after PG and never
  // pushed into it -- so an extra can never be miscounted as one of the ten.
  // Same property the emailed report's "no additional check is named the
  // same as one of the ten" rule guards, checked here on the app side too.
  const extraDefsBlock = (() => {
    const start = src.indexOf("const extraDefs=[");
    if (start === -1) return null;
    const end = src.indexOf("].filter(Boolean);", start);
    return end === -1 ? null : src.slice(start, end);
  })();
  check("App.jsx builds \"also checked\" as its own array, not pushed into the ten",
    !!extraDefsBlock, "expected a `const extraDefs=[...]` block after the PG.push sequence");
  if (extraDefsBlock) {
    const extraLabels = [...extraDefsBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    check("no \"also checked\" extra is named the same as one of the ten",
      !extraLabels.some((l) => POINT_TITLES.includes(l)),
      `extras: ${JSON.stringify(extraLabels)}`);
  }
  check("the \"also checked\" section says it isn't part of the ten",
    /Also checked/.test(src) && /not part of the ten/.test(src));
}

// ── the emailed PDF (email-quote-report) ───────────────────────────────────
console.log("\nthe emailed report");
{
  const src = read("supabase/functions/email-quote-report/index.ts");
  // Bounded to the function, with comments stripped so a line DESCRIBING old
  // code is never mistaken for the code itself.
  const start = src.indexOf("function tenPoints");
  const body = src.slice(start, src.indexOf("\n}", start)).replace(/\/\/[^\n]*/g, "");
  const titles = uniqInOrder([...body.matchAll(/P\.push\(\{\s*t:\s*"([^"]+)"/g)].map((m) => m[1]));
  // A branch may QUALIFY a title ("Financing APR (this dealer)") but must not
  // rename the point.
  const canonical = uniqInOrder(titles.map((t) => POINT_TITLES.find((c) => t === c || t.startsWith(c + " ")) || t));
  const core = canonical.slice(0, 10), extras = canonical.slice(10);
  check("tenPoints() opens with the canonical ten, in order",
    JSON.stringify(core) === JSON.stringify(POINT_TITLES),
    `email: ${JSON.stringify(core)}\n         canon: ${JSON.stringify(POINT_TITLES)}`);
  // Ten is a FLOOR. Extras are expected and must reach the PDF in full (Vic,
  // 2026-08-27: "yes add them to pdf file all 14") — they must simply not be
  // presented as points.
  console.log(`       (${extras.length} additional checks beyond the ten: ${extras.join(", ") || "none"})`);
  check("no additional check is named the same as one of the ten",
    !extras.some((e) => POINT_TITLES.includes(e)));
  check("tenPoints() never truncates its own list",
    !/return P\.slice\(0,\s*10\)/.test(body),
    "slice(0,10) silently drops any point beyond the tenth instead of failing loudly");
  check("the PDF's audit kicker counts the CORE, not the mixed pool",
    /kicker\(`\$\{CORE\.length\}-POINT AUDIT`\)/.test(src));
  // The emailed HTML body is a THIRD render path, and it used to build its own
  // conditional roll-up instead of using tenPoints(): every row was an
  // `if (...) push` with no else, so an unresolved point emitted nothing --
  // while the PDF stapled to the same email printed it as "NOT ON QUOTE".
  check("the emailed HTML body builds its checklist from tenPoints()",
    /const pts = tenPoints\(a\);/.test(src),
    "an unresolved point must render on every surface, not vanish from two of them");
  check("the emailed HTML splits core from extras the same way",
    /label: `The \$\{core\.length\}-point verification`/.test(src)
    && /label: `Also checked on this listing \(\$\{extras\.length\}\)`/.test(src));
  check("no conditional quick-checks roll-up remains",
    !/deck\.push\(\{ label: "Quick checks"/.test(src),
    "that roll-up is what silently dropped unresolved points");
  check("the PDF prints the additional checks under their own heading",
    /kicker\(`ALSO CHECKED ON THIS LISTING \(\$\{EXTRA\.length\}\)`\)/.test(src),
    "every extra must still be printed — just not as a point");
}

// ── the advertisement (public/index.html) ──────────────────────────────────
console.log("\nwhat we advertise");
{
  const src = read("public/index.html");
  const ol = /<ol class="pipe-fallback">([\s\S]*?)<\/ol>/.exec(src);
  check("the landing page's fallback list exists", !!ol);
  if (ol) {
    const items = [...ol[1].matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1].trim());
    check(`the advertised list has ten entries (${items.length})`, items.length === 10);
    check("the advertised ten are the delivered ten, in order",
      JSON.stringify(items) === JSON.stringify(REPORT_POINTS.map((p) => p.marketing)),
      `ad:    ${JSON.stringify(items)}\n         canon: ${JSON.stringify(REPORT_POINTS.map((p) => p.marketing))}`);
    check("the verdict is not advertised as one of the points",
      !items.some((i) => /leverage/i.test(i)),
      "the leverage score is computed FROM the ten; advertising it as a point promises a check we do not run");
  }
  const stn = /var STN = \[([\s\S]*?)\];/.exec(src);
  check("the animated lane's labels exist", !!stn);
  if (stn) {
    const labels = [...stn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    check("the lane cycles the same ten, in the same order",
      JSON.stringify(labels) === JSON.stringify(REPORT_POINT_SHORT),
      `lane:  ${JSON.stringify(labels)}\n         canon: ${JSON.stringify(REPORT_POINT_SHORT)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
