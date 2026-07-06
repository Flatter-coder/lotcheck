import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from "recharts";
import { createClient } from "@supabase/supabase-js";
import { Analytics } from "@vercel/analytics/react";

// ── Supabase client (anon key — safe to expose in frontend) ───────────────────
const supabase = createClient(
  "https://debigtyjhjamipooajhk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A"
);

// ── Global responsive styles injected once ────────────────────────────────────
const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; -webkit-text-size-adjust: 100%; }
  body { background: #020617; color: #e2e8f0; font-family: 'Inter','Segoe UI',system-ui,sans-serif; overflow-x: hidden; }
  input, button, textarea { font-family: inherit; }
  input::placeholder { color: #334155; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }

  /* ── Apple-style particle background ─────────────────────────────────────── */
  .lc-live-bg {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    background: #020617;
  }
  .lc-live-bg canvas {
    position: absolute;
    top: 0; left: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  /* ── Fuel type animations ─────────────────────────────────────────────────── */
  @keyframes lc-charge {
    0%,100% { opacity:0.5; transform:scale(0.85); }
    50%     { opacity:1;   transform:scale(1.2); }
  }
  @keyframes lc-pump {
    0%,100% { transform:translateY(0); }
    30%     { transform:translateY(-3px); }
    60%     { transform:translateY(0); }
    80%     { transform:translateY(-1px); }
  }
  @keyframes lc-spin {
    0%   { transform:rotate(0deg); }
    100% { transform:rotate(360deg); }
  }

  /* Live ticker strip */
  .lc-ticker-wrap {
    background: #040810;
    border-bottom: 1px solid #1e293b;
    overflow: hidden;
    white-space: nowrap;
    position: relative;
    height: 30px;
    display: flex;
    align-items: center;
  }
  .lc-ticker-track {
    display: inline-flex;
    align-items: center;
    gap: 28px;
    animation: lc-ticker-scroll 38s linear infinite;
    will-change: transform;
  }
  .lc-ticker-wrap:hover .lc-ticker-track { animation-play-state: paused; }
  .lc-ticker-item:hover { background: rgba(255,255,255,0.06); border-radius: 6px; }
  .lc-ticker-item:hover .name { color: #22c55e; }
  @keyframes lc-ticker-scroll {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-50%); }
  }
  .lc-ticker-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #64748b;
  }
  .lc-ticker-item .name { color: #94a3b8; }
  .lc-ticker-item .up { color: #22c55e; }
  .lc-ticker-item .down { color: #ef4444; }
  .lc-ticker-dot {
    width: 5px; height: 5px; border-radius: 50%;
    background: #22c55e;
    animation: lc-blink 1.6s ease-in-out infinite;
  }
  @keyframes lc-blink {
    0%, 100% { opacity: 1; } 50% { opacity: 0.25; }
  }

  /* Radar ping — used where LotCheck is claiming genuinely live/real-time
     data (not decorative). Concentric rings expand and fade from a solid
     center dot. Two rings offset by 1s so a ring is always mid-expansion. */
  .lc-radar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }
  .lc-radar-core {
    width: 6px; height: 6px; border-radius: 50%;
    background: #22c55e;
    z-index: 1;
  }
  .lc-radar-ring {
    position: absolute;
    width: 10px; height: 10px;
    border-radius: 50%;
    border: 1.5px solid #22c55e;
    animation: lc-radar-ping 2s cubic-bezier(0,0,0.2,1) infinite;
  }
  .lc-radar-ring.delay { animation-delay: 1s; }
  @keyframes lc-radar-ping {
    0%   { transform: scale(1); opacity: 0.8; }
    100% { transform: scale(2.8); opacity: 0; }
  }

  /* Card content sits above the live background */
  .lc-layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    position: relative;
    z-index: 1;
    isolation: isolate;
  }

  /* Header */
  .lc-header {
    background: #060d18;
    border-bottom: 1px solid #1e293b;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    gap: 8px;
  }
  .lc-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  @media (max-width: 400px) {
    .lc-header { padding: 8px 10px; }
    .lc-header-appraisal-text { display: none; }
  }

  /* Main content area */
  .lc-main {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  @media (min-width: 768px) {
    .lc-main { flex-direction: row; }
  }

  /* Sidebar. This is the fix for the real bug: previously this had no
     height limit on phones at all, so with 180+ listings it grew the
     whole page to tens of thousands of pixels tall -- there was
     nothing wrong with the listings, the page was just enormous.
     Now it's a proper self-scrolling panel on every screen size, not
     just desktop. (When a listing gets selected on a phone, a
     separate early-return view further up takes over completely with
     its own back button -- this sidebar is only ever what's on
     screen here when nothing's selected yet.) */
  .lc-sidebar {
    width: 100%;
    height: calc(100vh - 57px);
    height: calc(100dvh - 57px);
    overflow-y: auto;
    border-bottom: 1px solid #1e293b;
  }
  @media (min-width: 768px) {
    .lc-sidebar {
      width: 340px;
      min-width: 320px;
      max-width: 380px;
      border-bottom: none;
      border-right: 1px solid #1e293b;
      position: sticky;
      top: 57px;
    }
  }
  @media (min-width: 1024px) {
    .lc-sidebar { width: 380px; }
  }

  /* Detail panel. On phones, the code path that renders this always
     has nothing selected (selecting a listing on a phone triggers the
     separate full-screen view above instead), so its only job here on
     a phone would be showing the empty "select a listing" placeholder
     underneath an already-obvious list -- not useful, so it's hidden
     on narrow screens and only appears at the desktop side-by-side
     breakpoint. */
  .lc-detail {
    display: none;
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }
  @media (min-width: 768px) {
    .lc-detail {
      display: block;
      height: calc(100vh - 57px);
      height: calc(100dvh - 57px);
      position: sticky;
      top: 57px;
    }
  }

  /* Province filter scroll */
  .lc-provinces {
    background: #040810;
    border-bottom: 1px solid #1e293b;
    padding: 8px 16px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: nowrap;
  }
  .lc-province-btn {
    display: inline-block;
    padding: 6px 14px;
    background: transparent;
    border: 1px solid #1e293b;
    border-radius: 20px;
    color: #475569;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    margin-right: 6px;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .lc-province-btn.active {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
  }

  /* Search + filters */
  .lc-filters {
    padding: 12px 16px;
    border-bottom: 1px solid #1e293b;
  }
  .lc-search {
    width: 100%;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 12px 14px;
    color: #e2e8f0;
    font-size: 14px;
    margin-bottom: 10px;
    outline: none;
    transition: border 0.15s;
  }
  .lc-search:focus { border-color: #16a34a; }
  .lc-fuel-filters { display: flex; gap: 6px; }
  .lc-fuel-btn {
    flex: 1;
    padding: 8px 0;
    background: transparent;
    border: 1px solid #1e293b;
    border-radius: 8px;
    color: #475569;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .lc-fuel-btn.active { background: #16a34a; border-color: #16a34a; color: #fff; }

  /* Listing cards */
  .lc-listings { padding: 12px 16px; }
  .lc-card {
    background: #0a0f1e;
    border: 2px solid #1e293b;
    border-radius: 14px;
    padding: 14px 16px;
    cursor: pointer;
    margin-bottom: 10px;
    transition: border-color 0.15s, background 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .lc-card:hover, .lc-card.active {
    border-color: #16a34a;
    background: #0d2010;
  }
  .lc-card-name { font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; line-height: 1.3; }
  .lc-card-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .lc-card-bottom { display: flex; justify-content: space-between; align-items: flex-end; }
  .lc-price { font-size: 22px; font-weight: 800; color: #f1f5f9; }

  /* Skeleton loading cards -- shown immediately on page load, before the
     real listings arrive, so a slow connection shows something visibly
     alive right away instead of a small text label that's easy to miss
     while the sidebar otherwise looks empty. */
  .lc-skel-card {
    background: #0a0f1e;
    border: 2px solid #1e293b;
    border-radius: 14px;
    padding: 14px 16px;
    margin-bottom: 10px;
  }
  .lc-skel-bar {
    height: 14px;
    border-radius: 6px;
    background: linear-gradient(90deg, #131b2e 25%, #1c2740 37%, #131b2e 63%);
    background-size: 400% 100%;
    animation: lc-shimmer 1.6s ease-in-out infinite;
  }
  @keyframes lc-shimmer {
    0% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .lc-after-rebate { font-size: 12px; color: #22c55e; font-weight: 600; margin-top: 2px; }
  .lc-meta { text-align: right; }
  .lc-city { font-size: 12px; color: #64748b; }
  .lc-km { font-size: 12px; font-weight: 600; }

  /* Badges */
  .badge { display: inline-block; border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; }

  /* Detail view */
  .lc-price-hero { margin-bottom: 16px; }
  .lc-price-big { font-size: 36px; font-weight: 800; color: #f1f5f9; letter-spacing: -1px; }
  @media (min-width: 768px) { .lc-price-big { font-size: 42px; } }

  .lc-tabs { display: flex; border-bottom: 1px solid #1e293b; margin-bottom: 16px; overflow-x: auto; }
  .lc-tab {
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #64748b;
    cursor: pointer;
    font-size: 13px;
    font-weight: 400;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .lc-tab.active { border-bottom-color: #16a34a; color: #22c55e; font-weight: 700; }

  /* Stats grid */
  .lc-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 16px;
  }
  @media (min-width: 768px) {
    .lc-stats { grid-template-columns: repeat(4, 1fr); }
  }
  .lc-stat {
    background: #0a0f1e;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 12px 14px;
  }
  .lc-stat-label { font-size: 11px; color: #94a3b8; margin-bottom: 4px; font-weight: 500; }
  .lc-stat-value { font-size: 15px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px; }

  /* Connect button */
  .lc-connect-btn {
    width: 100%;
    background: #16a34a;
    border: none;
    border-radius: 14px;
    padding: 18px 0;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    margin-top: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    transition: background 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .lc-connect-btn:hover { background: #15803d; }

  /* Modal */
  .lc-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 200;
  }
  .lc-modal {
    background: #0d1526;
    border-radius: 20px 20px 0 0;
    padding: 24px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
  }
  @media (min-width: 768px) {
    .lc-modal-overlay { align-items: center; }
    .lc-modal {
      border-radius: 20px;
      max-width: 480px;
      margin: 16px;
    }
  }
  .lc-modal-input {
    width: 100%;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 14px;
    color: #f1f5f9;
    font-size: 15px;
    outline: none;
    margin-bottom: 10px;
    transition: border 0.15s;
  }
  .lc-modal-input:focus { border-color: #16a34a; }
  .lc-modal-btn {
    width: 100%;
    background: #16a34a;
    border: none;
    border-radius: 12px;
    padding: 16px 0;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s;
  }
  .lc-modal-btn:hover { background: #15803d; }
  .lc-modal-btn:disabled { background: #1e3a5f; cursor: not-allowed; }

  /* Empty state */
  .lc-empty { color: #475569; font-size: 14px; text-align: center; padding: 40px 0; }

  /* Footer */
  .lc-footer { padding: 16px; border-top: 1px solid #1e293b; text-align: center; font-size: 11px; color: #1e293b; }
`;

// ── Data ──────────────────────────────────────────────────────────────────────
const REBATES = {
  AB:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,
    note:"Federal EVAP only — Alberta has no provincial EV rebate."},
  BC:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,
    note:"BC cancelled its provincial EV rebate (CVAP) on May 15, 2025. Federal EVAP only."},
  ON:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,
    note:"Federal only — Ontario cancelled its provincial rebate in 2018."},
  QC:{federal_bev:5000,federal_phev:2500,prov_bev:2000,prov_phev:500,prov_name:"Roulez Vert",
    note:"QC Roulez Vert reduced in 2026: BEV $2,000, PHEV (under 15kWh) $500, PHEV (15kWh+) $1,000. Program ends Dec 31, 2026."},
  MB:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,
    note:"Federal EVAP only — Manitoba has no provincial EV rebate."},
  SK:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,
    note:"Federal EVAP only — Saskatchewan has no provincial EV rebate."},
  NS:{federal_bev:5000,federal_phev:2500,prov_bev:3000,prov_phev:1500,prov_name:"NS ZEVIP",
    note:"Stack federal + provincial. Verify current NS ZEVIP availability at nszev.ca."},
  NB:{federal_bev:5000,federal_phev:2500,prov_bev:2500,prov_phev:1000,prov_name:"NB EV",
    note:"Stack federal + provincial. Verify current NB program availability."},
};
// ── Pro trial — real, persisted, actually expires ──────────────────────────
// Previously "Start 3-day free trial" just set a React boolean with no timer,
// no persistence, no expiry — it was permanently Pro until page refresh.
// This is a real (if not abuse-proof) mechanism: 48h from first click,
// persisted in localStorage so it survives refresh, and genuinely expires.
// This is a stopgap until real accounts + Stripe subscriptions exist — at
// that point trial state should move server-side to a real trial_end field.
const TRIAL_MS = 48 * 60 * 60 * 1000; // 48 hours
const TRIAL_KEY = "lc_trial_start";
function getTrialStatus() {
  try {
    const raw = window.localStorage.getItem(TRIAL_KEY);
    if (!raw) return { state: "none" };
    const start = Number(raw);
    if (!start || Number.isNaN(start)) return { state: "none" };
    const elapsed = Date.now() - start;
    if (elapsed < TRIAL_MS) return { state: "active", msLeft: TRIAL_MS - elapsed };
    return { state: "expired" };
  } catch (e) {
    return { state: "none" }; // localStorage unavailable (private browsing etc.)
  }
}
function startTrial() {
  try { window.localStorage.setItem(TRIAL_KEY, String(Date.now())); } catch (e) {}
}
function formatMsLeft(ms) {
  const h = Math.max(0, Math.floor(ms / 3600000));
  const m = Math.max(0, Math.floor((ms % 3600000) / 60000));
  return `${h}h ${m}m`;
}

// ── Anonymous visitor ID — persisted so repeat visits from the same browser
// count as one unique visitor, not a new one each time. This is LotCheck's
// real production site running in real browsers, not the Claude sandbox —
// localStorage is the correct, normal tool for this, unlike in an artifact
// preview where it silently fails.
const VISITOR_ID_KEY = "lc_visitor_id";
// Turns document.referrer into a clean, human-readable source label.
// No referrer at all (empty string) means the browser didn't send one --
// typically a bookmark, typed URL, or an app opening a link directly.
// Referrers from lotcheck.ca itself are internal navigation (e.g. welcome
// page -> /browse), not a real acquisition source, so they're labelled
// separately rather than counted as "where a visitor came from."
function classifyReferrer(){
  const ref=document.referrer;
  if(!ref) return "Direct";
  let host;
  try{ host=new URL(ref).hostname.toLowerCase(); }catch{ return "Direct"; }
  if(host.includes("lotcheck.ca")) return "Internal navigation";
  const known=[
    [/google\./,"Google"],
    [/bing\.com/,"Bing"],
    [/duckduckgo\.com/,"DuckDuckGo"],
    [/yahoo\./,"Yahoo"],
    [/facebook\.com|fb\.com|m\.facebook/,"Facebook"],
    [/instagram\.com/,"Instagram"],
    [/kijiji\.ca/,"Kijiji"],
    [/twitter\.com|t\.co|x\.com/,"Twitter/X"],
    [/linkedin\.com/,"LinkedIn"],
    [/reddit\.com/,"Reddit"],
    [/tiktok\.com/,"TikTok"],
  ];
  for(const[pattern,label]of known){ if(pattern.test(host)) return label; }
  return host; // unrecognized source -- show the real domain rather than "Other"
}

// Groups an array of timestamps into fixed time buckets. Shared by both the
// traffic graph (bucketing page_views) and the listings-over-time graph
// (bucketing each listing's first-ever price_history record) so both charts
// use identical, consistent time windows rather than two separate
// implementations that could drift out of sync with each other.
function bucketByTime(timestamps,granularity){
  const now=Date.now();
  const configs={
    hour:{bucketMs:3600000,count:24,label:d=>d.toLocaleTimeString("en-CA",{hour:"numeric"})},
    day:{bucketMs:24*3600000,count:30,label:d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"})},
    week:{bucketMs:7*24*3600000,count:12,label:d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"})},
    month:{bucketMs:30*24*3600000,count:12,label:d=>d.toLocaleDateString("en-CA",{month:"short"})},
  };
  const cfg=configs[granularity]||configs.day;
  const startTime=now-cfg.bucketMs*cfg.count;
  const buckets=[];
  for(let i=0;i<cfg.count;i++){
    const bucketStart=startTime+i*cfg.bucketMs;
    const bucketEnd=bucketStart+cfg.bucketMs;
    const count=timestamps.filter(t=>t>=bucketStart&&t<bucketEnd).length;
    buckets.push({label:cfg.label(new Date(bucketStart)),count});
  }
  return buckets;
}

// Groups raw page_views rows into fixed time buckets for the admin traffic
// graph. Each bucket knows its own view count and unique-visitor count.
function bucketPageViews(views,granularity){
  const now=Date.now();
  const configs={
    hour:{bucketMs:3600000,count:24,label:d=>d.toLocaleTimeString("en-CA",{hour:"numeric"})},
    day:{bucketMs:24*3600000,count:30,label:d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"})},
    week:{bucketMs:7*24*3600000,count:12,label:d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"})},
    month:{bucketMs:30*24*3600000,count:12,label:d=>d.toLocaleDateString("en-CA",{month:"short"})},
  };
  const cfg=configs[granularity]||configs.day;
  const startTime=now-cfg.bucketMs*cfg.count;
  const buckets=[];
  for(let i=0;i<cfg.count;i++){
    const bucketStart=startTime+i*cfg.bucketMs;
    const bucketEnd=bucketStart+cfg.bucketMs;
    const inBucket=views.filter(v=>{
      const t=new Date(v.created_at).getTime();
      return t>=bucketStart&&t<bucketEnd;
    });
    buckets.push({
      label:cfg.label(new Date(bucketStart)),
      views:inBucket.length,
      visitors:new Set(inBucket.map(v=>v.visitor_id)).size,
    });
  }
  return buckets;
}

function getOrCreateVisitorId() {
  try {
    let id = window.localStorage.getItem(VISITOR_ID_KEY);
    if (!id) {
      id = "v_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      window.localStorage.setItem(VISITOR_ID_KEY, id);
    }
    return id;
  } catch (e) {
    return null; // localStorage unavailable — view still gets logged, just not deduped
  }
}

const PROVINCES={AB:"Alberta",BC:"British Columbia",ON:"Ontario",QC:"Quebec",MB:"Manitoba",SK:"Saskatchewan",NS:"Nova Scotia",NB:"New Brunswick"};

function getRebate(province,fuel,listing){
  const r=REBATES[province];
  if(!r)return{federal:0,provincial:0,total:0,prov_name:null,note:"",eligible:false,ineligibleReason:""};
  if(!listing||fuel==="Gas"||fuel==="Hybrid"||fuel==="Diesel"){
    return{federal:0,provincial:0,total:0,prov_name:null,note:"",eligible:false,ineligibleReason:"Gas and standard hybrid vehicles are not eligible for EVAP."};
  }
  // A vehicle is used if: km > 10,000 OR it's more than 1 model year old
  // This catches listings where km data is missing/zero but the car is clearly used
  const currentYear = new Date().getFullYear();
  const isUsed = listing.km > 10000 || (listing.year < currentYear - 1);
  const overPriceCap = listing.price > 50000;
  if(isUsed){
    const federal=fuel==="BEV"?r.federal_bev:fuel==="PHEV"?r.federal_phev:0;
    const provincial=fuel==="BEV"?r.prov_bev:fuel==="PHEV"?r.prov_phev:0;
    return{federal:0,provincial:0,total:0,prov_name:r.prov_name,note:r.note,eligible:false,
      ineligibleReason:"EVAP applies to NEW vehicles only. Used vehicles are not eligible regardless of age.",
      newEquivalent:{federal,provincial,total:federal+provincial}};
  }
  if(overPriceCap){
    return{federal:0,provincial:0,total:0,prov_name:null,note:"",eligible:false,
      ineligibleReason:`This vehicle's price ($${listing.price.toLocaleString()}) exceeds the EVAP cap of $50,000. Not eligible for federal rebate.`};
  }
  // Being a new-enough, under-cap BEV/PHEV is necessary but not sufficient --
  // the specific year/make/model also has to actually be on Transport
  // Canada's approved list. Plenty of EVs aren't (see the IONIQ 5/6 note
  // above EVAP_LIST) even when they'd otherwise qualify on paper. This was
  // previously never checked here at all, which is exactly how a listing
  // like a 2025 Mach-E (only the 2026 model year is actually approved)
  // could show a $5,000 rebate it was never really eligible for.
  const evapMatch=getEVAP(listing);
  if(!evapMatch){
    return{federal:0,provincial:0,total:0,prov_name:null,note:"",eligible:false,
      ineligibleReason:`The ${listing.year} ${listing.make||""} ${listing.model||""} isn't on Transport Canada's current EVAP approved vehicle list. Rebate eligibility is model-year specific — a newer or older model year of the same vehicle may qualify even when this one doesn't.`};
  }
  const federal=evapMatch.incentive;
  const provincial=fuel==="BEV"?r.prov_bev:fuel==="PHEV"?r.prov_phev:0;
  return{federal,provincial,total:federal+provincial,prov_name:r.prov_name,note:r.note,eligible:true,ineligibleReason:""};
}

// ── EVAP eligible vehicle list — verified against Transport Canada July 1, 2026
// Source: tc.canada.ca/en/road-transportation/innovative-technologies/electric-vehicles/electric-vehicle-affordability-program-evap/electric-vehicle-affordability-program-vehicle-list
// Key rules: NEW vehicles only (< 10,000 km), final transaction value ≤ $50,000, purchased Feb 16 2026+
// Canadian-made EVs (Dodge Charger, Chrysler Pacifica) exempt from price cap
const EVAP_LIST=[
  // ── Chevrolet ──────────────────────────────────────────────────────────────
  {year:2027,make:"Chevrolet",model:"Bolt",fuel:"BEV",incentive:5000},
  {year:2026,make:"Chevrolet",model:"Equinox EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Chevrolet",model:"Equinox EV",fuel:"BEV",incentive:5000},
  // ── Chrysler (Canadian-made — no price cap) ────────────────────────────────
  {year:2026,make:"Chrysler",model:"Pacifica",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Chrysler",model:"Pacifica",fuel:"PHEV",incentive:2500},
  // ── Dodge (Canadian-made — no price cap) ──────────────────────────────────
  {year:2026,make:"Dodge",model:"Charger",fuel:"BEV",incentive:5000},
  {year:2025,make:"Dodge",model:"Charger",fuel:"BEV",incentive:5000},
  {year:2024,make:"Dodge",model:"Charger",fuel:"BEV",incentive:5000},
  // ── Fiat ───────────────────────────────────────────────────────────────────
  {year:2026,make:"Fiat",model:"500e",fuel:"BEV",incentive:5000},
  {year:2025,make:"Fiat",model:"500e",fuel:"BEV",incentive:5000},
  // ── Ford ───────────────────────────────────────────────────────────────────
  {year:2026,make:"Ford",model:"Escape",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Ford",model:"Escape",fuel:"PHEV",incentive:2500},
  {year:2024,make:"Ford",model:"Escape",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Ford",model:"Mach-e",fuel:"BEV",incentive:5000},
  // ── Hyundai ────────────────────────────────────────────────────────────────
  {year:2026,make:"Hyundai",model:"Kona EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Hyundai",model:"Kona EV",fuel:"BEV",incentive:5000},
  // NOTE: IONIQ 5 and IONIQ 6 are NOT on the 2026 EVAP list (over $50k or not enrolled)
  // ── Kia ────────────────────────────────────────────────────────────────────
  {year:2027,make:"Kia",model:"EV5",fuel:"BEV",incentive:5000},
  {year:2026,make:"Kia",model:"EV4",fuel:"BEV",incentive:5000},
  {year:2026,make:"Kia",model:"Niro EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Kia",model:"Niro EV",fuel:"BEV",incentive:5000},
  {year:2024,make:"Kia",model:"Niro EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Kia",model:"EV6",fuel:"BEV",incentive:5000},
  {year:2026,make:"Kia",model:"Niro PHEV",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Kia",model:"Niro PHEV",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Kia",model:"Sorento PHEV",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Kia",model:"Sportage PHEV",fuel:"PHEV",incentive:2500},
  {year:2027,make:"Kia",model:"Sportage PHEV",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Kia",model:"Sportage PHEV",fuel:"PHEV",incentive:2500},
  // ── Mazda ──────────────────────────────────────────────────────────────────
  {year:2026,make:"Mazda",model:"CX-70 PHEV",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Mazda",model:"CX-90 PHEV",fuel:"PHEV",incentive:2500},
  // ── MINI ───────────────────────────────────────────────────────────────────
  {year:2027,make:"MINI",model:"Countryman SE",fuel:"BEV",incentive:5000},
  // ── Mitsubishi ─────────────────────────────────────────────────────────────
  {year:2026,make:"Mitsubishi",model:"Outlander PHEV",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Mitsubishi",model:"Outlander PHEV",fuel:"PHEV",incentive:2500},
  // ── Nissan ─────────────────────────────────────────────────────────────────
  {year:2026,make:"Nissan",model:"Leaf",fuel:"BEV",incentive:5000},
  // ── Subaru ─────────────────────────────────────────────────────────────────
  {year:2026,make:"Subaru",model:"Uncharted",fuel:"BEV",incentive:5000},
  // ── Tesla ──────────────────────────────────────────────────────────────────
  {year:2026,make:"Tesla",model:"Model Y",fuel:"BEV",incentive:5000},
  // ── Toyota ─────────────────────────────────────────────────────────────────
  {year:2026,make:"Toyota",model:"C-HR",fuel:"BEV",incentive:5000},
  {year:2026,make:"Toyota",model:"Prius Plug-in Hybrid",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Toyota",model:"RAV4 Plug-In Hybrid",fuel:"PHEV",incentive:2500},
  {year:2026,make:"Toyota",model:"bZ",fuel:"BEV",incentive:5000},
  // ── Volkswagen ─────────────────────────────────────────────────────────────
  {year:2025,make:"Volkswagen",model:"ID.4",fuel:"BEV",incentive:5000},
  // ── Volvo ──────────────────────────────────────────────────────────────────
  {year:2026,make:"Volvo",model:"EX30",fuel:"BEV",incentive:5000},
];
function getEVAP(l){
  if(!l||!l.make||!l.model) return null;
  // Only NEW vehicles qualify (< 10,000 km)
  if((l.km||0) > 10000) return null;
  const lMake = l.make.toLowerCase();
  const lModel = l.model.toLowerCase();
  return EVAP_LIST.find(e=>{
    if(e.year !== l.year) return false;
    if(e.make.toLowerCase() !== lMake) return false;
    // Model matching: handle both directions, strip common suffixes
    const eModel = e.model.toLowerCase();
    return lModel.includes(eModel) || eModel.includes(lModel);
  }) || null;
}

const DEMO_LISTINGS=[
  {id:1,name:"2025 Toyota RAV4 Prime XSE",make:"Toyota",model:"RAV4 Prime",year:2025,price:49900,km:8000,fuel:"PHEV",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:2,name:"2025 Hyundai IONIQ 5 Preferred",make:"Hyundai",model:"IONIQ 5",year:2025,price:48500,km:5200,fuel:"BEV",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:3,name:"2026 Chevrolet Equinox EV LT",make:"Chevrolet",model:"Equinox EV",year:2026,price:47498,km:1200,fuel:"BEV",province:"AB",city:"Edmonton",source:"Kijiji",dealer:true},
  {id:4,name:"2022 Toyota Tundra Platinum",make:"Toyota",model:"Tundra",year:2022,price:47698,km:151041,fuel:"Hybrid",province:"AB",city:"Calgary",source:"Kijiji",dealer:false},
  {id:5,name:"2025 Kia EV6 Standard RWD",make:"Kia",model:"EV6",year:2025,price:44900,km:3100,fuel:"BEV",province:"BC",city:"Vancouver",source:"Kijiji",dealer:true},
  {id:6,name:"2024 Toyota RAV4 Prime XSE",make:"Toyota",model:"RAV4 Prime",year:2024,price:47500,km:18000,fuel:"PHEV",province:"BC",city:"Victoria",source:"Kijiji",dealer:false},
  {id:7,name:"2025 Ford Escape PHEV SE",make:"Ford",model:"Escape",year:2025,price:44999,km:9000,fuel:"PHEV",province:"ON",city:"Toronto",source:"Kijiji",dealer:true},
  {id:8,name:"2025 Hyundai IONIQ 6 Preferred",make:"Hyundai",model:"IONIQ 6",year:2025,price:47499,km:4100,fuel:"BEV",province:"ON",city:"Ottawa",source:"Kijiji",dealer:true},
  {id:9,name:"2025 Chevrolet Bolt EV LT",make:"Chevrolet",model:"Bolt EV",year:2025,price:38998,km:500,fuel:"BEV",province:"QC",city:"Montreal",source:"Kijiji",dealer:true},
  {id:10,name:"2025 VW ID.4 Pro AWD",make:"Volkswagen",model:"ID.4",year:2025,price:49500,km:2200,fuel:"BEV",province:"AB",city:"Calgary",source:"Kijiji",dealer:false},
  {id:11,name:"2024 Toyota Tacoma TRD Off-Road",make:"Toyota",model:"Tacoma",year:2024,price:55900,km:12300,fuel:"Gas",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:12,name:"2023 Toyota Camry XSE",make:"Toyota",model:"Camry",year:2023,price:38900,km:33000,fuel:"Gas",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:13,name:"2025 Kia Niro EV Wind",make:"Kia",model:"Niro EV",year:2025,price:39995,km:4500,fuel:"BEV",province:"NS",city:"Halifax",source:"Kijiji",dealer:true},
  {id:14,name:"2025 Mitsubishi Outlander PHEV",make:"Mitsubishi",model:"Outlander",year:2025,price:44998,km:6200,fuel:"PHEV",province:"QC",city:"Quebec City",source:"Kijiji",dealer:true},
];

// ── Hook: fetch live listings from Supabase, fallback to demo ─────────────────
function useListings(){
  const [listings, setListings]=useState(DEMO_LISTINGS);
  const [loading, setLoading]=useState(true);
  const [isLive, setIsLive]=useState(false);

  useEffect(()=>{
    async function fetchLive(){
      try{
        const {data, error}=await supabase
          .from("listings")
          .select(`
            id, external_id, name, make, model, year, price, km, fuel,
            province, city, source, dealer, listing_url, image_url,
            scraped_at, verification_score
          `)
          .eq("status", "published")
          .order("scraped_at", {ascending:false})
          .limit(500);

        if(error) throw error;

        if(data && data.length > 0){
          const normalized = data.map(r=>({
            ...r,
            province: r.province || "AB",
            city: r.city || "Canada",
            source: r.source || "Kijiji",
            dealer: Boolean(r.dealer),
          }));
          setListings(normalized);
          setIsLive(true);
          console.log(`🍁 LotCheck: ${normalized.length} live listings loaded`);
        } else {
          console.log("📋 No live listings yet — showing demo data");
        }
      } catch(err){
        console.warn("⚠️ Supabase fetch failed, using demo data:", err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchLive();
  },[]);

  return {listings, loading, isLive};
}

// ── Hook: fetch ALL real price_history in one batched call ────────────────
// Used for the detail chart, "days on LotCheck" stat, and price-drop badges
// on cards. One shared fetch instead of one query per listing — avoids N
// round trips and avoids IN-clause URL-length issues (external_id is often
// a full Kijiji URL). Grouped client-side by listing_external_id.
function usePriceHistoryMap(){
  const [historyMap, setHistoryMap] = useState({});
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(()=>{
    let cancelled = false;
    async function fetchAll(){
      try{
        const {data, error} = await supabase
          .from("price_history")
          .select("listing_external_id, price, recorded_at")
          .order("recorded_at", {ascending:true})
          .limit(20000);
        if(error) throw error;
        const map = {};
        (data||[]).forEach(row=>{
          const id = row.listing_external_id;
          if(!id) return;
          if(!map[id]) map[id] = [];
          map[id].push({price: row.price, recorded_at: row.recorded_at});
        });
        if(!cancelled) setHistoryMap(map);
      }catch(err){
        console.warn("⚠️ price_history fetch failed:", err.message);
        if(!cancelled) setHistoryMap({});
      }finally{
        if(!cancelled) setHistoryLoading(false);
      }
    }
    fetchAll();
    return()=>{cancelled=true;};
  },[]);

  return {historyMap, historyLoading};
}

// NOTE: previously there was a `genHistory()` function here that generated a
// fake 60-day price chart using Math.random(). It has been removed. Real price
// history now comes from the `price_history` table (populated daily by
// scraper.js) via a direct Supabase fetch inside DetailPanel, keyed on
// listing.external_id. Do not reintroduce synthetic/random data for anything
// presented to users as historical fact.

// lotScore now requires a real comparable set (liveListings) — it must never
// be called against DEMO_LISTINGS. Returns null (not a fabricated 50) when
// there isn't enough real data to compute a meaningful score.
function lotScore(l,all){
  if(!all||!all.length) return null;
  const c=all.filter(x=>x.model===l.model&&x.id!==l.id);
  if(!c.length)return null;
  const aP=c.reduce((s,x)=>s+x.price,0)/c.length;
  const aK=c.reduce((s,x)=>s+x.km,0)/c.length;
  return Math.max(0,Math.min(100,Math.round(50+((aP-l.price)/aP)*120+((aK-l.km)/aK)*40)));
}

// Same comparison this listing's score is built from, but exposes the price
// and mileage components separately so the badge can explain itself. A
// low score can come from high mileage even when the price itself is good
// (or vice versa) -- "Above Market" alone doesn't tell a buyer which one it
// was, and that's exactly backwards for someone deciding whether to walk
// away from a car that's actually well-priced.
function lotScoreBreakdown(l,all){
  if(!all||!all.length) return null;
  const c=all.filter(x=>x.model===l.model&&x.id!==l.id);
  if(!c.length) return null;
  const aP=c.reduce((s,x)=>s+x.price,0)/c.length;
  const aK=c.reduce((s,x)=>s+x.km,0)/c.length;
  return{
    compCount:c.length,
    compAvgPrice:Math.round(aP),
    compAvgKm:Math.round(aK),
    priceIsBetter:l.price<aP,
    kmIsBetter:l.km<aK,
    priceDiff:Math.round(Math.abs(aP-l.price)),
    kmDiff:Math.round(Math.abs(aK-l.km)),
  };
}

// ── Reusable info tooltip — small ⓘ icon that toggles a popover explaining
// where a number actually comes from. Used anywhere LotCheck shows a
// computed/estimated value, so the methodology is never hidden behind a
// bare number.
function InfoTooltip({title, children}){
  const [open, setOpen] = useState(false);
  return(
    <div style={{position:"relative", display:"inline-block"}}>
      <button
        onClick={()=>setOpen(v=>!v)}
        style={{background:"none",border:"1px solid #334155",borderRadius:"50%",width:20,height:20,cursor:"pointer",color:"#64748b",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,padding:0}}
        title={title}
      >ℹ</button>
      {open&&(
        <div style={{position:"absolute",right:0,top:26,zIndex:99,background:"#0d1526",border:"1px solid #1e3a5f",borderRadius:12,padding:"14px 16px",width:280,boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#3b82f6",marginBottom:8,letterSpacing:0.5}}>ℹ️ {title}</div>
          <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.65}}>{children}</div>
          <button onClick={()=>setOpen(false)} style={{marginTop:10,background:"none",border:"none",color:"#475569",fontSize:11,cursor:"pointer",padding:0}}>Close ✕</button>
        </div>
      )}
    </div>
  );
}

function ScorePill({score,breakdown}){
  if(score==null) return <span className="badge" style={{background:"#1e293b80",color:"#64748b",border:"1px solid #33415560"}}>No comps yet</span>;
  const c=score>=70?"#16a34a":score>=45?"#d97706":"#dc2626";
  const l=score>=70?"✓ Great Deal":score>=45?"~ Fair Price":"↑ Above Market";
  if(!breakdown){
    return<span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}35`}}>{l}</span>;
  }
  return(
    <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
      <span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}35`}}>{l}</span>
      <InfoTooltip title="HOW THIS SCORE IS BUILT">
        This weighs <strong style={{color:"#f1f5f9"}}>both price and mileage</strong> against {breakdown.compCount} similar live listing{breakdown.compCount===1?"":"s"} (avg ${breakdown.compAvgPrice.toLocaleString()}, {breakdown.compAvgKm.toLocaleString()} km) — not price alone. A car can show "{l}" even with a good price if its mileage is well above comps, or vice versa.
        <br/><br/>
        This listing: price is <strong style={{color:breakdown.priceIsBetter?"#22c55e":"#ef4444"}}>${breakdown.priceDiff.toLocaleString()} {breakdown.priceIsBetter?"below":"above"} average</strong>, mileage is <strong style={{color:breakdown.kmIsBetter?"#22c55e":"#ef4444"}}>{breakdown.kmDiff.toLocaleString()} km {breakdown.kmIsBetter?"below":"above"} average</strong>.
      </InfoTooltip>
    </span>
  );
}

function FuelIcon({fuel,size=14}){
  const s=size;
  if(fuel==="BEV") return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-charge 1.6s ease-in-out infinite",flexShrink:0}}>
      <rect x="2" y="6" width="18" height="13" rx="2" stroke="#22c55e" strokeWidth="2" fill="none"/>
      <path d="M20 10h2v5h-2" stroke="#22c55e" strokeWidth="2" strokeLinecap="round"/>
      <path d="M13 7l-5 6h5l-3 5" stroke="#22c55e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if(fuel==="PHEV") return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-charge 2s ease-in-out infinite",flexShrink:0}}>
      <path d="M7 2v4M11 2v4" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
      <path d="M5 6h8v5a4 4 0 01-8 0V6z" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 17v4" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
      <path d="M15 8h2a2 2 0 012 2v7a1 1 0 001 1h0a1 1 0 001-1V8" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round"/>
      <rect x="17" y="5" width="4" height="3" rx="1" stroke="#f59e0b" strokeWidth="1.8"/>
    </svg>
  );
  if(fuel==="Hybrid") return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-spin 4s linear infinite",flexShrink:0}}>
      <path d="M12 2a10 10 0 0110 10" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round"/>
      <path d="M22 12a10 10 0 01-10 10" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 22a10 10 0 01-10-10" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round"/>
      <path d="M2 12a10 10 0 0110-10" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3"/>
      <path d="M22 10l-1.5 2.5L18 11" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2 14l1.5-2.5L6 13" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-pump 2.2s ease-in-out infinite",flexShrink:0}}>
      <path d="M3 22V5a2 2 0 012-2h8a2 2 0 012 2v17H3z" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 9h12" stroke="#94a3b8" strokeWidth="2"/>
      <path d="M15 7l4-2 2 2v9a2 2 0 01-2 2h-1" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M17 13h2" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round"/>
      <rect x="6" y="13" width="5" height="4" rx="1" stroke="#94a3b8" strokeWidth="1.5"/>
    </svg>
  );
}

function FuelTag({fuel}){
  const c={BEV:"#22c55e",PHEV:"#f59e0b",Hybrid:"#8b5cf6",Gas:"#94a3b8"}[fuel]||"#94a3b8";
  return(
    <span className="badge" style={{background:c+"1a",color:c,border:`1px solid ${c}40`,display:"inline-flex",alignItems:"center",gap:5,fontWeight:700,paddingTop:3,paddingBottom:3}}>
      <FuelIcon fuel={fuel} size={13}/>
      {fuel}
    </span>
  );
}
function EVAPTag({evap}){
  if(!evap)return null;
  return<span className="badge" style={{background:"#16a34a18",color:"#22c55e",border:"1px solid #22c55e30"}}>⚡ ${evap.incentive.toLocaleString()}</span>;
}

function ConnectModal({listing,onClose}){
  const rebate=getRebate(listing.province,listing.fuel,listing);
  const [name,setName]=useState("");
  const [phone,setPhone]=useState("");
  const [email,setEmail]=useState("");
  const [wantsDelivery,setWantsDelivery]=useState(false);
  const [deliveryCity,setDeliveryCity]=useState("");
  const [step,setStep]=useState("form");
  const [err,setErr]=useState("");
  async function submit(){
    if(!name.trim())return setErr("Please enter your name.");
    if(!phone.trim()&&!email.trim())return setErr("Please enter phone or email.");
    if(wantsDelivery&&!deliveryCity.trim())return setErr("Please enter your delivery city.");
    setErr("");setStep("sending");
    try{
      const {error}=await supabase.from("leads").insert({
        lead_type:"connect",
        name, phone, email,
        details:{
          listing_external_id:listing.external_id||null,
          listing_name:listing.name,
          listing_price:listing.price,
          province:listing.province,
          wants_delivery:wantsDelivery,
          delivery_city:wantsDelivery?deliveryCity:null,
        },
      });
      if(error) throw error;
      setStep("done");
    }catch(err){
      console.error("Lead submit failed:",err.message);
      setErr("Something went wrong sending your request. Please try again.");
      setStep("form");
    }
  }
  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        {step==="done"?(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>LotChecked!</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:16,lineHeight:1.6}}>Request received — we'll follow up with you directly about this listing.</div>
            {rebate.total>0&&(
              <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:12,padding:"12px 16px",marginBottom:20,textAlign:"left"}}>
                <div style={{fontSize:13,color:"#22c55e",fontWeight:700,marginBottom:4}}>⚡ Remind the dealer about your rebate</div>
                <div style={{fontSize:13,color:"#475569"}}>Up to <strong style={{color:"#22c55e"}}>${rebate.total.toLocaleString()}</strong> available. After rebates: ~<strong style={{color:"#22c55e"}}>${(listing.price-rebate.total).toLocaleString()}</strong></div>
              </div>
            )}
            <button onClick={onClose} className="lc-modal-btn">Done</button>
          </div>
        ):(
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9"}}>Connect me with a dealer</div>
              <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:12,padding:"12px 14px",marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:6}}>{listing.name}</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",gap:6,alignItems:"center"}}><FuelTag fuel={listing.fuel}/><span style={{fontSize:13,color:"#64748b"}}>{listing.km.toLocaleString()} km</span></div>
                <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9"}}>${listing.price.toLocaleString()}</div>
              </div>
              {rebate.eligible&&rebate.total>0&&<div style={{fontSize:12,color:"#22c55e",fontWeight:600,marginTop:6}}>⚡ After rebates: ~${(listing.price-rebate.total).toLocaleString()}</div>}
            </div>
            <div onClick={()=>setWantsDelivery(!wantsDelivery)} style={{display:"flex",alignItems:"center",gap:10,background:wantsDelivery?"#0d1e3a":"#0f172a",border:`1px solid ${wantsDelivery?"#1e3a5f":"#1e293b"}`,borderRadius:10,padding:"12px 14px",marginBottom:14,cursor:"pointer"}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${wantsDelivery?"#3b82f6":"#475569"}`,background:wantsDelivery?"#3b82f6":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s"}}>
                {wantsDelivery&&<span style={{color:"#fff",fontSize:12,fontWeight:900}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>🚚 I'd like this delivered to me</div>
                <div style={{fontSize:11,color:"#475569"}}>Ask the dealer about delivery — not all dealers offer this</div>
              </div>
            </div>
            {wantsDelivery&&(
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,color:"#94a3b8",display:"block",marginBottom:4}}>Delivery city *</label>
                <input type="text" placeholder="e.g. Edmonton, AB" value={deliveryCity} onChange={e=>setDeliveryCity(e.target.value)} className="lc-modal-input"/>
              </div>
            )}
            {[["Full name *","text","Jane Smith",name,setName],["Phone","tel","403-555-0100",phone,setPhone],["Email","email","jane@email.com",email,setEmail]].map(([l,t,ph,v,s])=>(
              <div key={l}>
                <label style={{fontSize:13,color:"#94a3b8",display:"block",marginBottom:4}}>{l}</label>
                <input type={t} placeholder={ph} value={v} onChange={e=>s(e.target.value)} className="lc-modal-input"/>
              </div>
            ))}
            {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:12}}>{err}</div>}
            <div style={{fontSize:12,color:"#334155",marginBottom:14}}>Your info is shared with the dealer only. LotCheck never sells your data.</div>
            <button onClick={submit} disabled={step==="sending"} className="lc-modal-btn" style={{background:step==="sending"?"#1e3a5f":"#16a34a"}}>
              {step==="sending"?"Sending…":"Connect me →"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const TEST_DRIVE_DAYS=["Today","Tomorrow","This weekend","Next week","Flexible"];
const TEST_DRIVE_TIMES=["Morning","Afternoon","Evening","Anytime"];

function TestDriveModal({listing,onClose}){
  const [name,setName]=useState("");
  const [phone,setPhone]=useState("");
  const [email,setEmail]=useState("");
  const [day,setDay]=useState("This weekend");
  const [time,setTime]=useState("Anytime");
  const [licenseConfirm,setLicenseConfirm]=useState(false);
  const [step,setStep]=useState("form");
  const [err,setErr]=useState("");

  async function submit(){
    if(!name.trim())return setErr("Please enter your name.");
    if(!phone.trim()&&!email.trim())return setErr("Please enter phone or email.");
    if(!licenseConfirm)return setErr("Please confirm you have a valid driver's license.");
    setErr("");setStep("sending");
    try{
      const {error}=await supabase.from("leads").insert({
        lead_type:"test_drive",
        name, phone, email,
        details:{
          listing_external_id:listing.external_id||null,
          listing_name:listing.name,
          listing_price:listing.price,
          province:listing.province,
          preferred_day:day,
          preferred_time:time,
          license_confirmed:licenseConfirm,
        },
      });
      if(error) throw error;
      setStep("done");
    }catch(err){
      console.error("Lead submit failed:",err.message);
      setErr("Something went wrong sending your request. Please try again.");
      setStep("form");
    }
  }

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        {step==="done"?(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🚗</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>Test drive requested!</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:16,lineHeight:1.6}}>Request received — we'll follow up with you directly to confirm a time.</div>
            <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:12,padding:"12px 16px",marginBottom:20,textAlign:"left"}}>
              <div style={{fontSize:13,color:"#60a5fa",fontWeight:700,marginBottom:6}}>🗓️ Your preference</div>
              <div style={{fontSize:13,color:"#94a3b8"}}>{day} · {time}</div>
            </div>
            <button onClick={onClose} className="lc-modal-btn">Done</button>
          </div>
        ):(
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9"}}>🚗 Book a test drive</div>
              <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:12,padding:"12px 14px",marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:6}}>{listing.name}</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",gap:6,alignItems:"center"}}><FuelTag fuel={listing.fuel}/><span style={{fontSize:13,color:"#64748b"}}>{listing.km.toLocaleString()} km</span></div>
                <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9"}}>${listing.price.toLocaleString()}</div>
              </div>
            </div>
            <label style={{fontSize:13,color:"#94a3b8",display:"block",marginBottom:6}}>When works for you?</label>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
              {TEST_DRIVE_DAYS.map(d=>(
                <button key={d} onClick={()=>setDay(d)} style={{padding:"8px 14px",background:day===d?"#16a34a":"transparent",border:`1px solid ${day===d?"#16a34a":"#334155"}`,borderRadius:20,color:day===d?"#fff":"#94a3b8",cursor:"pointer",fontSize:12,fontWeight:600}}>
                  {d}
                </button>
              ))}
            </div>
            <label style={{fontSize:13,color:"#94a3b8",display:"block",marginBottom:6}}>What time of day?</label>
            <div style={{display:"flex",gap:6,marginBottom:18}}>
              {TEST_DRIVE_TIMES.map(t=>(
                <button key={t} onClick={()=>setTime(t)} style={{flex:1,padding:"9px 0",background:time===t?"#16a34a":"transparent",border:`1px solid ${time===t?"#16a34a":"#334155"}`,borderRadius:8,color:time===t?"#fff":"#94a3b8",cursor:"pointer",fontSize:12,fontWeight:600}}>
                  {t}
                </button>
              ))}
            </div>
            {[["Full name *","text","Jane Smith",name,setName],["Phone","tel","403-555-0100",phone,setPhone],["Email","email","jane@email.com",email,setEmail]].map(([l,t,ph,v,s])=>(
              <div key={l}>
                <label style={{fontSize:13,color:"#94a3b8",display:"block",marginBottom:4}}>{l}</label>
                <input type={t} placeholder={ph} value={v} onChange={e=>s(e.target.value)} className="lc-modal-input"/>
              </div>
            ))}
            <div onClick={()=>setLicenseConfirm(!licenseConfirm)} style={{display:"flex",alignItems:"center",gap:10,background:licenseConfirm?"#0d2010":"#0f172a",border:`1px solid ${licenseConfirm?"#16a34a40":"#1e293b"}`,borderRadius:10,padding:"12px 14px",marginBottom:14,cursor:"pointer"}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${licenseConfirm?"#16a34a":"#475569"}`,background:licenseConfirm?"#16a34a":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s"}}>
                {licenseConfirm&&<span style={{color:"#fff",fontSize:12,fontWeight:900}}>✓</span>}
              </div>
              <div style={{fontSize:13,color:"#94a3b8"}}>I confirm I have a valid driver's license</div>
            </div>
            {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:12}}>{err}</div>}
            <div style={{fontSize:12,color:"#334155",marginBottom:14}}>Your info and license confirmation are shared with the dealer only.</div>
            <button onClick={submit} disabled={step==="sending"} className="lc-modal-btn" style={{background:step==="sending"?"#1e3a5f":"#16a34a"}}>
              {step==="sending"?"Sending…":"Request test drive →"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const MAKES=["Toyota","Hyundai","Kia","Chevrolet","Ford","Volkswagen","Mitsubishi"];

function estimateAppraisal(make,model,year,km,condition){
  const baseByAge={2026:42000,2025:38000,2024:34000,2023:30000,2022:26000,2021:22000,2020:18000,2019:15000};
  let base=baseByAge[year]||Math.max(8000,42000-(2026-year)*4000);
  const kmFactor=Math.max(0.55,1-(km/250000)*0.45);
  const condFactor={Excellent:1.08,Good:1.0,Fair:0.88,Poor:0.7}[condition]||1.0;
  const estimate=Math.round(base*kmFactor*condFactor/100)*100;
  return{low:Math.round(estimate*0.9/100)*100,mid:estimate,high:Math.round(estimate*1.1/100)*100};
}

function AppraisalModal({onClose}){
  const [step,setStep]=useState("form");
  const [make,setMake]=useState("Toyota");
  const [model,setModel]=useState("");
  const [year,setYear]=useState(2022);
  const [km,setKm]=useState("");
  const [condition,setCondition]=useState("Good");
  const [name,setName]=useState("");
  const [phone,setPhone]=useState("");
  const [email,setEmail]=useState("");
  const [wantsPickup,setWantsPickup]=useState(false);
  const [pickupAddress,setPickupAddress]=useState("");
  const [vin,setVin]=useState("");
  const [err,setErr]=useState("");

  const estimate=step!=="form"?estimateAppraisal(make,model,Number(year),Number(km)||50000,condition):null;

  function handleGetEstimate(){
    if(!model.trim()){setErr("Please enter your car's model.");return;}
    if(!km||Number(km)<=0){setErr("Please enter your odometer reading.");return;}
    setErr("");setStep("result");
  }

  async function handleSubmitToDealer(){
    if(!name.trim()){setErr("Please enter your name.");return;}
    if(!phone.trim()&&!email.trim()){setErr("Please enter phone or email.");return;}
    if(wantsPickup&&!pickupAddress.trim()){setErr("Please enter your pickup address.");return;}
    setErr("");setStep("sending");
    try{
      const {error}=await supabase.from("leads").insert({
        lead_type:"appraisal",
        name, phone, email,
        details:{
          make, model, year:Number(year), km:Number(km)||null, condition,
          vin:vin||null,
          estimate_low:estimate?.low||null,
          estimate_mid:estimate?.mid||null,
          estimate_high:estimate?.high||null,
          wants_pickup:wantsPickup,
          pickup_address:wantsPickup?pickupAddress:null,
        },
      });
      if(error) throw error;
      setStep("done");
    }catch(err){
      console.error("Lead submit failed:",err.message);
      setErr("Something went wrong sending your request. Please try again.");
      setStep("dealer");
    }
  }

  const inp={width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"12px 14px",color:"#f1f5f9",fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",marginBottom:10};

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal" style={{maxWidth:460}}>
        {step==="form"&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9"}}>💰 What's your car worth?</div>
            <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>Free instant estimate · No obligation · Takes 30 seconds</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}>
            <div>
              <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Make</label>
              <select value={make} onChange={e=>setMake(e.target.value)} style={{...inp,appearance:"auto"}}>
                {MAKES.map(m=><option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Year</label>
              <select value={year} onChange={e=>setYear(e.target.value)} style={{...inp,appearance:"auto"}}>
                {[2026,2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015].map(y=><option key={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Model</label>
          <input type="text" placeholder="e.g. RAV4, Tacoma, Camry" value={model} onChange={e=>setModel(e.target.value)} style={inp}/>
          <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Odometer (km)</label>
          <input type="number" placeholder="e.g. 65000" value={km} onChange={e=>setKm(e.target.value)} style={inp}/>
          <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>
            VIN <span style={{color:"#334155",fontWeight:400,fontSize:11}}>(optional)</span>
          </label>
          <input type="text" placeholder="e.g. 2T3BFREV1JW123456" value={vin} onChange={e=>setVin(e.target.value.toUpperCase())} style={{...inp,fontFamily:"monospace",letterSpacing:"0.5px"}} maxLength={17}/>
          <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Condition</label>
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            {["Excellent","Good","Fair","Poor"].map(c=>(
              <button key={c} onClick={()=>setCondition(c)}
                style={{flex:1,padding:"10px 0",background:condition===c?"#16a34a":"transparent",border:`1px solid ${condition===c?"#16a34a":"#334155"}`,borderRadius:8,color:condition===c?"#fff":"#94a3b8",cursor:"pointer",fontSize:12,fontWeight:600}}>
                {c}
              </button>
            ))}
          </div>
          {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:12}}>{err}</div>}
          <button onClick={handleGetEstimate} className="lc-modal-btn">Get my free estimate →</button>
        </>}

        {step==="result"&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>Your estimated value</div>
            <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
          <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:14,padding:"18px",marginBottom:16,textAlign:"center"}}>
            <div style={{fontSize:11,color:"#475569",marginBottom:6}}>ESTIMATED TRADE-IN VALUE</div>
            <div style={{fontSize:32,fontWeight:800,color:"#22c55e",marginBottom:4}}>${estimate.mid.toLocaleString()}</div>
            <div style={{fontSize:12,color:"#64748b"}}>Range: ${estimate.low.toLocaleString()} – ${estimate.high.toLocaleString()}</div>
          </div>
          <button onClick={()=>setStep("dealer")} className="lc-modal-btn">Get a real offer from a dealer →</button>
          <button onClick={()=>setStep("form")} style={{width:"100%",background:"transparent",border:"none",color:"#475569",fontSize:12,cursor:"pointer",marginTop:10,textAlign:"center"}}>← Edit my car details</button>
        </>}

        {(step==="dealer"||step==="sending")&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>Get your real offer</div>
            <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:13,color:"#94a3b8"}}>Estimated value</span>
            <span style={{fontSize:15,fontWeight:700,color:"#22c55e"}}>${estimate.mid.toLocaleString()}</span>
          </div>
          {[["Full name *","text","Jane Smith",name,setName],["Phone","tel","403-555-0100",phone,setPhone],["Email","email","jane@email.com",email,setEmail]].map(([l,t,ph,v,s])=>(
            <div key={l}>
              <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>{l}</label>
              <input type={t} placeholder={ph} value={v} onChange={e=>s(e.target.value)} style={inp}/>
            </div>
          ))}
          {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:12}}>{err}</div>}
          <button onClick={handleSubmitToDealer} disabled={step==="sending"} className="lc-modal-btn" style={{background:step==="sending"?"#1e3a5f":"#16a34a"}}>
            {step==="sending"?"Sending…":"Submit to dealer →"}
          </button>
        </>}

        {step==="done"&&(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:10}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>Request received!</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:16,lineHeight:1.6}}>We'll follow up with you directly about your {year} {make} {model}.</div>
            <button onClick={onClose} className="lc-modal-btn">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Depreciation planning calculator (free) ─────────────────────────────────
// Different question from Value Estimate: not "what is this used listing
// worth right now" but "if I buy something for $X new, what will it
// realistically be worth over time." Declining balance is the real-world
// depreciation model (steep early loss, slower after) vs straight-line
// (even loss every year) — shown side by side so the shape difference is
// visible, not just the end number. Free — this is educational math, not
// proprietary data, and it answers something AutoTrader's own valuation
// tool doesn't: theirs only prices a car you already own, not a forward
// plan for one you're considering buying new.
// Verified against Bank of Canada's Valet API (free, public, no auth) —
// CPI-trim, their preferred core inflation measure, was 2.0% as of the most
// recent published figure (May 2026). Used as the default assumption here,
// adjustable, since nobody can know FUTURE inflation with certainty — this
// is a real historical anchor, not a promise.
const BOC_CORE_INFLATION_DEFAULT = 2.0;
const BOC_INFLATION_AS_OF = "May 2026";

function DepreciationModal({onClose}){
  const [cost,setCost]=useState(40000);
  const [years,setYears]=useState(7);
  const [firstRate,setFirstRate]=useState(20);
  const [rate,setRate]=useState(15);
  const [inflation,setInflation]=useState(BOC_CORE_INFLATION_DEFAULT);

  const declining=[cost];
  let val=cost;
  for(let y=1;y<=years;y++){
    const r=(y===1?firstRate:rate)/100;
    val=val*(1-r);
    declining.push(Math.round(val));
  }
  const endDeclining=declining[declining.length-1];
  const totalLoss=cost-endDeclining;
  const annualLoss=totalLoss/years;
  const straight=[cost];
  for(let y=1;y<=years;y++){
    straight.push(Math.max(0,Math.round(cost-annualLoss*y)));
  }
  // Real (inflation-adjusted) value — what the future nominal dollar amount
  // is actually worth in TODAY'S purchasing power, deflated using the
  // inflation rate above.
  const real=declining.map((v,i)=>Math.round(v/Math.pow(1+inflation/100,i)));
  const chartData=declining.map((v,i)=>({year:i,declining:v,straight:straight[i],real:real[i]}));

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal" style={{maxWidth:520}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9"}}>📉 Depreciation planner</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>Model what a purchase is really worth over time — not a specific listing, just the math.</div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          <div>
            <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Initial cost</label>
            <input type="number" value={cost} onChange={e=>setCost(Math.max(0,Number(e.target.value)||0))}
              style={{width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:14,boxSizing:"border-box",outline:"none"}}/>
          </div>
          <div>
            <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Years of ownership: {years}</label>
            <input type="range" min="1" max="15" value={years} onChange={e=>setYears(Number(e.target.value))} style={{width:"100%"}}/>
          </div>
          <div>
            <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Year 1 drop: {firstRate}%</label>
            <input type="range" min="5" max="40" value={firstRate} onChange={e=>setFirstRate(Number(e.target.value))} style={{width:"100%"}}/>
          </div>
          <div>
            <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Each year after: {rate}%</label>
            <input type="range" min="5" max="30" value={rate} onChange={e=>setRate(Number(e.target.value))} style={{width:"100%"}}/>
          </div>
        </div>

        <div style={{marginBottom:16}}>
          <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Assumed inflation: {inflation.toFixed(1)}%</label>
          <input type="range" min="0" max="8" step="0.1" value={inflation} onChange={e=>setInflation(Number(e.target.value))} style={{width:"100%"}}/>
          <div style={{fontSize:10,color:"#334155",marginTop:2}}>Bank of Canada core inflation (CPI-trim) was {BOC_CORE_INFLATION_DEFAULT}% as of {BOC_INFLATION_AS_OF} — real published data, used as a starting assumption. Future inflation isn't knowable, so this stays adjustable.</div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontSize:10,color:"#475569",marginBottom:4}}>Declining balance</div>
            <div style={{fontSize:16,fontWeight:800,color:"#22c55e"}}>${endDeclining.toLocaleString()}</div>
          </div>
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontSize:10,color:"#475569",marginBottom:4}}>Straight-line</div>
            <div style={{fontSize:16,fontWeight:800,color:"#94a3b8"}}>${straight[straight.length-1].toLocaleString()}</div>
          </div>
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontSize:10,color:"#475569",marginBottom:4}}>Real (today's $)</div>
            <div style={{fontSize:16,fontWeight:800,color:"#f59e0b"}}>${real[real.length-1].toLocaleString()}</div>
          </div>
        </div>

        <div style={{height:180,marginBottom:8}}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{top:4,right:4,bottom:0,left:0}}>
              <XAxis dataKey="year" tick={{fontSize:11,fill:"#94a3b8"}} tickLine={false} axisLine={false} label={{value:"Year",position:"insideBottom",offset:-2,fontSize:10,fill:"#475569"}}/>
              <YAxis tick={{fontSize:11,fill:"#94a3b8"}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={42}/>
              <Tooltip formatter={(v,name)=>[`$${v.toLocaleString()}`,name==="declining"?"Declining balance":name==="straight"?"Straight-line":"Real (today's $)"]} contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:13,fontWeight:600,color:"#f1f5f9"}} labelStyle={{color:"#94a3b8",fontSize:11}}/>
              <Line type="monotone" dataKey="declining" stroke="#16a34a" strokeWidth={2} dot={false}/>
              <Line type="monotone" dataKey="straight" stroke="#64748b" strokeWidth={2} strokeDasharray="4 3" dot={false}/>
              <Line type="monotone" dataKey="real" stroke="#f59e0b" strokeWidth={2} strokeDasharray="2 2" dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{display:"flex",gap:14,fontSize:11,color:"#64748b",marginBottom:4,flexWrap:"wrap"}}>
          <span><span style={{display:"inline-block",width:10,height:2,background:"#16a34a",marginRight:6,verticalAlign:"middle"}}/>Declining balance</span>
          <span><span style={{display:"inline-block",width:10,height:2,background:"#64748b",marginRight:6,verticalAlign:"middle"}}/>Straight-line</span>
          <span><span style={{display:"inline-block",width:10,height:2,background:"#f59e0b",marginRight:6,verticalAlign:"middle"}}/>Real (inflation-adjusted)</span>
        </div>
      </div>
    </div>
  );
}

function ProModal({onStart,onClose,trialStatus}){
  const status = trialStatus?.state || "none";
  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:11,fontWeight:700,color:"#16a34a",letterSpacing:1}}>LOTCHECK PRO · 48-HOUR FREE TRIAL</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:20,fontWeight:800,color:"#f1f5f9",marginBottom:4,letterSpacing:"-0.5px"}}>Built for car professionals</div>
        <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>No credit card. Full access for 48 hours, once per browser. Then $9.99/mo CAD.</div>
        {[["📊","LotCheck Value Estimate","Our own retail/trade/wholesale estimate on every listing"],["🗓️","Market Intelligence","New arrivals by province, price-drop badges, and days-on-market — all real data, all in one place"],].map(([icon,title,sub])=>(
          <div key={title} style={{display:"flex",gap:12,background:"#1e293b20",borderRadius:10,padding:"12px",marginBottom:8}}>
            <span style={{fontSize:20}}>{icon}</span>
            <div><div style={{fontSize:14,fontWeight:600,color:"#e2e8f0"}}>{title}</div><div style={{fontSize:12,color:"#475569"}}>{sub}</div></div>
          </div>
        ))}
        {status==="expired"?(
          <>
            <div style={{background:"#1a0a00",border:"1px solid #f59e0b40",borderRadius:10,padding:"12px 14px",marginTop:8,fontSize:13,color:"#f59e0b"}}>
              Your 48-hour trial has already been used on this browser. Paid Pro subscriptions are launching soon.
            </div>
          </>
        ):(
          <button onClick={()=>{onStart();onClose();}} className="lc-modal-btn" style={{marginTop:8}}>Start 48-hour free trial →</button>
        )}
        <div style={{textAlign:"center",marginTop:8,fontSize:12,color:"#334155"}}>Cancel anytime · No card needed</div>
      </div>
    </div>
  );
}

// ── New Arrivals Tracker (Pro) ──────────────────────────────────────────────
// Replaces the old "Alberta Allocations — incoming inventory before it hits
// the lot" bullet, which had zero code behind it. Real manufacturer/dealer
// allocation data is private industry data (OEM-to-dealer allotments) that
// LotCheck has no access to and cannot honestly claim to show.
// What this DOES show, honestly: real listings, grouped by province, where
// the earliest price_history record we have is within the last 7 days —
// i.e. vehicles LotCheck first observed recently. This is a first-seen
// signal from our own scrape data, not a prediction and not OEM allocation
// data. Labeled as such throughout.
function ArrivalsModal({liveListings, historyMap, onClose}){
  const now = Date.now();
  const WINDOW_DAYS = 7;
  const arrivals = (liveListings||[]).filter(l=>{
    const h = historyMap[l.external_id];
    if(!h || !h.length) return false;
    const firstSeen = new Date(h[0].recorded_at).getTime();
    return (now - firstSeen) <= WINDOW_DAYS*86400000;
  });

  const byProvince = {};
  arrivals.forEach(l=>{
    const p = l.province || "Other";
    byProvince[p] = (byProvince[p]||0)+1;
  });
  const chartData = Object.keys(PROVINCES)
    .map(code=>({province:code, count:byProvince[code]||0}))
    .filter(d=>d.count>0)
    .sort((a,b)=>b.count-a.count);

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal" style={{maxWidth:480}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:11,fontWeight:700,color:"#16a34a",letterSpacing:1}}>NEW ARRIVALS TRACKER · PRO</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",marginBottom:16}}>{arrivals.length} new listing{arrivals.length===1?"":"s"} in the last {WINDOW_DAYS} days</div>

        {chartData.length===0?(
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"24px",textAlign:"center",color:"#475569"}}>
            No new arrivals recorded in the last {WINDOW_DAYS} days yet. This builds up with each daily update.
          </div>
        ):(
          <div style={{height:Math.max(140,chartData.length*34),marginBottom:8}}>
            <ResponsiveContainer>
              <BarChart data={chartData} layout="vertical" margin={{top:0,right:16,bottom:0,left:0}}>
                <XAxis type="number" allowDecimals={false} tick={{fontSize:11,fill:"#94a3b8"}} tickLine={false} axisLine={false}/>
                <YAxis type="category" dataKey="province" width={36} tick={{fontSize:12,fill:"#e2e8f0",fontWeight:700}} tickLine={false} axisLine={false}/>
                <Tooltip formatter={v=>[`${v} listing${v===1?"":"s"}`,"New arrivals"]} contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:13,fontWeight:600,color:"#f1f5f9"}} labelStyle={{color:"#94a3b8",fontSize:11}}/>
                <Bar dataKey="count" fill="#16a34a" radius={[0,4,4,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{fontSize:10,color:"#334155",marginTop:8}}>Window: last {WINDOW_DAYS} days · updates daily</div>
      </div>
    </div>
  );
}

