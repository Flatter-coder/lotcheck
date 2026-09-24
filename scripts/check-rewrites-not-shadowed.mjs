// A REWRITE THAT A FILE SILENTLY OVERRULES.
//
// Vercel serves a real file from the output (public/ is copied as-is) BEFORE
// it consults `rewrites`. So a rewrite whose source path is also a file never
// runs: the deploy is green, the config reads correctly, and production keeps
// serving the file. That is exactly how PR #537 shipped (2026-09-24): vercel.json
// said `/ -> /app.html`, public/index.html still existed, and lotcheck.ca kept
// the old landing page after a SUCCESS deploy.
//
// This checks every rewrite with a literal source path: if public/ holds the
// file Vercel would serve for that path, and it is not the rewrite's own
// destination, the rewrite is dead and the build fails.
//
//   node scripts/check-rewrites-not-shadowed.mjs
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8"));
const literal = (src) => !/[()*:?+[\]{}]/.test(src);
// What a request for `path` resolves to on disk, if anything.
const fileFor = (path) => (path.endsWith("/") ? path + "index.html" : path);

let bad = 0, checked = 0;
for (const r of cfg.rewrites || []) {
  if (!literal(r.source)) continue;
  checked++;
  const f = fileFor(r.source);
  const onDisk = resolve(ROOT, "public", "." + f);
  if (existsSync(onDisk) && f !== r.destination) {
    bad++;
    console.error(`FAIL  rewrite ${r.source} -> ${r.destination} never runs: public${f} exists and Vercel serves it first`);
  }
}
// The shape also has a self-test, so this gate cannot pass by construction.
{
  const probe = { source: "/", destination: "/app.html" };
  if (fileFor(probe.source) !== "/index.html") { console.error("FAIL  self-test: '/' must resolve to /index.html"); bad++; }
  if (literal("/((?!api/).*)")) { console.error("FAIL  self-test: a pattern source was read as literal"); bad++; }
}
if (bad) process.exit(1);
console.log(`ok  ${checked} literal rewrite(s); none shadowed by a file in public/`);
