// ============================================================================
// Is this ONE vehicle's page, or a list of many?
//
// WHY THIS EXISTS. A pasted link to an inventory or search-results grid cannot
// produce a single-vehicle report, and we must refuse it BEFORE paying for the
// extraction. The original rule was "more than one checksum-valid VIN in the
// page text means a grid", which was cheap, deterministic, and WRONG on a
// large class of real listings:
//
//     https://www.advantageford.ca/inventory/2025-gmc-acadia-elevation-...
//
// is one vehicle's page. It states SIX valid VINs: the GMC Acadia it is about
// (1GKENNRS8SJ240715) and five Fords and a Mazda in a "similar vehicles" rail
// down the page. Vic pasted it and got "Sorry, we can't process a page with
// multiple vehicles" -- a refusal, on a real VDP, with the customer's own
// vehicle sitting at the top of the page.
//
// THE COUNT WAS ANSWERING THE WRONG QUESTION. How many vehicles a page
// MENTIONS is not how many it is ABOUT. A detail page mentions its neighbours;
// a grid declares nothing. So the question becomes: does this page NAME its
// subject? Every dealer platform answers that in machine-readable form --
// schema.org Vehicle/Car nodes, Convertus's vmsData, D2C's __vdpJSON -- and
// this repo already reads all three on every scan for other reasons, so the
// evidence is in hand and costs nothing extra.
//
//     exactly one vehicle declared  -> a detail page, however many it mentions
//     several declared              -> a grid with per-card structured data
//     none declared, several found  -> a grid with no structured data: refuse
//
// Pure and offline so multi-vehicle.test.ts can pin every branch. The old
// counter lived inline in analyze-listing-url/index.ts with no test at all.
// ============================================================================

import { validateVin } from "./invariants.ts";

/**
 * Every DISTINCT checksum-valid VIN in a blob of text, in first-seen order.
 *
 * Checksum-valid only, and that guard earns its keep: SVG path data
 * (`<path d="M16 4V4H13V16H11ZM14 ...">`) collapses into 17-character
 * alphanumeric runs that match a naive VIN shape. The Advantage Ford page
 * carries two of them -- 16V4H13V16H11ZM14 and 16V4H15V16H14ZM17 -- and
 * without the check digit they alone would push a genuine single-vehicle page
 * over any count-based threshold.
 */
export function distinctValidVins(text: string): string[] {
  const seen = new Set<string>();
  const re = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const check = validateVin(m[0]);
    if (check.valid) seen.add(check.vin!);
  }
  return [...seen];
}

export type PageSubject =
  | { kind: "single"; subjectVin: string | null; why: string }
  // `blameThePage` separates "this page really is a grid" from "we never got a
  // look at it". Both refuse -- missing beats wrong -- but only the first is
  // the page's fault, and only the first may write a 2h/24h lockout row
  // against the URL. A slow fetch must never durably punish a real listing.
  | { kind: "multi"; why: string; blameThePage: boolean };

/**
 * Decide what KIND of page this is from evidence, never from a threshold.
 *
 * `foundVins`   every valid VIN in the fetched page text (the old signal)
 * `declaredVins` VINs on schema.org vehicle nodes -- what the page says it is ABOUT
 * `blobVin`     the subject VIN from a platform's own vehicle-data blob
 *               (Convertus vmsData / D2C __vdpJSON), for pages with no JSON-LD
 */
export type Declaration = { count: number; vins: string[]; anchoredVin: string | null };

