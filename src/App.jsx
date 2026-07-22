import { useState, useEffect, useRef, useContext, createContext, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from "recharts";
import { createClient } from "@supabase/supabase-js";
import { Analytics } from "@vercel/analytics/react";
import heic2any from "heic2any";

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
  @keyframes lc-gate-drive {
    0%{transform:translate(-95px,-47px);opacity:0;} 10%{opacity:1;} 50%{transform:translate(0,0);} 90%{opacity:1;} 100%{transform:translate(95px,47px);opacity:0;}
  }
  @keyframes lc-gate-flash {
    0%,40%{opacity:.22;} 50%{opacity:.68;} 60%,100%{opacity:.22;}
  }
  .lc-gate-car { animation: lc-gate-drive 4s linear infinite; }
  .lc-gate-window { animation: lc-gate-flash 4s linear infinite; }

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
  @keyframes lc-flagicon-pyramid-spin {
    0% { transform: rotateY(0deg); }
    100% { transform: rotateY(360deg); }
  }
  @keyframes lc-flagicon-flag-wave {
    0%, 100% { transform: skewY(-5deg); }
    50% { transform: skewY(5deg); }
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

// ── Quote Check access -- free and unlimited for now ────────────────────
// There's no license yet to operate this as a paid service, so no pricing
// or paywall should exist until that's resolved. Kept as named functions
// (not inlined at each call site) so turning pricing back on later, once
// licensed, is a one-place change instead of hunting through the file.
function getQuoteCheckAccess() {
  return { allowed: true, reason: "free" };
}
// No-op -- nothing to consume while Quote Check is free and unlimited.
function consumeQuoteCredit() {}

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

// USD -> CAD is a fixed snapshot rate, not a live lookup (1 USD = 1.406 CAD,
// verified July 15 2026). Fine for a rough admin-only cost dashboard where
// amounts are tiny fractions of a cent -- but this will drift from the real
// rate over time and would need a manual update (or a real FX API) if
// precise accounting ever depends on it.
const USD_TO_CAD = 1.406;

// Same bucketing pattern as bucketPageViews, but sums cost_usd per bucket
// instead of counting rows -- used for the admin Costs section's chart.
function bucketApiUsage(usage,granularity){
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
    const inBucket=usage.filter(u=>{
      const t=new Date(u.created_at).getTime();
      return t>=bucketStart&&t<bucketEnd;
    });
    buckets.push({
      label:cfg.label(new Date(bucketStart)),
      cost:inBucket.reduce((s,u)=>s+(Number(u.cost_usd)||0),0),
      requests:inBucket.length,
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
  // A vehicle is used if the caller says so explicitly (listing.condition),
  // OR km > 10,000, OR it's more than 1 model year old. The explicit flag
  // matters for nearly-new used EVs (a demo/lease-return current-year car can
  // have very low km yet still be "used" for EVAP, which is new-only).
  const currentYear = new Date().getFullYear();
  const isUsed = listing.condition==="used" || listing.km > 10000 || (listing.year < currentYear - 1);
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

// ── Hook: fetch real API usage/cost log for the admin Costs section ───────
// Only ever populated by the edge functions' service-role writes -- nothing
// on the buyer-facing site reads or writes this table.
function useApiUsage(){
  const [usage, setUsage] = useState([]);
  const [usageLoading, setUsageLoading] = useState(true);

  useEffect(()=>{
    let cancelled = false;
    async function fetchUsage(){
      try{
        const {data, error} = await supabase
          .from("api_usage_log")
          .select("feature, success, input_tokens, output_tokens, cost_usd, created_at")
          .order("created_at", {ascending:true})
          .limit(50000);
        if(error) throw error;
        if(!cancelled) setUsage(data||[]);
      }catch(err){
        console.warn("⚠️ api_usage_log fetch failed (did you run create_api_usage_log_table.sql?):", err.message);
        if(!cancelled) setUsage([]);
      }finally{
        if(!cancelled) setUsageLoading(false);
      }
    }
    fetchUsage();
    return()=>{cancelled=true;};
  },[]);

  return {usage, usageLoading};
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
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);

  const handleToggle=()=>{
    if(!open&&btnRef.current){
      const r=btnRef.current.getBoundingClientRect();
      const boxWidth=Math.min(300,window.innerWidth-32);
      // Prefer appearing just right of the icon, at the same height -- reads
      // as "attached to" whatever it's explaining rather than floating
      // somewhere unrelated. Clamped so it can never run off any edge of the
      // viewport, at any screen width or zoom level.
      let left=r.right+8;
      if(left+boxWidth>window.innerWidth-16) left=window.innerWidth-boxWidth-16;
      if(left<16) left=16;
      let top=r.top;
      if(top+220>window.innerHeight-16) top=Math.max(16,window.innerHeight-236);
      setPos({top,left,width:boxWidth});
    }
    setOpen(v=>!v);
  };

  return(
    <div style={{position:"relative", display:"inline-block"}}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        style={{background:"none",border:"1px solid #334155",borderRadius:"50%",width:20,height:20,cursor:"pointer",color:"#64748b",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,padding:0}}
        title={title}
      >ℹ</button>
      {open&&pos&&(
        <div style={{position:"fixed",top:pos.top,left:pos.left,width:pos.width,zIndex:200,background:"#0d1526",border:"1px solid #1e3a5f",borderRadius:12,padding:"14px 16px",boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
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

function FlagPyramidIcon({size=14}){
  const s=size;
  return(
    <span style={{display:"inline-flex",perspective:"60px",flexShrink:0,verticalAlign:"middle"}}>
      <svg width={s} height={s} viewBox="0 0 24 24" style={{animation:"lc-flagicon-pyramid-spin 3.2s linear infinite",transformStyle:"preserve-3d"}}>
        <polygon points="12,3 4,20 12,17" fill="#B85D42"/>
        <polygon points="12,3 20,20 12,17" fill="#F2836B"/>
      </svg>
    </span>
  );
}

function FlagWaveIcon({size=14}){
  const s=size;
  return(
    <svg width={s} height={s} viewBox="0 0 24 24" style={{flexShrink:0,verticalAlign:"middle"}}>
      <line x1="5" y1="2" x2="5" y2="21" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round"/>
      <polygon points="6,3 20,7 14,11 20,15 6,11" fill="#F2836B" style={{transformOrigin:"6px 7px",animation:"lc-flagicon-flag-wave 1.4s ease-in-out infinite"}}/>
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
  const hasRealTrend=priceHistory.length>=2;
  const hasSinglePoint=priceHistory.length===1;
  // With only one confirmed price check so far, extend it to today using the
  // listing's current (still-live) price -- this is honest, not fabricated:
  // we genuinely know the price was $X on day one, and the listing is still
  // showing that same price today since nothing has changed it. It's clearly
  // disclosed as limited data below, not presented as a real multi-day trend.
  const firstPrice=hasRealTrend||hasSinglePoint?priceHistory[0].price:currentPrice;
  const change=hasRealTrend||hasSinglePoint?currentPrice-firstPrice:0;
  const firstRecordedDate=hasRealTrend||hasSinglePoint?new Date(priceHistory[0].recorded_at):null;
  const spanDays=hasRealTrend
    ?Math.max(1,Math.round((new Date(priceHistory[priceHistory.length-1].recorded_at)-firstRecordedDate)/86400000))
    :hasSinglePoint
    ?Math.max(1,Math.round((Date.now()-firstRecordedDate)/86400000))
    :0;
  const avgHist=hasRealTrend?Math.round(priceHistory.reduce((s,h)=>s+h.price,0)/priceHistory.length):currentPrice;
  const chartData=hasRealTrend
    ?priceHistory.map(h=>({date:new Date(h.recorded_at).toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:h.price}))
    :hasSinglePoint
    ?[
        {date:firstRecordedDate.toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:firstPrice},
        {date:new Date().toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:currentPrice},
      ]
    :[];
  const domain=hasRealTrend
    ?[Math.round(Math.min(...priceHistory.map(h=>h.price))*0.97),Math.round(Math.max(...priceHistory.map(h=>h.price))*1.03)]
    :hasSinglePoint
    ?[Math.round(Math.min(firstPrice,currentPrice)*0.97),Math.round(Math.max(firstPrice,currentPrice)*1.03)]
    :undefined;

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
        {hasRealTrend
          ? <div style={{fontSize:14,color:change>=0?"#ef4444":"#22c55e",fontWeight:600,marginTop:4}}>{change>=0?"▲":"▼"} ${Math.abs(change).toLocaleString()} ({change>=0?"+":""}{((change/firstPrice)*100).toFixed(1)}%) over {spanDays}d tracked</div>
          : hasSinglePoint
          ? (change!==0
              ? <div style={{fontSize:14,color:change>=0?"#ef4444":"#22c55e",fontWeight:600,marginTop:4}}>{change>=0?"▲":"▼"} ${Math.abs(change).toLocaleString()} since first tracked {spanDays}d ago</div>
              : <div style={{fontSize:12,color:"#475569",fontWeight:500,marginTop:4}}>No price change recorded since first tracked {spanDays}d ago</div>)
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
        {(hasRealTrend||hasSinglePoint)?(
          <div style={{marginBottom:16}}>
            <div style={{height:180}}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{top:4,right:4,bottom:0,left:0}}>
                  <XAxis dataKey="date" tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} tickLine={false} axisLine={false}/>
                  <YAxis domain={domain} tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={42}/>
                  <Tooltip formatter={v=>[`$${v.toLocaleString()}`,"Price"]} contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:13,fontWeight:600,color:"#f1f5f9"}} labelStyle={{color:"#94a3b8",fontSize:11}}/>
                  {hasRealTrend&&<ReferenceLine y={avgHist} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{value:`avg`,fill:"#f59e0b",fontSize:9,position:"insideTopRight"}}/>}
                  <Line type="monotone" dataKey="price" stroke="#16a34a" strokeWidth={2} dot={{r:3}} strokeDasharray={hasSinglePoint?"5 4":undefined}/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            {hasSinglePoint&&(
              <div style={{fontSize:11,color:"#475569",marginTop:6,lineHeight:1.5}}>
                Dashed — based on 1 confirmed price check ({firstRecordedDate.toLocaleDateString("en-CA",{month:"short",day:"numeric"})}) plus today's listed price. A real day-by-day trend will fill in as we track it further.
              </div>
            )}
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
              LotCheck's own estimate, backed by live listings on LotCheck — not an official valuation from a licensed pricing guide.
              <br/><br/>
              Only shown once a similar live listing (<strong style={{color:"#f1f5f9"}}>same model, ±3 years</strong>) exists to compare against — weighted no more than evenly with this car's own asking price, so a couple of comps can never outvote what it's actually listed for. No comps, no number.
              <br/><br/>
              Trade-in and Wholesale are standard dealer-spread percentages off Retail (~80%/72%), not extra discounts on top.
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
        <ScorePill score={score}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
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
  // Real animated gate+car mark, pulled directly from the live homepage --
  // this replaces the old coral cube, which was never updated when the
  // homepage logo changed. viewBox is 145x130 (not perfectly square);
  // width/height are both set to `size` for a clean square footprint at
  // every call site, matching what the coral cube it replaces did.
  return (
    <div style={{ position:"relative", width:size, height:size, overflow:"hidden", borderRadius:size*0.18, flexShrink:0 }}>
      <svg width={size} height={size} viewBox="-95 -45 145 130" aria-hidden="true">
        <polygon points="-50,5 100,80 52,104 -98,29" fill="#D9DBEF"/>
        <polygon points="-4,-26 8,-20 -4,-14 -16,-20" fill="rgb(182,171,228)"/>
        <polygon points="-16,22 -4,28 -4,-14 -16,-20" fill="rgb(158,145,210)"/>
        <polygon points="8,22 -4,28 -4,-14 8,-20" fill="rgb(135,124,179)"/>
        <polygon points="-72,8 -60,14 -72,20 -84,14" fill="rgb(182,171,228)"/>
        <polygon points="-84,56 -72,62 -72,20 -84,14" fill="rgb(158,145,210)"/>
        <polygon points="-60,56 -72,62 -72,20 -60,14" fill="rgb(135,124,179)"/>
        <polygon points="1,-38.5 11,-33.5 -77,10.5 -87,5.5" fill="rgb(194,184,235)"/>
        <polygon points="-87,16.5 -77,21.5 -77,10.5 -87,5.5" fill="rgb(172,160,218)"/>
        <polygon points="11,-22.5 -77,21.5 -77,10.5 11,-33.5" fill="rgb(146,136,185)"/>
        <g className="lc-gate-window"><polygon points="6,17 -82,61 -82,17 6,-27" fill="rgba(59,130,246,.4)"/></g>
        <g className="lc-gate-car">
          <polygon points="-13,33.5 40,60 13,73.5 -40,47" fill="rgba(51,48,90,.10)"/>
          <polygon points="-12,25 34,48 12,59 -34,36" fill="rgb(244,150,130)"/>
          <polygon points="-34,44 12,67 12,59 -34,36" fill="rgb(227,123,100)"/>
          <polygon points="34,56 12,67 12,59 34,48" fill="rgb(193,104,85)"/>
          <polygon points="-5,23.5 17,34.5 1,42.5 -21,31.5" fill="rgb(244,150,130)"/>
          <polygon points="-21,39.5 1,50.5 1,42.5 -21,31.5" fill="rgb(227,123,100)"/>
          <polygon points="17,42.5 1,50.5 1,42.5 17,34.5" fill="rgb(193,104,85)"/>
          <polygon points="17,42.5 1,50.5 1,43.5 17,35.5" fill="#E6F4F6"/>
          <polygon points="-18,40 -1,48.5 -1,43.5 -18,35" fill="#DDEDF2"/>
          <polygon points="-25,43.5 -18,47 -22,49 -29,45.5" fill="rgb(98,93,130)"/>
          <polygon points="-29,50.5 -22,54 -22,49 -29,45.5" fill="rgb(64,59,100)"/>
          <polygon points="-18,52 -22,54 -22,49 -18,47" fill="rgb(55,50,85)"/>
        </g>
      </svg>
    </div>
  );
}

// ── Admin panel colors — LotCheck brand palette, independent of the shared
// dark GLOBAL_CSS theme so this doesn't touch the buyer-facing site ────────
// Two on-brand palettes, not a light theme + a generic navy fallback — dark
// mode is still teal/coral/purple, just recomposed for a dark background.
const LC_THEMES = {
  light: {
    ink:"#33305A", inkSoft:"#5B5885", inkFaint:"#706D96",
    paper:"#FBF5EC", paper2:"#F5EEE1", card:"#FFFFFF",
    line:"rgba(51,48,90,.12)",
    teal:"#2FA79A", tealInk:"#17756B", tealBg:"#E3F4F1",
    coral:"#F2836B", coralInk:"#A63C25", coralBg:"#FDEAE5",
    butter:"#F5C95C", butterInk:"#8A6414", butterBg:"#FDF4DF",
  },
  dark: {
    ink:"#F1EDE0", inkSoft:"#C9C4E8", inkFaint:"#8F8AB8",
    paper:"#1C1A2E", paper2:"#242238", card:"#2A2840",
    line:"rgba(255,255,255,.10)",
    teal:"#3FC2B3", tealInk:"#7FE0D3", tealBg:"rgba(63,194,179,.15)",
    coral:"#F2836B", coralInk:"#FFA88F", coralBg:"rgba(242,131,107,.15)",
    butter:"#F5C95C", butterInk:"#FFD97A", butterBg:"rgba(245,201,92,.15)",
  },
};

const AdminThemeContext = createContext(null);

function useAdminTheme(){
  const ctx = useContext(AdminThemeContext);
  return ctx || { theme:"light", C:LC_THEMES.light, toggleTheme:()=>{} };
}

// Called once at the top of AdminLogin and once at the top of AdminPanel —
// they're mutually exclusive (never both mounted), so each manages its own
// state, backed by the same localStorage key so the choice persists across
// login.
function useThemeState(){
  const [theme,setTheme]=useState(()=>{
    try{ return localStorage.getItem("lc_admin_theme")||"light"; }catch{ return "light"; }
  });
  function toggleTheme(next){
    setTheme(next);
    try{ localStorage.setItem("lc_admin_theme",next); }catch{}
  }
  return { theme, C:LC_THEMES[theme], toggleTheme };
}

function ThemeToggle(){
  const {theme,C,toggleTheme}=useAdminTheme();
  return (
    <div style={{display:"flex",gap:3,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:9,padding:3}}>
      <button onClick={()=>toggleTheme("dark")} style={{
        background: theme==="dark" ? C.ink : "transparent",
        color: theme==="dark" ? C.paper : C.inkFaint,
        border:"none", borderRadius:6, padding:"5px 11px", fontSize:11.5, fontWeight:700, cursor:"pointer",
      }}>🌙 Dark</button>
      <button onClick={()=>toggleTheme("light")} style={{
        background: theme==="light" ? C.card : "transparent",
        color: theme==="light" ? C.ink : C.inkFaint,
        border:"none", borderRadius:6, padding:"5px 11px", fontSize:11.5, fontWeight:700, cursor:"pointer",
        boxShadow: theme==="light" ? "0 1px 4px rgba(51,48,90,.15)" : "none",
      }}>☀️ Bright</button>
    </div>
  );
}

function AdminLogin(){
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);
  const themeState=useThemeState();
  const {C}=themeState;

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
    <AdminThemeContext.Provider value={themeState}>
      <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:C.paper,fontFamily:"'Nunito',Helvetica,Arial,sans-serif",position:"relative"}}>
        <div style={{position:"absolute",top:16,right:16}}><ThemeToggle/></div>
        <form onSubmit={handleLogin} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:20,padding:"40px 36px",width:360,maxWidth:"90vw",textAlign:"center",boxSizing:"border-box",boxShadow:"6px 7px 0 rgba(51,48,90,0.10)"}}>
          <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><LogoMark size={56}/></div>
          <div style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:4}}>LotCheck<sup style={{fontSize:"0.45em",fontWeight:700,marginLeft:2}}>™</sup> Admin</div>
          <div style={{fontSize:13,color:C.inkFaint,marginBottom:24,lineHeight:1.5}}>Real Supabase login — leads data is protected at the database level, not just this screen.</div>
          <input type="email" placeholder="you@lotcheck.ca" value={email} onChange={e=>setEmail(e.target.value)} required
            style={{width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"12px 14px",color:C.ink,fontSize:14,marginBottom:10,outline:"none",boxSizing:"border-box"}}/>
          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required
            style={{width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"12px 14px",color:C.ink,fontSize:14,marginBottom:14,outline:"none",boxSizing:"border-box"}}/>
          {err&&<div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:8,padding:"10px 14px",fontSize:13,color:C.coralInk,marginBottom:14,textAlign:"left"}}>{err}</div>}
          <button type="submit" disabled={loading}
            style={{width:"100%",background:loading?C.tealInk:C.teal,border:"none",borderRadius:12,padding:"13px",color:"#fff",fontFamily:"inherit",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer"}}>
            {loading?"Signing in…":"Sign in →"}
          </button>
        </form>
      </div>
    </AdminThemeContext.Provider>
  );
}

// ── Small shared bits for the new tabs ────────────────────────────────────────
function AdminTabButton({active,onClick,children}){
  const {C}=useAdminTheme();
  return (
    <button onClick={onClick} style={{
      background: active ? C.card : "transparent",
      border: "none", borderRadius: 8, padding: "7px 14px",
      color: active ? C.ink : C.inkFaint, fontSize: 13, fontWeight: 700,
      cursor: "pointer", boxShadow: active ? "0 2px 6px rgba(51,48,90,.12)" : "none",
    }}>{children}</button>
  );
}

function AdminEmpty({icon,children}){
  const {C}=useAdminTheme();
  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"32px 20px",textAlign:"center",color:C.inkFaint}}>
      {icon&&<div style={{fontSize:28,marginBottom:10}}>{icon}</div>}
      {children}
    </div>
  );
}