function UnlockModal({feature, price, onUnlock, onClose, onUpgrade}){
  const [step,setStep]=useState("offer");
  const labels={
    vin:{title:"Unlock VIN Lookup",icon:"🔍",desc:"Unlocks a direct link to CARFAX's official report page for this VIN. The CARFAX report itself is a separate ~$45 purchase with CARFAX."},
    cbb:{title:"Unlock Value Estimate",icon:"📊",desc:"LotCheck's retail, trade-in, and wholesale estimate for this exact vehicle, based on asking price, mileage, and age."},
  };
  const info=labels[feature]||labels.vin;

  async function pay(){
    setStep("paying");
    await new Promise(r=>setTimeout(r,1300));
    setStep("done");
  }

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal" style={{maxWidth:420}}>
        {step==="done"?(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:48,marginBottom:10}}>✅</div>
            <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9",marginBottom:6}}>Unlocked!</div>
            <button onClick={()=>{onUnlock();onClose();}} className="lc-modal-btn">Continue →</button>
          </div>
        ):(
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>{info.icon} {info.title}</div>
              <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
            </div>
            <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.6,marginBottom:18}}>{info.desc}</div>
            <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:12,padding:"16px",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                <span style={{fontSize:13,color:"#94a3b8"}}>One-time unlock</span>
                <span style={{fontSize:24,fontWeight:800,color:"#f1f5f9"}}>${price.toFixed(2)}</span>
              </div>
              <div style={{fontSize:11,color:"#475569"}}>No subscription · No account needed · Instant access</div>
            </div>
            <button onClick={pay} disabled={step==="paying"} className="lc-modal-btn" style={{marginBottom:10,background:step==="paying"?"#1e3a5f":"#16a34a"}}>
              {step==="paying"?"Processing…":`Pay $${price.toFixed(2)} & unlock →`}
            </button>
            <div style={{textAlign:"center",fontSize:11,color:"#334155",marginBottom:14}}>— or —</div>
            <button onClick={()=>{onUpgrade();onClose();}} style={{width:"100%",background:"transparent",border:"1px solid #1e3a5f",borderRadius:12,padding:"13px 0",color:"#60a5fa",fontSize:13,fontWeight:600,cursor:"pointer"}}>
              ✦ Get unlimited with Pro — 48h free
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function VINHistoryPanel({listing}){
  const [vin,setVin]=useState("");
  const [error,setError]=useState("");

  function validateVIN(v){
    const clean=v.toUpperCase().replace(/\s/g,"");
    if(clean.length!==17)return "VIN must be 17 characters";
    if(/[IOQ]/.test(clean))return "VIN cannot contain letters I, O, or Q";
    if(!/^[A-Z0-9]+$/.test(clean))return "VIN can only contain letters and numbers";
    return "";
  }

  function handleCheck(){
    const err=validateVIN(vin);
    if(err){setError(err);return;}
    setError("");
    window.open(`https://www.carfax.ca/vehicle-history-report?vin=${vin.toUpperCase()}&utm_source=lotcheck`,"_blank");
  }

  return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1,marginBottom:4}}>VEHICLE HISTORY REPORT · CARFAX</div>
      <div style={{fontSize:11,color:"#475569",marginBottom:14,lineHeight:1.5}}>This unlocks a direct link to CARFAX's official report page for this VIN. The CARFAX report itself is a separate purchase (~$45 CAD) made directly with CARFAX — not included in the LotCheck unlock.</div>
      <input type="text" placeholder="e.g. 1HGCM82633A123456" value={vin}
        onChange={e=>{setVin(e.target.value.toUpperCase());setError("");}} maxLength={17}
        style={{width:"100%",background:"#1e293b",border:`1px solid ${error?"#7f1d1d":"#334155"}`,borderRadius:10,padding:"12px 14px",color:"#f1f5f9",fontSize:15,fontFamily:"monospace",letterSpacing:1,outline:"none",boxSizing:"border-box",marginBottom:6}}/>
      <div style={{fontSize:11,color:error?"#ef4444":"#334155",marginBottom:14}}>
        {error||`${vin.length}/17 characters`}
      </div>
      <button onClick={handleCheck} disabled={vin.length!==17}
        style={{width:"100%",background:vin.length===17?"#16a34a":"#1e3a5f",border:"none",borderRadius:12,padding:"14px 0",color:"#fff",fontSize:15,fontWeight:700,cursor:vin.length===17?"pointer":"not-allowed"}}>
        🔍 Check Vehicle History →
      </button>
    </div>
  );
}

