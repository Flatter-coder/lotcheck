// ONE page source per scan, and a blocked origin must not empty the report.
//
// WHY THIS EXISTS. Every structured reader on the main path (JSON-LD,
// Convertus vmsData, D2C __vdpJSON, incentives, finance-contingent) used to
// hang off a single direct GET. When that one GET was refused, all of them
// resolved null together. Confirmed live 2026-08-27 on a real paid report
// (LC-46A4-66F, a 2026 Lexus NX 350h at a Convertus dealer): the page's own
// vmsData carried asking_price 62005, VIN 2T2GKCEZ8TC072832, msrp 58675,
// 8.99% APR and date_on_lot 2026-05-04 the whole time, and the buyer was shown
// "ASKING PRICE: Not shown" and "VIN: NOT ON QUOTE". Measured against that
// host, 57 of 67 requests returned a 5,927-byte Cloudflare challenge shell and
// every request after that returned HTTP 429.
//
// The rescue render was ALREADY being paid for on exactly those scans, and its
// HTML was being parsed by a separate, later pipeline. This makes it the
// second source for the SAME readers, so a blocked origin costs us coverage of
// nothing we already hold. [[no-single-point-of-failure]]
//
// It is a FALLBACK, never an override: a successful direct read always wins,
// because it is the unmodified page as the origin served it.

// A rendered page below this size is a challenge shell or an error stub, not a
// vehicle page — the same floor fetchDirectHtml applies to a direct read.
export const MIN_USABLE_HTML = 500;

/**
 * The HTML every reader in a scan should parse.
 *
 * @param {string|null} directHtml   result of the direct read (null = refused)
 * @param {{html?: string|null}|null} render  the rescue render, if one ran
 * @param {(msg: string) => void} [log]
 * @returns {{ html: string|null, source: "direct"|"render"|"none" }}
 */
export function resolvePageSource(directHtml, render, log) {
  if (typeof directHtml === "string" && directHtml.length >= MIN_USABLE_HTML) {
    return { html: directHtml, source: "direct" };
  }
  const rendered = render && typeof render.html === "string" && render.html.length >= MIN_USABLE_HTML
    ? render.html
    : null;
  if (rendered) {
    if (log) log(`Direct fetch blocked — structured readers falling back to the rendered page (${rendered.length} bytes).`);
    return { html: rendered, source: "render" };
  }
  return { html: null, source: "none" };
}
