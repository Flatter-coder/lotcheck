// ============================================================================
// canonicalMake(raw) — map a loosely-extracted vehicle make onto the exact make
// string used in our catalogs (manufacturer_warranties), so the verified-
// warranty lookup doesn't miss on a common variant. Extractions vary: a listing
// may say "Mercedes", "Range Rover", "VW", "Chevy", or "Mercedes-Benz AMG" for
// makes stored as "Mercedes-Benz", "Land Rover", "Volkswagen", "Chevrolet".
//
// Strategy: exact normalized match → explicit alias → prefix match (either
// string is a >=3-char prefix of the other, longest wins). Unknown makes fall
// through unchanged, so the lookup simply misses and the report uses its
// unverified estimate — never a wrong match.
// ============================================================================
const CANONICAL_MAKES = [
  "Toyota","Honda","Hyundai","Kia","Ford","Chevrolet","GMC","Mazda","Volkswagen",
  "Nissan","Subaru","Lexus","Acura","Infiniti","Genesis","Mitsubishi","BMW",
  "Mercedes-Benz","Audi","Volvo","MINI","Porsche","Jeep","Ram","Dodge","Chrysler",
  "Fiat","Alfa Romeo","Cadillac","Buick","Lincoln","Tesla","Jaguar","Land Rover","Polestar",
];

const norm = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const CANON_BY_NORM: Record<string, string> = {};
for (const m of CANONICAL_MAKES) CANON_BY_NORM[norm(m)] = m;

// Explicit aliases (normalized variant -> canonical make).
const ALIASES: Record<string, string> = {
  mercedes: "Mercedes-Benz", mercedesbenz: "Mercedes-Benz", benz: "Mercedes-Benz",
  merc: "Mercedes-Benz", mb: "Mercedes-Benz", mercedesamg: "Mercedes-Benz",
  vw: "Volkswagen", volkswagon: "Volkswagen",
  chevy: "Chevrolet", chev: "Chevrolet",
  rangerover: "Land Rover", rover: "Land Rover", landrover: "Land Rover",
  alfa: "Alfa Romeo", alfaromeo: "Alfa Romeo",
  minicooper: "MINI",
  bimmer: "BMW", beemer: "BMW",
  hyundia: "Hyundai",
  ram1500: "Ram", ram2500: "Ram", ram3500: "Ram",
};

export function canonicalMake(raw: string | null | undefined): string {
  const n = norm(raw || "");
  if (!n) return raw || "";
  if (CANON_BY_NORM[n]) return CANON_BY_NORM[n];
  if (ALIASES[n]) return ALIASES[n];
  // Prefix match: the shorter of {extracted, canonical} must be a >=3-char
  // prefix of the longer. Longest canonical wins (so "mercedesbenzamg" and
  // "mercedes" both resolve to "mercedesbenz").
  let best = "";
  for (const cn of Object.keys(CANON_BY_NORM)) {
    if (cn.length < 3) continue;
    const shorter = n.length < cn.length ? n : cn;
    const longer = n.length < cn.length ? cn : n;
    if (shorter.length >= 3 && longer.startsWith(shorter) && cn.length > best.length) best = cn;
  }
  return best ? CANON_BY_NORM[best] : (raw || "");
}
