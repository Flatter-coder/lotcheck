-- ============================================================================
-- 2026 RAV4 Plug-in Hybrid — charging capability, and the $14 basis fix.
--
-- PART 1: THE PRICES ARE CONFIRMED. Toyota's plug-in comparison tool publishes
-- the same four figures already seeded, so unlike the hybrid Limited there is
-- no paint baked into any plug-in row:
--     SE $51,828 · XSE $59,478 · GR SPORT $60,578 · XSE Tech $62,428
--
-- PART 2: THE $14. Both comparison tools quote the FINANCE basis, which carries
-- a $14 PPSA registration fee. The hybrid rows were seeded on the CASH basis
-- (MSRP + $3,861.40) while the plug-in rows took the comparison figure directly
-- (MSRP + $3,078, PPSA included). Same catalog, two bases, $14 apart.
--
-- Cash is the honest default for comparing against an ADVERTISED price: PPSA is
-- a lending registration, charged only if the buyer finances, so it does not
-- belong in a figure we hold up against a dealer's posted number. Plug-in rows
-- are restated on the cash basis (MSRP + $3,064) — $14 lower each.
--
-- PART 3: CHARGING CAPABILITY, which is a real buyer question on a plug-in and
-- is NOT uniform across the line. From Toyota's own comparison
-- (● standard, ⓘ available in a package, — not available):
--
--                        SE    XSE   XSE Tech   GR SPORT
--   J1772 inlet          ●     ●     —          ●
--   DC Fast Charging     —     ⓘ     ●          —
--   CCS1 inlet           —     ⓘ     ●          —
--
-- So DC fast charging and CCS1 are STANDARD only on the XSE Technology Package,
-- and reachable on the XSE by adding that package. The SE and the GR SPORT are
-- Level 2 / J1772 only. Toyota's own pricing release agrees: the 11kW on-board
-- charger, DC Fast Charging and the CCS1 connector are listed as Technology
-- Package content.
--
-- Worth recording because it is exactly the kind of specific, checkable claim a
-- report can get wrong: telling a GR SPORT buyer they have DC fast charging
-- would be a dealer's easiest possible rebuttal. The XSE Tech also drops the
-- plain J1772 listing, CCS1 having superseded it.
-- ============================================================================

-- Cash basis, consistent with every other row in the catalog.
update public.msrp_catalog set
  all_in_price = msrp + 3064,
  attrs = coalesce(attrs,'{}'::jsonb) || jsonb_build_object(
    'all_in_basis','cash',
    'all_in_note','PPSA excluded — a lending registration fee, charged only when financed'),
  fetched_at = now()
where make ilike 'Toyota' and year = 2026 and model = 'RAV4 Plug-in Hybrid';

-- Charging capability per trim.
--
-- TWO FIELDS, NOT ONE, and the distinction protects the buyer from Toyota's own
-- table. `j1772_inlet` is what the comparison chart lists. `ac_level2_capable`
-- is what the car can actually DO — and it is true on every trim, including the
-- one the chart marks "—".
--
-- CCS1 is physically a J1772 inlet with two DC pins added below: the top five
-- positions are a standard J1772 layout, so any J1772 EVSE charges a CCS1 car
-- using only those pins. Compatibility runs ONE WAY — a CCS1 car takes a J1772
-- plug, a J1772-only car cannot take a CCS1 plug.
--
-- So the chart's "J1772 — not available" on the XSE Technology Package means
-- the inlet fitted is CCS1 rather than plain J1772. Read literally it implies
-- the buyer cannot use Level 2 public charging, which is FALSE. Reporting that
-- would be a wrong claim in the buyer's disfavour — and this one is worth
-- getting right in the other direction too: it makes the pricier trim look
-- better, which is exactly the kind of finding that earns trust.
update public.msrp_catalog m set
  attrs = coalesce(m.attrs,'{}'::jsonb) || jsonb_build_object('charging', c.spec)
from (values
  ('SE',                     jsonb_build_object('j1772_inlet',true, 'ac_level2_capable',true,'dc_fast','no',        'ccs1','no',
     'summary','Level 2 (J1772) only — no DC fast charging on this trim')),
  ('XSE',                    jsonb_build_object('j1772_inlet',true, 'ac_level2_capable',true,'dc_fast','in_package','ccs1','in_package',
     'summary','Level 2 (J1772) standard. DC fast charging and CCS1 only by adding the Technology Package')),
  ('XSE Technology Package', jsonb_build_object('j1772_inlet',false,'ac_level2_capable',true,'dc_fast','standard',  'ccs1','standard',
     'summary','DC fast charging (CCS1) and an 11kW on-board charger, standard. Toyota lists J1772 as "not available" because the inlet fitted is CCS1 — but CCS1 is a J1772 inlet with two DC pins added, so Level 2 J1772 charging still works')),
  ('GR SPORT',               jsonb_build_object('j1772_inlet',true, 'ac_level2_capable',true,'dc_fast','no',        'ccs1','no',
     'summary','Level 2 (J1772) only — no DC fast charging on this trim'))
) as c(trim_name, spec)
where m.make ilike 'Toyota' and m.year = 2026
  and m.model = 'RAV4 Plug-in Hybrid'
  and m."trim" = c.trim_name;

select "trim", msrp, all_in_price, all_in_price - msrp as adds,
       attrs->'charging'->>'summary' as charging
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model = 'RAV4 Plug-in Hybrid'
order by msrp;
