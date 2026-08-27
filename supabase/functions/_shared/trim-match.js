// ============================================================================
// Trim fingerprinting — pick the RIGHT trim's MSRP from the catalog.
//
// The problem this solves (structural, not per-dealer): a model like the Toyota
// bZ or Camry has several trims spanning thousands of dollars. A single "base"
// row is wrong for any specific trim, and a wrong MSRP is worse than a blank one
// (it misleads). This scores every candidate trim against everything we can read
// from a listing and returns the best match — or flags ambiguity so the caller
// shows "starting at $X" instead of guessing.
//
// Signals, strongest first:
//   1. VIN decode (drivetrain/body)  — most authoritative, free (NHTSA)
//   2. Drivetrain (FWD/AWD)          — splits most lineups instantly
//   3. Trim-name tokens              — order-independent ("AWD XLE" == "XLE AWD")
//   4. Distinctive features          — e.g. Digital Key 2.0 = XLE/XSE only
//   5. Price proximity               — asking sits next to the right trim's MSRP
//
// Plain ES module (no TS annotations) so it runs UNCHANGED in both Deno (the
// edge functions) and Node (the regression test) — one source of truth, no drift.
// Pure + defensive: no I/O, never throws.
// ============================================================================

// "2wd" was missing. It is a drivetrain designation like every other entry
// here, and leaving it among the content tokens made Honda's "LX 2WD" row
// look like a strictly MORE SPECIFIC trim than "LX AWD", which downgraded a
// correctly matched HR-V LX AWD from "exact" to "starting_at". Stripped for
// NAME comparison only: normDrive() deliberately does NOT read it, because 2WD
// means front- or rear-wheel drive depending on the vehicle and we do not guess.
const DRIVE_WORDS = /\b(fwd|awd|rwd|2wd|4wd|4x4|4matic|4motion|xdrive|quattro)\b/g;

// Catalog trim names arrive with HTML ENTITIES still in them -- Mazda stores
// "MAZDA CX-90 MILD HYBRID INLINE 6 TURBO GT&#8209;P", where &#8209; is a
// non-breaking hyphen. Left encoded, that becomes the token "8209", a
// discriminating token no listing can ever match, so a genuine "GT-P" listing
// scored no better against its own row than against the plain "GT" row and
// resolved to the cheaper trim. Decoded here rather than only at write time,
// because the rows already in the table carry the entity today.
function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&ndash;/gi, "-").replace(/&mdash;/gi, "-");
}

function unifyDashes(s) {
  return decodeEntities(s).replace(/[‐-―−]/g, "-");
}

