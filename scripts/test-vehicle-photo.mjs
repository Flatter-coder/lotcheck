// THE CAR'S PHOTOGRAPH, AND THE THREE THINGS THAT MUST NEVER HAPPEN.
// Run: node --experimental-strip-types scripts/test-vehicle-photo.mjs
//
// The emailed PDF now prints the dealer's own photograph of the vehicle. Three
// ways that goes wrong, and assertions for each:
//
//   1. IT IS A DIFFERENT CAR. extractJsonLdVehicle() returns the FIRST priced
//      vehicle node and does not anchor to the page's subject, so a page with a
//      similar-vehicles rail can hand back a neighbour's picture. A wrong figure
//      can be qualified in prose; a wrong photograph is another car presented as
//      this one. [[ai-defamation-entity-match-lesson]]
//
//   2. IT IS THE DEALER'S LOGO. 10 of the 41 captured pages publish an og:image
//      and in all ten it is a dealer banner. og:image is not a fallback, and the
//      structural reason it can never be picked is that only the vehicle node is
//      ever read.
//
//   3. IT IS A URL THE CALLER CHOSE. email-quote-report is unauthenticated and
//      gated only on the report signature, and report-auth.test.ts pins that
//      fields outside canonicalReport() are NOT bound by it. So the URL must sit
//      inside the canonical, and the fetch must refuse a host that is not a
//      public web host and bytes that are not really an image.
//
// These run offline against the real modules. The PDF's own LAYOUT is not
// checked here -- rendering it needs pdf-lib, which the offline gates job has no
// way to install -- so that is verified by hand through the render harness and
// is NOT claimed green by this file. [[run-every-gate-before-done]]

import { extractJsonLdVehicle, fillFromJsonLd, vehiclePhotoUrl } from "../supabase/functions/_shared/jsonld-vehicle.js";
import { publicWebHost, imageKindFromBytes, photoAnchorOk, PHOTO_UA } from "../supabase/functions/_shared/vehicle-photo.ts";
import { canonicalReport } from "../supabase/functions/_shared/report-sign.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond ? "" : "\n        " + detail));
  cond ? pass++ : fail++;
};

const VIN = "3GNAXUEV7NL181253";
const OTHER_VIN = "1FTFW1E84MKE12345";
const CAR = "https://content.homenetiol.com/640x480/62248f08a2a843f1bdf8094d2a5afab4.jpg";
const LOGO = "https://static.foxdealer.com/492/2026/05/wolfe-chevrolet-edmonton-horizontal-1efb7a9e67.png";

const page = (nodes) => nodes
  .map((n) => '<script type="application/ld+json">' + JSON.stringify(n) + "</script>")
  .join("\n");

const vehicleNode = (o = {}) => ({
  "@type": "Car",
  vehicleModelDate: "2022",
  brand: "Chevrolet",
  model: "Equinox",
  vehicleIdentificationNumber: VIN,
  mileageFromOdometer: { value: 45786, unitCode: "KMT" },
  image: CAR,
  offers: { "@type": "Offer", price: "26999", priceCurrency: "CAD" },
  ...o,
});
const dealerNode = { "@type": "AutoDealer", name: "Wolfe Chevrolet Edmonton", image: LOGO, logo: LOGO };

// ── 1. THE SUBJECT ──────────────────────────────────────────────────────────
{
  const v = extractJsonLdVehicle(page([dealerNode, vehicleNode()]));
  check("the photo comes off the vehicle node, not the dealer's",
    v.vehiclePhotoUrl === CAR, String(v.vehiclePhotoUrl));
  check("...and it arrives anchored to that node's own VIN",
    v.vehiclePhotoVin === VIN, String(v.vehiclePhotoVin));
}
{
  // The shape the extractor cannot resolve on its own: a vehicle node with no
  // VIN. Its picture may be of anything, so it does not travel.
  const v = extractJsonLdVehicle(page([vehicleNode({ vehicleIdentificationNumber: undefined })]));
  check("a vehicle node with NO VIN yields no photo at all",
    v.vehiclePhotoUrl === null && v.vehiclePhotoVin === null,
    JSON.stringify({ u: v.vehiclePhotoUrl, vin: v.vehiclePhotoVin }));
}
{
  // The rail: the report is about OTHER_VIN and the first priced node is a
  // neighbour. That photo must not attach itself to this report.
  const parsed = { vin: OTHER_VIN };
  fillFromJsonLd(parsed, extractJsonLdVehicle(page([vehicleNode()])));
  check("a photo whose VIN disagrees with the report's is refused",
    parsed.vehiclePhotoUrl === undefined, String(parsed.vehiclePhotoUrl));
}
{
  const parsed = { vin: VIN };
  fillFromJsonLd(parsed, extractJsonLdVehicle(page([vehicleNode()])));
  check("a photo whose VIN agrees is carried, with its VIN",
    parsed.vehiclePhotoUrl === CAR && parsed.vehiclePhotoVin === VIN,
    JSON.stringify({ u: parsed.vehiclePhotoUrl, vin: parsed.vehiclePhotoVin }));
}

