// The guard that decides whether a computed dealer count is safe to write.
//
// Pure and separate from update-alberta-dealers.mjs on purpose: that script is a
// top-level-await module that performs its whole job on import, so there is no
// way to exercise its refusal paths without going to the network. The rule is
// what needs locking down, so the rule lives here and is tested directly.
//
// WHY IT EXISTS. update-alberta-dealers.mjs floored two numbers — the raw
// Overpass response, and the subset with a name and coordinates — and then
// wrote a THIRD number it never checked: the count that survives binning to the
// nearest listed city. Those differ by every dealer further than MAX_KM from one
// of the 33 cities. A run where all of them fall outside that radius passes both
// existing floors, writes `"totalDealers": 0`, and exits 0.
//
// And an absolute floor alone cannot catch a collapse. Fifty is ~12% of a normal
// run, so 405 -> 51 clears it and commits green. That is the catalog-refresh
// incident again in a different file: a green signal with no check behind it.
// The settled rule from that incident is compare-against-what-you-have, so this
// takes the previous total as its baseline rather than trusting a constant.

/**
 * Throws if the computed output must not overwrite the previous file.
 *
 * @param {object}  a
 * @param {number}  a.assigned    dealers that survived binning — the number written
 * @param {number}  a.examined    dealers that went into binning (for the message)
 * @param {?number} a.prevTotal   totalDealers currently on disk, or null on first run
 * @param {number}  a.minFloor    absolute floor below which any result is suspect
 * @param {number}  a.maxKm       binning radius, quoted in the message
 * @param {string}  a.outPath     output path, quoted in the recovery instruction
 * @param {number} [a.maxDropPct] refuse a drop of at least this share (default 0.5)
 */
export function assertOutputSane({ assigned, examined, prevTotal, minFloor, maxKm, outPath, maxDropPct = 0.5 }) {
  if (!Number.isFinite(assigned)) {
    throw new Error(`dealer count is not a number (${assigned}) — refusing to overwrite ${outPath}.`);
  }
  // A binning collapse is not an upstream problem, and saying so saves the next
  // person from going to look at Overpass when the bug is MAX_KM or CITIES.
  if (assigned < minFloor) {
    throw new Error(
      `only ${assigned} of ${examined} dealers fell within ${maxKm}km of a listed city — ` +
      `refusing to overwrite ${outPath}. The fetch itself worked, so this is a binning ` +
      `problem: check MAX_KM and the CITIES list, not Overpass.`);
  }
  if (prevTotal !== null && prevTotal !== undefined && Number.isFinite(prevTotal) && prevTotal > 0) {
    if (assigned < prevTotal * (1 - maxDropPct)) {
      const pct = Math.round((1 - assigned / prevTotal) * 100);
      throw new Error(
        `dealer count collapsed ${prevTotal} -> ${assigned} (${pct}% drop) — refusing to ` +
        `overwrite ${outPath}. A real week of roster change moves this by a handful. ` +
        `If the drop is genuine, delete ${outPath} and re-run to accept the new baseline.`);
    }
  }
}
