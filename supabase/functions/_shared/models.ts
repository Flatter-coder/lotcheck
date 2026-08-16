// ============================================================================
// canonicalModel(make, model) — reduce a loosely-extracted model string to its
// CANONICAL base nameplate, WITHOUT depending on any database.
//
// Why this exists: resolveBaseModel() used to resolve trims only via msrp_catalog,
// which is empty in production — so it always returned null and the recall/MSRP
// lookups fell back to fuzzy candidate-dropping. That let edge cases slip
// ("bZ Woodland" never confirmed; "Mustang Mach-E" would wrongly prefix-match
// "Mustang"). This static map fixes the common + tricky Canadian models
// deterministically; unknown makes/models return null so callers fall back to
// the existing catalog + candidate logic (never a wrong match). See
// make-recalls-fail-safe.
//
// Matching rule: for the vehicle's make, pick the LONGEST canonical model M
// where the extracted model equals M or starts with "M " (case-insensitive).
// Longest-wins keeps multi-word nameplates intact — "Mustang Mach-E" beats
// "Mustang", "Grand Highlander" beats "Highlander", "Ioniq 5 N" beats "Ioniq 5".
// ============================================================================
import { canonicalMake } from "./makes.ts";

// make (canonical) -> its base model nameplates. Not exhaustive by design; it
// covers high-volume Canadian models plus the naming traps. Add rows freely.
export const CANONICAL_MODELS: Record<string, string[]> = {
  // EVERY NAME msrp_catalog IS KEYED BY MUST APPEAR HERE, or its rows are dead.
  // The lookup queries `model ilike <canonicalModel(...)>` with no wildcard, so
  // a row stored as "RAV4 Hybrid" is never returned to a listing that resolves
  // to "RAV4" — the seed looks done and the report finds nothing.
  //
  // "Crown Signia" is the dangerous one and the reason this is not cosmetic.
  // Without it, "Crown Signia Limited" resolves to "Crown" — a DIFFERENT car
  // (sedan, 2.5L THS vs Hybrid MAX, ~$3k apart at base) that also has a
  // "Limited" trim. The lookup would find an exact trim match on the wrong
  // vehicle and report it as authoritative. Same shape as the Mustang Mach-E
  // trap this file was written for. Guarded by scripts/test-catalog-reachable.mjs.
  Toyota: ["bZ", "bZ4X", "Corolla Cross Hybrid", "Corolla Cross", "GR Corolla", "Corolla",
    "Grand Highlander", "Highlander", "RAV4 Plug-in Hybrid", "RAV4 Prime", "RAV4 Hybrid", "RAV4",
    "Camry", "Prius Prime", "Prius", "Sienna", "Tacoma", "Tundra", "4Runner Hybrid", "4Runner",
    "Sequoia", "Venza", "C-HR", "Crown Signia", "Crown", "Supra", "GR86", "Mirai", "Land Cruiser"],
  Honda: ["Civic", "Accord", "CR-V", "HR-V", "Pilot", "Passport", "Ridgeline", "Odyssey", "Prologue"],
  Hyundai: ["Ioniq 5 N", "Ioniq 5", "Ioniq 6", "Kona Electric", "Kona", "Tucson", "Santa Fe", "Santa Cruz",
    "Palisade", "Elantra", "Sonata", "Venue"],
  Kia: ["Sportage", "Sorento", "Telluride", "Seltos", "Soul", "Forte", "K5", "Carnival", "EV6", "EV9",
    "Niro", "Rio", "Stinger", "Sportage PHEV", "Sorento PHEV"],
  Mazda: ["CX-30", "CX-5", "CX-50", "CX-70", "CX-90", "Mazda3", "MX-5", "MX-30"],
  Ford: ["F-150 Lightning", "F-150", "Super Duty", "Escape", "Explorer", "Edge", "Bronco Sport", "Bronco",
    "Ranger", "Maverick", "Mustang Mach-E", "Mustang", "Expedition"],
  Chevrolet: ["Silverado", "Equinox EV", "Equinox", "Blazer EV", "Blazer", "Trailblazer", "Trax", "Traverse",
    "Tahoe", "Suburban", "Colorado", "Malibu", "Corvette", "Bolt EUV", "Bolt EV", "Bolt"],
  GMC: ["Sierra", "Terrain", "Acadia", "Yukon", "Canyon", "Hummer EV"],
  Ram: ["1500", "2500", "3500", "ProMaster"],
  Jeep: ["Grand Cherokee", "Cherokee", "Wrangler", "Compass", "Gladiator", "Grand Wagoneer", "Wagoneer", "Renegade"],
  Nissan: ["Rogue", "Sentra", "Altima", "Kicks", "Murano", "Pathfinder", "Frontier", "Titan", "Ariya", "Leaf", "Versa", "Armada"],
  Subaru: ["Forester", "Outback", "Crosstrek", "Impreza", "Legacy", "Ascent", "WRX", "Solterra", "BRZ"],
  Volkswagen: ["Tiguan", "Atlas Cross Sport", "Atlas", "Jetta", "Golf", "Taos", "ID.4", "ID.Buzz", "Passat"],
  Tesla: ["Model 3", "Model Y", "Model S", "Model X", "Cybertruck"],
  Lexus: ["RX", "NX", "UX", "TX", "GX", "LX", "ES", "IS", "RZ"],
  Acura: ["MDX", "RDX", "Integra", "TLX", "ZDX"],
  Mitsubishi: ["Outlander PHEV", "Outlander", "RVR", "Eclipse Cross", "Mirage"],
};

export function canonicalModel(make: string, model: string): string | null {
  if (!make || !model) return null;
  const mk = canonicalMake(make);
  // Case-insensitive make-key match so "RAM"/"Ram"/"jeep" all resolve.
  const key = Object.keys(CANONICAL_MODELS).find((k) => k.toUpperCase() === String(mk).toUpperCase());
  const list = key ? CANONICAL_MODELS[key] : null;
  if (!list) return null;
  const m = String(model).trim().toUpperCase();
  let best: string | null = null;
  for (const cand of list) {
    const c = cand.toUpperCase();
    if (m === c || m.startsWith(c + " ")) {
      if (!best || cand.length > best.length) best = cand;
    }
  }
  return best;
}
