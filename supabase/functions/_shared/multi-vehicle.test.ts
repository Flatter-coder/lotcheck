// ============================================================================
// Regression suite for "is this one vehicle's page, or a list of many".
//
// WHY: Vic pasted a real Advantage Ford VDP —
//   https://www.advantageford.ca/inventory/2025-gmc-acadia-elevation-...
// — and got "Sorry, we can't process a page with multiple vehicles." The rule
// was "more than one checksum-valid VIN means a grid", and that page states
// SIX: the GMC Acadia it is about, plus five neighbours in a similar-vehicles
// rail. How many vehicles a page MENTIONS is not how many it is ABOUT.
//
// Vic's directive, which is what the module implements: "you need verification
// process first establish what's on webpage then create report" — and, on the
// same-vehicle case he named, multiple PICTURES of one car are one car.
//
// Pure and offline. Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/multi-vehicle.test.ts
// ============================================================================

import { distinctValidVins, classifyVehiclePage, subjectMismatch, identityMismatch } from "./multi-vehicle.ts";
import { jsonLdVehicleVins, jsonLdVehicles } from "./jsonld-vehicle.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ""}`); }
};

// The real page, measured in-browser 2026-08-27. The subject is the GMC; the
// 3FM* are Fords and the JM3* a Mazda, all from the recommendations rail.
const SUBJECT = "1GKENNRS8SJ240715";
const NEIGHBOURS = ["3FMTK1S56TMA24404", "3FMCR9DA3TRE99869", "JM3KKDHC2S1257500", "3FMCR9DA3TRE85003", "3FMCR9DA5TRE04826"];
// Both are SVG path data with the spaces stripped: <path d="M16 4V4H13V16H11Z M14...">
const SVG_NOISE = ["16V4H13V16H11ZM14", "16V4H15V16H14ZM17"];

// The declaration shape the classifier now takes: how many vehicle NODES the
// page declares, which VINs they carry, and which node (if any) is this page.
const decl = (vins: string[], count = vins.length, anchoredVin: string | null = null) =>
  ({ count, vins, anchoredVin });

const ldScript = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

console.log("\nThe VIN reader");

check("finds a valid VIN in prose",
  distinctValidVins(`VIN: ${SUBJECT} — stock #A123`).join() === SUBJECT);

check("MULTIPLE PICTURES OF THE SAME VEHICLE ARE ONE VEHICLE",
  distinctValidVins(
    `<img alt="${SUBJECT} front"><img alt="${SUBJECT} rear"><img alt="${SUBJECT} interior">` +
    `<span>VIN ${SUBJECT}</span><span>VIN ${SUBJECT}</span>`,
  ).length === 1);

check("the same vehicle repeated across cards collapses to one",
  distinctValidVins([SUBJECT, SUBJECT, SUBJECT.toLowerCase().toUpperCase()].join(" ")).length === 1);

check("SVG path data is not mistaken for a VIN (the check digit refuses it)",
  distinctValidVins(SVG_NOISE.join(" ")).length === 0, SVG_NOISE.join());

check("the real page's six vehicles are all found",
  distinctValidVins([SUBJECT, ...NEIGHBOURS, ...SVG_NOISE].join("\n")).length === 6);

check("empty text finds nothing, and does not throw",
  distinctValidVins("").length === 0);

console.log("\nWhat the page DECLARES it is about");

check("one Car node with an offer declares one vehicle",
  jsonLdVehicleVins(ldScript({ "@type": ["Product", "Car"], vehicleIdentificationNumber: SUBJECT, offers: { "@type": "Offer", price: "54995" } }))
    .join() === SUBJECT);

check("a vehicle nested in an @graph is still found",
  jsonLdVehicleVins(ldScript({ "@context": "https://schema.org", "@graph": [{ "@type": "AutoDealer", name: "Advantage Ford" }, { "@type": "Car", vehicleIdentificationNumber: SUBJECT }] }))
    .join() === SUBJECT);

check("a grid whose cards each declare a vehicle declares several",
  jsonLdVehicleVins(ldScript([{ "@type": "Car", vehicleIdentificationNumber: SUBJECT }, { "@type": "Car", vehicleIdentificationNumber: NEIGHBOURS[0] }])).length === 2);

