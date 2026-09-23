// GATE: the sentences that explain a refusal must read correctly with NO make.
//
// basisRefusal() is what a buyer reads instead of an over/under-MSRP figure.
// It is printed verbatim in a signed report, so it is copy, and copy that only
// works on the happy path is copy that ships broken on the other one.
//
// Its templates each supply their own article — "the ${m} figure", "The ${m}
// figure", "the ${m} MSRP" — and its fallback for an unnamed make was
// "the manufacturer". The two collided and printed:
//
//   "and the the manufacturer figure we hold for this trim..."
//   "The the manufacturer figure we hold for this trim..."
//   "We hold a the manufacturer MSRP for this trim..."
//
// Every fixture in the suite passed a make, so the fallback path had no
// coverage at all. And this is the SECOND time: canada-terms.ts:45 records the
// same collision — "replacing the bare token first produced 'the the provincial
// registry'". Named once, repeated in another file.
//
// So the check is mechanical and renders the real sentences rather than
// inspecting the templates.
//
// Run: node scripts/test-refusal-copy.mjs
import { basisRefusal } from "../supabase/functions/_shared/msrp-basis.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

const WHYS = ["no_all_in", "incl_freight", "unknown_basis"];
// The unnamed path first: it is the one that was broken.
const MAKES = ["", null, undefined, "   ", "Toyota", "Lexus", "Mercedes-Benz"];

// Doubled articles and article-on-article collisions, case-insensitive.
const BAD = [
  { re: /\bthe\s+the\b/i, name: "doubled 'the'" },
  { re: /\ba\s+the\b/i, name: "'a the'" },
  { re: /\ban\s+the\b/i, name: "'an the'" },
  { re: /\bthe\s+a\b/i, name: "'the a'" },
  { re: /\ba\s+a\b/i, name: "doubled 'a'" },
  { re: /\s{2,}/, name: "double space" },
  { re: /\s+[,.]/, name: "space before punctuation" },
];

for (const mk of MAKES) {
  for (const why of WHYS) {
    const t = basisRefusal(why, mk);
    const label = `${why} / make=${JSON.stringify(mk)}`;
    const hit = BAD.find((b) => b.re.test(t));
    check(`${label}: reads cleanly`, !hit, hit ? `${hit.name} in: ${t.slice(0, 130)}` : "");
    check(`${label}: is a real sentence`, typeof t === "string" && t.length > 60 && /\.$/.test(t.trim()));
  }
}

// ---- the substance must survive the copy fix ----------------------------
// These sentences exist to say the gap is OURS, never the dealer's. A tidy-up
// that lost that would be worse than the doubled article.
for (const mk of ["", "Toyota"]) {
  for (const why of WHYS) {
    const t = basisRefusal(why, mk);
    check(`${why} / ${mk || "(unnamed)"}: still blames our catalogue, not the dealer`,
      /gap in our catalogue, not a finding about the price/.test(t), t.slice(0, 110));
    check(`${why} / ${mk || "(unnamed)"}: still refuses the claim in words`,
      /no over\/under-MSRP claim is made/.test(t), t.slice(0, 110));
  }
}

// ---- and the named make must actually appear ---------------------------
// A fallback that swallowed the make would pass every check above.
for (const why of WHYS) {
  check(`${why}: a named make is used`, /Toyota/.test(basisRefusal(why, "Toyota")));
  check(`${why}: an unnamed make does not print an empty gap`,
    !/\bthe\s+figure\b/.test(basisRefusal(why, "")) || why === "no_all_in",
    basisRefusal(why, "").slice(0, 110));
}

// ---- the detector must be able to fire ---------------------------------
const planted = "We hold a the manufacturer MSRP for this trim.";
check("the detector catches the exact string that shipped",
  BAD.some((b) => b.re.test(planted)));
check("...and does not fire on correct copy",
  !BAD.some((b) => b.re.test("We hold the Toyota MSRP for this trim.")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
