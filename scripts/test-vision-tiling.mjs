// Regression suite for the vision tiling math (src/App.jsx
// normalizeImageForVision). Pure arithmetic, no DOM -- the browser half
// (canvas draw + JPEG encode) can't run here, but the geometry is where the
// bugs live and this pins it.
//
// WHY: an uploaded PNG screenshot of a Google results page came back as "The
// analysis service returned an error" (2026-08-15). Claude rejects a single
// image over ~5MB outright, and the client sent raw bytes up to 15MB with no
// downscaling -- every upload in that band was a guaranteed 400. Fitting a
// tall screenshot inside 1568px on the LONG edge would have squeezed a
// 1920x9000 capture to ~334px wide and made every figure unreadable, so the
// fix caps WIDTH and slices HEIGHT into overlapping tiles instead.
//
// Run: node scripts/test-vision-tiling.mjs

const VISION_MAX_W = 1568;
const VISION_MAX_TILE_H = 1568;
const VISION_TILE_OVERLAP = 110;
const VISION_MAX_TILES = 8;
const VISION_TALL_RATIO = 2.2;

// Mirrors normalizeImageForVision's geometry exactly. Returns the output
// dimensions and the tile rectangles that would be drawn.
function plan(srcW, srcH) {
  const isTall = srcH / srcW >= VISION_TALL_RATIO;
  let outW, outH;
  if (isTall) {
    const scale = Math.min(1, VISION_MAX_W / srcW);
    outW = Math.max(1, Math.round(srcW * scale));
    outH = Math.max(1, Math.round(srcH * scale));
  } else {
    const scale = Math.min(1, VISION_MAX_W / Math.max(srcW, srcH));
    outW = Math.max(1, Math.round(srcW * scale));
    outH = Math.max(1, Math.round(srcH * scale));
  }

  const stride = VISION_MAX_TILE_H - VISION_TILE_OVERLAP;
  if (isTall) {
    const tilesNeeded = outH <= VISION_MAX_TILE_H ? 1 : Math.ceil((outH - VISION_TILE_OVERLAP) / stride);
    if (tilesNeeded > VISION_MAX_TILES) {
      const maxH = VISION_MAX_TILE_H + stride * (VISION_MAX_TILES - 1);
      const extra = maxH / outH;
      outW = Math.max(1, Math.round(outW * extra));
      outH = Math.max(1, Math.round(outH * extra));
    }
  }

  const tiles = [];
  if (!isTall || outH <= VISION_MAX_TILE_H) {
    tiles.push({ top: 0, h: outH });
  } else {
    for (let top = 0, n = 0; top < outH && n < VISION_MAX_TILES; top += stride, n++) {
      const h = Math.min(VISION_MAX_TILE_H, outH - top);
      if (h <= 0) break;
      tiles.push({ top, h });
      if (top + h >= outH) break;
    }
  }
  return { outW, outH, tiles };
}

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  -- " + detail : ""}`); }
};

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

// 6. Exactly-at-the-boundary heights don't produce a degenerate empty tile.
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

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