export function classifyVehiclePage(
  foundVins: string[],
  declaredRaw: Declaration,
  blobVinRaw: string | null,
  sawPageSource = true,
): PageSubject {
  // CHECKSUM THE DECLARATION TOO. The reader checks SHAPE only -- 17 characters
  // from the VIN alphabet -- and a platform publishing a placeholder or a typo
  // in vehicleIdentificationNumber would otherwise become this page's permanent
  // "subject": a VIN no read can ever equal, so the mismatch guard would refuse
  // that listing on every single scan, forever. A declaration we cannot
  // validate is not a declaration -- but the NODE it came from still counts,
  // because a detail page is a detail page whether or not we can read its VIN.
  const declaredVins = [...new Set(declaredRaw.vins.filter((v) => validateVin(v).valid))];
  const anchored = declaredRaw.anchoredVin && validateVin(declaredRaw.anchoredVin).valid ? declaredRaw.anchoredVin : null;
  const blobVin = blobVinRaw && validateVin(blobVinRaw).valid ? blobVinRaw : null;
  // One VIN on the page is the case that never needed any of this.
  if (foundVins.length <= 1) {
    return { kind: "single", subjectVin: blobVin || anchored || declaredVins[0] || foundVins[0] || null, why: "the page states at most one VIN" };
  }

  // THE RAIL IS MARKED UP TOO, on the platforms that do it properly: every card
  // in the similar-vehicles strip gets its own Car node, so the page declares
  // several. The one whose url/@id IS this page is the subject; the rest are
  // the rail. Refusing on the node count alone would cost those pages their
  // scan for being better marked up than the ones that pass.
  if (anchored) {
    return { kind: "single", subjectVin: anchored, why: `${declaredRaw.count} vehicles are marked up and one of them (${anchored}) is this page itself` };
  }

  // The page declares exactly one vehicle. It MENTIONS others -- a recommended
  // rail, a recently-viewed strip, a comparison block -- and that is what a
  // detail page looks like. subjectVin may be null when its VIN string is
  // unusable: still a detail page, the pin simply does not arm.
  if (declaredRaw.count === 1) {
    const vin = declaredVins[0] ?? null;
    return { kind: "single", subjectVin: vin ?? blobVin, why: `the page declares one vehicle${vin ? ` (${vin})` : " (with no usable VIN)"} and mentions ${foundVins.length - 1} more` };
  }

  // No structured vehicle nodes, but a platform blob names the one unit this
  // page is for. Same answer from a different, equally deterministic source.
  if (declaredRaw.count === 0 && blobVin) {
    return { kind: "single", subjectVin: blobVin, why: `the platform's own vehicle data names one subject (${blobVin})` };
  }

  // Several declared vehicles, none of them anchored to this URL: a grid whose
  // cards carry their own structured data -- the strongest possible evidence
  // for refusing, not against it.
  if (declaredRaw.count > 1) {
    return { kind: "multi", blameThePage: true, why: `the page declares ${declaredRaw.count} separate vehicles and none of them is this page` };
  }

  // Several VINs and nothing declared -- but did we actually LOOK? The
  // declaration is read from the page's own HTML, and that fetch can lose a
  // race, be blocked, or return a challenge shell. Refusing is still right
  // (we cannot tell which vehicle the buyer meant), but blaming the page for
  // our own blind spot would lock a real listing out for hours.
  if (!sawPageSource) {
    return { kind: "multi", blameThePage: false, why: `${foundVins.length} vehicles on the page and its own markup was never readable, so nothing could be established as the subject` };
  }

  // A grid with no structured data.
  // MISSING BEATS WRONG: we cannot tell which of these the buyer meant, and
  // guessing would produce a signed report about a car they never asked about.
  return { kind: "multi", blameThePage: true, why: `${foundVins.length} vehicles on the page and none declared as its subject` };
}

/**
 * Does the extraction describe the vehicle the page is ABOUT?
 *
 * Only meaningful on a page that mentions several VINs -- which we now accept
 * rather than refuse, so this is the other half of that change. If the reader
 * came back with a VIN belonging to one of the neighbours, it was reading the
 * wrong card, and every figure it read off that card is about the wrong car.
 * The page's own declaration outranks a prose read, which is already this
 * codebase's rule everywhere else structured data exists.
 */
/**
 * Does the extraction describe the same VEHICLE the page declares — not just
 * the same VIN?
 *
 * The VIN is the one field a wrong read is most likely to get RIGHT, because
 * it is stated once, prominently, at the top of the page. Year and make come
 * off whichever card was actually being read, and they are what drive the
 * recall lookup, the catalogue MSRP match and the comps — so a subject VIN
 * beside a neighbour's identity produces the wrong recalls and a wrong MSRP
 * denominator with the VIN guard fully armed and silent.
 *
 * Compared only when BOTH sides have a value: a declaration that omits the
 * year, or a read that missed the make, is not a contradiction.
 */
export function identityMismatch(
  read: { year?: unknown; make?: unknown },
  declared: { year?: unknown; make?: unknown } | null,
): string | null {
  if (!declared) return null;
  const norm = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rMake = norm(read?.make), dMake = norm(declared.make);
  if (rMake && dMake && rMake !== dMake) return `make ${rMake} vs declared ${dMake}`;
  const rYear = Number(read?.year), dYear = Number(declared.year);
  if (rYear > 1900 && dYear > 1900 && rYear !== dYear) return `year ${rYear} vs declared ${dYear}`;
  return null;
}

export function subjectMismatch(readVin: unknown, subjectVin: string | null): boolean {
  if (!subjectVin) return false;
  const r = String(readVin ?? "").trim().toUpperCase();
  if (r.length !== 17) return false;         // nothing usable read; not a mismatch
  return r !== subjectVin.toUpperCase();
}
