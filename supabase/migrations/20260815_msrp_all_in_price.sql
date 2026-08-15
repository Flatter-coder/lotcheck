-- ============================================================================
-- msrp_catalog.all_in_price — the manufacturer's OWN all-in figure.
--
-- THE PROBLEM THIS CLOSES. Alberta, Ontario, BC and Quebec require a dealer's
-- ADVERTISED price to be all-in. A published MSRP is not: it excludes freight,
-- PDI, A/C charge and the rest. Comparing one against the other invents a
-- markup that does not exist — and it is the single largest cause of a wrong
-- over/under claim, which under our own rules is a public accusation against a
-- named dealer.
--
-- We had been solving this by subtracting an ESTIMATE ("typically $2,000–$2,600
-- freight & PDI"). We do not have to estimate. Toyota publishes both numbers.
--
-- PROVEN 2026-08-15 against Toyota Canada's own Build & Price, three trims,
-- exact to the dollar:
--
--   trim       MSRP      + mandatory adds   = B&P "From"    screenshot
--   SE         $48,750   + $3,078           = $51,828       $51,828  ✓
--   XSE        $56,400   + $3,078           = $59,478       $59,478  ✓
--   GR SPORT   $57,500   + $3,078           = $60,578       $60,578  ✓
--
-- The $3,078 is itemised by Toyota, not inferred:
--   Delivery & Destination  $1,930
--   Dealer Fees (maximum)     $999   <- Toyota's own published ceiling
--   Air Conditioning Charge   $100
--   Tire Levy                  $25
--   PPSA Fee (finance)         $14
--   AMVIC                      $10
--
-- So the "From" price on a manufacturer trim card is the ALL-IN price, and it
-- is the correct thing to compare against an all-in advertised listing. The
-- MSRP is the correct thing to compare against an ex-freight quote. Holding
-- both, per row, is what makes the comparison basis-correct instead of
-- basis-hopeful.
--
-- NOTE: the adds are not universal. Delivery & Destination varies by model, and
-- the dealer-fee ceiling may vary by make and province. all_in_price is
-- therefore stored PER ROW, captured from the manufacturer — never computed by
-- adding a constant.
-- ============================================================================

alter table public.msrp_catalog
  add column if not exists all_in_price numeric;

comment on column public.msrp_catalog.all_in_price is
  'The manufacturer''s own all-in figure for this exact trim: MSRP plus every '
  'mandatory add they itemise (freight/PDI, A/C, levies, regulator fees, and '
  'their published maximum dealer fee). Compare THIS against an all-in '
  'advertised price; compare msrp against an ex-freight quote. Null means we '
  'hold only the MSRP, in which case no all-in comparison may be made. Never '
  'derive it by adding a constant — the adds vary by model and province.';

-- NOTE: populating all_in_price for the RAV4 rows lives at the END of
-- 20260815_seed_rav4_phev_msrp.sql, NOT here. It has to run AFTER the rows
-- exist. Running it here matched zero rows on a fresh database and left every
-- all_in_price null while reporting success (hit for real 2026-08-15).
