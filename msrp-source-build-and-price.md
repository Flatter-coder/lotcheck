# Build & Price is the MSRP source we've been looking for

**Discovered 2026-08-15**, from a Toyota Canada Build & Price PDF Vic pulled for a
2026 RAV4 Plug-in Hybrid GR SPORT AWD, Alberta.

This document records what that artifact contains, because it answers several
problems at once that we had been treating as separate.

---

## The captured artifact

| Field | Value |
|---|---|
| Vehicle | 2026 RAV4 Plug-in Hybrid **GR SPORT AWD**, Automatic |
| Province | **Alberta** (the document is province-scoped) |
| Exterior / Interior | Supersonic Red with Black Roof / Black Mixed Synthetic Suede & Softex |
| Build code | `KXPNZL` → **https://www.toyota.ca/build/KXPNZL** |
| Reference code | `GRRAPC AE 02TB` |
| Created | Aug 15, 2026, 2:04 AM MDT |
| Powertrain | Plug-in Hybrid, 5.7/7.2 L/100km, 943 km total range, 5 seats |

### The pricing table, exactly as published

| Line | Cash |
|---|---:|
| **MSRP** | **$58,405.00** |
| Dealer Fees [7] | $999.00 |
| Delivery and Destination Charge | $1,930.00 |
| Air Conditioning Charge | $100.00 |
| AMVIC | $10.00 |
| Tire Levy | $25.00 |
| PPSA Fee | n/a (cash) — $10 lease / $14 finance |
| PPSA Service Fee | n/a (cash) — $4.00 |
| **Vehicle Price subtotal** | **$61,469.00** |
| GST (5.0%) | $3,073.45 |
| **TOTAL** | **$64,542.45** |

Finance: **5.69% APR**, 72 months, *"applicable until Aug 30, 2026, 6:00 PM MDT"*.
Lease: 60 months, 20,000 km/yr, lease-end value $26,866.30 plus a $300 Dealer
Lease End Option Fee.

---

## Why this matters more than a price

### 1. It decomposes the BASIS, which is our largest source of wrong claims

The single biggest cause of a false over/under-MSRP claim is comparing an
**all-in advertised price** (regulator-mandated in AB/ON/BC/QC) against an
**ex-freight MSRP**. The difference is typically $2,000–$2,600 and it looks
exactly like dealer markup when it is not.

This document publishes **both numbers, itemised, per province, from the
manufacturer**. `MSRP $58,405` and `all-in $61,469` are both official. That
removes the guesswork entirely — see `msrpPriceBasis` handling and
`_shared/msrp-claim.ts`.

### 2. It publishes a manufacturer dealer-fee ceiling

> *"...and Dealer Fees of up to **$999.00**. Dealer may sell for less."*

Footnote 7 defines what that covers:

> *"Dealer Fees may be comprised of administration/documentation fees, VIN
> etching, anti-theft products, cold weather packages or other fees."*

That is a **manufacturer-published benchmark for the fee audit**. A dealer
charging $1,800 in admin/etching/anti-theft is exceeding what their own
manufacturer publishes as the ceiling — a citable, factual comparison rather
than an allegation.

### 3. It carries an official APR with an expiry date

5.69%, *valid until Aug 30, 2026*. The APR checkpoint can use it AND know
exactly when it goes stale, which is the freshness problem we could not
otherwise solve for `finance_rate_catalog`.

### 4. It is buyer-verifiable, which is the whole dispute-proofing model

The build code resolves to a public URL the buyer can open themselves. We are
not asking anyone to trust LotCheck's copy of the number — we hand them the
manufacturer's own page. This is exactly `make-it-dispute-proof`.

### 5. It gives us safe language

> *"A Toyota Dealership is free to set its own selling price for Toyota products
> and services."*

We report arithmetic, never wrongdoing. Toyota supplies the framing.

---

## The worked example that prompted this

A Google Vehicle Listing Ad showed **Okotoks Toyota, 2026 Toyota RAV4 Plug-In,
$85,995 "All-in", New**.