// ── Dealers tab ────────────────────────────────────────────────────────────
function DealersTab({dealers,dealersLoading,onAdd,onEdit,onToggle,onDelete,dealerListings,dealerListingsLoading,onMarkSold,onPublish}){
  const {C}=useAdminTheme();
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>
          DEALER NETWORK · {dealersLoading?"loading…":`${dealers.length} dealer${dealers.length===1?"":"s"}`}
        </div>
        <button onClick={onAdd} style={{background:C.teal,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer"}}>+ Add Dealer</button>
      </div>

      {dealersLoading ? (
        <div style={{color:C.inkFaint,fontSize:13}}>Loading…</div>
      ) : dealers.length===0 ? (
        <AdminEmpty icon="🏢">No dealers yet — add your first one</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden",marginBottom:28}}>
          {dealers.map(d=>(
            <div key={d.id} style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontWeight:800,color:C.ink,fontSize:14}}>{d.name}</div>
                <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>{d.contact||""} {d.city?`· ${d.city}, ${d.province||""}`:""}</div>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>{d.makes||"—"}</div>
                {d.amvic_number&&(
                  <div style={{fontSize:11,marginTop:4,fontWeight:800,color:d.amvic_verified?C.tealInk:C.butterInk}}>
                    {d.amvic_verified?"✓":"⚠"} AMVIC {d.amvic_number}{!d.amvic_verified&&" -- unverified"}
                  </div>
                )}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:C.inkSoft,cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.live} onChange={e=>onToggle(d.id,"live",e.target.checked)}/> Live lot
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:C.inkSoft,cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.featured} onChange={e=>onToggle(d.id,"featured",e.target.checked)}/> Featured ($300/mo)
                </label>
                {d.sold_count>0 && <span style={{background:C.tealBg,color:C.tealInk,border:`1px solid ${C.teal}55`,borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:800}}>{d.sold_count} sold</span>}
                <button onClick={()=>onEdit(d)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:11,cursor:"pointer"}}>Edit</button>
                <button onClick={()=>onDelete(d.id,d.name)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:11,cursor:"pointer"}}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        DEALER SUBMITTED INVENTORY · {dealerListingsLoading?"loading…":`${dealerListings.length} vehicle${dealerListings.length===1?"":"s"}`}
      </div>
      {dealerListingsLoading ? (
        <div style={{color:C.inkFaint,fontSize:13}}>Loading…</div>
      ) : dealerListings.length===0 ? (
        <AdminEmpty icon="🚗">No dealer submissions yet</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden"}}>
          {dealerListings.map(v=>{
            const isSold=v.status==="sold", isLive=v.status==="live";
            const commission = v.plan==="commission" ? Math.round((v.price||0)*0.01) : 100;
            return (
              <div key={v.id} style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{fontWeight:800,color:C.ink,fontSize:14}}>{v.year} {v.make} {v.model}</div>
                  <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>{v.dealer} · ${(v.price||0).toLocaleString()} · {v.plan==="commission"?"1% commission":"$100/lead"}</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{
                    background: isSold?C.paper2:isLive?C.tealBg:C.paper2,
                    color: isSold?C.ink:isLive?C.tealInk:C.inkFaint,
                    border: `1px solid ${isSold?C.line:isLive?C.teal+"55":C.line}`,
                    borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:800,
                  }}>{isSold?"✓ Sold":isLive?"● Live":"Pending"}</span>
                  {!isSold && <button onClick={()=>onMarkSold(v)} style={{background:"none",border:`1px solid ${C.teal}`,borderRadius:6,padding:"5px 10px",color:C.tealInk,fontSize:11,cursor:"pointer"}}>✓ Mark Sold (${commission.toLocaleString()})</button>}
                  {!isLive && !isSold && <button onClick={()=>onPublish(v.id)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:11,cursor:"pointer"}}>Publish</button>}
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
  const {C}=useAdminTheme();
  return (
    <div>
      <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        PENDING REVIEW · {reviewLoading?"loading…":`${reviewListings.length} listing${reviewListings.length===1?"":"s"}`}
      </div>
      {reviewLoading ? (
        <div style={{color:C.inkFaint,fontSize:13}}>Loading…</div>
      ) : reviewListings.length===0 ? (
        <AdminEmpty icon="✅">No listings pending review — pipeline approved everything</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden",marginBottom:28}}>
          {reviewListings.map(l=>{
            const score=l.verification_score||0;
            const scoreColor = score>=70?C.tealInk:score>=50?C.butterInk:C.coralInk;
            const flags=(l.verification_flags||"").split(" | ").filter(Boolean);
            return (
              <div key={l.id} style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{fontWeight:800,color:C.ink,fontSize:14}}>{l.name}</div>
                  <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>{l.city}, {l.province} · ${(l.price||0).toLocaleString()} · <span style={{color:scoreColor,fontWeight:800}}>{score}</span></div>
                  {flags.map((f,i)=>(<div key={i} style={{fontSize:11,color:C.butterInk,marginTop:2}}>⚠ {f}</div>))}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>onApprove(l.external_id,l.name)} style={{background:"none",border:`1px solid ${C.teal}`,borderRadius:6,padding:"6px 12px",color:C.tealInk,fontSize:12,cursor:"pointer"}}>✓ Approve</button>
                  <button onClick={()=>onReject(l.external_id)} style={{background:"none",border:`1px solid ${C.coral}`,borderRadius:6,padding:"6px 12px",color:C.coralInk,fontSize:12,cursor:"pointer"}}>✗ Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        RECENTLY REJECTED · {rejectedListings.length}
      </div>
      {rejectedListings.length===0 ? (
        <AdminEmpty>No rejected listings yet</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden"}}>
          {rejectedListings.map((l,i)=>(
            <div key={i} style={{padding:"12px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span style={{color:C.ink}}>{l.name}</span>
              <span style={{color:C.coralInk,fontWeight:800}}>{l.verification_score||0}</span>
              <span style={{color:C.inkFaint,fontSize:11}}>{(l.verification_flags||"").split(" | ")[0]||"—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Revenue tab ────────────────────────────────────────────────────────────
function RevenueTab({dealers, apiUsage, apiUsageLoading}){
  const featured = dealers.filter(d=>d.featured);
  const featuredRev = featured.length*300;
  const {C}=useAdminTheme();

  // Manually-entered subscriber count -- there's no real subscription
  // billing system yet (no accounts, no Stripe), so this is a stand-in you
  // type in yourself, not something pulled from real billing data. Labeled
  // as such below rather than presented as if it were live.
  const [subscribers,setSubscribers]=useState(()=>{
    try{ return Number(localStorage.getItem("lc_admin_subscriber_count"))||0; }catch{ return 0; }
  });
  function updateSubscribers(v){
    const n=Math.max(0,Number(v)||0);
    setSubscribers(n);
    try{ localStorage.setItem("lc_admin_subscriber_count",String(n)); }catch{}
  }

  const [costGranularity,setCostGranularity]=useState("day");

  const now=Date.now();
  const rollupCost=(windowMs)=>{
    const cutoff=now-windowMs;
    const inWindow=apiUsage.filter(u=>new Date(u.created_at).getTime()>=cutoff);
    const cost=inWindow.reduce((s,u)=>s+(Number(u.cost_usd)||0),0);
    const succeeded=inWindow.filter(u=>u.success).length;
    return {
      requests: inWindow.length,
      cost,
      successRate: inWindow.length ? Math.round((succeeded/inWindow.length)*100) : null,
    };
  };
  const costToday=rollupCost(24*3600000);
  const costWeek=rollupCost(7*24*3600000);
  const costMonth=rollupCost(30*24*3600000);

  const assumedRevenue = subscribers*9.99;
  const margin = assumedRevenue - costMonth.cost;

  const bucketedCost = bucketApiUsage(apiUsage,costGranularity);

  // Shows both currencies stacked -- USD first (what you're actually billed
  // in) with the CAD estimate underneath in smaller, muted text.
  function CostFigure({usd, size=22, color}){
    return (
      <>
        <div style={{fontSize:size,fontWeight:800,color:color||C.ink}}>${usd.toFixed(4)} <span style={{fontSize:size*0.5,fontWeight:700,color:C.inkFaint}}>USD</span></div>
        <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>≈ ${(usd*USD_TO_CAD).toFixed(4)} CAD</div>
      </>
    );
  }

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:24}}>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:C.tealInk}}>${featuredRev.toLocaleString()}</div>
          <div style={{fontSize:12,color:C.inkFaint}}>Featured listings/mo — real</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:C.inkFaint}}>$0</div>
          <div style={{fontSize:12,color:C.inkFaint}}>Lead referral fees</div>
        </div>
      </div>
      <AdminEmpty>
        Lead referral revenue shows $0 on purpose — leads aren't linked to a
        specific dealer yet (the buyer-facing Connect form doesn't set
        <code style={{background:C.paper2,padding:"1px 5px",borderRadius:4,margin:"0 4px"}}>dealer_id</code>
        when someone submits it). The database column exists now, but wiring
        the actual attribution is a separate follow-up task.
      </AdminEmpty>
      {featured.length>0 && (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden",marginTop:20,marginBottom:28}}>
          {featured.map(d=>(
            <div key={d.id} style={{padding:"12px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",fontSize:13}}>
              <span style={{color:C.ink}}>{d.name}</span>
              <span style={{color:C.tealInk,fontWeight:800}}>$300/mo</span>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:2}}>
        QUOTE CHECK COST · {apiUsageLoading?"loading…":`${apiUsage.length} logged call${apiUsage.length===1?"":"s"}`}
      </div>
      <div style={{fontSize:11,color:C.inkFaint,marginBottom:10}}>USD is what you're actually billed — CAD is an estimate at a fixed 1 USD = {USD_TO_CAD} CAD rate (July 15, 2026), not a live conversion.</div>
      {!apiUsageLoading&&apiUsage.length===0?(
        <AdminEmpty icon="📊">
          No usage logged yet — this fills in the moment someone runs a real quote through Quote Check, once the analyze-quote function's logging is live.
        </AdminEmpty>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
            {[["Today",costToday],["Last 7 days",costWeek],["Last 30 days",costMonth]].map(([label,stats])=>(
              <div key={label} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
                <div style={{fontSize:12,color:C.inkFaint,marginBottom:6}}>{label}</div>
                <CostFigure usd={stats.cost}/>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:6}}>{stats.requests} request{stats.requests===1?"":"s"}{stats.successRate!=null?` · ${stats.successRate}% succeeded`:""}</div>
              </div>
            ))}
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>Cost over time</div>
              <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                {[["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                  <button key={key} onClick={()=>setCostGranularity(key)}
                    style={{background:costGranularity===key?C.tealBg:"transparent",color:costGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{height:180}}>
              <ResponsiveContainer>
                <BarChart data={bucketedCost} margin={{top:4,right:4,bottom:0,left:0}}>
                  <XAxis dataKey="label" tick={{fontSize:10,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                  <YAxis tick={{fontSize:11,fill:C.inkFaint}} tickLine={false} axisLine={false} width={50} tickFormatter={v=>`$${v.toFixed(2)}`}/>
                  <Tooltip formatter={(v)=>[`$${Number(v).toFixed(4)} USD · $${(Number(v)*USD_TO_CAD).toFixed(4)} CAD`,"Cost"]} contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#fff"}} labelStyle={{color:"#D9DBEF",fontSize:11}}/>
                  <Bar dataKey="cost" radius={[3,3,0,0]} fill={C.teal}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:10}}>Cost vs. subscription — estimate</div>
            <div style={{fontSize:11,color:C.inkFaint,marginBottom:12,lineHeight:1.5}}>
              There's no real subscriber billing yet — type in a subscriber count to see an estimated margin. This is a manual stand-in, not live billing data.
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <label style={{fontSize:12,color:C.inkSoft,whiteSpace:"nowrap"}}>Subscribers at $9.99/mo:</label>
              <input type="number" min="0" value={subscribers} onChange={e=>updateSubscribers(e.target.value)}
                style={{width:90,background:C.paper,border:`2px solid ${C.line}`,borderRadius:8,padding:"6px 10px",color:C.ink,fontSize:13,outline:"none"}}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
              <div>
                <div style={{fontSize:18,fontWeight:800,color:C.ink}}>${assumedRevenue.toFixed(2)} <span style={{fontSize:11,fontWeight:700,color:C.inkFaint}}>USD</span></div>
                <div style={{fontSize:11,color:C.inkFaint}}>≈ ${(assumedRevenue*USD_TO_CAD).toFixed(2)} CAD</div>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:4}}>Assumed monthly revenue</div>
              </div>
              <div>
                <CostFigure usd={costMonth.cost} size={18}/>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:4}}>Actual cost, last 30 days</div>
              </div>
              <div>
                <CostFigure usd={Math.abs(margin)} size={18} color={margin>=0?C.tealInk:C.coralInk}/>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:4}}>Estimated margin{margin<0?" (loss)":""}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Quote Check pricing tiers -- kept for cost/revenue modeling in this tab
// only. The live paywall that used to charge these prices was removed
// (no license to operate a paid service yet, see getQuoteCheckAccess),
// so these figures are hypothetical -- "what this would earn if pricing
// were live" -- not real revenue right now.
const QC_PRICING_TIERS = [
  {key:"single", name:"1 check", price:2.99, quotesPerUnit:1},
  {key:"five", name:"5 checks", price:9.99, quotesPerUnit:5},
  {key:"ten", name:"10 checks", price:14.99, quotesPerUnit:10},
  {key:"sub", name:"25 / month", price:9.99, quotesPerUnit:25},
];
const QC_COST_PER_QUOTE = 0.0277; // current intro-pricing cost per quote check

function ProfitTrackerTab(){
  const {C}=useAdminTheme();
  const [period,setPeriod]=useState("month");

  // Sample placeholder counts -- there's no purchase-logging table yet, so
  // nothing tracks real sales per tier. These exist purely so the layout is
  // reviewable with realistic-looking numbers; swap this object for a real
  // query against a purchase-events table once one exists, keyed the same
  // way (day/week/month/year -> [single,five,ten,sub] counts).
  const SAMPLE_COUNTS = {
    day:   [8, 3, 1, 0],
    week:  [52, 19, 7, 2],
    month: [210, 76, 28, 9],
    year:  [1840, 612, 201, 64],
  };

  const round2 = (n) => Math.round(n*100)/100;
  const fmt = (n) => n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});

  const counts = SAMPLE_COUNTS[period];
  // Round each row's USD and CAD figures BEFORE summing for the totals row,
  // not after -- summing unrounded floats and rounding only the total can
  // land a cent away from what someone gets manually adding the displayed
  // rows, in either currency. Verified this stays consistent across all 4
  // periods and both currencies before shipping this.
  let totalCount=0, totalRevUsd=0, totalRevCad=0, totalProfitUsd=0, totalProfitCad=0;
  const rows = QC_PRICING_TIERS.map((tier,i)=>{
    const count = counts[i];
    const revenueUsd = round2(tier.price*count);
    const revenueCad = round2(revenueUsd*USD_TO_CAD);
    const costUsd = tier.quotesPerUnit*count*QC_COST_PER_QUOTE;
    const profitUsd = round2(revenueUsd-costUsd);
    const profitCad = round2(profitUsd*USD_TO_CAD);
    totalCount+=count; totalRevUsd+=revenueUsd; totalRevCad+=revenueCad;
    totalProfitUsd+=profitUsd; totalProfitCad+=profitCad;
    return {...tier,count,revenueUsd,revenueCad,profitUsd,profitCad};
  });

  const th={textAlign:"right",fontSize:10,color:C.inkFaint,fontWeight:800,padding:"8px 10px",borderBottom:`1px solid ${C.line}`,letterSpacing:0.4};
  const td={textAlign:"right",padding:"12px 10px",borderBottom:`1px solid ${C.line}`};

  return (
    <div>
      <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>QUOTE CHECK PROFIT</div>
      <div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:10,padding:"10px 14px",fontSize:12,color:C.coralInk,fontWeight:700,marginBottom:16,lineHeight:1.5}}>
        ⚠ "Checks sold" below are sample placeholders, not real data -- there's no purchase-logging table yet, so nothing tracks actual sales per tier today. The pricing and profit math itself is real and will be correct the moment real counts flow in.
      </div>

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>Checks sold & profit</div>
          <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
            {[["day","Day"],["week","Week"],["month","Month"],["year","Year"]].map(([key,label])=>(
              <button key={key} onClick={()=>setPeriod(key)}
                style={{background:period===key?C.tealBg:"transparent",color:period===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead>
            <tr>
              <th style={{...th,textAlign:"left"}}>TIER</th>
              <th style={th}>CHECKS SOLD</th>
              <th style={th}>REVENUE</th>
              <th style={th}>PROFIT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r=>(
              <tr key={r.key}>
                <td style={{padding:"12px 10px",borderBottom:`1px solid ${C.line}`}}>
                  <div style={{fontSize:13,fontWeight:800,color:C.ink}}>{r.name}</div>
                  <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>${r.price.toFixed(2)} each</div>
                </td>
                <td style={{...td,fontFamily:"monospace",fontSize:14,fontWeight:700,color:C.ink}}>{r.count.toLocaleString()}</td>
                <td style={td}>
                  <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:C.ink}}>${fmt(r.revenueUsd)}</div>
                  <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>${fmt(r.revenueCad)} CAD</div>
                </td>
                <td style={td}>
                  <div style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:C.tealInk}}>${fmt(r.profitUsd)}</div>
                  <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>${fmt(r.profitCad)} CAD</div>
                </td>
              </tr>
            ))}
            <tr style={{background:C.paper2}}>
              <td style={{padding:"12px 10px",fontWeight:800,color:C.butterInk,fontSize:13}}>Total</td>
              <td style={{textAlign:"right",padding:"12px 10px",fontFamily:"monospace",fontSize:14,fontWeight:800,color:C.ink}}>{totalCount.toLocaleString()}</td>
              <td style={{textAlign:"right",padding:"12px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:C.ink}}>${fmt(totalRevUsd)}</div>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>${fmt(totalRevCad)} CAD</div>
              </td>
              <td style={{textAlign:"right",padding:"12px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:C.tealInk}}>${fmt(totalProfitUsd)}</div>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>${fmt(totalProfitCad)} CAD</div>
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{fontSize:11,color:C.inkFaint,marginTop:12,lineHeight:1.6}}>
          Profit basis: ${QC_COST_PER_QUOTE} USD cost per quote check (current intro API pricing) × checks actually delivered per tier -- e.g. a "5 checks" bundle costs 5× that per unit sold. CAD figures use the same fixed {USD_TO_CAD} snapshot rate already used above in Cost over time, not a live rate.
        </div>
      </div>
    </div>
  );
}

function DealerModal({dealer,onSave,onClose}){
  const [form,setForm]=useState(dealer||{name:"",contact:"",phone:"",email:"",city:"",province:"AB",makes:"",notes:"",live:false,featured:false,amvic_number:"",amvic_verified:false,amvic_verified_at:null});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const {C}=useAdminTheme();
  const inputStyle={width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"11px 13px",color:C.ink,fontSize:13,marginBottom:10,outline:"none",boxSizing:"border-box"};
  const labelStyle={fontSize:11,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:0.4,marginBottom:5,display:"block"};

  // Format sanity-check only -- confirmed from 2 real AMVIC business
  // licence numbers found in an actual public AMVIC document (e.g.
  // "B1022490": a "B" followed by 7 digits). Not a hard validation gate,
  // since 2 examples isn't enough to be confident this covers every
  // licence class AMVIC issues -- an unexpected format shouldn't block
  // saving, just prompt a second look.
  const amvicTrimmed=(form.amvic_number||"").trim();
  const amvicFormatLooksRight=amvicTrimmed==="" || /^B\d{7}$/i.test(amvicTrimmed);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(51,48,90,.45)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:28,width:"100%",maxWidth:440,maxHeight:"90vh",overflowY:"auto",boxSizing:"border-box",boxShadow:"6px 7px 0 rgba(51,48,90,0.10)"}}>
        <div style={{fontSize:18,fontWeight:800,marginBottom:18,color:C.ink}}>{dealer?"Edit Dealer":"Add Dealer"}</div>
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

        <div style={{background:C.paper,border:`1.5px solid ${C.line}`,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
          <label style={labelStyle}>AMVIC business licence number</label>
          <input
            style={{...inputStyle,marginBottom:6,borderColor:amvicTrimmed&&!amvicFormatLooksRight?C.coral:C.line}}
            value={form.amvic_number}
            onChange={e=>set("amvic_number",e.target.value.toUpperCase())}
            placeholder="B1022490"
          />
          {amvicTrimmed&&!amvicFormatLooksRight&&(
            <div style={{fontSize:11,color:C.coralInk,marginBottom:8,lineHeight:1.4}}>
              Doesn't match the usual AMVIC format (a "B" followed by 7 digits) -- that's only based on 2 confirmed real examples though, so this isn't a hard block. Worth a second look before saving.
            </div>
          )}
          <div style={{fontSize:11,color:C.inkFaint,marginBottom:10,lineHeight:1.5}}>
            AMVIC has no public API to auto-verify this against -- a correctly formatted number isn't proof of an active licence. Check it yourself:
          </div>
          <a href="https://amvic.ca.thentiacloud.net/webs/amvic/register/" target="_blank" rel="noreferrer"
            style={{fontSize:12,fontWeight:800,color:C.tealInk,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:5,marginBottom:12}}>
            Verify on AMVIC's public search →
          </a>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.inkSoft,cursor:"pointer"}}>
            <input type="checkbox" checked={!!form.amvic_verified} onChange={e=>set("amvic_verified",e.target.checked)}/>
            I checked AMVIC's public search and confirmed this licence is active
          </label>
          {form.amvic_verified&&form.amvic_verified_at&&(
            <div style={{fontSize:11,color:C.tealInk,marginTop:6}}>
              ✓ Verified {new Date(form.amvic_verified_at).toLocaleDateString("en-CA")}
            </div>
          )}
        </div>

        <label style={labelStyle}>Notes</label>
        <input style={inputStyle} value={form.notes} onChange={e=>set("notes",e.target.value)} placeholder="Met at Costco"/>
        <div style={{display:"flex",gap:16,marginBottom:16,marginTop:6}}>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.inkSoft,cursor:"pointer"}}>
            <input type="checkbox" checked={form.live} onChange={e=>set("live",e.target.checked)}/> Live lot
          </label>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.inkSoft,cursor:"pointer"}}>
            <input type="checkbox" checked={form.featured} onChange={e=>set("featured",e.target.checked)}/> Featured ($300/mo)
          </label>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,background:"none",border:`1px solid ${C.line}`,borderRadius:10,padding:11,color:C.inkSoft,fontSize:14,cursor:"pointer"}}>Cancel</button>
          <button onClick={()=>{ if(!form.name.trim()){alert("Dealer name is required");return;} onSave(form); }}
            style={{flex:1,background:C.teal,border:"none",borderRadius:10,padding:11,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>Save Dealer →</button>
        </div>
      </div>
    </div>
  );
}
// ── Visitor location map ──────────────────────────────────────────────────
// Simplified North America outline (Natural Earth 110m admin-0 countries,
// public domain, naturalearthdata.com), pre-processed into flat SVG path
// strings so this needs zero external map libraries or API calls -- same
// "build it in-house" approach as the landing page's Canvas charts.
// Projection is a plain equirectangular transform (straightforward lon/lat
// -> x/y), verified against real city coordinates (Calgary, Toronto,
// Vancouver, Winnipeg, Ottawa) landing in geographically correct relative
// positions before this was embedded.
const MAP_SCALE=4;
const MAP_LON_OFFSET=175;
const MAP_LAT_OFFSET=85;
const CANADA_PATH="M208.6,144.0 L197.5,138.3 L190.3,136.7 L188.6,130.7 L183.5,129.0 L182.8,125.8 L177.9,122.8 L180.0,116.3 L173.2,113.8 L158.1,100.8 L150.2,104.4 L143.8,100.0 L136.0,98.8 L136.1,61.2 L154.0,64.4 L180.8,59.2 L183.6,60.9 L187.4,58.1 L197.0,62.1 L202.3,59.4 L202.8,62.4 L214.1,60.8 L239.0,64.4 L244.4,66.4 L238.8,68.4 L246.0,69.2 L260.2,68.1 L264.5,70.5 L268.8,68.5 L264.7,66.8 L267.3,65.4 L275.4,64.8 L294.2,69.4 L306.2,68.9 L305.8,66.4 L309.3,65.7 L315.5,67.0 L315.5,70.8 L318.0,67.6 L321.3,67.7 L323.1,63.7 L314.1,59.6 L314.4,55.2 L319.2,52.3 L328.5,54.7 L333.9,59.2 L330.4,61.2 L337.8,62.0 L337.8,66.1 L343.1,63.0 L347.9,65.5 L346.7,68.5 L350.6,71.2 L357.7,64.9 L357.9,60.5 L369.5,61.4 L374.9,63.4 L372.1,67.5 L375.0,69.6 L374.5,71.6 L366.6,74.4 L356.9,73.8 L350.7,80.9 L337.2,85.6 L336.9,88.2 L332.3,88.7 L323.0,96.4 L321.3,104.2 L327.1,104.9 L330.8,111.7 L336.4,110.9 L360.0,118.8 L370.9,119.4 L371.5,126.9 L380.3,135.2 L385.6,129.8 L380.7,121.3 L387.1,119.5 L393.8,113.9 L390.8,107.8 L385.9,104.8 L390.7,100.6 L387.6,90.7 L404.6,90.2 L414.5,95.5 L421.6,95.8 L422.8,104.2 L429.4,107.2 L435.2,104.9 L441.7,98.7 L454.4,112.1 L452.8,114.6 L470.7,121.5 L472.3,124.9 L477.0,126.9 L477.3,131.4 L459.9,139.0 L434.4,139.1 L415.6,152.7 L425.4,146.8 L439.8,143.1 L443.3,145.0 L439.5,147.7 L442.1,155.0 L447.3,157.0 L453.9,156.5 L457.9,152.0 L460.8,156.3 L438.5,165.8 L435.5,165.5 L435.4,162.1 L442.3,158.8 L431.5,159.4 L428.8,157.2 L428.8,151.7 L423.1,150.2 L414.0,160.0 L400.5,160.0 L392.7,165.5 L385.1,165.5 L383.3,166.1 L384.2,168.5 L370.2,173.3 L367.4,172.1 L371.4,165.7 L369.8,158.6 L346.5,146.8 L333.4,147.4 L322.7,145.3 L320.7,142.4 L319.4,144.0 L208.6,144.0Z M377.0,51.8 L388.7,49.0 L403.1,52.9 L403.6,54.7 L411.0,53.8 L424.9,57.9 L432.1,63.3 L424.8,65.1 L452.6,72.6 L444.3,80.0 L433.1,74.4 L427.9,74.9 L427.4,77.2 L438.7,82.5 L441.3,86.4 L439.9,89.3 L424.9,85.0 L435.3,92.3 L424.5,90.7 L400.7,81.3 L389.2,83.1 L385.8,81.7 L388.4,78.8 L404.2,78.2 L404.2,74.8 L409.4,70.9 L406.8,67.7 L392.5,64.4 L395.1,63.4 L384.2,59.3 L374.8,61.0 L345.3,58.4 L341.9,57.0 L346.1,55.1 L340.4,55.1 L339.2,51.1 L346.4,45.8 L356.7,44.8 L353.8,47.4 L356.9,49.9 L360.6,46.6 L370.7,45.0 L377.6,49.1 L377.0,51.8Z M333.7,12.4 L358.0,9.4 L367.3,10.7 L370.3,8.6 L382.8,7.5 L452.6,9.5 L429.4,14.0 L438.1,14.0 L415.3,20.8 L392.4,22.7 L397.9,23.2 L395.1,23.9 L398.4,25.9 L381.0,31.2 L388.4,32.9 L377.8,35.3 L342.0,34.1 L341.5,32.2 L348.9,31.3 L347.0,28.4 L360.1,29.8 L348.2,26.5 L359.6,22.6 L352.3,19.0 L372.6,18.1 L349.6,17.9 L333.7,12.4Z M266.4,47.6 L278.4,49.3 L282.1,56.0 L296.1,59.9 L295.6,61.7 L289.1,62.0 L291.6,63.5 L290.3,65.0 L276.2,63.3 L246.7,65.9 L230.6,60.2 L250.3,58.5 L228.4,57.8 L226.3,56.4 L235.5,54.8 L222.4,53.8 L228.5,49.2 L239.2,46.7 L243.3,47.5 L241.3,49.4 L250.2,48.2 L255.8,50.2 L260.3,48.2 L267.2,53.4 L269.3,51.7 L266.4,47.6Z M200.3,42.8 L229.8,43.3 L238.0,46.1 L223.1,49.9 L218.2,54.5 L207.6,56.4 L196.3,52.5 L204.2,45.3 L200.3,42.8Z M313.2,19.4 L322.8,16.1 L321.1,15.2 L330.4,15.0 L348.8,18.7 L356.7,22.7 L343.9,26.9 L328.5,26.6 L324.2,25.0 L327.4,22.5 L320.1,22.5 L313.2,19.4Z";
const US_PATH="M208.6,144.0 L319.4,144.0 L320.7,142.4 L322.7,145.3 L333.4,147.4 L346.5,146.8 L369.8,158.6 L371.4,165.7 L367.5,171.7 L369.2,173.3 L384.2,168.5 L383.3,166.1 L385.1,165.5 L392.7,165.5 L400.5,160.0 L414.0,160.0 L423.1,150.2 L428.8,151.7 L428.8,157.2 L432.1,160.8 L419.5,165.3 L416.7,170.7 L420.1,173.5 L405.2,176.3 L412.2,176.3 L404.2,177.0 L400.4,184.2 L397.9,182.0 L399.8,186.4 L396.2,191.1 L397.1,188.3 L394.6,183.4 L394.7,187.7 L392.0,187.0 L394.8,188.3 L397.1,197.8 L374.7,214.2 L374.7,219.9 L379.8,232.5 L378.5,239.2 L375.3,239.2 L373.2,236.5 L365.2,220.3 L359.6,221.5 L354.4,218.4 L341.6,219.4 L342.4,223.4 L327.1,220.9 L321.2,222.1 L311.4,228.7 L311.4,236.5 L309.9,236.6 L303.9,234.5 L296.2,222.5 L290.1,221.0 L287.6,224.1 L284.2,222.9 L274.0,213.0 L255.9,214.7 L241.1,209.1 L231.5,209.9 L225.9,203.9 L217.5,201.6 L202.4,178.7 L201.9,168.9 L204.4,157.9 L201.3,147.3 L207.5,147.8 L209.7,151.6 L208.6,144.0Z M136.1,61.2 L136.0,98.8 L143.8,100.0 L150.2,104.4 L158.1,100.8 L173.2,113.8 L180.0,116.3 L177.9,120.8 L172.1,118.0 L163.7,107.5 L153.5,107.2 L140.5,101.8 L111.5,96.5 L107.1,97.3 L107.9,100.1 L93.1,103.4 L94.4,97.1 L98.6,95.9 L97.5,94.9 L83.9,102.6 L86.8,104.5 L83.1,107.4 L66.3,116.0 L40.2,121.7 L65.3,111.9 L69.1,109.7 L71.8,104.3 L63.8,106.3 L58.6,103.7 L52.1,105.3 L52.5,101.5 L49.9,100.0 L44.7,100.8 L38.6,98.0 L35.5,94.0 L37.1,91.7 L41.7,87.4 L56.9,84.9 L53.9,82.4 L56.9,80.8 L40.2,82.2 L27.6,77.3 L42.1,73.7 L45.4,73.7 L44.8,75.7 L53.3,75.5 L32.9,66.6 L35.2,64.5 L42.3,64.3 L52.4,58.7 L73.7,54.6 L82.6,57.2 L136.1,61.2Z M87.1,108.1 L91.4,109.6 L84.0,113.1 L81.9,112.0 L81.3,110.2 L87.1,108.1Z M13.1,84.9 L18.0,85.2 L25.2,86.8 L21.9,88.1 L13.8,86.7 L13.1,84.9Z M76.6,258.9 L80.8,262.0 L77.2,264.3 L75.7,261.2 L76.6,258.9Z M30.2,99.1 L37.3,98.8 L37.7,100.4 L30.2,99.1Z";
const MEXICO_PATH="M231.5,209.9 L241.1,209.1 L255.9,214.7 L274.0,213.0 L284.2,222.9 L287.6,224.1 L290.1,221.0 L293.4,220.9 L303.9,234.5 L311.4,236.5 L308.5,250.2 L316.4,264.7 L322.3,267.4 L334.4,264.5 L336.9,262.9 L338.9,256.0 L351.8,253.8 L352.6,256.6 L348.7,267.0 L336.0,268.7 L336.0,271.0 L334.2,271.0 L338.1,275.7 L333.0,275.7 L331.1,281.8 L324.5,276.2 L313.8,277.4 L286.0,266.8 L278.0,260.2 L278.9,254.3 L275.9,248.9 L251.1,224.2 L247.4,215.3 L240.9,212.8 L240.3,214.4 L241.3,219.3 L253.5,233.3 L257.4,242.8 L262.4,246.5 L260.6,248.7 L251.3,241.0 L250.8,236.0 L239.8,229.1 L243.4,225.7 L237.9,221.8 L231.5,209.9Z";

function projectLatLng(lat,lon){
  return[
    Math.round((lon+MAP_LON_OFFSET)*MAP_SCALE*10)/10,
    Math.round((MAP_LAT_OFFSET-lat)*MAP_SCALE*10)/10,
  ];
}

// Groups raw page_views rows (each with a lat/long from Vercel's built-in
// geolocation) into visit counts per rounded coordinate -- rounding to ~1
// decimal degree groups visitors from the same metro area together into
// one dot sized by volume, rather than showing hundreds of overlapping
// single-visit points.
function groupVisitsByLocation(pageViews){
  const groups=new Map();
  for(const v of pageViews){
    if(v.latitude==null||v.longitude==null)continue;
    const key=`${Math.round(v.latitude*2)/2},${Math.round(v.longitude*2)/2}`;
    if(!groups.has(key)){
      groups.set(key,{lat:v.latitude,lon:v.longitude,count:0,city:v.city,country:v.country});
    }
    groups.get(key).count++;
  }
  return[...groups.values()].sort((a,b)=>b.count-a.count);
}

function VisitorMap({pageViews}){
  const located=pageViews.filter(v=>v.latitude!=null&&v.longitude!=null);
  const locations=groupVisitsByLocation(pageViews);
  const maxCount=locations.length?Math.max(...locations.map(l=>l.count)):1;
  const {C}=useAdminTheme();

  if(!located.length){
    return(
      <div style={{textAlign:"center",padding:"32px 16px",color:C.inkFaint}}>
        <div style={{fontSize:26,marginBottom:8}}>🗺️</div>
        <div style={{fontWeight:700,color:C.inkSoft,marginBottom:4}}>No located visits yet</div>
        <div style={{fontSize:12}}>Geolocation just went live — every visit before this update was recorded without it. This fills in from here forward.</div>
      </div>
    );
  }

  return(
    <div>
      <div style={{position:"relative",width:"100%",maxWidth:640,margin:"0 auto"}}>
        <svg viewBox="0 0 500 300" style={{width:"100%",height:"auto",display:"block"}}>
          <path d={US_PATH} fill="#F5EEE1" stroke="#33305A22" strokeWidth="1"/>
          <path d={MEXICO_PATH} fill="#F5EEE1" stroke="#33305A22" strokeWidth="1"/>
          <path d={CANADA_PATH} fill="#E3F4F1" stroke="#2FA79A" strokeWidth="1.5"/>
          {locations.map((loc,i)=>{
            const[x,y]=projectLatLng(loc.lat,loc.lon);
            const r=3+Math.sqrt(loc.count/maxCount)*9;
            if(x<0||x>500||y<0||y>300)return null; // outside NA view -- skip rather than mis-plot
            return(
              <circle key={i} cx={x} cy={y} r={r} fill="#F2836B" fillOpacity={0.55} stroke="#F2836B" strokeWidth="1">
                <title>{loc.city||"Unknown"}{loc.country?`, ${loc.country}`:""} — {loc.count} visit{loc.count===1?"":"s"}</title>
              </circle>
            );
          })}
        </svg>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.inkFaint,marginTop:8,maxWidth:640,margin:"8px auto 0"}}>
        <span>{located.length.toLocaleString()} of {pageViews.length.toLocaleString()} visits located</span>
        <span>Dot size = relative visit volume</span>
      </div>
      <div style={{marginTop:16,maxWidth:640,margin:"16px auto 0"}}>
        <div style={{fontSize:12,fontWeight:800,color:C.inkFaint,marginBottom:8}}>Top locations</div>
        {locations.slice(0,8).map((loc,i)=>{
          const pct=Math.round((loc.count/located.length)*100);
          return(
            <div key={i} style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:2}}>
                <span style={{color:C.ink,fontWeight:700}}>{loc.city||"Unknown"}{loc.country?`, ${loc.country}`:""}</span>
                <span style={{color:C.inkFaint}}>{loc.count} · {pct}%</span>
              </div>
              <div style={{background:C.paper2,borderRadius:4,height:5,overflow:"hidden"}}>
                <div style={{width:`${pct}%`,height:"100%",background:"#2FA79A"}}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminPanel(){
  const [session,setSession]=useState(null);
  const [checkingSession,setCheckingSession]=useState(true);
  const [tab,setTab]=useState("overview");

  const [reportLeads,setReportLeads]=useState([]);
  const [reportLeadsLoading,setReportLeadsLoading]=useState(true);
  const [pageViews,setPageViews]=useState([]);
  const [trafficGranularity,setTrafficGranularity]=useState("day");
  const [viewsLoading,setViewsLoading]=useState(true);
  const {listings:liveListings, loading:listingsLoading}=useListings();
  const {historyMap}=usePriceHistoryMap();
  const {usage:apiUsage, usageLoading:apiUsageLoading}=useApiUsage();
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
    if(!session){ setReportLeads([]); return; }
    let cancelled=false;
    async function fetchReportLeads(){
      setReportLeadsLoading(true);
      try{
        const {data,error}=await supabase.from("quote_report_leads").select("*").order("created_at",{ascending:false}).limit(500);
        if(error) throw error;
        if(!cancelled) setReportLeads(data||[]);
      }catch(err){
        console.warn("⚠️ report leads fetch failed:",err.message);
        if(!cancelled) setReportLeads([]);
      }finally{
        if(!cancelled) setReportLeadsLoading(false);
      }
    }
    fetchReportLeads();
    return()=>{cancelled=true;};
  },[session]);

  useEffect(()=>{
    if(!session){ setPageViews([]); return; }
    let cancelled=false;
    async function fetchViews(){
      setViewsLoading(true);
      try{
        const {data,error}=await supabase.from("page_views").select("created_at, visitor_id, referrer_source, city, country, latitude, longitude").order("created_at",{ascending:true}).limit(50000);
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

  function exportReportLeadsCsv(){
    const rows=[["email","source","created_at"],...reportLeads.map(l=>[l.email,l.source||"",l.created_at])];
    const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`lotcheck-report-emails-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveDealer(form){
    const payload={
      name:form.name.trim(), contact:form.contact?.trim()||null, phone:form.phone?.trim()||null,
      email:form.email?.trim()||null, city:form.city?.trim()||null, province:form.province||null,
      makes:form.makes?.trim()||null, notes:form.notes?.trim()||null,
      live:!!form.live, featured:!!form.featured,
      amvic_number:form.amvic_number?.trim()||null,
      amvic_verified:!!form.amvic_verified,
      amvic_verified_at:form.amvic_verified?(form.amvic_verified_at||new Date().toISOString()):null,
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
    // Also pull it off the live buyer-facing site -- without this, a sold car
    // stays visible and contactable on lotcheck.ca even though dealer_listings
    // itself correctly shows "sold" here in admin.
    const {error:listingsError}=await supabase.from("listings").update({status:"sold"}).eq("external_id",`dealer-${v.id}`);
    if(listingsError) console.warn("⚠️ Couldn't remove sold dealer listing from the live site:",listingsError.message);
    const dealerIdx=dealers.findIndex(d=>d.name===v.dealer);
    if(dealerIdx>=0){
      await supabase.from("dealers").update({sold_count:(dealers[dealerIdx].sold_count||0)+1}).eq("id",dealers[dealerIdx].id);
      fetchDealers();
    }
    fetchDealerListings();
  }

  async function publishDealerListing(id){
    const v = dealerListings.find(d=>d.id===id);
    if(!v){ alert("Couldn't find that listing to publish."); return; }
    const externalId = `dealer-${id}`;
    const row = {
      external_id: externalId,
      name: `${v.year} ${v.make} ${v.model}${v.trim?" "+v.trim:""}`,
      make: v.make, model: v.model, year: v.year,
      price: v.price, km: v.km, fuel: v.fuel||"Gas",
      province: v.province||"AB", city: v.city||"",
      source: "Dealer",
      dealer: v.dealer, // dealer name string -- Boolean(r.dealer) in useListings() reads this as true, same normalization the scraper path already relies on
      listing_url: null,
      image_url: null,
      // useListings() orders by scraped_at desc, and the scraper-populated
      // listings table may mark scraped_at NOT NULL -- always set it so the
      // insert isn't rejected and the just-published car sorts to the top.
      scraped_at: new Date().toISOString(),
      // listings.is_verified is NOT NULL (DB default false). Nothing in the app
      // reads or writes it (the UI uses verification_score) -- it's set by the
      // scraper's verification pipeline, which dealer submissions never run
      // through. Set explicitly rather than leaning on the default: self-
      // documenting, and survives a future schema that drops the default.
      is_verified: false,
      // NOT copying dealer_listings' "live" -- listings uses a different
      // vocabulary and useListings() only shows status="published".
      status: "published",
    };

    // Republish-safe write. markSold leaves a status="sold" row on the same
    // external_id (it never deletes it), so the old skip-if-exists guard would
    // silently do nothing on a re-publish: dealer_listings flipped to "live"
    // but the buyer site kept showing the sold row (or nothing). Update the
    // existing row to published instead of skipping; only insert when there's
    // genuinely no row yet -- still no duplicate, and re-publish now works.
    const {data:existing,error:selError}=await supabase.from("listings").select("id").eq("external_id",externalId).limit(1);
    if(selError){ alert("Couldn't check the live site before publishing: "+selError.message); return; }
    if(existing&&existing.length>0){
      const {error:updateError}=await supabase.from("listings").update(row).eq("external_id",externalId);
      if(updateError){ alert("Couldn't publish to the live site: "+updateError.message); return; }
    }else{
      const {error:insertError}=await supabase.from("listings").insert(row);
      if(insertError){ alert("Couldn't publish to the live site: "+insertError.message); return; }
    }

    const {error}=await supabase.from("dealer_listings").update({status:"live",published_at:new Date().toISOString()}).eq("id",id);
    if(error){ alert("Published to the live site, but couldn't update dealer_listings' own status: "+error.message); return; }
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

  const themeState=useThemeState();
  const {C}=themeState;
  if(checkingSession) return <div style={{minHeight:"100dvh",background:C.paper,display:"flex",alignItems:"center",justifyContent:"center",color:C.inkFaint,fontFamily:"'Nunito',Helvetica,Arial,sans-serif"}}>Loading…</div>;
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

  return(
    <AdminThemeContext.Provider value={themeState}>
    <div style={{minHeight:"100dvh",background:C.paper,color:C.ink,padding:"24px",fontFamily:"'Nunito',Helvetica,Arial,sans-serif"}}>
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
          <div style={{fontWeight:800,fontSize:18,color:C.ink}}>LotCheck<sup style={{fontSize:"0.45em",fontWeight:700,marginLeft:2}}>™</sup> Admin</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:4,background:C.card,border:`1px solid ${C.line}`,borderRadius:10,padding:4}}>
          <AdminTabButton active={tab==="overview"} onClick={()=>setTab("overview")}>Overview</AdminTabButton>
          <AdminTabButton active={tab==="dealers"} onClick={()=>setTab("dealers")}>Dealers</AdminTabButton>
          <AdminTabButton active={tab==="review"} onClick={()=>setTab("review")}>Review</AdminTabButton>
          <AdminTabButton active={tab==="revenue"} onClick={()=>setTab("revenue")}>Revenue</AdminTabButton>
          <AdminTabButton active={tab==="profit"} onClick={()=>setTab("profit")}>Profit</AdminTabButton>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <ThemeToggle/>
          <button onClick={()=>supabase.auth.signOut()} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 14px",color:C.inkSoft,fontSize:13,cursor:"pointer"}}>Sign out</button>
        </div>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto"}}>
        {tab==="overview" && (<>
          <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
            TRAFFIC · {viewsLoading?"loading…":trackingSince?`tracking since ${trackingSince.toLocaleDateString("en-CA")}`:"no data yet"}
          </div>
          {!viewsLoading&&pageViews.length===0?(
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"20px",textAlign:"center",color:C.inkFaint,marginBottom:28}}>
              No page views recorded yet. This starts counting the moment someone loads the live site after this goes out — there's no way to recover data from before tracking began.
            </div>
          ):(
            <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
                {[["Today",trafficToday],["Last 7 days",trafficWeek],["Last 30 days",trafficMonth],["All time",trafficAllTime]].map(([label,stats])=>(
                  <div key={label} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
                    <div style={{fontSize:12,color:C.inkFaint,marginBottom:6}}>{label}</div>
                    <div style={{fontSize:22,fontWeight:800,color:C.ink}}>{stats.visitors.toLocaleString()}</div>
                    <div style={{fontSize:11,color:C.inkFaint}}>unique visitor{stats.visitors===1?"":"s"} · {stats.views.toLocaleString()} view{stats.views===1?"":"s"}</div>
                  </div>
                ))}
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>Visits over time</div>
                  <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                    {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                      <button key={key} onClick={()=>setTrafficGranularity(key)}
                        style={{background:trafficGranularity===key?C.tealBg:"transparent",color:trafficGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedTraffic} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:10,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:11,fill:C.inkFaint}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v,name)=>[v,name==="views"?"Views":name]}
                        contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#fff"}}
                        labelStyle={{color:"#D9DBEF",fontSize:11}}
                      />
                      <Bar dataKey="views" radius={[3,3,0,0]}>
                        {bucketedTraffic.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.views>=bucketedTraffic[i-1].views?C.teal:C.butter}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:11,color:C.inkFaint}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.teal,marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.butter,marginRight:5}}/>Down from previous period</span>
                </div>
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
                <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:12}}>Where visits come from</div>
                {sortedSources.every(([src])=>src==="Unknown (recorded before tracking)")?(
                  <div style={{color:C.inkFaint,fontSize:13,lineHeight:1.6}}>
                    Source tracking just went live — every visit before this update was recorded without it, so there's nothing real to show yet. This will fill in from here forward.
                  </div>
                ):(
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {sortedSources.map(([src,count])=>{
                      const pct=Math.round((count/pageViews.length)*100);
                      return(
                        <div key={src}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
                            <span style={{color:C.ink,fontWeight:700}}>{src}</span>
                            <span style={{color:C.inkFaint}}>{count.toLocaleString()} · {pct}%</span>
                          </div>
                          <div style={{background:C.paper2,borderRadius:4,height:6,overflow:"hidden"}}>
                            <div style={{width:`${pct}%`,height:"100%",background:src==="Internal navigation"?C.inkFaint:src==="Direct"?C.ink:C.teal}}/>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
                <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:12}}>Where visitors are located</div>
                <VisitorMap pageViews={pageViews}/>
              </div>
            </>
          )}

          <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>LISTINGS · {listingsLoading?"loading…":`${liveListings.length} live`}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{liveListings.length}</div>
              <div style={{fontSize:12,color:C.inkFaint}}>Total live listings</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.tealInk}}>{evapCount}</div>
              <div style={{fontSize:12,color:C.inkFaint}}>EVAP-eligible (new, verified)</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{Object.keys(byProvince).length}</div>
              <div style={{fontSize:12,color:C.inkFaint}}>Provinces covered</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{reportLeads.length}</div>
              <div style={{fontSize:12,color:C.inkFaint}}>Report emails captured</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{avgDaysOnMarket==null?"—":`${avgDaysOnMarket}d`}</div>
              <div style={{fontSize:12,color:C.inkFaint}}>Avg. days on market</div>
            </div>
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>New listings tracked over time</div>
              <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                  <button key={key} onClick={()=>setListingsGranularity(key)}
                    style={{background:listingsGranularity===key?C.tealBg:"transparent",color:listingsGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {firstSeenTimestamps.length===0?(
              <div style={{color:C.inkFaint,fontSize:13,textAlign:"center",padding:"20px 0"}}>No listing history recorded yet.</div>
            ):(
              <>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedListings} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:10,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:11,fill:C.inkFaint}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v)=>[v,"New listings"]}
                        contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:12,fontWeight:700,color:"#fff"}}
                        labelStyle={{color:"#D9DBEF",fontSize:11}}
                      />
                      <Bar dataKey="count" radius={[3,3,0,0]}>
                        {bucketedListings.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.count>=bucketedListings[i-1].count?C.teal:C.butter}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:11,color:C.inkFaint}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.teal,marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.butter,marginRight:5}}/>Down from previous period</span>
                </div>
              </>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:28}}>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:12,fontWeight:800,color:C.inkSoft,marginBottom:10}}>By province</div>
              {Object.entries(byProvince).sort((a,b)=>b[1]-a[1]).map(([p,c])=>(
                <div key={p} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.line}`,fontSize:13}}>
                  <span style={{color:C.inkSoft}}>{p}</span><span style={{fontWeight:800,color:C.ink}}>{c}</span>
                </div>
              ))}
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:12,fontWeight:800,color:C.inkSoft,marginBottom:10}}>By fuel type</div>
              {Object.entries(byFuel).sort((a,b)=>b[1]-a[1]).map(([f,c])=>(
                <div key={f} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.line}`,fontSize:13}}>
                  <span style={{color:C.inkSoft}}>{f}</span><span style={{fontWeight:800,color:C.ink}}>{c}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
            <span>REPORT EMAILS · {reportLeadsLoading?"loading…":`${reportLeads.length} total`}</span>
            {!reportLeadsLoading&&reportLeads.length>0&&(
              <button onClick={exportReportLeadsCsv}
                style={{fontSize:11,fontWeight:700,letterSpacing:0,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:"transparent",border:`1px solid ${C.line}`,color:C.inkSoft}}>
                Export CSV
              </button>
            )}
          </div>
          {reportLeadsLoading?(
            <div style={{color:C.inkFaint,fontSize:13}}>Loading report emails…</div>
          ):reportLeads.length===0?(
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"24px",textAlign:"center",color:C.inkFaint}}>
              No report emails yet. They'll show up here the moment someone uses "Email me this report" on a Quote Check.
            </div>
          ):(
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden"}}>
              {reportLeads.map(l=>(
                <div key={l.id} style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
                  <div>
                    <strong style={{color:C.ink}}>{l.email}</strong>
                    {l.source&&<div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>Re: {l.source}</div>}
                  </div>
                  <div style={{fontSize:11,color:C.inkFaint}}>{new Date(l.created_at).toLocaleString("en-CA")}</div>
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

        {tab==="revenue" && <RevenueTab dealers={dealers} apiUsage={apiUsage} apiUsageLoading={apiUsageLoading}/>}
        {tab==="profit" && <ProfitTrackerTab/>}
      </div>
    </div>
    </AdminThemeContext.Provider>
  );
}

// ── Reusable isometric 3D scan visual -- a real CSS 3D transform
// (perspective + rotateX/rotateZ), not a flat icon, with a scan beam
// sweeping across a tilted document. Used both as the idle-state teaser
// (slow, ambient loop) and the "analyzing" loading state (faster, more
// active loop) -- one consistent visual instead of a flat emoji for the
// real moment a file is actually being read.
function IsoScanVisual({C, speed="idle"}){
  const floatDur = speed==="active" ? 2.2 : 3.6;
  const sweepDur = speed==="active" ? 1.3 : 2.8;
  return (
    <div style={{perspective:900,margin:"0 auto 4px",height:130,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{
        position:"relative",width:104,height:128,
        transform:"rotateX(52deg) rotateZ(-10deg)",
        animation:`lc-iso-float ${floatDur}s ease-in-out infinite`,
      }}>
        <div style={{
          // Fixed white, not C.card -- this represents an actual physical
          // sheet of paper, which doesn't change color with the theme. The
          // previous C.card reference resolved to a near-black purple in
          // dark mode, making the "paper" essentially invisible against the
          // dark page behind it.
          position:"absolute",inset:0,borderRadius:10,background:"#FFFFFF",
          boxShadow:"10px 12px 0 rgba(51,48,90,.10), 0 1px 0 1px rgba(51,48,90,.08)",
          padding:"16px 14px",
        }}>
          <div style={{width:"60%",height:6,borderRadius:3,background:"#EDE7D8",marginBottom:10}}/>
          <div style={{width:"90%",height:4,borderRadius:2,background:"#EDE7D8",marginBottom:7}}/>
          <div style={{width:"90%",height:4,borderRadius:2,background:"#EDE7D8",marginBottom:7}}/>
          <div style={{width:"65%",height:4,borderRadius:2,background:"#EDE7D8",marginBottom:7}}/>
          <div style={{width:"90%",height:4,borderRadius:2,background:"#EDE7D8",marginBottom:7}}/>
          <div style={{width:"75%",height:4,borderRadius:2,background:"#EDE7D8"}}/>
        </div>
        <div style={{
          position:"absolute",left:6,right:6,top:8,height:16,borderRadius:4,
          background:`linear-gradient(180deg, transparent, ${C.teal}99, transparent)`,
          boxShadow:`0 0 14px 3px ${C.teal}77`,
          animation:`lc-iso-sweep ${sweepDur}s linear infinite`,
        }}/>
      </div>
    </div>
  );
}

// Quote Check paywall removed -- no license yet to operate this as a
// paid service, so Quote Check stays free and unlimited until that's
// resolved. getQuoteCheckAccess() above always allows access now.

// Progressive "analyzing" status messages. The edge function doesn't
// stream progress back, so these are TIME-BASED, not real milestones --
// they exist to make a genuinely slow scan (a URL scan is ~30-60s, since
// it live-scrapes the dealer page and, on payment-first listings, also
// cross-checks the manufacturer's site) FEEL like active work instead of
// a frozen spinner. The `at` values are seconds of elapsed time, tuned to
// the real backend phases: dealer-page fetch, first analysis, then the
// manufacturer-MSRP fallback. Each message just needs to still be true if
// the scan finishes early -- so they describe the pipeline generically,
// never claim a specific step "is done." URL and file/photo scans get
// different sequences because a file scan skips the slow live-scrape and
// manufacturer steps entirely.
const URL_SCAN_STAGES = [
  { at: 0,  text: "Opening the dealer's listing…" },
  { at: 6,  text: "Reading the pricing and fine print…" },
  { at: 16, text: "Analyzing MSRP, fees, and financing…" },
  { at: 30, text: "Cross-checking MSRP with the manufacturer…" },
  { at: 46, text: "Putting your report together…" },
];
const FILE_SCAN_STAGES = [
  { at: 0,  text: "Reading the document…" },
  { at: 5,  text: "Pulling out MSRP, price, and add-ons…" },
  { at: 14, text: "Checking the warranty terms…" },
  { at: 22, text: "Putting your report together…" },
];

// ── Quote Check: upload a dealer quote PDF, get an AI-read breakdown of
// MSRP vs quoted price, flagged add-ons, and warranty analysis. Nothing is
// uploaded to Supabase Storage or saved anywhere -- the file is read in the
// browser, sent once to the edge function for analysis, and discarded.
function QuoteCheckPage(){
  const [status,setStatus]=useState("idle"); // idle | analyzing | done | error
  const [scanMsg,setScanMsg]=useState(""); // rotating progress line shown while status==="analyzing"
  const [analysis,setAnalysis]=useState(null);
  // Tracks which analysis path produced the current `analysis` object --
  // "quote" (uploaded document/photo) or "listing" (pasted dealer URL).
  // Some copy below (the flagged-items banner especially) means something
  // different depending on the source: a flagged fee on a formal quote is
  // money being taken from the buyer, but a flagged condition on a listing
  // is usually a rebate/discount that might not apply -- money that MIGHT
  // not come to the buyer, not money being extracted. Same verdict schema,
  // opposite real-world meaning, so the wording needs to match the source.
  const [analysisSource,setAnalysisSource]=useState(null); // "quote" | "listing"
  const [errorMsg,setErrorMsg]=useState("");
  const [fileName,setFileName]=useState("");
  const [dragOver,setDragOver]=useState(false);
  const [urlInput,setUrlInput]=useState("");
  const [payFreq,setPayFreq]=useState("weekly"); // weekly | biweekly | monthly -- for the payment breakdown card

  // Fire-and-forget dealer-sentiment lookup, called after EITHER analysis
  // path (quote upload or listing URL) once analysis.dealerName is known.
  // Deliberately not awaited at the call site -- the rest of the report
  // renders immediately via setStatus("done"), and this card just fills
  // in a moment later once the separate lookup finishes, same pattern as
  // any other progressive enhancement. Never blocks, never shows an
  // error -- a buyer should never know this lookup even happened if it
  // fails; the card just doesn't appear.
  const fetchDealerSentiment=async(dealerName,dealerCity)=>{
    if(!dealerName) return;
    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/get-dealer-sentiment",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({dealerName,dealerCity}),
      });
      const data=await res.json();
      if(!res.ok||data.error||!data.dealerSentiment) return;
      setAnalysis(prev=>prev?{...prev,dealerSentiment:data.dealerSentiment}:prev);
    }catch{
      // Silent by design -- see comment above.
    }
  };
  const fileInputRef=useRef(null);
  // Which method the most recent attempt actually used -- set the moment an
  // attempt starts, regardless of whether it succeeds, so an error state
  // always knows precisely what to suggest instead (a failed URL attempt
  // should point at upload, since that doesn't depend on a third-party site
  // being scrapable at all -- a failed upload needs different guidance).
  const [lastAttemptType,setLastAttemptType]=useState(null); // "file" | "url"
  const [lastFile,setLastFile]=useState(null); // the actual File object from the most recent upload -- needed to re-run a refresh on the file path, since handleFile only ever received it as a function argument before now, not from state

  // Email-a-copy state -- separate from the main analyze flow so a failed
  // email send never wipes out the report the person can already see on
  // screen. idle -> sending -> sent | error.
  const [emailInput,setEmailInput]=useState("");
  const [emailStatus,setEmailStatus]=useState("idle");
  const [emailErr,setEmailErr]=useState("");

  function isValidEmail(v){
    // Deliberately simple -- catches typos ("bob@gmailcom") without the
    // false-negative risk of a stricter regex rejecting a real address.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  async function sendReportEmail(){
    const email=emailInput.trim();
    if(!isValidEmail(email)){
      setEmailErr("That doesn't look like a valid email address.");
      return;
    }
    setEmailErr("");
    setEmailStatus("sending");
    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/email-quote-report",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({email,analysis}),
      });
      const data=await res.json();
      if(!res.ok||data.error){
        setEmailStatus("error");
        setEmailErr(data.error||"Couldn't send that email. Please try again.");
        return;
      }
      setEmailStatus("sent");
      // Fire-and-forget capture -- logs the email for admin follow-up now
      // that a real send has succeeded. A failed insert here should never
      // surface as an error to the person; they already have their report
      // either way, this is purely so it's not lost on Vic's end too.
      supabase.from("quote_report_leads").insert({
        email,
        source: analysisSource==="listing" ? (urlInput.trim()||null) : (fileName||null),
      }).then(({error})=>{ if(error) console.warn("⚠️ quote_report_leads insert failed:",error.message); });
    }catch(err){
      setEmailStatus("error");
      setEmailErr("Couldn't reach the email service. Check your connection and try again.");
    }
  }

  // Two palettes, pulled directly from the welcome page's CSS custom
  // properties (both the :root light values and the html[data-theme="dark"]
  // overrides) -- not invented separately, so Quote Check's dark mode is
  // the SAME dark mode as the homepage's, not just "a" dark theme. Brand
  // accents (teal/coral/butter) don't change between modes on the homepage
  // either, so they're kept constant here too -- only chrome (ink/paper/
  // card/line) shifts. tealBg/coralBg/butterBg (translucent tint
  // backgrounds) aren't homepage CSS vars -- there's no direct source to
  // match, so these are reasonable extrapolations in the same spirit as
  // the homepage's own dark-mode overrides, not verified against anything.
  const QC_LIGHT={
    ink:"#33305A", inkSoft:"#5B5885", inkFaint:"#706D96",
    paper:"#FBF5EC", paper2:"#F5EEE1", card:"#FFFFFF",
    line:"rgba(51,48,90,.12)", borderWidth:"1px", cardShadow:"0 18px 40px -18px rgba(51,48,90,.18)",
    teal:"#2FA79A", tealInk:"#17756B", tealBg:"#E3F4F1",
    coral:"#F2836B", coralInk:"#A63C25", coralBg:"#FDEAE5",
    butter:"#F5C95C", butterInk:"#8A6414", butterBg:"#FDF4DF",
  };
  const QC_DARK={
    ink:"#EDEBF7", inkSoft:"#B9B6D6", inkFaint:"#8D89B8",
    paper:"#15121F", paper2:"#1C1830", card:"#211C34",
    line:"rgba(237,235,247,.14)", borderWidth:"1px", cardShadow:"0 18px 40px -18px rgba(51,48,90,.18)",
    teal:"#2FA79A", tealInk:"#5FD8CB", tealBg:"rgba(47,167,154,.18)",
    coral:"#F2836B", coralInk:"#FF9E85", coralBg:"rgba(242,131,107,.18)",
    butter:"#F5C95C", butterInk:"#F5C95C", butterBg:"rgba(245,201,92,.18)",
  };
  // Outdoor/bright: for viewing on a phone in direct sunlight, where the
  // usual cream paper and mid-tone teal/coral wash out badly against
  // glare. Pure white paper and near-black ink maximize contrast; teal
  // and coral are darkened and more saturated than the standard palette
  // so the color-coding (principal vs. interest, verified vs. flagged)
  // stays legible even when ambient light flattens subtle hue
  // differences. No soft box-shadow here -- shadows are exactly the kind
  // of low-contrast cue that disappears in bright glare, so a visibly
  // bolder border does the job of defining the card edge instead.
  const QC_OUTDOOR={
    ink:"#141127", inkSoft:"#3A3660", inkFaint:"#514C82",
    paper:"#FFFFFF", paper2:"#F1F1EC", card:"#FFFFFF",
    line:"rgba(20,17,39,.22)", borderWidth:"1.5px", cardShadow:"none",
    teal:"#0E7A6C", tealInk:"#0A5A50", tealBg:"#D9F0EB",
    coral:"#C8431F", coralInk:"#8F2E12", coralBg:"#FBE1D6",
    butter:"#B8860B", butterInk:"#6B4E08", butterBg:"#F5E8C8",
  };
  // Same key and same fallback logic as the homepage's inline head script:
  // explicit "dark" wins, otherwise fall back to the OS preference -- so a
  // first-time visitor who lands directly on /quote-check (never having
  // touched the homepage toggle) still gets a theme that matches their
  // system, not a hardcoded default. "outdoor" is a third saved value now,
  // but only ever reached by explicit user choice below -- there's no OS
  // media feature for "in bright sunlight," so a first-time visitor with
  // nothing saved still only ever falls back to dark or light.
  const [qcTheme,setQcTheme]=useState(()=>{
    try{
      const saved=localStorage.getItem("lc-theme");
      if(saved==="dark"||saved==="outdoor") return saved;
      if(saved==="light") return "light";
      return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
    }catch{ return "light"; }
  });
  function setQcThemeAndPersist(next){
    setQcTheme(next);
    try{ localStorage.setItem("lc-theme",next); }catch{}
  }
  const C=qcTheme==="dark"?QC_DARK:qcTheme==="outdoor"?QC_OUTDOOR:QC_LIGHT;

  // 5-star reviews green, 3-star amber, 1-star red -- with 4 and 2 filled
  // in sensibly on the same gradient (existing teal/butter/coral palette,
  // matching the pattern already used elsewhere for score buckets).
  function ratingColor(r){
    if(r>=4) return C.tealInk;
    if(r===3) return C.butterInk;
    return C.coralInk;
  }

  // Backend now returns a bigger pool (6-8) of individual, rating-tagged
  // review highlights instead of 2-4 fixed thematic bullets -- this picks
  // a random subset of them to actually display. Re-samples whenever a
  // NEW dealerSentiment payload arrives (a fresh report, a refresh, or
  // checking a different vehicle at the same dealer), so the card feels
  // alive across checks instead of showing the exact same lines every
  // time, while staying stable while someone's actually reading one.
  const sampledHighlights=useMemo(()=>{
    const pool=analysis?.dealerSentiment?.highlights||[];
    if(pool.length<=4) return pool;
    const shuffled=[...pool].sort(()=>Math.random()-0.5);
    return shuffled.slice(0,4);
  },[analysis?.dealerSentiment]);

  // JPEG/PNG/WEBP go straight through -- HEIC/HEIF (the default format for
  // iPhone camera photos) needs converting first, since neither browsers
  // nor Claude's vision API can read HEIC directly. Some browsers report an
  // empty or generic file.type for HEIC picked via a file input, so this
  // also checks the filename extension as a fallback, not just MIME type.
  const ACCEPTED_TYPES=["application/pdf","image/jpeg","image/png","image/webp","image/heic","image/heif"];
  const HEIC_EXTENSIONS=[".heic",".heif"];
  const MAX_FILE_SIZE_MB=15;

  function isHeic(file){
    if(file.type==="image/heic"||file.type==="image/heif") return true;
    const lower=(file.name||"").toLowerCase();
    return HEIC_EXTENSIONS.some(ext=>lower.endsWith(ext));
  }

  const handleFile=async(file)=>{
    if(!file) return;
    const heic=isHeic(file);
    if(!heic&&!ACCEPTED_TYPES.includes(file.type)){
      setStatus("error");
      setErrorMsg("Please upload a PDF, or a clear photo (JPG, PNG, WEBP, or HEIC) of the quote.");
      return;
    }
    if(file.size>MAX_FILE_SIZE_MB*1024*1024){
      setStatus("error");
      setErrorMsg(`That file is a bit large (${(file.size/1024/1024).toFixed(1)}MB) — please try a photo under ${MAX_FILE_SIZE_MB}MB. A single clear photo of the quote works better than a scan of every page.`);
      return;
    }
    setFileName(file.name);
    setLastFile(file);
    setLastAttemptType("file");
    setStatus("analyzing");
    setErrorMsg("");

    try{
      // Convert HEIC/HEIF to JPEG entirely in the browser before anything
      // else touches it -- this keeps "sent once, discarded" true, since
      // conversion never goes through a server.
      let fileToSend=file;
      if(heic){
        try{
          const converted=await heic2any({blob:file,toType:"image/jpeg",quality:0.9});
          fileToSend=Array.isArray(converted)?converted[0]:converted;
        }catch(convErr){
          setStatus("error");
          setErrorMsg("Couldn't convert that HEIC photo. Try taking a screenshot of it instead, or switch your camera to JPEG in Settings → Camera → Formats.");
          return;
        }
      }

      const base64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result.split(",")[1]);
        reader.onerror=()=>reject(new Error("Couldn't read that file."));
        reader.readAsDataURL(fileToSend);
      });

      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-quote",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({fileBase64:base64,mediaType:fileToSend.type||"image/jpeg"}),
      });

      const data=await res.json();
      if(!res.ok||data.error){
        setStatus("error");
        setErrorMsg(data.error||"Something went wrong analyzing that quote.");
        return;
      }
      setAnalysis(data.analysis);
      setAnalysisSource("quote");
      fetchDealerSentiment(data.analysis?.dealerName,data.analysis?.dealerCity);
      consumeQuoteCredit();
      setStatus("done");
    }catch(err){
      setStatus("error");
      setErrorMsg("Couldn't reach the analysis service. Check your connection and try again.");
    }
  };

  function isValidUrl(v){
    try{ const u=new URL(v.trim()); return u.protocol==="http:"||u.protocol==="https:"; }catch{ return false; }
  }

  // Advance the time-based progress line while a scan runs. The clock
  // restarts whenever a new scan begins (status -> "analyzing"); the
  // interval is torn down on status change / unmount so no stray timer
  // outlives the scan. Purely cosmetic -- it never gates the real result,
  // which still lands via setStatus("done") from the fetch above.
  useEffect(()=>{
    if(status!=="analyzing") return;
    const stages=lastAttemptType==="url"?URL_SCAN_STAGES:FILE_SCAN_STAGES;
    setScanMsg(stages[0].text);
    const t0=Date.now();
    const id=setInterval(()=>{
      const elapsed=(Date.now()-t0)/1000;
      let text=stages[0].text;
      for(const s of stages){ if(elapsed>=s.at) text=s.text; }
      setScanMsg(text);
    },500);
    return ()=>clearInterval(id);
  },[status,lastAttemptType]);

  const handleUrlAnalyze=async()=>{
    const url=urlInput.trim();
    if(!isValidUrl(url)){
      setStatus("error");
      setErrorMsg("That doesn't look like a valid URL — paste the full link, starting with http:// or https://.");
      return;
    }
    setFileName(new URL(url).hostname);
    setLastAttemptType("url");
    setStatus("analyzing");
    setErrorMsg("");

    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-listing-url",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({url}),
      });

      const data=await res.json();
      if(!res.ok||data.error){
        setStatus("error");
        setErrorMsg(data.error||"Something went wrong analyzing that listing.");
        return;
      }
      setAnalysis(data.analysis);
      setAnalysisSource("listing");
      fetchDealerSentiment(data.analysis?.dealerName,data.analysis?.dealerCity);
      consumeQuoteCredit();
      setStatus("done");
    }catch(err){
      setStatus("error");
      setErrorMsg("Couldn't reach the analysis service. Check your connection and try again.");
    }
  };

  // Re-runs the exact same analysis that was last attempted, whether that
  // was a file upload or a pasted URL -- lets someone retry in place
  // (e.g. if MSRP/financing came back empty due to a transient fetch
  // issue) without needing to re-paste a URL or re-pick a file. Does
  // nothing if there's no prior attempt to repeat, or one is already in
  // flight.
  const handleRefresh=()=>{
    if(status==="analyzing"||!lastAttemptType) return;
    if(lastAttemptType==="url") handleUrlAnalyze();
    else if(lastAttemptType==="file"&&lastFile) handleFile(lastFile);
  };

  const reset=()=>{
    setStatus("idle");
    setAnalysis(null);
    setAnalysisSource(null);
    setErrorMsg("");
    setFileName("");
    setUrlInput("");
  };

  // Lets someone paste a screenshot (Ctrl+V / Cmd+V) straight in, without
  // needing to save it to disk first and browse for it. Only listens while
  // the upload zone is actually showing.
  useEffect(()=>{
    if(status!=="idle") return;
    const onPaste=(e)=>{
      const items=e.clipboardData?.items;
      if(!items) return;
      for(const item of items){
        if(item.type&&item.type.startsWith("image/")){
          const file=item.getAsFile();
          if(file){ e.preventDefault(); handleFile(file); }
          return;
        }
      }
    };
    window.addEventListener("paste",onPaste);
    return ()=>window.removeEventListener("paste",onPaste);
  },[status]);

  // Local keyframes for the isometric scan demo -- kept scoped to this page
  // (not merged into the shared GLOBAL_CSS) since QuoteCheckPage mounts as
  // its own standalone route and nothing else needs these.
  const QC_CSS=`
    @keyframes lc-iso-float {
      0%,100% { transform:rotateX(52deg) rotateZ(-10deg) translateY(0); }
      50%     { transform:rotateX(52deg) rotateZ(-10deg) translateY(-6px); }
    }
    @keyframes lc-iso-sweep {
      0%   { top:8px;   opacity:0; }
      12%  { opacity:1; }
      88%  { opacity:1; }
      100% { top:112px; opacity:0; }
    }
    @keyframes lc-iso-chip-1 {
      0%,4%   { opacity:0; transform:translateY(6px); }
      8%,17%  { opacity:1; transform:translateY(0); }
      21%,100%{ opacity:0; transform:translateY(-6px); }
    }
    @keyframes lc-iso-chip-2 {
      0%,21%  { opacity:0; transform:translateY(6px); }
      25%,34% { opacity:1; transform:translateY(0); }
      38%,100%{ opacity:0; transform:translateY(-6px); }
    }
    @keyframes lc-iso-chip-3 {
      0%,38%  { opacity:0; transform:translateY(6px); }
      42%,51% { opacity:1; transform:translateY(0); }
      55%,100%{ opacity:0; transform:translateY(-6px); }
    }
    @keyframes lc-iso-chip-4 {
      0%,55%  { opacity:0; transform:translateY(6px); }
      59%,68% { opacity:1; transform:translateY(0); }
      72%,100%{ opacity:0; transform:translateY(-6px); }
    }
    @keyframes lc-iso-chip-5 {
      0%,72%  { opacity:0; transform:translateY(6px); }
      76%,85% { opacity:1; transform:translateY(0); }
      89%,100%{ opacity:0; transform:translateY(-6px); }
    }
  `;

  // Five example findings the scan demo cycles through -- a representative
  // spread across what the pipeline actually catches (verified fact,
  // flagged fee, rebate, VIN check, warranty), not just one repeated idea.
  const EXAMPLES=[
    {icon:"✓",text:"MSRP verified",bg:C.tealBg,fg:C.tealInk,anim:"lc-iso-chip-1"},
    {icon:"⚠",text:"Doc fee flagged — $599",bg:C.coralBg,fg:C.coralInk,anim:"lc-iso-chip-2"},
    {icon:"$",text:"$5,000 EVAP rebate found",bg:C.butterBg,fg:C.butterInk,anim:"lc-iso-chip-3"},
    {icon:"✓",text:"VIN pattern valid",bg:C.tealBg,fg:C.tealInk,anim:"lc-iso-chip-4"},
    {icon:"⚠",text:"Extended warranty overpriced",bg:C.coralBg,fg:C.coralInk,anim:"lc-iso-chip-5"},
  ];

  const cardStyle={
    background:C.card,borderRadius:26,padding:20,marginBottom:16,
    border:`${C.borderWidth} solid ${C.line}`,boxShadow:C.cardShadow,
  };

  // Whether this report's addOns should be framed as real costs (fees) vs.
  // discounts/conditions. Prefers each item's own `kind` field, which the
  // edge function now supplies -- a URL/listing analysis can genuinely
  // contain real fees (e.g. Honda Safe & Secure on a "payment-first"
  // listing), so the old assumption of "listing = always discounts" was
  // wrong and mislabeled a real $749 fee as a "conditional saving" on a
  // live example. Falls back to the old analysisSource-based guess only
  // when no item carries `kind` at all (older cached responses, or the
  // analyze-quote path, which doesn't use this field since its add-ons
  // are always genuine fees already labeled correctly).
  const addOnsHaveKind=analysis?.addOns?.some(a=>a.kind==="fee"||a.kind==="discount");
  const addOnsAreFees=addOnsHaveKind?analysis.addOns.some(a=>a.kind==="fee"):analysisSource!=="listing";

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      <style>{QC_CSS}</style>
      <div style={{minHeight:"100dvh",background:C.paper,padding:"24px 16px",fontFamily:"'Nunito',system-ui,-apple-system,sans-serif"}}>
        <div style={{maxWidth:640,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:28}}>
            <a href="/" aria-label="LotCheck home" style={{display:"flex",alignItems:"center",gap:10,textDecoration:"none",flex:1,minWidth:0}}>
              <LogoMark size={34}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:1000,fontSize:18,color:C.ink}}>LotCheck Quote Check</div>
                <div style={{fontSize:12,color:C.inkSoft}}>Upload your dealer quote. We'll tell you what's real and what's padding.</div>
              </div>
            </a>
            {lastAttemptType&&(
              <button onClick={handleRefresh} disabled={status==="analyzing"} aria-label="Re-run this report"
                title="Re-run this report from scratch"
                style={{display:"flex",alignItems:"center",justifyContent:"center",width:34,height:34,borderRadius:10,background:C.paper2,border:`1px solid ${C.line}`,color:C.inkSoft,cursor:status==="analyzing"?"default":"pointer",opacity:status==="analyzing"?0.5:1,flexShrink:0,fontSize:15}}>
                🔄
              </button>
            )}
            <div style={{display:"flex",gap:3,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:10,padding:3,flexShrink:0}}>
              {[["dark","🌙 Dark"],["light","🌤️ Light"],["outdoor","☀️ Outdoor"]].map(([k,label])=>(
                <button key={k} onClick={()=>setQcThemeAndPersist(k)} aria-label={`Switch to ${k} mode`}
                  style={{background:qcTheme===k?C.tealBg:"transparent",color:qcTheme===k?C.tealInk:C.inkFaint,border:"none",borderRadius:7,padding:"6px 10px",fontSize:11.5,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {status==="idle"&&(
            <>
            <div
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);handleFile(e.dataTransfer.files[0]);}}
              onClick={()=>fileInputRef.current?.click()}
              style={{
                border:`2px dashed ${dragOver?C.teal:C.line}`,
                borderRadius:26,padding:"40px 24px 30px",textAlign:"center",cursor:"pointer",
                background:dragOver?C.tealBg:C.card,transition:"all 0.15s",
                boxShadow:"0 18px 40px -18px rgba(51,48,90,.18)",
              }}
            >
              <IsoScanVisual C={C} speed="idle"/>

              <div style={{position:"relative",height:24,margin:"8px 0 14px"}}>
                {EXAMPLES.map((ex,i)=>(
                  <div key={i} style={{
                    position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",gap:7,
                    animation:`${ex.anim} 15s ease-in-out infinite`,
                  }}>
                    <span style={{
                      display:"inline-flex",alignItems:"center",gap:6,
                      background:ex.bg,color:ex.fg,fontWeight:800,fontSize:12,
                      padding:"5px 12px",borderRadius:999,
                    }}>
                      <span aria-hidden="true">{ex.icon}</span>{ex.text}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{color:C.ink,fontWeight:1000,marginBottom:6}}>Drop your quote here, paste a screenshot, or snap a photo</div>
              <div style={{color:C.inkFaint,fontSize:13}}>PDF or photo of a paper quote — takes a couple of seconds to analyze</div>
              <input ref={fileInputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" style={{display:"none"}}
                onChange={e=>handleFile(e.target.files[0])}/>
            </div>

            <div style={{display:"flex",alignItems:"center",gap:12,margin:"18px 0"}}>
              <div style={{flex:1,height:1,background:C.line}}/>
              <div style={{fontSize:11,color:C.inkFaint,fontWeight:800}}>OR</div>
              <div style={{flex:1,height:1,background:C.line}}/>
            </div>

            <div onClick={e=>e.stopPropagation()} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:"16px 18px"}}>
              <div style={{color:C.ink,fontWeight:800,fontSize:14,marginBottom:8}}>Paste a dealer listing link instead</div>
              <div style={{fontSize:12,color:C.inkFaint,marginBottom:12}}>For a car on a dealer's website — too long to screenshot, or the price loads dynamically. Dealer links take up to a minute to read; uploading a photo is faster.</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <input
                  type="url"
                  placeholder="https://dealer-site.com/inventory/..."
                  value={urlInput}
                  onChange={e=>setUrlInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter") handleUrlAnalyze();}}
                  style={{flex:"1 1 220px",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"11px 14px",color:C.ink,fontSize:14,outline:"none",boxSizing:"border-box"}}
                />
                <button onClick={handleUrlAnalyze}
                  style={{background:C.teal,border:"none",borderRadius:10,padding:"11px 22px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",whiteSpace:"nowrap"}}>
                  Analyze →
                </button>
              </div>
            </div>

            <div style={{display:"flex",gap:20,marginTop:26,flexWrap:"wrap"}}>
              {[
                {n:"1",label:"Upload or paste",desc:"Drop a file, click to browse, or paste (Ctrl+V / Cmd+V) a screenshot"},
                {n:"2",label:"We read it",desc:"Every line item, fee, and warranty term — parsed in seconds"},
                {n:"3",label:"See what's real",desc:"True MSRP, flagged add-ons, and any EVAP rebate you qualify for"},
              ].map((s,i)=>(
                <div key={i} style={{flex:"1 1 160px",minWidth:150}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <div style={{width:22,height:22,borderRadius:"50%",background:C.coral,color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{s.n}</div>
                    <div style={{color:C.ink,fontWeight:800,fontSize:13}}>{s.label}</div>
                  </div>
                  <div style={{color:C.inkFaint,fontSize:12,lineHeight:1.5,paddingLeft:30}}>{s.desc}</div>
                </div>
              ))}
            </div>
            </>
          )}

          {status==="analyzing"&&(
            <div style={{...cardStyle,padding:"48px 24px",textAlign:"center"}}>
              <IsoScanVisual C={C} speed="active"/>
              <div style={{color:C.ink,fontWeight:1000,marginBottom:6}}>{lastAttemptType==="url"?`Scanning ${fileName}…`:`Reading ${fileName}…`}</div>
              <div style={{color:C.inkFaint,fontSize:13,transition:"opacity .2s"}}>{scanMsg||"Checking MSRP, add-ons, and warranty terms"}</div>
              {lastAttemptType==="url"&&(
                <div style={{color:C.inkFaint,fontSize:11,marginTop:10,opacity:.75}}>Reading a live dealer page can take up to a minute — hang tight.</div>
              )}
            </div>
          )}

          {status==="error"&&(
            <div style={{...cardStyle,background:C.coralBg,border:`1px solid ${C.coral}55`,padding:"32px 24px",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
              <div style={{color:C.coralInk,fontWeight:800,marginBottom:8}}>{errorMsg}</div>
              {lastAttemptType==="url"?(
                <>
                  <div style={{fontSize:12,color:C.inkFaint,margin:"10px 0 14px",lineHeight:1.5}}>
                    Dealer sites occasionally can't be read automatically. Uploading a screenshot of the same page works even when the link doesn't, since it never depends on the dealer's site cooperating.
                  </div>
                  <button onClick={reset} style={{background:C.ink,border:"none",borderRadius:999,padding:"11px 22px",color:C.paper,fontWeight:800,cursor:"pointer",boxShadow:"5px 6px 0 rgba(51,48,90,.16)",marginBottom:10}}>Upload a screenshot instead →</button>
                  <div>
                    <button onClick={()=>handleUrlAnalyze()} style={{background:"transparent",border:"none",color:C.inkFaint,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Or try this link again</button>
                  </div>
                </>
              ):(
                <button onClick={reset} style={{marginTop:8,background:C.ink,border:"none",borderRadius:999,padding:"10px 22px",color:C.paper,fontWeight:800,cursor:"pointer",boxShadow:"5px 6px 0 rgba(51,48,90,.16)"}}>Try again</button>
              )}
            </div>
          )}

          {status==="done"&&analysis&&(
            <div>
              <div style={cardStyle}>
                <div style={{fontSize:13,color:C.inkFaint}}>{analysis.vehicle||"Vehicle"}</div>
              </div>

              {/* MSRP on its own -- just the manufacturer's number, nothing
                  else mixed into this card. The comparison against what the
                  buyer is actually being asked to pay lives in the Quoted
                  price card right below, colored against this figure. */}
              <div style={cardStyle}>
                <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>MSRP</div>
                <div style={{fontSize:22,fontWeight:1000,color:C.ink}}>{analysis.msrp?`$${analysis.msrp.toLocaleString()}`:"Not shown on quote"}</div>
              </div>

              {/* Quoted price colored against MSRP: teal/green at-or-under
                  MSRP, coral/red over it. hasMsrpCompare guards against
                  coloring when either number is missing (e.g. MSRP wasn't
                  on the quote) -- no color claim without both values. */}
              {(()=>{
                const hasMsrpCompare=!!(analysis.msrp&&analysis.quotedPrice);
                const overMsrp=hasMsrpCompare&&analysis.quotedPrice>analysis.msrp;
                const diff=hasMsrpCompare?Math.abs(analysis.quotedPrice-analysis.msrp):0;
                const priceColor=hasMsrpCompare?(overMsrp?C.coralInk:C.tealInk):C.ink;
                return (
                  <div style={{...cardStyle,...(hasMsrpCompare?{background:overMsrp?C.coralBg:C.tealBg,border:`1px solid ${overMsrp?C.coral:C.teal}55`}:{})}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Quoted price</div>
                    <div style={{fontSize:22,fontWeight:1000,color:priceColor}}>{analysis.quotedPrice?`$${analysis.quotedPrice.toLocaleString()}`:"Not found"}</div>
                    {hasMsrpCompare&&(
                      <div style={{fontSize:12,fontWeight:700,color:priceColor,marginTop:4}}>
                        {diff===0?"= Exactly at MSRP":overMsrp?`▲ $${diff.toLocaleString()} over MSRP`:`▼ $${diff.toLocaleString()} under MSRP`}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── Verification checks (the real 10-point results) rendered
                  from the edge function's structured output: leverage,
                  recalls, odometer, VIN, financing math. Each card only
                  appears when its check ran, and reuses the same teal=good /
                  coral=concern language as the price cards above. ── */}

              {analysis.leverageScore?.computed&&(
                <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Negotiation leverage</div>
                  <div style={{fontSize:28,fontWeight:1000,color:C.ink,lineHeight:1}}>{analysis.leverageScore.score}<span style={{fontSize:15,color:C.inkFaint,fontWeight:800}}> /10</span></div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>{analysis.leverageScore.note}</div>
                </div>
              )}

              {analysis.recalls&&(()=>{
                const r=analysis.recalls;
                if(!r.checked) return (
                  <div style={cardStyle}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Open recalls · Transport Canada</div>
                    <div style={{fontSize:13,color:C.inkSoft,lineHeight:1.5}}>Couldn't reach the recall registry just now — you can check directly at Transport Canada before you sign.</div>
                  </div>
                );
                if(r.count===0) return (
                  <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Open recalls · Transport Canada</div>
                    <div style={{fontSize:15,fontWeight:800,color:C.tealInk}}>✓ No open recalls found</div>
                  </div>
                );
                const yr=(dt)=>{const y=new Date(dt).getFullYear();return isNaN(y)?"":` · ${y}`;};
                return (
                  <div style={{...cardStyle,background:C.coralBg,border:`1px solid ${C.coral}55`}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Open recalls · Transport Canada</div>
                    <div style={{fontSize:20,fontWeight:1000,color:C.coralInk}}>{r.count} open recall{r.count>1?"s":""}</div>
                    {(r.items||[]).slice(0,4).map((it,i)=>(
                      <div key={i} style={{fontSize:12,color:C.ink,marginTop:8,paddingTop:8,borderTop:`1px solid ${C.line}`}}>
                        <div style={{fontWeight:800}}>{it.system||"Recall"}{it.date?yr(it.date):""}</div>
                        {it.summary&&<div style={{color:C.inkSoft,marginTop:2,lineHeight:1.5}}>{it.summary}</div>}
                      </div>
                    ))}
                    <div style={{fontSize:11,color:C.inkFaint,marginTop:10}}>Recalls are repaired free of charge — {r.sourceUrl?<a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" style={{color:C.inkFaint}}>confirm the fix status</a>:"confirm the fix status"} with the dealer before you sign.</div>
                  </div>
                );
              })()}

              {analysis.odometerCheck?.checked&&(
                <div style={{...cardStyle,...(analysis.odometerCheck.flag?{background:C.coralBg,border:`1px solid ${C.coral}55`}:{})}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Odometer</div>
                  <div style={{fontSize:18,fontWeight:1000,color:analysis.odometerCheck.flag?C.coralInk:C.ink}}>{analysis.odometerCheck.km.toLocaleString()} km{analysis.odometerCheck.flag?" ⚠":""}</div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>{analysis.odometerCheck.note}</div>
                </div>
              )}

              {analysis.vinCheck?.present&&(
                <div style={{...cardStyle,...(analysis.vinCheck.valid?{}:{background:C.coralBg,border:`1px solid ${C.coral}55`})}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>VIN check{analysis.vinCheck.vin?` · ${analysis.vinCheck.vin}`:""}</div>
                  <div style={{fontSize:14,fontWeight:800,color:analysis.vinCheck.valid?C.tealInk:C.coralInk}}>{analysis.vinCheck.valid?"✓ Valid VIN pattern":"⚠ VIN doesn't validate"}</div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>{analysis.vinCheck.reason}</div>
                </div>
              )}

              {analysis.financingCheck?.checked&&(
                <div style={{...cardStyle,...(analysis.financingCheck.consistent?{}:{background:C.coralBg,border:`1px solid ${C.coral}55`})}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Financing math</div>
                  <div style={{fontSize:14,fontWeight:800,color:analysis.financingCheck.consistent?C.tealInk:C.coralInk}}>{analysis.financingCheck.consistent?"✓ Payments reconcile":"⚠ Numbers don't add up"}</div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>{analysis.financingCheck.note}</div>
                </div>
              )}

              {/* Dealer sentiment: what public Google reviews say about
                  THIS dealer, read for the patterns that actually predict
                  a good/bad buying experience (financing transparency,
                  communication, service honesty) -- the same signals
                  real industry review analysis finds drive buyer
                  satisfaction more than star rating alone. Always free
                  and buyer-facing per Vic's call -- this is deliberately
                  NOT a paid dealer product, since a dealer paying LotCheck
                  for their own reputation summary would undercut the
                  buyer-first positioning the whole platform is built on.
                  Requires analysis.dealerSentiment from the edge function
                  -- {dealerName, rating, reviewCount,
                  highlights:[{rating,text}], sourceUrl}. Shows a random
                  sample of up to 4 from the backend's pool of 6-8 (see
                  sampledHighlights above) so the card varies across
                  checks instead of showing identical content every time
                  someone checks a different vehicle at the same dealer. */}
              {analysis.dealerSentiment&&(
                <div style={cardStyle}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10,flexWrap:"wrap",gap:6}}>
                    <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>What customers say about {analysis.dealerSentiment.dealerName}</div>
                    {!!analysis.dealerSentiment.rating&&(
                      <div style={{fontSize:12,color:C.inkFaint,whiteSpace:"nowrap"}}>
                        ★ {analysis.dealerSentiment.rating.toFixed(1)}{analysis.dealerSentiment.reviewCount?` · ${analysis.dealerSentiment.reviewCount.toLocaleString()} reviews`:""}
                      </div>
                    )}
                  </div>
                  {sampledHighlights.map((h,i)=>(
                    <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",padding:"6px 0",borderTop:i>0?`1px solid ${C.line}`:"none"}}>
                      <span style={{color:ratingColor(h.rating),fontWeight:800,fontSize:12,lineHeight:"20px",whiteSpace:"nowrap"}}>★{h.rating}</span>
                      <span style={{fontSize:13,color:C.ink,lineHeight:1.5}}>{h.text}</span>
                    </div>
                  ))}
                  <div style={{fontSize:11,color:C.inkFaint,marginTop:10}}>
                    Based on public Google reviews{analysis.dealerSentiment.sourceUrl&&(<> — <a href={analysis.dealerSentiment.sourceUrl} target="_blank" rel="noopener noreferrer" style={{color:C.inkFaint}}>see all reviews</a></>)}
                  </div>
                </div>
              )}

              {/* Standard/included manufacturer warranty -- NOT an upsell
                  product (that's the separate "warranty" section further
                  down for a PURCHASED extended plan). This is what already
                  comes free with the vehicle, framed positively so buyers
                  know it's already covered before anyone tries to sell them
                  something that overlaps with it. */}
              {analysis.standardWarranty?.coverage&&(
                <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                  <div style={{fontSize:13,fontWeight:800,color:C.tealInk,marginBottom:6}}>✓ Included manufacturer warranty</div>
                  <div style={{color:C.ink,fontSize:14,marginBottom:4}}>{analysis.standardWarranty.coverage}</div>
                  {analysis.standardWarranty.note&&<div style={{fontSize:12,color:C.inkFaint}}>{analysis.standardWarranty.note}</div>}
                </div>
              )}

              {/* EVAP rebate check -- rendered for any BEV/PHEV (new OR used),
                  since for a real EV the rebate status is information a buyer
                  wants; only regular gas/diesel cars are hidden, where "not
                  eligible" would just be noise. Reuses getRebate()/getEVAP() directly
                  (defined elsewhere in this same file) against the structured
                  year/make/model/fuelType/vehicleCondition fields the edge
                  function now extracts -- same EVAP logic already used and
                  verified for live listings, not a separate reimplementation.
                  Province is hardcoded to "AB" since LotCheck is Alberta-only
                  right now; revisit if that ever changes.

                  2026-07-22 fix: confirmed live (Gateway Toyota C-HR) that a
                  dealer page's OWN fuelType label can be wrong even when the
                  page's detailed technical specs (battery kWh, electric range,
                  NACS charging) are correct -- that page said "Fuel Type:
                  Gasoline" on a vehicle Toyota's own official press release
                  confirms is a genuine 77-kWh BEV, almost certainly a stale
                  inventory-system default never updated for the new model
                  year. A prompt-only fix (trust the structured field) made
                  this WORSE, not better -- it made the extraction confidently
                  wrong instead of uncertain. The real fix: don't rely purely
                  on the page's own fuelType read at all when year+make+model
                  matches the curated EVAP_LIST, which Vic has manually
                  verified against Transport Canada -- that's a source of
                  truth the page's own labels aren't. evapListMatch below
                  checks that FIRST; effectiveFuelType prefers the verified
                  list entry's fuel over the page extraction whenever there's
                  a match, and the outer gate now also fires on a list match
                  alone so a wrong "Gas" read can't hide a real EV rebate. */}
              {(()=>{
                const evapListMatch=analysis.year&&analysis.make&&analysis.model
                  ?getEVAP({year:analysis.year,make:analysis.make,model:analysis.model,km:0})
                  :null;
                const effectiveFuelType=evapListMatch?.fuel||analysis.fuelType;
                const fuelMismatch=!!evapListMatch&&analysis.fuelType&&analysis.fuelType!==evapListMatch.fuel;
                // Show for ANY BEV/PHEV, new or used -- for an actual EV the
                // rebate status (eligible, or the specific reason it isn't) is
                // real information, not noise. Only gas/diesel are hidden (the
                // fuel gate below). getRebate gets the real condition + price
                // so it reports "used / over cap / not on the list" correctly.
                if(!(analysis.year&&analysis.make&&analysis.model
                     &&(effectiveFuelType==="BEV"||effectiveFuelType==="PHEV"))) return null;
                const rebate=getRebate("AB",effectiveFuelType,{
                  year:analysis.year,make:analysis.make,model:analysis.model,
                  condition:analysis.vehicleCondition,
                  km:analysis.odometerKm||0,price:analysis.quotedPrice||analysis.msrp||0,
                });
                return(
                  <div style={{...cardStyle,background:rebate.eligible?C.tealBg:C.butterBg,border:`1px solid ${rebate.eligible?C.teal:C.butter}55`}}>
                    <div style={{fontSize:13,fontWeight:800,color:rebate.eligible?C.tealInk:C.butterInk,marginBottom:8}}>
                      {rebate.eligible?"🎉 EVAP rebate eligible":"⚡ EV/PHEV rebate check"}
                    </div>
                    {fuelMismatch&&(
                      <div style={{fontSize:11,color:C.inkFaint,marginBottom:8,fontStyle:"italic"}}>
                        This page's own fuel-type label said "{analysis.fuelType}", but our verified records for this exact year/make/model show it's actually a {evapListMatch.fuel} -- using the verified value here.
                      </div>
                    )}
                    {rebate.eligible?(
                      <>
                        <div style={{color:C.ink,fontSize:18,fontWeight:1000,marginBottom:4}}>${rebate.total.toLocaleString()} available</div>
                        <div style={{fontSize:12,color:C.inkSoft}}>
                          ${rebate.federal.toLocaleString()} federal
                          {rebate.provincial>0&&` + $${rebate.provincial.toLocaleString()} ${rebate.prov_name}`}
                          {rebate.note&&` — ${rebate.note}`}
                        </div>
                      </>
                    ):(
                      <div style={{fontSize:13,color:C.inkSoft}}>{rebate.ineligibleReason}</div>
                    )}
                  </div>
                );
              })()}

              {analysis.totalFlaggedCost>0&&(
                <div style={{...cardStyle,background:C.coralBg,border:`1px solid ${C.coral}55`}}>
                  {!addOnsAreFees?(
                    <>
                      <div style={{fontSize:13,color:C.coralInk,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>
                        <FlagWaveIcon size={15}/>
                        <span>${analysis.totalFlaggedCost.toLocaleString()} in conditional savings</span>
                      </div>
                      <div style={{fontSize:12,color:C.inkSoft,marginTop:4}}>These are advertised discounts or rebates with restrictions or hedged language -- confirm they actually apply to you before counting on them.</div>
                    </>
                  ):(
                    <>
                      <div style={{fontSize:13,color:C.coralInk,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>
                        <FlagWaveIcon size={15}/>
                        <span>${analysis.totalFlaggedCost.toLocaleString()} in flagged add-ons</span>
                      </div>
                      <div style={{fontSize:12,color:C.inkSoft,marginTop:4}}>These are commonly overpriced items worth questioning or negotiating down.</div>
                    </>
                  )}
                </div>
              )}

              {analysis.addOns?.length>0&&(
                <div style={cardStyle}>
                  <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:12}}>{!addOnsAreFees?"Discounts & conditions":"Add-ons & fees"}</div>
                  {analysis.addOns.map((a,i)=>{
                    // verdict: "good" (genuine buyer benefit -- a fair/legit
                    // rate, a real discount), "flagged" (worth questioning),
                    // or "standard" (a mandatory, unremarkable pass-through
                    // like tax/registration -- neither a win nor a problem,
                    // shown plainly so it isn't mislabeled as a "positive").
                    const v=a.verdict||(a.flagged?"flagged":"standard"); // fallback for any stale cached response shape
                    const priceColor=v==="good"?C.tealInk:v==="flagged"?C.coralInk:C.inkSoft;
                    return (
                      <div key={i} style={{padding:"10px 0",borderTop:i>0?`1px solid ${C.line}`:"none"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,color:C.ink,fontWeight:700,fontSize:14}}>
                            {v==="good"&&<span>✓</span>}
                            {v==="flagged"&&<FlagPyramidIcon size={13}/>}
                            <span>{a.name}</span>
                          </div>
                          <div style={{color:priceColor,fontWeight:800}}>${a.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                        </div>
                        <div style={{fontSize:12,color:v==="good"?C.tealInk:C.inkFaint,marginTop:2}}>{a.reason}</div>
                      </div>
                    );
                  })}
                  {/* Subtotal -- only for genuine fees, never discounts/
                      conditions (summing those as a total-added figure
                      would misrepresent them). When kind data exists,
                      sums only the fee-kind items, so a mixed report
                      (some fees, some discounts) doesn't fold a discount
                      into what should be a pure cost total. */}
                  {addOnsAreFees&&(()=>{
                    const feeItems=addOnsHaveKind?analysis.addOns.filter(a=>a.kind==="fee"):analysis.addOns;
                    if(!feeItems.length) return null;
                    return (
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0 0",marginTop:4,borderTop:`1px solid ${C.line}`}}>
                        <div style={{color:C.inkSoft,fontWeight:800,fontSize:13}}>Add-ons total</div>
                        <div style={{color:C.ink,fontWeight:1000,fontSize:15}}>${feeItems.reduce((sum,a)=>sum+(a.price||0),0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Payment breakdown: weekly / bi-weekly / monthly equivalents,
                  plus how much of each payment is interest (finance) or
                  lease charge (lease) vs principal/depreciation.
                  Requires analysis.financing from the edge function --
                  {type, termMonths, totalObligation, totalCostOfCredit} --
                  which doesn't exist in the schema yet as of this write, so
                  this renders nothing until that's added. All three
                  frequencies are derived from the SAME disclosed
                  totalObligation (re-sliced across a different number of
                  equal installments), not a re-derived amortization
                  schedule -- so it always ties back to a real number the
                  dealer already put on the page, e.g. the 260 weekly
                  payments in the Calgary Honda Civic example checks out
                  exactly: $27,952.60 / 260 = $107.51. IMPORTANT for whoever
                  wires up the edge function: totalObligation and
                  totalCostOfCredit must be on the SAME tax basis (both
                  pre-tax, ideally) or this percentage split is comparing
                  apples to oranges -- capture that explicitly rather than
                  assuming.

                  2026-07-22 fix: confirmed live on a real listing (Toyota
                  bZ, Macleod Trail Toyota) that this card was rendering
                  NOTHING even though the dealer's page disclosed a real
                  payment amount, frequency, and rate -- because that page
                  uses an interactive finance calculator with no committed
                  term shown, so termMonths/totalObligation both come back
                  null while paymentAmount/paymentFrequency/rate are known.
                  That's a common, legitimate real-world shape (not a
                  parsing failure), so this now has two paths: full data
                  gets the original weekly/biweekly/monthly toggle with the
                  principal/interest bar; partial data (payment+frequency
                  only) gets a simpler, honest card showing just what's
                  disclosed, with a clear note about what the dealer hasn't
                  committed to yet -- never silently hides the card just
                  because the page only gives a partial picture. */}
              {analysis.financing?.paymentAmount&&analysis.financing?.paymentFrequency&&(()=>{
                const f=analysis.financing;
                const hasFullData=!!(f.termMonths&&f.totalObligation);
                const freqLabel={weekly:"Weekly",biweekly:"Bi-weekly",monthly:"Monthly"};
                const freqSuffix={weekly:"week",biweekly:"2 weeks",monthly:"month"};
                const chargeWord=f.type==="lease"?"lease charge":"interest";

                if(!hasFullData){
                  // Partial data: show exactly what the dealer disclosed,
                  // in the frequency THEY stated it in -- no conversion,
                  // since converting to a different frequency requires
                  // termMonths, which isn't known here. Styled to feel as
                  // deliberate and complete as the full card -- a confirmed-
                  // data badge on what IS real, and the disclosure as a
                  // proper amber callout (same pattern as the EV rebate
                  // check card) instead of thin gray afterthought text --
                  // without inventing the missing term/total to fill space.
                  return (
                    <div style={cardStyle}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                        <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>
                          Payment breakdown{f.type==="lease"?" (lease)":f.type==="finance"?" (finance)":""}
                        </div>
                        <div style={{fontSize:11,fontWeight:800,color:C.tealInk,background:C.tealBg,padding:"3px 10px",borderRadius:999}}>rate confirmed</div>
                      </div>
                      <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4}}>
                        <div style={{fontSize:32,fontWeight:1000,color:C.ink}}>${f.paymentAmount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                        <div style={{fontSize:13,color:C.inkFaint}}>/{freqSuffix[f.paymentFrequency]||f.paymentFrequency}</div>
                      </div>
                      {!!f.rate&&(<div style={{fontSize:13,color:C.inkSoft,marginBottom:14}}>at <span style={{fontWeight:800,color:C.ink}}>{f.rate}% APR</span></div>)}
                      <div style={{background:C.butterBg,border:`1px solid ${C.butter}55`,borderRadius:14,padding:"12px 14px"}}>
                        <div style={{fontSize:12,fontWeight:800,color:C.butterInk,marginBottom:4}}>⚡ Term and total cost not shown</div>
                        <div style={{fontSize:12,color:C.inkSoft,lineHeight:1.5}}>
                          This dealer's page uses an interactive calculator with no default term selected, so only the payment and rate above are confirmed. Ask for the exact term and total cost in writing before relying on this payment figure.
                        </div>
                      </div>
                    </div>
                  );
                }

                const termMonths=f.termMonths;
                const totalObligation=f.totalObligation;
                const totalInterest=f.totalCostOfCredit||0;
                const periodsPerYear={weekly:52,biweekly:26,monthly:12};
                const periodsFor=freq=>termMonths*(periodsPerYear[freq]/12);
                const paymentFor=freq=>totalObligation/periodsFor(freq);
                const interestFor=freq=>totalInterest/periodsFor(freq);
                const payment=paymentFor(payFreq);
                const interest=interestFor(payFreq);
                const principal=Math.max(payment-interest,0);
                const interestPct=payment>0?Math.round((interest/payment)*100):0;
                return (
                  <div style={cardStyle}>
                    <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:12}}>
                      Payment breakdown{f.type==="lease"?" (lease)":f.type==="finance"?" (finance)":""}
                    </div>
                    <div style={{display:"flex",gap:6,marginBottom:14}}>
                      {["weekly","biweekly","monthly"].map(k=>(
                        <button key={k} onClick={()=>setPayFreq(k)}
                          style={{background:payFreq===k?C.tealBg:"transparent",color:payFreq===k?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                          {freqLabel[k]}
                        </button>
                      ))}
                    </div>
                    <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:10}}>
                      <div style={{fontSize:26,fontWeight:1000,color:C.ink}}>${payment.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                      <div style={{fontSize:12,color:C.inkFaint}}>/{freqSuffix[payFreq]}</div>
                    </div>
                    {totalInterest>0&&(
                      <>
                        <div style={{display:"flex",height:10,borderRadius:999,overflow:"hidden",marginBottom:8}}>
                          <div style={{width:`${100-interestPct}%`,background:C.teal}}/>
                          <div style={{width:`${interestPct}%`,background:C.coral}}/>
                        </div>
                        <div style={{display:"flex",gap:16,flexWrap:"wrap",fontSize:12,color:C.inkSoft,marginBottom:10}}>
                          <div><span style={{color:C.tealInk,fontWeight:800}}>${principal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span> principal{f.type==="lease"?"/depreciation":""}</div>
                          <div><span style={{color:C.coralInk,fontWeight:800}}>${interest.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span> {chargeWord} ({interestPct}%)</div>
                        </div>
                      </>
                    )}
                    <div style={{fontSize:12,color:C.inkFaint,borderTop:`1px solid ${C.line}`,paddingTop:10}}>
                      {termMonths} months total &middot; ${totalObligation.toLocaleString()} total obligation{f.totalObligationTaxIncluded&&" (tax included)"}{totalInterest>0&&` \u00b7 $${totalInterest.toLocaleString()} total ${chargeWord}`}
                    </div>
                  </div>
                );
              })()}

              {analysis.warranty?.offered&&(
                <div style={cardStyle}>
                  <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:8}}>Warranty / protection plan</div>
                  <div style={{color:C.ink,fontSize:14,marginBottom:4}}>{analysis.warranty.offered}{analysis.warranty.price?` — $${analysis.warranty.price.toLocaleString()}`:""}</div>
                  <div style={{fontSize:12,color:C.inkFaint}}>{analysis.warranty.assessment}</div>
                </div>
              )}

              <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                <div style={{fontSize:13,fontWeight:800,color:C.tealInk,marginBottom:8}}>Bottom line</div>
                <div style={{color:C.ink,fontSize:14,lineHeight:1.6}}>{analysis.summary}</div>
              </div>

              <div style={cardStyle}>
                <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:10}}>📧 Email me this report</div>
                {emailStatus==="sent"?(
                  <div style={{display:"flex",alignItems:"center",gap:8,color:C.tealInk,fontWeight:700,fontSize:14}}>
                    <span>✓</span> Sent to {emailInput.trim()}
                  </div>
                ):(
                  <>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      <input
                        type="email"
                        placeholder="you@email.com"
                        value={emailInput}
                        onChange={e=>{setEmailInput(e.target.value);if(emailErr)setEmailErr("");}}
                        disabled={emailStatus==="sending"}
                        style={{flex:"1 1 200px",background:C.paper,border:`2px solid ${emailErr?C.coral:C.line}`,borderRadius:10,padding:"11px 14px",color:C.ink,fontSize:14,outline:"none",boxSizing:"border-box"}}
                      />
                      <button onClick={sendReportEmail} disabled={emailStatus==="sending"}
                        style={{background:emailStatus==="sending"?C.tealInk:C.teal,border:"none",borderRadius:10,padding:"11px 20px",color:"#fff",fontWeight:800,fontSize:14,cursor:emailStatus==="sending"?"default":"pointer",whiteSpace:"nowrap"}}>
                        {emailStatus==="sending"?"Sending…":"Send"}
                      </button>
                    </div>
                    {emailErr&&<div style={{fontSize:12,color:C.coralInk,marginTop:8}}>{emailErr}</div>}
                    <div style={{fontSize:11,color:C.inkFaint,marginTop:8}}>Used once to send this report, then not kept.</div>
                  </>
                )}
              </div>

              <button onClick={reset} style={{width:"100%",background:C.ink,border:"none",borderRadius:999,padding:"13px",color:C.paper,fontWeight:800,cursor:"pointer",boxShadow:"5px 6px 0 rgba(51,48,90,.16)"}}>Check another quote</button>
            </div>
          )}

          <div style={{textAlign:"center",marginTop:20,fontSize:11,color:C.inkFaint}}>
            LotCheck never saves your quote to our own systems. It's analyzed once, then discarded on our end — nothing is stored.
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
  // Routed through /api/track-visit (a Vercel Edge Function) rather than
  // writing to Supabase directly from here, since real visitor geolocation
  // can only be read server-side from the incoming request -- the browser
  // itself has no way to see that.
  useEffect(()=>{
    const visitorId=getOrCreateVisitorId();
    fetch("/api/track-visit",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        visitor_id: visitorId||"unknown",
        path: window.location.pathname||"/",
        referrer_source: classifyReferrer(),
      }),
    }).catch(err=>console.warn("⚠️ visit tracking failed:",err.message));
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
          <a href="/quote-check" className="lc-header-right" style={{background:"#0175ff",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontWeight:700,fontSize:13,textDecoration:"none",whiteSpace:"nowrap"}}>
            📄 Check a quote
          </a>
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