function InsurancePanel({listing}){
  const kanetixUrl=`https://www.kanetix.ca/auto-insurance-quotes?utm_source=lotcheck&vehicle=${encodeURIComponent(listing.name)}`;
  const estMonthly=Math.round((listing.price*0.025)/12/10)*10;
  return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#f59e0b",letterSpacing:1,marginBottom:10}}>INSURANCE ESTIMATE · KANETIX</div>
      <div style={{background:"#1a1200",border:"1px solid #f59e0b30",borderRadius:10,padding:"14px",marginBottom:14}}>
        <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>~${estMonthly}<span style={{fontSize:14,color:"#64748b"}}>/mo</span></div>
        <div style={{fontSize:11,color:"#475569",marginTop:4}}>Estimate only — actual rate varies</div>
      </div>
      <a href={kanetixUrl} target="_blank" rel="noreferrer"
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,width:"100%",background:"#f59e0b",border:"none",borderRadius:12,padding:"14px 0",color:"#020617",fontSize:15,fontWeight:700,textDecoration:"none",boxSizing:"border-box"}}>
        🛡️ Compare Insurance Quotes →
      </a>
    </div>
  );
}

function EVAPRebateTab({listing, rebate}){
  const [timeLeft, setTimeLeft] = useState({});

  useEffect(()=>{
    const calc=()=>{
      const now=new Date();
      const drop=new Date("2027-01-01T00:00:00");
      const diff=drop-now;
      if(diff<=0){setTimeLeft({expired:true});return;}
      const d=Math.floor(diff/(1000*60*60*24));
      const h=Math.floor((diff%(1000*60*60*24))/(1000*60*60));
      const m=Math.floor((diff%(1000*60*60))/(1000*60));
      const s=Math.floor((diff%60000)/1000);
      setTimeLeft({d,h,m,s});
    };
    calc();
    const t=setInterval(calc,1000);
    return()=>clearInterval(t);
  },[]);

  const schedule=[
    {year:"2026",bev:5000,phev:2500,active:true,label:"NOW"},
    {year:"2027",bev:4000,phev:2000,active:false,label:"Jan 1, 2027"},
    {year:"2028–29",bev:3000,phev:1500,active:false,label:"Jan 1, 2028"},
    {year:"2030",bev:2000,phev:1000,active:false,label:"Jan 1, 2030"},
  ];

  const progStart=new Date("2026-02-16");
  const progEnd=new Date("2031-03-31");
  const now=new Date();
  const pct=Math.min(100,Math.max(0,((now-progStart)/(progEnd-progStart))*100));
  const daysLeft=Math.max(0,Math.floor((progEnd-now)/(1000*60*60*24)));
  const isEV=listing.fuel==="BEV"||listing.fuel==="PHEV";

  if(!isEV) return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:20,textAlign:"center"}}>
      <div style={{fontSize:28,marginBottom:8}}>⛽</div>
      <div style={{color:"#94a3b8",fontWeight:600,marginBottom:4}}>No federal rebates for gas vehicles</div>
      <div style={{fontSize:12,color:"#475569"}}>EVAP applies to BEV and PHEV new purchases only.</div>
    </div>
  );

  if(!rebate.eligible) return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{background:"#1a0a00",border:"1px solid #f59e0b40",borderRadius:14,padding:"16px 18px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <span style={{fontSize:20}}>⚠️</span>
          <div style={{fontSize:14,fontWeight:700,color:"#f59e0b"}}>Not eligible for EVAP rebate</div>
        </div>
        <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.7,marginBottom:12}}>{rebate.ineligibleReason}</div>
        {rebate.newEquivalent&&(
          <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#22c55e",marginBottom:8}}>💡 BUYING NEW INSTEAD?</div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Federal EVAP (new)</span>
              <span style={{fontSize:14,fontWeight:700,color:"#22c55e"}}>${rebate.newEquivalent.federal.toLocaleString()}</span>
            </div>
            <div style={{borderTop:"1px solid #16a34a20",paddingTop:8,marginTop:4,display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Total if buying new</span>
              <span style={{fontSize:16,fontWeight:800,color:"#22c55e"}}>${rebate.newEquivalent.total.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#22c55e"}}>⚡ Federal EVAP Rebates · {PROVINCES[listing.province]||listing.province}</div>
        <InfoTooltip title="WHERE THIS COMES FROM">
          Federal and provincial EV rebate amounts are sourced directly from <strong style={{color:"#f1f5f9"}}>Transport Canada</strong> (tc.canada.ca) and manually verified against their official eligible-vehicle list.
          <br/><br/>
          Eligibility requires the vehicle be <strong style={{color:"#f1f5f9"}}>new</strong> (under 10,000 km), priced under $50,000, and on Transport Canada's current model list — LotCheck checks all three before showing a rebate.
          <br/><br/>
          This is not financial advice — confirm current eligibility with your dealer before purchase, as program rules can change.
        </InfoTooltip>
      </div>
      {rebate.total>0&&(
        <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:12,padding:"14px 16px"}}>
          {rebate.federal>0&&(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div><div style={{fontSize:14,color:"#e2e8f0",fontWeight:600}}>Federal EVAP</div></div>
              <div style={{fontSize:18,fontWeight:700,color:"#22c55e"}}>${rebate.federal.toLocaleString()}</div>
            </div>
          )}
          <div style={{borderTop:"1px solid #16a34a20",paddingTop:10,marginTop:4,display:"flex",justifyContent:"space-between"}}>
            <div style={{fontSize:13,color:"#94a3b8"}}>Total stacked</div>
            <div style={{fontSize:20,fontWeight:800,color:"#22c55e"}}>${rebate.total.toLocaleString()}</div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
            <div style={{fontSize:13,color:"#94a3b8"}}>After all rebates</div>
            <div style={{fontSize:20,fontWeight:800,color:"#f1f5f9"}}>${(listing.price-rebate.total).toLocaleString()}</div>
          </div>
        </div>
      )}

      <div style={{background:"#0d1526",border:"1px solid #f59e0b30",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#f59e0b",letterSpacing:0.8,marginBottom:8}}>⏳ REBATE DROPS JAN 1, 2027</div>
        {!timeLeft.expired&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
            {[["DAYS",timeLeft.d],["HRS",timeLeft.h],["MIN",timeLeft.m],["SEC",timeLeft.s]].map(([label,val])=>(
              <div key={label} style={{background:"#0a0f1e",borderRadius:8,padding:"8px 4px",textAlign:"center",border:"1px solid #1e293b"}}>
                <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9",fontVariantNumeric:"tabular-nums"}}>
                  {String(val??0).padStart(2,"0")}
                </div>
                <div style={{fontSize:9,color:"#475569",fontWeight:600,marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",letterSpacing:0.8,marginBottom:10}}>📉 EVAP DECLINING SCHEDULE</div>
        {schedule.map((s,i)=>(
          <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,padding:"8px 10px",borderRadius:8,marginBottom:4,background:s.active?"#0d2010":"transparent",border:s.active?"1px solid #16a34a30":"1px solid transparent"}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              {s.active&&<span style={{fontSize:8,background:"#16a34a",color:"#fff",borderRadius:3,padding:"1px 4px",fontWeight:700}}>NOW</span>}
              <span style={{fontSize:12,color:s.active?"#e2e8f0":"#475569",fontWeight:s.active?700:400}}>{s.year}</span>
            </div>
            <div style={{textAlign:"center",fontSize:13,fontWeight:s.active&&listing.fuel==="BEV"?800:500,color:s.active&&listing.fuel==="BEV"?"#22c55e":s.active?"#e2e8f0":"#475569"}}>${s.bev.toLocaleString()}</div>
            <div style={{textAlign:"center",fontSize:13,fontWeight:s.active&&listing.fuel==="PHEV"?800:500,color:s.active&&listing.fuel==="PHEV"?"#f59e0b":s.active?"#e2e8f0":"#475569"}}>${s.phev.toLocaleString()}</div>
          </div>
        ))}
        <div style={{fontSize:10,color:"#334155",marginTop:6}}>Source: Transport Canada · Updated May 11, 2026</div>
      </div>

      <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",letterSpacing:0.8}}>📅 PROGRAM WINDOW</div>
          <div style={{fontSize:11,color:"#64748b"}}>{daysLeft.toLocaleString()} days remaining</div>
        </div>
        <div style={{height:6,background:"#1e293b",borderRadius:3,overflow:"hidden",marginBottom:6}}>
          <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#22c55e,#16a34a)",borderRadius:3}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:"#334155"}}>Feb 16, 2026</span>
          <span style={{fontSize:10,color:"#334155"}}>Mar 31, 2031</span>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({listing,liveListings,history,historyLoading,onConnect,onTestDrive}){
  const priceHistory = history || [];
  const [tab,setTab]=useState("chart");
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel,listing);
  const score=lotScore(listing,liveListings);
  const scoreBreakdown=lotScoreBreakdown(listing,liveListings);

  const currentPrice=listing.price;
  const hasTrend=priceHistory.length>=2;
  const firstPrice=hasTrend?priceHistory[0].price:currentPrice;
  const change=hasTrend?currentPrice-firstPrice:0;
  const spanDays=hasTrend?Math.max(1,Math.round((new Date(priceHistory[priceHistory.length-1].recorded_at)-new Date(priceHistory[0].recorded_at))/86400000)):0;
  const avgHist=hasTrend?Math.round(priceHistory.reduce((s,h)=>s+h.price,0)/priceHistory.length):currentPrice;
  const chartData=priceHistory.map(h=>({date:new Date(h.recorded_at).toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:h.price}));
  const domain=hasTrend?[Math.round(Math.min(...priceHistory.map(h=>h.price))*0.97),Math.round(Math.max(...priceHistory.map(h=>h.price))*1.03)]:undefined;

  // Real comps — replaces the old opaque "Deal Score X/100" stat tile with
  // the actual numbers behind it, so it's auditable instead of a black box.
  // Only treat other listings as real comps if they're actually comparable
  // vehicles -- same model AND within 3 model-years. Matching on model name
  // alone let a 2014 Santa Fe with 259,000km get "anchored" toward the
  // average of possibly-much-newer, lower-mileage Santa Fes, producing a
  // retail estimate wildly higher than the car's real asking price. That's
  // exactly the kind of misleading number this feature exists to avoid.
  const comps=(liveListings||[]).filter(x=>
    x.model===listing.model &&
    x.id!==listing.id &&
    Math.abs((x.year||0)-(listing.year||0))<=3
  );
  const compAvgPrice=comps.length?Math.round(comps.reduce((s,x)=>s+x.price,0)/comps.length):null;

  // Real "days on LotCheck" — from the first price_history point we've ever
  // recorded for this listing. This is NOT the same as "days since posted
  // on Kijiji" (Kijiji's postedDate is frequently null in scraped data) —
  // it's honestly labeled as our own tracking duration only.
  const daysTracked=priceHistory.length?Math.max(0,Math.floor((Date.now()-new Date(priceHistory[0].recorded_at))/86400000)):null;


  // Depreciation curve — previously a hard floor at exactly 10 years old
  // (Math.max(0.4, 1-(years*0.08))), meaning a 10-year-old and a 25-year-old
  // When real comps exist (other live listings of the same model), anchor
  // the retail estimate toward their real average price instead of relying
  // purely on this one listing's own asking price — which may itself be
  // underpriced, overpriced, or a quick-sale price that doesn't reflect
  // typical market value for the model.
  // When real comps exist (other live listings of the same model, within 3
  // model-years so they're actually comparable vehicles), nudge the retail
  // estimate toward their real average price -- but weighted no more than
  // 1:1 against this car's own asking price, so a couple of comps can never
  // outvote the listing's own real, current price.
  const formulaRetail=Math.round(listing.price*1.05);
  const retailAnchor=compAvgPrice!=null
    ? Math.round((formulaRetail*2 + compAvgPrice*Math.min(comps.length,2))/(2+Math.min(comps.length,2)))
    : formulaRetail;

  // Trade-in and wholesale are flat ratios off retail, not a second
  // age/mileage discount on top of it. Retail already reflects this car's
  // age and condition — it's anchored to the actual asking price (and real
  // comps of the same model) — so applying an age-based depreciation curve
  // AGAIN on top of an already-current price was double-discounting. Real
  // appraisal guides work the same way: trade-in and wholesale are fairly
  // stable percentages of today's market value, not a re-run of a from-new
  // depreciation formula on a price that's already aged.
  const cbb={retail:retailAnchor,trade:Math.round(retailAnchor*0.80)};
  cbb.wholesale=Math.round(cbb.trade*0.90);

  return(
    <div style={{padding:"16px"}}>
      <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",marginBottom:8,lineHeight:1.3}}>{listing.name}</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
        <ScorePill score={score} breakdown={scoreBreakdown}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
        <span className="badge" style={{background:"#1e293b",color:"#64748b"}}>{listing.city}, {listing.province}</span>
        <span className="badge" style={{background:"#1e293b",color:"#94a3b8"}}>
          🕐 {daysTracked==null?"New on LotCheck":daysTracked===0?"Listed today":`${daysTracked}d on the market`}
        </span>
      </div>
      <div className="lc-price-hero">
        <div className="lc-price-big">${currentPrice.toLocaleString()}</div>
        {hasTrend
          ? <div style={{fontSize:14,color:change>=0?"#ef4444":"#22c55e",fontWeight:600,marginTop:4}}>{change>=0?"▲":"▼"} ${Math.abs(change).toLocaleString()} ({change>=0?"+":""}{((change/firstPrice)*100).toFixed(1)}%) over {spanDays}d tracked</div>
          : <div style={{fontSize:12,color:"#475569",fontWeight:500,marginTop:4}}>{historyLoading?"Loading price history…":"Price tracking started — trend builds with each daily update"}</div>
        }
        {rebate.total>0&&<div style={{fontSize:14,color:"#22c55e",fontWeight:700,marginTop:4}}>After all rebates: ~${(currentPrice-rebate.total).toLocaleString()}</div>}
      </div>
      {/* VIN tab intentionally removed from this array — paused until a real
          Carfax business relationship exists. Right now unlocking it would
          only send the user to Carfax's own paid page (~$45 separately),
          not deliver a report LotCheck actually provides. VINHistoryPanel
          and its UnlockModal entry are left in place below, unused. */}
      <div className="lc-tabs">
        {[["chart","📈 Chart"],["rebates","⚡ Rebates"],["cbb","📊 Value Est."],["insurance","🛡️ Insurance"]].map(([t,l])=>(
          <button key={t} className={`lc-tab${tab===t?" active":""}`} onClick={()=>setTab(t)}>
            {l}
          </button>
        ))}
      </div>

      {tab==="chart"&&<>
        {hasTrend?(
          <div style={{height:180,marginBottom:16}}>
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{top:4,right:4,bottom:0,left:0}}>
                <XAxis dataKey="date" tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} tickLine={false} axisLine={false}/>
                <YAxis domain={domain} tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={42}/>
                <Tooltip formatter={v=>[`$${v.toLocaleString()}`,"Price"]} contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:13,fontWeight:600,color:"#f1f5f9"}} labelStyle={{color:"#94a3b8",fontSize:11}}/>
                <ReferenceLine y={avgHist} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{value:`avg`,fill:"#f59e0b",fontSize:9,position:"insideTopRight"}}/>
                <Line type="monotone" dataKey="price" stroke="#16a34a" strokeWidth={2} dot={{r:3}}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        ):(
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"28px 20px",textAlign:"center",marginBottom:16}}>
            <div style={{fontSize:26,marginBottom:8}}>📈</div>
            <div style={{color:"#94a3b8",fontWeight:600,marginBottom:4}}>
              {historyLoading?"Loading price history…":"Not enough price history yet"}
            </div>
            <div style={{fontSize:12,color:"#475569"}}>LotCheck updates this listing daily. A real trend will appear here once we've tracked it over multiple days.</div>
          </div>
        )}
        <div className="lc-stats">
          {[["Asking",`$${listing.price.toLocaleString()}`],["vs Comps",compAvgPrice==null?"No comps yet":`${comps.length} · avg $${compAvgPrice.toLocaleString()}`],["Odometer",`${listing.km.toLocaleString()} km`]].map(([l,v])=>(
            <div key={l} className="lc-stat"><div className="lc-stat-label">{l}</div><div className="lc-stat-value">{v}</div></div>
          ))}
          <div className="lc-stat"><div className="lc-stat-label">Tracked</div><div className="lc-stat-value">{daysTracked==null?"New today":`${daysTracked}d on LotCheck`}</div></div>
        </div>
      </>}
      {tab==="rebates"&&<EVAPRebateTab listing={listing} rebate={rebate}/>}
      {tab==="cbb"&&(
        <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:14,padding:"16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1}}>LOTCHECK VALUE ESTIMATE</div>
            <InfoTooltip title="HOW THIS IS CALCULATED">
              This is <strong style={{color:"#f1f5f9"}}>not</strong> licensed Black Book, CBB, or any third-party valuation data — LotCheck doesn't have access to that, and building it would mean scraping sites like AutoTrader, which we won't do without weighing that risk deliberately.
              <br/><br/>
              We only show an estimate once at least one other live LotCheck listing of the <strong style={{color:"#f1f5f9"}}>same model and a similar model-year (±3 years)</strong> exists to anchor it against — weighted no more than evenly against this listing's own asking price, so a couple of comps can never outvote what this specific car is actually listed for. With zero comps, there's nothing real to anchor to, so we don't show a number at all rather than presenting a guess as if it were backed by data.
              <br/><br/>
              Trade-in and Wholesale are typical dealer-spread percentages off Retail (roughly 80% and 72%) — not a second age/mileage discount on top of it, since Retail already reflects this car's age and condition through its real market price. Still an approximation, not a market regression.
            </InfoTooltip>
          </div>
          <div style={{fontSize:11,color:"#475569",marginBottom:comps.length>0?8:12,lineHeight:1.5}}>Our own estimate based on this vehicle's asking price and real comps from other live LotCheck listings.</div>
          {comps.length>0?(
            <>
              <div style={{fontSize:11,color:"#60a5fa",marginBottom:12,lineHeight:1.5}}>
                📊 Anchored against {comps.length} other live {listing.model} listing{comps.length===1?"":"s"} on LotCheck right now, averaging ${compAvgPrice.toLocaleString()}.
              </div>
              <div className="lc-stats">
                {[["Retail",cbb.retail,"#22c55e","Dealer asking range"],["Trade-in",cbb.trade,"#f59e0b","What dealer pays"],["Wholesale",cbb.wholesale,"#94a3b8","Auction estimate"]].map(([l,v,c,sub])=>(
                  <div key={l} className="lc-stat" style={{borderColor:"#1e3a5f"}}>
                    <div className="lc-stat-label">{l}</div>
                    <div style={{fontSize:17,fontWeight:700,color:c,marginBottom:2}}>${v.toLocaleString()}</div>
                    <div style={{fontSize:10,color:"#334155"}}>{sub}</div>
                  </div>
                ))}
              </div>
            </>
          ):(
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"28px 20px",textAlign:"center"}}>
              <div style={{fontSize:26,marginBottom:8}}>📊</div>
              <div style={{color:"#94a3b8",fontWeight:600,marginBottom:4}}>Not enough comps yet for a reliable estimate</div>
              <div style={{fontSize:12,color:"#475569"}}>No other live {listing.model} listings on LotCheck right now to anchor a Retail figure against. We'll show one here as soon as a real comp appears, rather than guess from the asking price alone.</div>
            </div>
          )}
        </div>
      )}
      {/* Paused — see note above tabs array. Re-enable by uncommenting:
      {tab==="vin"&&isUnlocked("vin")&&<VINHistoryPanel listing={listing}/>} */}
      {tab==="insurance"&&<InsurancePanel listing={listing}/>}
    </div>
  );
}