// ── 2. NEVER THE LOGO ───────────────────────────────────────────────────────
{
  // Structural, not a blocklist: the dealer node is never handed to the reader.
  const v = extractJsonLdVehicle(page([dealerNode]));
  check("a page with ONLY a dealer node yields no vehicle and no photo",
    v === null, JSON.stringify(v));
}
check("an Organization's `logo` is never read as a vehicle photo",
  vehiclePhotoUrl({ logo: CAR }) === null, String(vehiclePhotoUrl({ logo: CAR })));
check("a data: URI is refused -- a buyer cannot re-fetch and re-check it",
  vehiclePhotoUrl({ image: "data:image/png;base64,iVBORw0KGgo=" }) === null);
check("a relative src is refused",
  vehiclePhotoUrl({ image: "/img/car.jpg" }) === null);
check("a schema.org ImageObject is read through to its url",
  vehiclePhotoUrl({ image: { "@type": "ImageObject", url: CAR } }) === CAR);

// ── 3. THE URL IS SEALED, THE HOST IS PUBLIC, THE BYTES ARE REAL ────────────
{
  const c = canonicalReport({ vehiclePhotoUrl: CAR, vehiclePhotoVin: VIN, vin: VIN, quotedPrice: 1 });
  check("the photo is SEALED into the canonical as `ph`",
    !!c.ph && c.ph.u === CAR && c.ph.vin === VIN, JSON.stringify(c.ph));
  check("the canonical is at the version that seals it", c.v === 16, String(c.v));
  check("a photo with no VIN seals as null, never as a bare URL",
    canonicalReport({ vehiclePhotoUrl: CAR, quotedPrice: 1 }).ph === null);
}
for (const [host, want, why] of [
  ["content.homenetiol.com", true, "a real photo CDN"],
  ["prod.pictures.autoscout24.net", true, "the other real photo CDN"],
  ["169.254.169.254", false, "the cloud metadata address"],
  ["127.0.0.1", false, "loopback"],
  ["10.0.0.5", false, "private range"],
  ["[::1]", false, "IPv6 loopback"],
  ["localhost", false, "no dot"],
  ["printer.local", false, "mDNS"],
  ["db.internal", false, "internal suffix"],
]) {
  check("host policy: " + host + " -> " + (want ? "allowed" : "refused") + " (" + why + ")",
    publicWebHost(host) === want);
}
{
  const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // RIFF....WEBP -- what a CDN content-negotiates into the response while still
  // labelling it image/jpeg. pdf-lib 1.17.1 cannot embed it.
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const html = new TextEncoder().encode("<!doctype html><html>nope</html>");
  check("JPEG magic bytes are believed", imageKindFromBytes(jpg) === "jpg");
  check("PNG magic bytes are believed", imageKindFromBytes(png) === "png");
  check("a WEBP is refused, whatever the server called it", imageKindFromBytes(webp) === null);
  check("an HTML error page is refused", imageKindFromBytes(html) === null);
  check("empty bytes are refused", imageKindFromBytes(new Uint8Array(0)) === null);
}
{
  check("the anchor holds on matching VINs",
    photoAnchorOk({ vehiclePhotoUrl: CAR, vehiclePhotoVin: VIN, vin: VIN }) === true);
  check("the anchor refuses mismatched VINs",
    photoAnchorOk({ vehiclePhotoUrl: CAR, vehiclePhotoVin: VIN, vin: OTHER_VIN }) === false);
  check("the anchor refuses a URL with no VIN beside it",
    photoAnchorOk({ vehiclePhotoUrl: CAR, vin: VIN }) === false);
  check("the anchor refuses a report with no VIN of its own",
    photoAnchorOk({ vehiclePhotoUrl: CAR, vehiclePhotoVin: VIN }) === false);
}

// ── 4. WE SAY WHO WE ARE ────────────────────────────────────────────────────
// Honest identification, not browser impersonation. A host that refuses an
// identified request has answered, and the report says no photo rather than
// pretending to be a browser to obtain one.
check("the fetcher identifies itself and offers a contact URL",
  /^LotCheckBot\/[\d.]+ \(\+https:\/\/lotcheck\.ca\)$/.test(PHOTO_UA), PHOTO_UA);
check("...and never claims to be a browser",
  !/Mozilla|Chrome|Safari|AppleWebKit/i.test(PHOTO_UA), PHOTO_UA);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
