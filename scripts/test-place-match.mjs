// GATE: another company's reviews never get attached to this dealer.
//
// get-dealer-sentiment took `searchData.places[0]` -- the first free-text search
// result -- with no comparison of the returned name, address or website against
// the dealer we asked about, then cached it for 30 days and signed it into the
// report. A near-name collision publishes another business's star rating and its
// worst reviews against a named company, in a document the buyer carries into
// that company. [[ai-defamation-entity-match-lesson]]
//
// The AMVIC matcher had the identical defect and the identical fix: refuse
// rather than guess. This pins that refusal.
//
// THE ONE PROPERTY THAT MATTERS: returning null must stay possible. A matcher
// that always answers is the bug, not the fix -- so most of this file is cases
// where the right answer is "we cannot tell".
//
// Offline. No network, no database.
//
// Run: npm run test:place-match

import { matchPlace, placeHost, addressHasCity }
  from "../supabase/functions/_shared/place-match.js";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const ok = (m) => console.log(`ok    ${m}`);
const check = (m, c, d) => c ? ok(m) : fail(m, d);

const P = (name, opts = {}) => ({
  id: opts.id || name.toLowerCase().replace(/\W+/g, "-"),
  displayName: { text: name },
  formattedAddress: opts.addr || "",
  websiteUri: opts.site || "",
  rating: opts.rating ?? 4.2,
  userRatingCount: opts.n ?? 100,
});

/* ── 0. the matcher can still say no ─────────────────────────────────────── */
console.log("\npart 0 -- refusing is reachable");
{
  const r = matchPlace([P("Completely Different Motors", { addr: "Red Deer AB" })],
    { dealerName: "Xperts Auto Sales", dealerCity: "Calgary" });
  if (r === null) ok("an unrelated business is refused, not returned");
  else { console.error("FATAL the matcher cannot refuse -- every other case here is meaningless."); process.exit(1); }

  const y = matchPlace([P("Xperts Auto Sales", { addr: "123 36 St NE, Calgary, AB" })],
    { dealerName: "Xperts Auto Sales", dealerCity: "Calgary" });
  if (y && y.place) ok("a genuine match is still returned");
  else { console.error("FATAL the matcher refuses everything."); process.exit(1); }
}

/* ── 1. the collision this was built for ─────────────────────────────────── */
console.log("\npart 1 -- near-name collisions");
{
  // Google's order is not evidence. "Summit Auto House" first, the real
  // "Auto House" second: taking [0] publishes Summit's reviews as Auto House's.
  const places = [
    P("Summit Auto House", { addr: "900 Main St, Red Deer, AB", rating: 2.9 }),
    P("Auto House", { addr: "1616 Centre St, Calgary, AB", rating: 4.6 }),
  ];
  const r = matchPlace(places, { dealerName: "Auto House", dealerCity: "Calgary" });
  check("the right rooftop is chosen, not the first result",
    r && r.place.formattedAddress.includes("Calgary"), JSON.stringify(r?.place?.displayName));
  check("...and it is NOT the higher-ranked wrong one",
    r && r.place.rating === 4.6, String(r?.place?.rating));

  // Same brand, wrong town, and no city given to break the tie.
  const noCity = matchPlace([P("Auto House", { addr: "900 Main St, Red Deer, AB" })],
    { dealerName: "Auto House" });
  check("same name in another town with no city to check is refused", noCity === null,
    JSON.stringify(noCity?.basis));

  // A city we were given and cannot find is a reason to doubt.
  const wrongTown = matchPlace([P("Auto House", { addr: "900 Main St, Red Deer, AB" })],
    { dealerName: "Auto House", dealerCity: "Calgary" });
  check("a match whose address is not in the stated city is refused", wrongTown === null,
    JSON.stringify(wrongTown?.basis));
}

