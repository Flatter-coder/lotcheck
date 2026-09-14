// The explanation must fit the reading it is printed beside.
//
// THE DEFECT (2026-08-27, a real report on a 2025 Mazda CX-90 MHEV reading
// 12 km). computeOdometerCheck already banded the reading correctly and wrote
// "12 km — consistent with a new vehicle (delivery distance)." Directly under
// it, the "what this means" explainer printed:
//
//   "A truly new car should read near zero km - thousands on the clock means
//    it's been driven (demo/loaner) and should be priced below new."
//
// Both sentences were ours, on the same card, and they contradicted each other.
// The explainer was a SECOND, hand-written string that branched only on
// vehicleCondition and never looked at the kilometres. Vic: "12kms on odometer
// that's fine offloading from truck driving around dealrship lot ... that needs
// to change".
//
// The class is "a fixed sentence printed beside a variable number", so the fix
// is one BAND written where the reading is banded, read by every surface. This
// gate pins that the band exists, that both surfaces branch on it, and that no
// surface can state the demo/loaner story about a delivery-distance reading.
import { readFileSync } from "node:fs";
// THE MODEL IS EXECUTABLE, SO EXECUTE IT. Reading source text only proves a
// string exists somewhere in a file; calling the function proves what a buyer
// is actually shown. The emailed PDF is a Deno module this runner cannot
// import, so that half stays a text check -- the model does not have to.
import { odometerExplain, reportBands } from "../supabase/functions/_shared/report-bands.js";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// COMMENTS STRIPPED BEFORE EVERY ASSERTION. Four checks in this repo have now
// passed or failed on PROSE rather than code: one matched `reason` inside
// `reason: data?.reason`, one matched a function name inside the comment that
// explained the fix, and check:points failed on a comment quoting the very
// string it forbids. A gate that reads the explanation goes green the day the
// code is deleted and the comment is not.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const SERVER = strip(read("supabase/functions/analyze-listing-url/index.ts"));
const EMAIL = strip(read("supabase/functions/email-quote-report/index.ts"));
const APP = strip(read("src/App.jsx"));
// THE ON-SCREEN EXPLAINER DOES NOT LIVE IN App.jsx ANY MORE. The app renders
// the shared band model, so that model is the on-screen surface and is where
// this gate has to look. Pointing it back at App.jsx is what made it fail on
// 2026-09-14 while the PDF was still correct.
const MODEL = strip(read("supabase/functions/_shared/report-bands.js"));

console.log("\nthe reading is banded once, where it is judged");
check("computeOdometerCheck assigns a band",
  /let band: string;/.test(SERVER) && /band = "new_delivery";/.test(SERVER),
  "the band must be set where the km-aware note is already written");
check("every branch sets one",
  ["new_delivery", "new_beyond_delivery", "used_nearly_new", "used"]
    .every((b) => SERVER.includes(`band = "${b}";`)));
check("the band reaches the analysis",
  /odometerCheck = \{ checked: true, km, flag, note, band \}/.test(SERVER),
  "a band computed and not carried is the built-but-never-wired defect");
