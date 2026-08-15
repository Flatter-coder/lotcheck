-- ============================================================================
-- 2026 RAV4 Hybrid — correction, two missing trims, and drivetrain.
--
-- Toyota's own trim-comparison tool publishes the all-in price for every
-- configuration side by side. Reversing those figures (shown price − $14 PPSA
-- − $3,861.40 adds) exposed one seeded row that was WRONG and supplied the two
-- that had been withheld.
--
--   config                shown       implied MSRP    was seeded
--   LE                    $41,375.40   $37,500        $37,500  ok
--   XLE - XLE Premium     $47,674.40   $43,799        (withheld)
--   XSE - XSE Tech Pkg    $56,325.40   $52,450        (withheld)
--   Limited               $55,875.40   $52,000        $52,350  WRONG by $350
--   Woodland              $50,875.40   $47,000        $47,000  ok
--   XSE                   $54,775.40   $50,900        $50,900  ok
--
-- THE LIMITED WAS THE XSE TRAP AGAIN. Its Build & Price summary read $52,350
-- because that build carried "Ruby Flare Pearl". Third time on one nameplate
-- (XSE, XLE Premium, Limited) — a captured build is a CAR, and a catalog row
-- must hold the TRIM.
--
-- AND IT RESOLVES THE PAINT PUZZLE. There are two premium-paint prices, not
-- one, which is why $905 and $350 both looked "confirmed" at different moments:
--
--     single-tone pearl (Ruby Flare, Wind Chill)      +$350
--     two-tone pearl WITH BLACK ROOF                  +$905
--
-- Every build now reconciles:
--   XSE          $50,900 + $905 (Wind Chill Pearl w/Black Roof) = $51,805
--   Limited      $52,000 + $350 (Ruby Flare Pearl)              = $52,350
--   XLE Premium  $2,499 package + $350 (Wind Chill Pearl)       = $2,849
--   GR SPORT     $57,500 + $905 (Supersonic Red w/Black Roof)   = $58,405  (PHEV)
--
-- DRIVETRAIN IS NOW KNOWN. "All Wheel Drive (AWD)" shows as Standard on all six
-- configurations in the comparison tool. Every RAV4 hybrid row was carrying
-- drivetrain = null, which capped the matcher at `starting_at` and made it
-- REFUSE every over/under claim. With AWD recorded it can grant `exact`.
--
-- Cash basis throughout (MSRP + $3,861.40), consistent with the other rows. The
-- comparison tool's figures are the FINANCE basis and carry $14 more.
-- ============================================================================

-- 1. The correction, and the two trims that were withheld.
insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at)
select m.year, m.make, v.model, v.trim, v.msrp, v.all_in, 'Hybrid', 'AWD', 'excl_freight',
       'https://www.toyota.ca/en/build-price/rav4/', now()
from (values (2026,'Toyota')) as m(year, make)
cross join (values
  ('RAV4',        'Limited',                52000, 55861.40),
  ('RAV4',        'XLE Premium',            43799, 47660.40),
  ('RAV4',        'XSE Technology Package', 52450, 56311.40),
  ('RAV4 Hybrid', 'Limited',                52000, 55861.40),
  ('RAV4 Hybrid', 'XLE Premium',            43799, 47660.40),
  ('RAV4 Hybrid', 'XSE Technology Package', 52450, 56311.40)
) as v(model, trim, msrp, all_in)
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      drivetrain   = excluded.drivetrain,
      fetched_at   = now();

-- 2. AWD is standard across the whole hybrid line. Until now every row was
--    null here, which meant the matcher could never grant an `exact` basis and
--    therefore never made an over/under claim at all.
update public.msrp_catalog
   set drivetrain = 'AWD', fetched_at = now()
 where make ilike 'Toyota' and year = 2026
   and model in ('RAV4','RAV4 Hybrid')
   and drivetrain is null;

-- 3. Record both premium-paint prices so a build can be reconciled to a trim.
update public.msrp_catalog
   set attrs = coalesce(attrs,'{}'::jsonb) || jsonb_build_object(
         'premium_paint_single_tone', 350,
         'premium_paint_two_tone_black_roof', 905,
         'drivetrain_source', 'toyota.ca trim comparison — All Wheel Drive (AWD) Standard on all trims')
 where make ilike 'Toyota' and year = 2026 and model in ('RAV4','RAV4 Hybrid');

select model, "trim", msrp, all_in_price, all_in_price - msrp as adds, drivetrain
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model = 'RAV4'
order by msrp;
