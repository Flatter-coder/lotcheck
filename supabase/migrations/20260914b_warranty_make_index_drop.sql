-- The model-scoped warranty migration could not apply, and the reason is a
-- defensive block that was only half defensive.
--
-- 20260912_warranty_model_scoped.sql makes `make` non-unique so one maker can
-- hold several rows (a Civic and a Civic Type R do not share a warranty). It
-- does that carefully: it looks up the PRIMARY KEY by name rather than guessing
-- it, because Postgres generated the name.
--
-- But it searches `pg_constraint` for `contype = 'p'`. A bare
-- `create unique index ... on (lower(make))` produces NO pg_constraint row at
-- all -- it is an index, not a constraint -- so the block finds nothing, drops
-- nothing, and the insert that follows dies on it. Applied 2026-09-14:
--
--   ✗ 20260912_warranty_model_scoped.sql
--       ERROR: 23505: duplicate key value violates unique constraint
--       "idx_manufacturer_warranties_make"  DETAIL: Key (lower(make))...
--
-- A guard that inspects one catalogue and calls itself thorough is the shape
-- this repo keeps meeting: it looked complete, it named the right risk, and it
-- was blind to the object that actually held the lock.
--
-- THIS DROPS AN INDEX, NOT DATA. No row is touched. The uniqueness it enforced
-- -- one warranty row per make -- is exactly what the model-scoped design
-- replaces, and its successor
-- (manufacturer_warranties_scope_uq, over make + model + year range) is created
-- by that same migration. Run this one FIRST, then re-run 20260912.
--
-- Written by object SHAPE rather than by name, so a differently-named index
-- doing the same job is also removed: any UNIQUE index on this table whose
-- definition covers lower(make) and nothing else. The new scope index spans
-- four expressions and is therefore never matched.

do $$
declare
  ix record;
  dropped int := 0;
begin
  for ix in
    select i.relname as idx_name, pg_get_indexdef(i.oid) as idx_def
      from pg_class t
      join pg_index x  on x.indrelid = t.oid
      join pg_class i  on i.oid = x.indexrelid
     where t.relname = 'manufacturer_warranties'
       and t.relnamespace = 'public'::regnamespace
       and x.indisunique
       and x.indnatts = 1                 -- one key only; the new one has four
       and not x.indisprimary             -- the PK is the other migration's job
  loop
    -- Only an index keyed on make (raw or lower()). Anything else on this table
    -- is left alone: this migration has one job.
    if ix.idx_def ~* '\((lower\()?make\)?\)$' then
      raise notice 'dropping unique index % -- %', ix.idx_name, ix.idx_def;
      execute format('drop index if exists public.%I', ix.idx_name);
      dropped := dropped + 1;
    end if;
  end loop;

  if dropped = 0 then
    raise notice 'no make-only unique index found; nothing to drop (already applied, or never existed)';
  end if;
end $$;

-- Readback: proves what happened rather than reporting success. After this runs
-- there must be NO single-column unique index on make, and the model-scoped
-- migration is free to apply.
select
  i.relname                                   as remaining_unique_index,
  pg_get_indexdef(i.oid)                      as definition
  from pg_class t
  join pg_index x on x.indrelid = t.oid
  join pg_class i on i.oid = x.indexrelid
 where t.relname = 'manufacturer_warranties'
   and t.relnamespace = 'public'::regnamespace
   and x.indisunique
 order by 1;
