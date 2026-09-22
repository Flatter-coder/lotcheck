// Text out of a PDF, so a figure published in a document can be re-read like
// one published on a page.
//
// WHY THIS EXISTS. On 2026-09-21 the warranty job reported DRIFT on Toyota:
// hybrid_ev_coverage "no longer found on the manufacturer's page". It was a
// false alarm with real teeth. The row cited toyota.ca's warranty landing page,
// which shows only BEV and Electric Vehicle summary tiles. Toyota's actual
// hybrid terms live in the Owner's Manual Supplement PDF, which the row's own
// notes field already named — and that PDF states, verbatim:
//
//     Hybrid-Related Components Warranty   96 months or 160,000 km
//     Hybrid Battery Warranty             120 months or 240,000 km
//
// Both of which we hold, correctly. Acting on that DRIFT — updating the row to
// match the page — would have cut two years and 80,000 km off the hybrid
// battery term in every Toyota hybrid report. The most valuable fact a used
// Prius buyer gets, quietly reduced, by a job doing its job.
//
// The same shape is why Ford, Nissan and Subaru report "cites a printed
// booklet, not a web page". A booklet published as a PDF is re-readable; it
// was only unreadable because nothing here could open one.
//
// NOT A PDF LIBRARY. This pulls literal strings out of text-showing operators
// in Flate-compressed content streams. That is enough to confirm a figure is
// still stated and nothing more. It cannot lay out a page, and a PDF whose
// text is an image returns nothing — which reads as "could not be read", never
// as "the figure is gone".
import zlib from "node:zlib";

// Adobe's standard ligature glyphs arrive as octal escapes in the literal.
// "e036ect" is "effect" and "037rst" is "first"; left unmapped they only make
// the output ugly, but a figure sitting next to one would still be found.
const LIGATURES = [
  ["İ", "ff"], ["036", "ff"], ["037", "fi"], ["038", "fl"],
  ["222", "'"], ["223", '"'], ["224", '"'], ["226", "-"], ["227", "-"],
];

/** Decompress every Flate content stream in the file. */
function streams(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    const e = buf.indexOf("endstream", s);
    if (e < 0) break;
    let b = s + "stream".length;
    while (buf[b] === 0x0d || buf[b] === 0x0a) b++;
    try { out.push(zlib.inflateSync(buf.subarray(b, e)).toString("latin1")); }
    catch { /* not a Flate stream — image, font, or already plain */ }
    i = e + "endstream".length;
  }
  return out;
}

/** Literal strings out of one content stream, in page order. */
function literals(chunk) {
  let out = "";
  let j = 0;
  const BACKSLASH = String.fromCharCode(92);
  while (j < chunk.length) {
    const c = chunk[j];
    if (c === "(") {
      let k = j + 1, s = "", depth = 1;
      while (k < chunk.length) {
        const ch = chunk[k];
        if (ch === BACKSLASH) { s += chunk[k + 1] ?? ""; k += 2; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) break; }
        s += ch; k++;
      }
      out += s;
      j = k + 1;
      continue;
    }
    // T* and ]TJ end a run — without a separator, adjacent runs weld words
    // together and "160,000 km" stops matching.
    if (c === "T" && chunk[j + 1] === "*") { out += " "; j += 2; continue; }
    if (c === "]" && chunk[j + 1] === "T" && chunk[j + 2] === "J") { out += " "; j += 3; continue; }
    j++;
  }
  return out;
}

/**
 * Extract readable text from a PDF buffer.
 * Returns "" when nothing could be read — the caller must treat that as
 * "could not be read", never as "the figure is absent".
 */
export function pdfText(buffer) {
  if (!buffer || !buffer.length) return "";
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let out = streams(buf).map(literals).join(" ");
  for (const [from, to] of LIGATURES) out = out.split(from).join(to);
  return out.replace(/\s+/g, " ").trim();
}

/** Does this response body look like a PDF? */
export function looksLikePdf(contentType, buffer) {
  if (typeof contentType === "string" && /application\/pdf/i.test(contentType)) return true;
  if (!buffer || buffer.length < 5) return false;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}
