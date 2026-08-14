// DELIVERY GUARANTEE GATE — two promises to the buyer, locked in source.
//
// WHY THIS EXISTS. Both promises were broken or nearly broken by ordinary,
// well-meaning edits, and neither failure is visible in testing:
//
//   1. "An email that says 'your report is attached' always has the report
//      attached." Until 2026-08-14 the PDF build was wrapped in a try/catch
//      that logged and sent the email anyway. A buyer got a LotCheck-branded
//      email promising a report, opened it, and found nothing. They believe
//      they were served, so they don't re-run — and because that path records
//      nothing, we never find out. Vic: "that can never happen."
//
//   2. "Nobody is charged for a report we couldn't build." The unreadable-
//      listing paths release the credit hold before returning. That release is
//      four lines away from the return in a 3,300-line function; a refactor
//      that moves the return without the release silently starts charging for
//      nothing.
//
// Neither is a data invariant (_shared/invariants.ts) or a copy rule
// (check-copy-compliance.mjs) — they are CONTROL-FLOW promises, so they get
// their own gate. Same move as those two: fix the class, then lock it.
//
// This is a source-shape check, not a proof. It cannot run the function. What
// it CAN do is fail loudly the moment the shape that makes the promise true
// stops being there, which is exactly how both regressions would arrive.
//
// Run (from repo root):  npm run check:delivery
// Exit 0 = clean; 1 = a violation.
import { readFileSync } from "node:fs";

// LC_GATE_ROOT lets the gate be pointed at a mutated copy of the tree so the
// gate itself can be tested (scripts/test-delivery-guarantees.mjs). Unset in
// normal use, so `npm run check:delivery` reads the real source.
const ROOT = process.env.LC_GATE_ROOT ? process.env.LC_GATE_ROOT.replace(/[/\\]+$/, "") + "/" : "";
const EMAIL_FN = ROOT + "supabase/functions/email-quote-report/index.ts";
const URL_FN = ROOT + "supabase/functions/analyze-listing-url/index.ts";

const read = (p) => readFileSync(p, "utf8");
const lines = (s) => s.split(/\r?\n/);

const failures = [];
const passes = [];
const fail = (rule, why, detail) => failures.push({ rule, why, detail });
const pass = (rule, detail) => passes.push({ rule, detail });

