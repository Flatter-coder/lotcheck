// ============================================================================
// Sealed listing capture — pure helpers.
//
// The capture (a full-page screenshot of the listing) is client-supplied on the
// email path, so NOTHING here is trusted on arrival: shape, size, magic bytes,
// and pixel dimensions are all validated here, and the caller must additionally
// prove the bytes' SHA-256 is sealed inside the SIGNED canonical before using
// the words "sealed"/"fingerprint" anywhere (see verifySealedShot in
// email-quote-report). Pure and offline so capture.test.ts can pin every branch
// (no-regressions-durable-fixes).
//
// Run tests (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/capture.test.ts
// ============================================================================

export interface ParsedShot {
  bytes: Uint8Array;
  ext: "jpg" | "png";
  b64: string;
}

// Base64 -> bytes. atob throws on characters outside the base64 alphabet
// (including whitespace), which doubles as our body validation — no O(n)
// character-class regex over a multi-megabyte string.
export function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

// ~12 MB decoded. Checked against the STRING length before any decode work so
// an oversized payload costs O(1), not a regex scan plus a 16 MB copy.
export const SHOT_B64_CAP = 16_000_000;

// Parse a data:image/... URI into bytes. Returns null unless it is a
// well-formed jpeg/png data URI whose DECODED magic bytes agree — a declared
// mime is never trusted (a "data:image/png" wrapping JPEG bytes would
// otherwise throw inside pdf-lib's embedPng, or ship a mislabelled file).
export function parseListingShot(a: unknown): ParsedShot | null {
  try {
    const uri = (a as any)?.listingShot;
    if (typeof uri !== "string" || uri.length > SHOT_B64_CAP + 64) return null;
    const m = uri.match(/^data:image\/(jpeg|jpg|png);base64,/);
    if (!m) return null;
    const b64 = uri.slice(m[0].length);
    if (!b64 || b64.length > SHOT_B64_CAP) return null;
    // atob is WHATWG-forgiving (silently strips whitespace), so enforce the
    // strict alphabet ourselves — a canonical base64 body is what gets
    // attached verbatim and what any re-encode must reproduce byte-for-byte.
    if (/[^A-Za-z0-9+/=]/.test(b64)) return null;
    const bytes = b64ToU8(b64); // throws on chars outside the alphabet
    // Magic-byte sniff decides the real format; declared mime must agree in
    // family (jpeg/jpg vs png) or the URI is rejected outright.
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (isJpg && m[1] !== "png") return { bytes, ext: "jpg", b64 };
    if (isPng && m[1] === "png") return { bytes, ext: "png", b64 };
    return null;
  } catch {
    return null;
  }
}

// PNG pixel count from the IHDR header (width at bytes 16-19, height at 20-23,
// big-endian). Returns null when the buffer is too short. Used to refuse
// decompression bombs BEFORE pdf-lib's embedPng inflates width*height*4 bytes
// of RGBA in pure JS — a sub-12 MB PNG declaring 40k x 40k pixels would OOM the
// whole isolate, which no try/catch can survive.
export function pngPixelCount(bytes: Uint8Array): number | null {
  if (bytes.length < 24) return null;
  // The first chunk MUST be IHDR (bytes 12-15). Without this check a bomb
  // hides behind a small decoy chunk placed first: dimensions read from the
  // decoy pass the budget while the decoder still finds the real, huge IHDR.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (w <= 0 || h <= 0) return null;
  return w * h;
}

// Max pixels we will let pdf-lib decode (~120 MB RGBA). Any real full-page
// listing capture is far below this; only a crafted bomb exceeds it.
export const PNG_PIXEL_BUDGET = 30_000_000;

// When the capture's base64 exceeds this, the PDF skips its evidence pages and
// the photo ships as the attachment only. Keeps worst-case email weight
// (PDF + attachment + JSON overhead) safely under Resend's 40 MB limit.
export const SHOT_PDF_EMBED_CAP = 9_000_000;

