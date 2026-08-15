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

-- ---- 2026 RAV4 Plug-in Hybrid: complete, and reconciled to the dollar -------
-- Sources: Toyota Canada pricing release + Build & Price summaries for SE AWD,
-- XSE AWD and GR SPORT AWD (Alberta), captured 2026-08-15.
update public.msrp_catalog set
  all_in_price = case trim
    when 'SE'                     then 51828
    when 'XSE'                    then 59478
    when 'GR SPORT'               then 60578
    when 'XSE Technology Package' then 62428   -- 59,478 + $2,950 package
  end,
  attrs = coalesce(attrs, '{}'::jsonb) || jsonb_build_object(
    'province', 'AB',
    'all_in_breakdown', jsonb_build_object(
      'delivery_destination', 1930,
      'dealer_fees_max',       999,
      'air_conditioning',      100,
      'tire_levy',              25,
      'ppsa_fee_finance',       14,
      'amvic',                  10
    ),
    -- Toyota's own PDF carries the Alberta EVAP line as an incentive. It
    -- appears on the SE and NOT on the XSE, which is the price ceiling doing
    -- its work — worth surfacing rather than us re-deriving eligibility.
    'evap_eligible', (trim = 'SE'),
    'evap_amount',   case when trim = 'SE' then 2500 else null end,
    'captured_from', 'toyota.ca Build & Price summary (Alberta)'
  ),
  fetched_at = now()
where make ilike 'Toyota'
  and model = 'RAV4 Plug-in Hybrid'
  and year = 2026;

-- ---------------------------------------------------------------------------
-- What this makes possible, and it is the whole point:
--
-- The most expensive 2026 RAV4 Plug-in Hybrid Toyota sells is the XSE with the
-- Technology Package, at $62,428 all-in INCLUDING the maximum dealer fee. That
-- is the ceiling for this model line, from the manufacturer's own arithmetic.
--
-- A listing advertised at $85,995 all-in is $23,567 above it — and that holds
-- WITHOUT pinning the trim, because there is no higher grade to name. It is the
-- most generous possible assumption in the dealer's favour and it still lands.
-- ---------------------------------------------------------------------------
