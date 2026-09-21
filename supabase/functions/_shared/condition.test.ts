// Regression suite for sale-condition granularity (condition.ts).
// Run: node --experimental-strip-types supabase/functions/_shared/condition.test.ts

import { deriveSaleCondition, DELIVERY_KM } from "./condition.ts";

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


// ---- the odometer is itself a demo signal --------------------------------
// The 2026 Defender at Land Rover Royal Oak: advertised "New", 6,675 km, no
// demo flag, no sale_class, no hint. Before this it returned "new" — which is
// what drives the new-only dealer-fee ceiling and an unstarted warranty clock.
check("a 'new' car above delivery kilometres is a demo",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: 6675 }), "demo");
check("delivery kilometres stay new",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: 47 }), "new");
check("zero kilometres stay new",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: 0 }), "new");
check("exactly at the threshold is still new",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: DELIVERY_KM }), "new");
check("one kilometre past the threshold is a demo",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: DELIVERY_KM + 1 }), "demo");

// UNKNOWN IS NOT ZERO. Number(null) === 0 would certify every car with no
// reading as new — the exact shape that produced 21 of 22 defects on 09-03.
check("a missing odometer leaves the badge alone",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: null }), "new");
check("an undefined odometer leaves the badge alone",
  deriveSaleCondition({ vehicleCondition: "new" }), "new");
check("an unparseable odometer leaves the badge alone",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: Number("abc") }), "new");

// A negative reading is corrupt, not proof of freshness.
check("a negative odometer does not certify the car as new",
  deriveSaleCondition({ vehicleCondition: "new", odometerKm: -5 }), "new");

// An explicit 4-way value still outranks everything, including kilometres.
check("an explicit 'certified' still wins over the odometer",
  deriveSaleCondition({ vehicleCondition: "new", saleCondition: "certified", odometerKm: 6675 }), "certified");

// Kilometres alone cannot separate a demo from a used car.
check("kilometres with no condition at all stay unknown",
  deriveSaleCondition({ odometerKm: 6675 }), null);
check("a used car with high kilometres is still used, not a demo",
  deriveSaleCondition({ vehicleCondition: "used", odometerKm: 6675 }), "used");

// ONE AUTHOR. msrp-basis.ts kept its own copy of this number while condition.ts
// had none; the two are now the same constant by construction.
check("the threshold is the measured delivery figure", DELIVERY_KM, 1000);

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