check("the recommendations rail declares nothing, so a VDP still declares one",
  jsonLdVehicleVins(
    ldScript({ "@type": ["Product", "Car"], vehicleIdentificationNumber: SUBJECT }) +
    NEIGHBOURS.map((v) => `<div class="rec-card" data-vin="${v}">Similar vehicle</div>`).join(""),
  ).join() === SUBJECT);

check("a malformed block never sinks the rest",
  jsonLdVehicleVins(`<script type="application/ld+json">{ nope </script>` + ldScript({ "@type": "Car", vehicleIdentificationNumber: SUBJECT }))
    .join() === SUBJECT);

check("a page with no structured data declares nothing",
  jsonLdVehicleVins(`<html><body>VIN ${SUBJECT}</body></html>`).length === 0);

check("non-string input is handled, not thrown on",
  jsonLdVehicleVins(null as unknown as string).length === 0 && jsonLdVehicleVins("").length === 0);

console.log("\nThe decision");

{
  // THE REPORTED BUG.
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([SUBJECT]), null);
  check("a VDP with a similar-vehicles rail is a SINGLE-vehicle page",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT], decl([]), null);
  check("one vehicle on the page needs no declaration at all",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));
}

{
  const v = classifyVehiclePage([], decl([]), null);
  check("a page with no VINs at all is not refused as a grid",
    v.kind === "single" && v.subjectVin === null, JSON.stringify(v));
}

{
  // A platform with no schema.org markup still names its subject.
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), SUBJECT);
  check("the platform's own vehicle blob can name the subject instead",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([SUBJECT, NEIGHBOURS[0], NEIGHBOURS[1]]), null);
  check("a grid whose cards declare their own vehicles is still refused",
    v.kind === "multi", JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), null);
  check("several vehicles and nothing declared is refused -- missing beats wrong",
    v.kind === "multi", JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, SUBJECT], decl([SUBJECT]), null);
  check("the same vehicle twice is never a grid",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));
}

{
  // One unit described twice -- a Product node and a Car node for the same
  // vehicle -- is common markup, and it is ONE vehicle. Deduped in the reader,
  // by VIN, so the classifier never sees it as two.
  const twice = ldScript({ "@type": "Product", vehicleIdentificationNumber: SUBJECT }) +
                ldScript({ "@type": "Car", vehicleIdentificationNumber: SUBJECT });
  check("the same vehicle declared twice is one declaration, not two vehicles",
    jsonLdVehicles(twice, null).count === 1, JSON.stringify(jsonLdVehicles(twice, null)));
}

{
  // A DECLARATION WE CANNOT VALIDATE IS NOT A DECLARATION. jsonLdVehicleVins
  // checks shape only, so a platform publishing a placeholder or a typo in
  // vehicleIdentificationNumber would otherwise become this page's permanent
  // "subject" -- a VIN no read can ever equal, so the mismatch guard would
  // refuse that listing on every scan, forever.
  const BAD = "1GKENNRS8SJ240714";  // the real VIN with the check digit broken
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([BAD]), null);
  check("a checksum-invalid VIN never becomes the subject (it would refuse forever)",
    v.kind === "single" && v.subjectVin === null, JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), "NOTAREALVIN123456");
  check("a checksum-invalid platform blob VIN is ignored too",
    v.kind === "multi", JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl(["1GKENNRS8SJ240714"], 1), SUBJECT);
  check("a broken declared VIN falls through to the platform blob",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));
}

check("every verdict explains itself",
  [
    classifyVehiclePage([SUBJECT], decl([]), null),
    classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([SUBJECT]), null),
    classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), null),
  ].every((v) => typeof v.why === "string" && v.why.length > 10));

{
  // THE PLATFORMS THAT MARK UP THEIR RAIL PROPERLY would otherwise be punished
  // for it: every card gets its own Car node, so the page declares several.
  // The one whose url IS this page is the subject.
  const HERE = "https://www.advantageford.ca/inventory/2025-gmc-acadia/";
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([SUBJECT, NEIGHBOURS[0]], 6, SUBJECT), null);
  check("a rail that carries its own markup does not make the page a grid",
    v.kind === "single" && v.subjectVin === SUBJECT, JSON.stringify(v));

  const marked =
    ldScript({ "@type": "Car", url: HERE, vehicleIdentificationNumber: SUBJECT }) +
    NEIGHBOURS.map((n, i) => ldScript({ "@type": "Car", url: `https://www.advantageford.ca/inventory/other-${i}/`, vehicleIdentificationNumber: n })).join("");
  const read = jsonLdVehicles(marked, HERE);
  check("the reader anchors the subject node to the scanned URL",
    read.count === 6 && read.anchoredVin === SUBJECT, JSON.stringify(read));
  check("and a URL that matches nothing anchors nothing",
    jsonLdVehicles(marked, "https://elsewhere.example/x").anchoredVin === null);
}

