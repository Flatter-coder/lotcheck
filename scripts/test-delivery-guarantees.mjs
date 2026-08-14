// MUTATION TEST for the delivery guarantee gate.
//
// A gate that cannot fail is decoration. This copies the two real source files
// into a temp tree, reintroduces each regression the gate exists to catch, and
// asserts the gate FAILS on every one — then asserts it PASSES on the pristine
// copy. If someone weakens check-delivery-guarantees.mjs, this goes red.
//
// Run (from repo root):  npm run test:delivery
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMAIL_REL = "supabase/functions/email-quote-report/index.ts";
const URL_REL = "supabase/functions/analyze-listing-url/index.ts";
const GATE = "scripts/check-delivery-guarantees.mjs";

// Each case: the regression, and the file+edit that reintroduces it.
const CASES = [
  {
    name: "conditional attachment spread returns",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/^(\s*)attachments,$/m, "$1...(attachments.length ? { attachments } : {}),"),
  },
  {
    name: "PDF failure is swallowed and the email sent anyway",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/pdf_generation_failed/g, "some_other_error"),
  },
  {
    name: "the size floor is declared but no longer compared against",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/bytes\.byteLength\s*<\s*MIN_PDF_BYTES/, "false"),
  },
  {
    name: "the size floor is deleted outright",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/const MIN_PDF_BYTES\s*=\s*\d+;/, "// floor removed"),
  },
  {
    name: "the ledger attempt row is dropped entirely",
    file: EMAIL_REL,
    // No \n anchor — the file is CRLF and `\}\);\n` silently matches nothing.
    mutate: (s) => s.replace(/const deliveryId[\s\S]*?\}\);/, ""),
  },
  {
    name: "the ledger row is written after the send instead of before",
    file: EMAIL_REL,
    // Move the attempt call below the Resend fetch: correlation survives, but a
    // send that dies mid-flight leaves no evidence it was attempted.
    mutate: (s) => {
      const m = s.match(/ {4}const deliveryId[\s\S]*?\}\);/);
      if (!m) return s;
      return s.replace(m[0], "").replace(
        /( {4}if \(!resendRes\.ok\) \{)/,
        `${m[0]}\n\n$1`,
      );
    },
  },
  {
    name: "the Resend message id is discarded again",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/const body = await resendRes\.json\(\);/, "const body = {};"),
  },
  {
    name: "ledgerRpc rethrows instead of swallowing",
    file: EMAIL_REL,
    mutate: (s) => s.replace(
      /console\.warn\(`ledger \$\{fn\} threw \(send continues regardless\):`, e\);\s*\n\s*return null;/,
      "throw e;",
    ),
  },
  {
    name: "the recipient address is passed to the ledger",
    file: EMAIL_REL,
    mutate: (s) => s.replace(/p_recipient_domain: recipientDomain,/, "p_recipient_domain: email,"),
  },
  {
    name: "an empty-report exit stops releasing the credit hold",
    file: URL_REL,
    // Kill only the release that guards the fresh-scrape exit.
    mutate: (s) => s.replace(
      /await logUsage\(\{ success: false, errorMessage: "unreadable_listing \(no price\/MSRP extracted\)" \}\);\s*\n\s*await releaseCredit\(holdId\);/,
      'await logUsage({ success: false, errorMessage: "unreadable_listing (no price/MSRP extracted)" });',
    ),
  },
  {
    name: "the refunded flag is dropped from an empty-report payload",
    file: URL_REL,
    // \s* not \n — the two exits format this differently and the file is CRLF.
    mutate: (s) => s.replace(/refunded:\s*true,\s*/, ""),
  },
  {
    name: "the shared apology is inlined again so copies can drift",
    file: URL_REL,
    mutate: (s) => s.replace(/const UNREADABLE_LISTING_MESSAGE\s*=/, "const UNUSED_MESSAGE ="),
  },
  {
    name: "the apology loses the try-another-dealer route",
    file: URL_REL,
    mutate: (s) => s.replace(/or run the same vehicle at another dealer[^"]*/, "and that's all we can offer."),
  },
];

const root = join(tmpdir(), "lc-delivery-gate-test");
const runGate = (dir) => {
  try {
    execFileSync(process.execPath, [GATE], {
      env: { ...process.env, LC_GATE_ROOT: dir },
      stdio: "pipe",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, out: (e.stdout?.toString() || "") + (e.stderr?.toString() || "") };
  }
};

const fresh = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "supabase/functions/email-quote-report"), { recursive: true });
  mkdirSync(join(dir, "supabase/functions/analyze-listing-url"), { recursive: true });
  cpSync(EMAIL_REL, join(dir, EMAIL_REL));
  cpSync(URL_REL, join(dir, URL_REL));
};

let failed = 0;

// Control: the pristine copy must pass, or every result below is meaningless.
fresh(root);
const control = runGate(root);
if (!control.ok) {
  console.error("✗ CONTROL FAILED — the gate rejects the current, correct source.\n");
  console.error(control.out);
  process.exit(1);
}
console.log("  ✓ control — gate passes on unmodified source");

for (const c of CASES) {
  fresh(root);
  const p = join(root, c.file);
  const before = readFileSync(p, "utf8");
  const after = c.mutate(before);
  if (after === before) {
    console.error(`\n✗ ${c.name}\n    the mutation matched nothing — the source moved and this case no longer tests anything. Fix the case.\n`);
    failed++;
    continue;
  }
  writeFileSync(p, after);
  const res = runGate(root);
  if (res.ok) {
    console.error(`\n✗ ${c.name}\n    the gate PASSED on mutated source — this regression would ship undetected.\n`);
    failed++;
  } else {
    console.log(`  ✓ caught — ${c.name}`);
  }
}

rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(`\n❌ ${failed} of ${CASES.length} regressions were not caught by the gate.\n`);
  process.exit(1);
}
console.log(`\n✅ delivery gate is load-bearing: all ${CASES.length} regressions caught\n`);
