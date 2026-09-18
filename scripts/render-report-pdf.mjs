// SEE THE PDF A CUSTOMER ACTUALLY RECEIVES.
//
// buildReportPdf() in supabase/functions/email-quote-report/index.ts is the
// single author of the emailed report, and until 2026-09-18 nothing outside
// Deno could reach it: it is not exported, it pulls pdf-lib over https, and the
// module calls Deno.serve() at load. So every change to that PDF -- the one
// artifact a buyer prints and carries to a dealership -- shipped unseen.
//
// This does NOT copy the function. Copying is how a second author starts, and
// two authors per fact is the shape behind most of docs/FIXING-HISTORY.md. It
// reads the LIVE source on every run and applies three mechanical rewrites, so
// what renders here is what ships:
//
//   1. the two https://esm.sh specifiers  -> the locally installed packages
//   2. "../_shared/x"                     -> absolute file: URLs
//   3. an export line appended            -> the function becomes reachable
//
// Deno.env / Deno.serve are stubbed on globalThis before the import.
//
// NOT A GATE, and deliberately so. The offline `gates` job in gates.yml runs
// without `npm install`, so it can never render a PDF; claiming otherwise would
// be a gate that cannot fail. pdf-lib is therefore NOT a dependency of this
// repo -- install it on demand:
//
//   npm i --no-save pdf-lib@1.17.1 @pdf-lib/fontkit@1.1.1
//   node --experimental-strip-types scripts/render-report-pdf.mjs out.pdf [analysis.json]
//
// With no analysis.json it renders the built-in fixture below: a real Alberta
// listing, with a vehicle photo, so the page-1 photo band is exercised. Pass
// `--no-photo` to see the 44% of listings that publish none.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FN = resolve(ROOT, "supabase/functions/email-quote-report/index.ts");
const SHARED = pathToFileURL(resolve(ROOT, "supabase/functions/_shared/")).href + "/";

async function loadBuildReportPdf() {
  let src = readFileSync(FN, "utf8");
  const before = src;
  src = src.split('"https://esm.sh/pdf-lib@1.17.1"').join('"pdf-lib"');
  src = src.split('"https://esm.sh/@pdf-lib/fontkit@1.1.1"').join('"@pdf-lib/fontkit"');
  src = src.split('"../_shared/').join('"' + SHARED);
  if (src === before) throw new Error("no rewrite applied - this harness is out of step with the source");
  if (!/async function buildReportPdf\(/.test(src)) throw new Error("buildReportPdf not found in the live source");
  src += "\nexport { buildReportPdf };\n";

  // The generated module must sit where `pdf-lib` resolves, i.e. under a
  // directory whose node_modules lookup reaches this repo's.
  const dir = mkdtempSync(join(ROOT, ".pdfrender-"));
  const out = join(dir, "report-pdf.ts");
  writeFileSync(out, src);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));

  globalThis.Deno = globalThis.Deno || { env: { get: () => undefined }, serve: () => {} };
  const mod = await import(pathToFileURL(out).href);
  return { build: mod.buildReportPdf, dir };
}

// A real listing, with the figures production holds for it.
const FIXTURE = {
  reportId: "LC-EQX-4417",
  issuedAt: "2026-09-18T14:22:00.000Z",
  reportDate: "2026-09-18",
  year: 2022, make: "Chevrolet", model: "Equinox", trim: "LT",
  vehicle: "2022 Chevrolet Equinox LT",
  vehicleCondition: "used",
  vin: "3GNAXUEV7NL181253",
  odometerKm: 45786,
  quotedPrice: 26999,
  dealerName: "Wolfe Chevrolet Edmonton",
  dealerCity: "Edmonton",
  province: "AB",
  allInPricing: true,
  fuelType: "Gas",
  recalls: { checked: true, count: 1, open: 1, source: "Transport Canada" },
  dealerLicence: { state: "valid", status: "Licensed", registration_number: "B1019884" },
  dealerRating: { rating: 4.6, count: 1841 },
  daysOnLot: { days: 62 },
  docFeeCheck: { checked: true, docFee: 699 },
  financingCheck: { checked: true, consistent: true },
  financeContingent: { contingent: false },
  vinCheck: { present: true },
  addOns: [],
  feesRead: true,
  vehiclePhotoUrl: "https://content.homenetiol.com/640x480/62248f08a2a843f1bdf8094d2a5afab4.jpg",
  vehiclePhotoVin: "3GNAXUEV7NL181253",
};

const args = process.argv.slice(2);
const noPhoto = args.includes("--no-photo");
const positional = args.filter((a) => !a.startsWith("--"));
const outPath = positional[0] || "report.pdf";
const analysis = positional[1] ? JSON.parse(readFileSync(positional[1], "utf8")) : FIXTURE;

// PROBE FIRST, before anything opens a socket or a timer. buildReportPdf()
// imports pdf-lib LAZILY, inside its own body, so a missing package does not
// surface when the module loads -- it surfaces mid-render as an unhandled
// rejection with a stack trace, which reads like a broken harness rather than a
// missing install. Ask the cheap question while exiting is still free.
try {
  await import("pdf-lib");
  await import("@pdf-lib/fontkit");
} catch {
  console.error("pdf-lib is not installed. It is deliberately not a dependency of\n" +
    "this repo -- the offline gates job cannot install it, and a renderer wired\n" +
    "into a job that cannot run it is a gate that cannot fail. Install on demand:\n\n" +
    "  npm i --no-save pdf-lib@1.17.1 @pdf-lib/fontkit@1.1.1");
  process.exit(2);
}

// The handler fetches the photo itself, AFTER the signature verifies and the VIN
// anchor holds (see _shared/vehicle-photo.ts). This harness stands in for that
// one step so the band can be seen; it does not reimplement the rules.
let photo = null;
if (!noPhoto && analysis.vehiclePhotoUrl) {
  const { fetchVehiclePhoto, photoAnchorOk } = await import(SHARED + "vehicle-photo.ts");
  photo = photoAnchorOk(analysis) ? await fetchVehiclePhoto(analysis.vehiclePhotoUrl) : null;
  if (!photo) console.warn("no photo: the anchor refused it, or it would not fetch as a JPEG/PNG");
}

const ctx = await loadBuildReportPdf();
const bytes = await ctx.build(analysis, "https://lotcheck.ca/verify?r=" + analysis.reportId, null, photo);
writeFileSync(outPath, bytes);
console.log(`${outPath}  ${bytes.length} bytes  photo=${photo ? photo.kind : "none"}`);
console.log(`(scratch module left at ${ctx.dir} - delete it when you are done)`);
