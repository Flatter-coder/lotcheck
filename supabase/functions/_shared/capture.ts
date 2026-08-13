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
