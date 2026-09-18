// THE LISTING'S OWN PHOTOGRAPH OF THE CAR -- the rules for using one.
//
// Everything in this file exists so that the emailed PDF can print a picture of
// the vehicle without ever printing a picture of a DIFFERENT vehicle, and
// without turning an unauthenticated edge function into a fetch-anything proxy.
// It lives here rather than inside email-quote-report/index.ts because a guard
// that cannot be imported cannot be tested, and this repo has shipped an
// untested guard before (test-published-price.mjs was green 8/8 while wired to
// nothing).
//
// THE THREE RULES, in the order they bind:
//
//  1. ANCHORED. The photo travels attached to the VIN it was published beside,
//     and prints only when that VIN is the one the report is about.
//     extractJsonLdVehicle() returns the FIRST priced vehicle node and does not
//     anchor to the page's subject, so on a page with a similar-vehicles rail it
//     can return a neighbour's picture. Measured on the 41 captured pages: 8
//     declare more than one vehicle, 23 publish a photo on a vehicle node, and
//     all 23 publish a VIN on that same node -- so the anchor closes a
//     one-in-five risk at no cost in coverage.
//
//  2. SEALED. The URL rides inside canonicalReport() as `ph` (v14). The email
//     endpoint is unauthenticated and gated only on that signature, and
//     report-auth.test.ts pins the residual that fields OUTSIDE the projection
//     are not bound by it. Unsealed, a caller holding one genuine report could
//     choose an address for us to fetch and print inside a DKIM-signed
//     lotcheck.ca document.
//
//  3. PROVEN. The bytes are believed over the headers. A server may label
//     anything image/jpeg; only the file's own first bytes decide.

export const PHOTO_MAX_BYTES = 3_000_000;
export const PHOTO_TIMEOUT_MS = 6_000;
// Identifies itself honestly. This project does not spoof a browser agent to
// get past a refusal: if a host declines an identified request, that is an
// answer, and the report says no photo rather than pretending to be something
// else to obtain one.
export const PHOTO_UA = "LotCheckBot/1.0 (+https://lotcheck.ca)";

export interface VehiclePhoto {
  bytes: Uint8Array;
  kind: "jpg" | "png";
  url: string;
}

// NOTHING IN THIS CODEBASE HAS EVER FETCHED A URL SCRAPED OUT OF A DEALER'S OWN
// PAGE BEFORE. Everything else it fetches is a URL the user typed or one a
// vendor's API handed back. This is the first, so it gets a perimeter the rest
// of the tree never needed.
//
// WHAT THIS STOPS: a dealer publishing http://169.254.169.254/ or http://10.0.0.5/
// in their own schema.org markup and using our edge function as a probe into the
// network it runs in. An IP literal is never a photo CDN -- both hosts in the
// captured corpus are names -- so refusing literals outright removes the class
// without enumerating ranges that change.
//
// WHAT THIS DOES NOT STOP, said plainly rather than left for someone to find:
// DNS rebinding. A public name that resolves to a private address passes this,
// and Deno offers no hook to pin resolution. What bounds it instead is that
// NOTHING COMES BACK -- the response is never returned to the caller, never
// logged, and is discarded unless its first bytes are a real JPEG or PNG -- and
// that the URL is SEALED, so choosing it means controlling the dealer page we
// read, not merely holding a report.
export function publicWebHost(raw: string): boolean {
  const host = String(raw || "").toLowerCase();
  if (!host || host.length > 255) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;        // IPv4 literal
  if (host.startsWith("[") || host.includes(":")) return false;  // IPv6 literal
  if (!host.includes(".")) return false;                         // localhost, bare names
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return false;
  return true;
}

// THE FILE'S OWN FIRST BYTES, not the server's content-type header. pdf-lib
// 1.17.1 embeds PNG and JPEG and nothing else -- a WEBP or AVIF that a CDN
// content-negotiated into the response would reach embedJpg() and throw inside
// the one function that must never fail.
export function imageKindFromBytes(b: Uint8Array | null | undefined): "jpg" | "png" | null {
  if (!b || b.length < 8) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  return null;
}

// Rule 1, as one function, so there is exactly one author of "may this picture
// be printed". Both VINs come from a SEALED projection by the time this is
// called, so it compares sealed against sealed.
export function photoAnchorOk(a: any): boolean {
  const url = typeof a?.vehiclePhotoUrl === "string" ? a.vehiclePhotoUrl.trim() : "";
  const pvin = String(a?.vehiclePhotoVin || "").trim().toUpperCase();
  const rvin = String(a?.vin || "").trim().toUpperCase();
  return !!(url && pvin && rvin && pvin === rvin);
}

export async function fetchVehiclePhoto(url: string): Promise<VehiclePhoto | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  // https only. The sealed URL came off a page we fetched over https; a plain
  // http fetch from inside the edge function is downgradeable in transit and
  // there is no reason to accept one.
  if (u.protocol !== "https:") return null;
  if (!publicWebHost(u.hostname)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PHOTO_TIMEOUT_MS);
  try {
    const r = await fetch(u.href, {
      headers: { "user-agent": PHOTO_UA, accept: "image/jpeg,image/png" },
      redirect: "follow",
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    // Cheap refusal before reading a body, when the server declares one.
    if (Number(r.headers.get("content-length") || 0) > PHOTO_MAX_BYTES) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength > PHOTO_MAX_BYTES || bytes.byteLength < 256) return null;
    const kind = imageKindFromBytes(bytes);
    if (!kind) return null;
    return { bytes, kind, url: u.href };
  } catch {
    // A photo is never worth a failed report. Every failure here is silent and
    // the PDF prints the absence instead. [[no-single-point-of-failure]]
    return null;
  } finally {
    clearTimeout(timer);
  }
}