Against Toyota Canada's own all-in figure for the GR SPORT AWD — which already
includes the maximum $999 dealer fee — that is:

```
$85,995  −  $61,469  =  $24,526   (≈ 40% above the manufacturer's all-in price)
```

**This comparison is NOT publishable as it stands.** The Google card title is
truncated at "RAV4 Plug-I…" and the trim is unconfirmed. Under
`msrp-exact-must-pin-config` and `_shared/msrp-claim.ts`, an unpinned trim
yields `basis: "starting_at"` at best, which refuses the comparison. Pinning the
trim is the precondition, and it is what the trim-confirmation flow below is for.

---

## How the trim gets pinned (Vic, 2026-08-15)

The dealer must **type the model into their own page** to sell it — that text
survives even when the price is replaced with "Call for pricing". So:

1. Read the dealer's own words for the vehicle.
2. Match them against the manufacturer's official trim ladder.
3. **When it is ambiguous, ask the buyer** — showing the *manufacturer's* trim
   images and their MSRPs, not the dealer's photo: *"The dealer's page says 2026
   RAV4 Plug-in Hybrid. Which one is it?"*
4. The buyer, who is looking at the actual car, settles it in one click. The
   trim is then pinned by someone who knows, not inferred from pixels.

Using the dealer's photo to guess the trim was considered and rejected: the
manufacturer's own disclaimer — *"Image shown for illustration purposes only.
Vehicle may not be as shown"* — applies to dealer stock photography too, and a
mis-identified trim produces a wrong MSRP, which is the IONIQ 9 failure class.

---

---

## The "From" price is the ALL-IN price (proven 2026-08-15)

Three more Build & Price summaries (SE AWD, XSE AWD) plus the trim-selector
cards settled the basis question outright.

| trim | MSRP | + mandatory adds | = card "From" |
|---|---:|---:|---:|
| SE | $48,750 | $3,078 | **$51,828** |
| XSE | $56,400 | $3,078 | **$59,478** |
| GR SPORT | $57,500 | $3,078 | **$60,578** |
| XSE + Technology Package | $59,350 | $3,078 | **$62,428** |

Exact to the dollar, every trim. The $3,078 is itemised by Toyota:

```
Delivery & Destination   $1,930
Dealer Fees (maximum)      $999
Air Conditioning Charge    $100
Tire Levy                   $25
PPSA Fee (finance)          $14
AMVIC                       $10
```

**So we never estimate freight and PDI again.** Compare the card's "From"
against an all-in advertised listing; compare MSRP against an ex-freight quote.
Both figures now live per row — `msrp_catalog.all_in_price`, added in
`20260815_msrp_all_in_price.sql`.

The adds are **not** a universal constant: Delivery & Destination varies by
model, and the dealer-fee ceiling may vary by make and province. Capture per row
from the manufacturer; never add a constant.

### EVAP eligibility comes from the same document

The SE summary carries an **"Electric Vehicle Affordability Program −$2,500.00"**
incentive line; the XSE summary does not. That is Alberta's price ceiling doing
its work, published by Toyota rather than re-derived by us. The trim card also
shows an "Eligible for EVAP" badge.

### The ceiling this establishes

The most expensive 2026 RAV4 Plug-in Hybrid Toyota sells is the XSE with the
Technology Package at **$62,428 all-in, including the maximum dealer fee**.

The Okotoks listing at $85,995 all-in is **$23,567 above that ceiling** — and it
holds without pinning the trim, because there is no higher grade to name.

---

## Open questions

- Does the build-code URL pattern (`toyota.ca/build/XXXXXX`) allow cheap
  enumeration of every trim, or is a code only minted per configuration session?
- Which other makes publish an equivalent province-aware Build & Price summary
  with an itemised fee breakdown? (Expected: most; needs verification per make.)
- Is the PDF generated client-side or fetched? Determines capture cost.
- Does the "Dealer Fees of up to $X" ceiling vary by make and province? If so it
  becomes a per-jurisdiction benchmark table for the fee audit.
