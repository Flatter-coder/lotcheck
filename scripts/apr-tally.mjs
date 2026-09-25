// The APR (new) catalogue's verdict, from each make's own fresh-rows guard
// (catalog-rates-daily.yml). Prints the summary JSON record-catalog-status.mjs
// reads. Green only when every make wrote fresh rates; a make with no tally
// line -- its leg never got that far -- counts as not refreshed.
//
//   node scripts/apr-tally.mjs <dir of "Name|outcome" files> <workflow file>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function legNames(workflowYaml) {
  return [...String(workflowYaml).matchAll(/- \{ name: ([^,]+),/g)].map((m) => m[1].trim());
}

export function aprTally(lines, expected) {
  const ok = new Set(), seen = new Set();
  for (const l of lines) {
    const [name, outcome] = String(l).trim().split("|");
    if (!name) continue;
    seen.add(name);
    if (outcome === "success") ok.add(name);
  }
  const notDone = expected.filter((n) => !ok.has(n));
  const n = expected.length, k = n - notDone.length;
  const state = k === n ? "green" : k > 0 ? "amber" : "red";
  const note = k === n
    ? `All ${n} makes' published finance rates were re-read and written fresh.`
    : `${k} of ${n} makes' finance rates were written fresh; not refreshed: ${notDone.map((x) => (seen.has(x) ? x : `${x} (no result)`)).join(", ")}.`;
  return { state, covered: k, of_total: n, unit: "makes", note };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, wf] = process.argv.slice(2);
  const lines = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => readFileSync(join(dir, f), "utf8")) : [];
  console.log(JSON.stringify(aprTally(lines, legNames(readFileSync(wf, "utf8")))));
}
