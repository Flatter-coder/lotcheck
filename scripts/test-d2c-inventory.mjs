// D2C Media inventory adapter (2026-09-26). The fixture is Wheaton Honda's own
// used listing, trimmed to two real cards plus a real new-car record sitting
// outside any card, the way a sidebar carries one.
//
// Run: node scripts/test-d2c-inventory.mjs
import { readFileSync } from "node:fs";
import { parseD2cListing, d2cPageUrl, isD2cListing } from "./lib/d2c-inventory.mjs";
import { crawlD2cSection } from "./crawl-alberta-inventory.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? " -- " + detail : ""}`); } };
const html = readFileSync(new URL("./fixtures/d2c-used-cards.html", import.meta.url), "utf8");

const rows = parseD2cListing(html, "used");
const corolla = rows.find((r) => r.vin === "2T1BE4EE3AC033054");
check("a card becomes a row: VIN, year, make, model, trim, km, price, stock, fuel",
  corolla && corolla.year === 2010 && corolla.make === "Toyota" && corolla.model === "Corolla" && corolla.trim === "XRS"
  && corolla.odometer_km === 239372 && corolla.list_price === 10488 && corolla.stock_no === "26CVH8244A" && corolla.fuel_type === "Gas", JSON.stringify(corolla));
check("a structured record outside any card is never a car on this lot", rows.length === 2 && !rows.some((r) => r.vin === "2HGFE2F28TH114944"), rows.map((r) => r.vin).join());
const escape = rows.find((r) => /Escape/.test(r.model));
check("the card's own NEW flag does not make a 57,487 km Escape new -- its /used/ address does", escape?.condition === "used" && escape.odometer_km === 57487, JSON.stringify(escape));
check("the page is recognised as D2C", isD2cListing(html));
check("the pager address, used and new", d2cPageUrl("https://x.ca", "used", 2) === "https://x.ca/inventory.html?filterid=a1b1q2-10x0-0-0" && d2cPageUrl("https://x.ca", "new", 0) === "https://x.ca/inventory.html?filterid=a1b32q0-10x0-0-0");
check("a page of any other shape yields nothing", parseD2cListing("<html>no cars</html>", "used").length === 0);

// Paging: featured cards repeat on every page; a page adding no new VIN is the end.
{
  const [a, b] = html.split(/(?=<li class="carBoxWrapper")/).slice(1);
  const pages = [a + b, b, b];
  const asked = [];
  const r = await crawlD2cSection("https://x.ca", "used", { fetcher: async (u) => { asked.push(u); return pages[asked.length - 1] ?? ""; }, delayMs: 0 });
  check("walks pages until one adds nothing new, and keeps each car once", r.rows.length === 2 && asked.length === 2 && !r.partial, JSON.stringify({ n: r.rows.length, asked }));
  let threw = false;
  try { await crawlD2cSection("https://x.ca", "used", { fetcher: async () => { throw new Error("HTTP 403"); }, delayMs: 0 }); } catch { threw = true; }
  check("a first page that fails fails the section (never an empty lot)", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