check("the delivery band is 500 km, matching the note it sits beside",
  /if \(km <= 500\) \{\s*\n\s*band = "new_delivery";/.test(SERVER));

console.log("\nboth explainers branch on the band, not on condition alone");
// AND THE LINK THAT MAKES THE MODEL COUNT. Without this, every assertion
// below could pass against a file the buyer never sees.
check("the on-screen card renders that shared model",
  /reportBands\s*\(/.test(APP),
  "if the app stops rendering report-bands.js, this gate is checking a file nobody reads");

check("the emailed report reads odometerCheck.band",
  /odometerCheck\.band/.test(EMAIL),
  "branching on vehicleCondition alone is what produced the contradiction");
check("the emailed report handles the delivery case", /new_delivery/.test(EMAIL));
check("the emailed report handles the beyond-delivery case", /new_beyond_delivery/.test(EMAIL));

// The model is not asked whether it CONTAINS the string "odometerCheck.band".
// It is handed two readings that differ only in kilometres and asked what it
// would print. That is the property: same car, same condition, different
// number, different sentence.
{
  const d = odometerExplain("new_delivery", 12);
  const b = odometerExplain("new_beyond_delivery", 3200);
  check("the model answers a delivery reading differently from a beyond-delivery one",
    !!d && !!b && d !== b,
    "one sentence for both readings is the contradiction this gate exists to stop");
  check("each answer carries THAT car's own reading, not a fixed number",
    /\b12 km\b/.test(d) && /\b3,200 km\b/.test(b),
    `d=${String(d).slice(0, 60)} b=${String(b).slice(0, 60)}`);
  check("an ordinary used car falls through to its own km-vs-age note",
    odometerExplain("used", 90000) === null,
    "a fixed sentence must never replace the note carrying this car's age");
}

console.log("\nthe contradicting sentence is gone from every surface");
for (const [label, src] of [["the emailed report", EMAIL], ["the on-screen card", APP], ["the shared band model", MODEL]]) {
  check(`${label} no longer says a new car reading km has been driven`,
    !/truly new car should (read near zero|be near zero)/i.test(src),
    "this fired on a 12 km car");
  check(`${label} does not assert demo/loaner unconditionally`,
    !/anything in the thousands means it's been driven/i.test(src));
}

// BOTH surfaces carry the copy, so both are held to it. On 2026-09-14 the PDF
// had all four of these and the screen had none, and this gate was green on the
// screen because it was only ever reading the PDF.
//
// The PDF is sliced out of its source. The model is CALLED, so what is tested
// is the sentence a buyer receives rather than a sentence that happens to be
// somewhere in the file.
const NEXT = { new_delivery: "new_beyond_delivery", new_beyond_delivery: "used_nearly_new" };
const SURFACES = [
  ["the PDF", (b) => EMAIL.slice(EMAIL.indexOf(`case "${b}"`), EMAIL.indexOf(`case "${NEXT[b]}"`))],
  ["the shared band model", (b) => String(odometerExplain(b, 3200) || "")],
];

console.log("\nthe delivery-band copy explains the reading rather than doubting it");
for (const [label, cut] of SURFACES) {
  const s = cut("new_delivery");
  check(`${label}: it names why a new car is not on zero`,
    /transport truck/i.test(s) && /pre-delivery inspection/i.test(s), s.slice(0, 120));
  check(`${label}: it tells the buyer it changes nothing about the car`,
    /delivery distance, not use/i.test(s));
  check(`${label}: it gives the buyer something to do`, /read the dash/i.test(s));
  check(`${label}: it makes no claim about the dealer`,
    !/(padding|markup|priced below new|should be priced)/i.test(s), s.slice(0, 140));
}

console.log("\nand the beyond-delivery copy is factual, not accusatory");
for (const [label, cut] of SURFACES) {
  const s = cut("new_beyond_delivery");
  check(`${label}: it says what the reading most often means`, /demonstrator|service loaner/i.test(s));
  check(`${label}: it explicitly says that is normal, not a fault`,
    /normal part of the business, not a fault/i.test(s),
    "a demo unit is not wrongdoing and must not read as one");
  check(`${label}: it points at the thing that actually costs the buyer money`,
    /in-service date/i.test(s) && /warranty/i.test(s));
}

// AND THE WHOLE WAY THROUGH. The explainer existing is not the same as the
// explainer reaching the band the app renders -- built-but-never-wired is the
// defect that put "NOT ON QUOTE" on a buyer's report for a month.
console.log("\nthe rendered band carries it, end to end");
{
  const at06 = (o) => reportBands({ odometerCheck: o }).find((x) => x.n === "06");
  const beyond = at06({ checked: true, km: 3200, flag: true, band: "new_beyond_delivery", note: "one-liner" });
  check("a flagged new-car reading is a raise", beyond.state === "raise", beyond.state);
  check("...and the raise still says it is not a fault",
    /normal part of the business, not a fault/i.test(beyond.note),
    "a red band with no such sentence is an accusation");
  const deliv = at06({ checked: true, km: 12, flag: false, band: "new_delivery", note: "one-liner" });
  check("a delivery reading prints the explainer, not the one-line note",
    /transport truck/i.test(deliv.note), deliv.note.slice(0, 80));
  const legacy = at06({ checked: true, km: 90000, flag: false, note: "90,000 km is in the normal range for a 4-year-old vehicle." });
  check("an analysis cached before bands existed still explains itself",
    /normal range/i.test(legacy.note),
    "old cached reports must not degrade to a generic line");
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
