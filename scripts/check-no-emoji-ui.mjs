#!/usr/bin/env node
// ============================================================================
// No emoji in shipped UI.
//
// The rule is not aesthetic. An emoji renders as whatever glyph the device
// ships, so the same report looked like a different product on Android than it
// did on macOS — and the one thing a buyer is meant to trust is that the report
// they were sent is the report everyone gets. A dealer disputing a report has
// to be arguing with the same artifact the buyer saw.
//
// 95 sites were swept out at once. Without a gate, they come back one at a
// time: an emoji is the fastest way to put a picture in a string, so the next
// person adding a card reaches for one, and nothing complains.
//
// WHAT STAYS. Typographic and geometric marks are characters doing a
// character's job, and Vic keeps the checkmarks: ✓ ✗ ● ○ ▶ ◀ ⏸ → ↑ ↓ ← ↗ ↘ ™ ©
// A ✓ inside a badge is punctuation. A 🚗 at 52px is an icon, and icons come
// from src/icons3d.jsx.
//
// Console logging is exempt: it is developer output, never rendered to a user,
// and the ⚠ in a console.warn is genuinely useful when scanning a log.
// ============================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Characters that are pictographic by Unicode but read as typography here.
const ALLOWED = new Set([...'✓✗✔✘→↑↓←↗↘●○▶◀⏸™©•']);
const PICTO = /\p{Extended_Pictographic}/u;

const targets = [
  "src/App.jsx", "src/icons3d.jsx", "src/main.jsx", "src/scraper.js", "src/verify.js",
  // The emailed HTML + PDF is the artifact the buyer forwards to the dealer, and
  // it carried U+26A0 and U+1F53B in card copy until 2026-09-02 (Vic: card 04).
  "supabase/functions/email-quote-report/index.ts",
  ...readdirSync(join(root, "public")).filter(f => f.endsWith(".html")).map(f => "public/" + f),
];

const hits = [];
for (const rel of targets) {
  const file = join(root, rel);
  if (!existsSync(file)) continue;
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (/console\.(log|warn|error|info|debug)/.test(line)) return;
    const found = [...new Set([...line].filter(c => PICTO.test(c) && !ALLOWED.has(c)))];
    if (found.length) {
      hits.push({ rel, n: i + 1, chars: found.join(""), text: line.trim().replace(/\s+/g, " ").slice(0, 88) });
    }
  });
}

if (hits.length) {
  console.error(`\nEMOJI IN SHIPPED UI — ${hits.length} line${hits.length === 1 ? "" : "s"}\n`);
  for (const h of hits) console.error(`  ${h.rel}:${h.n}  [${h.chars}]  ${h.text}`);
  console.error(
    "\n  Use an icon from src/icons3d.jsx instead:\n" +
    '    <Icon3D name="warning" size={14}/>\n' +
    "  Static pages in public/ inline the same SVG with a data-icon attribute.\n" +
    "  If the value is ALSO an object key or an HTML title attribute, it has to\n" +
    "  stay a plain string — drop the glyph and let tone/colour carry it.\n" +
    "  Typographic marks (✓ ✗ ● ▶ → ™) are fine and are not what this catches.\n"
  );
  process.exit(1);
}

console.log(`no-emoji gate — clean (${targets.length} shipped files; ✓ and other typographic marks allowed)`);