/* ── 2. the domain is identity ───────────────────────────────────────────── */
console.log("\npart 2 -- the dealer's own domain decides");
{
  const places = [
    P("Xperts Automotive Group", { addr: "Edmonton, AB", site: "https://someoneelse.ca" }),
    P("Xperts Auto", { addr: "Calgary, AB", site: "https://www.xpertsautos.com" }),
  ];
  const r = matchPlace(places, {
    dealerName: "XPERTS AUTO SALES LTD", dealerCity: "Calgary",
    domains: ["xpertsautos.com"],
  });
  check("a website match wins outright", r && r.confidence === 1, JSON.stringify(r?.basis));
  check("...and names the domain as the basis", r && /domain/.test(r.basis), r?.basis);

  // www and scheme must not defeat it.
  const r2 = matchPlace([P("X", { site: "http://www.xpertsautos.com/contact" })],
    { dealerName: "Anything At All", domains: ["https://xpertsautos.com"] });
  check("www, scheme and path do not defeat the domain match", r2 && r2.confidence === 1,
    JSON.stringify(r2));

  // A dealer group: several rooftops on one domain. Without a city we cannot
  // say which one, and rooftops have genuinely different ratings.
  const group = [
    P("Go Auto Edmonton", { addr: "Edmonton, AB", site: "https://goauto.ca", rating: 4.1 }),
    P("Go Auto Calgary", { addr: "Calgary, AB", site: "https://goauto.ca", rating: 3.2 }),
  ];
  check("one domain, several rooftops, no city -> refused",
    matchPlace(group, { dealerName: "Go Auto", domains: ["goauto.ca"] }) === null);
  const picked = matchPlace(group, { dealerName: "Go Auto", dealerCity: "Calgary", domains: ["goauto.ca"] });
  check("...but a city picks the rooftop", picked && picked.place.rating === 3.2, String(picked?.place?.rating));
}

/* ── 3. ambiguity is refused, not ranked ─────────────────────────────────── */
console.log("\npart 3 -- two equally good answers is no answer");
{
  const twins = [
    P("Calgary Honda", { addr: "11 Ave SW, Calgary, AB", rating: 4.4 }),
    P("Calgary Honda", { addr: "52 St SE, Calgary, AB", rating: 3.1 }),
  ];
  check("two identically-named places in one city are refused",
    matchPlace(twins, { dealerName: "Calgary Honda", dealerCity: "Calgary" }) === null,
    "picking by Google's order is picking a coin toss, and the two differ by 1.3 stars");
}

/* ── 4. nothing to go on ─────────────────────────────────────────────────── */
console.log("\npart 4 -- empty and missing inputs");
{
  check("no candidates -> null", matchPlace([], { dealerName: "X" }) === null);
  check("null candidates -> null", matchPlace(null, { dealerName: "X" }) === null);
  check("no dealer name and no domain -> null",
    matchPlace([P("Anything", { addr: "Calgary, AB" })], { dealerCity: "Calgary" }) === null);
  check("a weak partial name is refused",
    matchPlace([P("Stampede Toyota Sales and Service Centre", { addr: "Calgary, AB" })],
      { dealerName: "Auto", dealerCity: "Calgary" }) === null);
}

/* ── 5. helpers ──────────────────────────────────────────────────────────── */
console.log("\npart 5 -- helpers");
{
  check("placeHost strips scheme, www and path",
    placeHost({ websiteUri: "https://www.example.ca/about" }) === "example.ca",
    placeHost({ websiteUri: "https://www.example.ca/about" }));
  check("placeHost on a missing website is empty", placeHost({}) === "");
  check("addressHasCity is case and punctuation tolerant",
    addressHasCity({ formattedAddress: "1616 Centre St. N, CALGARY, AB T2E 2S1" }, "Calgary"));
  check("addressHasCity is false when the city is absent",
    !addressHasCity({ formattedAddress: "900 Main St, Red Deer, AB" }, "Calgary"));
}

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("all checks passed");
