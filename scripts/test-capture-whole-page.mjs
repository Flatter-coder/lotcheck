// Regression suite for the WHOLE-PAGE guarantee on the sealed listing capture.
//
// WHY: Vic, on a Sundance Mazda CX-90 report -- "scrapfly only took screnshoot
// half the page". captureListingScreenshot asks Scrapfly for `capture=fullpage`
// and then threw the result away when its base64 ran past 1_500_000 chars,
// re-shooting the VIEWPORT instead: a photo of the top of the listing. The cap
// was a guess (fb67429: "size-capped so a giant full-page render never bloats
// the response/cache") that no downstream limit was ever measured against, and
// it fires on ordinary tall dealer pages -- so the degrade was not the rare
// path it was written as. The standing rule is that the capture is ALWAYS the
// whole page. [[capture-always-whole-page]]
//
// This pins the three things that make that true and keep it true:
//   1. the cap is DERIVED from the tightest real downstream limit, not chosen
//   2. a too-large page is re-shot WHOLE at a narrower width, not cropped
//   3. no surface claims "full-page" from a field it cannot back
//
// Pure and offline: no network, no Scrapfly key. The arithmetic and the source
// structure are where the bugs live.
//
// Run: node --experimental-strip-types scripts/test-capture-whole-page.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const SCRAPFLY = read("supabase/functions/_shared/scrapfly.ts");
const VISION_SRC = read("supabase/functions/_shared/vision-limits.ts");
const APP = read("src/App.jsx");
const EMAIL = read("supabase/functions/email-quote-report/index.ts");

const {
  CAPTURE_MAX_B64, CAPTURE_BASE_WIDTH, CAPTURE_MIN_WIDTH, CAPTURE_FIT_SAFETY,
  EMAIL_BODY_NON_CAPTURE_RESERVE, SHOT_PDF_EMBED_CAP, SHOT_B64_CAP,
  captureFitWidth, captureCoverage,
} = await import("../supabase/functions/_shared/capture.ts");
// The tightest limit of the four, and the one the first derivation missed.
const { MAX_BODY_BYTES } = await import("../supabase/functions/_shared/report-auth.ts");
const { VISION_MAX_B64_BYTES, VISION_MAX_EDGE_PX, jpegDimensions, visionImageVerdict } =
  await import("../supabase/functions/_shared/vision-limits.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ""}`); }
};

// ---------------------------------------------------------------------------
// 1. The cap is derived, and every consumer downstream of it accepts it.
// ---------------------------------------------------------------------------
console.log("\nThe cap is derived from a real limit, not chosen");

// PIN THE RELATION, NOT THE NUMBER. The first version of this gate asserted
// the cap equalled the vision ceiling and nothing else -- which pinned an
// INCOMPLETE derivation as if it were correct, the same mistake fb67429 made
// one constant over. The cap has to clear all four, so all four are asserted,
// and the tightest is the email body cap the first pass never consulted.
check("the capture plus the rest of a report still fits the email body cap",
  CAPTURE_MAX_B64 + EMAIL_BODY_NON_CAPTURE_RESERVE <= MAX_BODY_BYTES,
  `${CAPTURE_MAX_B64} + ${EMAIL_BODY_NON_CAPTURE_RESERVE} > ${MAX_BODY_BYTES}`);

check("the reserve is big enough for the non-capture payload actually measured",
  EMAIL_BODY_NON_CAPTURE_RESERVE >= 1_500_000,
  String(EMAIL_BODY_NON_CAPTURE_RESERVE));

check("the cap is the SMALLEST of the four limits, not one of them",
  CAPTURE_MAX_B64 === Math.min(
    MAX_BODY_BYTES - EMAIL_BODY_NON_CAPTURE_RESERVE,
    Math.floor((VISION_MAX_B64_BYTES * 4) / 3),
    SHOT_PDF_EMBED_CAP,
    SHOT_B64_CAP,
  ), String(CAPTURE_MAX_B64));

// The sealed shot does double duty as the vision input when both renders fail,
// so a capture we accept must be one Anthropic will also accept.
check("a capture at the cap still passes the vision byte ceiling",
  Math.floor((CAPTURE_MAX_B64 * 3) / 4) <= VISION_MAX_B64_BYTES,
  `${Math.floor((CAPTURE_MAX_B64 * 3) / 4)} > ${VISION_MAX_B64_BYTES}`);