function SkeletonCard(){
  return(
    <div className="lc-skel-card">
      <div className="lc-skel-bar" style={{width:"78%",marginBottom:10}}/>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <div className="lc-skel-bar" style={{width:52,height:18,borderRadius:20}}/>
        <div className="lc-skel-bar" style={{width:44,height:18,borderRadius:20}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
        <div className="lc-skel-bar" style={{width:80,height:22}}/>
        <div className="lc-skel-bar" style={{width:70,height:14}}/>
      </div>
    </div>
  );
}

function ListingCard({listing,liveListings,history,onClick,active}){
  const score=lotScore(listing,liveListings);
  const scoreBreakdown=lotScoreBreakdown(listing,liveListings);
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel,listing);
  // Real price-drop detection: compare the two most recent recorded_at
  // points for this exact listing. Only shows when we've actually observed
  // a drop — never a guess or a fabricated "sale" signal.
  const h=history||[];
  const hasDrop=h.length>=2&&h[h.length-1].price<h[h.length-2].price;
  const dropAmount=hasDrop?h[h.length-2].price-h[h.length-1].price:0;
  // Same "days on LotCheck" logic as the detail view's Tracked stat --
  // from the first price_history point we've ever recorded for this
  // listing, not from the scraper's own scraped_at (which gets touched on
  // every re-scrape, not just the first one, so it can't tell you when a
  // listing actually first appeared).
  const daysOnMarket=h.length?Math.max(0,Math.floor((Date.now()-new Date(h[0].recorded_at))/86400000)):null;
  return(
    <div className={`lc-card${active?" active":""}`} onClick={()=>onClick(listing)}>
      <div className="lc-card-name">{listing.name}</div>
      <div className="lc-card-badges">
        <ScorePill score={score} breakdown={scoreBreakdown}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
        {hasDrop&&<span className="badge" style={{background:"#16a34a18",color:"#22c55e",border:"1px solid #22c55e35"}}>🔻 ${dropAmount.toLocaleString()}</span>}
      </div>
      <div className="lc-card-bottom">
        <div>
          <div className="lc-price">${listing.price.toLocaleString()}</div>
          {rebate.eligible&&rebate.total>0&&<div className="lc-after-rebate">~${(listing.price-rebate.total).toLocaleString()} after rebates</div>}
        </div>
        <div className="lc-meta">
          <div className="lc-city">{listing.city}, {listing.province}</div>
          <div className="lc-km" style={{color:listing.km>150000?"#ef4444":listing.km>80000?"#f59e0b":"#22c55e"}}>{listing.km.toLocaleString()} km</div>
        </div>
      </div>
      <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #1e293b",fontSize:11,color:"#475569"}}>
        {daysOnMarket==null?"New on LotCheck":daysOnMarket===0?"Listed today":`${daysOnMarket} day${daysOnMarket===1?"":"s"} on the market`}
      </div>
    </div>
  );
}

