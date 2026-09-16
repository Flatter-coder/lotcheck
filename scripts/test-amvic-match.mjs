// Regression suite for the AMVIC licensee matcher (check #11).
// Run: node scripts/test-amvic-match.mjs
//
// The defamation-safe contract is what these tests actually protect: a wrong
// or over-confident match would attach a real regulator status to the wrong
// business. Every "expect null" case below is a claim we must NOT make.

import { readFileSync } from "node:fs";
import { matchLicensee, classifyStatus, nameScore, pageDomains, normHost, licenceProbes } from "../supabase/functions/_shared/amvic-match.js";

// Real shapes from AMVIC's registry (values observed live 2026-08-10).
const ROWS = [
  // THE REAL REGISTRY ROW, read from our own snapshot on 2026-09-15. It used to
  // be a fiction here -- `name: "OKOTOKS TOYOTA LTD."` with
  // `website: "www.okotokstoyota.ca"` -- which is the EASY shape: the legal name
  // is the dealer name and the domain matches. AMVIC actually records this
  // business as HRT MOTORS INC. trading as OKOTOKS TOYOTA, with website "N/A".
  // So the only route to it is the trade name: the legal name shares no token
  // with "Okotoks Toyota" and there is no domain to fall back on. The fixture
  // had been passing against a row the registry does not contain.
  { name: "HRT MOTORS INC.", trade_name: "OKOTOKS TOYOTA", city: "Okotoks", facility_status: "Issued", registration_number: "B1023322", expiry_date: "Apr-30-2027", website: "N/A" },
  { name: "CANYON CREEK HOLDINGS INC.", trade_name: "CANYON CREEK TOYOTA", city: "Calgary", facility_status: "Closed - Voluntarily", registration_number: "B1009900", website: "www.canyoncreektoyota.com" },
  { name: "CROWFOOT DODGE CHRYSLER INC.", trade_name: "N/A", city: "Calgary", facility_status: "Closed - Voluntarily", registration_number: "B1002222" },
  { name: "North American EV Inc", trade_name: "N/A", city: "Mountain View County", facility_status: "Expired - Required to Reapply", registration_number: "B2035585", website: "www.northamericanev.com", expiry_date: "Jun-30-2022" },
  { name: "ADVANCED AUTOMOTIVE REPAIR INC.", trade_name: "N/A", city: "Calgary", facility_status: "Expired - Required to Reapply", registration_number: "B1012209" },
  { name: "KRAMER MAZDA LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Issued", registration_number: "B1004444" },
  // Deliberate near-duplicates: the ambiguity guard must refuse to choose.
  { name: "CALGARY AUTO SALES INC.", trade_name: "N/A", city: "Calgary", facility_status: "Issued" },
  { name: "CALGARY AUTO SALES LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Cancelled by Registrar" },
  // Real shape (2026-08-11): ONE business, TWO registry records, same status.
  // Refusing these meant real dealers silently got no licence card.
  { name: "ADVANTAGE FORD SALES LTD.", trade_name: "N/A", city: "CALGARY", facility_status: "Issued", registration_number: "B2037619", expiry_date: "Feb-28-2027" },
  { name: "ADVANTAGE FORD SALES LTD.", trade_name: "N/A", city: "CALGARY", facility_status: "Issued", registration_number: "B2037619", expiry_date: "Feb-28-2027" },
  // THE SUPERSEDED-RECORD CASE (real, 2026-08-11). Fish Creek Nissan has three
  // records: the previous operator's dead ones, and the current operator's live
  // licence filed under a COMBINED trade name. Name-only scoring picks the dead
  // 2014 record -- an exact match -- and calls an operating dealer "closed".
  { name: "969642 ALBERTA LTD.", trade_name: "FISH CREEK NISSAN", city: "CALGARY", facility_status: "Closed - Voluntarily", registration_number: "B1013803", expiry_date: "Dec-31-2014" },
  { name: "CALGARY N MOTORS GP INC.", trade_name: "CALGARY N MOTORS LP/FISH CREEK NISSAN", city: "Calgary", facility_status: "Closed - Voluntarily", registration_number: "B1045312", expiry_date: "Jun-30-2019" },
  { name: "CALGARY N MOTORS GP INC.", trade_name: "FISH CREEK NISSAN/CALGARY N MOTORS LP", city: "Calgary", facility_status: "Issued", registration_number: "B2026510", expiry_date: "Mar-31-2027" },
  // A storefront whose ONLY records are dead -- report the most recent, not the oldest.
  { name: "OLDTOWN MOTORS LTD.", trade_name: "OLDTOWN MOTORS", city: "Red Deer", facility_status: "Closed - Voluntarily", registration_number: "B1000001", expiry_date: "Jan-31-2012" },
  { name: "OLDTOWN MOTORS LTD.", trade_name: "OLDTOWN MOTORS", city: "Red Deer", facility_status: "Expired - Required to Reapply", registration_number: "B1000002", expiry_date: "Aug-31-2024" },
];