check("a capture at the cap still embeds in the PDF evidence pages",
  CAPTURE_MAX_B64 < SHOT_PDF_EMBED_CAP, `${CAPTURE_MAX_B64} >= ${SHOT_PDF_EMBED_CAP}`);

check("a capture at the cap still parses on the email path",
  CAPTURE_MAX_B64 < SHOT_B64_CAP, `${CAPTURE_MAX_B64} >= ${SHOT_B64_CAP}`);

{
  // THREE copies of the 1_500_000 guess lived in this file, not one: the
  // capture path, scrapflyRenderOnce's screenshot cap, and the rescue
  // photo-lock re-attach (which compares the OTHER way, so it reads
  // differently and is easy to miss). Strip comments and assert none survives
  // in executable code -- an occurrence check over the raw file would pass on
  // the notes that explain the removal.
  const code = SCRAPFLY.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => l.replace(/\/\/.*/, "")).join("\n");
  check("no copy of the guessed cap survives in executable code",
    CAPTURE_MAX_B64 > 1_500_000 && !code.includes("1_500_000"),
    code.split("\n").filter((l) => l.includes("1_500_000")).join(" | "));
}

check("the honesty label is never defaulted to the strongest claim",
  /if \(shot\.kind\) analysis\.listingShotKind = shot\.kind;/.test(SCRAPFLY) &&
  !/listingShotKind = shot\.kind \|\| "fullpage"/.test(SCRAPFLY));

check("the rescue photo-lock says which shot it sealed",
  /parsed\.listingShotKind = "viewport";/.test(SCRAPFLY));

check("a whole-page capture replaces a top-of-page render shot, never the reverse",
  /if \(analysis\.listingShot && analysis\.listingShotKind === "fullpage"\) return;/.test(SCRAPFLY) &&
  /if \(replacing && shot\.kind !== "fullpage"\) return;/.test(SCRAPFLY));

{
  // Every field the capture measures about itself has to survive mergeRescued,
  // or the coverage sentence never renders on a rescue path -- built, but
  // unwired. listingShotKind was stripped here from the day PR #342 shipped it.
  const fill = (SCRAPFLY.match(/const fillKeys = \[[\s\S]*?\];/) || [""])[0];
  for (const k of ["listingShotKind", "listingShotWidthPx", "listingShotHeightPx", "listingShotPageHeightPx"]) {
    check(`mergeRescued carries ${k}`, fill.includes(`"${k}"`));
  }
}

// Okotoks Toyota came back at 2.5 MB, which is 3.33M b64 chars -- over the old
// cap, comfortably under this one. It now ships whole with NO extra call.
check("Okotoks (2.5 MB whole page) now fits with no retry at all",
  captureFitWidth(Math.ceil((2_500_000 * 4) / 3), CAPTURE_BASE_WIDTH) === null);

// ---------------------------------------------------------------------------
// 2. The refit arithmetic. Narrowing is the lever because the page does not
//    reflow shorter -- measured 5,873px tall at BOTH 1280 and 1024.
// ---------------------------------------------------------------------------
console.log("\nA too-large page is re-shot WHOLE at a narrower width");

check("a page just over the cap narrows, and not by much",
  (() => { const w = captureFitWidth(CAPTURE_MAX_B64 + 1, 1920); return w !== null && w < 1920 && w > 1500; })(),
  String(captureFitWidth(CAPTURE_MAX_B64 + 1, 1920)));

check("a 9M-char page narrows to a width that is predicted to fit",
  (() => {
    const w = captureFitWidth(9_000_000, 1920);
    if (w === null) return false;
    // Height is invariant under width, so bytes are linear in width.
    return 9_000_000 * (w / 1920) <= CAPTURE_MAX_B64;
  })(), String(captureFitWidth(9_000_000, 1920)));

check("the prediction keeps headroom under the cap (the encoder is not linear)",
  CAPTURE_FIT_SAFETY > 0 && CAPTURE_FIT_SAFETY < 1);

check("a page needing a sub-1024 width is refused, not re-shot as a different layout",
  captureFitWidth(60_000_000, 1920) === null);

