// The Stampede Toyota failure, pinned.
//
// Run: node --experimental-strip-types supabase/functions/_shared/vision-limits.test.ts

import { visionImageVerdict, pngDimensions, VISION_MAX_B64_BYTES, VISION_MAX_EDGE_PX } from "./vision-limits.ts";

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

// Byte ceiling — the gate that fires on a JPEG, where dimensions aren't cheap.
const huge = "A".repeat(Math.ceil((VISION_MAX_B64_BYTES + 1_000_000) * 4 / 3));
const heavy = visionImageVerdict(huge, "image/jpeg");
check("an oversized JPEG is refused on bytes alone",
  !heavy.ok && /MB vision limit/.test(heavy.reason), JSON.stringify({ ok: heavy.ok, reason: heavy.reason }));

check("a reasonable JPEG passes even though its dimensions are unreadable",
  visionImageVerdict("A".repeat(400_000), "image/jpeg").ok,
  "a non-PNG must not be rejected merely for being unmeasurable");

check("a missing screenshot is 'not ok' without pretending it was checked",
  !visionImageVerdict(null).ok && visionImageVerdict(null).reason === "no screenshot",
  JSON.stringify(visionImageVerdict(null)));

check("the verdict always reports the byte size it judged",
  typeof visionImageVerdict(fakePng(800, 600)).bytes === "number",
  "a refusal that does not say how big it was is not diagnosable");

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