const CASES = [
  // --- must match (confident) ---
  // The dealer name matches the TRADE name only. The legal name is a holding
  // company sharing no token with it, and the registry records no website, so
  // the trade name is the only route in. This is the real shape of the record.
  ["Trade name is the only route in (legal name is a holding company)", { dealerName: "Okotoks Toyota", dealerCity: "Okotoks, AB" }, "HRT MOTORS INC."],
  ["Word-order flip, against the trade name", { dealerName: "Toyota of Okotoks", dealerCity: "Okotoks" }, "HRT MOTORS INC."],
  ["Corporate suffix in the query", { dealerName: "Kramer Mazda Ltd.", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],
  ["Closed dealer still matches (status is the point)", { dealerName: "Crowfoot Dodge Chrysler", dealerCity: "Calgary" }, "CROWFOOT DODGE CHRYSLER INC."],
  ["Expired dealer with live website", { dealerName: "North American EV", dealerCity: "Mountain View County" }, "North American EV Inc"],
  // The website path needs a row that HAS a website; the Okotoks record does
  // not, which is why it can no longer carry this case. Canyon Creek can: its
  // legal name is unrelated and the domain is the only strong signal.
  ["Website host clinches it", { dealerName: "Canyon Creek Toyota", website: "https://www.canyoncreektoyota.com/new/inventory/x.html" }, "CANYON CREEK HOLDINGS INC."],
  // ...and with no city and no domain, the trade name still carries it.
  ["Trade-name match with no city and no website", { dealerName: "Okotoks Toyota" }, "HRT MOTORS INC."],
  ["Punctuation + ampersand noise", { dealerName: "Kramer Mazda", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],
  ["Duplicate records, same status -> still matches", { dealerName: "Advantage Ford", dealerCity: "Calgary, AB" }, "ADVANTAGE FORD SALES LTD."],
  // The regression that mattered: never report a superseded "Closed" record for
  // a dealer that currently holds a licence.
  ["Fish Creek Nissan -> the CURRENT operator's licence, not the 2014 closure", { dealerName: "Fish Creek Nissan", dealerCity: "Calgary" }, "CALGARY N MOTORS GP INC."],
  ["Only-dead records -> the most recent one, not the oldest", { dealerName: "Oldtown Motors", dealerCity: "Red Deer" }, "OLDTOWN MOTORS LTD."],

  // --- must NOT match (these are the defamation guards) ---
  ["Single generic token", { dealerName: "Auto", dealerCity: "Calgary" }, null],
  ["Unknown dealer", { dealerName: "Sunridge Hyundai", dealerCity: "Calgary" }, null],
  // Same storefront name across two entities, one live: report the LIVE one.
  // The card prints the legal name + licence number, so the buyer can see whose
  // record it is; the opposite error (calling a licensed dealer cancelled) is
  // the one that must never happen.
  ["Same name, one live -> report the live licence", { dealerName: "Calgary Auto Sales", dealerCity: "Calgary" }, "CALGARY AUTO SALES INC."],
  ["Empty name", { dealerName: "", dealerCity: "Calgary" }, null],
  ["City alone is not identity", { dealerName: "Calgary", dealerCity: "Calgary" }, null],
  ["Brand alone is not a dealer", { dealerName: "Toyota", dealerCity: "Okotoks" }, null],
];

let pass = 0, fail = 0;
for (const [label, sig, expected] of CASES) {
  let got = null;
  try { const m = matchLicensee(ROWS, sig); got = m ? m.row.name : null; }
  catch (e) { got = "THREW: " + e.message; }
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${expected === null ? "no match" : expected}, got ${got === null ? "no match" : got}`);
  ok ? pass++ : fail++;
}

// Status classification — the regulator's wording drives the report tone.
const STATUS = [
  ["Issued", "valid"],
  ["Expired - Required to Reapply", "expired"],
  ["Expired", "expired"],
  ["Closed - Voluntarily", "closed"],
  ["Cancelled by Registrar", "action"],
  ["Suspended by Registrar", "action"],
  ["N/A", "unknown"],
  ["Active", "valid"],        // rare but present in the live registry
  ["Deceased", "closed"],     // sole-proprietor records
  ["", "unknown"],
];
for (const [s, want] of STATUS) {
  const got = classifyStatus(s);
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  status "${s}" -> ${got}`);
  ok ? pass++ : fail++;
}

// Single-assertion helper for the blocks below; the table-driven loop above
// predates them and counts into the same pass/fail totals.
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? `
        ${detail}` : ""}`); }
};

// ---------------------------------------------------------------------------
// DETERMINISM, AND THE FALSE ATTRIBUTION IT WAS HIDING.
//
// rank() used to be `(city ? 2 : 0) + (expiry ? 1 : 0)` — no reference to how
// well the row's NAME matched. Every currently-licensed Calgary row with an
// expiry date therefore scored identically, and `sort()[0]` returned whichever
// row PostgREST happened to hand back first.
//
// Measured 2026-09-12 against the REAL registry: "Auto House" over its 21 real
// candidates, 200 shuffles of the SAME rows, returned SEVEN different
// businesses — AUTO HOUSE LTD. (correct) 58, SUMMIT AUTO HOUSE LTD. 96,
// ELSHAYAT, AHMED 21 (a named individual), CANADA AUTO HOUSE LTD. 16, others 9.
// 71% of the time the card printed another business's live licence number under
// "AUTO HOUSE — AMVIC PASS VALID". A real customer report landed on the correct
// 29% by luck. [[ai-defamation-entity-match-lesson]]
// ---------------------------------------------------------------------------
{
  const mk = (name, reg, extra = {}) => ({
    name, trade_name: "N/A", registration_number: reg, facility_status: "Issued",
    city: "Calgary", website: "N/A", expiry_date: "Jan-31-2027", ...extra,
  });
  // The real shape of the Auto House candidate set: the true row plus same-city
  // live neighbours that share the tokens "auto" and "house".
  const AH = [
    mk("AUTO HOUSE LTD.", "B1033010", { website: "www.autoshouse.com", expiry_date: "Jun-30-2027" }),
    mk("SUMMIT AUTO HOUSE LTD.", "B2039137"),
    mk("SUMMIT AUTO HOUSE LTD.", "B2039136"),
    mk("CANADA AUTO HOUSE LTD.", "B2036576"),
    mk("AUTO HOUSE SUNRIDGE LTD.", "B2013681"),
    mk("SG AUTO HOUSE & FINANCE LTD.", "B2022248"),
    mk("AUTO HOUSE JACKSONPORT LTD.", "B2033902", { facility_status: "Expired - Required to Reapply", website: "autoshouse.com" }),
  ];
  const shuffle = (arr, seed) => {
    const a = arr.slice();
    for (let j = a.length - 1; j > 0; j--) { const k = (seed * 7919 + j * 104729) % (j + 1); [a[j], a[k]] = [a[k], a[j]]; }
    return a;
  };
  const answers = (sig) => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = matchLicensee(shuffle(AH, i), sig);
      seen.add(r ? r.row.registration_number : "REFUSED");
    }
    return [...seen];
  };

  const withSite = answers({ dealerName: "Auto House", dealerCity: "Calgary", domains: ["autoshouse.com"] });
  check("200 row orderings, with the website, give ONE answer",
    withSite.length === 1 && withSite[0] === "B1033010", `got ${JSON.stringify(withSite)}`);

  const nameOnly = answers({ dealerName: "Auto House", dealerCity: "Calgary" });
  check("200 row orderings, name only, give ONE answer",
    nameOnly.length === 1 && nameOnly[0] === "B1033010", `got ${JSON.stringify(nameOnly)}`);

  // An EXPIRED row sharing the same domain must never win over the live one.
  const expiredShares = matchLicensee(AH, { dealerName: "Auto House", dealerCity: "Calgary", domains: ["autoshouse.com"] });
  check("an expired row on the same domain never outranks the live licence",
    expiredShares && expiredShares.row.registration_number === "B1033010");
}

// ---- the website path, and what it refuses ---------------------------------
{
  const rows = [
    { name: "XPERTS AUTO SALES LTD.", trade_name: "N/A", registration_number: "B2036047", facility_status: "Issued", city: "Calgary", website: "xpertsauto.ca", expiry_date: "Feb-28-2027" },
    { name: "AUTO EXPERT LTD.", trade_name: "AUTO EXPERT LTD.", registration_number: "B1044554", facility_status: "Expired - Required to Reapply", city: "CALGARY", website: "N/A", expiry_date: null },
  ];
  // The real case: the listing is on xpertsautos.com, AMVIC holds xpertsauto.ca,
  // and the page's own e-mail domain is what bridges them.
  const doms = pageDomains({ sourceUrl: "https://xpertsautos.com/cars/used/2017-tesla-modelx-613521", emails: ["sales@xpertsauto.ca"], statedWebsites: ["www.xpertsauto.com"] });
  check("an e-mail domain matches the registry when the host does not",
    doms.includes("xpertsauto.ca"));
  const hit = matchLicensee(rows, { dealerName: "", dealerCity: "", domains: doms });
  check("a website match identifies the dealer with no name at all",
    hit && hit.row.registration_number === "B2036047", hit ? hit.basis : "no match");

  check("an unrelated domain matches nothing",
    matchLicensee(rows, { dealerName: "", domains: ["someotherdealer.ca"] }) === null);

  // AMVIC's own website column contains e-mail addresses for some dealers,
  // including free-mail ones (DANIAS AUTO LTD. -> assumyhalabi@gmail.com).
  // Matching a page's gmail address against those would attach a real licence
  // to whichever row came back first.
  check("free mail is never an identity",
    pageDomains({ emails: ["bob@gmail.com", "x@hotmail.com"] }).length === 0);
  check("an e-mail-shaped registry website yields no host",
    normHost("assumyhalabi@gmail.com") === "");
  check("a vendor or placeholder domain is not the dealer",
    pageDomains({ emails: ["a@sentry.io", "you@domain.com"] }).length === 0);
}

// ---- two different companies, tied: refuse ---------------------------------
{
  const mk2 = (name, reg) => ({ name, trade_name: "N/A", registration_number: reg, facility_status: "Issued", city: "Calgary", website: "N/A", expiry_date: "Jan-31-2027" });
  // normName strips ltd/inc — which is exactly what separates these two real,
  // different companies. The tie check compares the RAW name for that reason.
  check("two different legal entities with identical evidence are REFUSED",
    matchLicensee([mk2("CITY MOTORS LTD.", "B111"), mk2("CITY MOTORS INC.", "B222")], { dealerName: "City Motors", dealerCity: "Calgary" }) === null);
  check("duplicate rows for ONE entity still answer",
    matchLicensee([mk2("CITY MOTORS LTD.", "B111"), mk2("CITY MOTORS LTD.", "B333")], { dealerName: "City Motors", dealerCity: "Calgary" }) !== null);
  check("a clear winner still wins",
    (matchLicensee([mk2("CITY MOTORS LTD.", "B111"), mk2("SUMMIT CITY MOTORS AND RV LTD.", "B222")], { dealerName: "City Motors", dealerCity: "Calgary" }) || {}).row?.registration_number === "B111");
}


// ---------------------------------------------------------------------------
// THE CALLER ACTUALLY USES IT.
//
// 2026-09-12: the website path was built, unit-tested against the real page and
// the real registry, and shipped — and the caller never passed it the domains.
// Every test above was green while the live report still said "No dealer name
// was confirmed" for a dealer whose licence was in our own table. A unit test
// of a matcher proves the matcher; it proves nothing about whether anything
// calls it. [[repeat-fix-pattern]] shape 2: built, tested, never wired.
//
// This reads the caller's source and asserts the wiring exists. It is a coarse
// check and it is deliberately coarse: it only has to fail when the connection
// is missing, which is exactly the failure that shipped.
// ---------------------------------------------------------------------------
{
  const src = readFileSync("supabase/functions/analyze-listing-url/index.ts", "utf8");

  check("the caller extracts the page's own domains",
    /domainsFromText\s*\(/.test(src),
    "domainsFromText is never called — the website path can never fire");

  check("the caller hands those domains to matchLicensee",
    /matchLicensee\([^)]*domains/s.test(src),
    "matchLicensee is called without `domains`, so it falls back to the listing host alone — " +
    "which is the exact case that failed: the host is xpertsautos.com, the registry holds xpertsauto.ca");

  check("the licence check no longer bails when only a domain is known",
    /!name\s*&&\s*!domains\.length/.test(src),
    "an early `if (!name) return` means a dealer whose name never extracted can never be matched, " +
    "even when their own e-mail domain is sitting in the registry");

  check("candidates are fetched by website as well as by name",
    /website\.ilike/.test(src),
    "the candidate query searches names only, so a row matchable by domain is never fetched for " +
    "the matcher to see");
}



// ── the city is the haystack, not the lead ─────────────────────────
// A signed report (LC-DEDF-526, 2026-09-16) told a buyer that Lexus of Edmonton
// held AMVIC licence B1021023. That licence belongs to CITY OF EDMONTON, the
// municipality. The probe was the LONGEST token of the dealer name -- 'edmonton',
// not 'lexus' -- so the read matched hundreds of Edmonton businesses, was capped
// at 60, and HERBLENS MOTORS INC. (trading as LEXUS OF EDMONTON) was not in the
// rows the matcher got to judge.
{
  check("the city's own name is not used to search for a dealer in that city",
    JSON.stringify(licenceProbes("Lexus of Edmonton", "Edmonton, AB")) === JSON.stringify(["lexus"]),
    JSON.stringify(licenceProbes("Lexus of Edmonton", "Edmonton, AB")));
  check("the longest token does not win when it is the city",
    licenceProbes("Lexus of Edmonton", "Edmonton, AB")[0] !== "edmonton",
    "'edmonton' is 8 characters and 'lexus' is 5; length is not selectivity");
  check("a dealer named after its city still gets a usable probe",
    licenceProbes("City of Edmonton", "Edmonton").length > 0,
    "an empty probe list means no name query at all");
  check("remaining tokens are ordered longest-first, and deterministically",
    JSON.stringify(licenceProbes("Lexus South Pointe", "Edmonton, AB")) === JSON.stringify(["pointe", "lexus", "south"]),
    JSON.stringify(licenceProbes("Lexus South Pointe", "Edmonton, AB")));
  check("a dealer outside the city keeps every token",
    licenceProbes("Advantage Ford", "Calgary, AB").length === 2,
    JSON.stringify(licenceProbes("Advantage Ford", "Calgary, AB")));

  // The matcher was never the problem. Given the right rows it prefers the
  // exact host; this pins that it still does, with the municipality present.
  const ROWS = [
    { name: "CITY OF EDMONTON", trade_name: "N/A", city: "Edmonton", facility_status: "Issued", registration_number: "B1021023", expiry_date: "Nov-30-2026", website: "N/A" },
    { name: "HERBLENS MOTORS INC.", trade_name: "LEXUS OF EDMONTON/CARDEALSTODAY.CA", city: "Edmonton", facility_status: "Issued", registration_number: "B1026602", expiry_date: "Mar-31-2027", website: "www.lexusofedmonton.ca" },
  ];
  const hit = matchLicensee(ROWS, { dealerName: "Lexus of Edmonton", dealerCity: "Edmonton, AB",
    domains: ["lexusofedmonton.ca"], website: "https://www.lexusofedmonton.ca/inventory/x/" });
  check("the dealer's own domain beats a municipality that shares its city name",
    hit && hit.row.registration_number === "B1026602", JSON.stringify(hit && hit.row));
  check("...and the municipality is never the answer for a car dealer",
    !hit || hit.row.name !== "CITY OF EDMONTON", JSON.stringify(hit && hit.row));

  // FOUND BY MUTATION: deleting the +500 exact-host bonus (the 2026-09-12 guard)
  // left every test green, because in the two-row fixture above HERBLENS already
  // wins on trade-name score alone. A test that passes for the wrong reason is
  // not protecting the thing it names. Here the NAME favours the wrong company
  // and only the registered domain can separate them.
  const RIVALS = [
    { name: "LEXUS OF EDMONTON LTD.", trade_name: "N/A", city: "Edmonton", facility_status: "Issued", registration_number: "B9999999", expiry_date: "Dec-31-2027", website: "N/A" },
    { name: "HERBLENS MOTORS INC.", trade_name: "LEXUS OF EDMONTON/CARDEALSTODAY.CA", city: "Edmonton", facility_status: "Issued", registration_number: "B1026602", expiry_date: "Mar-31-2027", website: "www.lexusofedmonton.ca" },
  ];
  const byHost = matchLicensee(RIVALS, { dealerName: "Lexus of Edmonton", dealerCity: "Edmonton, AB",
    domains: ["lexusofedmonton.ca"], website: "https://www.lexusofedmonton.ca/inventory/x/" });
  check("a registered domain outranks a better-looking name",
    byHost && byHost.row.registration_number === "B1026602",
    "a name is typed by whoever filled the form; a domain is registered. " + JSON.stringify(byHost && byHost.row));

  // FOUND BY MUTATION, ROUND TWO: the fixtures above are all resolved by the
  // EARLY exact-host short-circuit, which returns before any scoring happens --
  // so removing the host bonuses inside the scorer changed nothing and the
  // suite stayed green over a real regression. The short-circuit needs exactly
  // ONE live host match to fire, and the registry holds TWO rows for this
  // dealer (B1026602 and B2019050, same legal name, same website). That is the
  // real shape, and it falls through to the scorer, where the host bonus is the
  // only thing standing between the buyer and the municipality.
  const REAL = [
    { name: "CITY OF EDMONTON", trade_name: "N/A", city: "Edmonton", facility_status: "Issued", registration_number: "B1021023", expiry_date: "Nov-30-2026", website: "N/A" },
    { name: "HERBLENS MOTORS INC.", trade_name: "LEXUS OF EDMONTON/CARDEALSTODAY.CA", city: "Edmonton", facility_status: "Issued", registration_number: "B1026602", expiry_date: "Mar-31-2027", website: "www.lexusofedmonton.ca" },
    { name: "HERBLENS MOTORS INC.", trade_name: "LEXUS OF EDMONTON/CARDEALSTODAY.CA", city: "Edmonton", facility_status: "Issued", registration_number: "B2019050", expiry_date: "Mar-31-2027", website: "www.lexusofedmonton.ca" },
  ];
  const real = matchLicensee(REAL, { dealerName: "Lexus of Edmonton", dealerCity: "Edmonton, AB",
    domains: ["lexusofedmonton.ca"], website: "https://www.lexusofedmonton.ca/inventory/x/" });
  check("two licences for one dealer still never resolve to the municipality",
    real && real.row.name === "HERBLENS MOTORS INC.", JSON.stringify(real && real.row));
  check("...and the answer is the same whichever order the rows arrive in",
    JSON.stringify(matchLicensee(REAL.slice().reverse(), { dealerName: "Lexus of Edmonton", dealerCity: "Edmonton, AB",
      domains: ["lexusofedmonton.ca"], website: "https://www.lexusofedmonton.ca/inventory/x/" })?.row?.registration_number)
      === JSON.stringify(real?.row?.registration_number),
    "a stable wrong answer is still wrong, but an unstable one cannot even be audited");
}

// ── a capped read must be ordered ────────────────────────────────
// aa77a97 fixed exactly this in scripts/lib/amvic-hosts.mjs. The runtime lookup
// in analyze-listing-url never got it, so it kept returning an arbitrary slice.
{
  const src = readFileSync("supabase/functions/analyze-listing-url/index.ts", "utf8");
  const fn = src.slice(src.indexOf("async function checkDealerLicence"), src.indexOf("async function checkDealerLicence") + 6000);
  const limits = (fn.match(/\.limit\(/g) || []).length;
  const orders = (fn.match(/\.order\(/g) || []).length;
  check("every capped read in the licence lookup is ordered",
    limits > 0 && orders >= limits,
    `${limits} .limit( call(s) and only ${orders} .order( call(s) -- an unordered capped read returns whichever rows Postgres felt like`);
  check("the domain query is not OR'd into the name query's row budget",
    fn.includes("website.ilike") && fn.includes("hosts.map("),
    "the website clause shares a capped result set with hundreds of name matches, so the one " +
    "decisive signal we hold can be truncated away");
  check("the probe is chosen by selectivity, not by length",
    fn.includes("licenceProbes(") && !fn.includes("b.length - a.length"),
    "the longest token of 'Lexus of Edmonton' is the city it sits in");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