// Normalize a trim/model string: lowercase, unify dashes, strip fuel words,
// collapse to space-separated alphanumerics.
function norm(s) {
  return unifyDashes(s).toLowerCase()
    .replace(/\b(hybrid|phev|plug-?in|bev|electric|gas(oline)?|diesel)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Content tokens = normalized tokens WITHOUT drivetrain words (drivetrain is
// scored on its own, so it must not double-count in name overlap).
function contentTokens(s) {
  return norm(s).replace(DRIVE_WORDS, " ").split(/\s+/).filter(Boolean);
}

function normDrive(s) {
  const t = unifyDashes(s).toLowerCase();
  if (!t) return null;
  if (/all.?wheel|\bawd\b|4matic|4motion|xdrive|quattro|\b4wd\b|4x4/.test(t)) return "AWD";
  if (/front.?wheel|\bfwd\b/.test(t)) return "FWD";
  if (/rear.?wheel|\brwd\b/.test(t)) return "RWD";
  return null;
}

function fuelKind(s) {
  const t = String(s == null ? "" : s).toLowerCase();
  if (/phev|plug/.test(t)) return "phev";
  if (/hybrid/.test(t)) return "hybrid";
  if (/bev|electric|\bev\b/.test(t)) return "bev";
  if (/diesel/.test(t)) return "diesel";
  return "gas";
}

// Trim tokens that carry real grade meaning (weighted higher than filler words).
const KEY_TOKENS = new Set([
  "xle","xse","se","le","limited","platinum","nightshade","trd","sr","sr5",
  "touring","preferred","sport","premium","ultimate","calligraphy","denali",
  "laramie","rubicon","sahara","raptor","lariat","woodland","prime","n","type",
  "signature","select","essential","technology","luxury","execline","progressif",
  "gt",
  // Honda/Acura/Kia grade ladders. Missing, these scored the CORRECT row a
  // feeble +1: a 2027 HR-V EX-L AWD listing tied its own EX-L row ($39,200)
  // against "LX AWD" ($33,100, +4 on the drivetrain word alone), and the
  // ambiguous-tie rule then anchored the report $6,100 low on the cheaper row
  // (albertahonda.com, 2026-08-14). A grade the manufacturer prints on the
  // car is the strongest name evidence there is -- same reasoning the rest of
  // this list was built on.
  "ex","lx","dx","exl",
  // Lexus grade ladder. "Executive" was missing, and its absence is what let a
  // 2026 NX 350h Premium resolve to the Executive row at $70,878 (2026-08-27).
  "executive",
]);

function keyTokens(s) {
  return contentTokens(s).filter((t) => KEY_TOKENS.has(t));
}

// A row expresses a drivetrain either in its own column or inside its trim
// name ("XSE AWD"). Used for scoring and for the configuration test below.
function rowDrive(r) {
  return normDrive(r && r.drivetrain) || normDrive(r && r.trim);
}

// The drivetrain the listing claims, from any of the three places it can appear.
// Wider than `wantDrive` in the scorer on purpose: a drivetrain read out of a
// free-text trim string is weak evidence for RANKING rows, but it is still the
// buyer being told this car is AWD, so it must count when we decide whether we
// may call a figure exact.
function statedDrive(s) {
  return normDrive(s.drivetrain) || normDrive(s.vinDrive) || normDrive(s.trim);
}

// CONFIGURATION CONFIRMATION — the fix for the Mach-E false accusation.
//
// Catalog rows pin a TRIM, not a CONFIGURATION. Ford publishes one Mach-E
// "Premium" row at $49,990 and sells AWD and extended range as options above
// it. A listing for a Premium AWD matched that row on the token "premium",
// scored a clear win, and was labelled basis:"exact" — so the report treated a
// five-figure options gap as though the catalog had priced this exact car.
// Downstream that produced a $13,018 "inflated sticker" accusation against a
// named dealer.
//
// The tell was available the whole time and ignored: the listing STATED a
// drivetrain and the matched row did not pin one. "exact" has to mean the row
// describes THIS car, not merely that it shares a trim name with it. So the
// winning row must itself express the drivetrain the listing claims.
//
// Conservative on purpose. A single-drivetrain model whose catalog omits the
// column (Land Cruiser, all 4WD) gets labelled "starting at" even though its
// figure is right. That costs a precise label on a figure the report still
// shows; the alternative cost a named dealer a false accusation.
function rowConfirmsConfig(r, s) {
  const stated = statedDrive(s);
  if (!stated) return true;            // nothing claimed -> nothing to confirm
  return rowDrive(r) === stated;       // the row must pin the same configuration
}

// PRICE PLAUSIBILITY CEILING — same failure class as rowConfirmsConfig, one
// layer deeper: several real trims can share ONE drivetrain (a model sold as
// "base AWD" / "AWD + package A" / "AWD + package B", all literally AWD), so
// drivetrain-confirmation alone cannot tell them apart. If the catalog is
// missing the higher-package rows (confirmed live, 2026-08-13: the IONIQ 9's
// $76,499 and $81,499 package trims were absent, leaving only $59,999/
// $64,999/$64,999 to compare against), the matcher confidently calls the
// closest AVAILABLE row "exact" against an asking price it isn't remotely
// close to — southtrailkia's sibling defect, but for MSRP instead of price:
// $83,899 asking matched to a $64,999 "exact" row read as an $18,900 "over
// MSRP" accusation against a named dealer, when the real explanation was a
// missing catalog row, not dealer padding.
//
// A genuine dealer markup this large on a mainstream new vehicle is far less
// likely than an incomplete catalog. Past BOTH 20% AND $6,000 over the
// winning row, the confident "exact" claim costs more than it's worth --
// downgrade to "starting_at" so the report shows the honest floor instead of
// a specific accusation. Both thresholds required (not either alone) so a
// cheap car with a large percentage and an expensive car with a large
// absolute gap are each still judged on the other -- same calibration
// already proven safe for the inflation-callout ceiling (3.1%/$1,350 and
// 11.9%/$4,965 real padding cases both still get caught).
function priceImplausible(rowMsrp, askingPrice) {
  if (!(Number(askingPrice) > 0) || !(Number(rowMsrp) > 0)) return false; // nothing to compare -> not implausible
  const gap = Number(askingPrice) - Number(rowMsrp);
  return gap > Number(rowMsrp) * 0.20 && gap > 6000;
}

// Does another row in this ladder carry the SAME trim name at a materially
// different price? If so we cannot say which one a listing naming that trim
// means, and publishing either as the exact MSRP is a coin flip on the
// difference. Caught on the 2026 Lexus NX, where a case-sensitive write-side
// dedupe left "LUXURY" $58,025 beside "Luxury" $62,165 -- $4,140 apart, one
// trim name. The row is still the best answer available, so it is still
// returned; it is just labelled "starting_at" instead of "exact".
//
// $500 is the same threshold the clear-winner rule uses: below it, either row
// is an accurate answer to the buyer's question. [[msrp-exact-must-pin-config]]
function trimNameIsAmbiguous(pool, row) {
  const norm = (t) => String(t == null ? "" : t).trim().toLowerCase().replace(/\s+/g, " ");
  const key = norm(row.trim);
  if (!key) return false;
  // Rows the CATALOG itself distinguishes are not ambiguous. Ford's Mach-E
  // ladder legitimately carries "Premium" twice -- RWD $49,990 and AWD $56,990
  // -- and the drivetrain column plus the listing's own drivetrain resolves
  // that cleanly. Only a name collision with nothing to tell the rows apart is
  // a coin flip.
  const drive = norm(row.drivetrain);
  return pool.some((r) => r !== row
    && norm(r.trim) === key
    && norm(r.drivetrain) === drive
    && Math.abs(Number(r.msrp) - Number(row.msrp)) >= 500);
}
// Does the pool hold a trim that is everything the winning row is, PLUS more?
// "X-Line Limited" is a strict superset of "X-Line"; "GT-P" of "GT". Only
// DISCRIMINATING tokens count, so the shared model-name noise never makes one
// row look like a superset of another.
function hasMoreSpecificSibling(pool, row, common) {
  const disc = (t) => new Set(contentTokens(t).filter((x) => !common.has(x)));
  const mine = disc(row.trim);
  if (!mine.size) return false;
  return pool.some((r) => {
    if (r === row) return false;
    const theirs = disc(r.trim);
    if (theirs.size <= mine.size) return false;
    for (const t of mine) if (!theirs.has(t)) return false;   // must contain ALL of mine
    return true;
  });
}

// rows: [{ trim, msrp, fuel_type?, drivetrain?, attrs? }]
// sig:  { trim?, drivetrain?, fuelType?, quotedPrice?, features?[], vinDrive?, vinBody? }
// returns { msrp, trim, basis: "exact"|"starting_at", score } or null.

export function pickTrimMsrp(rows, sig) {
  const s = sig || {};
  const valid = (rows || []).filter((r) => r && Number(r.msrp) > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    const r = valid[0];
    // One row cannot pin a configuration the listing names, so the same test
    // applies here — a lone row is the likeliest place to over-claim.
    const exact = !!r.trim && rowConfirmsConfig(r, s) && !priceImplausible(r.msrp, s.quotedPrice);
    return { msrp: Number(r.msrp), trim: r.trim || null, basis: exact ? "exact" : "starting_at", score: 0 };
  }

  // 1) Fuel partition — never cross hybrid / gas / bev / phev.
  const wantFuel = fuelKind(s.fuelType) !== "gas" ? fuelKind(s.fuelType)
    : (/hybrid|phev/i.test(String(s.trim || "")) ? "hybrid" : "gas");
  let pool = valid.filter((r) => fuelKind(r.fuel_type) === wantFuel);
  if (pool.length === 0) pool = valid.slice(); // fuel unknown/mismatch -> keep all

  const wantDrive = normDrive(s.drivetrain) || normDrive(s.vinDrive);
  const wantTokens = new Set(contentTokens(s.trim));
  const wantKeys = keyTokens(s.trim);
  const price = Number(s.quotedPrice) > 0 ? Number(s.quotedPrice) : null;
  const feats = new Set((s.features || []).map((f) => String(f).toLowerCase()));

  // TOKENS THAT ACTUALLY DISCRIMINATE. Catalog trim names often repeat the
  // whole model description on every row -- Mazda stores "MAZDA CX-90 MILD
  // HYBRID INLINE 6 TURBO GT" and "... TURBO GT-P" -- so most tokens carry no
  // information about WHICH trim this is. Anything present on every row in the
  // pool is noise; what is left is the grade.
  const common = pool.length > 1
    ? pool.map((r) => new Set(contentTokens(r.trim)))
        .reduce((acc, set) => new Set([...acc].filter((t) => set.has(t))))
    : new Set();

  const scored = pool.map((r) => {
    let sc = 0;
    // Drivetrain — strong: match +4, mismatch -6 (near-exclusion). Reads the
    // trim name as well as the column, so a catalog that encodes drivetrain as
    // "XSE AWD" still discriminates instead of scoring it as unknown.
    const rDrive = rowDrive(r);
    if (wantDrive && rDrive) sc += wantDrive === rDrive ? 4 : -6;
    // Trim-name token overlap (order-independent, drivetrain words excluded).
    for (const t of contentTokens(r.trim)) if (wantTokens.has(t)) sc += KEY_TOKENS.has(t) ? 2 : 1;
    // Trim-name CONFLICT — both sides name a grade and they share none of them.
    // Without this, overlap could only ever add, so a row that matched on
    // drivetrain alone (+4) outscored the correctly-named trim (+2): a Premium
    // AWD listing picked the "GT AWD" row at $69,990 and called it exact. A
    // grade the manufacturer did not print on this car is disqualifying
    // evidence, so it has to be able to cost more than drivetrain can win.
    const rKeys = keyTokens(r.trim);
    if (wantKeys.length && rKeys.length && !rKeys.some((t) => wantKeys.includes(t))) sc -= 5;
    // A row whose grade name we do not RECOGNISE used to escape that penalty
    // entirely and win by being the only unpunished candidate. Caught live
    // 2026-08-27 on a 2026 Lexus NX 350h Premium: "premium" is a KEY_TOKEN, so
    // every correctly-named row ("Luxury", "F SPORT 2/3", "Ultra Luxury") took
    // the -5, while "Executive" -- a real Lexus grade that simply was not in
    // KEY_TOKENS -- scored 0 and won at $70,878 against a car asking $62,005.
    //
    // Naming an unrecognised grade is still naming a DIFFERENT grade than the
    // one the listing states, so it has to cost something. It costs less than a
    // recognised conflict (-3 vs -5) because the evidence is weaker: our
    // vocabulary being incomplete is our gap, not the row's fault. Rows with no
    // grade words at all (a bare "AWD", or an empty trim) are untouched -- they
    // make no competing claim.
    else if (wantKeys.length && !rKeys.length && contentTokens(r.trim).length) sc -= 3;
    // A ROW MAY NOT BE MORE SPECIFIC THAN THE LISTING. "GT-P" contains "GT",
    // so a listing that says GT matches the GT row and the GT-P row equally on
    // overlap alone -- and nothing else told them apart, so the asking price
    // decided (see the tiebreaker below). Choosing the more specific row
    // UPGRADES the buyer's car without evidence and, because the package trim
    // costs more, overstates the MSRP their price is measured against.
    //
    // Caught live 2026-08-27 on a 2025 Mazda CX-90 MHEV GT AWD: the report
    // anchored to the GT-P row at $59,650 when the GT row at $55,700 is the
    // car the listing names. Only DISCRIMINATING tokens count, so the shared
    // model-name noise cannot punish a verbose catalog.
    for (const t of contentTokens(r.trim)) {
      if (common.has(t) || wantTokens.has(t)) continue;
      sc -= KEY_TOKENS.has(t) ? 2 : 1;
    }
    // Distinctive features from attrs (e.g. { digitalKey2: true }).
    const attrs = r.attrs || {};
    for (const k of Object.keys(attrs)) {
      if (attrs[k] === true) {
        if (feats.has(k.toLowerCase())) sc += 2;      // listing has this defining feature
        else if (feats.size > 0) sc -= 1;             // feature set known, this trim's marker absent
      }
    }
    return { r, sc };
  });

  // PRICE PROXIMITY IS NOT EVIDENCE OF TRIM. This block used to ADD to the
  // score before the sort, which let the asking price outrank the trim NAME --
  // the comment called it a tiebreaker while the code let it break ties it had
  // created. On the Mazda CX-90 above, an $8,000 dealer discount moved the ask
  // to $58,805, nearer the GT-P row ($59,650) than the GT row ($55,700), and
  // the car became a GT-P. That is backwards: a dealer who discounts harder
  // would make the same car appear to be a higher trim, and the MSRP the buyer
  // is measured against moves with the discount.
  //
  // The name decides. Price only orders rows that the name and drivetrain
  // could not separate at all, and even then it never beats the honest floor
  // rule below -- a genuine tie still resolves to the CHEAPEST of the tied
  // rows, labelled "starting_at", so we never overstate the sticker.
  scored.sort((a, b) => {
    if (b.sc !== a.sc) return b.sc - a.sc;
    if (!price) return 0;
    return Math.abs(Number(a.r.msrp) - price) - Math.abs(Number(b.r.msrp) - price);
  });
  const top = scored[0], second = scored[1];

  // No usable signal at all -> honest "starting at" = cheapest in the fuel pool.
  if (top.sc <= 0 && wantTokens.size === 0 && !wantDrive && feats.size === 0) {
    const base = pool.slice().sort((a, b) => Number(a.msrp) - Number(b.msrp))[0];
    return { msrp: Number(base.msrp), trim: base.trim || null, basis: "starting_at", score: 0 };
  }

  // Clear winner if it leads by >=2, or the runner-up's MSRP is within $500
  // (same price -> either is an accurate answer).
  const clear = !second || (top.sc - second.sc) >= 2 || Math.abs(Number(top.r.msrp) - Number(second.r.msrp)) < 500;
  if (clear) {
    // A clear winner among rows that cannot express the stated configuration is
    // still only the right TRIM, not the right CAR. Same for a winner whose own
    // MSRP isn't remotely close to what's actually being asked -- more likely a
    // missing higher-package row than a real markup (see priceImplausible).
    // A MORE SPECIFIC SIBLING MEANS WE CANNOT SAY "EXACT". The specificity rule
    // above correctly stops us UPGRADING the buyer to a package trim they did
    // not name -- but a listing titled "X-Line AWD" on a car that is really an
    // "X-Line Limited" is a real thing dealers write. Picking the base row is
    // the right FIGURE to show; calling it exact would license an over-MSRP
    // claim measured against the cheaper trim. So when the pool still holds a
    // strictly more specific sibling the listing did not rule out, the figure
    // stands and the label stays honest.
    const basis = (rowConfirmsConfig(top.r, s)
      && !priceImplausible(top.r.msrp, s.quotedPrice)
      && !trimNameIsAmbiguous(pool, top.r)
      && !hasMoreSpecificSibling(pool, top.r, common)) ? "exact" : "starting_at";
    return { msrp: Number(top.r.msrp), trim: top.r.trim || null, basis, score: top.sc };
  }

  // Genuinely ambiguous between materially different trims -> cheapest of the tie,
  // labelled starting_at so the report never presents a guess as the exact MSRP.
  const tied = scored.filter((x) => x.sc === top.sc).sort((a, b) => Number(a.r.msrp) - Number(b.r.msrp));
  return { msrp: Number(tied[0].r.msrp), trim: tied[0].r.trim || null, basis: "starting_at", score: top.sc };
}
