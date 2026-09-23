// Regression suite for the vision tiling math -- planVisionTiles() in
// src/App.jsx, which decides the output size and the tile rectangles for an
// uploaded image.
//
// WHY: an uploaded PNG screenshot of a Google results page came back as "The
// analysis service returned an error" (2026-08-15). Claude rejects a single
// image over ~5MB outright, and the client sent raw bytes up to 15MB with no
// downscaling -- every upload in that band was a guaranteed 400. Fitting a
// tall screenshot inside 1568px on the LONG edge would have squeezed a
// 1920x9000 capture to ~334px wide and made every figure unreadable, so the
// fix caps WIDTH and slices HEIGHT into overlapping tiles instead.
//
// WHY THIS FILE LOOKS THE WAY IT DOES. Until 2026-09-22 it declared its own
// copy of the five constants and its own plan(), under a comment reading
// "Mirrors normalizeImageForVision's geometry exactly". It touched no
// production file at all -- the only suite in scripts/ that touched none --
// so the geometry could be changed, or deleted outright, with every check
// here still green. That is the defect docs/FIXING-HISTORY.md records for
// test:catalog-quality on the same day: a gate that tests its own copy of the
// rule tests nothing but its own internal consistency.
//
// So the geometry was split out of the canvas work into a pure module-scope
// function, and this suite now LIFTS THAT FUNCTION out of App.jsx and runs it.
// App.jsx cannot be imported here (JSX, React, a DOM), so it is extracted by
// source range and evaluated -- the same route test-pg-timestamp.mjs and
// test-share-round-trip.mjs take to the real code in that file.
//
// Run: node scripts/test-vision-tiling.mjs
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  -- " + detail : ""}`); }
};

// ---- lift the REAL constants and the REAL function ------------------------
// A miss here is fatal rather than skipped: "the function moved" must never
// read as "the geometry is fine".
const DECLS = ["VISION_MAX_W", "VISION_MAX_TILE_H", "VISION_TILE_OVERLAP",
               "VISION_MAX_TILES", "VISION_TALL_RATIO"];
const consts = {};
let prelude = "";
for (const name of DECLS) {
  const m = new RegExp(`^export const ${name}=([0-9.]+);`, "m").exec(src);
  if (!m) {
    console.error(`FAIL: src/App.jsx no longer exports ${name} at module scope.\n` +
      "  This suite runs the real geometry by lifting it out of App.jsx. If the\n" +
      "  constants moved, point it at their new home -- do NOT restate them here.");
    process.exit(1);
  }
  consts[name] = Number(m[1]);
  prelude += `const ${name}=${m[1]};\n`;
}

