-- ============================================================================
-- 2026 RAV4 Hybrid — seed the same prices under BOTH names Toyota uses.
--
-- CAUGHT BY THE POWERTRAIN GUARD, against my own data. The hybrid rows were
-- seeded as model = 'RAV4'. `powertrainCompatible` correctly refuses to let a
-- listing that says "RAV4 Hybrid XLE" or "RAV4 HEV XLE" match a catalog row
-- called plain 'RAV4' — a catalog name may not DROP a powertrain marker the
-- listing carries. So the guard did its job and my seed was the thing at fault.
--
-- Dealers write all four forms: "RAV4", "RAV4 Hybrid", "RAV4 HEV", and for the
-- plug-in "RAV4 Plug-in Hybrid", "RAV4 PHEV", "RAV4 Prime". And Toyota itself
-- is inconsistent — its own Build & Price summaries head some pages "2026 RAV4"
-- and others "2026 RAV4 Hybrid", for the same vehicles.
--
-- WHY DUPLICATING IS HONEST HERE, not a hack. The 2026 RAV4 is HYBRID-ONLY in
-- Canada: there is no gasoline RAV4 to collide with, so 'RAV4' and
-- 'RAV4 Hybrid' name the same car at the same price. Storing both is recording
-- two published names for one vehicle, not inventing a second price.
--
-- WHAT IT MUST NOT DO is let a plug-in reach these rows. It cannot: 'RAV4
-- Hybrid' carries the `hybrid` marker and a PHEV listing carries `phev`, so the
-- guard refuses both directions. Pinned by test:model-identity —
--   'RAV4 PHEV XSE' -> 'RAV4 Hybrid'  = false   ($5,500 apart: 56,400 vs 50,900)
--   'RAV4 HEV XLE'  -> 'RAV4 Plug-in Hybrid' = false
--
-- IF A GASOLINE RAV4 RETURNS in a later model year, delete the plain 'RAV4'
-- rows for 2026 rather than adding gas rows beside them — otherwise a bare
-- "RAV4" listing could match a hybrid price.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
select
  m.year, m.make, 'RAV4 Hybrid', m.trim, m.msrp, m.all_in_price, m.fuel_type,
  m.drivetrain, m.price_basis, m.source_url, now(),
  coalesce(m.attrs, '{}'::jsonb) || jsonb_build_object(
    'alias_of', 'RAV4',
    'alias_reason', '2026 RAV4 is hybrid-only; Toyota publishes both names')
from public.msrp_catalog m
where m.make ilike 'Toyota' and m.model = 'RAV4' and m.year = 2026
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- Both names, same four trims, same prices.
select model, "trim", msrp, all_in_price, fuel_type
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model in ('RAV4','RAV4 Hybrid','RAV4 Plug-in Hybrid')
order by model, msrp;