// Page count for the sliced capture, mirroring the EXACT render-loop
// arithmetic (including its 2 pt remainder tolerance) so the "PAGE k OF N"
// header can never disagree with how many pages actually render.
// scaledH = image height scaled to content width; u0 = usable height on the
// first page (big caption); uR = usable height on continuation pages.
export function capturePageCount(scaledH: number, u0: number, uR: number, maxPages: number): number {
  let off = 0, k = 0;
  while (off < scaledH - 2 && k < maxPages) {
    off += Math.min(k === 0 ? u0 : uR, scaledH - off);
    k++;
  }
  return k;
}

// ============================================================================
// FITTING A WHOLE PAGE INTO ONE PHOTO
//
// The sealed capture is asked for as `capture=fullpage`, and when the returned
// JPEG came back over a cap we threw the WHOLE PAGE away and re-shot the
// viewport instead -- a photo of the top of the listing. The standing rule is
// that the capture is always the whole page, so the cap and the retry are both
// wrong here, and this is the arithmetic that replaces them.
//
// THE CAP WAS A GUESS. 1_500_000 b64 chars arrived in fb67429 justified only as
// "size-capped so a giant full-page render never bloats the response/cache" --
// no downstream limit was consulted. FOUR real ones exist, and the cap is the
// smallest of them. Tightest first:
//
//  1. THE EMAIL BODY. report-auth.ts MAX_BODY_BYTES = 8_000_000, enforced on
//     Content-Length in email-quote-report BEFORE req.json() parses anything,
//     because that endpoint is unauthenticated and an unbounded body is a
//     memory-exhaustion lever. The capture rides into that body 1:1 -- base64's
//     alphabet JSON-escapes to itself -- so the capture's ceiling is the body
//     cap MINUS everything else the report carries. report-auth.ts records
//     whole reports landing at 1-3 MB, and the captures inside those reports
//     were themselves up to 1_500_000 chars under the old cap, so the
//     non-capture remainder is at most ~1.5 MB. Reserving 2_000_000 leaves
//     8_000_000 - 2_000_000 = 6_000_000.
//
//     Derive in this direction only. Raising MAX_BODY_BYTES to make room for a
//     bigger capture would trade a bounded photo for an unbounded attack
//     surface on an endpoint that has no authentication at all.
//
//  2. THE VISION CEILING. VISION_MAX_B64_BYTES = 4_500_000 DECODED bytes,
//     because the sealed shot does double duty as the vision input when both
//     renders fail (scrapfly.ts, "screenshot-first"). visionImageVerdict
//     computes bytes as floor(len * 3 / 4), so in the b64 chars we actually
//     measure that is also 6_000_000.
//
//  3. THE PDF EVIDENCE PAGES. SHOT_PDF_EMBED_CAP = 9_000_000 b64 chars.
//  4. THE EMAIL PARSER.       SHOT_B64_CAP      = 16_000_000 b64 chars.
//
// min(6_000_000, 6_000_000, 9_000_000, 16_000_000) = 6_000_000, and the first
// two agree from completely independent directions. Four times what we were
// allowing, and now derived rather than picked.
//
// Four times matters because 1_500_000 was never a ceiling on giants. At 1920
// wide the failing Mazda VDP is 11.5 MP, and a page JPEG runs ~0.05-0.15
// bytes/pixel -- so the old cap sat in the middle of the ORDINARY tall-dealer-
// page band. The degrade it triggered was not the rare path it was written as.
export const EMAIL_BODY_NON_CAPTURE_RESERVE = 2_000_000;
export const CAPTURE_MAX_B64 = 6_000_000;

// Scrapfly documents /screenshot as defaulting to 1920x1080 and we do not set
// `resolution` on the first shot -- deliberately. Sending an unnecessary
// parameter on the rung that takes EVERY capture would risk a 422 on every
// listing to buy nothing; it is set only on the refit, where the alternative is
// already a degraded photo.
//
// So this is a FALLBACK, not an assumption the arithmetic rests on: the refit
// is computed from the width read out of the returned image's own header
// (imageDimensions), and only falls back to this when that header is
// unreadable. If Scrapfly ever changes its default, the measurement follows it
// and the refit stays correct.
export const CAPTURE_BASE_WIDTH = 1920;