const start = src.indexOf("export function planVisionTiles(");
if (start === -1) {
  console.error("FAIL: planVisionTiles is gone from src/App.jsx.\n" +
    "  It is the whole tiling geometry. If it moved, point this test at its new\n" +
    "  home. Restating the arithmetic here is what this file used to do, and it\n" +
    "  meant the suite passed while production was free to do anything.");
  process.exit(1);
}
let depth = 0, end = start;
for (let i = src.indexOf("{", start); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const plan = new Function(
  `${prelude}${src.slice(start, end).replace("export function", "function")}\n` +
  "return planVisionTiles;")();

const { VISION_MAX_W, VISION_MAX_TILE_H, VISION_TILE_OVERLAP, VISION_MAX_TILES } = consts;

// ---- the constants themselves --------------------------------------------
// Lifting them means an assertion like `outW === VISION_MAX_W` follows the
// source wherever it goes -- including somewhere wrong. These pin the values
// that make the geometry correct against the API it feeds.
check("the width cap is Anthropic's 1568px downscale target", VISION_MAX_W === 1568, String(VISION_MAX_W));
check("no tile exceeds that same budget in height", VISION_MAX_TILE_H === 1568, String(VISION_MAX_TILE_H));
check("tiles overlap by a readable band, not a hairline", VISION_TILE_OVERLAP >= 80, String(VISION_TILE_OVERLAP));
check("the overlap is smaller than the tile, so the stride advances",
  VISION_TILE_OVERLAP < VISION_MAX_TILE_H, `overlap=${VISION_TILE_OVERLAP} tile=${VISION_MAX_TILE_H}`);
check("the tile ceiling bounds request weight", VISION_MAX_TILES >= 2 && VISION_MAX_TILES <= 12, String(VISION_MAX_TILES));

// ---- the geometry ---------------------------------------------------------

// 1. A normal phone photo of a quote: downscaled, single tile, never sliced.
{
  const p = plan(3024, 4032);
  check("phone photo -> single tile (not sliced -- it is a photo, not a scroll capture)", p.tiles.length === 1, JSON.stringify(p));
  check("phone photo -> fits the long-edge cap", p.outH <= VISION_MAX_TILE_H && p.outW <= VISION_MAX_W, `outW=${p.outW} outH=${p.outH}`);
}

// 2. A small image is left at its own size, never upscaled.
{
  const p = plan(900, 1200);
  check("small image is not upscaled", p.outW === 900 && p.outH === 1200, JSON.stringify(p));
}

// 3. THE REPORTED CASE: a tall Google results screenshot. Must slice, and must
// keep full width -- the whole point of the fix.
{
  const p = plan(1920, 9000);
  check("tall screenshot -> multiple tiles", p.tiles.length > 1, `tiles=${p.tiles.length}`);
  check("tall screenshot -> width kept at the cap, NOT squeezed", p.outW === VISION_MAX_W, `outW=${p.outW}`);
  check("tall screenshot -> every tile within budget", p.tiles.every((t) => t.h <= VISION_MAX_TILE_H));
  // Coverage: the union of tiles must span the whole page, no gap.
  let covered = 0;
  for (const t of p.tiles) covered = Math.max(covered, t.top + t.h);
  check("tall screenshot -> tiles cover the full height", covered >= p.outH, `covered=${covered} outH=${p.outH}`);
}

// 4. Consecutive tiles must actually overlap, or a line of text landing on a
// seam is cut in half in both tiles and readable in neither.
{
  const p = plan(1920, 9000);
  let minOverlap = Infinity;
  for (let i = 1; i < p.tiles.length; i++) {
    const prevEnd = p.tiles[i - 1].top + p.tiles[i - 1].h;
    minOverlap = Math.min(minOverlap, prevEnd - p.tiles[i].top);
  }
  check("consecutive tiles overlap", minOverlap >= VISION_TILE_OVERLAP - 1, `minOverlap=${minOverlap}`);
}

// 5. An absurdly tall page scales down rather than getting truncated -- a
// shorter read of the WHOLE page beats a sharp read of its top third
// (report-never-empty).
{
  const p = plan(1920, 60000);
  check("absurd height -> capped at MAX_TILES", p.tiles.length <= VISION_MAX_TILES, `tiles=${p.tiles.length}`);
  let covered = 0;
  for (const t of p.tiles) covered = Math.max(covered, t.top + t.h);
  check("absurd height -> still covers the whole page", covered >= p.outH, `covered=${covered} outH=${p.outH}`);
  check("absurd height -> width reduced to fit, not truncated", p.outW < VISION_MAX_W && p.outW > 0, `outW=${p.outW}`);
}

// 6. Exactly-at-the-boundary heights do not produce a degenerate empty tile.
for (const h of [VISION_MAX_TILE_H, VISION_MAX_TILE_H + 1, VISION_MAX_TILE_H * 2]) {
  const p = plan(1000, h);
  check(`boundary height ${h} -> no empty tile`, p.tiles.every((t) => t.h > 0), JSON.stringify(p.tiles));
}

// 7. A wide-but-short panorama stays one tile.
{
  const p = plan(5000, 800);
  check("wide panorama -> single tile", p.tiles.length === 1, JSON.stringify(p));
  check("wide panorama -> width capped", p.outW === VISION_MAX_W, `outW=${p.outW}`);
}

// 8. A borderline-tall page (just past the ratio gate) still slices correctly.
{
  const p = plan(1200, 3000);
  check("borderline tall -> slices", p.tiles.length > 1, JSON.stringify(p.tiles));
}

// 9. Every plan must start at the top and leave no gap, because the caller now
// draws EVERY plan through one loop over tiles. A plan returning no tile, or
// one that skipped a band, would silently crop the image it was handed.
for (const [w, h] of [[3024, 4032], [900, 1200], [5000, 800], [1920, 9000], [1920, 60000]]) {
  const p = plan(w, h);
  check(`${w}x${h} -> the plan starts at the top and leaves no gap`,
    p.tiles.length > 0 && p.tiles[0].top === 0 &&
    p.tiles.every((t, i) => i === 0 || t.top <= p.tiles[i - 1].top + p.tiles[i - 1].h),
    JSON.stringify(p.tiles));
}

// ---- the function is REACHED by production --------------------------------
// The reason this suite was worthless was not that the arithmetic was wrong --
// it was that nothing tied it to the code that runs. A geometry function the
// uploader does not call is dead code this file would keep green forever.
{
  const consumer = src.slice(src.indexOf("async function normalizeImageForVision(file){"),
                             src.indexOf("// Cheap triage frame:"));
  check("normalizeImageForVision calls planVisionTiles",
    /const\s*\{\s*outW\s*,\s*outH\s*,\s*tiles\s*\}\s*=\s*planVisionTiles\(srcW,\s*srcH\)/.test(consumer),
    "the uploader must take its size and slices FROM this function, or the two drift apart again");
  check("the uploader keeps no second copy of the geometry",
    !/VISION_TALL_RATIO|VISION_MAX_TILE_H|VISION_TILE_OVERLAP/.test(consumer),
    "a constant re-read inside the drawing code is the start of a second implementation");
  check("every tile the plan returns is drawn",
    /for\(const t of tiles\)/.test(consumer),
    "a drawing loop that does not iterate the plan can drop or invent tiles");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