// ── 1. The report email always carries the report ────────────────────────────
{
  const rule = "no-pdf-less-report-email";
  const why =
    "An email promising a report must never ship without the PDF. The buyer " +
    "believes they were served and never re-runs.";
  const src = read(EMAIL_FN);

  // (a) The conditional spread is how the hole shipped. It made the attachment
  //     optional at the exact moment it mattered.
  if (/\.\.\.\(\s*attachments\.length\s*\?/.test(src)) {
    fail(rule, why, `${EMAIL_FN}: attachments are spread conditionally (\`...(attachments.length ? …)\`). The send must always carry the PDF; the guard belongs earlier, not at the payload.`);
  }

  // (b) The old swallow-and-send comment, verbatim, in case someone reverts.
  if (/never fatal: if generation fails, send the email anyway/i.test(src)) {
    fail(rule, why, `${EMAIL_FN}: the "send the email anyway" PDF fallback is back.`);
  }

  // (c) The fail-closed exit must exist AND must come before the send. Ordering
  //     is the whole point: a guard after the fetch guards nothing.
  const guardAt = src.indexOf("pdf_generation_failed");
  const sendAt = src.indexOf("api.resend.com/emails");
  if (guardAt === -1) {
    fail(rule, why, `${EMAIL_FN}: no \`pdf_generation_failed\` early return — nothing stops a send when the PDF can't be built.`);
  } else if (sendAt === -1) {
    fail(rule, why, `${EMAIL_FN}: the Resend send call moved or was renamed; this gate can no longer prove the PDF guard precedes it. Update the gate deliberately.`);
  } else if (guardAt > sendAt) {
    fail(rule, why, `${EMAIL_FN}: the \`pdf_generation_failed\` guard sits AFTER the Resend call. A guard downstream of the send cannot prevent the send.`);
  }

  // (d) A build that "succeeds" with a few hundred bytes is a broken build, not
  //     a report. The floor must be DECLARED and actually COMPARED against —
  //     checking the identifier merely appears somewhere passes on a commented
  //     -out mention, which is how a mutation test caught this rule being weak.
  const declaresFloor = /const\s+MIN_PDF_BYTES\s*=\s*\d+/.test(src);
  const comparesFloor = /byteLength\s*<\s*MIN_PDF_BYTES/.test(src);
  if (!declaresFloor) {
    fail(rule, why, `${EMAIL_FN}: MIN_PDF_BYTES is no longer declared — a truncated or empty PDF would count as a successful build.`);
  } else if (!comparesFloor) {
    fail(rule, why, `${EMAIL_FN}: MIN_PDF_BYTES is declared but never compared against \`byteLength\`. The floor only works if the built bytes are actually measured.`);
  }

  if (!failures.some((f) => f.rule === rule)) {
    pass(rule, "PDF is fatal, size-checked, and guarded before the send");
  }
}

// ── 1b. The send is recorded, and the record can't block the send ────────────
{
  const rule = "delivery-ledger-records-the-send";
  const why =
    "A send with no record is unprovable. Equally, a ledger that can fail the " +
    "send turns evidence-keeping into an outage — it must be fail-open.";
  const src = read(EMAIL_FN);

  const attemptAt = src.indexOf("fn_record_delivery_attempt");
  const sendAt = src.indexOf("api.resend.com/emails");

  if (attemptAt === -1) {
    fail(rule, why, `${EMAIL_FN}: no \`fn_record_delivery_attempt\` call — sends are unrecorded again, and a dispute has nothing to check.`);
  } else if (sendAt !== -1 && attemptAt > sendAt) {
    fail(rule, why, `${EMAIL_FN}: the ledger row is written AFTER the Resend call. A send that times out mid-flight then leaves no evidence it was ever attempted — record first, seal the answer second.`);
  }
  if (!/fn_record_delivery_result/.test(src)) {
    fail(rule, why, `${EMAIL_FN}: no \`fn_record_delivery_result\` call — the provider's answer is never sealed onto the attempt row.`);
  }

  // The Resend message id is the only token linking our row to theirs. It was
  // discarded on the floor before 2026-08-14; if the success body stops being
  // parsed, correlation silently dies and every webhook lands uncorrelated.
  if (!/resendRes\.json\(\)/.test(src) || !/providerMsgId/.test(src)) {
    fail(rule, why, `${EMAIL_FN}: the Resend success body is no longer parsed for its message id. Without it no delivered/bounced webhook can ever be tied back to a send.`);
  }

  // Fail-open: the ledger helper must swallow everything.
  const helper = src.slice(src.indexOf("async function ledgerRpc"), src.indexOf("async function ledgerRpc") + 1400);
  if (!/async function ledgerRpc/.test(src)) {
    fail(rule, why, `${EMAIL_FN}: the ledgerRpc helper is gone; ledger calls are no longer guaranteed fail-open.`);
  } else if (!/catch\s*\([\s\S]{0,40}\)\s*\{[\s\S]{0,200}return null/.test(helper)) {
    fail(rule, why, `${EMAIL_FN}: ledgerRpc no longer swallows its errors into a null return. A database problem would now surface as a failed send — the ledger must never gate the buyer's report.`);
  } else if (/\bthrow\b/.test(helper)) {
    fail(rule, why, `${EMAIL_FN}: ledgerRpc contains a \`throw\`. It must never propagate — a ledger outage cannot become a send outage.`);
  }

  // The address must never reach the ledger. Only the domain does.
  const call = src.slice(attemptAt >= 0 ? attemptAt : 0, (attemptAt >= 0 ? attemptAt : 0) + 700);
  if (attemptAt >= 0) {
    if (/p_recipient_domain:\s*email\b/.test(call) || /\bp_recipient(_email|_address)?\s*:/.test(call)) {
      fail(rule, why, `${EMAIL_FN}: the recipient address (or a field named for it) is being passed to the ledger. Only \`recipient_domain\` may be stored — the shipped copy promises the address is "not saved on our end".`);
    }
    if (!/recipientDomain/.test(call)) {
      fail(rule, why, `${EMAIL_FN}: the ledger attempt no longer passes a derived \`recipientDomain\`; check what is being stored in its place.`);
    }
  }

  if (!failures.some((f) => f.rule === rule)) {
    pass(rule, "attempt recorded before the send, provider id captured, writes fail-open, address never stored");
  }
}

// ── 2. No charge for a report we couldn't build ──────────────────────────────
{
  const rule = "no-charge-for-empty-report";
  const why =
    "An unreadable listing produces no report, so the credit hold must be " +
    "released before the response leaves. The buyer is told the refund is done.";
  const src = read(URL_FN);
  const L = lines(src);

  // Every place that returns the unreadable-listing error.
  const sites = [];
  L.forEach((l, i) => {
    if (/error:\s*"unreadable_listing"|error:\s*'unreadable_listing'/.test(l)) sites.push(i);
  });

  if (sites.length === 0) {
    fail(rule, why, `${URL_FN}: no \`unreadable_listing\` return found at all. Either the empty-report path was removed (buyers now receive empty reports) or it was renamed (update this gate deliberately).`);
  }

  const LOOKBACK = 14;
  const LOOKAHEAD = 8;
  for (const i of sites) {
    const before = L.slice(Math.max(0, i - LOOKBACK), i).join("\n");
    const around = L.slice(Math.max(0, i - 2), i + LOOKAHEAD).join("\n");

    if (!/releaseCredit\(\s*holdId\s*\)/.test(before)) {
      fail(rule, why, `${URL_FN}:${i + 1}: an \`unreadable_listing\` response with no \`releaseCredit(holdId)\` in the ${LOOKBACK} lines above it — this path charges for a report it never produced.`);
    }
    if (!/refunded:\s*true/.test(around)) {
      fail(rule, why, `${URL_FN}:${i + 1}: this \`unreadable_listing\` payload is missing \`refunded: true\`. The client and the admin ledger both read that flag to show the refund actually happened.`);
    }
  }

  if (!failures.some((f) => f.rule === rule)) {
    pass(rule, `${sites.length} unreadable-listing exits, each releasing the hold and declaring the refund`);
  }
}

// ── 3. One apology, not several that drift apart ─────────────────────────────
{
  const rule = "single-empty-report-message";
  const why =
    "Two copies of this message drifted before. A buyer must not get a " +
    "different apology depending on whether the miss came from cache.";
  const src = read(URL_FN);

  if (!/const\s+UNREADABLE_LISTING_MESSAGE\s*=/.test(src)) {
    fail(rule, why, `${URL_FN}: UNREADABLE_LISTING_MESSAGE is gone — the empty-report copy is no longer defined in one place.`);
  } else {
    const uses = (src.match(/UNREADABLE_LISTING_MESSAGE/g) || []).length - 1; // minus the definition
    if (uses < 2) {
      fail(rule, why, `${URL_FN}: UNREADABLE_LISTING_MESSAGE is referenced ${uses} time(s); both the cached and the fresh-scrape exits must use it.`);
    }
    // The three elements Vic asked for, checked individually so a rewrite that
    // drops one is caught rather than a brittle exact-string match.
    const def = src.slice(src.indexOf("const UNREADABLE_LISTING_MESSAGE"), src.indexOf("const supabase"));
    const need = [
      [/sorry/i, "an apology — the failure is ours, not theirs"],
      [/refund/i, "the refund, stated as already done"],
      [/another dealer/i, "the try-another-dealer route out"],
      [/upload/i, "the upload-the-paperwork route out"],
    ];
    for (const [re, what] of need) {
      if (!re.test(def)) fail(rule, why, `${URL_FN}: the empty-report message no longer contains ${what}.`);
    }
    if (!failures.some((f) => f.rule === rule)) {
      pass(rule, `defined once, used ${uses}×, carries apology + refund + both routes out`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const byRule = new Map();
for (const f of failures) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, f);
}

if (failures.length === 0) {
  console.log("\n── delivery guarantees ──");
  for (const p of passes) console.log(`  ✓ ${p.rule} — ${p.detail}`);
  console.log(`\n✅ delivery guarantees: ${passes.length} of ${passes.length} rules clean\n`);
  process.exit(0);
}

console.error("\n❌ DELIVERY GUARANTEE GATE FAILED\n");
for (const [rule, first] of byRule) {
  console.error(`  ✗ ${rule}`);
  console.error(`    why: ${first.why}`);
  for (const f of failures.filter((x) => x.rule === rule)) {
    console.error(`    → ${f.detail}`);
  }
  console.error("");
}
console.error(`${failures.length} violation(s). These are promises to the buyer — fix the code, don't relax the gate.\n`);
process.exit(1);