// Below this the layout stops being the desktop page a buyer sees; a narrower
// shot would be a DIFFERENT rendering, not a smaller one, so the ladder stops
// here rather than photographing something else and calling it the listing.
export const CAPTURE_MIN_WIDTH = 1024;

// Leave room: the prediction below is linear and the real encoder is not.
export const CAPTURE_FIT_SAFETY = 0.85;

// The width to re-shoot a too-large full-page capture at, or null when no
// narrower shot would help.
//
// WHY WIDTH IS THE RIGHT LEVER, correcting the note in PR #342. That note
// measured the failing Mazda page at 1280 and again at 1024, found it 5,873 px
// tall BOTH times, and concluded "scaling the width will not bring a too-large
// page under the cap". The height finding is right and it is the important
// half: the layout does NOT reflow shorter. But the conclusion was drawn
// against the wrong baseline. The render is not 1280 wide, it is 1920, and
// because height is invariant the byte size falls very nearly LINEARLY with
// width -- so the move that matters is 1920 -> as low as 1024, a 47% cut, not
// the 20% that a 1280 -> 1024 comparison suggests.
//
// Linear, therefore, and deliberately not clever: bytes ~ width * height * k,
// height is fixed, so the width that fits is the current width scaled by how
// far over we are. A page that DOES reflow taller when narrowed simply comes
// back over the cap again and the caller stops; it never silently ships.
export function captureFitWidth(b64Len: number, currentWidth: number, cap = CAPTURE_MAX_B64): number | null {
  if (!(b64Len > 0) || !(currentWidth > 0)) return null;
  if (currentWidth <= CAPTURE_MIN_WIDTH) return null; // already at the floor
  const target = cap * CAPTURE_FIT_SAFETY;
  if (b64Len <= target) return null;               // it already fits; nothing to retry
  const w = Math.floor(currentWidth * (target / b64Len));
  if (w >= currentWidth) return null;              // no narrowing on offer
  if (w < CAPTURE_MIN_WIDTH) {
    // DO NOT GIVE UP ON THE PAGE HERE. Refusing outright loses the whole page
    // for one that missed the floor by a little -- and those are the tallest
    // listings, the ones this fix exists for. From 1920 the predicted width
    // falls under 1024 only past 9,562,500 b64 chars, so this band is
    // 9,562,501 to 11,250,000: real pages, not hypotheticals.
    //
    // WHAT IT COSTS, stated plainly rather than hidden in the arithmetic: this
    // compares against `cap` and not against `target`, so the shot it allows is
    // predicted to land between 85% and 100% of the cap -- it deliberately
    // spends CAPTURE_FIT_SAFETY, and it is EXPECTED to fail sometimes. Two
    // things make that an acceptable trade and both must stay true: the linear
    // model is an UPPER bound (JPEG bytes fall slightly sublinearly with width,
    // because a narrower render has fewer distinct blocks), and the caller
    // reserves the top-of-page fallback BEFORE it runs this rung, so a failed
    // floor shot costs one credit and never costs the photo.
    //
    // Below the band there is no width that helps, and we do not spend the credit.
    return b64Len * (CAPTURE_MIN_WIDTH / currentWidth) <= cap ? CAPTURE_MIN_WIDTH : null;
  }
  return w;
}

// How much of the page a capture actually shows, as a fraction, given the
// measured page height from the full-page attempt. Used to state the shortfall
// as a MEASURED fact when the ladder ends on a viewport shot, instead of
// leaving the report to imply it got everything.
export function captureCoverage(capturedPx: number, pagePx: number): number | null {
  if (!(capturedPx > 0) || !(pagePx > 0)) return null;
  return Math.min(1, capturedPx / pagePx);
}
