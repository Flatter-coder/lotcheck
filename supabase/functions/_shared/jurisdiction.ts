// Which province is this dealer in — asked of every signal on the page, not
// just one.
//
// WHY. The Charlesglen RAV4 PHEV GR SPORT report told the buyer they were
// "$11,173 over MSRP". The true gap is $8,095. The other $3,078 is freight,
// PDI, A/C, AMVIC and the tire levy — Toyota's own itemised adds, printed as
// dealer markup.
//
// Nothing about the trim match was wrong: GR SPORT was identified correctly and
// $57,500 is its real ex-freight MSRP. What failed is the BASIS. Alberta
// mandates all-in advertised pricing, so $68,673 already contains those adds,
// and it must be compared against Toyota's all-in $60,578.
//
// The all-in path is gated on `analysis.allInPricing`, which came from
// resolveAllInAuthority(analysis.dealerCity) — ONE signal. The city did not
// extract from this page, so allInPricing was null, and null took the
// ex-freight branch. Absence of knowledge became knowledge of absence, in the
// single most consequential number the report prints.
//
// Meanwhile the page carried the province in several places: a (403) phone
// number, "Calgary" in the dealer's own address block, charlesglentoyota.com,
// and the listing URL itself. Any one of them settles it.
//
// TWO CHANGES, and the second matters more:
//   1. Ask every signal, so the city failing to extract is no longer fatal.
//   2. When NONE of them answers, say UNKNOWN — and let the caller refuse the
//      comparison rather than quietly assume ex-freight. In an all-in province
//      that assumption is wrong by about $3,000 and always in the direction
//      that accuses the dealer.

export type Jurisdiction = { code: string | null; source: string; confident: boolean };

// Area codes, by province. Enough to settle the all-in provinces.
const AREA_CODES: Record<string, string> = {};
for (const [code, prov] of Object.entries({
  AB: "403,587,780,825,368",
  BC: "604,778,236,250,672",
  ON: "416,647,437,905,289,365,613,343,519,226,548,705,249,807,942",
  QC: "514,438,450,579,418,581,367,819,873,263,354,468",
  SK: "306,639", MB: "204,431", NS: "902,782", NB: "506", NL: "709", PE: "902",
}) ) for (const a of prov.split(",")) AREA_CODES[a] = code;

const CITY_HINTS: Record<string, string> = {};
for (const [prov, cities] of Object.entries({
  AB: "calgary,edmonton,red deer,lethbridge,airdrie,okotoks,st albert,sherwood park,grande prairie,medicine hat,fort mcmurray,spruce grove,leduc,cochrane,camrose,lloydminster",
  BC: "vancouver,surrey,burnaby,richmond,victoria,kelowna,abbotsford,coquitlam,langley,nanaimo,kamloops",
  ON: "toronto,ottawa,mississauga,brampton,hamilton,london,markham,vaughan,kitchener,windsor,oshawa,barrie",
  QC: "montreal,quebec,laval,gatineau,longueuil,sherbrooke,trois-rivieres,levis",
})) for (const c of cities.split(",")) CITY_HINTS[c] = prov;

const PROV_WORDS: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", ontario: "ON",
  quebec: "QC", "québec": "QC", saskatchewan: "SK", manitoba: "MB",
  "nova scotia": "NS", "new brunswick": "NB", newfoundland: "NL",
  "prince edward island": "PE",
};

/** Postal-code first letter -> province. Unambiguous for the all-in provinces. */
const POSTAL: Record<string, string> = { T: "AB", V: "BC", S: "SK", R: "MB", G: "QC", H: "QC", J: "QC", E: "NB", B: "NS", C: "PE", A: "NL" };

