-- Which price convention a catalog row is stored on.
--
-- WHY. Canadian MSRP is conventionally quoted EXCLUDING freight & PDI (~$2,000
-- -$2,600), but an advertised price in an all-in province (AB/ON/BC/QC) INCLUDES
-- it. Comparing the two silently overstates how far over sticker a car is by
-- roughly the freight amount. Our sources also disagree: scrape-vw.mjs derives
-- msrp by subtracting freight from the advertised price (excl.), while the
-- hand-verified toyota.ca rows are freight-inclusive (their $75,450 Land Cruiser
-- 1958 is Toyota's $71,670 press figure + $3,780 freight/PDI).
--
-- Rather than guess a single convention, record what each row actually is and
-- let the report say so. NULL means "not established" -- the report then states
-- the freight caveat instead of pretending precision it doesn't have.
alter table msrp_catalog add column if not exists price_basis text;

comment on column msrp_catalog.price_basis is
  'incl_freight | excl_freight | null (unknown). Freight & PDI convention for this row.';
