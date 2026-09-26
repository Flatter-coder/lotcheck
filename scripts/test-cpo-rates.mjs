// Used-vehicle APR catalogue (Vic 2026-09-25). Fixtures are real official pages
// read that day, trimmed. Pins that every rate comes from the maker's own page
// with its term, and that a page of any other shape yields nothing.
//
// Run: node scripts/test-cpo-rates.mjs
import { readFileSync } from "node:fs";
import { readToyota, readSubaru, readNissan, readMini, readVw, gmLadders, gmLegal, readGm, readStatement, isoDate } from "./lib/cpo-rates.mjs";
import { TRACKED } from "./scrape-cpo-rates.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? " -- " + detail : ""}`); } };
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

const t = readToyota(fx("cpo-toyota.txt"), "u");
check("Toyota: one rate per term, as its table states", t.map((r) => `${r.term_months}:${r.apr}`).join() === "24:5.89,36:5.94,48:5.99,60:6.05,72:6.2", JSON.stringify(t.map((r) => [r.term_months, r.apr])));
const s = readSubaru(fx("cpo-subaru.txt"), "u");
check("Subaru: rates by model year, fewer terms for older years",
  s.length === 10 && s.some((r) => r.year_from === 2022 && r.year_to === 2026 && r.term_months === 60 && r.apr === 5.99)
  && s.filter((r) => r.year_from === 2019).length === 1, JSON.stringify(s.map((r) => [r.year_from, r.term_months, r.apr])));
check("Nissan: 'as low as 2.99% for up to 24 months', with that caveat kept", (() => { const n = readNissan(fx("cpo-nissan.txt"), "u")[0]; return n?.apr === 2.99 && n.term_months === 24 && /as low as/.test(n.conditions); })());
const m = readMini(fx("cpo-mini.txt"), "u")[0];
check("MINI: 3.49% for 24 months, the protection-product reduction and the expiry kept",
  m?.apr === 3.49 && m.term_months === 24 && /Protect and Save/.test(m.conditions) && m.valid_until === "2026-09-30", JSON.stringify(m));
const v = readVw(fx("cpo-vw.json"), "u");
check("VW: model, year and term from its own JSON; the balloon program left out",
  v.length > 0 && v.every((r) => r.program === "Volkswagen Financing") && v.some((r) => r.model_scope === "Golf" && r.year_from === 2022 && r.term_months === 84 && r.apr === 5.49) && v.every((r) => r.valid_until === "2026-09-30"));
check("VW: a '-' cell (term not offered) is not a 0% rate", !v.some((r) => r.apr === 0));
const lad = gmLadders(fx("cpo-gm-offers.txt"));
const L = gmLegal(fx("cpo-gm-399-legal.json"));
check("GM: the legal text names years, lenders and the end date", L.yearFrom === 2021 && L.yearTo === 2027 && L.lender === "Royal Bank, Scotiabank or TD" && L.validUntil === "2026-09-30", JSON.stringify({ ...L, body: undefined }));
const g = readGm(lad, { "399-financing": L }, "u");
check("GM: a ladder becomes rows only with its eligibility read", g.length === 6 && g.every((r) => /Equinox/.test(r.model_scope)) && readGm(lad, {}, "u").length === 0, JSON.stringify(lad));
check("Honda: its own words that the lender sets each buyer's rate", readStatement("Honda", fx("cpo-honda.txt"), "u")[0]?.status === "lender_discretion");
check("Infiniti: offers CPO rates, states no number", readStatement("Infiniti", fx("cpo-infiniti.txt"), "u")[0]?.status === "no_number");
check("any other page shape yields nothing, never a guess",
  readToyota("<p>Rates from 1.9%</p>", "u").length === 0 && readNissan("", "u").length === 0 && readMini("3.49% APR", "u").length === 0 && readStatement("Honda", "rates vary", "u").length === 0);
check("dates are read as the maker wrote them", isoDate("Offers expires September 30, 2026") === "2026-09-30" && isoDate("soon") === null);
check("the survey's 22 makes are all tracked, so an unread make counts against the check mark", TRACKED.length === 22 && new Set(TRACKED).size === 22);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
