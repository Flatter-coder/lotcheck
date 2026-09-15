// ============================================================================
// What a VIN looks like — decided once.
//
// WHY THIS EXISTS. check:lineage put `vin` at the top of the multi-author list,
// and the survey behind that number was worse than the number: the same shape
// rule was written FOURTEEN times across the edge functions, in THREE different
// strengths, with the differences almost certainly accidental.
//
//   /^[A-HJ-NPR-Z0-9]{17}$/            shape, case-sensitive      (most sites)
//   /^[A-HJ-NPR-Z0-9]{17}$/i           shape, case-insensitive    (two sites)
//   shape && !/^(.)\1{16}$/            + rejects AAAA...A         (the three
//                                        platform extractors)
//
// Nothing chose those differences. A VIN arriving lower-cased is a real VIN at
// one site and not a VIN at the next; the placeholder `11111111111111111` is
// refused by the Convertus reader and accepted by the listing path that stores
// it. One question, three answers, none of them written down.
//
// WHAT THIS DOES NOT DO. It does not decide whether a VIN must pass its CHECK
// DIGIT to be published. `validateVin` in invariants.ts already computes the
// ISO 3779 digit and produces a reason a buyer can read, and it stays the
// authority on validity. This module owns only the question BELOW that one --
// is this string VIN-shaped at all -- which is what those fourteen expressions
// were each answering for themselves.
//
// The gap between them is worth stating plainly, because consolidating the
// shape rule makes it visible rather than closing it: a VIN can be accepted by
// every site here, stored, and published, while failing the check digit that
// invariants.ts is perfectly capable of computing. Whether acceptance should
// require that digit is a product decision, not a refactoring one.
//
// scripts/lib/golden.mjs keeps its OWN VIN check on purpose and must never
// import this. The answer key may not share a parser with the pipeline it
// grades, or a shared bug scores itself correct.
//
// Run tests (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/vin.test.ts
// ============================================================================

// I, O and Q are excluded by the standard precisely because they are confusable
// with 1, 0 and 0 -- which is why a VIN containing one is a mis-read, not a VIN.
const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/;

// Seventeen of the same character is a placeholder, not a vehicle. Only three
// of the fourteen sites rejected it; the rest would have stored it.
const ALL_ONE_CHAR = /^(.)\1{16}$/;

/** Trim, upper-case, strip internal whitespace. Null for anything unusable. */
export function normalizeVin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase().replace(/\s+/g, "");
  return v || null;
}

/**
 * Is this string VIN-SHAPED? Case-insensitive by normalising first, which is
 * the behaviour the two `/i` sites already had and the others got by accident
 * of their inputs happening to be upper-cased upstream.
 *
 * Says nothing about whether the VIN is real — see validateVin for that.
 */
export function isVinShape(raw: unknown): boolean {
  const v = normalizeVin(raw);
  return !!v && VIN_SHAPE.test(v);
}

/**
 * VIN-shaped AND not an obvious placeholder. What the platform extractors
 * require before they will put a VIN on a vehicle, and the stricter of the two
 * rules that were in the tree.
 */
export function isPlausibleVin(raw: unknown): boolean {
  const v = normalizeVin(raw);
  return !!v && VIN_SHAPE.test(v) && !ALL_ONE_CHAR.test(v);
}

/** The normalised VIN when it is plausible, else null. The extractors' idiom. */
export function plausibleVinOrNull(raw: unknown): string | null {
  const v = normalizeVin(raw);
  return v && VIN_SHAPE.test(v) && !ALL_ONE_CHAR.test(v) ? v : null;
}

/** The normalised VIN when it is VIN-shaped, else null. */
export function vinShapeOrNull(raw: unknown): string | null {
  const v = normalizeVin(raw);
  return v && VIN_SHAPE.test(v) ? v : null;
}