function scan(text: string): Jurisdiction | null {
  const t = String(text || "").toLowerCase();
  if (!t) return null;

  // Explicit province name is the strongest textual signal.
  for (const [word, code] of Object.entries(PROV_WORDS)) {
    if (t.includes(word)) return { code, source: `province name "${word}"`, confident: true };
  }
  // Postal code, e.g. "T3G 0B4".
  const pc = t.toUpperCase().match(/\b([A-Z])\d[A-Z]\s?\d[A-Z]\d\b/);
  if (pc && POSTAL[pc[1]]) return { code: POSTAL[pc[1]], source: `postal code ${pc[0]}`, confident: true };
  // Area code — only in a shape that is actually a phone number.
  const ph = t.match(/(?:^|[^\d])\(?([2-9]\d{2})\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/);
  if (ph && AREA_CODES[ph[1]]) return { code: AREA_CODES[ph[1]], source: `area code ${ph[1]}`, confident: true };
  // City name last: shared names exist ("London ON" vs UK), so lower trust.
  // Match the run-together form too — a dealer domain has no word boundaries
  // (stampedetoyotacalgary.com), and that is exactly the case that returned no
  // province while the city sat in the hostname.
  for (const [city, code] of Object.entries(CITY_HINTS)) {
    const bounded = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (bounded.test(t) || t.includes(city.replace(/\s+/g, ""))) {
      return { code, source: `city "${city}"`, confident: true };
    }
  }
  return null;
}

/**
 * Ask every signal the analysis carries. Order is by reliability, and the FIRST
 * confident answer wins — but every field is tried, so one failing to extract
 * can no longer disable the whole basis check.
 */
export function resolveJurisdiction(a: any): Jurisdiction {
  const fields: Array<[string, unknown]> = [
    ["province", a?.dealerProvince],
    ["city", a?.dealerCity],
    ["address", a?.dealerAddress],
    ["phone", a?.dealerPhone],
    ["dealer name", a?.dealerName],
    ["listing url", a?.url ?? a?.listingUrl],
    ["page text", a?.pageTextSample],
  ];
  for (const [name, value] of fields) {
    const hit = scan(value as string);
    if (hit?.code) return { ...hit, source: `${name}: ${hit.source}` };
  }
  return { code: null, source: "no province signal on the page", confident: false };
}

/** Provinces whose ADVERTISED price is regulator-mandated all-in. */
export const ALL_IN_PROVINCES = new Set(["AB", "ON", "BC", "QC"]);

/**
 * Returns true / false / null. NULL IS THE POINT: it means we could not tell,
 * and the caller must refuse the over/under claim rather than pick a basis.
 */
export function isAllInJurisdiction(a: any): { allIn: boolean | null; jurisdiction: Jurisdiction } {
  const j = resolveJurisdiction(a);
  if (!j.code) return { allIn: null, jurisdiction: j };
  return { allIn: ALL_IN_PROVINCES.has(j.code), jurisdiction: j };
}

/**
 * The dealer's CITY, from the same signals as the province.
 *
 * Google Places disambiguates far better with one — "Stampede Toyota, Calgary"
 * against a bare name — and the dealer-reputation lookup was receiving null
 * here. That is how a dealer with 3,369 reviews came back unchecked while its
 * city sat in the listing URL the whole time (stampedetoyotacalgary.com).
 */
export function resolveCity(a: any): string | null {
  const direct = String(a?.dealerCity || "").trim();
  if (direct) return direct;

  const hay = [a?.dealerAddress, a?.dealerName, a?.url ?? a?.listingUrl, a?.pageTextSample]
    .map((v) => String(v || "").toLowerCase()).join(" ");
  if (!hay) return null;

  // Longest name first so "medicine hat" wins over any shorter substring match
  // and a compound city is never truncated to its first word.
  const cities = Object.keys(CITY_HINTS).sort((x, y) => y.length - x.length);
  const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

  for (const c of cities) {
    // A dealer domain runs the words together (stampedetoyotacalgary.com), so a
    // word-boundary match would miss it. Check both the bare substring and a
    // boundary-anchored form, which is enough for a Places disambiguation hint.
    if (hay.includes(c) || hay.includes(c.replace(/\s+/g, ""))) return titleCase(c);
  }
  return null;
}

