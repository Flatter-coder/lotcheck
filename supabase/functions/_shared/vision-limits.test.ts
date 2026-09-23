// The Stampede Toyota failure, pinned.
//
// Run: node --experimental-strip-types supabase/functions/_shared/vision-limits.test.ts

import { visionImageVerdict, pngDimensions, jpegDimensions, imageDimensions, VISION_MAX_B64_BYTES, VISION_MAX_EDGE_PX, VISION_MAX_PIXELS } from "./vision-limits.ts";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + (detail ?? "")}`);
  cond ? pass++ : fail++;
};

/** Minimal PNG header (IHDR only) at the given dimensions — enough to measure. */
function fakePng(width: number, height: number, padBytes = 0): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
                 (width >> 24) & 255, (width >> 16) & 255, (width >> 8) & 255, width & 255,
                 (height >> 24) & 255, (height >> 16) & 255, (height >> 8) & 255, height & 255];
  let s = String.fromCharCode(...bytes);
  if (padBytes > 0) s += "\0".repeat(padBytes);
  return btoa(s);
}

check("PNG dimensions are read from the IHDR chunk",
  JSON.stringify(pngDimensions(fakePng(1280, 17729))) === '{"width":1280,"height":17729}',
  JSON.stringify(pngDimensions(fakePng(1280, 17729))));

check("a non-PNG returns null rather than a wrong number",
  pngDimensions(btoa("not an image at all, just text padding here")) === null,
  "guessing dimensions is worse than declining to");

// THE CASE FROM THE CODE'S OWN COMMENT: capitalchev.ca, 17,729px tall.
const tall = visionImageVerdict(fakePng(1280, 17729));
check("THE BUG: a 17,729px-tall screenshot is refused BEFORE the request",
  !tall.ok && /long-edge/.test(tall.reason), JSON.stringify(tall));

check("...and the reason names the actual dimensions, so the log explains itself",
  /1280x17729px/.test(tall.reason), tall.reason);

check("a normal full-page screenshot passes",
  visionImageVerdict(fakePng(1280, 6400)).ok,
  JSON.stringify(visionImageVerdict(fakePng(1280, 6400))));

check("exactly at the long-edge limit still passes",
  visionImageVerdict(fakePng(1280, VISION_MAX_EDGE_PX)).ok,
  "the gate is OVER the limit, not at it");

// Byte ceiling — the gate that fires when the dimensions cannot be read at all.
// (This comment used to say "the gate that fires on a JPEG, where dimensions
// aren't cheap". That stopped being true when jpegDimensions was added: a JPEG
// IS measured now. The sentence outlived the behaviour it described, and the
// checks under it were still the pre-jpegDimensions ones — see the block at the
// bottom of this file.)
const huge = "A".repeat(Math.ceil((VISION_MAX_B64_BYTES + 1_000_000) * 4 / 3));
const heavy = visionImageVerdict(huge, "image/jpeg");
check("an oversized JPEG is refused on bytes alone",
  !heavy.ok && /MB vision limit/.test(heavy.reason), JSON.stringify({ ok: heavy.ok, reason: heavy.reason }));

check("bytes that are not an image at all pass on the byte ceiling alone",
  visionImageVerdict("A".repeat(400_000), "image/jpeg").ok,
  "something unmeasurable must not be rejected merely for being unmeasurable");

check("a missing screenshot is 'not ok' without pretending it was checked",
  !visionImageVerdict(null).ok && visionImageVerdict(null).reason === "no screenshot",
  JSON.stringify(visionImageVerdict(null)));

check("the verdict always reports the byte size it judged",
  typeof visionImageVerdict(fakePng(800, 600)).bytes === "number",
  "a refusal that does not say how big it was is not diagnosable");

// ---------------------------------------------------------------------------
// JPEG, WITH AN ACTUAL JPEG.
//
// Until 2026-09-23 every check above used either a PNG or `"A".repeat(n)`, and
// `"A".repeat(n)` is not a JPEG — it fails the SOI test on its first two bytes
// and lands on the byte ceiling. So jpegDimensions, the 35 lines written
// BECAUSE the guard was blind to the only format Scrapfly actually produces,
// had no case exercising it at all: its SOI test, its marker walk, its DHT
// trap and its scan budget could each be broken with this file still green.
// Proven by mutation — inverting the SOI comparison survived.
//
// That is the original defect's own shape. The guard that stops a tall JPEG
// from reaching Anthropic as an HTTP 400 — which surfaced to Vic as "this
// dealer site may be blocking automated access", an accusation about a dealer
// that was doing nothing wrong — has to be the best-covered thing here.

/** A real JPEG header: SOI, APP0/JFIF, optional filler segments, SOFn, SOS. */
function realJpeg(w: number, h: number, opts: { fillerSegments?: number; marker?: number; fillerLen?: number } = {}): string {
  const { fillerSegments = 0, marker = 0xC0, fillerLen = 65 } = opts;
  const b: number[] = [0xFF, 0xD8];
  b.push(0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  // Quantisation tables and Exif sit between SOI and SOFn in real encoder
  // output. They are the reason the frame header cannot be read at a fixed
  // offset the way PNG's IHDR can.
  for (let i = 0; i < fillerSegments; i++) {
    b.push(0xFF, 0xDB, (fillerLen + 2) >> 8, (fillerLen + 2) & 255);
    for (let j = 0; j < fillerLen; j++) b.push(0);
  }
  b.push(0xFF, marker, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3);
  for (let i = 0; i < 9; i++) b.push(0);
  b.push(0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00);
  return btoa(String.fromCharCode(...b));
}

/** A JPEG carrying a zero-payload segment (length field == 2) before the frame. */
function jpegWithEmptySegment(w: number, h: number): string {
  const b: number[] = [0xFF, 0xD8];
  b.push(0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  b.push(0xFF, 0xDB, 0x00, 0x02);                      // length 2 => no payload at all
  b.push(0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3);
  for (let i = 0; i < 9; i++) b.push(0);
  b.push(0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00);
  return btoa(String.fromCharCode(...b));
}

/** A JPEG whose marker chain includes restart markers, which carry no length. */
function realJpegWithRst(w: number, h: number): string {
  const b: number[] = [0xFF, 0xD8];
  b.push(0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  b.push(0xFF, 0xD0, 0xFF, 0xD3, 0xFF, 0xD7);          // RST0, RST3, RST7
  b.push(0xFF, 0xFF, 0xFF, 0xC0, 0x00, 0x11, 0x08,     // a fill byte, then SOF0
         (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3);
  for (let i = 0; i < 9; i++) b.push(0);
  b.push(0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00);
  return btoa(String.fromCharCode(...b));
}

check("JPEG dimensions are read from the SOFn frame header",
  JSON.stringify(jpegDimensions(realJpeg(1280, 17729))) === '{"width":1280,"height":17729}',
  JSON.stringify(jpegDimensions(realJpeg(1280, 17729))));

check("...even when the frame header sits behind several other segments",
  JSON.stringify(jpegDimensions(realJpeg(800, 600, { fillerSegments: 6 }))) === '{"width":800,"height":600}',
  "this is the whole reason the marker chain is walked instead of read at an offset");

check("a progressive JPEG (SOF2) is measured too",
  JSON.stringify(jpegDimensions(realJpeg(640, 480, { marker: 0xC2 }))) === '{"width":640,"height":480}',
  JSON.stringify(jpegDimensions(realJpeg(640, 480, { marker: 0xC2 }))));

// DHT (C4), JPG (C8) and DAC (CC) sit inside the C0..CF range and are NOT
// frame headers. Reading one as a frame yields a confident wrong size, which
// is worse than no size at all.
for (const [name, m] of [["DHT", 0xC4], ["JPG", 0xC8], ["DAC", 0xCC]] as const) {
  check(`${name} (0x${m.toString(16).toUpperCase()}) is not mistaken for a frame header`,
    jpegDimensions(realJpeg(1234, 5678, { marker: m })) === null,
    `read ${JSON.stringify(jpegDimensions(realJpeg(1234, 5678, { marker: m })))} out of a table, not a frame`);
}

check("something that is not a JPEG returns null rather than a wrong number",
  jpegDimensions(btoa("plain text, no SOI marker anywhere in here")) === null,
  "the SOI test is what stops the walk running over arbitrary bytes");

check("a PNG is not read as a JPEG", jpegDimensions(fakePng(800, 600)) === null);

check("the header walk is bounded, so a hostile file costs O(1)",
  jpegDimensions(realJpeg(900, 700, { fillerSegments: 40, fillerLen: 250 }), 64) === null,
  "not finding SOFn inside the budget must return null, never scan on");

check("imageDimensions routes both formats to the right reader",
  JSON.stringify(imageDimensions(realJpeg(1280, 17729))) === '{"width":1280,"height":17729}'
    && JSON.stringify(imageDimensions(fakePng(1280, 6400))) === '{"width":1280,"height":6400}');

// THE DEFECT, on the format that actually reaches us. A tall page compresses
// well: it can sit far under the byte ceiling and still be 17,729px tall.
const tallJpeg = visionImageVerdict(realJpeg(1280, 17729));
check("THE BUG, as a JPEG: a tall capture is refused on DIMENSIONS, not bytes",
  !tallJpeg.ok && /long-edge/.test(tallJpeg.reason),
  JSON.stringify(tallJpeg) + " — under the byte ceiling, so bytes alone would have let it through");

check("...and the refusal names the dimensions it measured",
  tallJpeg.width === 1280 && tallJpeg.height === 17729 && /1280x17729px/.test(tallJpeg.reason),
  tallJpeg.reason);

check("a normal JPEG screenshot still passes",
  visionImageVerdict(realJpeg(1280, 6400)).ok,
  JSON.stringify(visionImageVerdict(realJpeg(1280, 6400))));

check("a JPEG over the pixel budget is refused on megapixels",
  (() => { const v = visionImageVerdict(realJpeg(7000, 5000)); return !v.ok && /MP/.test(v.reason); })(),
  JSON.stringify(visionImageVerdict(realJpeg(7000, 5000))));

// ---------------------------------------------------------------------------
// THE EDGES OF EACH LIMIT.
//
// Each case below was chosen because a mutation SURVIVED there: the boundary
// could be moved by one, or a guard turned inside out, with this file green.
// A limit whose exact edge is untested is a limit nobody has actually agreed
// on -- and every one of these decides whether a paid vision read is attempted
// or the report quietly degrades to text.

// A header claiming zero. Malformed input must be refused, not measured: a
// 0-dimension "image" sails through every ceiling below, because 0 is under
// all of them.
for (const [label, w, h] of [["zero width", 0, 600], ["zero height", 800, 0], ["both zero", 0, 0]] as const) {
  check(`a JPEG header claiming ${label} is refused, not measured`,
    jpegDimensions(realJpeg(w, h)) === null,
    "zero passes every ceiling, so reading it as valid is how a broken file gets called fine");
  check(`a PNG header claiming ${label} is refused, not measured`,
    pngDimensions(fakePng(w, h)) === null);
}

// SOF15 is the last real frame marker. The range test is <= 0xCF, and moving
// it to < 0xCF loses exactly this one.
check("SOF15 (0xCF), the last frame marker, is still read",
  JSON.stringify(jpegDimensions(realJpeg(320, 240, { marker: 0xCF }))) === '{"width":320,"height":240}',
  JSON.stringify(jpegDimensions(realJpeg(320, 240, { marker: 0xCF }))));

// Restart markers carry no length payload, so the walk must step over them by
// two rather than reading the next two bytes as a segment length.
check("restart markers are stepped over, not read as segments",
  JSON.stringify(jpegDimensions(realJpegWithRst(1024, 768))) === '{"width":1024,"height":768}',
  JSON.stringify(jpegDimensions(realJpegWithRst(1024, 768))));

// A segment whose length field is exactly 2 carries no payload. The guard is
// `len < 2`, written against a length of 0 that would never advance the walk.
// Moving it to `len <= 2` makes an empty segment end the walk instead of
// stepping over it -- the frame header behind it is never reached, the
// dimensions come back unreadable, and a 17,729px capture then passes on the
// byte ceiling alone. That is the exact failure this module exists to prevent,
// reachable by a one-character edit, and nothing here noticed.
check("an empty segment is stepped over, not treated as the end of the header",
  JSON.stringify(jpegDimensions(jpegWithEmptySegment(1280, 17729))) === '{"width":1280,"height":17729}',
  JSON.stringify(jpegDimensions(jpegWithEmptySegment(1280, 17729))));

check("...so a tall JPEG behind an empty segment is still refused on dimensions",
  (() => { const v = visionImageVerdict(jpegWithEmptySegment(1280, 17729)); return !v.ok && /long-edge/.test(v.reason); })(),
  JSON.stringify(visionImageVerdict(jpegWithEmptySegment(1280, 17729))));

// The byte ceiling, at the edge. "Over the limit" and "at the limit" are
// different claims, and only one of them is what the constant says.
{
  const atCeiling = "A".repeat(Math.floor((VISION_MAX_B64_BYTES * 4) / 3));
  const v = visionImageVerdict(atCeiling, "image/jpeg");
  check("exactly at the byte ceiling still passes",
    v.ok && v.bytes <= VISION_MAX_B64_BYTES,
    JSON.stringify({ ok: v.ok, bytes: v.bytes, limit: VISION_MAX_B64_BYTES }));
  const over = "A".repeat(Math.ceil(((VISION_MAX_B64_BYTES + 5_000) * 4) / 3));
  check("one step over the byte ceiling is refused",
    !visionImageVerdict(over, "image/jpeg").ok);
}

// The pixel budget, at the edge. 5000x6000 is exactly 30 MP.
{
  const side = 5000, other = VISION_MAX_PIXELS / side;
  check("exactly at the pixel budget still passes",
    visionImageVerdict(realJpeg(side, other)).ok,
    JSON.stringify(visionImageVerdict(realJpeg(side, other))));
  check("one pixel row over the budget is refused",
    !visionImageVerdict(realJpeg(side, other + 1)).ok,
    JSON.stringify(visionImageVerdict(realJpeg(side, other + 1))));
}

// The long edge, one past. The "exactly at" side is already pinned above.
check("one pixel over the long-edge limit is refused",
  !visionImageVerdict(fakePng(1280, VISION_MAX_EDGE_PX + 1)).ok,
  JSON.stringify(visionImageVerdict(fakePng(1280, VISION_MAX_EDGE_PX + 1))));

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
