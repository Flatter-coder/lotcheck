// Regression suite for the AMVIC licensee matcher (check #11).
// Run: node scripts/test-amvic-match.mjs
//
// The defamation-safe contract is what these tests actually protect: a wrong
// or over-confident match would attach a real regulator status to the wrong
// business. Every "expect null" case below is a claim we must NOT make.

import { matchLicensee, classifyStatus, nameScore, pageDomains, normHost } from "../supabase/functions/_shared/amvic-match.js";

// Real shapes from AMVIC's registry (values observed live 2026-08-10).
const ROWS = [
  { name: "OKOTOKS TOYOTA LTD.", trade_name: "N/A", city: "Okotoks", facility_status: "Issued", registration_number: "B1001234", website: "www.okotokstoyota.ca" },
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
  ["Exact-ish legal name + city", { dealerName: "Okotoks Toyota", dealerCity: "Okotoks, AB" }, "OKOTOKS TOYOTA LTD."],
  ["Word-order flip", { dealerName: "Toyota of Okotoks", dealerCity: "Okotoks" }, "OKOTOKS TOYOTA LTD."],
  ["Corporate suffix in the query", { dealerName: "Kramer Mazda Ltd.", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],
  ["Closed dealer still matches (status is the point)", { dealerName: "Crowfoot Dodge Chrysler", dealerCity: "Calgary" }, "CROWFOOT DODGE CHRYSLER INC."],
  ["Expired dealer with live website", { dealerName: "North American EV", dealerCity: "Mountain View County" }, "North American EV Inc"],
  ["Website host clinches it", { dealerName: "Okotoks Toyota", website: "https://www.okotokstoyota.ca/new/inventory/x.html" }, "OKOTOKS TOYOTA LTD."],
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


console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
