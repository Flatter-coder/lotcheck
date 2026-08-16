// replaceRows against a stubbed PostgREST — the interaction test that was
// missing, and that let a real defect through a green suite.
//
// THE DEFECT. Two protections were merged that were each safe alone and unsafe
// together. `readExisting` filtered out hand-verified rows ("&source_url=is.null"),
// which cost nothing while nothing ever deleted them — the DELETE spared them.
// The supersede step DOES delete them, to stop a stale hand-entered price
// outranking the manufacturer's live one. Filtered read + supersede means the
// row is destroyed without its drivetrain / attrs / price_basis ever being
// read, so the replacement lands blank in exactly the columns carry-forward
// exists to protect. drivetrain was 0/881 populated the last time that went
// unnoticed, and a blank drivetrain re-opens the drivetrain-blind trim match.
//
// Worse: superseded rows sat OUTSIDE the restore set, so a failed insert
// reported "restored all N previous rows" while they were gone permanently — a
// false all-clear, which is the one failure mode that must never ship.
//
// Every pure-function test passed throughout. Only exercising replaceRows
// end-to-end finds this, which is why this file exists.
//
// Run: node scripts/test-supersede-enrichment.mjs

process.env.SUPABASE_URL ||= "https://stub.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-key";

const { replaceRows } = await import("./lib/catalog-io.mjs");

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
};

// A hand-verified row: enriched by the NRCan backfill and by hand from the
// manufacturer's own page. Modelled on the seeded Land Cruiser.
const VERIFIED = {
  id: 900, year: 2027, make: "Toyota", model: "Land Cruiser", trim: "Land Cruiser",
  msrp: 80460, drivetrain: "4WD", price_basis: "excl_freight",
  attrs: { province: "AB" }, source_url: "https://www.toyota.ca/en/build-price/land-cruiser/",
};
const PLAIN = { id: 901, year: 2026, make: "Toyota", model: "Camry", trim: "SE", msrp: 38792, drivetrain: "FWD", source_url: null };

/** Stub PostgREST. `failInsert` makes the main INSERT 400 so the restore runs. */
function stub({ existing, failInsert = false }) {
  const log = { inserted: [], deleted: [], restored: [] };
  let mainInsertDone = false;
  globalThis.fetch = async (u, opts = {}) => {
    const url = String(u), method = opts.method || "GET";
    if (method === "GET") {
      // HONOUR THE QUERY FILTER. PostgREST applies "&source_url=is.null"
      // server-side; a stub that ignores it makes the exact defect under test
      // invisible and the suite passes on broken code. This assertion is the
      // test — everything below only reports what it lets through.
      let visible = existing;
      if (/[?&]source_url=is\.null/.test(url)) visible = existing.filter((r) => r.source_url == null);
      const cols = /select=id,year,model,trim,msrp/.test(url);
      const body = cols ? visible.map(({ id, year, model, trim, msrp }) => ({ id, year, model, trim, msrp })) : visible;
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    }
    if (method === "DELETE") { log.deleted.push(url); return { ok: true, status: 204, text: async () => "" }; }
    if (method === "POST") {
      const rows = JSON.parse(opts.body);
      if (!mainInsertDone) {
        mainInsertDone = true;
        log.inserted.push(...rows);
        if (failInsert) return { ok: false, status: 400, text: async () => "PGRST102 simulated" };
        return { ok: true, status: 201, text: async () => "" };
      }
      log.restored.push(...rows);
      return { ok: true, status: 201, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return log;
}

// ---------------------------------------------------------------------------
// 1. Superseding a hand-verified row must CARRY its enrichment, not blank it.
// ---------------------------------------------------------------------------
{
  const scraped = [{ year: 2027, make: "Toyota", model: "Land Cruiser", trim: "Land Cruiser", msrp: 81990, fuel_type: "Hybrid" }];
  const log = stub({ existing: [VERIFIED, PLAIN] });
  await replaceRows("msrp_catalog", scraped, "Toyota", { fatal: false });

  const row = log.inserted.find((r) => r.model === "Land Cruiser");
  check("the superseded row is replaced with the FRESH manufacturer price",
    row && row.msrp === 81990, JSON.stringify(row));
  check("THE BUG: drivetrain survives being superseded",
    row && row.drivetrain === "4WD",
    `drivetrain=${row?.drivetrain} — a superseded row was replaced with its enrichment blanked`);
  check("price_basis and attrs survive too",
    row && row.price_basis === "excl_freight" && row.attrs?.province === "AB",
    JSON.stringify(row));
  check("the hand-verified provenance is not silently dropped",
    row && typeof row.source_url === "string" && row.source_url.includes("toyota.ca"),
    `source_url=${row?.source_url}`);
  check("the stale row WAS actually deleted (the supersede still happens)",
    log.deleted.some((u) => /id=eq\.900/.test(u)), JSON.stringify(log.deleted));
}

// ---------------------------------------------------------------------------
// 2. A failed insert must restore what was destroyed — including superseded
//    rows — and must never claim success it did not achieve.
// ---------------------------------------------------------------------------
{
  const scraped = [{ year: 2027, make: "Toyota", model: "Land Cruiser", trim: "Land Cruiser", msrp: 81990 }];
  const log = stub({ existing: [VERIFIED, PLAIN], failInsert: true });
  let msg = "";
  try { await replaceRows("msrp_catalog", scraped, "Toyota", { fatal: true }); }
  catch (e) { msg = e.message; }

  check("a failed insert throws rather than reporting success", /INSERT/.test(msg), msg || "(no error thrown)");
  check("THE SECOND BUG: the superseded row is in the restore set",
    log.restored.some((r) => r.model === "Land Cruiser" && r.id === undefined),
    `restored ${log.restored.length} row(s): ${log.restored.map((r) => r.model).join(", ")}`);
  check("the restored row still carries its enrichment",
    log.restored.find((r) => r.model === "Land Cruiser")?.drivetrain === "4WD",
    JSON.stringify(log.restored.find((r) => r.model === "Land Cruiser")));
  check("ordinary deleted rows are restored as well",
    log.restored.some((r) => r.model === "Camry"), JSON.stringify(log.restored.map((r) => r.model)));
  check("the id is never re-sent — the database owns it",
    log.restored.every((r) => !("id" in r)), JSON.stringify(log.restored[0]));
}

// ---------------------------------------------------------------------------
// 3. A hand-verified row that this run does NOT supersede must be left alone —
//    and must NOT be re-posted on restore, which would collide on its own key
//    and fail the batch, under-restoring the rows that did need recovery.
// ---------------------------------------------------------------------------
{
  const scraped = [{ year: 2026, make: "Toyota", model: "Camry", trim: "SE", msrp: 39500 }];
  const log = stub({ existing: [VERIFIED, PLAIN], failInsert: true });
  try { await replaceRows("msrp_catalog", scraped, "Toyota", { fatal: true }); } catch {}

  check("an untouched hand-verified row is NOT deleted",
    !log.deleted.some((u) => /id=eq\.900/.test(u)), JSON.stringify(log.deleted));
  check("...and is NOT re-posted on restore (it never left the table)",
    !log.restored.some((r) => r.model === "Land Cruiser"),
    `restore set: ${log.restored.map((r) => `${r.model}/${r.trim}`).join(", ")}`);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
