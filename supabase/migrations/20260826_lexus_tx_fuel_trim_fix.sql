-- ============================================================================
-- Correct the 2026 Lexus TX in the live catalog.
--
-- The TCI scraper tags fuel at the SERIES level, so the multi-powertrain TX line
-- (TX 350 gas + TX 500h hybrid) stored every gas TX 350 trim as "Hybrid", and
-- named the base by Lexus's internal grade "Premium" instead of the Canadian
-- "Luxury" trim. A 2026 TX 350 Luxury listing then matched no row and resolved
-- to $81,484 (the F SPORT 3 row) — the dealer inflated nothing; we did.
--
-- This fixes the served rows NOW. scripts/lib/tci-overrides.mjs keeps the
-- ex-freight MSRP, fuel and trim correct on every daily refresh (replaceRows
-- would otherwise wipe a data-only fix). all_in_price is not carried across a
-- refresh yet, so after the next scrape the report falls back to the ex-freight
-- floor for the TX — conservative and correct, never the wrong $81,484.
--
-- msrp is EX-FREIGHT (price_basis); all_in_price is Lexus Canada Build & Price's
-- all-in "From" (Alberta) = msrp + the $3,351.18 AB fee stack, which closes the
-- TX 350 Luxury arithmetic to the cent (69,855 + 3,351.18 = 73,206.18).
-- ============================================================================
delete from public.msrp_catalog where make = 'Lexus' and model = 'TX' and year = 2026;

insert into public.msrp_catalog (year, make, model, trim, msrp, fuel_type, drivetrain, price_basis, all_in_price) values
  -- TX 350 — gasoline
  (2026, 'Lexus', 'TX', 'Luxury',                   69855, 'Gas', 'AWD', 'excl_freight', 73206.18),
  (2026, 'Lexus', 'TX', 'Ultra Luxury',             72608, 'Gas', 'AWD', 'excl_freight', 75959.18),
  (2026, 'Lexus', 'TX', 'Executive 7-Pass',         80861, 'Gas', 'AWD', 'excl_freight', 84212.18),
  (2026, 'Lexus', 'TX', 'F SPORT 3',                81484, 'Gas', 'AWD', 'excl_freight', 84835.18),
  (2026, 'Lexus', 'TX', 'Executive 6-Pass',         81611, 'Gas', 'AWD', 'excl_freight', 84962.18),
  (2026, 'Lexus', 'TX', 'F SPORT 3 + Towing Hitch', 82631, 'Gas', 'AWD', 'excl_freight', 85982.18),
  -- TX 500h — hybrid
  (2026, 'Lexus', 'TX', 'F SPORT Performance 2',                85400, 'Hybrid', 'AWD', 'excl_freight', 88751.18),
  (2026, 'Lexus', 'TX', 'F SPORT Performance 2 + Towing Hitch', 86546, 'Hybrid', 'AWD', 'excl_freight', 89897.18),
  (2026, 'Lexus', 'TX', 'F SPORT Performance 3',                91399, 'Hybrid', 'AWD', 'excl_freight', 94750.18),
  (2026, 'Lexus', 'TX', 'F SPORT Performance 3 + Towing Hitch', 92546, 'Hybrid', 'AWD', 'excl_freight', 95897.18);
