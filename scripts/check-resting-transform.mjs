// RESTING-TRANSFORM GATE — the report must come to rest square.
//
// WHY THIS EXISTS. On 2026-09-15 the whole Quote Check report shipped on a 3D
// tilt. `@keyframes lcgcReveal` ended at
//
//     rotateX(6deg) rotateY(-9deg)
//
// and `.lcgc-panel` used `animation: ... both`, which HOLDS THE FINAL FRAME. So
// the report did not animate onto a tilt and settle — it came to rest on one,
// permanently. Every number on the page was read at an angle: the asking price,
// the $999 admin fee the report exists to flag, the negotiation gauge, all ten
// point rows. It reached production and sat there.
//
// Not one gate could have caught it. Every check in this repo reads CODE. The
// tilt was valid JSX, valid CSS, valid everything — the build was green, the
// canonical shape was intact, the copy was compliant. It was only wrong when
// looked at.
//
// WHAT THIS IS NOT. It is not pixel-diff visual regression. That needs a
// browser, golden images, and tolerance for font rendering that differs between
// CI runners — flaky by construction, and a flaky gate gets switched off. This
// checks one geometric INVARIANT instead, deterministically and offline:
//
//     A surface that holds its animation's final frame must come to rest on a
//     transform that does not rotate, skew or shear its content.
//
// Sliding in (translate), growing in (scale), fading in (opacity) all settle
// legibly. Rotating does not: text at 6deg is text the reader decodes before
// reading, and a dollar figure is the last thing on this page that should cost
// a second look.
//
// WHAT IT STILL CANNOT SEE, said plainly so the green line is not over-read:
// overlapping elements, unreadable contrast, a card off the edge of the
// viewport, an element that renders at zero height. Those need real pixels.
// This closes ONE class — the one that shipped.
//
// Run:  npm run check:resting-transform
import { readFileSync } from "node:fs";

const FILES = ["src/App.jsx", "src/DealOrrery.jsx", "src/icons3d.jsx"];

// Transform functions that leave content legible at rest. Anything else — any
// rotate, any skew, a matrix we cannot reason about — shears what it holds.
const SETTLES_FLAT = /^(translate[XYZ3d]*|scale[XYZ3d]*|perspective|none)$/i;

// `rotate(0deg)`, `skewY(0)`, `rotate3d(1,0,0,0deg)` are identity — a rest
// state written explicitly as flat, which is exactly the fix this gate wants
// people to reach for. Treat them as flat rather than forcing the author to
// delete the function entirely.
function isIdentity(fn, args) {
  if (!/rotate|skew|matrix/i.test(fn)) return true;
  const nums = String(args).match(/-?\d*\.?\d+/g) || [];
  if (/rotate3d/i.test(fn)) return Number(nums[3] ?? 0) === 0;
  if (/matrix/i.test(fn)) return false; // unreasonable to reason about
  return nums.every((n) => Number(n) === 0);
}

// Pull every `transform:` value out of a keyframe's final frame.
function finalFrameTransforms(body) {
  // `100%{...}` or `to{...}` — the frame an element rests on.
  const out = [];
  // The `}` matters: a final frame almost always follows another frame, as in
  // `0%{...}100%{...}`. Leaving it out of this character class made the gate
  // find ZERO held frames on its first run and report itself clean over the
  // very defect it was written for.
  for (const m of body.matchAll(/(?:^|[},{;\s])(100%|to)\s*\{([^}]*)\}/gi)) {
    for (const t of m[2].matchAll(/transform\s*:\s*([^;}]+)/gi)) out.push(t[1].trim());
  }
  return out;
}

const failures = [];
const checked = [];

for (const file of FILES) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }

  // Which keyframes are HELD? `animation: name ... both|forwards`.
  const held = new Map(); // keyframe name -> the rule that holds it
  for (const m of src.matchAll(/animation\s*:\s*([A-Za-z_][\w-]*)([^;"'`}]*)/g)) {
    const [, name, rest] = m;
    if (/\b(both|forwards)\b/.test(rest)) held.set(name, `animation: ${name}${rest}`.trim().slice(0, 80));
  }
  // `animation-fill-mode` set separately, with `animation-name` nearby.
  if (/animation-fill-mode\s*:\s*(both|forwards)/.test(src)) {
    for (const m of src.matchAll(/animation-name\s*:\s*([A-Za-z_][\w-]*)/g)) {
      if (!held.has(m[1])) held.set(m[1], `animation-name: ${m[1]} + fill-mode`);
    }
  }

  for (const kf of src.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)\s*\{/g)) {
    const name = kf[1];
    if (!held.has(name)) continue;

    // Brace-match the keyframe body.
    let i = kf.index + kf[0].length - 1, depth = 0, start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start, i + 1);

    for (const value of finalFrameTransforms(body)) {
      checked.push(`${name} -> ${value.slice(0, 60)}`);
      for (const fn of value.matchAll(/([a-zA-Z0-9]+)\s*\(([^)]*)\)/g)) {
        const [, name2, args] = fn;
        if (SETTLES_FLAT.test(name2)) continue;
        if (isIdentity(name2, args)) continue;
        failures.push(
          `${file}: @keyframes ${name} comes to REST on ${name2}(${args.trim()})\n` +
          `    held by  ${held.get(name)}\n` +
          `    Content under a resting ${/skew/i.test(name2) ? "skew" : "rotation"} is sheared for as long as it is on screen.\n` +
          `    Animate FROM an angle if you like, but the final frame must settle flat\n` +
          `    (rotate(0deg) / rotateX(0deg) is fine and says so explicitly).`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error(`resting-transform: ${failures.length} surface(s) come to rest sheared.\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(`The whole Quote Check report shipped like this on 2026-09-15 and no other`);
  console.error(`gate could see it: the code was valid, the build was green, and it was only`);
  console.error(`wrong when looked at.`);
  process.exit(1);
}
console.log(`resting-transform: ${checked.length} held final frame(s) settle flat.`);
for (const c of checked) console.log(`   ${c}`);
process.exit(0);
