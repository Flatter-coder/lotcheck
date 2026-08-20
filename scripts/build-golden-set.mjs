// Golden-set answer-key builder.
//
// Fetches each listing URL in scripts/fixtures/golden/url-pool.json directly
// (the dealer's own public page, no vendor) and extracts the page's TRUTH for
// the fields a Quote Check report claims: identity, condition, asking price,
// price-gating, dealer-stated MSRP, VIN, odometer. The output answer key is
// what scripts/grade-golden-set.mjs grades pipeline output against — this is
// the correctness instrument the benchmark explicitly is not (its header:
// "a figure that is present but wrong is counted as present").
//
// INDEPENDENCE RULE: this file must not import from supabase/functions/_shared
// or reuse any pipeline parser. The pipeline must never grade itself — a
// shared parser bug would score a wrong value as a match. Extraction here is
// deliberately separate, simple code reading the page's own machine-readable
// data (JSON-LD, inline vehicle blobs, meta tags) plus labelled visible text.
//
// CONFIDENCE MODEL — the grader only grades 'structured', 'cross' and 'agent':
//   structured  one machine-readable source on the page states it
//   cross       two independent sources on the same page agree
//   text        visible-text-only read; NOT graded until adversarially
//               verified (then promoted to 'agent') — text regexes are noisy
//               and a noisy key would manufacture fake "wrong" grades.
//   conflict    sources disagree; excluded from grading, listed for review.
//
// Run: node scripts/build-golden-set.mjs
//   writes scripts/fixtures/golden/answer-keys.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { vinValid } from "./lib/golden.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 LotCheckGoldenSet/1.0";
const POOL = "scripts/fixtures/golden/url-pool.json";
const OUT = "scripts/fixtures/golden/answer-keys.json";

const get = async (url, ms = 30_000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-CA" },
      signal: c.signal, redirect: "follow",
    });
    return { status: r.status, html: r.ok ? await r.text() : "" };
  } catch (e) {
    return { status: 0, html: "", err: String(e?.message || e) };
  } finally { clearTimeout(t); }
};

const snip = (s, at, span = 90) =>
  String(s).slice(Math.max(0, at - span), at + span).replace(/\s+/g, " ").trim().slice(0, 200);

const toNum = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── source 1: JSON-LD ────────────────────────────────────────────────────────
function jsonLdNodes(html) {
  const nodes = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const stack = [parsed];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) { stack.push(...n); continue; }
      if (!n || typeof n !== "object") continue;
      if (n["@graph"]) stack.push(n["@graph"]);
      const t = [].concat(n["@type"] || []).map(String);
      if (t.some((x) => /vehicle|car|product/i.test(x))) nodes.push(n);
      for (const v of Object.values(n)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return nodes;
}

function fromJsonLd(nodes) {
  const out = {};
  for (const n of nodes) {
    const offer = [].concat(n.offers || [])[0] || {};
    const set = (k, v) => { if (v != null && out[k] === undefined) out[k] = v; };
    set("vin", typeof n.vehicleIdentificationNumber === "string" ? n.vehicleIdentificationNumber.toUpperCase().trim() : null);
    set("price", toNum(offer.price ?? n.price));
    const mil = n.mileageFromOdometer;
    set("odometerKm", toNum(typeof mil === "object" ? mil?.value : mil));
    set("condition", /used/i.test(String(n.itemCondition || offer.itemCondition || "")) ? "used"
      : /new/i.test(String(n.itemCondition || offer.itemCondition || "")) ? "new" : null);
    set("name", typeof n.name === "string" ? n.name : null);
    set("year", toNum(n.vehicleModelDate ?? n.productionDate ?? n.modelDate));
    set("make", typeof n.brand === "object" ? n.brand?.name : typeof n.brand === "string" ? n.brand : (typeof n.manufacturer === "object" ? n.manufacturer?.name : n.manufacturer));
    set("model", typeof n.model === "object" ? n.model?.name : typeof n.model === "string" ? n.model : null);
    // vehicleConfiguration is a body-style label on some platforms ("4WD Sport
    // Utility Vehicles") — verification corrected 4 keys that trusted it.
    set("trim", typeof n.trim === "string" ? n.trim
      : typeof n.vehicleConfiguration === "string" && !/wagon|sedan|coupe|truck|van|hatch|utility|cab|convertible|4wd|awd|fwd|2wd|4x4/i.test(n.vehicleConfiguration)
        ? n.vehicleConfiguration : null);
    set("stock", typeof n.sku === "string" ? n.sku : null);
  }
  return out;
}

