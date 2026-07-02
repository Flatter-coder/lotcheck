import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar } from "recharts";
import { createClient } from "@supabase/supabase-js";

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

  /* Card content sits above the live background */
  .lc-layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
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

  /* Sidebar */
  .lc-sidebar {
    width: 100%;
    border-bottom: 1px solid #1e293b;
  }
  @media (min-width: 768px) {
    .lc-sidebar {
      width: 340px;
      min-width: 320px;
      max-width: 380px;
      border-bottom: none;
      border-right: 1px solid #1e293b;
      height: calc(100vh - 57px);
      position: sticky;
      top: 57px;
      overflow-y: auto;
    }
  }
  @media (min-width: 1024px) {
    .lc-sidebar { width: 380px; }
  }

  /* Detail panel */
  .lc-detail {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }
  @media (min-width: 768px) {
    .lc-detail {
      height: calc(100vh - 57px);
      position: sticky;
      top: 57px;
      overflow-y: auto;
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
  const federal=fuel==="BEV"?r.federal_bev:fuel==="PHEV"?r.federal_phev:0;
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

function ScorePill({score}){
  if(score==null) return <span className="badge" style={{background:"#1e293b80",color:"#64748b",border:"1px solid #33415560"}}>No comps yet</span>;
  const c=score>=70?"#16a34a":score>=45?"#d97706":"#dc2626";
  const l=score>=70?"✓ Great Deal":score>=45?"~ Fair Price":"↑ Above Market";
  return<span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}35`}}>{l}</span>;
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

function DetailPanel({listing,isPro,liveListings,history,historyLoading,onConnect,onUpgrade,onTestDrive}){
  const priceHistory = history || [];
  const [tab,setTab]=useState("chart");
  const [unlocks,setUnlocks]=useState({});
  const [unlockModal,setUnlockModal]=useState(null);
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel,listing);
  const score=lotScore(listing,liveListings);

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
  const comps=(liveListings||[]).filter(x=>x.model===listing.model&&x.id!==listing.id);
  const compAvgPrice=comps.length?Math.round(comps.reduce((s,x)=>s+x.price,0)/comps.length):null;

  // Real "days on LotCheck" — from the first price_history point we've ever
  // recorded for this listing. This is NOT the same as "days since posted
  // on Kijiji" (Kijiji's postedDate is frequently null in scraped data) —
  // it's honestly labeled as our own tracking duration only.
  const daysTracked=priceHistory.length?Math.max(0,Math.floor((Date.now()-new Date(priceHistory[0].recorded_at))/86400000)):null;


  const cbb={retail:Math.round(listing.price*1.05),trade:Math.round(listing.price*Math.max(0.4,1-(2026-listing.year)*0.08)*Math.max(0.7,1-(listing.km/300000)*0.35)*0.82)};
  cbb.wholesale=Math.round(cbb.trade*0.91);

  const key=f=>`${listing.id}-${f}`;
  const isUnlocked=f=>isPro||unlocks[key(f)];
  const unlockPrice={vin:2.99,cbb:2.99};

  return(
    <div style={{padding:"16px"}}>
      <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",marginBottom:8,lineHeight:1.3}}>{listing.name}</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
        <ScorePill score={score}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
        <span className="badge" style={{background:"#1e293b",color:"#64748b"}}>{listing.city}, {listing.province}</span>
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
          and its UnlockModal entry are left in place below, unused — add
          ["vin", isUnlocked("vin")?"🔍 VIN History":"🔒 VIN $2.99"] back to
          this array to re-enable once that's resolved. */}
      <div className="lc-tabs">
        {[["chart","📈 Chart"],["rebates","⚡ Rebates"],["cbb",isUnlocked("cbb")?"📊 Value Est.":"🔒 Value Est. $2.99"],["insurance","🛡️ Insurance"]].map(([t,l])=>(
          <button key={t} className={`lc-tab${tab===t?" active":""}`} onClick={()=>{
            if(t==="cbb"&&!isUnlocked(t)){setUnlockModal(t);return;}
            setTab(t);
          }}>
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
          {isPro?(
            <div className="lc-stat"><div className="lc-stat-label">Tracked</div><div className="lc-stat-value">{daysTracked==null?"New today":`${daysTracked}d on LotCheck`}</div></div>
          ):(
            <div className="lc-stat" onClick={onUpgrade} style={{cursor:"pointer"}}>
              <div className="lc-stat-label">Tracked</div>
              <div className="lc-stat-value" style={{color:"#475569",fontSize:13}}>🔒 Pro</div>
            </div>
          )}
        </div>
      </>}
      {tab==="rebates"&&<EVAPRebateTab listing={listing} rebate={rebate}/>}
      {tab==="cbb"&&isUnlocked("cbb")&&(
        <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:14,padding:"16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1}}>LOTCHECK VALUE ESTIMATE · PRO</div>
            <InfoTooltip title="HOW THIS IS CALCULATED">
              This is <strong style={{color:"#f1f5f9"}}>not</strong> licensed Black Book, CBB, or any third-party valuation data — LotCheck doesn't have access to that.
              <br/><br/>
              It's a formula built entirely from <strong style={{color:"#f1f5f9"}}>this listing's own asking price</strong>: Retail = asking price + a small markup. Trade-in = asking price reduced for the vehicle's age and odometer reading. Wholesale = trade-in reduced further, as an auction estimate typically runs.
              <br/><br/>
              Useful as a rough reference point — not a substitute for a real appraisal or a licensed valuation service.
            </InfoTooltip>
          </div>
          <div style={{fontSize:11,color:"#475569",marginBottom:12,lineHeight:1.5}}>Our own algorithmic estimate based on this vehicle's asking price, mileage, and age — not a licensed third-party valuation.</div>
          <div className="lc-stats">
            {[["Retail",cbb.retail,"#22c55e","Dealer asking range"],["Trade-in",cbb.trade,"#f59e0b","What dealer pays"],["Wholesale",cbb.wholesale,"#94a3b8","Auction estimate"]].map(([l,v,c,sub])=>(
              <div key={l} className="lc-stat" style={{borderColor:"#1e3a5f"}}>
                <div className="lc-stat-label">{l}</div>
                <div style={{fontSize:17,fontWeight:700,color:c,marginBottom:2}}>${v.toLocaleString()}</div>
                <div style={{fontSize:10,color:"#334155"}}>{sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Paused — see note above tabs array. Re-enable by uncommenting:
      {tab==="vin"&&isUnlocked("vin")&&<VINHistoryPanel listing={listing}/>} */}
      {tab==="insurance"&&<InsurancePanel listing={listing}/>}

      <div style={{display:"flex",gap:8}}>
        <button onClick={onConnect} className="lc-connect-btn" style={{flex:2}}>
          <span>🤝</span><span>Connect me with a dealer</span>
          {rebate.eligible&&rebate.total>0&&<span style={{background:"rgba(255,255,255,0.2)",borderRadius:6,padding:"2px 8px",fontSize:12}}>⚡ ${rebate.total.toLocaleString()}</span>}
        </button>
        <button onClick={onTestDrive} style={{flex:1,background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:14,padding:"0 14px",color:"#60a5fa",fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,whiteSpace:"nowrap"}}>
          <span>🚗</span><span>Test drive</span>
        </button>
      </div>

      {unlockModal&&(
        <UnlockModal feature={unlockModal} price={unlockPrice[unlockModal]}
          onUnlock={()=>{setUnlocks(prev=>({...prev,[key(unlockModal)]:true}));setTab(unlockModal);}}
          onClose={()=>setUnlockModal(null)} onUpgrade={()=>{setUnlockModal(null);onUpgrade();}}
        />
      )}
    </div>
  );
}

function ListingCard({listing,liveListings,history,isPro,onClick,active}){
  const score=lotScore(listing,liveListings);
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel,listing);
  // Real price-drop detection: compare the two most recent recorded_at
  // points for this exact listing. Only shows when we've actually observed
  // a drop — never a guess or a fabricated "sale" signal.
  const h=history||[];
  const hasDrop=h.length>=2&&h[h.length-1].price<h[h.length-2].price;
  const dropAmount=hasDrop?h[h.length-2].price-h[h.length-1].price:0;
  return(
    <div className={`lc-card${active?" active":""}`} onClick={()=>onClick(listing)}>
      <div className="lc-card-name">{listing.name}</div>
      <div className="lc-card-badges">
        <ScorePill score={score}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
        {isPro&&hasDrop&&<span className="badge" style={{background:"#16a34a18",color:"#22c55e",border:"1px solid #22c55e35"}}>🔻 ${dropAmount.toLocaleString()}</span>}
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
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#020617"}}>
      <form onSubmit={handleLogin} style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:20,padding:"40px 36px",width:360,maxWidth:"90vw",textAlign:"center",boxSizing:"border-box"}}>
        <div style={{width:56,height:56,background:"linear-gradient(135deg,#16a34a,#0ea5e9)",borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,margin:"0 auto 16px"}}>✅</div>
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

function AdminPanel(){
  const [session,setSession]=useState(null);
  const [checkingSession,setCheckingSession]=useState(true);
  const [leads,setLeads]=useState([]);
  const [leadsLoading,setLeadsLoading]=useState(true);
  const {listings:liveListings, loading:listingsLoading}=useListings();

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
        console.warn("⚠️ leads fetch failed (check you're logged in and RLS policies are applied):",err.message);
        if(!cancelled) setLeads([]);
      }finally{
        if(!cancelled) setLeadsLoading(false);
      }
    }
    fetchLeads();
    return()=>{cancelled=true;};
  },[session]);

  async function updateLeadStatus(id,status){
    const {error}=await supabase.from("leads").update({status}).eq("id",id);
    if(!error) setLeads(prev=>prev.map(l=>l.id===id?{...l,status}:l));
  }

  if(checkingSession) return <div style={{minHeight:"100vh",background:"#020617",display:"flex",alignItems:"center",justifyContent:"center",color:"#475569"}}>Loading…</div>;
  if(!session) return <AdminLogin/>;

  // Real analytics — computed from actual live listings and actual leads.
  // Nothing here is estimated or fabricated; if a number is empty, it's
  // because there's genuinely no data yet, not because it's hidden.
  const byProvince={};
  const byFuel={};
  let evapCount=0;
  liveListings.forEach(l=>{
    byProvince[l.province]=(byProvince[l.province]||0)+1;
    byFuel[l.fuel]=(byFuel[l.fuel]||0)+1;
    if(getEVAP(l)) evapCount++;
  });
  const byLeadType={};
  leads.forEach(l=>{ byLeadType[l.lead_type]=(byLeadType[l.lead_type]||0)+1; });

  return(
    <div style={{minHeight:"100vh",background:"#020617",color:"#e2e8f0",padding:"24px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,maxWidth:1100,margin:"0 auto 24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:"linear-gradient(135deg,#16a34a,#0ea5e9)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>✅</div>
          <div style={{fontWeight:800,fontSize:18}}>LotCheck Admin</div>
        </div>
        <button onClick={()=>supabase.auth.signOut()} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:"8px 14px",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>Sign out</button>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#64748b",letterSpacing:1,marginBottom:10}}>LISTINGS · {listingsLoading?"loading…":`${liveListings.length} live`}</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:28}}>
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
      </div>
    </div>
  );
}

// App is the actual default export/root — it must not call any hooks itself
// (Rules of Hooks), so routing between the buyer-facing site and the admin
// panel happens here by choosing which fully separate component to mount,
// rather than an early-return inside a hook-using component.
export default function App(){
  return window.location.pathname.startsWith("/admin") ? <AdminPanel/> : <LotCheckApp/>;
}

function LotCheckApp(){
  const [trialStatus,setTrialStatus]=useState(()=>getTrialStatus());
  const isPro = trialStatus.state==="active";
  const [showPro,setShowPro]=useState(false);
  const [showArrivals,setShowArrivals]=useState(false);
  const [showAppraisal,setShowAppraisal]=useState(false);
  const [showConnect,setShowConnect]=useState(false);
  const [showTestDrive,setShowTestDrive]=useState(false);
  const [selected,setSelected]=useState(null);
  const [province,setProvince]=useState("ALL");
  const [fuelFilter,setFuelFilter]=useState("All");
  const [search,setSearch]=useState("");
  const [isMobile,setIsMobile]=useState(window.innerWidth<768);

  const {listings:liveListings, loading:dataLoading, isLive}=useListings();
  const {historyMap, historyLoading}=usePriceHistoryMap();

  // Re-check trial status every minute so the UI reflects real expiry
  // instead of staying "Pro" forever once granted.
  useEffect(()=>{
    const t=setInterval(()=>setTrialStatus(getTrialStatus()),60000);
    return()=>clearInterval(t);
  },[]);

  const handleStartTrial=()=>{
    if(trialStatus.state==="none"){
      startTrial();
      setTrialStatus(getTrialStatus());
    }
  };

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
        <div style={{minHeight:"100vh",background:"#020617"}}>
          <div style={{background:"#060d18",borderBottom:"1px solid #1e293b",padding:"12px 16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:100}}>
            <button onClick={()=>setSelected(null)} style={{background:"#1e293b",border:"none",borderRadius:8,padding:"8px 14px",color:"#e2e8f0",cursor:"pointer",fontSize:14,fontWeight:600}}>← Back</button>
            <div style={{flex:1,fontSize:13,fontWeight:600,color:"#f1f5f9",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selected.name}</div>
            {isPro?<span style={{fontSize:11,color:"#22c55e",fontWeight:700,whiteSpace:"nowrap"}}>✅ {formatMsLeft(trialStatus.msLeft)} left</span>:<button onClick={()=>setShowPro(true)} style={{background:"#16a34a",border:"none",borderRadius:8,padding:"6px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Pro</button>}
          </div>
          <DetailPanel key={selected.id} listing={selected} isPro={isPro} liveListings={liveListings} history={historyMap[selected.external_id]} historyLoading={historyLoading} onConnect={()=>setShowConnect(true)} onUpgrade={()=>setShowPro(true)} onTestDrive={()=>setShowTestDrive(true)}/>
        </div>
        {showConnect&&<ConnectModal listing={selected} onClose={()=>setShowConnect(false)}/>}
        {showTestDrive&&<TestDriveModal listing={selected} onClose={()=>setShowTestDrive(false)}/>}
        {showPro&&<ProModal onStart={handleStartTrial} onClose={()=>setShowPro(false)} trialStatus={trialStatus}/>}
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
            <div style={{width:32,height:32,background:"linear-gradient(135deg,#16a34a,#0ea5e9)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>✅</div>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:800,fontSize:16,letterSpacing:"-0.5px",lineHeight:1}}>LotCheck</div>
              <div style={{fontSize:9,color:"#334155",fontStyle:"italic",whiteSpace:"nowrap"}}>Did you LotCheck it?</div>
            </div>
          </div>
          <div className="lc-header-right">
            <button onClick={()=>setShowAppraisal(true)} style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:10,padding:"7px 10px",color:"#60a5fa",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
              💰 <span className="lc-header-appraisal-text">My car's worth</span>
            </button>
            <button onClick={()=>{isPro?setShowArrivals(true):setShowPro(true);}} style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:10,padding:"7px 10px",color:"#60a5fa",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
              🗓️ <span className="lc-header-appraisal-text">New arrivals</span>
            </button>
            {isPro
              ?<div style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#22c55e",fontWeight:700,whiteSpace:"nowrap"}}>✅ {formatMsLeft(trialStatus.msLeft)} left</div>
              :<button onClick={()=>setShowPro(true)} style={{background:"#16a34a",border:"none",borderRadius:10,padding:"7px 12px",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>{trialStatus.state==="expired"?"Trial ended":"Try Pro free"}</button>
            }
          </div>
        </header>

        <LiveTicker listings={liveListings} onSelect={handleSelect}/>
        {showAppraisal&&<AppraisalModal onClose={()=>setShowAppraisal(false)}/>}
        {showArrivals&&isPro&&<ArrivalsModal liveListings={liveListings} historyMap={historyMap} onClose={()=>setShowArrivals(false)}/>}

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
                  ?<span>⏳ Loading live listings...</span>
                  :<><span style={{color:isLive?"#22c55e":"#475569"}}>{isLive?"🟢":"⚪"}</span> {filtered.length} listings · {isLive?"Live · Canada":"Demo data"}</>
                }
              </div>
              {filtered.length===0&&<div className="lc-empty">No listings match your filters</div>}
              {filtered.map(l=><ListingCard key={l.id} listing={l} liveListings={liveListings} history={historyMap[l.external_id]} isPro={isPro} onClick={handleSelect} active={selected?.id===l.id}/>)}
            </div>
            <div className="lc-footer">© 2026 LotCheck · lotcheck.ca · "Did you LotCheck it?" ™</div>
          </div>

          <div className="lc-detail">
            {selected?(
              <DetailPanel key={selected.id} listing={selected} isPro={isPro} liveListings={liveListings} history={historyMap[selected.external_id]} historyLoading={historyLoading} onConnect={()=>setShowConnect(true)} onUpgrade={()=>setShowPro(true)} onTestDrive={()=>setShowTestDrive(true)}/>
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
      {showPro&&<ProModal onStart={handleStartTrial} onClose={()=>setShowPro(false)} trialStatus={trialStatus}/>}
    </>
  );
}