function LiveBackground(){
  const canvasRef=useRef(null);
  const animRef=useRef(null);

  useEffect(()=>{
    const canvas=canvasRef.current;
    if(!canvas)return;
    const ctx=canvas.getContext("2d");
    const dpr=Math.min(window.devicePixelRatio||1,2);
    const setSize=()=>{
      const vw=window.innerWidth,vh=window.innerHeight;
      canvas.width=vw*dpr;canvas.height=vh*dpr;
      canvas.style.width=vw+"px";canvas.style.height=vh+"px";
      ctx.scale(dpr,dpr);W=vw;H=vh;
    };
    let W=window.innerWidth,H=window.innerHeight;
    setSize();
    const resize=()=>{ctx.setTransform(1,0,0,1,0,0);setSize();};
    window.addEventListener("resize",resize);
    const COLORS=[[22,163,74],[14,165,233],[99,102,241],[139,92,246]];
    const N=Math.min(200,Math.floor(W*H/8000));
    const particles=Array.from({length:N},()=>{
      const [r,g,b]=COLORS[Math.floor(Math.random()*COLORS.length)];
      return{x:Math.random()*W,y:Math.random()*H,r,g,b,size:Math.random()*1.8+0.3,vx:(Math.random()-0.5)*0.15,vy:(Math.random()-0.5)*0.12,phase:Math.random()*Math.PI*2,freq:0.003+Math.random()*0.005,amp:0.3+Math.random()*0.5,opacity:0.15+Math.random()*0.55,opacityTarget:0.15+Math.random()*0.55,opacitySpeed:0.002+Math.random()*0.004};
    });
    let t=0;
    const draw=()=>{
      ctx.fillStyle="rgba(2,6,23,0.18)";ctx.fillRect(0,0,W,H);t+=1;
      for(const p of particles){
        p.x+=p.vx+Math.sin(t*p.freq+p.phase)*p.amp*0.08;
        p.y+=p.vy+Math.cos(t*p.freq*0.7+p.phase)*p.amp*0.06;
        if(p.x<-2)p.x=W+2;if(p.x>W+2)p.x=-2;
        if(p.y<-2)p.y=H+2;if(p.y>H+2)p.y=-2;
        p.opacity+=(p.opacityTarget-p.opacity)*p.opacitySpeed;
        if(Math.abs(p.opacity-p.opacityTarget)<0.01)p.opacityTarget=0.08+Math.random()*0.5;
        const grd=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*3);
        grd.addColorStop(0,`rgba(${p.r},${p.g},${p.b},${p.opacity})`);
        grd.addColorStop(1,`rgba(${p.r},${p.g},${p.b},0)`);
        ctx.beginPath();ctx.arc(p.x,p.y,p.size*3,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill();
      }
      animRef.current=requestAnimationFrame(draw);
    };
    draw();
    return()=>{cancelAnimationFrame(animRef.current);window.removeEventListener("resize",resize);};
  },[]);

  return(
    <div className="lc-live-bg" aria-hidden="true"><canvas ref={canvasRef}/></div>
  );
}

