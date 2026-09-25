// Porsche Canada's configurator, as scrape-porsche.mjs reads it (2026-09-25).
// Fixtures are real pages, trimmed: a 2027 911 Carrera and a 2025 718 Cayman,
// whose asset path carries a five-character code and whose year the first
// version of this reader missed.
//
// Run: node scripts/test-porsche-configurator.mjs
import { readFileSync } from "node:fs";
import { configuratorCodes, parseConfigurator, splitName } from "./lib/porsche-configurator.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? " -- " + detail : ""}`); } };
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

const c = parseConfigurator(fx("porsche-911-carrera.html"), "9921B2");
check("911 Carrera: Porsche's own base price, year, destination and maximum dealer fee",
  c && c.name === "911 Carrera" && c.year === 2027 && c.base === 144900 && c.destination === 3200 && c.dealerFeeMax === 2750, JSON.stringify(c));
check("...and the itemised figures add up to Porsche's own estimated total",
  c && c.base + c.destination + c.dealerFeeMax + c.luxuryTax + 35 + 100 === c.total, JSON.stringify(c));
const k = parseConfigurator(fx("porsche-718-cayman.html"), "982120");
check("718 Cayman: the year comes from the page's tag, not a path the 718 spells differently",
  k && k.year === 2025 && k.base === 79500 && k.destination === 2950, JSON.stringify(k));
check("a page with no base price is not a row", parseConfigurator("<title>911 | Porsche Car Configurator (Canada)</title>", "X") === null);

check("codes are read once each, in page order",
  configuratorCodes('<a href="https://configurator.porsche.com/en-CA/mode/model/9921B2">a</a><a href="https://configurator.porsche.com/en-CA/mode/model/992182"></a><a href="https://configurator.porsche.com/en-CA/mode/model/9921B2"></a>').join() === "9921B2,992182");

check("nameplate and variant, the way a dealer lists them",
  JSON.stringify(splitName("911 Carrera T")) === JSON.stringify({ model: "911", trim: "Carrera T" })
  && JSON.stringify(splitName("718 Cayman GT4 RS")) === JSON.stringify({ model: "718 Cayman", trim: "GT4 RS" })
  && JSON.stringify(splitName("Cayenne")) === JSON.stringify({ model: "Cayenne", trim: null }));

const src = readFileSync(new URL("./scrape-porsche.mjs", import.meta.url), "utf8");
check("the MSRP basis is excl_freight, stated because Porsche lists base price apart from destination",
  /priceBasis:\s*"excl_freight"/.test(src) && !/priceBasisUnknown/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
