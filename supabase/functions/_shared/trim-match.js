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

const DRIVE_WORDS = /\b(fwd|awd|rwd|4wd|4x4|4matic|4motion|xdrive|quattro)\b/g;

function unifyDashes(s) {
  return String(s == null ? "" : s).replace(/[‐-―−]/g, "-");
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
    const exact = !!r.trim && rowConfirmsConfig(r, s);
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

  // Price proximity — nearest MSRP to the asking price is a tiebreaker.
  if (price) {
    let best = Infinity;
    for (const x of scored) best = Math.min(best, Math.abs(Number(x.r.msrp) - price));
    for (const x of scored) {
      const d = Math.abs(Number(x.r.msrp) - price);
      if (d === best) x.sc += 2;
      else if (d < 3000) x.sc += 1;
    }
  }

  scored.sort((a, b) => b.sc - a.sc);
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
    // still only the right TRIM, not the right CAR.
    const basis = rowConfirmsConfig(top.r, s) ? "exact" : "starting_at";
    return { msrp: Number(top.r.msrp), trim: top.r.trim || null, basis, score: top.sc };
  }

  // Genuinely ambiguous between materially different trims -> cheapest of the tie,
  // labelled starting_at so the report never presents a guess as the exact MSRP.
  const tied = scored.filter((x) => x.sc === top.sc).sort((a, b) => Number(a.r.msrp) - Number(b.r.msrp));
  return { msrp: Number(tied[0].r.msrp), trim: tied[0].r.trim || null, basis: "starting_at", score: top.sc };
}