function LiveTicker({listings,onSelect}){
  // Shows real listings with real current prices, scrolling. No fabricated
  // price movement — a previous version randomly nudged prices every 2.5s
  // to simulate "live" ticks, which was fake data on real car names. Real
  // price changes will show once price_history has enough points per listing
  // to justify a real delta; until then this is a straight snapshot ticker.
  const src=listings&&listings.length>0?listings:DEMO_LISTINGS;
  const items=src.map(l=>({id:l.id,listing:l,name:`${l.make} ${l.model}`,price:l.price}));
  const doubled=[...items,...items];
  // Duration was previously a fixed 38s regardless of item count. That was
  // tuned for the 14-car demo array — with 51+ real listings the same 38s
  // has to cover far more content, so the effective scroll speed increased
  // proportionally (way too fast). Real tickers hold a constant pace, not a
  // constant loop time — so duration now scales with item count instead.
  const SECONDS_PER_ITEM=4;
  const MIN_DURATION=24;
  const duration=Math.max(MIN_DURATION, items.length*SECONDS_PER_ITEM);
  return(
    <div className="lc-ticker-wrap">
      <div className="lc-ticker-track" style={{animationDuration:`${duration}s`}}>
        {doubled.map((it,i)=>(
          <span key={i} className="lc-ticker-item" onClick={()=>onSelect&&onSelect(it.listing)} style={{cursor:"pointer"}}>
            <span className="lc-ticker-dot"/>
            <span className="name">{it.name}</span>
            <span style={{color:"#f1f5f9",fontWeight:600}}>${it.price.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Admin Panel ──────────────────────────────────────────────────────────
// Reachable at lotcheck.ca/admin. Uses real Supabase Auth — not a client-
// side password box. A text-match password screen provides no real
// protection if the data behind it is reachable with the same public anon
// key used everywhere else on the site; the actual security boundary here
// is the RLS policy on the `leads` table (see create_leads_table.sql):
// anon can INSERT, only an authenticated Supabase session can SELECT or
// UPDATE. Create your own login at Supabase → Authentication → Users →
// Add User with your real email + a real password.
// ── Shared logo mark ────────────────────────────────────────────────────────
// One consistent icon everywhere: a blue circle with a scan/search glyph,
// replacing the old green-gradient checkmark used inconsistently across
// admin.html, the React admin panel, the main site header, and the dealer
// portal. Only replaces genuine brand-logo usages -- the plain checkmark
// emoji used elsewhere as a decorative "success" indicator (trial badges,
// empty states) is untouched, since that's a different meaning, not branding.
function LogoMark({ size = 32 }) {
  const iconSize = Math.round(size * 0.5);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: "linear-gradient(135deg,#0175ff,#0057c2)",
      boxShadow: "0 0 16px rgba(1,117,255,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none"
        stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7V5a2 2 0 0 1 2-2h2" />
        <path d="M17 3h2a2 2 0 0 1 2 2v2" />
        <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
        <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
        <circle cx="12" cy="12" r="3" />
        <path d="m16 16-1.9-1.9" />
      </svg>
    </div>
  );
}

function AdminLogin(){
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);

  async function handleLogin(e){
    e.preventDefault();
    setErr("");setLoading(true);
    const {error}=await supabase.auth.signInWithPassword({email,password});
    setLoading(false);
    if(error) setErr(error.message);
    // On success, supabase.auth.onAuthStateChange (subscribed in AdminPanel)
    // updates the session automatically — no manual redirect needed here.
  }

  return(
    <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"#020617"}}>
      <form onSubmit={handleLogin} style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:20,padding:"40px 36px",width:360,maxWidth:"90vw",textAlign:"center",boxSizing:"border-box"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><LogoMark size={56}/></div>
        <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9",marginBottom:4}}>LotCheck Admin</div>
        <div style={{fontSize:13,color:"#64748b",marginBottom:24,lineHeight:1.5}}>Real Supabase login — leads data is protected at the database level, not just this screen.</div>
        <input type="email" placeholder="you@lotcheck.ca" value={email} onChange={e=>setEmail(e.target.value)} required
          style={{width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"12px 14px",color:"#f1f5f9",fontSize:14,marginBottom:10,outline:"none",boxSizing:"border-box"}}/>
        <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required
          style={{width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"12px 14px",color:"#f1f5f9",fontSize:14,marginBottom:14,outline:"none",boxSizing:"border-box"}}/>
        {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:14,textAlign:"left"}}>{err}</div>}
        <button type="submit" disabled={loading} className="lc-modal-btn">{loading?"Signing in…":"Sign in →"}</button>
      </form>
    </div>
  );
}

// ── Small shared bits for the new tabs ────────────────────────────────────────
function AdminTabButton({active,onClick,children}){
  return (
    <button onClick={onClick} style={{
      background: active ? "#1e293b" : "transparent",
      border: "none", borderRadius: 8, padding: "7px 14px",
      color: active ? "#f1f5f9" : "#64748b", fontSize: 13, fontWeight: 600,
      cursor: "pointer",
    }}>{children}</button>
  );
}

function AdminEmpty({icon,children}){
  return (
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"32px 20px",textAlign:"center",color:"#475569"}}>
      {icon&&<div style={{fontSize:28,marginBottom:10}}>{icon}</div>}
      {children}
    </div>
  );
}