// THE FLOOR IS TESTED, NOT JUST OBEYED. Refusing outright whenever the
// PREDICTED width lands under the floor throws away the whole page for a page
// that missed by a little -- and those are the tallest listings, the ones this
// fix exists for. The prediction is an upper bound, so a page that clears the
// cap at the floor itself is worth one real shot.
check("a page predicted just under the floor is still shot AT the floor",
  captureFitWidth(10_500_000, 1920) === CAPTURE_MIN_WIDTH,
  String(captureFitWidth(10_500_000, 1920)));

check("a page hopeless even at the floor spends no credit",
  captureFitWidth(11_300_000, 1920) === null,
  String(captureFitWidth(11_300_000, 1920)));

check("the floor is tested against the cap, not against the safety-reduced target",
  captureFitWidth(CAPTURE_MAX_B64 * (1920 / CAPTURE_MIN_WIDTH), 1920) === CAPTURE_MIN_WIDTH);

check("a shot already at the floor never retries itself",
  captureFitWidth(9_000_000, CAPTURE_MIN_WIDTH) === null);

check("the floor is the narrowest width that is still the desktop page",
  CAPTURE_MIN_WIDTH === 1024 && CAPTURE_BASE_WIDTH === 1920);

check("a capture already under the cap never triggers a retry",
  captureFitWidth(1, 1920) === null && captureFitWidth(1_000_000, 1920) === null);

check("nonsense inputs return null instead of a width",
  captureFitWidth(0, 1920) === null && captureFitWidth(9_000_000, 0) === null);

// THE MEASUREMENT THE WHOLE LEVER RESTS ON, taken in-browser on the failing
// Sundance Mazda CX-90 VDP (2026-08-27):
//
//     1920 wide -> 5,991 px tall      11.50 MP
//     1280 wide -> 5,873 px tall       7.52 MP   (65% of 1920)
//     1024 wide -> 5,873 px tall       6.01 MP   (52% of 1920)
//
// Height is invariant across a near-2x width range -- 2% -- so pixel count,
// and therefore bytes, fall almost exactly linearly with width. PR #342
// measured only 1280 vs 1024, saw 20%, and concluded scaling would not help;
// the render is at 1920, where the same move is a 48% cut. If a future page
// ever reflows TALLER when narrowed, this model over-predicts the saving, the
// refit comes back over the cap, and the ladder degrades honestly rather than
// silently -- which is why the safety factor exists.
{
  const PAGE_H = 5_991, MP_1920 = 1920 * PAGE_H;
  check("narrowing 1920 -> 1024 nearly halves the pixels (measured, not assumed)",
    (1024 * 5_873) / MP_1920 < 0.55 && (1024 * 5_873) / MP_1920 > 0.45,
    ((1024 * 5_873) / MP_1920).toFixed(3));
  check("the 1280 -> 1024 move alone is the small one PR #342 measured",
    Math.abs(1 - (1024 * 5_873) / (1280 * 5_873) - 0.20) < 0.01);
}

// ---------------------------------------------------------------------------
// 3. The ladder in the source. Structure, not arithmetic: the bug was that
//    "too large" fell straight to a cropped shot.
// ---------------------------------------------------------------------------
console.log("\nThe ladder photographs the page again before it photographs less of it");

