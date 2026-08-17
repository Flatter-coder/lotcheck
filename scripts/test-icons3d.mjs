#!/usr/bin/env node
// ============================================================================
// The 3D icon set, checked for the failures a build cannot see.
//
// An SVG that references a gradient id which does not exist does not throw —
// it paints nothing. The icon vanishes and everything around it still renders,
// so a typo'd `url(#i3-warn-a)` reads as "no warning here", which on a report
// whose whole job is flagging things is the worst possible way to fail.
//
// The same silence applies to a `className` naming an animation nobody wrote,
// and to an animation nobody remembered to stop under prefers-reduced-motion.
//
// So each icon is required to be self-contained and honest:
//   1. every url(#…) it uses is defined inside that same icon
//   2. every animation class it uses exists in ICON3D_CSS
//   3. every animation in ICON3D_CSS is disabled under reduced motion
//   4. it is actually lit — a gradient, not a flat fill, or it is not 3D
//   5. its name is referenced somewhere in the UI, or it is dead weight
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "icons3d.jsx"), "utf8");

const failures = [];
let checked = 0;

// --- split the registry into one blob per icon -------------------------------
const regStart = src.indexOf("const I = {");
const regEnd = src.indexOf("\n};", regStart);
if (regStart < 0 || regEnd < 0) {
  console.error("FAIL: could not find the icon registry in src/icons3d.jsx");
  process.exit(1);
}
const registry = src.slice(regStart, regEnd);

const icons = [];
const nameRe = /^\s{2}([a-zA-Z][a-zA-Z0-9]*):\(\)=>\(<>/gm;
let m, marks = [];
while ((m = nameRe.exec(registry)) !== null) marks.push({ name: m[1], at: m.index });
for (let i = 0; i < marks.length; i++) {
  icons.push({
    name: marks[i].name,
    body: registry.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : registry.length),
  });
}
if (icons.length < 20) {
  console.error(`FAIL: only found ${icons.length} icons — the registry parse is wrong`);
  process.exit(1);
}

// --- the animation vocabulary ------------------------------------------------
const cssStart = src.indexOf("export const ICON3D_CSS");
const css = src.slice(cssStart, src.indexOf("`;", cssStart));
const declaredClasses = new Set([...css.matchAll(/^\.(i3-[a-z0-9]+)\s*\{/gm)].map(x => x[1]));
const declaredFrames = new Set([...css.matchAll(/@keyframes\s+(i3[A-Za-z0-9]+)/g)].map(x => x[1]));

const reducedBlock = css.slice(css.indexOf("prefers-reduced-motion"));
// Helper/delay classes carry no animation of their own.
const HELPERS = new Set(["i3-d2", "i3-d3", "i3-d4"]);

for (const cls of declaredClasses) {
  if (HELPERS.has(cls)) continue;
  checked++;
  if (!reducedBlock.includes(cls)) {
    failures.push(`.${cls} keeps animating under prefers-reduced-motion — every animation must stop`);
  }
  const rule = css.match(new RegExp(`^\\.${cls}\\s*\\{([^}]*)\\}`, "m"));
  const frame = rule && rule[1].match(/animation:\s*([A-Za-z0-9]+)/);
  if (frame && !declaredFrames.has(frame[1])) {
    failures.push(`.${cls} animates "${frame[1]}", which has no @keyframes`);
  }
}

// --- per-icon checks ---------------------------------------------------------
// Shared primitives define these ids on the icon's behalf.
const SHARED = /(<Lit|<Ball)\s+id=\{?"?([a-zA-Z0-9-]+)"?\}?/g;

for (const { name, body } of icons) {
  checked++;

  // 1. references resolve inside the icon
  const defined = new Set([...body.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
  for (const s of body.matchAll(SHARED)) defined.add(s[2]);
  for (const ref of body.matchAll(/url\(#([^)]+)\)/g)) {
    if (!defined.has(ref[1])) {
      failures.push(`${name}: references url(#${ref[1]}) but never defines it — this icon renders blank`);
    }
  }

  // 2. animation classes exist
  for (const c of body.matchAll(/className="([^"]+)"/g)) {
    for (const cls of c[1].split(/\s+/)) {
      if (!cls.startsWith("i3-")) continue;
      if (!declaredClasses.has(cls)) {
        failures.push(`${name}: uses .${cls}, which is not defined in ICON3D_CSS`);
      }
    }
  }

  // 3. it has to be lit, or it is a flat glyph wearing a 3D label
  if (!/<Lit |<Ball |radialGradient|linearGradient/.test(body)) {
    failures.push(`${name}: has no gradient — a flat fill is not a 3D icon`);
  }

  // 4. and it has to move, since the whole set is "3D animated"
  if (!/className="i3-/.test(body)) {
    failures.push(`${name}: has no animation — every icon in this set moves`);
  }
}

// --- 5. no icon is dead weight ----------------------------------------------
const consumers = [];
for (const f of ["src/App.jsx"]) consumers.push(readFileSync(join(root, f), "utf8"));
for (const f of readdirSync(join(root, "public")).filter(f => f.endsWith(".html"))) {
  consumers.push(readFileSync(join(root, "public", f), "utf8"));
}
// Matched on the attribute form specifically. A bare "search" or "money"
// appears all over App.jsx for unrelated reasons, so a loose string match would
// call an unwired icon used and defeat the point of the check.
const allConsumers = consumers.join("\n");
for (const { name } of icons) {
  // \\?" because one page embeds its icon inside a JSON-escaped string literal.
  if (!new RegExp(`(name|data-icon)=\\\\?"${name}\\\\?"`).test(allConsumers)) {
    failures.push(`${name}: defined but never used — drop it or wire it up`);
  }
}

// --- 6. the static pages' copy of the keyframes matches the module's --------
// public/ has no bundler, so those pages link public/icons3d.css instead of
// importing the module. Two copies of the same animations drift, and drift here
// means an icon that moves in the app and is frozen on the landing page —
// which nobody notices, because a still icon looks like a deliberate one.
{
  checked++;
  const cssFile = join(root, "public", "icons3d.css");
  const shipped = readFileSync(cssFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  if (norm(shipped) !== norm(css.slice(css.indexOf("`") + 1))) {
    const inCss = new Set([...shipped.matchAll(/@keyframes\s+(i3[A-Za-z0-9]+)/g)].map(x => x[1]));
    const missing = [...declaredFrames].filter(f => !inCss.has(f));
    const extra = [...inCss].filter(f => !declaredFrames.has(f));
    failures.push(
      "public/icons3d.css has drifted from src/icons3d.jsx" +
      (missing.length ? `\n          missing there: ${missing.join(", ")}` : "") +
      (extra.length ? `\n          only there: ${extra.join(", ")}` : "") +
      (!missing.length && !extra.length ? " (same animations, different rules)" : "")
    );
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nicons3d: ${failures.length} FAILED (${icons.length} icons, ${checked} checks)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`icons3d: ${icons.length} icons clean — refs resolve, animations declared and reduced-motion safe, all in use`);