{
  // A detail page is a detail page even when its VIN string is unusable --
  // the pin simply does not arm. Scoring it "declares nothing" would refuse it.
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([], 1), null);
  check("one declared vehicle with no readable VIN is still a detail page",
    v.kind === "single" && v.subjectVin === null, JSON.stringify(v));
}

{
  // Every Convertus VDP ships a hardcoded, checksum-VALID VIN as the trade-in
  // form placeholder. Counted as a vehicle it arms the guard on 100% of that
  // platform, so the caller strips form chrome before counting -- pinned here
  // as the shape, since the stripping itself lives at the call site.
  const chrome = `<input name="vin" placeholder="${NEIGHBOURS[0]}" value="">`;
  const stripped = chrome.replace(/\s(?:placeholder|value)="[^"]*"/gi, " ");
  check("a VIN that is only a form placeholder is not a vehicle on the page",
    distinctValidVins(chrome).length === 1 && distinctValidVins(stripped).length === 0);
}

console.log("\nBlame, when we refuse");

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), null, true);
  check("a real grid is the page's fault, so it may be throttled",
    v.kind === "multi" && v.blameThePage === true, JSON.stringify(v));
}

{
  // The declaration is read from the page's own HTML, and that fetch can lose
  // a race, be blocked, or return a challenge shell. Still refuse -- but a
  // 2h/24h lockout row against a real listing for OUR blind spot is how the
  // reported bug would come back durably.
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([]), null, false);
  check("a refusal caused by an unreadable fetch is NOT the page's fault",
    v.kind === "multi" && v.blameThePage === false, JSON.stringify(v));
}

{
  const v = classifyVehiclePage([SUBJECT, ...NEIGHBOURS], decl([SUBJECT, NEIGHBOURS[0]]), null, false);
  check("a page that really does declare several is its fault either way",
    v.kind === "multi" && v.blameThePage === true, JSON.stringify(v));
}

console.log("\nThe VIN is the field a wrong read gets RIGHT");

check("a different make is a mismatch even when the VIN matches",
  identityMismatch({ make: "Ford", year: 2025 }, { make: "GMC", year: 2025 }) !== null);

check("a different year is a mismatch",
  identityMismatch({ make: "GMC", year: 2023 }, { make: "GMC", year: 2025 }) !== null);

check("the same vehicle is not a mismatch, whatever the casing or spacing",
  identityMismatch({ make: " gmc ", year: "2025" }, { make: "GMC", year: 2025 }) === null);

check("a field missing on either side is not a contradiction",
  identityMismatch({ make: "GMC" }, { make: "GMC" }) === null &&
  identityMismatch({ year: 2025 }, { make: "GMC", year: 2025 }) === null &&
  identityMismatch({ make: "Ford" }, { year: 2025 }) === null);

check("no declaration at all is never a mismatch",
  identityMismatch({ make: "Ford", year: 2020 }, null) === null);

check("the reason names the field that disagreed",
  /make/i.test(String(identityMismatch({ make: "Ford" }, { make: "GMC" }))) &&
  /year/i.test(String(identityMismatch({ year: 2020 }, { year: 2025 }))));

console.log("\nThe report must be about the vehicle the page declares");

check("a read that matches the declared subject is no mismatch",
  subjectMismatch(SUBJECT, SUBJECT) === false);

check("a read that is one of the NEIGHBOURS is a mismatch",
  subjectMismatch(NEIGHBOURS[0], SUBJECT) === true);

check("case and whitespace do not make a mismatch",
  subjectMismatch(`  ${SUBJECT.toLowerCase()} `, SUBJECT) === false);

check("no VIN read at all is not a mismatch -- the gap-fill supplies it",
  subjectMismatch(null, SUBJECT) === false && subjectMismatch("", SUBJECT) === false &&
  subjectMismatch("UNKNOWN", SUBJECT) === false);