check("the shot pins its own resolution instead of inheriting the Scrapfly default",
  /searchParams\.set\("resolution",/.test(SCRAPFLY) && /\$\{width\}x1080/.test(SCRAPFLY));

check("a too-large result carries the measurements the refit needs",
  /tooLarge: \{ b64Len: b64\.length, width: shotWidth, pageHeightPx:/.test(SCRAPFLY));

// The refit width is arithmetic on the width the image CAME BACK at, never on
// an assumed constant. Scrapfly's default resolution is documented, not
// verified by us, and if it ever moves the measurement follows it.
check("the width is read off the returned image, with the constant only as fallback",
  /const shotWidth = dim\?\.width \?\? width \?\? CAPTURE_BASE_WIDTH;/.test(SCRAPFLY));

check("the first shot sends no resolution at all (no new param on every capture)",
  /if \(width\) u\.searchParams\.set\("resolution",/.test(SCRAPFLY) &&
  /const shoot = async \(fullpage: boolean, ms: number, asp = false, width: number \| null = null\)/.test(SCRAPFLY));

{
  // Every rung issues a call with rendering_wait pinned at 8s, so a rung
  // entered with less than that cannot return before its own abort -- it
  // burns one of five concurrency slots and may still be billed.
  const wait = Number((SCRAPFLY.match(/searchParams\.set\("rendering_wait", "(\d+)"\)/) || [])[1]);
  const rungMin = Number((SCRAPFLY.match(/const CAPTURE_RUNG_MIN_MS = ([\d_]+);/) || ["", "0"])[1].replace(/_/g, ""));
  check("the rung floor clears the mandatory render wait", wait > 0 && rungMin > wait, `rung=${rungMin} wait=${wait}`);

  const fn = SCRAPFLY.slice(SCRAPFLY.indexOf("export async function captureListingScreenshot"),
                            SCRAPFLY.indexOf("export async function attachSealedScreenshot"));
  const bareGuards = [...fn.matchAll(/left\w*\s*[<>]=?\s*([\d_]+)/g)]
    .map((m) => Number(m[1].replace(/_/g, ""))).filter((n) => n < wait);
  check("no rung guard sits below the render wait", bareGuards.length === 0, bareGuards.join(","));

  check("the top-of-page fallback is reserved before a refit may run",
    /const CAPTURE_VIEWPORT_RESERVE_MS = /.test(SCRAPFLY) &&
    /left < CAPTURE_RUNG_MIN_MS \+ CAPTURE_VIEWPORT_RESERVE_MS/.test(SCRAPFLY) &&
    /Math\.min\(CAPTURE_REFIT_MS, left - CAPTURE_VIEWPORT_RESERVE_MS\)/.test(SCRAPFLY));

  check("a second refit is driven by the first refit's own measurement, and there is no third",
    /const CAPTURE_MAX_REFITS = 2;/.test(SCRAPFLY) &&
    /over = isTooLarge\(refit\) \? refit\.tooLarge : null;/.test(SCRAPFLY));
}

// Raising the cap made the whole-page capture reach the vision rescue, where
// the NEW jpeg dimension check refuses it on the 8,000px long edge -- and with
// no HTML behind it that rung returned null and killed the whole rescue. The
// evidence photo and the vision input do not have to be the same bytes.
check("a capture too tall to read degrades the vision INPUT, not the whole rescue",
  /viewportOnly\?: boolean/.test(SCRAPFLY) &&
  /if \(!visionImageVerdict\(shot\.b64, shot\.mime\)\.ok\)/.test(SCRAPFLY) &&
  /captureListingScreenshot\(url, left, \{ viewportOnly: true \}\)/.test(SCRAPFLY));

// listingShot is written unconditionally and the measurements conditionally, so
// a replacement could inherit the previous image's height and print a coverage
// percentage about an image those numbers do not describe.
check("the measurement fields are cleared whenever a new image is written",
  /delete analysis\.listingShotWidthPx;[\s\S]{0,120}delete analysis\.listingShotPageHeightPx;/.test(SCRAPFLY));

check("one fetch cannot eat the whole capture budget",
  /const CAPTURE_FIRST_ATTEMPT_MS = 45_000;/.test(SCRAPFLY) &&
  /attempt\(true, Math\.min\(budgetMs, CAPTURE_FIRST_ATTEMPT_MS\)\)/.test(SCRAPFLY));

{
  // The refit must come BEFORE any viewport shot inside the too-large branch,
  // or we are back to cropping first and asking questions later.
  const branch = SCRAPFLY.slice(SCRAPFLY.indexOf("if (isTooLarge(first)) {"));
  const refitAt = branch.indexOf("captureFitWidth(");
  const fullpageRetryAt = branch.indexOf("attempt(true,");
  const viewportAt = branch.indexOf("attempt(false,");
  check("the too-large branch computes a refit width", refitAt > -1);
  check("the too-large branch re-shoots the FULL PAGE before any viewport shot",
    fullpageRetryAt > -1 && viewportAt > -1 && fullpageRetryAt < viewportAt,
    `fullpage@${fullpageRetryAt} viewport@${viewportAt}`);
}

check("the degraded shot still carries the measured page height",
  /return \{ \.\.\.vp, pageHeightPx \}/.test(SCRAPFLY));

check("a degraded shot is still labelled viewport, never fullpage",
  /kind: \(fullpage \? "fullpage" : "viewport"\)/.test(SCRAPFLY));

check("the analysis records what was captured and how tall the page was",
  /analysis\.listingShotHeightPx = shot\.heightPx/.test(SCRAPFLY) &&
  /analysis\.listingShotPageHeightPx = pagePx/.test(SCRAPFLY));

// ---------------------------------------------------------------------------
// 4. The vision guard was blind to the only format we capture.
// ---------------------------------------------------------------------------
console.log("\nThe long-edge guard now applies to JPEG, which is what we produce");

const jpegB64 = (w, h, withDecoyDht = true) => {
  const seg = (m, payload) => {
    const len = payload.length + 2;
    return [0xFF, m, (len >> 8) & 0xFF, len & 0xFF, ...payload];
  };
  const b = [0xFF, 0xD8,
    ...seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xDB, [0x00, ...new Array(64).fill(0)]),
    // DHT sits INSIDE the 0xC0-0xCF range and is not a frame header. A walker
    // that reads it as SOF returns garbage dimensions.
    ...(withDecoyDht ? seg(0xC4, [0x00, ...new Array(20).fill(0)]) : []),
    ...seg(0xC0, [8, (h >> 8) & 0xFF, h & 0xFF, (w >> 8) & 0xFF, w & 0xFF, 3, ...new Array(9).fill(0)]),
    0xFF, 0xDA, 0x00, 0x08, 0, 0, 0, 0, 0, 0];
  return Buffer.from(Uint8Array.from(b)).toString("base64");
};

check("JPEG dimensions are read out of the SOF frame header",
  JSON.stringify(jpegDimensions(jpegB64(1920, 17729))) === JSON.stringify({ width: 1920, height: 17729 }),
  JSON.stringify(jpegDimensions(jpegB64(1920, 17729))));

check("a DHT segment in the same marker range is skipped, not misread as SOF",
  JSON.stringify(jpegDimensions(jpegB64(1920, 5873))) === JSON.stringify({ width: 1920, height: 5873 }),
  JSON.stringify(jpegDimensions(jpegB64(1920, 5873))));

// This is the exact capture vision-limits.ts's own header names as the one that
// "fails outright" -- and before jpegDimensions existed it sailed straight
// through, because pngDimensions returns null for a JPEG and the verdict then
// answered ok:true on the byte ceiling alone.
{
  const v = visionImageVerdict(jpegB64(1920, 17729), "image/jpeg");
  check("a 17,729px-tall JPEG is now refused on the long-edge limit",
    v.ok === false && /8000px long-edge/.test(v.reason), JSON.stringify(v));
}
{
  const v = visionImageVerdict(jpegB64(1920, 5873), "image/jpeg");
  check("an ordinary tall page is still accepted", v.ok === true && v.height === 5873, JSON.stringify(v));
}
check("the long-edge limit itself did not move", VISION_MAX_EDGE_PX === 8_000);
check("a non-image string still degrades to the byte-only verdict, never a crash",
  visionImageVerdict("A".repeat(4_000), "image/jpeg").ok === true);
check("the verdict reads whichever of the two formats it is handed",
  /const dim = imageDimensions\(b64\)/.test(VISION_SRC));

// ---------------------------------------------------------------------------
// 5. No surface claims "full-page" from something it cannot back.
// ---------------------------------------------------------------------------
console.log("\nNo unbacked full-page claim survives");

check("the report card only says full-page when the kind says fullpage",
  /a\.listingShotKind === "fullpage"[\s\S]{0,700}Full-page capture of the listing/.test(APP));

// A capture re-shot narrower is the whole page of a DIFFERENT rendering --
// responsive layouts move things between 1920 and 1024. The width was recorded
// and read by nobody, which is how "full-page capture" ends up describing a
// photo the buyer never saw at that size.
check("a narrowed capture discloses the width it was photographed at",
  /a\.listingShotWidthPx > 0 && a\.listingShotWidthPx < 1920/.test(APP) &&
  /Photographed \$\{a\.listingShotWidthPx\}px wide so the whole page fit in one image/.test(APP));

check("a short capture states its coverage as a measured percentage",
  /listingShotHeightPx \/ a\.listingShotPageHeightPx/.test(APP));

{
  // /verify is the proof surface, and the kind is neither signed nor carried in
  // a share link, so it must not assert the shape of the capture at all.
  const verify = APP.slice(APP.indexOf("function VerifyPage()"));
  check("the verify page no longer claims a full-page photo",
    !/seals a full-page photo/.test(verify) && /seals a photo of the listing/.test(verify));
}

check("the email body no longer calls the attachment a full-page capture",
  !/The full-page capture rides along/.test(EMAIL) && /The capture rides along/.test(EMAIL));

check("the PDF caption still asserts nothing about the shape",
  /para\("Photo of the listing, captured for report /.test(EMAIL));

check("the print-truncation notice no longer claims the attachment is the whole PAGE",
  !/the attached photo file contains the complete page/.test(EMAIL) &&
  /These pages print the top /.test(EMAIL) && /the attached photo file is the complete capture/.test(EMAIL));

// It states a MEASURED fraction computed by the render loop itself, so it is
// true at any capture width and needs nothing from the unsigned analysis.
check("the truncation notice prints a fraction it computed, not a claim it inherited",
  /Math\.round\(\(off \/ scaledH\) \* 100\)/.test(EMAIL) &&
  // Executable code only: the comment at that site names the field on purpose,
  // to record WHY it must never be read there.
  !EMAIL.split("\n").some((l) => /listingShotKind/.test(l) && !l.trim().startsWith("//")));

check("the vision prompt no longer calls a viewport render a full-page screenshot",
  !/Above is a full-page screenshot/.test(SCRAPFLY) && /it may show only the top of the page/.test(SCRAPFLY));

check("the admin cost card no longer promises a full-page screenshot",
  !/sealed full-page screenshot/.test(APP));

// ---------------------------------------------------------------------------
// 7. The print budget has to grow with the byte cap, and its mirror must not
//    drift. Raising what we CAPTURE while the PDF still truncates at the old
//    page count is half a two-step.
// ---------------------------------------------------------------------------
console.log("\nThe PDF prints as much of the bigger capture as it now carries");

const CAPTURE_TEST = read("supabase/functions/_shared/capture.test.ts");
const num = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
const capMaxP = num(EMAIL, /CAP_HEAD_FIRST = 100, CAP_HEAD_REST = 34, CAP_MAXP = (\d+)/);
const mirrorMaxP = num(CAPTURE_TEST, /const U0 = 629\.89, UR = 695\.89, MAXP = (\d+)/);
const pageW = num(EMAIL, /const PW = 595\.28, PH = 841\.89, M = (\d+)/);

check("capture.test.ts mirrors the PDF's real page budget",
  capMaxP !== null && capMaxP === mirrorMaxP, `pdf=${capMaxP} mirror=${mirrorMaxP}`);

{
  // DERIVED AT THE NARROWEST CAPTURE, NOT THE WIDEST. capScaledH scales by the
  // CAPTURE's own width, so a narrower source image prints TALLER -- and narrow
  // is exactly what the refit ladder produces on the tall pages that need the
  // pages most. A budget derived at 1920 covers 21,855px there and only
  // 11,656px at 1024, which is the same "measured against the wrong baseline"
  // mistake this whole change is about, one constant over.
  const W = 595.28 - (pageW ?? 56) * 2;
  const printablePt = 629.89 + (capMaxP - 1) * 695.89;
  const at = (w) => printablePt / (W / w);
  check("the page budget covers the tallest capture on record AT THE NARROWEST width",
    at(CAPTURE_MIN_WIDTH) >= 17_729,
    `${Math.round(at(CAPTURE_MIN_WIDTH))}px at ${capMaxP} pages / ${CAPTURE_MIN_WIDTH}px wide`);
  check("and therefore covers it at every wider capture too",
    at(CAPTURE_BASE_WIDTH) >= at(CAPTURE_MIN_WIDTH));
}

// ---------------------------------------------------------------------------
// 6. Coverage arithmetic.
// ---------------------------------------------------------------------------
console.log("\nCoverage is arithmetic, and absent when unknown");

check("a whole-page capture is full coverage", captureCoverage(5873, 5873) === 1);
check("a top-of-page shot reports its fraction", captureCoverage(1080, 5400) === 0.2);
check("coverage never exceeds 1 even if the shot is taller than the page",
  captureCoverage(9000, 5873) === 1);
check("unknown dimensions produce null, never a guessed fraction",
  captureCoverage(0, 5873) === null && captureCoverage(1080, 0) === null);

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