// ── Dealers tab ────────────────────────────────────────────────────────────
function DealersTab({dealers,dealersLoading,onAdd,onEdit,onToggle,onDelete,dealerListings,dealerListingsLoading,onMarkSold,onPublish}){
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1}}>
          DEALER NETWORK · {dealersLoading?"loading…":`${dealers.length} dealer${dealers.length===1?"":"s"}`}
        </div>
        <button onClick={onAdd} style={{background:"#16a34a",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Add Dealer</button>
      </div>

      {dealersLoading ? (
        <div style={{color:"#475569",fontSize:13}}>Loading…</div>
      ) : dealers.length===0 ? (
        <AdminEmpty icon="🏢">No dealers yet — add your first one</AdminEmpty>
      ) : (
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden",marginBottom:28}}>
          {dealers.map(d=>(
            <div key={d.id} style={{padding:"14px 16px",borderBottom:"1px solid #1e293b60",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontWeight:700,color:"#f1f5f9",fontSize:14}}>{d.name}</div>
                <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{d.contact||""} {d.city?`· ${d.city}, ${d.province||""}`:""}</div>
                <div style={{fontSize:11,color:"#475569",marginTop:2}}>{d.makes||"—"}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b",cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.live} onChange={e=>onToggle(d.id,"live",e.target.checked)}/> Live lot
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b",cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.featured} onChange={e=>onToggle(d.id,"featured",e.target.checked)}/> Featured ($300/mo)
                </label>
                {d.sold_count>0 && <span className="badge" style={{background:"#7c3aed18",color:"#c4b5fd",border:"1px solid #7c3aed35"}}>{d.sold_count} sold</span>}
                <button onClick={()=>onEdit(d)} style={{background:"none",border:"1px solid #334155",borderRadius:6,padding:"5px 10px",color:"#64748b",fontSize:11,cursor:"pointer"}}>Edit</button>
                <button onClick={()=>onDelete(d.id,d.name)} style={{background:"none",border:"1px solid #334155",borderRadius:6,padding:"5px 10px",color:"#64748b",fontSize:11,cursor:"pointer"}}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>
        DEALER SUBMITTED INVENTORY · {dealerListingsLoading?"loading…":`${dealerListings.length} vehicle${dealerListings.length===1?"":"s"}`}
      </div>
      {dealerListingsLoading ? (
        <div style={{color:"#475569",fontSize:13}}>Loading…</div>
      ) : dealerListings.length===0 ? (
        <AdminEmpty icon="🚗">No dealer submissions yet</AdminEmpty>
      ) : (
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
          {dealerListings.map(v=>{
            const isSold=v.status==="sold", isLive=v.status==="live";
            const commission = v.plan==="commission" ? Math.round((v.price||0)*0.01) : 100;
            return (
              <div key={v.id} style={{padding:"14px 16px",borderBottom:"1px solid #1e293b60",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{fontWeight:700,color:"#f1f5f9",fontSize:14}}>{v.year} {v.make} {v.model}</div>
                  <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{v.dealer} · ${(v.price||0).toLocaleString()} · {v.plan==="commission"?"1% commission":"$100/lead"}</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span className="badge" style={{
                    background: isSold?"#7c3aed18":isLive?"#16a34a18":"#33415530",
                    color: isSold?"#c4b5fd":isLive?"#22c55e":"#94a3b8",
                    border: `1px solid ${isSold?"#7c3aed35":isLive?"#22c55e35":"#33415560"}`,
                  }}>{isSold?"✓ Sold":isLive?"● Live":"Pending"}</span>
                  {!isSold && <button onClick={()=>onMarkSold(v)} style={{background:"none",border:"1px solid #22c55e",borderRadius:6,padding:"5px 10px",color:"#22c55e",fontSize:11,cursor:"pointer"}}>✓ Mark Sold (${commission.toLocaleString()})</button>}
                  {!isLive && !isSold && <button onClick={()=>onPublish(v.id)} style={{background:"none",border:"1px solid #334155",borderRadius:6,padding:"5px 10px",color:"#64748b",fontSize:11,cursor:"pointer"}}>Publish</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Review queue tab ──────────────────────────────────────────────────────
function ReviewTab({reviewListings,reviewLoading,rejectedListings,onApprove,onReject}){
  return (
    <div>
      <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>
        PENDING REVIEW · {reviewLoading?"loading…":`${reviewListings.length} listing${reviewListings.length===1?"":"s"}`}
      </div>
      {reviewLoading ? (
        <div style={{color:"#475569",fontSize:13}}>Loading…</div>
      ) : reviewListings.length===0 ? (
        <AdminEmpty icon="✅">No listings pending review — pipeline approved everything</AdminEmpty>
      ) : (
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden",marginBottom:28}}>
          {reviewListings.map(l=>{
            const score=l.verification_score||0;
            const scoreColor = score>=70?"#22c55e":score>=50?"#f59e0b":"#ef4444";
            const flags=(l.verification_flags||"").split(" | ").filter(Boolean);
            return (
              <div key={l.id} style={{padding:"14px 16px",borderBottom:"1px solid #1e293b60",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{fontWeight:700,color:"#f1f5f9",fontSize:14}}>{l.name}</div>
                  <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{l.city}, {l.province} · ${(l.price||0).toLocaleString()} · <span style={{color:scoreColor,fontWeight:700}}>{score}</span></div>
                  {flags.map((f,i)=>(<div key={i} style={{fontSize:11,color:"#f59e0b",marginTop:2}}>⚠ {f}</div>))}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>onApprove(l.external_id,l.name)} style={{background:"none",border:"1px solid #22c55e",borderRadius:6,padding:"6px 12px",color:"#22c55e",fontSize:12,cursor:"pointer"}}>✓ Approve</button>
                  <button onClick={()=>onReject(l.external_id)} style={{background:"none",border:"1px solid #ef4444",borderRadius:6,padding:"6px 12px",color:"#ef4444",fontSize:12,cursor:"pointer"}}>✗ Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>
        RECENTLY REJECTED · {rejectedListings.length}
      </div>
      {rejectedListings.length===0 ? (
        <AdminEmpty>No rejected listings yet</AdminEmpty>
      ) : (
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
          {rejectedListings.map((l,i)=>(
            <div key={i} style={{padding:"12px 16px",borderBottom:"1px solid #1e293b60",display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span style={{color:"#f1f5f9"}}>{l.name}</span>
              <span style={{color:"#ef4444",fontWeight:700}}>{l.verification_score||0}</span>
              <span style={{color:"#475569",fontSize:11}}>{(l.verification_flags||"").split(" | ")[0]||"—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Revenue tab ────────────────────────────────────────────────────────────
function RevenueTab({dealers}){
  const featured = dealers.filter(d=>d.featured);
  const featuredRev = featured.length*300;
  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:24}}>
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:"#22c55e"}}>${featuredRev.toLocaleString()}</div>
          <div style={{fontSize:12,color:"#64748b"}}>Featured listings/mo — real</div>
        </div>
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:"#475569"}}>$0</div>
          <div style={{fontSize:12,color:"#64748b"}}>Lead referral fees</div>
        </div>
      </div>
      <AdminEmpty>
        Lead referral revenue shows $0 on purpose — leads aren't linked to a
        specific dealer yet (the buyer-facing Connect form doesn't set
        <code style={{background:"#1e293b",padding:"1px 5px",borderRadius:4,margin:"0 4px"}}>dealer_id</code>
        when someone submits it). The database column exists now, but wiring
        the actual attribution is a separate follow-up task.
      </AdminEmpty>
      {featured.length>0 && (
        <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden",marginTop:20}}>
          {featured.map(d=>(
            <div key={d.id} style={{padding:"12px 16px",borderBottom:"1px solid #1e293b60",display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span style={{color:"#f1f5f9"}}>{d.name}</span>
              <span style={{color:"#22c55e",fontWeight:700}}>$300/mo</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function DealerModal({dealer,onSave,onClose}){
  const [form,setForm]=useState(dealer||{name:"",contact:"",phone:"",email:"",city:"",province:"AB",makes:"",notes:"",live:false,featured:false});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const inputStyle={width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"11px 13px",color:"#f1f5f9",fontSize:13,marginBottom:10,outline:"none",boxSizing:"border-box"};
  const labelStyle={fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:0.4,marginBottom:5,display:"block"};

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:16,padding:28,width:"100%",maxWidth:440,maxHeight:"90vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{fontSize:18,fontWeight:700,marginBottom:18,color:"#f1f5f9"}}>{dealer?"Edit Dealer":"Add Dealer"}</div>
        <label style={labelStyle}>Dealership name *</label>
        <input style={inputStyle} value={form.name} onChange={e=>set("name",e.target.value)} placeholder="Cochrane Toyota"/>
        <label style={labelStyle}>Contact name</label>
        <input style={inputStyle} value={form.contact} onChange={e=>set("contact",e.target.value)} placeholder="Ryan Smith"/>
        <label style={labelStyle}>Phone</label>
        <input style={inputStyle} value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="403-932-9900"/>
        <label style={labelStyle}>Email</label>
        <input style={inputStyle} value={form.email} onChange={e=>set("email",e.target.value)} placeholder="ryan@dealer.com"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <label style={labelStyle}>City</label>
            <input style={inputStyle} value={form.city} onChange={e=>set("city",e.target.value)} placeholder="Cochrane"/>
          </div>
          <div>
            <label style={labelStyle}>Province</label>
            <select style={inputStyle} value={form.province} onChange={e=>set("province",e.target.value)}>
              {["AB","BC","ON","QC","MB","SK","NS","NB","PE","NL","YT","NT","NU"].map(p=><option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <label style={labelStyle}>Makes (comma separated)</label>
        <input style={inputStyle} value={form.makes} onChange={e=>set("makes",e.target.value)} placeholder="Toyota, Lexus"/>
        <label style={labelStyle}>Notes</label>
        <input style={inputStyle} value={form.notes} onChange={e=>set("notes",e.target.value)} placeholder="Met at Costco"/>
        <div style={{display:"flex",gap:16,marginBottom:16,marginTop:6}}>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#94a3b8",cursor:"pointer"}}>
            <input type="checkbox" checked={form.live} onChange={e=>set("live",e.target.checked)}/> Live lot
          </label>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#94a3b8",cursor:"pointer"}}>
            <input type="checkbox" checked={form.featured} onChange={e=>set("featured",e.target.checked)}/> Featured ($300/mo)
          </label>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,background:"none",border:"1px solid #334155",borderRadius:10,padding:11,color:"#94a3b8",fontSize:14,cursor:"pointer"}}>Cancel</button>
          <button onClick={()=>{ if(!form.name.trim()){alert("Dealer name is required");return;} onSave(form); }}
            className="lc-modal-btn" style={{flex:1}}>Save Dealer →</button>
        </div>
      </div>
    </div>
  );
}
function AdminPanel(){
  const [session,setSession]=useState(null);
  const [checkingSession,setCheckingSession]=useState(true);
  const [tab,setTab]=useState("overview");

  const [leads,setLeads]=useState([]);
  const [leadsLoading,setLeadsLoading]=useState(true);
  const [pageViews,setPageViews]=useState([]);
  const [trafficGranularity,setTrafficGranularity]=useState("day");
  const [viewsLoading,setViewsLoading]=useState(true);
  const {listings:liveListings, loading:listingsLoading}=useListings();
  const {historyMap}=usePriceHistoryMap();
  const [listingsGranularity,setListingsGranularity]=useState("day");

  const [dealers,setDealers]=useState([]);
  const [dealersLoading,setDealersLoading]=useState(true);
  const [dealerModal,setDealerModal]=useState(null); // null | "new" | dealer object

  const [dealerListings,setDealerListings]=useState([]);
  const [dealerListingsLoading,setDealerListingsLoading]=useState(true);

  const [reviewListings,setReviewListings]=useState([]);
  const [rejectedListings,setRejectedListings]=useState([]);
  const [reviewLoading,setReviewLoading]=useState(true);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{
      setSession(data.session);
      setCheckingSession(false);
    });
    const {data:sub}=supabase.auth.onAuthStateChange((_event,newSession)=>{
      setSession(newSession);
    });
    return()=>sub.subscription.unsubscribe();
  },[]);

  useEffect(()=>{
    if(!session){ setLeads([]); return; }
    let cancelled=false;
    async function fetchLeads(){
      setLeadsLoading(true);
      try{
        const {data,error}=await supabase.from("leads").select("*").order("created_at",{ascending:false}).limit(500);
        if(error) throw error;
        if(!cancelled) setLeads(data||[]);
      }catch(err){
        console.warn("⚠️ leads fetch failed:",err.message);
        if(!cancelled) setLeads([]);
      }finally{
        if(!cancelled) setLeadsLoading(false);
      }
    }
    fetchLeads();
    return()=>{cancelled=true;};
  },[session]);

  useEffect(()=>{
    if(!session){ setPageViews([]); return; }
    let cancelled=false;
    async function fetchViews(){
      setViewsLoading(true);
      try{
        const {data,error}=await supabase.from("page_views").select("created_at, visitor_id, referrer_source").order("created_at",{ascending:true}).limit(50000);
        if(error) throw error;
        if(!cancelled) setPageViews(data||[]);
      }catch(err){
        console.warn("⚠️ page_views fetch failed:",err.message);
        if(!cancelled) setPageViews([]);
      }finally{
        if(!cancelled) setViewsLoading(false);
      }
    }
    fetchViews();
    return()=>{cancelled=true;};
  },[session]);

  async function fetchDealers(){
    setDealersLoading(true);
    try{
      const {data,error}=await supabase.from("dealers").select("*").order("created_at",{ascending:false});
      if(error) throw error;
      setDealers(data||[]);
    }catch(err){
      console.warn("⚠️ dealers fetch failed (did you run create_dealers_table.sql?):",err.message);
      setDealers([]);
    }finally{
      setDealersLoading(false);
    }
  }
  useEffect(()=>{ if(session) fetchDealers(); else setDealers([]); },[session]);

  async function fetchDealerListings(){
    setDealerListingsLoading(true);
    try{
      const {data,error}=await supabase.from("dealer_listings").select("*").order("submitted_at",{ascending:false}).limit(100);
      if(error) throw error;
      setDealerListings(data||[]);
    }catch(err){
      console.warn("⚠️ dealer_listings fetch failed:",err.message);
      setDealerListings([]);
    }finally{
      setDealerListingsLoading(false);
    }
  }
  useEffect(()=>{ if(session) fetchDealerListings(); else setDealerListings([]); },[session]);

  async function fetchReview(){
    setReviewLoading(true);
    try{
      const {data:review,error:e1}=await supabase.from("listings")
        .select("id,external_id,name,price,fuel,source,city,province,verification_score,verification_flags,scraped_at")
        .eq("status","review").order("scraped_at",{ascending:false}).limit(100);
      if(e1) throw e1;
      const {data:rejected,error:e2}=await supabase.from("listings")
        .select("name,price,verification_score,verification_flags,scraped_at")
        .eq("status","reject").order("scraped_at",{ascending:false}).limit(50);
      if(e2) throw e2;
      setReviewListings(review||[]);
      setRejectedListings(rejected||[]);
    }catch(err){
      console.warn("⚠️ review queue fetch failed:",err.message);
      setReviewListings([]); setRejectedListings([]);
    }finally{
      setReviewLoading(false);
    }
  }
  useEffect(()=>{ if(session) fetchReview(); else { setReviewListings([]); setRejectedListings([]); } },[session]);

  async function updateLeadStatus(id,status){
    const {error}=await supabase.from("leads").update({status}).eq("id",id);
    if(!error) setLeads(prev=>prev.map(l=>l.id===id?{...l,status}:l));
  }

  async function saveDealer(form){
    const payload={
      name:form.name.trim(), contact:form.contact?.trim()||null, phone:form.phone?.trim()||null,
      email:form.email?.trim()||null, city:form.city?.trim()||null, province:form.province||null,
      makes:form.makes?.trim()||null, notes:form.notes?.trim()||null,
      live:!!form.live, featured:!!form.featured,
    };
    if(form.id){
      const {error}=await supabase.from("dealers").update(payload).eq("id",form.id);
      if(error){ alert("Couldn't save: "+error.message); return; }
    }else{
      const {error}=await supabase.from("dealers").insert(payload);
      if(error){ alert("Couldn't save: "+error.message); return; }
    }
    setDealerModal(null);
    fetchDealers();
  }

  async function toggleDealerField(id,field,value){
    setDealers(prev=>prev.map(d=>d.id===id?{...d,[field]:value}:d)); // optimistic
    const {error}=await supabase.from("dealers").update({[field]:value}).eq("id",id);
    if(error){ alert("Couldn't update: "+error.message); fetchDealers(); }
  }

  async function deleteDealer(id,name){
    if(!confirm(`Delete ${name}?`)) return;
    const {error}=await supabase.from("dealers").delete().eq("id",id);
    if(error){ alert("Couldn't delete: "+error.message); return; }
    fetchDealers();
  }

  async function markSold(v){
    const commission = v.plan==="commission" ? Math.round((v.price||0)*0.01) : 100;
    if(!confirm(`Mark ${v.year} ${v.make} ${v.model} from ${v.dealer} as SOLD?\n\nCommission due: $${commission.toLocaleString()}`)) return;
    const {error}=await supabase.from("dealer_listings").update({status:"sold"}).eq("id",v.id);
    if(error){ alert("Couldn't update: "+error.message); return; }
    const dealerIdx=dealers.findIndex(d=>d.name===v.dealer);
    if(dealerIdx>=0){
      await supabase.from("dealers").update({sold_count:(dealers[dealerIdx].sold_count||0)+1}).eq("id",dealers[dealerIdx].id);
      fetchDealers();
    }
    fetchDealerListings();
  }

  async function publishDealerListing(id){
    const {error}=await supabase.from("dealer_listings").update({status:"live",published_at:new Date().toISOString()}).eq("id",id);
    if(error){ alert("Couldn't update: "+error.message); return; }
    fetchDealerListings();
  }

  async function approveReview(externalId,name){
    if(!confirm(`Approve "${name}" and publish to LotCheck?`)) return;
    const {error}=await supabase.from("listings").update({status:"published"}).eq("external_id",externalId);
    if(error){ alert("Couldn't update: "+error.message); return; }
    fetchReview();
  }

  async function rejectReview(externalId){
    const {error}=await supabase.from("listings").update({status:"reject"}).eq("external_id",externalId);
    if(error){ alert("Couldn't update: "+error.message); return; }
    fetchReview();
  }

  const now=Date.now();
  const rollup=(windowMs)=>{
    const cutoff=now-windowMs;
    const inWindow=pageViews.filter(v=>new Date(v.created_at).getTime()>=cutoff);
    return { views: inWindow.length, visitors: new Set(inWindow.map(v=>v.visitor_id)).size };
  };
  const trafficToday=rollup(24*3600000);
  const trafficWeek=rollup(7*24*3600000);
  const trafficMonth=rollup(30*24*3600000);
  const trafficAllTime={views:pageViews.length, visitors:new Set(pageViews.map(v=>v.visitor_id)).size};
  const trackingSince=pageViews.length?new Date(pageViews[0].created_at):null;
  const bucketedTraffic=bucketPageViews(pageViews,trafficGranularity);
  const trafficSources={};
  pageViews.forEach(v=>{
    const src=v.referrer_source||"Unknown (recorded before tracking)";
    trafficSources[src]=(trafficSources[src]||0)+1;
  });
  const sortedSources=Object.entries(trafficSources).sort((a,b)=>b[1]-a[1]);

  if(checkingSession) return <div style={{minHeight:"100dvh",background:"#020617",display:"flex",alignItems:"center",justifyContent:"center",color:"#475569"}}>Loading…</div>;
  if(!session) return <AdminLogin/>;

  const byProvince={};
  const byFuel={};
  let evapCount=0;
  const firstSeenTimestamps=[];
  const daysOnMarketValues=[];
  liveListings.forEach(l=>{
    byProvince[l.province]=(byProvince[l.province]||0)+1;
    byFuel[l.fuel]=(byFuel[l.fuel]||0)+1;
    if(getEVAP(l)) evapCount++;
    const h=historyMap[l.external_id];
    if(h&&h.length){
      const firstSeen=new Date(h[0].recorded_at).getTime();
      firstSeenTimestamps.push(firstSeen);
      daysOnMarketValues.push(Math.max(0,Math.floor((Date.now()-firstSeen)/86400000)));
    }
  });
  const avgDaysOnMarket=daysOnMarketValues.length?Math.round(daysOnMarketValues.reduce((a,b)=>a+b,0)/daysOnMarketValues.length):null;
  const bucketedListings=bucketByTime(firstSeenTimestamps,listingsGranularity);
  const byLeadType={};
  leads.forEach(l=>{ byLeadType[l.lead_type]=(byLeadType[l.lead_type]||0)+1; });

  return(
    <div style={{minHeight:"100dvh",background:"#020617",color:"#e2e8f0",padding:"24px"}}>
      {dealerModal && (
        <DealerModal
          dealer={dealerModal==="new"?null:dealerModal}
          onSave={saveDealer}
          onClose={()=>setDealerModal(null)}
        />
      )}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,maxWidth:1100,margin:"0 auto 20px",flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <LogoMark size={32}/>
          <div style={{fontWeight:800,fontSize:18}}>LotCheck Admin</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4,background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:10,padding:4}}>
          <AdminTabButton active={tab==="overview"} onClick={()=>setTab("overview")}>Overview</AdminTabButton>
          <AdminTabButton active={tab==="dealers"} onClick={()=>setTab("dealers")}>Dealers</AdminTabButton>
          <AdminTabButton active={tab==="review"} onClick={()=>setTab("review")}>Review</AdminTabButton>
          <AdminTabButton active={tab==="revenue"} onClick={()=>setTab("revenue")}>Revenue</AdminTabButton>
        </div>
        <button onClick={()=>supabase.auth.signOut()} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:"8px 14px",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>Sign out</button>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto"}}>
        {tab==="overview" && (<>
          <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>
            TRAFFIC · {viewsLoading?"loading…":trackingSince?`tracking since ${trackingSince.toLocaleDateString("en-CA")}`:"no data yet"}
          </div>
          {!viewsLoading&&pageViews.length===0?(
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"20px",textAlign:"center",color:"#475569",marginBottom:28}}>
              No page views recorded yet. This starts counting the moment someone loads the live site after this goes out — there's no way to recover data from before tracking began.
            </div>
          ):(
            <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
                {[["Today",trafficToday],["Last 7 days",trafficWeek],["Last 30 days",trafficMonth],["All time",trafficAllTime]].map(([label,stats])=>(
                  <div key={label} style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
                    <div style={{fontSize:12,color:"#64748b",marginBottom:6}}>{label}</div>
                    <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{stats.visitors.toLocaleString()}</div>
                    <div style={{fontSize:11,color:"#475569"}}>unique visitor{stats.visitors===1?"":"s"} · {stats.views.toLocaleString()} view{stats.views===1?"":"s"}</div>
                  </div>
                ))}
              </div>

              <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px",marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>Visits over time</div>
                  <div style={{display:"flex",gap:4,background:"#0d1526",border:"1px solid #1e293b",borderRadius:8,padding:3}}>
                    {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                      <button key={key} onClick={()=>setTrafficGranularity(key)}
                        style={{background:trafficGranularity===key?"#1e3a5f":"transparent",color:trafficGranularity===key?"#60a5fa":"#64748b",border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedTraffic} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:10,fill:"#64748b"}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:11,fill:"#64748b"}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v,name)=>[v,name==="views"?"Views":name]}
                        contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:12,fontWeight:600,color:"#f1f5f9"}}
                        labelStyle={{color:"#94a3b8",fontSize:11}}
                      />
                      <Bar dataKey="views" radius={[3,3,0,0]}>
                        {bucketedTraffic.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.views>=bucketedTraffic[i-1].views?"#22c55e":"#f59e0b"}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:11,color:"#475569"}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#22c55e",marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#f59e0b",marginRight:5}}/>Down from previous period</span>
                </div>
              </div>

              <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px",marginBottom:28}}>
                <div style={{fontSize:13,fontWeight:700,color:"#94a3b8",marginBottom:12}}>Where visits come from</div>
                {sortedSources.every(([src])=>src==="Unknown (recorded before tracking)")?(
                  <div style={{color:"#475569",fontSize:13,lineHeight:1.6}}>
                    Source tracking just went live — every visit before this update was recorded without it, so there's nothing real to show yet. This will fill in from here forward.
                  </div>
                ):(
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {sortedSources.map(([src,count])=>{
                      const pct=Math.round((count/pageViews.length)*100);
                      return(
                        <div key={src}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
                            <span style={{color:"#e2e8f0",fontWeight:600}}>{src}</span>
                            <span style={{color:"#64748b"}}>{count.toLocaleString()} · {pct}%</span>
                          </div>
                          <div style={{background:"#1e293b",borderRadius:4,height:6,overflow:"hidden"}}>
                            <div style={{width:`${pct}%`,height:"100%",background:src==="Internal navigation"?"#475569":src==="Direct"?"#60a5fa":"#22c55e"}}/>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>LISTINGS · {listingsLoading?"loading…":`${liveListings.length} live`}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{liveListings.length}</div>
              <div style={{fontSize:12,color:"#64748b"}}>Total live listings</div>
            </div>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:"#22c55e"}}>{evapCount}</div>
              <div style={{fontSize:12,color:"#64748b"}}>EVAP-eligible (new, verified)</div>
            </div>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{Object.keys(byProvince).length}</div>
              <div style={{fontSize:12,color:"#64748b"}}>Provinces covered</div>
            </div>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{leads.length}</div>
              <div style={{fontSize:12,color:"#64748b"}}>Total leads received</div>
            </div>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{avgDaysOnMarket==null?"—":`${avgDaysOnMarket}d`}</div>
              <div style={{fontSize:12,color:"#64748b"}}>Avg. days on market</div>
            </div>
          </div>

          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px",marginBottom:28}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>New listings tracked over time</div>
              <div style={{display:"flex",gap:4,background:"#0d1526",border:"1px solid #1e293b",borderRadius:8,padding:3}}>
                {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                  <button key={key} onClick={()=>setListingsGranularity(key)}
                    style={{background:listingsGranularity===key?"#1e3a5f":"transparent",color:listingsGranularity===key?"#60a5fa":"#64748b",border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {firstSeenTimestamps.length===0?(
              <div style={{color:"#475569",fontSize:13,textAlign:"center",padding:"20px 0"}}>No listing history recorded yet.</div>
            ):(
              <>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedListings} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:10,fill:"#64748b"}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:11,fill:"#64748b"}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v)=>[v,"New listings"]}
                        contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:12,fontWeight:600,color:"#f1f5f9"}}
                        labelStyle={{color:"#94a3b8",fontSize:11}}
                      />
                      <Bar dataKey="count" radius={[3,3,0,0]}>
                        {bucketedListings.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.count>=bucketedListings[i-1].count?"#22c55e":"#f59e0b"}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:11,color:"#475569"}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#22c55e",marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:"#f59e0b",marginRight:5}}/>Down from previous period</span>
                </div>
              </>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:28}}>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#94a3b8",marginBottom:10}}>By province</div>
              {Object.entries(byProvince).sort((a,b)=>b[1]-a[1]).map(([p,c])=>(
                <div key={p} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #1e293b40",fontSize:13}}>
                  <span style={{color:"#94a3b8"}}>{p}</span><span style={{fontWeight:700}}>{c}</span>
                </div>
              ))}
            </div>
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#94a3b8",marginBottom:10}}>By fuel type</div>
              {Object.entries(byFuel).sort((a,b)=>b[1]-a[1]).map(([f,c])=>(
                <div key={f} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #1e293b40",fontSize:13}}>
                  <span style={{color:"#94a3b8"}}>{f}</span><span style={{fontWeight:700}}>{c}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>
            LEADS · {leadsLoading?"loading…":`${leads.length} total`}
            {!leadsLoading&&leads.length>0&&` · ${Object.entries(byLeadType).map(([t,c])=>`${c} ${t}`).join(" · ")}`}
          </div>
          {leadsLoading?(
            <div style={{color:"#475569",fontSize:13}}>Loading leads…</div>
          ):leads.length===0?(
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"24px",textAlign:"center",color:"#475569"}}>
              No leads yet. They'll show up here the moment someone submits Connect, Test Drive, or an appraisal request on the live site.
            </div>
          ):(
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
              {leads.map(l=>(
                <div key={l.id} style={{padding:"14px 16px",borderBottom:"1px solid #1e293b60"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6,flexWrap:"wrap",gap:8}}>
                    <div>
                      <span className="badge" style={{background:"#16a34a18",color:"#22c55e",border:"1px solid #22c55e35",marginRight:8}}>{l.lead_type}</span>
                      <strong style={{color:"#f1f5f9"}}>{l.name}</strong>
                    </div>
                    <div style={{fontSize:11,color:"#475569"}}>{new Date(l.created_at).toLocaleString("en-CA")}</div>
                  </div>
                  <div style={{fontSize:13,color:"#94a3b8",marginBottom:6}}>
                    {l.phone&&<span>{l.phone}</span>}{l.phone&&l.email&&<span> · </span>}{l.email&&<span>{l.email}</span>}
                  </div>
                  {l.details?.listing_name&&<div style={{fontSize:12,color:"#64748b",marginBottom:4}}>Re: {l.details.listing_name}</div>}
                  {l.lead_type==="appraisal"&&<div style={{fontSize:12,color:"#64748b",marginBottom:4}}>{l.details.year} {l.details.make} {l.details.model} · {l.details.km?Number(l.details.km).toLocaleString():"?"} km · est. ${l.details.estimate_mid?.toLocaleString()}</div>}
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    {["new","contacted","closed"].map(s=>(
                      <button key={s} onClick={()=>updateLeadStatus(l.id,s)}
                        style={{fontSize:11,padding:"4px 10px",borderRadius:6,cursor:"pointer",
                          background:l.status===s?"#16a34a":"transparent",
                          border:`1px solid ${l.status===s?"#16a34a":"#334155"}`,
                          color:l.status===s?"#fff":"#64748b"}}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>)}

        {tab==="dealers" && (
          <DealersTab
            dealers={dealers} dealersLoading={dealersLoading}
            onAdd={()=>setDealerModal("new")} onEdit={d=>setDealerModal(d)}
            onToggle={toggleDealerField} onDelete={deleteDealer}
            dealerListings={dealerListings} dealerListingsLoading={dealerListingsLoading}
            onMarkSold={markSold} onPublish={publishDealerListing}
          />
        )}

        {tab==="review" && (
          <ReviewTab
            reviewListings={reviewListings} reviewLoading={reviewLoading}
            rejectedListings={rejectedListings}
            onApprove={approveReview} onReject={rejectReview}
          />
        )}

        {tab==="revenue" && <RevenueTab dealers={dealers}/>}
      </div>
    </div>
  );
}

// ── Quote Check: upload a dealer quote PDF, get an AI-read breakdown of
// MSRP vs quoted price, flagged add-ons, and warranty analysis. Nothing is
// uploaded to Supabase Storage or saved anywhere -- the file is read in the
// browser, sent once to the edge function for analysis, and discarded.
function QuoteCheckPage(){
  const [status,setStatus]=useState("idle"); // idle | analyzing | done | error
  const [analysis,setAnalysis]=useState(null);
  const [errorMsg,setErrorMsg]=useState("");
  const [fileName,setFileName]=useState("");
  const [dragOver,setDragOver]=useState(false);
  const fileInputRef=useRef(null);

  const ACCEPTED_TYPES=["application/pdf","image/jpeg","image/png","image/webp"];

  const handleFile=async(file)=>{
    if(!file) return;
    if(!ACCEPTED_TYPES.includes(file.type)){
      setStatus("error");
      setErrorMsg("Please upload a PDF, or a clear photo (JPG, PNG, or WEBP) of the quote.");
      return;
    }
    setFileName(file.name);
    setStatus("analyzing");
    setErrorMsg("");

    try{
      const base64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result.split(",")[1]);
        reader.onerror=()=>reject(new Error("Couldn't read that file."));
        reader.readAsDataURL(file);
      });

      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-quote",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({fileBase64:base64,mediaType:file.type}),
      });

      const data=await res.json();
      if(!res.ok||data.error){
        setStatus("error");
        setErrorMsg(data.error||"Something went wrong analyzing that quote.");
        return;
      }
      setAnalysis(data.analysis);
      setStatus("done");
    }catch(err){
      setStatus("error");
      setErrorMsg("Couldn't reach the analysis service. Check your connection and try again.");
    }
  };

  const reset=()=>{
    setStatus("idle");
    setAnalysis(null);
    setErrorMsg("");
    setFileName("");
  };

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{minHeight:"100dvh",background:"#020617",padding:"24px 16px"}}>
        <div style={{maxWidth:640,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:28}}>
            <LogoMark size={34}/>
            <div>
              <div style={{fontWeight:800,fontSize:18,color:"#f1f5f9"}}>LotCheck Quote Check</div>
              <div style={{fontSize:12,color:"#475569"}}>Upload your dealer quote. We'll tell you what's real and what's padding.</div>
            </div>
          </div>

          {status==="idle"&&(
            <div
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);handleFile(e.dataTransfer.files[0]);}}
              onClick={()=>fileInputRef.current?.click()}
              style={{
                border:`2px dashed ${dragOver?"#3b82f6":"#1e293b"}`,
                borderRadius:16,padding:"48px 24px",textAlign:"center",cursor:"pointer",
                background:dragOver?"#0d1e3a":"#0a0f1e",transition:"all 0.15s",
              }}
            >
              <div style={{fontSize:36,marginBottom:12}}>📄</div>
              <div style={{color:"#f1f5f9",fontWeight:700,marginBottom:6}}>Drop your quote here, or snap a photo</div>
              <div style={{color:"#475569",fontSize:13}}>PDF or photo of a paper quote — takes about 15 seconds to analyze</div>
              <input ref={fileInputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" style={{display:"none"}}
                onChange={e=>handleFile(e.target.files[0])}/>
            </div>
          )}

          {status==="analyzing"&&(
            <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:16,padding:"48px 24px",textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:12}}>⏳</div>
              <div style={{color:"#f1f5f9",fontWeight:700,marginBottom:6}}>Reading {fileName}…</div>
              <div style={{color:"#475569",fontSize:13}}>Checking MSRP, add-ons, and warranty terms</div>
            </div>
          )}

          {status==="error"&&(
            <div style={{background:"#2a0f0f",border:"1px solid #7f1d1d",borderRadius:16,padding:"32px 24px",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
              <div style={{color:"#fca5a5",fontWeight:700,marginBottom:8}}>{errorMsg}</div>
              <button onClick={reset} style={{marginTop:8,background:"#0175ff",border:"none",borderRadius:10,padding:"10px 20px",color:"#fff",fontWeight:700,cursor:"pointer"}}>Try again</button>
            </div>
          )}

          {status==="done"&&analysis&&(
            <div>
              <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:16,padding:20,marginBottom:16}}>
                <div style={{fontSize:13,color:"#64748b",marginBottom:4}}>{analysis.vehicle||"Vehicle"}</div>
                <div style={{display:"flex",gap:24,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:11,color:"#475569"}}>MSRP</div>
                    <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{analysis.msrp?`$${analysis.msrp.toLocaleString()}`:"Not shown on quote"}</div>
                  </div>
                  <div>
                    <div style={{fontSize:11,color:"#475569"}}>Quoted price</div>
                    <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{analysis.quotedPrice?`$${analysis.quotedPrice.toLocaleString()}`:"Not found"}</div>
                  </div>
                </div>
              </div>

              {analysis.totalFlaggedCost>0&&(
                <div style={{background:"#2a1a0a",border:"1px solid #7c4a03",borderRadius:16,padding:20,marginBottom:16}}>
                  <div style={{fontSize:13,color:"#fbbf24",fontWeight:700}}>⚠️ ${analysis.totalFlaggedCost.toLocaleString()} in flagged add-ons</div>
                  <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>These are commonly overpriced items worth questioning or negotiating down.</div>
                </div>
              )}

              {analysis.addOns?.length>0&&(
                <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:16,padding:20,marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#94a3b8",marginBottom:12}}>Add-ons & fees</div>
                  {analysis.addOns.map((a,i)=>(
                    <div key={i} style={{padding:"10px 0",borderTop:i>0?"1px solid #1e293b":"none"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{color:"#f1f5f9",fontWeight:600,fontSize:14}}>{a.flagged&&"🔻 "}{a.name}</div>
                        <div style={{color:a.flagged?"#f59e0b":"#94a3b8",fontWeight:700}}>${a.price.toLocaleString()}</div>
                      </div>
                      <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{a.reason}</div>
                    </div>
                  ))}
                </div>
              )}

              {analysis.warranty?.offered&&(
                <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:16,padding:20,marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#94a3b8",marginBottom:8}}>Warranty / protection plan</div>
                  <div style={{color:"#f1f5f9",fontSize:14,marginBottom:4}}>{analysis.warranty.offered}{analysis.warranty.price?` — $${analysis.warranty.price.toLocaleString()}`:""}</div>
                  <div style={{fontSize:12,color:"#64748b"}}>{analysis.warranty.assessment}</div>
                </div>
              )}

              <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:16,padding:20,marginBottom:16}}>
                <div style={{fontSize:13,fontWeight:700,color:"#3b82f6",marginBottom:8}}>Bottom line</div>
                <div style={{color:"#e2e8f0",fontSize:14,lineHeight:1.6}}>{analysis.summary}</div>
              </div>

              <button onClick={reset} style={{width:"100%",background:"#1e293b",border:"none",borderRadius:10,padding:"12px",color:"#e2e8f0",fontWeight:700,cursor:"pointer"}}>Check another quote</button>
            </div>
          )}

          <div style={{textAlign:"center",marginTop:20,fontSize:11,color:"#334155"}}>
            LotCheck never saves your quote to our own systems. It's sent once to Claude (Anthropic's AI) to read and analyze, then discarded on our end — see how this works.
          </div>
        </div>
      </div>
    </>
  );
}


// App is the actual default export/root — it must not call any hooks itself
// (Rules of Hooks), so routing between the buyer-facing site, admin panel,
// and quote-check page happens here by choosing which fully separate
// component to mount, rather than an early-return inside a hook-using component.
export default function App(){
  const path = window.location.pathname;
  return(
    <>
      {path.startsWith("/admin") ? <AdminPanel/>
        : path.startsWith("/quote-check") ? <QuoteCheckPage/>
        : <LotCheckApp/>}
      <Analytics/>
    </>
  );
}

function LotCheckApp(){
  const [showConnect,setShowConnect]=useState(false);
  const [showTestDrive,setShowTestDrive]=useState(false);
  const [selected,setSelected]=useState(null);
  const [province,setProvince]=useState("ALL");
  const [fuelFilter,setFuelFilter]=useState("All");
  const [search,setSearch]=useState("");
  const [isMobile,setIsMobile]=useState(window.innerWidth<768);

  const {listings:liveListings, loading:dataLoading, isLive}=useListings();
  const {historyMap, historyLoading}=usePriceHistoryMap();

  // Log a real page view once per load. Fire-and-forget — a failed insert
  // here shouldn't ever block or slow down the actual site for a visitor.
  useEffect(()=>{
    const visitorId=getOrCreateVisitorId();
    supabase.from("page_views").insert({
      visitor_id: visitorId||"unknown",
      path: window.location.pathname||"/",
      referrer_source: classifyReferrer(),
    }).then(({error})=>{
      if(error) console.warn("⚠️ page_views insert failed:",error.message);
    });
  },[]);

  useEffect(()=>{
    const handler=()=>setIsMobile(window.innerWidth<768);
    window.addEventListener("resize",handler);
    return()=>window.removeEventListener("resize",handler);
  },[]);

  const filtered=liveListings.filter(l=>{
    const q=search.toLowerCase();
    return(province==="ALL"||l.province===province)
      &&(fuelFilter==="All"||l.fuel===fuelFilter)
      &&(l.name.toLowerCase().includes(q)||l.city.toLowerCase().includes(q)||l.make.toLowerCase().includes(q));
  });

  const handleSelect=(listing)=>{
    setSelected(listing);
    if(isMobile)window.scrollTo(0,0);
  };

  if(isMobile&&selected){
    return(
      <>
        <style>{GLOBAL_CSS}</style>
        <div style={{minHeight:"100dvh",background:"#020617"}}>
          <div style={{background:"#060d18",borderBottom:"1px solid #1e293b",padding:"12px 16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:100}}>
            <button onClick={()=>setSelected(null)} style={{background:"#1e293b",border:"none",borderRadius:8,padding:"8px 14px",color:"#e2e8f0",cursor:"pointer",fontSize:14,fontWeight:600}}>← Back</button>
            <div style={{flex:1,fontSize:13,fontWeight:600,color:"#f1f5f9",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selected.name}</div>
          </div>
          <DetailPanel key={selected.id} listing={selected} liveListings={liveListings} history={historyMap[selected.external_id]} historyLoading={historyLoading} onConnect={()=>setShowConnect(true)} onTestDrive={()=>setShowTestDrive(true)}/>
        </div>
        {showConnect&&<ConnectModal listing={selected} onClose={()=>setShowConnect(false)}/>}
        {showTestDrive&&<TestDriveModal listing={selected} onClose={()=>setShowTestDrive(false)}/>}
      </>
    );
  }

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      <div className="lc-layout">
        <LiveBackground/>
        <header className="lc-header">
          <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
            <LogoMark size={32}/>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:800,fontSize:16,letterSpacing:"-0.5px",lineHeight:1}}>LotCheck</div>
              <div style={{fontSize:9,color:"#334155",fontStyle:"italic",whiteSpace:"nowrap"}}>Did you LotCheck it?</div>
            </div>
          </div>
        </header>

        <LiveTicker listings={liveListings} onSelect={handleSelect}/>

        {/* Province filter — uses liveListings so only real provinces show */}
        <div className="lc-provinces">
          {["ALL",...Object.keys(PROVINCES).filter(c=>liveListings.some(l=>l.province===c))].map(code=>(
            <button key={code} className={`lc-province-btn${province===code?" active":""}`} onClick={()=>setProvince(code)}>
              {code==="ALL"?"🇨🇦 All Canada":code}
            </button>
          ))}
        </div>

        <div className="lc-main">
          <div className="lc-sidebar">
            <div className="lc-filters">
              <input className="lc-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search make, model, city…"/>
              <div className="lc-fuel-filters">
                {["All","BEV","PHEV","Hybrid","Gas"].map(f=>(
                  <button key={f} className={`lc-fuel-btn${fuelFilter===f?" active":""}`} onClick={()=>setFuelFilter(f)} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                    {f!=="All"&&<FuelIcon fuel={f} size={12}/>}{f}
                  </button>
                ))}
              </div>
            </div>
            <div className="lc-listings">
              <div style={{fontSize:12,color:"#334155",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
                {dataLoading
                  ?<span style={{color:"#60a5fa",fontWeight:600}}>⏳ Loading live listings…</span>
                  :<>
                    {isLive
                      ?<span className="lc-radar"><span className="lc-radar-ring"/><span className="lc-radar-ring delay"/><span className="lc-radar-core"/></span>
                      :<span style={{color:"#475569"}}>⚪</span>
                    }
                    {filtered.length} listings · {isLive?"Live · Canada":"Demo data"}
                  </>
                }
              </div>
              {dataLoading
                ? Array.from({length:6}).map((_,i)=><SkeletonCard key={i}/>)
                : <>
                    {filtered.length===0&&<div className="lc-empty">No listings match your filters</div>}
                    {filtered.map(l=><ListingCard key={l.id} listing={l} liveListings={liveListings} history={historyMap[l.external_id]} onClick={handleSelect} active={selected?.id===l.id}/>)}
                  </>
              }
            </div>
            <div className="lc-footer">© 2026 LotCheck · lotcheck.ca · "Did you LotCheck it?" ™</div>
          </div>

          <div className="lc-detail">
            {selected?(
              <DetailPanel key={selected.id} listing={selected} liveListings={liveListings} history={historyMap[selected.external_id]} historyLoading={historyLoading} onConnect={()=>setShowConnect(true)} onTestDrive={()=>setShowTestDrive(true)}/>
            ):(
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",color:"#334155",textAlign:"center",padding:"40px 20px"}}>
                <div style={{fontSize:48,marginBottom:16}}>✅</div>
                <div style={{fontSize:18,fontWeight:700,color:"#475569",marginBottom:8}}>Select a listing</div>
                <div style={{fontSize:14,color:"#334155"}}>Choose any car from the left to see price history, rebates, and connect with a dealer</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showConnect&&selected&&<ConnectModal listing={selected} onClose={()=>setShowConnect(false)}/>}
      {showTestDrive&&selected&&<TestDriveModal listing={selected} onClose={()=>setShowTestDrive(false)}/>}
    </>
  );
}
