-- 2026 Toyota bZ Woodland — official Toyota Canada MSRP.
-- Source: media.toyota.ca (2026 bZ Woodland launch): Base $59,900 / Premium
-- $64,900 CAD, all-wheel-drive BEV.
--
-- Why a single NULL-trim row: the analyze-listing-url catalog lookup only
-- auto-resolves MSRP for a listing WITHOUT a detected trim when there is
-- exactly ONE row for (year, make, model) (lookupCatalogMsrp, "pool.length===1
-- && !trim"). Bot-walled dealer pages (this one is Cloudflare) rarely expose a
-- trim, so the base "starting-at" MSRP is the reliable fallback. Adding the
-- Premium as a 2nd row would break that single-row resolution for no-trim
-- listings, so it is intentionally omitted here (revisit if we start detecting
-- the Premium trim reliably).

DELETE FROM msrp_catalog WHERE year = 2026 AND make = 'Toyota' AND model = 'bZ Woodland';

INSERT INTO msrp_catalog (year, make, model, trim, msrp, fuel_type) VALUES
  (2026, 'Toyota', 'bZ Woodland', NULL, 59900, 'BEV');
