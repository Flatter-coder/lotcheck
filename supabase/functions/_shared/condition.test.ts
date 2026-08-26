// Regression suite for sale-condition granularity (condition.ts).
// Run: node --experimental-strip-types supabase/functions/_shared/condition.test.ts

import { deriveSaleCondition } from "./condition.ts";

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        want ${JSON.stringify(want)}  got ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};

// Explicit 4-way value wins.
check("explicit certified wins", deriveSaleCondition({ saleCondition: "certified", vehicleCondition: "new" }), "certified");
check("explicit demo wins", deriveSaleCondition({ saleCondition: "demo" }), "demo");
check("invalid explicit is ignored", deriveSaleCondition({ saleCondition: "florp", vehicleCondition: "used" }), "used");

// Structured flags (d2c).
check("isCertified on a used car -> certified", deriveSaleCondition({ vehicleCondition: "used", isCertified: true }), "certified");
check("isDemo on a used car -> demo", deriveSaleCondition({ vehicleCondition: "used", isDemo: true }), "demo");
check("demo signal downgrades a 'new' listing -> demo", deriveSaleCondition({ vehicleCondition: "new", isDemo: true }), "demo");
check("a plain new car stays new", deriveSaleCondition({ vehicleCondition: "new" }), "new");
check("certified signal does NOT upgrade a new car", deriveSaleCondition({ vehicleCondition: "new", isCertified: true }), "new");

// Free-text sale_class (convertus).
check("sale_class 'Certified Pre-Owned' -> certified", deriveSaleCondition({ vehicleCondition: "used", saleClass: "Certified Pre-Owned" }), "certified");
check("sale_class 'Demonstrator' -> demo", deriveSaleCondition({ vehicleCondition: "used", saleClass: "Demonstrator" }), "demo");
check("'non-certified' is NOT read as certified", deriveSaleCondition({ vehicleCondition: "used", saleClass: "non-certified used" }), "used");

// Plain used, and the truly-unknown case.
check("plain used -> used", deriveSaleCondition({ vehicleCondition: "used" }), "used");
check("no condition, no signal -> null (never guess)", deriveSaleCondition({}), null);
check("no condition but a certified signal -> certified", deriveSaleCondition({ isCertified: true }), "certified");

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
