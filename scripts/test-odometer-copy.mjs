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

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const SERVER = read("supabase/functions/analyze-listing-url/index.ts");
const EMAIL = read("supabase/functions/email-quote-report/index.ts");
const APP = read("src/App.jsx");

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
for (const [label, src] of [["the emailed report", EMAIL], ["the on-screen card", APP]]) {
  check(`${label} reads odometerCheck.band`,
    /odometerCheck\.band/.test(src),
    "branching on vehicleCondition alone is what produced the contradiction");
  check(`${label} handles the delivery case`, /new_delivery/.test(src));
  check(`${label} handles the beyond-delivery case`, /new_beyond_delivery/.test(src));
}

console.log("\nthe contradicting sentence is gone from every surface");
for (const [label, src] of [["the emailed report", EMAIL], ["the on-screen card", APP]]) {
  check(`${label} no longer says a new car reading km has been driven`,
    !/truly new car should (read near zero|be near zero)/i.test(src),
    "this fired on a 12 km car");
  check(`${label} does not assert demo/loaner unconditionally`,
    !/anything in the thousands means it's been driven/i.test(src));
}

console.log("\nthe delivery-band copy explains the reading rather than doubting it");
{
  const seg = EMAIL.slice(EMAIL.indexOf('case "new_delivery"'), EMAIL.indexOf('case "new_beyond_delivery"'));
  check("it names why a new car is not on zero",
    /transport truck/i.test(seg) && /pre-delivery inspection/i.test(seg), seg.slice(0, 120));
  check("it tells the buyer it changes nothing about the car",
    /delivery distance, not use/i.test(seg));
  check("it gives the buyer something to do", /read the dash/i.test(seg));
  check("it makes no claim about the dealer",
    !/(padding|markup|priced below new|should be priced)/i.test(seg), seg.slice(0, 140));
}

console.log("\nand the beyond-delivery copy is factual, not accusatory");
{
  const seg = EMAIL.slice(EMAIL.indexOf('case "new_beyond_delivery"'), EMAIL.indexOf('case "used_nearly_new"'));
  check("it says what the reading most often means", /demonstrator|service loaner/i.test(seg));
  check("it explicitly says that is normal, not a fault",
    /normal part of the business, not a fault/i.test(seg),
    "a demo unit is not wrongdoing and must not read as one");
  check("it points at the thing that actually costs the buyer money",
    /in-service date/i.test(seg) && /warranty/i.test(seg));
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
