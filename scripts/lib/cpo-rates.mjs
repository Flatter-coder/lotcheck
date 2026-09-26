// Certified pre-owned (CPO) finance rates, read from each manufacturer's own
// Canadian site. Surveyed 2026-09-25 across 22 makes; these readers cover the
// ones whose official page states a rate, or states in its own words that it
// publishes none. Every reader returns [] when its page does not carry the
// shape it knows -- a changed page is a failure to report, never a guess.
//
// Row shape (cpo_rate_catalog):
//   { make, program, status, model_scope, year_from, year_to, term_months, apr,
//     lender, conditions, valid_until, source_url }
//   status: "published" (rate + term read) | "lender_discretion" (the maker
//   says the lender sets each buyer's rate) | "no_number" (the maker says it
//   offers CPO rates but states none).

// "September 30, 2026" and "Sep 30, 2026" (VW's JSON) both.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isoDate(s) {
  const m = String(s || "").match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/);
  const mo = m && MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}` : null;
}
export function pageText(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, "|")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\|\s*(\|\s*)+/g, "|").replace(/\s+/g, " ");
}
const pct = (s) => { const n = Number(String(s).replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n >= 0 && n < 30 ? n : null; };
const row = (o) => ({ model_scope: null, year_from: null, year_to: null, term_months: null, apr: null, lender: null, conditions: null, valid_until: null, ...o });

// Toyota: one table, "Terms in Months | 24 | 36 ... | Finance Rate (%) for All Vehicles | 5.89% | ..."
export function readToyota(html, url) {
  const t = pageText(html);
  const m = t.match(/Terms in Months\|((?:\d{2}\|)+)Finance Rate \(%\) for All Vehicles\|((?:[\d.]+%\|?)+)/);
  if (!m) return [];
  const terms = m[1].split("|").filter(Boolean).map(Number), rates = m[2].split("|").filter(Boolean).map(pct);
  if (!terms.length || terms.length !== rates.length) return [];
  const legal = (t.match(/\* ?Limited time purchase financing offer provided through Toyota Financial Services[^|]{0,120}/) || [])[0] || null;
  return terms.map((term, i) => row({ make: "Toyota", program: "Toyota Certified Used Vehicles", status: "published", model_scope: "all certified vehicles",
    term_months: term, apr: rates[i], lender: "Toyota Financial Services", conditions: legal, source_url: url }));
}

// Subaru: "Model Year | 24 MONTHS | 36 MONTHS ... | 2022 - 2026 | 3.99% | ... | 2021 | ..."
export function readSubaru(html, url) {
  const t = pageText(html);
  const h = t.match(/Model Year \|((?:\d{2} MONTHS\|)+)/);
  if (!h) return [];
  const terms = h[1].split("|").filter(Boolean).map((x) => Number(x.replace(/\D/g, "")));
  const out = [];
  const body = t.slice(t.indexOf(h[0]) + h[0].length);
  for (const r of body.matchAll(/(\d{4})(?:\s*-\s*(\d{4}))?\|((?:[\d.]+%\|)+)/g)) {
    const rates = r[3].split("|").filter(Boolean).map(pct);
    if (rates.length > terms.length) break;
    rates.forEach((apr, i) => out.push(row({ make: "Subaru", program: "Subaru Certified Pre-Owned", status: "published", model_scope: "all certified vehicles",
      year_from: Number(r[1]), year_to: Number(r[2] || r[1]), term_months: terms[i], apr, lender: "Subaru Financial Services by TCCI", source_url: url })));
    if (!r[2] && Number(r[1]) < 2015) break;
  }
  return out;
}

// Nissan: "Exclusive Certified Pre-Owned rates as low as 2.99% for up to 24 months"
export function readNissan(html, url) {
  const m = pageText(html).match(/Certified Pre-Owned rates as low as ([\d.]+)% for up to (\d+) months/i);
  return m ? [row({ make: "Nissan", program: "Nissan Certified Pre-Owned", status: "published", model_scope: "all certified vehicles",
    term_months: Number(m[2]), apr: pct(m[1]), conditions: "as low as; for up to that term; speak with your local dealer for details", source_url: url })] : [];
}

// MINI: "FINANCE RATES STARTING FROM 3.49 % APR * 24 months* Includes a 0.5% Protect and Save rate reduction"
export function readMini(html, url) {
  const t = pageText(html);
  // Rendered across separate elements: "STARTING FROM |3.49 |% |APR |* |24 months*"
  const m = t.match(/FINANCE RATES STARTING FROM[\s|]*([\d.]+)[\s|]*%[\s|]*APR[\s|*]*(\d+) months/i);
  if (!m) return [];
  const cut = t.match(/Includes a ([\d.]+)% Protect and Save rate reduction/i);
  const basis = t.match(/Finance offers based on select ([^|.]{5,80}?) MINI Certified Pre-Owned vehicles/i);
  return [row({ make: "MINI", program: "MINI NEXT Certified Pre-Owned", status: "published",
    model_scope: basis ? `select ${basis[1].trim()}` : "select certified vehicles", term_months: Number(m[2]), apr: pct(m[1]),
    lender: "MINI Financial Services Canada",
    conditions: [ "starting from", cut && `includes a ${cut[1]}% Protect and Save rate reduction` ].filter(Boolean).join("; "),
    valid_until: isoDate((t.match(/Offers expires ([A-Za-z]+ \d{1,2}, \d{4})/) || [])[1]), source_url: url })];
}

// Volkswagen: the public JSON the CPO page loads (globalapi.vwtools.ca/volkswagen/cpo-rates).
// The default program only; "Volkswagen Select" is a balloon program, not a rate.
export function readVw(json, url) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  const types = d?.data?.rates || [];
  const std = types.find((x) => x?.type?.details?.default === 1)?.type;
  if (!std) return [];
  const valid = isoDate(d?.data?.legal?.en?.valid_date);
  const out = [];
  for (const list of Object.values(std.models || {})) for (const mdl of list || []) {
    for (const r of mdl.rates || []) for (const k of Object.keys(r)) {
      const m = k.match(/^months(\d+)$/);
      const apr = m ? pct(r[k]) : null;
      if (!m || apr == null || !/\d/.test(String(r[k]))) continue;
      out.push(row({ make: "Volkswagen", program: std.details?.en || "Volkswagen Financing", status: "published", model_scope: mdl.model_details?.en || null,
        year_from: Number(r.year), year_to: Number(r.year), term_months: Number(m[1]), apr, lender: "Volkswagen Finance", valid_until: valid, source_url: url }));
    }
  }
  return out;
}

// GM (Chevrolet, Buick, GMC): each rate ladder on gmcpo.ca/offers links to its
// own legal text, which names the eligible models, years, lenders and dates.
export function gmLadders(html) {
  const u = String(html || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\\"/g, '"');
  const out = [];
  for (const b of u.matchAll(/FINANCING FOR 24 MONTHS ON ELIGIBLE CERTIFIED PRE-OWNED([\s\S]{0,3000}?)84 MONTHS[^%]{0,400}?([\d.]+)%/g)) {
    const block = b[0];
    const prog = (block.match(/benefit-disclosure\/([a-z0-9-]+)\//) || [])[1];
    const ladder = [...block.matchAll(/(\d{2}) MONTHS[^%]{0,300}?([\d.]+)%/g)].map((m) => ({ term: Number(m[1]), apr: pct(m[2]) }));
    if (prog && ladder.length && !out.some((o) => o.prog === prog)) out.push({ prog, ladder });
  }
  return out;
}
export function gmLegal(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  const body = String(d?.properties?.elements?.disclaimerBody?.value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const yrs = body.match(/include (\d{4})\s*[–-]\s*(\d{4})/);
  const models = (body.match(/include \d{4}\s*[–-]\s*\d{4}:\s*([^.]+)\./) || [])[1] || null;
  return { body, yearFrom: yrs ? Number(yrs[1]) : null, yearTo: yrs ? Number(yrs[2]) : null, models,
    validUntil: isoDate((body.match(/to ([A-Za-z]+ \d{1,2}, \d{4})/) || [])[1]),
    lender: /Royal Bank, Scotiabank or Toronto Dominion/i.test(body) ? "Royal Bank, Scotiabank or TD" : null,
    minFinanced: (body.match(/Minimum financed amount of (\$[\d,]+)/) || [])[1] || null };
}
export function readGm(ladders, legalByProg, url) {
  const out = [];
  for (const { prog, ladder } of ladders) {
    const L = legalByProg[prog];
    if (!L || !L.models) continue;     // eligibility unread: not a row we can stand behind
    for (const { term, apr } of ladder) out.push(row({ make: "GM", program: `GM Certified Pre-Owned (${prog})`, status: "published",
      model_scope: L.models.slice(0, 600), year_from: L.yearFrom, year_to: L.yearTo, term_months: term, apr, lender: L.lender,
      conditions: L.minFinanced ? `minimum financed ${L.minFinanced}` : null, valid_until: L.validUntil, source_url: url }));
  }
  return out;
}

// The makers that say, in their own words, that there is no single CPO rate.
export function readStatement(make, html, url) {
  const t = pageText(html);
  const S = {
    Honda: [/HFS will determine each buyer's applicable finance rate in its discretion/i, "lender_discretion", "Honda Financial Services"],
    Acura: [/AFS will determine each buyer's applicable finance rate in its discretion/i, "lender_discretion", "Acura Financial Services"],
    Infiniti: [/We offer preferred finance rates for Certified Pre-Owned vehicles/i, "no_number", "INFINITI Canada Finance"],
  }[make];
  const m = S && t.match(S[0]);
  return m ? [row({ make, program: `${make} Certified Pre-Owned`, status: S[1], model_scope: "all certified vehicles", lender: S[2], conditions: m[0], source_url: url })] : [];
}