// ── source 2: inline vehicle blobs (Convertus vmsData and lookalikes) ────────
// Generic deep scan — key-name driven, no dependence on one platform's schema.
function inlineBlob(html) {
  const m = html.match(/(?:var|window\.)\s*vmsData\s*=\s*(\{[\s\S]*?\})\s*;/) ||
            html.match(/window\.__vdpJSON\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function fromBlob(blob) {
  if (!blob) return {};
  const found = {};
  const stack = [[blob, ""]];
  while (stack.length) {
    const [n, path] = stack.pop();
    if (!n || typeof n !== "object") continue;
    for (const [k, v] of Object.entries(n)) {
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === "object") { stack.push([v, p]); continue; }
      const key = k.toLowerCase();
      const keep = (name, val) => { if (val != null && found[name] === undefined) found[name] = { val, path: p }; };
      if (typeof v === "string" && vinValid(v)) keep("vin", v.toUpperCase().trim());
      if (/^(price|selling_?price|sale_?price|asking_?price|final_?price|internet_?price)$/.test(key)) {
        const n2 = toNum(v); if (n2 && n2 >= 3000 && n2 <= 500000) keep("price", n2);
      }
      if (/^(msrp|list_?price|retail_?price)$/.test(key)) {
        const n2 = toNum(v); if (n2 && n2 >= 3000 && n2 <= 500000) keep("msrp", n2);
      }
      if (/odometer|mileage|kilometer/.test(key)) {
        const n2 = toNum(v); if (n2 != null && n2 >= 0 && n2 <= 500000) keep("odometerKm", n2);
      }
      if (/^stock(_?(no|number|num))?$/.test(key) && typeof v === "string") keep("stock", v.trim());
      if (/date_?on_?lot|in_?stock_?date|date_?entry/.test(key) && v) keep("dateOnLot", String(v));
      if (key === "year") { const n2 = toNum(v); if (n2 && n2 > 1980 && n2 < 2100) keep("year", n2); }
      if (key === "make" && typeof v === "string") keep("make", v.trim());
      if (key === "model" && typeof v === "string") keep("model", v.trim());
      if (key === "trim" && typeof v === "string") keep("trim", v.trim());
    }
  }
  return found;
}

// ── source 2b: vehicle-widget query strings ──────────────────────────────────
// D2C/DealerOn pages embed widget URLs carrying the record's own fields in one
// query string with the VIN (vin=...&mk=Ford&model=F-250&trim=Platinum&cond=U
// &kms=8,557). Verification showed these separate model from trim where the
// URL slug mashes them together — 24 conflated model keys came from slugs.
function widgetParams(html) {
  for (const m of html.matchAll(/vin=([A-HJ-NPR-Z0-9]{17})[^"'<>\s]*/g)) {
    const qs = m[0].replace(/&amp;/g, "&");
    const p = (name) => {
      const x = qs.match(new RegExp(`[?&]${name}=([^&]+)`, "i"));
      return x ? decodeURIComponent(x[1].replace(/\+/g, " ")).trim() : null;
    };
    const out = { vin: m[1], make: p("mk"), model: p("model"), trim: p("trim"), cond: p("cond"), kms: p("kms") };
    if (out.model || out.trim) return out;
  }
  return null;
}

// ── source 3: visible text ───────────────────────────────────────────────────
function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

const GATED_RE = /(contact\s+us\s+for\s+(?:our\s+)?pric\w+|call\s+for\s+pric\w+|inquire\s+for\s+pric\w+|request\s+(?:a\s+|our\s+)?pric\w+|get\s+(?:e-?)?pric\w+|unlock\s+(?:our\s+)?pric\w+)/i;

function textFacts(text) {
  const prices = [];
  for (const m of text.matchAll(/\$\s?([\d,]{4,9})(?:\.\d\d)?\b/g)) {
    const v = toNum(m[1]);
    if (!v || v < 3000 || v > 500000) continue;
    const ctx = snip(text, m.index, 70);
    const isMsrp = /msrp|sticker|manufacturer'?s?\s+(?:suggested|retail)|total\s+msrp/i.test(ctx);
    const isAsking = /(?:^|[^a-z])(price|now|sale|our|dealer|internet|cash|net)\b/i.test(ctx) && !isMsrp;
    prices.push({ v, isMsrp, isAsking, ctx });
  }
  const gated = text.match(GATED_RE);
  const odos = [];
  for (const m of text.matchAll(/([\d,]{1,3}(?:,\d{3})+|\d{4,6})\s*km\b/gi)) {
    const ctx = snip(text, m.index, 70);
    if (/warranty|coverage|per\s+year|\/\s*yr|range|l\/100|allowance/i.test(ctx)) continue;
    const v = toNum(m[1]);
    if (v != null && v >= 0 && v <= 500000) odos.push({ v, labelled: /odometer|mileage|kms?\s*:/i.test(ctx), ctx });
  }
  const apr = text.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:apr|financ)/i);
  const fpAt = text.search(/disclaimer|prices?\s+(?:do(?:es)?\s+not|exclude|plus)|\+\s*(?:gst|tax)|documentation\s+fee/i);
  return {
    prices, odos,
    gatedCta: gated ? gated[0] : null,
    gatedCtx: gated ? snip(text, gated.index, 90) : null,
    aprText: apr ? apr[0] : null,
    finePrint: fpAt >= 0 ? text.slice(fpAt, fpAt + 320).trim() : null,
  };
}

// ── source 4: URL + <title> identity ─────────────────────────────────────────
function urlIdentity(url) {
  const path = new URL(url).pathname.toLowerCase();
  // convertus: /vehicles/2025/acura/integra/calgary/ab/NNN/
  let m = path.match(/\/vehicles\/(20\d\d)\/([a-z-]+)\/([a-z0-9-]+)\//);
  if (m) return { year: Number(m[1]), make: m[2].replace(/-/g, " "), model: m[3].replace(/-/g, " "), platform: "convertus" };
  // d2c/dealeron: /new/vehicle/2026-chevrolet-trax-1rs-idNNN.htm
  m = path.match(/\/(new|used)\/vehicle\/(20\d\d)-([a-z]+)-([a-z0-9-]+?)-id\d+\.htm/);
  if (m) return { condition: m[1], year: Number(m[2]), make: m[3], modelTrim: m[4].replace(/-/g, " "), platform: "d2c_dealeron" };
  // westgate: /inventory/Used-2018-Chevrolet-Trax-LT-VIN17
  m = path.match(/\/inventory\/(new|used|certified)-(20\d\d)-([a-z]+)-(.+?)-([a-hj-npr-z0-9]{17})$/);
  if (m) return { condition: m[1] === "certified" ? "used" : m[1], year: Number(m[2]), make: m[3], modelTrim: m[4].replace(/-/g, " "), vin: m[5].toUpperCase(), platform: "inventory_vin" };
  // edealer-family: /inventory/2026-honda-civic-sedan-lx-XXXXvdp
  m = path.match(/\/inventory\/(20\d\d)-([a-z]+)-([a-z0-9-]+?)-[a-z0-9]{10,}(?:vdp)?$/);
  if (m) return { year: Number(m[1]), make: m[2], modelTrim: m[3].replace(/-/g, " "), platform: "edealer_family" };
  return { platform: "unknown" };
}

// ── reconcile one listing ────────────────────────────────────────────────────
function buildKey(url, html, status) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const ld = fromJsonLd(jsonLdNodes(html));
  const blob = fromBlob(inlineBlob(html));
  const text = pageText(html);
  const tf = textFacts(text);
  const uid = urlIdentity(url);
  const wp = widgetParams(html);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();

  const fields = {};
  const conflicts = [];
  const put = (name, value, source, confidence, evidence) => { fields[name] = { value, source, confidence, evidence }; };
  const agree = (a, b, tol = 1) => a != null && b != null && (typeof a === "number" ? Math.abs(a - b) <= tol : String(a).toLowerCase() === String(b).toLowerCase());

  // VIN — whole-page scan of check-digit-valid VINs, cross-checked vs sources
  const vins = [...new Set([...html.matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map((m) => m[0].toUpperCase()).filter(vinValid))];
  const srcVin = ld.vin && vinValid(ld.vin) ? ld.vin : blob.vin?.val || uid.vin || null;
  let vinAbsentConfirmed = false;
  if (srcVin && vins.includes(srcVin)) put("vin", srcVin, "structured+page-scan", "cross", `VIN appears in structured data and page body`);
  else if (srcVin) put("vin", srcVin, ld.vin ? "jsonld" : blob.vin ? "inline-blob" : "url", "structured", "VIN from structured source only");
  else if (vins.length === 1) put("vin", vins[0], "page-scan", "structured", "single check-digit-valid VIN on page");
  else if (vins.length > 1) conflicts.push({ field: "vin", values: vins.map((v) => ({ source: "page-scan", value: v })) });
  else if (status === 200 && html.length > 20000) vinAbsentConfirmed = true;

  // asking price. The <title> counts as machine-readable: D2C/DealerOn titles
  // are platform-generated from the listing record ("2026 Chevrolet Trax 1RS
  // at $28890 for sale...") and were the ONLY machine source on 24/120 pages.
  const titlePrice = toNum(title.match(/(?:\bat|\bfor)\s+\$\s?([\d,]{4,9})\b/)?.[1]);
  // meta description "for sale - only $X" is the displayed price on D2C pages
  // where JSON-LD/title carry the MSRP or an allowance-conditioned figure —
  // verification corrected 6 keys that trusted title/JSON-LD alone. Including
  // it makes those pages a declared CONFLICT (adjudicated), never a silent
  // wrong value.
  const metaDescPrice = toNum(html.match(/for sale[^"'<>]{0,40}?only\s+\$\s?([\d,]{4,9})/i)?.[1]);
  const structuredPrices = [
    ld.price != null ? { source: "jsonld", value: ld.price } : null,
    blob.price ? { source: `inline-blob:${blob.price.path}`, value: blob.price.val } : null,
    titlePrice != null && titlePrice >= 3000 && titlePrice <= 500000 ? { source: "title", value: titlePrice } : null,
    metaDescPrice != null && metaDescPrice >= 3000 && metaDescPrice <= 500000 ? { source: "meta-desc", value: metaDescPrice } : null,
  ].filter(Boolean);
  const textAsk = tf.prices.filter((p) => p.isAsking);
  const gated = !!tf.gatedCta && structuredPrices.length === 0 && textAsk.length === 0;
  const allAgree = structuredPrices.every((p) => agree(p.value, structuredPrices[0].value));
  if (structuredPrices.length >= 2 && !allAgree) {
    conflicts.push({ field: "askingPrice", values: structuredPrices });
  } else if (structuredPrices.length) {
    const v = structuredPrices[0].value;
    const crossed = structuredPrices.length >= 2 || textAsk.some((p) => agree(p.v, v));
    put("askingPrice", v, structuredPrices.map((s) => s.source).join("+"), crossed ? "cross" : "structured",
      crossed ? "independent on-page sources agree" : structuredPrices[0].source);
  } else if (textAsk.length && new Set(textAsk.map((p) => p.v)).size === 1) {
    put("askingPrice", textAsk[0].v, "visible-text", "text", textAsk[0].ctx);
  }

  // dealer-stated MSRP
  const textMsrp = tf.prices.filter((p) => p.isMsrp);
  if (blob.msrp) {
    const crossed = textMsrp.some((p) => agree(p.v, blob.msrp.val));
    put("msrpStated", blob.msrp.val, `inline-blob:${blob.msrp.path}`, crossed ? "cross" : "structured",
      crossed ? "blob and visible text agree" : blob.msrp.path);
  } else if (textMsrp.length && new Set(textMsrp.map((p) => p.v)).size === 1) {
    put("msrpStated", textMsrp[0].v, "visible-text", "text", textMsrp[0].ctx);
  }

  // odometer
  const structOdo = ld.odometerKm ?? blob.odometerKm?.val ?? null;
  const labelledOdo = tf.odos.filter((o) => o.labelled);
  if (structOdo != null) {
    const crossed = tf.odos.some((o) => agree(o.v, structOdo, 2));
    put("odometerKm", structOdo, ld.odometerKm != null ? "jsonld" : "inline-blob", crossed ? "cross" : "structured",
      crossed ? "structured and visible text agree" : "structured source only");
  } else if (labelledOdo.length && new Set(labelledOdo.map((o) => o.v)).size === 1) {
    put("odometerKm", labelledOdo[0].v, "visible-text", "text", labelledOdo[0].ctx);
  }

  // identity: year / make / model — cross when two of URL, title, JSON-LD agree
  const idSources = { url: uid, jsonld: { year: ld.year, make: ld.make, model: ld.model }, title: {} };
  const tm = title.match(/(20\d\d)\s+([A-Za-z]+)\s+([A-Za-z0-9 .-]+?)(?:\s+(?:for sale|in\b|\||–|-)\s|$)/);
  if (tm) idSources.title = { year: Number(tm[1]), make: tm[2], model: tm[3].trim() };
  for (const f of ["year", "make"]) {
    const vals = Object.entries(idSources).map(([s, o]) => ({ s, v: o[f] })).filter((x) => x.v != null && x.v !== "");
    if (!vals.length) continue;
    const uniq = [...new Set(vals.map((x) => String(x.v).toLowerCase()))];
    if (uniq.length === 1) put(f, vals[0].v, vals.map((x) => x.s).join("+"), vals.length >= 2 ? "cross" : "text", title.slice(0, 120));
    else conflicts.push({ field: f, values: vals.map((x) => ({ source: x.s, value: x.v })) });
  }
  // model: prefer sources that separate model from trim (JSON-LD, widget
  // params) — a URL slug mashes them ("trax 1rs"), which verification rejected
  // on 24 keys. Slug/title model is text-confidence only.
  const modelCand = ld.model || wp?.model || uid.model || uid.modelTrim || idSources.title.model;
  if (modelCand) {
    const two = [ld.model, wp?.model, uid.model, idSources.title.model].filter(Boolean);
    const crossed = two.length >= 2 && two.some((a) => two.some((b) => a !== b && (String(a).toLowerCase().includes(String(b).toLowerCase()) || String(b).toLowerCase().includes(String(a).toLowerCase()))));
    put("model", modelCand, ld.model ? "jsonld" : wp?.model ? "widget-params" : "url/title",
      crossed ? "cross" : ld.model || wp?.model ? "structured" : "text", title.slice(0, 120));
  }
  const trimCand = ld.trim || blob.trim?.val || wp?.trim;
  if (trimCand) put("trim", trimCand, ld.trim ? "jsonld" : blob.trim ? "inline-blob" : "widget-params", "structured", "");

  // condition
  const urlCond = uid.condition || (/\/used|\/certified|[/-]used-/i.test(url.toLowerCase()) ? "used" : /\/new\//i.test(url.toLowerCase()) ? "new" : null);
  const conds = [{ s: "url", v: urlCond }, { s: "jsonld", v: ld.condition }].filter((x) => x.v);
  if (conds.length) {
    const uniq = [...new Set(conds.map((x) => x.v))];
    if (uniq.length === 1) put("condition", uniq[0], conds.map((x) => x.s).join("+"), conds.length >= 2 ? "cross" : "structured", "");
    else conflicts.push({ field: "condition", values: conds.map((x) => ({ source: x.s, value: x.v })) });
  } else if (fields.odometerKm?.value > 2000) put("condition", "used", "odometer-inference", "text", `${fields.odometerKm.value} km`);

  if (blob.stock) put("stockNumber", blob.stock.val, "inline-blob", "structured", "");
  else if (ld.stock) put("stockNumber", ld.stock, "jsonld", "structured", "");
  if (blob.dateOnLot) put("dateOnLot", blob.dateOnLot.val, "inline-blob", "structured", "");

  return {
    url, host, platform: uid.platform, httpStatus: status,
    pageTitle: title.slice(0, 160),
    condition: fields.condition?.value || null,
    priceGated: gated,
    gatedCta: tf.gatedCta, gatedCtx: tf.gatedCtx,
    vinAbsentConfirmed,
    aprText: tf.aprText,
    finePrint: tf.finePrint,
    fields, conflicts,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
// A rebuild resets adversarial verification — the same shape as a catalog
// refresh wiping hand-verified enrichment (test:carry-forward's lesson). Never
// destroy a verified key file silently: demand --force, and after any forced
// rebuild re-run the verify workflow + scripts/apply-golden-verification.mjs.
if (existsSync(OUT) && !process.argv.includes("--force")) {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8").replace(/^﻿/, ""));
    if (prev?.meta?.verifiedAt) {
      console.error(`${OUT} was adversarially verified at ${prev.meta.verifiedAt}.`);
      console.error("Rebuilding would DISCARD that verification. Re-run with --force, then re-verify.");
      process.exit(1);
    }
  } catch { /* unreadable previous file — overwriting it is fine */ }
}
const pool = JSON.parse(readFileSync(POOL, "utf8").replace(/^﻿/, ""));
const listings = [];
const fetchFailures = [];
let i = 0;
const CONCURRENCY = 6;

async function worker() {
  while (i < pool.length) {
    const url = pool[i++];
    let r = await get(url);
    if (!r.html) r = await get(url); // one retry
    if (!r.html) { fetchFailures.push({ url, reason: r.err || `http_${r.status}` }); continue; }
    try {
      listings.push(buildKey(url, r.html, r.status));
    } catch (e) {
      fetchFailures.push({ url, reason: `extract: ${String(e?.message || e)}` });
    }
    console.error(`[${listings.length + fetchFailures.length}/${pool.length}] ${url.slice(0, 90)}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const dealers = {}; const platforms = {};
for (const l of listings) {
  dealers[l.host] = (dealers[l.host] || 0) + 1;
  platforms[l.platform] = (platforms[l.platform] || 0) + 1;
}
const cov = (f) => listings.filter((l) => l.fields[f] && ["structured", "cross", "agent"].includes(l.fields[f].confidence)).length;

const out = {
  meta: {
    version: 1,
    builtAt: new Date().toISOString(),
    poolFile: POOL,
    attempted: pool.length,
    keysWritten: listings.length,
    fetchFailures,
    dealers, platforms,
    gradableCoverage: {
      askingPrice: cov("askingPrice"), vin: cov("vin"), odometerKm: cov("odometerKm"),
      msrpStated: cov("msrpStated"), year: cov("year"), make: cov("make"),
      model: cov("model"), condition: cov("condition"),
    },
    caps: [
      "Alberta dealers only; 6 hosts, 4 platform shapes — no Quebec, no marketplaces (policy), no OEM-direct stores.",
      "text-confidence fields are NOT graded until adversarially verified and promoted to 'agent'.",
      "dealer-stated MSRP truth only — manufacturer-exact MSRP correctness is the catalog value audit's job, not this key's.",
    ],
  },
  listings,
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(`\nwrote ${OUT}: ${listings.length} keys, ${fetchFailures.length} fetch failures`);
console.error("dealers:", JSON.stringify(dealers));
console.error("platforms:", JSON.stringify(platforms));
console.error("gradable coverage:", JSON.stringify(out.meta.gradableCoverage));
