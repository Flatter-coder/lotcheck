// Regression harness for the sealed listing capture helpers (capture.ts).
// Same contract as invariants.test.ts: pure, offline, exercises the EXACT
// code that ships (imported, not copied), exits 1 on any failure. Every case
// pins a reviewed failure mode from the 2026-08-12 pre-landing review — the
// email-copy/attachment divergence class, the mislabelled-mime class, the
// PNG decompression bomb, and the PAGE-k-OF-N off-by-one.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/capture.test.ts
import { parseListingShot, pngPixelCount, capturePageCount, b64ToU8, bytesToHex, SHOT_B64_CAP } from "./capture.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ok  ${name}`); }
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

function b64Of(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
const JPG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Minimal PNG prefix through IHDR: signature + length + "IHDR" + 100x200 px
const PNG_IHDR = [...PNG_HEAD, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64, /* w=100 */ 0x00, 0x00, 0x00, 0xc8 /* h=200 */];

// ── parseListingShot ────────────────────────────────────────────────────────
check("accepts a well-formed jpeg data URI",
  parseListingShot({ listingShot: "data:image/jpeg;base64," + b64Of(JPG_BYTES) })?.ext === "jpg");
check("accepts the jpg mime alias",
  parseListingShot({ listingShot: "data:image/jpg;base64," + b64Of(JPG_BYTES) })?.ext === "jpg");
check("accepts a well-formed png data URI",
  parseListingShot({ listingShot: "data:image/png;base64," + b64Of(PNG_IHDR) })?.ext === "png");
check("rejects a declared png wrapping JPEG bytes (mislabelled mime)",
  parseListingShot({ listingShot: "data:image/png;base64," + b64Of(JPG_BYTES) }) === null);
check("rejects a declared jpeg wrapping PNG bytes (mislabelled mime)",
  parseListingShot({ listingShot: "data:image/jpeg;base64," + b64Of(PNG_IHDR) }) === null);
check("rejects webp (unsupported by the PDF embed, never promised)",
  parseListingShot({ listingShot: "data:image/webp;base64," + b64Of(JPG_BYTES) }) === null);
check("rejects base64 containing whitespace/newlines",
  parseListingShot({ listingShot: "data:image/jpeg;base64," + b64Of(JPG_BYTES).slice(0, 4) + "\n" + b64Of(JPG_BYTES).slice(4) } as any) === null);
check("rejects garbage magic bytes",
  parseListingShot({ listingShot: "data:image/jpeg;base64," + b64Of([0x00, 0x01, 0x02, 0x03]) }) === null);
check("rejects an oversized capture (> cap)",
  parseListingShot({ listingShot: "data:image/jpeg;base64," + "A".repeat(SHOT_B64_CAP + 100) }) === null);
check("rejects a missing/non-string listingShot",
  parseListingShot({}) === null && parseListingShot({ listingShot: 42 }) === null && parseListingShot(null) === null);
check("rejects an empty base64 body",
  parseListingShot({ listingShot: "data:image/jpeg;base64," }) === null);

// ── pngPixelCount ───────────────────────────────────────────────────────────
check("reads IHDR dimensions (100x200 = 20,000 px)",
  pngPixelCount(new Uint8Array(PNG_IHDR)) === 20_000);
check("returns null for a truncated buffer",
  pngPixelCount(new Uint8Array(PNG_HEAD)) === null);
// Zero-dimension IHDR: w or h of 0 is not a real image; null (embed skipped).
const PNG_ZERO_W = [...PNG_IHDR.slice(0, 16), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc8];
const PNG_ZERO_H = [...PNG_IHDR.slice(0, 16), 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00];
check("returns null for a zero-dimension IHDR (w=0 or h=0)",
  pngPixelCount(new Uint8Array(PNG_ZERO_W)) === null && pngPixelCount(new Uint8Array(PNG_ZERO_H)) === null);
// Sign-bit width (declared 2^31 px): the 32-bit read goes negative — must fail
// CLOSED (null -> embed skipped), never wrap into a small "safe" pixel count.
const PNG_SIGN_W = [...PNG_IHDR.slice(0, 16), 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc8];
check("sign-bit width fails closed (bomb declaring 2^31 px is refused, not wrapped)",
  pngPixelCount(new Uint8Array(PNG_SIGN_W)) === null);
// Chunk-reorder bypass: a tiny decoy chunk (gAMA) placed first would have its
// data read as "dimensions" and pass the budget while the real, huge IHDR sits
// later for the decoder to find. A non-IHDR first chunk must fail closed.
const PNG_FAKE_CHUNK = [...PNG_IHDR.slice(0, 8), 0x00, 0x00, 0x00, 0x08, 0x67, 0x41, 0x4d, 0x41, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01];
check("non-IHDR first chunk fails closed (budget can't be bypassed by chunk reordering)",
  pngPixelCount(new Uint8Array(PNG_FAKE_CHUNK)) === null);

// ── b64 round trip + hex ────────────────────────────────────────────────────
{
  const round = b64ToU8(b64Of(JPG_BYTES));
  check("b64ToU8 round-trips bytes", round.length === JPG_BYTES.length && round[0] === 0xff && round[9] === 0x46);
  check("bytesToHex pads low bytes", bytesToHex(new Uint8Array([0x00, 0x0f, 0xff])) === "000fff");
}

// ── capturePageCount — must mirror the render loop's 2 pt tolerance ─────────
const U0 = 629.89, UR = 695.89, MAXP = 6;
check("fits-on-one-page yields 1", capturePageCount(U0, U0, UR, MAXP) === 1);
check("1 pt of overflow is absorbed (no phantom PAGE 2)", capturePageCount(U0 + 1, U0, UR, MAXP) === 1);
check("2 pt of overflow is absorbed", capturePageCount(U0 + 2, U0, UR, MAXP) === 1);
check("3 pt of overflow makes a real page 2", capturePageCount(U0 + 3, U0, UR, MAXP) === 2);
check("exactly two full pages", capturePageCount(U0 + UR, U0, UR, MAXP) === 2);
check("caps at maxPages for absurd heights", capturePageCount(1_000_000, U0, UR, MAXP) === MAXP);
check("zero/negative height renders no pages", capturePageCount(0, U0, UR, MAXP) === 0 && capturePageCount(-5, U0, UR, MAXP) === 0);

if (failures) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log("\nAll capture cases pass.");