check("with no declared subject there is nothing to mismatch against",
  subjectMismatch(NEIGHBOURS[0], null) === false);

// ---------------------------------------------------------------------------
// The ORDER inside the scan, read out of the source. The decision is pure and
// tested above; where it sits in the request is what makes it usable.
// ---------------------------------------------------------------------------
console.log("\nWhere the decision sits in the scan");

const SCAN = readFileSync(new URL("../analyze-listing-url/index.ts", import.meta.url), "utf8");
const at = (needle: string) => SCAN.indexOf(needle);

check("the page is classified before any decision is taken about it",
  at("classifyVehiclePage(") > -1 && at("classifyVehiclePage(") < at('if (page.kind === "multi")'));

{
  // THE THROTTLE MUST NOT OUTLIVE THE RULE THAT FILLED IT. Every URL recorded
  // under the old count-based rule is on the counter; consulting it before the
  // classification would keep real VDPs locked out for 2h/24h under a verdict
  // we no longer reach — including the owner's own Advantage Ford link, which
  // is on the counter from the refusal that prompted this fix.
  const branch = at('if (page.kind === "multi")');
  check("the repeat cooldown is consulted only once we still mean to refuse",
    at("await checkRepeatCooldown(") > branch, `cooldown@${at("await checkRepeatCooldown(")} branch@${branch}`);
  check("and the hit is recorded only there too",
    at("await recordMultiVehicleHit(") > branch);
}

check("classification still runs before the paid extraction call",
  at("classifyVehiclePage(") < at("Here is the extracted content of a dealer listing page"));

check("a report is refused, not repaired, when it describes a different vehicle",
  /if \(pageMentionsOthers && pageSubjectVin\)/.test(SCAN) &&
  /error: "subject_mismatch"/.test(SCAN));

check("the pin is three questions, not just the VIN",
  /subjectMismatch\(analysis\.vin, pageSubjectVin\)/.test(SCAN) &&
  /identityMismatch\(analysis, pageDeclared\)/.test(SCAN) &&
  /nothing in what was read ties it/.test(SCAN));

check("the expensive refusal is throttled like the cheap one",
  /const cooldown = repeatIdentity \? await checkRepeatCooldown/.test(SCAN));

check("a refusal we caused ourselves never writes a lockout against the page",
  /if \(page\.blameThePage\) await recordMultiVehicleHit/.test(SCAN) &&
  /const sawPageSource = /.test(SCAN));

check("the JSON-LD fallback path classifies before it charges",
  /JSON-LD declares \$\{jlDeclared\.count\} vehicles/.test(SCAN) &&
  SCAN.indexOf("const jlDeclared") < SCAN.indexOf("Served structured-data (JSON-LD) fallback"));

check("the pin is recorded on the analysis, not thrown away",
  /analysis\.pageSubjectVin = pageSubjectVin;/.test(SCAN) &&
  /analysis\.pageMentionsOtherVehicles = true;/.test(SCAN));

{
  // Every exit from the two new refusals must give the credit back.
  const seg = SCAN.slice(at('if (page.kind === "multi")'), at('if (page.kind === "multi")') + 2200);
  check("the multi-vehicle refusal releases the credit", /await releaseCredit\(holdId\);/.test(seg));
  const seg2 = SCAN.slice(at('error: "subject_mismatch"') - 1400, at('error: "subject_mismatch"'));
  check("the subject-mismatch refusal releases the credit", /await releaseCredit\(holdId\);/.test(seg2));
}

// The refusal has to REACH the buyer as itself. [[report-features-all-views]]
console.log("\nThe client renders the refusal, not a generic failure");

const APP = readFileSync(new URL("../../../src/App.jsx", import.meta.url), "utf8");

check("the client has a branch for subject_mismatch",
  /body\.error==="subject_mismatch"/.test(APP));

{
  // res.json() can only run once. The 422 block reads the body, so any code
  // it does not handle used to fall through to `await res.json()` below and
  // throw "body stream already read" -- a specific server message becoming a
  // generic failure. The block must now end in a return for EVERY code.
  const i = APP.indexOf("if(res.status===422){");
  const block = APP.slice(i, APP.indexOf("const data=await res.json();", i));
  check("no 422 can fall through to a second read of the same body",
    /setErrorMsg\(body\.message\|\|body\.error/.test(block));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
