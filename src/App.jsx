import { useState, useEffect, useRef, useContext, createContext, useMemo, Component } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from "recharts";
import { createClient } from "@supabase/supabase-js";
import { Analytics } from "@vercel/analytics/react";
import heic2any from "heic2any";
// THE SAME module the edge functions use. Not a copy — a copy is how six
// surfaces ended up with six different answers to "may this MSRP support a
// claim". Pure TypeScript, no Deno APIs, so Vite compiles it for the browser.
import { qualifyMsrpClaim, isManufacturerFigure, qualifyCeilingClaim } from "../supabase/functions/_shared/msrp-claim.ts";
import DealOrrery from "./DealOrrery.jsx";

// ---------------------------------------------------------------------------
// Alberta-only access gate.
//
// LotCheck answers Alberta questions: AMVIC all-in advertising, Alberta EVAP,
// the AMVIC dealer registry, Alberta fee benchmarks. Running a report for a
// Manitoba buyer would give Alberta answers to a different province's question.
//
// /api/geo runs on Vercel, which terminates the connection and therefore is the
// only part of the stack that sees the real IP. It returns a verdict plus a
// short-lived HMAC token that the edge functions verify — the browser is never
// trusted to state its own province, because the analyze functions spend real
// vendor money.
//
// IP geolocation is not truth: Canadian carriers backhaul through regional
// hubs, so a Calgary phone can resolve to Toronto. Everything below therefore
// fails OPEN, and a visitor who is told they look out-of-province can say so
// and continue. Refusing one paying Albertan is worse than serving a few
// visitors we should not have.
// ---------------------------------------------------------------------------
const REGION_SELF_DECLARE_KEY = "lc-region-self-declared";
let _regionState = null;

function regionAttestation(){
  return {
    regionToken: _regionState?.token ?? null,
    regionSelfDeclared: (()=>{ try{ return localStorage.getItem(REGION_SELF_DECLARE_KEY)==="1"; }catch{ return false; } })(),
  };
}

function useRegionGate(){
  const [state,setState]=useState(_regionState);
  const [declared,setDeclared]=useState(()=>{ try{ return localStorage.getItem(REGION_SELF_DECLARE_KEY)==="1"; }catch{ return false; } });
  useEffect(()=>{
    if(_regionState){ setState(_regionState); return; }
    let cancelled=false;
    (async()=>{
      try{
        const res=await fetch("/api/geo",{headers:{Accept:"application/json"}});
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        _regionState=await res.json();
      }catch(err){
        // Fail open, loudly enough to find in the console but never to the user.
        console.warn("region check unavailable — serving:",err?.message||err);
        _regionState={served:true,reason:"unavailable",enforced:false,token:null,region:null,regionLabel:null};
      }
      if(!cancelled) setState(_regionState);
    })();
    return()=>{cancelled=true;};
  },[]);
  const declare=()=>{ try{ localStorage.setItem(REGION_SELF_DECLARE_KEY,"1"); }catch{} setDeclared(true); };
  // Undecided (null) is NOT blocked — the check simply hasn't answered yet.
  const blocked = !!state && state.served===false && !declared;
  return { state, blocked, declared, declare };
}

// Shown instead of the check when a visitor resolves outside Alberta. It does
// three jobs: say why plainly, capture the demand so an out-of-province visitor
// becomes expansion inventory rather than a lost tab, and offer the appeal —
// because geolocation is wrong often enough that a wall without a door would
// cost real Alberta customers.
function RegionBlockCard({ state, onDeclare }){
  const [email,setEmail]=useState("");
  const [sent,setSent]=useState(false);
  const [busy,setBusy]=useState(false);
  const where = state?.regionLabel || (state?.reason==="other_country" ? "outside Canada" : "outside Alberta");

  const join=async(e)=>{
    e.preventDefault();
    if(!email.trim()||busy) return;
    setBusy(true);
    try{
      await supabase.from("region_waitlist").insert({
        email: email.trim().toLowerCase(),
        country: state?.country ?? null,
        region: state?.region ?? null,
      });
      setSent(true);
    }catch(err){
      console.warn("waitlist insert failed:",err?.message||err);
      setSent(true); // never show a failure for a signup; the address is captured or it isn't
    }finally{ setBusy(false); }
  };

  return (
    <div style={{maxWidth:620,margin:"48px auto",padding:"0 20px",fontFamily:"inherit"}}>
      <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:16,padding:"28px 26px",color:"#e2e8f0"}}>
        <div style={{fontSize:12,fontWeight:800,letterSpacing:1.4,color:"#f0997b",marginBottom:10}}>
          ALBERTA ONLY
        </div>
        <h2 style={{fontSize:23,margin:"0 0 12px",lineHeight:1.3,color:"#fff"}}>
          LotCheck isn&rsquo;t available in {where} yet
        </h2>
        <p style={{fontSize:15,lineHeight:1.65,color:"#cbd5e1",margin:"0 0 14px"}}>
          Every answer LotCheck gives is an Alberta answer &mdash; AMVIC&rsquo;s all-in
          advertising rule, Alberta EVAP rebates, the AMVIC dealer registry,
          Alberta fee benchmarks. Running a report on a {where} listing would
          give you Alberta answers to a different province&rsquo;s question, which is
          worse than giving you nothing.
        </p>
        <p style={{fontSize:13.5,lineHeight:1.6,color:"#94a3b8",margin:"0 0 20px"}}>
          Use outside Alberta is a breach of our{" "}
          <a href="/terms.html" style={{color:"#16a34a"}}>Terms of Service</a>.
        </p>

        {!sent ? (
          <form onSubmit={join} style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
            <input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)}
              placeholder="you@email.com" aria-label="Email for the waitlist"
              style={{flex:"1 1 220px",background:"#020617",border:"1px solid #1e293b",borderRadius:10,
                      padding:"12px 14px",color:"#e2e8f0",fontSize:15,fontFamily:"inherit",outline:"none"}}/>
            <button type="submit" disabled={busy}
              style={{background:busy?"#334155":"#16a34a",border:"none",borderRadius:10,padding:"12px 20px",
                      color:"#fff",fontWeight:800,fontSize:15,fontFamily:"inherit",cursor:busy?"default":"pointer"}}>
              {busy?"…":"Tell me when it opens"}
            </button>
          </form>
        ) : (
          <div style={{background:"rgba(22,163,74,.12)",border:"1px solid #16a34a",borderRadius:10,
                       padding:"12px 14px",fontSize:14,color:"#bbf7d0",marginBottom:18}}>
            You&rsquo;re on the list for {where}. We&rsquo;ll email you when LotCheck opens there.
          </div>
        )}

        <div style={{borderTop:"1px solid #1e293b",paddingTop:16,fontSize:13.5,color:"#94a3b8",lineHeight:1.6}}>
          Location is worked out from your network, and it gets it wrong &mdash;
          Alberta carriers often route through other provinces.{" "}
          <button onClick={onDeclare}
            style={{background:"none",border:"none",padding:0,color:"#16a34a",fontSize:13.5,
                    fontFamily:"inherit",fontWeight:700,textDecoration:"underline",cursor:"pointer"}}>
            I&rsquo;m in Alberta &mdash; let me through
          </button>
        </div>
      </div>
    </div>
  );
}
import PlanetAlerts from "./PlanetAlerts.jsx";

// ── Supabase client (anon key — safe to expose in frontend) ───────────────────
// Public anon key. Named once so the credit-aware fetches below can send it as
// the `apikey` header (and as the Bearer fallback for anonymous requests) without
// re-pasting the literal.
const SB_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A";
const supabase = createClient(
  "https://debigtyjhjamipooajhk.supabase.co",
  SB_ANON_KEY
  // No custom auth options -> supabase-js defaults apply: persistSession:true
  // and detectSessionInUrl:true, so a magic-link return (…/quote-check#access_token=…)
  // establishes the session automatically on load and survives reloads.
);

// ── User auth (magic link) ────────────────────────────────────────────────────
// Single source of truth for the current Supabase auth user in the *public*
// app. Reads the existing session once on mount, then keeps it live via one
// onAuthStateChange subscription (cleaned up on unmount). The admin dashboard
// (AdminPanel) manages its own session on the /admin route; that component and
// the public pages are never mounted at the same time (App routes to exactly
// one page by pathname), so these subscriptions never coexist or conflict.
// The same magic-link OTP and password (admin) flows share this one client.
// Returns: a user object when signed in, null when CONFIRMED signed out, and
// `undefined` while getSession() is still in flight.
//
// That third state matters. getSession() is async, so on every page load there
// is a window where a signed-in person reads as falsy. Code that treats falsy
// as "signed out" will bounce a paying user to the sign-in modal during it —
// which is exactly what happened when the free-check gate started trusting
// this value synchronously. Both undefined and null are falsy, so every
// existing `if(user)` check behaves identically; only code that needs to know
// the difference tests for undefined.
function useSupabaseUser(){
  const [user,setUser]=useState(undefined);
  useEffect(()=>{
    let active=true;
    supabase.auth.getSession().then(({data})=>{
      if(active) setUser(data.session?.user||null);
    });
    const {data:sub}=supabase.auth.onAuthStateChange((_event,session)=>{
      setUser(session?.user||null);
    });
    return()=>{ active=false; sub.subscription.unsubscribe(); };
  },[]);
  return user;
}

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

// ── Quote Check credits ─────────────────────────────────────────────────
// The old client-side subscription/bundle stopgap is gone. Credits are now
// server-authoritative (Phase 3 edge functions + fn_my_credits RPC): the
// frontend only DISPLAYS balances the server reports and never grants or
// deducts locally. The one thing still tracked client-side is the single
// anonymous free check, gated by a per-device localStorage flag.
const LC_FREE_USED_KEY = "lc_free_used";
function isFreeCheckUsed() {
  try { return window.localStorage.getItem(LC_FREE_USED_KEY) === "1"; }
  catch { return false; } // localStorage unavailable (private browsing etc.)
}
function markFreeCheckUsed() {
  try { window.localStorage.setItem(LC_FREE_USED_KEY, "1"); } catch {}
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

// Single source of truth for the EVAP rebate on a Quote Check report.
//
// The server never sends an `evapRebate` field -- the rebate is derived on the
// client from the EVAP list plus the analysis. That derivation used to be
// inlined in two places (the scroll view and the emailed-report payload), and
// the 10-point panel instead read `analysis.evapRebate`, a field nothing ever
// populates. Result: on a BEV, the scroll view and the email showed the real
// rebate while the deck/heatmap/sidebar rendered a dead "—". Measured
// 2026-08-11 on three live BEV listings (bZ4X, Bolt, Equinox EV) -- all three
// showed "—" on the panel, and the Jack Carter page was openly advertising a
// $4,762 federal rebate at the time.
//
// Every surface that renders the rebate goes through this function. Adding a
// new view means calling it, not re-deriving it.
function resolveEvap(a){
  const none = { show:false, rebate:null, effectiveFuelType:a?.fuelType || null, fuelMismatch:false, listMatch:null };
  if(!a || !a.year || !a.make || !a.model) return none;
  let listMatch = null;
  try{ listMatch = getEVAP({ year:a.year, make:a.make, model:a.model, km:0 }); }catch{ listMatch = null; }
  // Our verified list wins over the page's own fuel-type label -- dealer pages
  // mislabel drivetrains, and the mismatch is surfaced to the buyer.
  const effectiveFuelType = listMatch?.fuel || a.fuelType;
  const fuelMismatch = !!listMatch && !!a.fuelType && a.fuelType !== listMatch.fuel;
  const show = effectiveFuelType === "BEV" || effectiveFuelType === "PHEV";
  if(!show) return { show:false, rebate:null, effectiveFuelType, fuelMismatch, listMatch };
  return {
    show:true,
    rebate: getRebate("AB", effectiveFuelType, {
      year:a.year, make:a.make, model:a.model,
      condition:a.vehicleCondition,
      km:a.odometerKm || 0,
      price:a.quotedPrice || a.msrp || 0,
    }),
    effectiveFuelType, fuelMismatch, listMatch,
  };
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
          .select("feature, success, input_tokens, output_tokens, cost_usd, error_message, created_at")
          .order("created_at", {ascending:true})
          .limit(50000);
        if(error) throw error;
        if(!cancelled) setUsage(data||[]);
      }catch(err){
        console.warn("⚠️ api_usage_log fetch failed (did you run create_api_usage_log_table.sql?):", err.message);
        // Blank ONLY on the very first read, where an empty panel is the honest
        // "we have nothing" state. On a refresh, keep what we already have: a
        // transient network blip must not wipe a populated ledger back to 0 and
        // recreate the exact "it's not even showing" confusion this polling was
        // added to fix.
        if(!cancelled) setUsage(prev=>prev.length?prev:[]);
      }finally{
        if(!cancelled) setUsageLoading(false);
      }
    }
    fetchUsage();
    // The Verification Ledger is labelled "● LIVE", but this used to fetch
    // exactly once on mount and never again -- so a panel opened before a scan
    // ran showed 0 checks forever and looked like nothing was happening
    // (2026-08-15: two real rows existed, the ledger read 0). A surface that
    // says LIVE has to actually re-read (live-data-green-dot); a one-shot
    // snapshot wearing a live badge is the misleading-label class we keep
    // fixing everywhere else.
    //
    // 45s is frequent enough that a scan shows up while you are still looking
    // at the panel, and this is an admin-only, single-viewer surface. Also
    // re-reads the moment the tab regains focus, which is when you actually
    // look at it after running a scan in another window.
    const id=setInterval(fetchUsage,45_000);
    const onFocus=()=>{ if(document.visibilityState==="visible") fetchUsage(); };
    document.addEventListener("visibilitychange",onFocus);
    window.addEventListener("focus",onFocus);
    return()=>{
      cancelled=true;
      clearInterval(id);
      document.removeEventListener("visibilitychange",onFocus);
      window.removeEventListener("focus",onFocus);
    };
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

// Self-contained animated brand mark — the same gate+car as LogoMark, but it
// carries its OWN keyframes so the car drives through the gate on any page,
// including the cosmic pages (MSRP/Verify/Trust) that don't load GLOBAL_CSS.
function SiteLogo({ size = 30 }) {
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <style dangerouslySetInnerHTML={{__html:`
        .slc-car{animation:slcDrive 4s linear infinite}
        .slc-win{animation:slcFlash 4s linear infinite}
        @keyframes slcDrive{0%{transform:translate(-95px,-47px);opacity:0}10%{opacity:1}50%{transform:translate(0,0)}90%{opacity:1}100%{transform:translate(95px,47px);opacity:0}}
        @keyframes slcFlash{0%,40%{opacity:.22}50%{opacity:.68}60%,100%{opacity:.22}}
        @media(prefers-reduced-motion:reduce){.slc-car,.slc-win{animation:none!important}}
      `}}/>
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
        <g className="slc-win"><polygon points="6,17 -82,61 -82,17 6,-27" fill="rgba(58,224,255,.5)"/></g>
        <g className="slc-car">
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
        border:"none", borderRadius:6, padding:"5px 11px", fontSize:13.5, fontWeight:700, cursor:"pointer",
      }}>🌙 Dark</button>
      <button onClick={()=>toggleTheme("light")} style={{
        background: theme==="light" ? C.card : "transparent",
        color: theme==="light" ? C.ink : C.inkFaint,
        border:"none", borderRadius:6, padding:"5px 11px", fontSize:13.5, fontWeight:700, cursor:"pointer",
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
          <div style={{fontSize:14.5,color:C.inkFaint,marginBottom:24,lineHeight:1.5}}>Real Supabase login — leads data is protected at the database level, not just this screen.</div>
          <input type="email" placeholder="you@lotcheck.ca" value={email} onChange={e=>setEmail(e.target.value)} required
            style={{width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"12px 14px",color:C.ink,fontSize:14,marginBottom:10,outline:"none",boxSizing:"border-box"}}/>
          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required
            style={{width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"12px 14px",color:C.ink,fontSize:14,marginBottom:14,outline:"none",boxSizing:"border-box"}}/>
          {err&&<div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:8,padding:"10px 14px",fontSize:14.5,color:C.coralInk,marginBottom:14,textAlign:"left"}}>{err}</div>}
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
      color: active ? C.ink : C.inkFaint, fontSize: 14.5, fontWeight: 700,
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
        <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>
          DEALER NETWORK · {dealersLoading?"loading…":`${dealers.length} dealer${dealers.length===1?"":"s"}`}
        </div>
        <button onClick={onAdd} style={{background:C.teal,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:13.5,fontWeight:800,cursor:"pointer"}}>+ Add Dealer</button>
      </div>

      {dealersLoading ? (
        <div style={{color:C.inkFaint,fontSize:14.5}}>Loading…</div>
      ) : dealers.length===0 ? (
        <AdminEmpty icon="🏢">No dealers yet — add your first one</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden",marginBottom:28}}>
          {dealers.map(d=>(
            <div key={d.id} style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontWeight:800,color:C.ink,fontSize:14}}>{d.name}</div>
                <div style={{fontSize:13.5,color:C.inkFaint,marginTop:2}}>{d.contact||""} {d.city?`· ${d.city}, ${d.province||""}`:""}</div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>{d.makes||"—"}</div>
                {d.amvic_number&&(
                  <div style={{fontSize:13,marginTop:4,fontWeight:800,color:d.amvic_verified?C.tealInk:C.butterInk}}>
                    {d.amvic_verified?"✓":"⚠"} AMVIC {d.amvic_number}{!d.amvic_verified&&" -- unverified"}
                  </div>
                )}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.inkSoft,cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.live} onChange={e=>onToggle(d.id,"live",e.target.checked)}/> Live lot
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.inkSoft,cursor:"pointer"}}>
                  <input type="checkbox" checked={!!d.featured} onChange={e=>onToggle(d.id,"featured",e.target.checked)}/> Featured ($300/mo)
                </label>
                {d.sold_count>0 && <span style={{background:C.tealBg,color:C.tealInk,border:`1px solid ${C.teal}55`,borderRadius:6,padding:"3px 8px",fontSize:13,fontWeight:800}}>{d.sold_count} sold</span>}
                <button onClick={()=>onEdit(d)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:13,cursor:"pointer"}}>Edit</button>
                <button onClick={()=>onDelete(d.id,d.name)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:13,cursor:"pointer"}}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        DEALER SUBMITTED INVENTORY · {dealerListingsLoading?"loading…":`${dealerListings.length} vehicle${dealerListings.length===1?"":"s"}`}
      </div>
      {dealerListingsLoading ? (
        <div style={{color:C.inkFaint,fontSize:14.5}}>Loading…</div>
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
                  <div style={{fontSize:13.5,color:C.inkFaint,marginTop:2}}>{v.dealer} · ${(v.price||0).toLocaleString()} · {v.plan==="commission"?"1% commission":"$100/lead"}</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{
                    background: isSold?C.paper2:isLive?C.tealBg:C.paper2,
                    color: isSold?C.ink:isLive?C.tealInk:C.inkFaint,
                    border: `1px solid ${isSold?C.line:isLive?C.teal+"55":C.line}`,
                    borderRadius:6,padding:"3px 8px",fontSize:13,fontWeight:800,
                  }}>{isSold?"✓ Sold":isLive?"● Live":"Pending"}</span>
                  {!isSold && <button onClick={()=>onMarkSold(v)} style={{background:"none",border:`1px solid ${C.teal}`,borderRadius:6,padding:"5px 10px",color:C.tealInk,fontSize:13,cursor:"pointer"}}>✓ Mark Sold (${commission.toLocaleString()})</button>}
                  {!isLive && !isSold && <button onClick={()=>onPublish(v.id)} style={{background:"none",border:`1px solid ${C.line}`,borderRadius:6,padding:"5px 10px",color:C.inkSoft,fontSize:13,cursor:"pointer"}}>Publish</button>}
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
      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        PENDING REVIEW · {reviewLoading?"loading…":`${reviewListings.length} listing${reviewListings.length===1?"":"s"}`}
      </div>
      {reviewLoading ? (
        <div style={{color:C.inkFaint,fontSize:14.5}}>Loading…</div>
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
                  <div style={{fontSize:13.5,color:C.inkFaint,marginTop:2}}>{l.city}, {l.province} · ${(l.price||0).toLocaleString()} · <span style={{color:scoreColor,fontWeight:800}}>{score}</span></div>
                  {flags.map((f,i)=>(<div key={i} style={{fontSize:13,color:C.butterInk,marginTop:2}}>⚠ {f}</div>))}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>onApprove(l.external_id,l.name)} style={{background:"none",border:`1px solid ${C.teal}`,borderRadius:6,padding:"6px 12px",color:C.tealInk,fontSize:13.5,cursor:"pointer"}}>✓ Approve</button>
                  <button onClick={()=>onReject(l.external_id)} style={{background:"none",border:`1px solid ${C.coral}`,borderRadius:6,padding:"6px 12px",color:C.coralInk,fontSize:13.5,cursor:"pointer"}}>✗ Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
        RECENTLY REJECTED · {rejectedListings.length}
      </div>
      {rejectedListings.length===0 ? (
        <AdminEmpty>No rejected listings yet</AdminEmpty>
      ) : (
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden"}}>
          {rejectedListings.map((l,i)=>(
            <div key={i} style={{padding:"12px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",fontSize:14.5}}>
              <span style={{color:C.ink}}>{l.name}</span>
              <span style={{color:C.coralInk,fontWeight:800}}>{l.verification_score||0}</span>
              <span style={{color:C.inkFaint,fontSize:13}}>{(l.verification_flags||"").split(" | ")[0]||"—"}</span>
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
        <div style={{fontSize:13.5,color:C.inkFaint,marginTop:2}}>≈ ${(usd*USD_TO_CAD).toFixed(4)} CAD</div>
      </>
    );
  }

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:24}}>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:C.tealInk}}>${featuredRev.toLocaleString()}</div>
          <div style={{fontSize:13.5,color:C.inkFaint}}>Featured listings/mo — real</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
          <div style={{fontSize:26,fontWeight:800,color:C.inkFaint}}>$0</div>
          <div style={{fontSize:13.5,color:C.inkFaint}}>Lead referral fees</div>
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
            <div key={d.id} style={{padding:"12px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",justifyContent:"space-between",fontSize:14.5}}>
              <span style={{color:C.ink}}>{d.name}</span>
              <span style={{color:C.tealInk,fontWeight:800}}>$300/mo</span>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:2}}>
        QUOTE CHECK COST · {apiUsageLoading?"loading…":`${apiUsage.length} logged call${apiUsage.length===1?"":"s"}`}
      </div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:10}}>USD is what you're actually billed — CAD is an estimate at a fixed 1 USD = {USD_TO_CAD} CAD rate (July 15, 2026), not a live conversion.</div>
      {!apiUsageLoading&&apiUsage.length===0?(
        <AdminEmpty icon="📊">
          No usage logged yet — this fills in the moment someone runs a real quote through Quote Check, once the analyze-quote function's logging is live.
        </AdminEmpty>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
            {[["Today",costToday],["Last 7 days",costWeek],["Last 30 days",costMonth]].map(([label,stats])=>(
              <div key={label} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
                <div style={{fontSize:13.5,color:C.inkFaint,marginBottom:6}}>{label}</div>
                <CostFigure usd={stats.cost}/>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:6}}>{stats.requests} request{stats.requests===1?"":"s"}{stats.successRate!=null?` · ${stats.successRate}% succeeded`:""}</div>
              </div>
            ))}
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft}}>Cost over time</div>
              <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                {[["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                  <button key={key} onClick={()=>setCostGranularity(key)}
                    style={{background:costGranularity===key?C.tealBg:"transparent",color:costGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:13.5,fontWeight:700,cursor:"pointer"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{height:180}}>
              <ResponsiveContainer>
                <BarChart data={bucketedCost} margin={{top:4,right:4,bottom:0,left:0}}>
                  <XAxis dataKey="label" tick={{fontSize:12,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                  <YAxis tick={{fontSize:13,fill:C.inkFaint}} tickLine={false} axisLine={false} width={50} tickFormatter={v=>`$${v.toFixed(2)}`}/>
                  <Tooltip formatter={(v)=>[`$${Number(v).toFixed(4)} USD · $${(Number(v)*USD_TO_CAD).toFixed(4)} CAD`,"Cost"]} contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:13.5,fontWeight:700,color:"#fff"}} labelStyle={{color:"#D9DBEF",fontSize:13}}/>
                  <Bar dataKey="cost" radius={[3,3,0,0]} fill={C.teal}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:12}}>
            <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft,marginBottom:10}}>Cost vs. subscription — estimate</div>
            <div style={{fontSize:13,color:C.inkFaint,marginBottom:12,lineHeight:1.5}}>
              There's no real subscriber billing yet — type in a subscriber count to see an estimated margin. This is a manual stand-in, not live billing data.
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <label style={{fontSize:13.5,color:C.inkSoft,whiteSpace:"nowrap"}}>Subscribers at $9.99/mo:</label>
              <input type="number" min="0" value={subscribers} onChange={e=>updateSubscribers(e.target.value)}
                style={{width:90,background:C.paper,border:`2px solid ${C.line}`,borderRadius:8,padding:"6px 10px",color:C.ink,fontSize:14.5,outline:"none"}}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
              <div>
                <div style={{fontSize:18,fontWeight:800,color:C.ink}}>${assumedRevenue.toFixed(2)} <span style={{fontSize:13,fontWeight:700,color:C.inkFaint}}>USD</span></div>
                <div style={{fontSize:13,color:C.inkFaint}}>≈ ${(assumedRevenue*USD_TO_CAD).toFixed(2)} CAD</div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:4}}>Assumed monthly revenue</div>
              </div>
              <div>
                <CostFigure usd={costMonth.cost} size={18}/>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:4}}>Actual cost, last 30 days</div>
              </div>
              <div>
                <CostFigure usd={Math.abs(margin)} size={18} color={margin>=0?C.tealInk:C.coralInk}/>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:4}}>Estimated margin{margin<0?" (loss)":""}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Quote Check pricing tiers -- kept for cost/revenue modeling in this tab
// only. These figures are hypothetical -- "what this would earn if pricing
// were live" -- not real revenue right now.
const QC_PRICING_TIERS = [
  {key:"single", name:"1 check", price:4.99, quotesPerUnit:1},
  {key:"three", name:"3 checks", price:9.99, quotesPerUnit:3},
  {key:"five", name:"5 checks", price:12.99, quotesPerUnit:5},
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

  const th={textAlign:"right",fontSize:12,color:C.inkFaint,fontWeight:800,padding:"8px 10px",borderBottom:`1px solid ${C.line}`,letterSpacing:0.4};
  const td={textAlign:"right",padding:"12px 10px",borderBottom:`1px solid ${C.line}`};

  return (
    <div>
      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>QUOTE CHECK PROFIT</div>
      <div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:10,padding:"10px 14px",fontSize:13.5,color:C.coralInk,fontWeight:700,marginBottom:16,lineHeight:1.5}}>
        ⚠ "Checks sold" below are sample placeholders, not real data -- there's no purchase-logging table yet, so nothing tracks actual sales per tier today. The pricing and profit math itself is real and will be correct the moment real counts flow in.
      </div>

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft}}>Checks sold & profit</div>
          <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
            {[["day","Day"],["week","Week"],["month","Month"],["year","Year"]].map(([key,label])=>(
              <button key={key} onClick={()=>setPeriod(key)}
                style={{background:period===key?C.tealBg:"transparent",color:period===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:13.5,fontWeight:700,cursor:"pointer"}}>
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
                  <div style={{fontSize:14.5,fontWeight:800,color:C.ink}}>{r.name}</div>
                  <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>${r.price.toFixed(2)} each</div>
                </td>
                <td style={{...td,fontFamily:"monospace",fontSize:14,fontWeight:700,color:C.ink}}>{r.count.toLocaleString()}</td>
                <td style={td}>
                  <div style={{fontFamily:"monospace",fontSize:14.5,fontWeight:700,color:C.ink}}>${fmt(r.revenueUsd)}</div>
                  <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>${fmt(r.revenueCad)} CAD</div>
                </td>
                <td style={td}>
                  <div style={{fontFamily:"monospace",fontSize:14.5,fontWeight:800,color:C.tealInk}}>${fmt(r.profitUsd)}</div>
                  <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>${fmt(r.profitCad)} CAD</div>
                </td>
              </tr>
            ))}
            <tr style={{background:C.paper2}}>
              <td style={{padding:"12px 10px",fontWeight:800,color:C.butterInk,fontSize:14.5}}>Total</td>
              <td style={{textAlign:"right",padding:"12px 10px",fontFamily:"monospace",fontSize:14,fontWeight:800,color:C.ink}}>{totalCount.toLocaleString()}</td>
              <td style={{textAlign:"right",padding:"12px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:14.5,fontWeight:800,color:C.ink}}>${fmt(totalRevUsd)}</div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>${fmt(totalRevCad)} CAD</div>
              </td>
              <td style={{textAlign:"right",padding:"12px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:14.5,fontWeight:800,color:C.tealInk}}>${fmt(totalProfitUsd)}</div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>${fmt(totalProfitCad)} CAD</div>
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{fontSize:13,color:C.inkFaint,marginTop:12,lineHeight:1.6}}>
          Profit basis: ${QC_COST_PER_QUOTE} USD cost per quote check (current intro API pricing) × checks actually delivered per tier -- e.g. a "5 checks" bundle costs 5× that per unit sold. CAD figures use the same fixed {USD_TO_CAD} snapshot rate already used above in Cost over time, not a live rate.
        </div>
      </div>
    </div>
  );
}

// ── Unit Economics tab ────────────────────────────────────────────────────
// Free / shared / paid checks and their modeled API cost, driven by an
// adjustable cost-per-check, plus a live-editable free-check daily cap.
// ALL numbers here come from the admin-gated fn_admin_economics RPC
// (aggregate-only, no PII) except the "logged" API spend, which reuses the
// same real api_usage_log the Revenue tab already reads. Real vs estimated is
// labelled explicitly — revenue is ESTIMATED (Stripe isn't wired yet).
const ECON_WINDOWS = [["today","Today"],["7d","Last 7 days"],["30d","Last 30 days"]];
// Pack prices are treated as USD, matching the existing Profit tab convention
// (tier.price * count = USD, then × USD_TO_CAD for the CAD estimate).
const PRICE_BY_CREDITS = {1:4.99, 3:9.99, 5:12.99};

function estRevenueUsd(purchasesByDelta){
  if(!purchasesByDelta) return 0;
  let sum=0;
  for(const [delta,n] of Object.entries(purchasesByDelta)){
    const d=Number(delta);
    // Known tier price if the credit grant matches a pack; otherwise fall back
    // to a per-credit proxy ($12.99 / 5 credits, the current best-value unit
    // rate) so an unexpected grant size still contributes a sensible (clearly
    // estimated) figure rather than $0.
    const price = PRICE_BY_CREDITS[d] ?? d*(12.99/5);
    sum += price*Number(n||0);
  }
  return sum;
}

function UnitEconomicsTab({econ, econLoading, econError, apiUsage, apiUsageLoading, onSetCap, onRefresh}){
  const {C}=useAdminTheme();

  const [costPerCheck,setCostPerCheck]=useState(()=>{
    try{ const v=Number(localStorage.getItem("lc_admin_cost_per_check")); return v>0?v:0.10; }catch{ return 0.10; }
  });
  function updateCpc(v){
    const n=Math.max(0,Number(v)||0);
    setCostPerCheck(n);
    try{ localStorage.setItem("lc_admin_cost_per_check",String(n)); }catch{}
  }

  const status=econ?.free_check_status||null;
  const [capInput,setCapInput]=useState("");
  const [savingCap,setSavingCap]=useState(false);
  useEffect(()=>{ if(status&&status.limit_per_day!=null) setCapInput(String(status.limit_per_day)); },[status?.limit_per_day]);

  async function saveCap(){
    setSavingCap(true);
    await onSetCap(capInput);
    setSavingCap(false);
  }

  // Real logged API spend (USD), windowed the same calendar-day way the RPC
  // windows the counts, so "logged vs modeled" is an apples-to-apples compare.
  const now=Date.now();
  const startOfToday=new Date(); startOfToday.setHours(0,0,0,0);
  const loggedCost=(win)=>{
    let since;
    if(win==="today") since=startOfToday.getTime();
    else if(win==="7d") since=startOfToday.getTime()-6*86400000;
    else since=startOfToday.getTime()-29*86400000;
    return (apiUsage||[]).filter(u=>new Date(u.created_at).getTime()>=since)
      .reduce((s,u)=>s+(Number(u.cost_usd)||0),0);
  };

  const fmtUsd=(n)=>`$${(Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const cad=(usd)=>`$${((Number(usd)||0)*USD_TO_CAD).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})} CAD`;

  // Per-window derived economics.
  function derive(win){
    const w=econ?.windows?.[win]||{};
    const free=Number(w.free_checks||0);
    const shared=Number(w.gift_received_n||0);   // shared checks actually redeemed
    const paid=Number(w.quote_check_n||0);       // signed-in credit spends
    const totalChecks=free+shared+paid;
    const freeCost=free*costPerCheck;
    const sharedCost=shared*costPerCheck;
    const paidCost=paid*costPerCheck;
    const modeledSpend=totalChecks*costPerCheck;
    const revenue=estRevenueUsd(w.purchases_by_delta);
    const grossMargin=revenue-paidCost;              // paid checks vs their own cost
    const netAfterSubsidy=revenue-modeledSpend;      // revenue minus ALL check cost (incl. free/shared subsidy)
    return {
      free, shared, paid, totalChecks,
      freeCost, sharedCost, paidCost, modeledSpend,
      revenue, grossMargin, netAfterSubsidy,
      giftSent:Number(w.gift_sent_n||0),
      purchaseN:Number(w.purchase_n||0),
      logged:loggedCost(win),
    };
  }
  const cols=ECON_WINDOWS.map(([win,label])=>({win,label,d:derive(win)}));

  const cardStyle={background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"};
  const th={textAlign:"right",fontSize:12,color:C.inkFaint,fontWeight:800,padding:"9px 12px",borderBottom:`1px solid ${C.line}`,letterSpacing:0.4,whiteSpace:"nowrap"};
  const td={textAlign:"right",padding:"12px",borderBottom:`1px solid ${C.line}`,fontFamily:"monospace",fontSize:14.5};
  const RealTag=()=><span style={{fontSize:11,fontWeight:800,color:C.tealInk,background:C.tealBg,borderRadius:4,padding:"1px 5px",marginLeft:6,letterSpacing:0.3,fontFamily:"'Nunito',sans-serif"}}>REAL</span>;
  const EstTag=()=><span style={{fontSize:11,fontWeight:800,color:C.butterInk,background:C.butter+"55",borderRadius:4,padding:"1px 5px",marginLeft:6,letterSpacing:0.3,fontFamily:"'Nunito',sans-serif"}}>EST.</span>;

  if(econLoading){
    return <AdminEmpty>Loading unit economics…</AdminEmpty>;
  }
  if(econError||!econ){
    return (
      <div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:12,padding:"16px 18px",fontSize:14.5,color:C.coralInk,lineHeight:1.6}}>
        <div style={{fontWeight:800,marginBottom:6}}>Couldn't load unit economics.</div>
        <div>{econError||"No data returned."}</div>
        <div style={{marginTop:8,color:C.inkFaint}}>
          This RPC is admin-gated. Confirm <code style={{background:C.paper2,padding:"1px 5px",borderRadius:4}}>20260730_admin_economics.sql</code> is applied and your login email is listed in <code style={{background:C.paper2,padding:"1px 5px",borderRadius:4}}>admin_config.admin_emails</code>.
        </div>
        <button onClick={onRefresh} style={{marginTop:12,background:C.teal,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:13.5,fontWeight:800,cursor:"pointer"}}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:6}}>
        <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>UNIT ECONOMICS</div>
        <button onClick={onRefresh} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",color:C.inkSoft,fontSize:13.5,fontWeight:700,cursor:"pointer"}}>Refresh</button>
      </div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:16,lineHeight:1.6,maxWidth:760}}>
        Calendar-day windows (DB timezone). Check counts and purchases are <b style={{color:C.tealInk}}>real</b> (from the credit ledger + free-check tally); modeled $ figures multiply those counts by the cost-per-check below. Revenue is <b style={{color:C.butterInk}}>estimated</b> from purchase grants — there's no Stripe billing yet. Pack prices are treated as USD (matching the Profit tab); CAD shown at the fixed {USD_TO_CAD} snapshot rate.
      </div>

      {/* Controls: cost-per-check */}
      <div style={{...cardStyle,marginBottom:14,display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13.5,fontWeight:800,color:C.inkSoft,marginBottom:6}}>Cost per check <span style={{color:C.inkFaint,fontWeight:600}}>(USD — drives every modeled $ figure)</span></div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:18,fontWeight:800,color:C.inkFaint}}>$</span>
            <input type="number" min="0" step="0.01" value={costPerCheck}
              onChange={e=>updateCpc(e.target.value)}
              style={{width:120,background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"10px 12px",color:C.ink,fontSize:16,fontWeight:700,outline:"none"}}/>
            <span style={{fontSize:13.5,color:C.inkFaint}}>≈ {cad(costPerCheck)} each</span>
          </div>
        </div>
        <div style={{fontSize:13,color:C.inkFaint,maxWidth:340,lineHeight:1.5}}>
          A modeling assumption you set, saved on this device. Use it to fill the gap where real API cost isn't logged (the PDF path doesn't write to <code style={{background:C.paper2,padding:"1px 4px",borderRadius:4}}>api_usage_log</code>).
        </div>
      </div>

      {/* Free-check breaker status + editable cap */}
      <div style={{...cardStyle,marginBottom:20}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginBottom:12}}>
          <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft}}>Free-check breaker <RealTag/></div>
          <div style={{fontSize:13.5,color:C.inkFaint}}>anonymous free checks used today</div>
        </div>
        {(()=>{
          const used=Number(status?.used||0);
          const lim=Number(status?.limit_per_day||0);
          const pct=lim>0?Math.min(100,Math.round((used/lim)*100)):0;
          const atCap=lim>0&&used>=lim;
          return (
            <>
              <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:8}}>
                <span style={{fontSize:30,fontWeight:800,color:atCap?C.coralInk:C.ink,fontFamily:"monospace"}}>{used.toLocaleString()}</span>
                <span style={{fontSize:16,color:C.inkFaint}}>/ {lim<=0?"disabled":lim.toLocaleString()}</span>
                {atCap&&<span style={{fontSize:13,fontWeight:800,color:C.coralInk,background:C.coralBg,borderRadius:5,padding:"2px 7px"}}>AT CAPACITY</span>}
              </div>
              <div style={{background:C.paper2,borderRadius:5,height:8,overflow:"hidden",marginBottom:16}}>
                <div style={{width:`${pct}%`,height:"100%",background:atCap?C.coral:C.teal}}/>
              </div>
              <div style={{display:"flex",alignItems:"flex-end",gap:10,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:0.4,marginBottom:5}}>Daily free-check cap</div>
                  <input type="number" min="0" step="1" value={capInput}
                    onChange={e=>setCapInput(e.target.value)}
                    style={{width:140,background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"10px 12px",color:C.ink,fontSize:15,fontWeight:700,outline:"none"}}/>
                </div>
                <button onClick={saveCap} disabled={savingCap||capInput===String(lim)}
                  style={{background:(savingCap||capInput===String(lim))?C.inkFaint:C.teal,border:"none",borderRadius:10,padding:"11px 18px",color:"#fff",fontSize:14.5,fontWeight:800,cursor:(savingCap||capInput===String(lim))?"default":"pointer"}}>
                  {savingCap?"Saving…":"Save cap"}
                </button>
                <div style={{fontSize:13,color:C.inkFaint,maxWidth:300,lineHeight:1.5}}>
                  Live-writes <code style={{background:C.paper2,padding:"1px 4px",borderRadius:4}}>app_config.free_checks_per_day</code>. 0 disables anonymous free checks entirely.
                </div>
              </div>
            </>
          );
        })()}
      </div>

      {/* Checks matrix */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflowX:"auto",marginBottom:20}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
          <thead>
            <tr>
              <th style={{...th,textAlign:"left"}}>METRIC</th>
              {cols.map(c=><th key={c.win} style={th}>{c.label.toUpperCase()}</th>)}
            </tr>
          </thead>
          <tbody>
            {[
              {label:"Free checks", sub:"anonymous · free", tag:"real", count:c=>c.free, cost:c=>c.freeCost},
              {label:"Shared checks", sub:"gift redeemed · free", tag:"real", count:c=>c.shared, cost:c=>c.sharedCost},
              {label:"Paid checks", sub:"signed-in credit spends", tag:"real", count:c=>c.paid, cost:c=>c.paidCost},
            ].map(row=>(
              <tr key={row.label}>
                <td style={{padding:"12px",borderBottom:`1px solid ${C.line}`}}>
                  <div style={{fontSize:14.5,fontWeight:800,color:C.ink,fontFamily:"'Nunito',sans-serif"}}>{row.label}{row.tag==="real"?<RealTag/>:<EstTag/>}</div>
                  <div style={{fontSize:13,color:C.inkFaint,marginTop:2,fontFamily:"'Nunito',sans-serif"}}>{row.sub}</div>
                </td>
                {cols.map(c=>(
                  <td key={c.win} style={{...td,color:C.ink}}>
                    <div style={{fontWeight:800,fontSize:15}}>{row.count(c.d).toLocaleString()}</div>
                    <div style={{fontSize:13,color:C.inkFaint,marginTop:3}}>{fmtUsd(row.cost(c.d))} <span style={{opacity:0.7}}>modeled</span></div>
                  </td>
                ))}
              </tr>
            ))}
            {/* Estimated revenue */}
            <tr style={{background:C.paper2}}>
              <td style={{padding:"12px",borderBottom:`1px solid ${C.line}`}}>
                <div style={{fontSize:14.5,fontWeight:800,color:C.ink,fontFamily:"'Nunito',sans-serif"}}>Est. revenue<EstTag/></div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2,fontFamily:"'Nunito',sans-serif"}}>from purchase grants</div>
              </td>
              {cols.map(c=>(
                <td key={c.win} style={{...td}}>
                  <div style={{fontWeight:800,fontSize:15,color:C.ink}}>{fmtUsd(c.d.revenue)}</div>
                  <div style={{fontSize:13,color:C.inkFaint,marginTop:3}}>{c.d.purchaseN} purchase{c.d.purchaseN===1?"":"s"} · {cad(c.d.revenue)}</div>
                </td>
              ))}
            </tr>
            {/* Gross margin on paid */}
            <tr>
              <td style={{padding:"12px",borderBottom:`1px solid ${C.line}`}}>
                <div style={{fontSize:14.5,fontWeight:800,color:C.ink,fontFamily:"'Nunito',sans-serif"}}>Est. gross margin<EstTag/></div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2,fontFamily:"'Nunito',sans-serif"}}>revenue − paid-check cost</div>
              </td>
              {cols.map(c=>(
                <td key={c.win} style={{...td}}>
                  <div style={{fontWeight:800,fontSize:15,color:c.d.grossMargin>=0?C.tealInk:C.coralInk}}>{fmtUsd(c.d.grossMargin)}</div>
                </td>
              ))}
            </tr>
            {/* Net after free/shared subsidy */}
            <tr>
              <td style={{padding:"12px"}}>
                <div style={{fontSize:14.5,fontWeight:800,color:C.ink,fontFamily:"'Nunito',sans-serif"}}>Est. net after subsidy<EstTag/></div>
                <div style={{fontSize:13,color:C.inkFaint,marginTop:2,fontFamily:"'Nunito',sans-serif"}}>revenue − ALL check cost</div>
              </td>
              {cols.map(c=>(
                <td key={c.win} style={{...td,borderBottom:"none"}}>
                  <div style={{fontWeight:800,fontSize:15,color:c.d.netAfterSubsidy>=0?C.tealInk:C.coralInk}}>{fmtUsd(c.d.netAfterSubsidy)}</div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* API spend: logged (real, partial) vs modeled */}
      <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:8}}>API SPEND · LOGGED vs MODELED</div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:12,lineHeight:1.6,maxWidth:760}}>
        <b style={{color:C.tealInk}}>Logged</b> is the real cost written to <code style={{background:C.paper2,padding:"1px 4px",borderRadius:4}}>api_usage_log</code> — but only the URL analyze function logs it; the <b>PDF path doesn't</b>, so this <b>undercounts</b>. <b style={{color:C.butterInk}}>Modeled</b> = every check (free + shared + paid) × cost-per-check, a fuller estimate.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:10}}>
        {cols.map(c=>(
          <div key={c.win} style={cardStyle}>
            <div style={{fontSize:13.5,color:C.inkFaint,marginBottom:8}}>{c.label}</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
              <span style={{fontSize:13,fontWeight:800,color:C.tealInk}}>LOGGED{apiUsageLoading?"…":""}</span>
              <span style={{fontFamily:"monospace",fontSize:15,fontWeight:800,color:C.ink}}>{fmtUsd(c.d.logged)}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
              <span style={{fontSize:13,fontWeight:800,color:C.butterInk}}>MODELED</span>
              <span style={{fontFamily:"monospace",fontSize:15,fontWeight:800,color:C.ink}}>{fmtUsd(c.d.modeledSpend)}</span>
            </div>
            <div style={{fontSize:13,color:C.inkFaint,borderTop:`1px solid ${C.line}`,paddingTop:8}}>
              {c.d.totalChecks.toLocaleString()} check{c.d.totalChecks===1?"":"s"} total ({c.d.free}f · {c.d.shared}s · {c.d.paid}p)
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DealerModal({dealer,onSave,onClose}){
  const [form,setForm]=useState(dealer||{name:"",contact:"",phone:"",email:"",city:"",province:"AB",makes:"",notes:"",live:false,featured:false,amvic_number:"",amvic_verified:false,amvic_verified_at:null});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const {C}=useAdminTheme();
  const inputStyle={width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"11px 13px",color:C.ink,fontSize:14.5,marginBottom:10,outline:"none",boxSizing:"border-box"};
  const labelStyle={fontSize:13,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:0.4,marginBottom:5,display:"block"};

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
            <div style={{fontSize:13,color:C.coralInk,marginBottom:8,lineHeight:1.4}}>
              Doesn't match the usual AMVIC format (a "B" followed by 7 digits) -- that's only based on 2 confirmed real examples though, so this isn't a hard block. Worth a second look before saving.
            </div>
          )}
          <div style={{fontSize:13,color:C.inkFaint,marginBottom:10,lineHeight:1.5}}>
            AMVIC has no public API to auto-verify this against -- a correctly formatted number isn't proof of an active licence. Check it yourself:
          </div>
          <a href="https://amvic.ca.thentiacloud.net/webs/amvic/register/" target="_blank" rel="noreferrer"
            style={{fontSize:13.5,fontWeight:800,color:C.tealInk,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:5,marginBottom:12}}>
            Verify on AMVIC's public search →
          </a>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:14.5,color:C.inkSoft,cursor:"pointer"}}>
            <input type="checkbox" checked={!!form.amvic_verified} onChange={e=>set("amvic_verified",e.target.checked)}/>
            I checked AMVIC's public search and confirmed this licence is active
          </label>
          {form.amvic_verified&&form.amvic_verified_at&&(
            <div style={{fontSize:13,color:C.tealInk,marginTop:6}}>
              ✓ Verified {new Date(form.amvic_verified_at).toLocaleDateString("en-CA")}
            </div>
          )}
        </div>

        <label style={labelStyle}>Notes</label>
        <input style={inputStyle} value={form.notes} onChange={e=>set("notes",e.target.value)} placeholder="Met at Costco"/>
        <div style={{display:"flex",gap:16,marginBottom:16,marginTop:6}}>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:14.5,color:C.inkSoft,cursor:"pointer"}}>
            <input type="checkbox" checked={form.live} onChange={e=>set("live",e.target.checked)}/> Live lot
          </label>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:14.5,color:C.inkSoft,cursor:"pointer"}}>
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
        <div style={{fontSize:13.5}}>Geolocation just went live — every visit before this update was recorded without it. This fills in from here forward.</div>
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
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.inkFaint,marginTop:8,maxWidth:640,margin:"8px auto 0"}}>
        <span>{located.length.toLocaleString()} of {pageViews.length.toLocaleString()} visits located</span>
        <span>Dot size = relative visit volume</span>
      </div>
      <div style={{marginTop:16,maxWidth:640,margin:"16px auto 0"}}>
        <div style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,marginBottom:8}}>Top locations</div>
        {locations.slice(0,8).map((loc,i)=>{
          const pct=Math.round((loc.count/located.length)*100);
          return(
            <div key={i} style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13.5,marginBottom:2}}>
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

// ── Give a check tab ──────────────────────────────────────────────────────
// Owner tool: mint single-use, tap-to-redeem free-check links to hand a
// friend/family (…/quote-check?gift=CODE). Daily-capped (admin_daily_share_cap,
// default 10, editable here). All server-authoritative via admin-gated RPCs
// (fn_admin_create_gift / _list_gifts / _revoke_gift / _set_share_cap) from
// 20260731_admin_share_gifts.sql. No PII shown — status + timestamps only.
function GiveCheckTab(){
  const {C}=useAdminTheme();
  const [data,setData]=useState(null);   // {cap, used_today, remaining_today, codes:[]}
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState(null);
  const [minting,setMinting]=useState(false);
  const [copied,setCopied]=useState(null); // code just copied
  const [capInput,setCapInput]=useState("");
  const [savingCap,setSavingCap]=useState(false);
  const [grantEmail,setGrantEmail]=useState("");
  const [grantCount,setGrantCount]=useState("10");
  const [granting,setGranting]=useState(false);
  const [grantMsg,setGrantMsg]=useState(null); // {ok:boolean, text}
  async function grantCredits(){
    const email=(grantEmail||"").trim(), n=Math.round(Number(grantCount)||0);
    if(!email||n<1){ setGrantMsg({ok:false,text:"Enter an email and a number of checks."}); return; }
    setGranting(true); setGrantMsg(null);
    try{
      const {data:d,error}=await supabase.rpc("fn_admin_grant_credits",{p_email:email,p_count:n});
      if(error) throw error;
      const c=d?.credits||n;
      const where=d?.target==="account"?`added to ${email}${d.balance!=null?` (balance now ${d.balance})`:""}`:`held for ${email} — lands the moment they sign in`;
      setGrantMsg({ok:true,text:`${c} free check${c===1?"":"s"} ${where}.`});
      setGrantEmail("");
    }catch(e){ setGrantMsg({ok:false,text:e.message||"Couldn't grant those checks."}); }
    finally{ setGranting(false); }
  }

  const origin = (typeof window!=="undefined" && window.location?.origin) || "https://lotcheck.ca";
  const linkFor = (code)=>`${origin}/quote-check?gift=${code}`;

  async function load(){
    setLoading(true); setErr(null);
    try{
      const {data:d,error}=await supabase.rpc("fn_admin_list_gifts",{p_limit:30});
      if(error) throw error;
      setData(d||null);
      if(d&&d.cap!=null) setCapInput(String(d.cap));
    }catch(e){
      console.warn("⚠️ fn_admin_list_gifts failed (run 20260731_admin_share_gifts.sql, and confirm your login is in admin_config.admin_emails):",e.message);
      setErr(e.message||"Couldn't load your gift links."); setData(null);
    }finally{ setLoading(false); }
  }
  useEffect(()=>{ load(); },[]);

  async function mint(){
    setMinting(true); setErr(null);
    try{
      const {data:d,error}=await supabase.rpc("fn_admin_create_gift");
      if(error) throw error;
      await load();
      if(d&&d.code){ // auto-copy the fresh link so it's ready to paste into a text
        try{ await navigator.clipboard.writeText(linkFor(d.code)); setCopied(d.code); setTimeout(()=>setCopied(null),2200); }catch{}
      }
    }catch(e){
      setErr(e.message||"Couldn't create a link.");
    }finally{ setMinting(false); }
  }

  async function copyLink(code){
    try{ await navigator.clipboard.writeText(linkFor(code)); setCopied(code); setTimeout(()=>setCopied(null),2200); }
    catch{ setErr("Couldn't copy — select the link and copy manually."); }
  }

  async function revoke(code){
    setErr(null);
    const {error}=await supabase.rpc("fn_admin_revoke_gift",{p_code:code});
    if(error){ setErr(error.message||"Couldn't cancel that link."); return; }
    load();
  }

  async function saveCap(){
    setSavingCap(true); setErr(null);
    const {error}=await supabase.rpc("fn_admin_set_share_cap",{p_value:Math.round(Number(capInput)||0)});
    if(error){ setErr("Couldn't update the daily cap: "+error.message); setSavingCap(false); return; }
    await load(); setSavingCap(false);
  }

  const card={background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"};
  const remaining=Number(data?.remaining_today||0);
  const cap=Number(data?.cap||0);
  const used=Number(data?.used_today||0);
  const canMint=remaining>0 && !minting;
  const codes=data?.codes||[];
  const statusStyle=(s)=> s==="redeemed"
      ? {color:C.tealInk,bg:C.tealBg,label:"Redeemed"}
    : s==="revoked"
      ? {color:C.inkFaint,bg:C.paper2,label:"Cancelled"}
      : {color:C.butterInk,bg:C.butter+"55",label:"Active"};

  if(loading) return <AdminEmpty>Loading your gift links…</AdminEmpty>;

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:6}}>
        <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>GIVE A FREE CHECK</div>
        <button onClick={load} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",color:C.inkSoft,fontSize:13.5,fontWeight:700,cursor:"pointer"}}>Refresh</button>
      </div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:16,lineHeight:1.6,maxWidth:760}}>
        Mint a single-use link to hand a friend or family a free Quote Check. Text them the link — they tap it, sign in, and the check lands on their account. A leaked or forwarded link can't be reused. Capped per day (editable below).
      </div>

      {err&&(
        <div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:10,padding:"10px 14px",fontSize:13.5,color:C.coralInk,marginBottom:14,lineHeight:1.5}}>{err}</div>
      )}

      {/* Mint control + today's allowance */}
      <div style={{...card,marginBottom:14,display:"flex",alignItems:"center",gap:18,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:0.4,marginBottom:5}}>Left to give today</div>
          <div style={{display:"flex",alignItems:"baseline",gap:8}}>
            <span style={{fontSize:32,fontWeight:900,color:remaining>0?C.ink:C.coralInk,fontFamily:"monospace"}}>{remaining}</span>
            <span style={{fontSize:15,color:C.inkFaint}}>/ {cap}</span>
          </div>
        </div>
        <button onClick={mint} disabled={!canMint}
          style={{background:canMint?C.teal:C.inkFaint,border:"none",borderRadius:12,padding:"13px 22px",color:"#fff",fontSize:14,fontWeight:800,cursor:canMint?"pointer":"default"}}>
          {minting?"Creating…":"Create free-check link"}
        </button>
        {remaining<=0&&<div style={{fontSize:13.5,color:C.coralInk,fontWeight:700}}>Daily limit reached — resets tomorrow, or raise the cap below.</div>}
        {copied&&<div style={{fontSize:13.5,color:C.tealInk,fontWeight:800}}>Link copied — paste it into a text</div>}
      </div>

      {/* Links list */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflow:"hidden",marginBottom:16}}>
        {codes.length===0?(
          <div style={{padding:"22px 18px",fontSize:14.5,color:C.inkFaint,textAlign:"center"}}>No links yet — create one above.</div>
        ):codes.map((c)=>{
          const st=statusStyle(c.status);
          const active=c.status==="active";
          return (
            <div key={c.code} style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",padding:"12px 16px",borderBottom:`1px solid ${C.line}`}}>
              <span style={{fontFamily:"monospace",fontSize:14,fontWeight:800,color:C.ink,letterSpacing:1}}>{c.code}</span>
              <span style={{fontSize:13,fontWeight:800,color:st.color,background:st.bg,borderRadius:5,padding:"2px 8px"}}>{st.label}</span>
              <span style={{flex:"1 1 120px",fontSize:13,color:C.inkFaint,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{linkFor(c.code)}</span>
              {active&&(
                <>
                  <button onClick={()=>copyLink(c.code)} style={{background:copied===c.code?C.tealBg:C.paper2,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",color:copied===c.code?C.tealInk:C.inkSoft,fontSize:13.5,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>{copied===c.code?"Copied":"Copy link"}</button>
                  <button onClick={()=>revoke(c.code)} style={{background:"transparent",border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 10px",color:C.inkFaint,fontSize:13.5,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>Cancel</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Editable daily cap */}
      <div style={{...card,display:"flex",alignItems:"flex-end",gap:10,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:C.inkFaint,textTransform:"uppercase",letterSpacing:0.4,marginBottom:5}}>Free checks I can give per day</div>
          <input type="number" min="0" step="1" value={capInput} onChange={e=>setCapInput(e.target.value)}
            style={{width:140,background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"10px 12px",color:C.ink,fontSize:15,fontWeight:700,outline:"none"}}/>
        </div>
        <button onClick={saveCap} disabled={savingCap||capInput===String(cap)}
          style={{background:(savingCap||capInput===String(cap))?C.inkFaint:C.teal,border:"none",borderRadius:10,padding:"11px 18px",color:"#fff",fontSize:14.5,fontWeight:800,cursor:(savingCap||capInput===String(cap))?"default":"pointer"}}>
          {savingCap?"Saving…":"Save cap"}
        </button>
        <div style={{fontSize:13,color:C.inkFaint,maxWidth:320,lineHeight:1.5}}>
          Live-writes <code style={{background:C.paper2,padding:"1px 4px",borderRadius:4}}>app_config.admin_daily_share_cap</code>. Cancelling an unredeemed link frees its slot back.
        </div>
      </div>

      {/* Grant free checks directly to an email (comp a customer / tester) */}
      <div style={{...card,marginTop:10}}>
        <div style={{fontSize:14,fontWeight:800,color:C.inkSoft,marginBottom:2}}>Grant free checks to an email</div>
        <div style={{fontSize:13,color:C.inkFaint,marginBottom:12,lineHeight:1.5}}>Adds free Quote Checks straight to an account. If they already have one, it's credited now; if not, it waits and lands the moment they sign in with that email.</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input type="email" placeholder="person@email.com" value={grantEmail} onChange={e=>{setGrantEmail(e.target.value);if(grantMsg)setGrantMsg(null);}}
            style={{flex:"1 1 220px",minWidth:180,background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"10px 12px",color:C.ink,fontSize:14,outline:"none"}}/>
          <input type="number" min="1" max="100" step="1" value={grantCount} onChange={e=>setGrantCount(e.target.value)} aria-label="Number of checks"
            style={{width:84,background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"10px 12px",color:C.ink,fontSize:14,fontWeight:700,outline:"none"}}/>
          <button onClick={grantCredits} disabled={granting}
            style={{background:granting?C.inkFaint:C.teal,border:"none",borderRadius:10,padding:"11px 20px",color:"#fff",fontSize:14,fontWeight:800,cursor:granting?"default":"pointer",whiteSpace:"nowrap"}}>
            {granting?"Granting…":"Grant"}
          </button>
        </div>
        {grantMsg&&<div style={{marginTop:10,fontSize:14,fontWeight:700,color:grantMsg.ok?C.tealInk:C.coralInk}}>{grantMsg.text}</div>}
      </div>
    </div>
  );
}

// ── MSRP Alerts tab ───────────────────────────────────────────────────────
// The demand "folders": every waitlist signup grouped by make (with a city
// breakdown), drill-down to the buyer list. This is the Dealer Bridge's
// inventory ([[alerts-are-bridge-inventory]]) — owner-only. Reads the RLS-locked
// msrp_alert_subscription via the admin-gated fn_admin_alert_folders RPC.
// The owner's dispatch console: enter one at/below-MSRP car a dealer is offering,
// see how many CONFIRMED buyers it matches (make + city), and send them the alert.
// fn_admin_push_candidate records the car + returns the match count; the
// alert-dispatch edge fn emails the matched buyers and logs each send (dedupe).
function PushCarPanel({C,onDispatched}){
  const blank={make:"",model:"",year:"",city:"",province:"AB",price:"",below:false,dealer:"",note:""};
  const [f,setF]=useState(blank);
  const [open,setOpen]=useState(false);
  const [cand,setCand]=useState(null);      // {id,matches} after matching
  const [busy,setBusy]=useState("");         // "match" | "send" | ""
  const [msg,setMsg]=useState(null);         // {kind,text}
  const set=(k)=>(e)=>{ setF(s=>({...s,[k]:e.target.type==="checkbox"?e.target.checked:e.target.value})); setCand(null); setMsg(null); };

  async function match(){
    setMsg(null);
    if(!f.make.trim()||!f.city.trim()){ setMsg({kind:"bad",text:"Make and city are required."}); return; }
    setBusy("match");
    const {data,error}=await supabase.rpc("fn_admin_push_candidate",{
      p_make:f.make.trim(), p_model:f.model.trim()||null, p_year:f.year?+f.year:null,
      p_city:f.city.trim(), p_province:f.province.trim()||"AB",
      p_price:f.price?+f.price:null, p_below:f.below, p_dealer:f.dealer.trim()||null, p_note:f.note.trim()||null,
    });
    setBusy("");
    if(error){ setMsg({kind:"bad",text:error.message||"Couldn't record that car."}); return; }
    setCand({id:data.id,matches:data.matches});
  }

  async function send(){
    if(!cand?.id) return;
    setBusy("send"); setMsg(null);
    try{
      const {data,error}=await supabase.functions.invoke("alert-dispatch",{body:{candidate_id:cand.id}});
      if(error||!data?.ok) throw new Error(data?.error||error?.message||"Dispatch failed.");
      setMsg({kind:"ok",text:`Sent ${data.sent} alert${data.sent===1?"":"s"}${data.failed?`, ${data.failed} failed`:""}.`});
      setCand(null); setF(blank); onDispatched&&onDispatched();
    }catch(e){ setMsg({kind:"bad",text:e.message||"Dispatch failed. Is the alert-dispatch function deployed + RESEND_API_KEY set?"}); }
    setBusy("");
  }

  const inp={background:C.paper2,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",color:C.ink,fontSize:14,fontWeight:600,width:"100%",boxSizing:"border-box"};
  const lab={fontSize:12,fontWeight:800,color:C.inkFaint,letterSpacing:.4,display:"block",marginBottom:4,textTransform:"uppercase"};
  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:16,marginBottom:16}}>
      <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
        <div style={{fontSize:14.5,fontWeight:900,color:C.ink}}>📣 Push a car → alert matching buyers</div>
        <span style={{fontSize:13,color:C.inkFaint,marginLeft:"auto"}}>{open?"▲":"▼"}</span>
      </div>
      {!open && <div style={{fontSize:13,color:C.inkFaint,marginTop:6,lineHeight:1.6}}>When a dealer has a unit at or below MSRP, enter it here. LotCheck emails only the buyers who <b style={{color:C.inkSoft}}>confirmed</b> an alert for that make in that city.</div>}
      {open && <>
        <div style={{fontSize:13,color:C.inkFaint,margin:"8px 0 14px",lineHeight:1.6,maxWidth:720}}>
          <b style={{color:C.inkSoft}}>The process:</b> a signup emails the buyer a confirm link → they click it (now “confirmed”). When you enter an at/below-MSRP car below, step 1 shows how many confirmed buyers match; step 2 emails them and logs each send so no one is emailed twice for the same car.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10}}>
          <div><label style={lab}>Make *</label><input style={inp} value={f.make} onChange={set("make")} placeholder="Toyota"/></div>
          <div><label style={lab}>Model</label><input style={inp} value={f.model} onChange={set("model")} placeholder="RAV4"/></div>
          <div><label style={lab}>Year</label><input style={inp} value={f.year} onChange={set("year")} placeholder="2025" inputMode="numeric"/></div>
          <div><label style={lab}>City *</label><input style={inp} value={f.city} onChange={set("city")} placeholder="Calgary"/></div>
          <div><label style={lab}>Province</label><input style={inp} value={f.province} onChange={set("province")} placeholder="AB"/></div>
          <div><label style={lab}>Price (CAD)</label><input style={inp} value={f.price} onChange={set("price")} placeholder="41990" inputMode="numeric"/></div>
          <div><label style={lab}>Dealer</label><input style={inp} value={f.dealer} onChange={set("dealer")} placeholder="ABC Toyota"/></div>
          <div style={{gridColumn:"1/-1"}}><label style={lab}>Note (internal)</label><input style={inp} value={f.note} onChange={set("note")} placeholder="e.g. demo unit, in stock this week"/></div>
        </div>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13.5,color:C.inkSoft,fontWeight:700,margin:"12px 0 4px",cursor:"pointer"}}>
          <input type="checkbox" checked={f.below} onChange={set("below")} style={{accentColor:C.teal}}/> This car is <b>below</b> MSRP (not just at it)
        </label>
        {msg && <div style={{fontSize:13.5,fontWeight:700,margin:"10px 0 2px",color:msg.kind==="ok"?C.tealInk:C.coralInk}}>{msg.text}</div>}
        <div style={{display:"flex",gap:10,alignItems:"center",marginTop:12,flexWrap:"wrap"}}>
          <button onClick={match} disabled={busy==="match"} style={{background:C.card,border:`1px solid ${C.teal}`,borderRadius:9,padding:"9px 16px",color:C.tealInk,fontSize:14,fontWeight:800,cursor:"pointer"}}>{busy==="match"?"Matching…":"1 · Match buyers"}</button>
          {cand && (cand.matches>0
            ? <button onClick={send} disabled={busy==="send"} style={{background:C.teal,border:"none",borderRadius:9,padding:"9px 18px",color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer"}}>{busy==="send"?"Sending…":`2 · Send ${cand.matches} alert${cand.matches===1?"":"s"}`}</button>
            : <span style={{fontSize:13.5,color:C.inkFaint,fontWeight:700}}>No confirmed buyers match this make + city yet.</span>)}
        </div>
      </>}
    </div>
  );
}

function AlertFoldersTab(){
  const {C}=useAdminTheme();
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState(null);
  const [openMake,setOpenMake]=useState(null);

  async function load(){
    setLoading(true); setErr(null);
    try{
      const {data:d,error}=await supabase.rpc("fn_admin_alert_folders",{p_limit:2000});
      if(error) throw error;
      setData(d||null);
    }catch(e){
      console.warn("⚠️ fn_admin_alert_folders failed (run 20260731_admin_alert_folders.sql; confirm your login is in admin_config.admin_emails):",e.message);
      setErr(e.message||"Couldn't load the alert folders."); setData(null);
    }finally{ setLoading(false); }
  }
  useEffect(()=>{ load(); },[]);

  const thLabel=(t,pct)=> t==="at_msrp"?"At MSRP":t==="below_msrp"?"Below MSRP":t==="pct_below"?`${pct||5}%+ under`:t||"—";
  const fmtDate=(s)=>{ try{ return new Date(s).toISOString().slice(0,10); }catch{ return ""; } };

  // Group rows client-side into make folders (+ per-city counts + the list).
  const folders=(()=>{
    const rows=data?.rows||[]; const m=new Map();
    for(const r of rows){
      const mk=r.make||"—";
      if(!m.has(mk)) m.set(mk,{make:mk,list:[],cities:new Map()});
      const f=m.get(mk); f.list.push(r);
      const c=r.city||"—"; f.cities.set(c,(f.cities.get(c)||0)+1);
    }
    return [...m.values()].map(f=>({...f,cities:[...f.cities.entries()].sort((a,b)=>b[1]-a[1])}))
      .sort((a,b)=>b.list.length-a.list.length);
  })();

  function exportCsv(f){
    const rows=[["email","make","model","year","city","province","alert_when","status","signed_up"],
      ...f.list.map(r=>[r.email,r.make,r.model,r.year,r.city,r.province,thLabel(r.threshold,r.pct),r.status,fmtDate(r.created_at)])];
    const csv=rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
    const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    const a=document.createElement("a"); a.href=url; a.download=`msrp-alerts-${f.make.toLowerCase().replace(/[^a-z0-9]+/g,"-")}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  const card={background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"};
  if(loading) return <AdminEmpty>Loading MSRP alert folders…</AdminEmpty>;
  if(err) return (
    <div style={{background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:12,padding:"16px 18px",fontSize:14.5,color:C.coralInk,lineHeight:1.6}}>
      <div style={{fontWeight:800,marginBottom:6}}>Couldn't load the alert folders.</div><div>{err}</div>
      <div style={{marginTop:8,color:C.inkFaint}}>Confirm <code style={{background:C.paper2,padding:"1px 5px",borderRadius:4}}>20260731_admin_alert_folders.sql</code> is applied.</div>
      <button onClick={load} style={{marginTop:12,background:C.teal,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:13.5,fontWeight:800,cursor:"pointer"}}>Retry</button>
    </div>
  );

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:6}}>
        <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>MSRP ALERT FOLDERS</div>
        <button onClick={load} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",color:C.inkSoft,fontSize:13.5,fontWeight:700,cursor:"pointer"}}>Refresh</button>
      </div>
      <div style={{fontSize:13,color:C.inkFaint,marginBottom:16,lineHeight:1.6,maxWidth:760}}>
        Every waitlist signup, filed by make — the Dealer Bridge's demand inventory. <b style={{color:C.inkSoft}}>{data?.total||0}</b> total signup{(data?.total||0)===1?"":"s"}. Owner-only; buyers are never handed to a dealer without a separate, explicit consent.
      </div>

      <PushCarPanel C={C} onDispatched={load}/>

      {folders.length===0?(
        <AdminEmpty icon="📭">No MSRP alert signups yet — they'll appear here filed by make as buyers join the waitlist.</AdminEmpty>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {folders.map(f=>{
            const open=openMake===f.make;
            return (
              <div key={f.make} style={card}>
                <div onClick={()=>setOpenMake(open?null:f.make)} style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer",flexWrap:"wrap"}}>
                  <div style={{fontSize:16,fontWeight:900,color:C.ink,minWidth:120}}>{f.make}</div>
                  <div style={{fontSize:14.5,fontWeight:800,color:C.tealInk,background:C.tealBg,borderRadius:999,padding:"3px 11px"}}>{f.list.length} buyer{f.list.length===1?"":"s"}</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",flex:1}}>
                    {f.cities.slice(0,4).map(([c,n])=><span key={c} style={{fontSize:13,fontWeight:700,color:C.inkSoft,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:6,padding:"2px 8px"}}>{c} · {n}</span>)}
                  </div>
                  <button onClick={(e)=>{e.stopPropagation();exportCsv(f);}} style={{background:"transparent",border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 11px",color:C.inkSoft,fontSize:13.5,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>Export CSV</button>
                  <span style={{fontSize:13,color:C.inkFaint}}>{open?"▲":"▼"}</span>
                </div>
                {open&&(
                  <div style={{marginTop:12,borderTop:`1px solid ${C.line}`,overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",minWidth:560,fontSize:14}}>
                      <thead><tr>{["Email","Model","Year","City","Alert when","Status","Signed up"].map(h=>(
                        <th key={h} style={{textAlign:"left",fontSize:12,color:C.inkFaint,fontWeight:800,padding:"9px 10px",letterSpacing:0.4,whiteSpace:"nowrap",borderBottom:`1px solid ${C.line}`}}>{h.toUpperCase()}</th>))}</tr></thead>
                      <tbody>{f.list.map((r,i)=>(
                        <tr key={i}>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`,color:C.ink,fontWeight:700,fontFamily:"monospace",fontSize:13.5}}>{r.email}</td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`,color:C.ink}}>{r.model||"—"}</td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`,color:C.inkSoft}}>{r.year||"—"}</td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`,color:C.inkSoft}}>{r.city||"—"}{r.province?`, ${r.province}`:""}</td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`}}><span style={{fontSize:13,fontWeight:800,color:C.butterInk,background:C.butter+"44",borderRadius:5,padding:"2px 7px"}}>{thLabel(r.threshold,r.pct)}</span></td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`}}>{r.status==="confirmed"
                            ? <span style={{fontSize:12.5,fontWeight:800,color:C.tealInk,background:C.tealBg,borderRadius:5,padding:"2px 7px"}}>✓ Confirmed</span>
                            : <span style={{fontSize:12.5,fontWeight:800,color:C.inkFaint,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:5,padding:"2px 7px"}}>Waitlist</span>}</td>
                          <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.line}`,color:C.inkFaint,fontFamily:"monospace",fontSize:13}}>{fmtDate(r.created_at)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Verification ledger (admin tab 9) ────────────────────────────────────────
// Every scan, every checkpoint, every send. This is the instrument panel for
// the promise that a report delivers all of its points with backed results.
//
// HONESTY RULE, and it is the whole design of this tab: show real numbers where
// a table exists, and say "not instrumented" where one does not. It must never
// paint a checkpoint green that we are not actually measuring. A fabricated
// pass rate is worse here than a blank, because this is precisely the surface
// you would consult to decide whether the reports are sound — a false all-clear
// on this screen is how a broken reader survives for weeks.
//
//   Real today   api_usage_log (feature, success, created_at) — both paths.
//                verification_check (checkpoint, outcome, detail) — one row per
//                checkpoint per report, written by analyze-quote,
//                analyze-listing-url and get-dealer-sentiment. THE TARGET IS
//                UNDER 1% FAILURE, measured per checkpoint rather than per
//                request, because 12 of 13 delivered is a failure of the 13th.
//   Missing      report_delivery — email send + PDF hash + provider receipt
const VERIF_BUCKETS = [
  { k:"1h",  label:"Last hour",      n:12,
    floor:d=>{const x=new Date(d); x.setSeconds(0,0); x.setMinutes(Math.floor(x.getMinutes()/5)*5); return x;},
    prev:d=>new Date(d.getTime()-5*60e3),
    fmt:d=>`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`,
    fmtShort:d=>`${String(d.getMinutes()).padStart(2,"0")}m` },
  { k:"24h", label:"Last 24 hours",  n:24,
    floor:d=>{const x=new Date(d); x.setMinutes(0,0,0); return x;},
    prev:d=>new Date(d.getTime()-3600e3),
    fmt:d=>`${String(d.getHours()).padStart(2,"0")}:00 → ${String((d.getHours()+1)%24).padStart(2,"0")}:00`,
    fmtShort:d=>`${String(d.getHours()).padStart(2,"0")}:00` },
  { k:"7d",  label:"Last 7 days",    n:7,
    floor:d=>{const x=new Date(d); x.setHours(0,0,0,0); return x;},
    prev:d=>new Date(d.getTime()-864e5),
    fmt:d=>d.toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric"}),
    fmtShort:d=>d.toLocaleDateString("en-CA",{weekday:"short"}) },
  { k:"30d", label:"Last 30 days",   n:30,
    floor:d=>{const x=new Date(d); x.setHours(0,0,0,0); return x;},
    prev:d=>new Date(d.getTime()-864e5),
    fmt:d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"}),
    fmtShort:d=>String(d.getDate()) },
  { k:"1y",  label:"Last 12 months", n:12,
    floor:d=>{const x=new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x;},
    prev:d=>{const x=new Date(d); x.setMonth(x.getMonth()-1); return x;},
    fmt:d=>d.toLocaleDateString("en-CA",{month:"short",year:"numeric"}),
    fmtShort:d=>d.toLocaleDateString("en-CA",{month:"short"}) },
];

// The 13 checkpoints, in report order — deliberately NOT reordered by failure
// rate, because recognising the list is what makes a gap obvious. The worst
// offenders are named in the summary row instead. The second element is the
// verification_check.checkpoint key each row reads.
const VERIF_CHECKPOINTS = [
  ["MSRP","verification_check.msrp"],
  ["Odometer","verification_check.odometer"],
  ["Open recalls","verification_check.recalls"],
  ["Fee audit","verification_check.fees"],
  ["EV rebate","verification_check.ev_rebate"],
  ["VIN pattern","verification_check.vin"],
  ["Warranty validity","verification_check.warranty"],
  ["Financing math","verification_check.financing"],
  ["APR vs official site","verification_check.apr"],
  ["Dealer reputation","verification_check.reputation"],
  ["Leverage score","verification_check.leverage"],
  ["Days on lot","verification_check.days_on_lot"],
  ["AMVIC licence","verification_check.amvic"],
];

// Bucket rows into gap-filled intervals. Empty intervals MUST survive as zero
// rows — a dead hour that vanishes from the list is the one thing you most need
// to see, and dropping it makes the neighbours look adjacent.
// A specific day / month / year picked from the calendar, rather than a rolling
// "last N". Relative windows answer "how are we doing right now"; an anchored
// one answers "what happened on the 11th", which is the question you have when
// something looks wrong in hindsight. Both produce the same interval shape, so
// everything downstream is unchanged.
function buildAnchoredIntervals(anchor, rows){
  const {mode, date} = anchor;
  const edges=[]; let fmt, fmtShort;

  if(mode==="day"){
    for(let h=0;h<24;h++){
      const d=new Date(date); d.setHours(h,0,0,0); edges.push(d);
    }
    fmt=d=>`${String(d.getHours()).padStart(2,"0")}:00 → ${String((d.getHours()+1)%24).padStart(2,"0")}:00`;
    fmtShort=d=>`${String(d.getHours()).padStart(2,"0")}:00`;
  }else if(mode==="month"){
    const days=new Date(date.getFullYear(), date.getMonth()+1, 0).getDate();
    for(let i=1;i<=days;i++){
      const d=new Date(date.getFullYear(), date.getMonth(), i, 0,0,0,0); edges.push(d);
    }
    fmt=d=>d.toLocaleDateString("en-CA",{month:"short",day:"numeric"});
    fmtShort=d=>String(d.getDate());
  }else{ // year
    for(let m=0;m<12;m++) edges.push(new Date(date.getFullYear(), m, 1, 0,0,0,0));
    fmt=d=>d.toLocaleDateString("en-CA",{month:"short",year:"numeric"});
    fmtShort=d=>d.toLocaleDateString("en-CA",{month:"short"});
  }

  const out=edges.map((start,i)=>({
    start, label:fmt(start), shortLabel:fmtShort(start),
    end: i+1<edges.length ? edges[i+1] : (
      mode==="day"   ? new Date(new Date(date).setHours(24,0,0,0))
    : mode==="month" ? new Date(date.getFullYear(), date.getMonth()+1, 1)
    :                  new Date(date.getFullYear()+1, 0, 1)),
    ok:0, fail:0,
  }));
  for(const r of rows||[]){
    const t=new Date(r.created_at).getTime();
    if(isNaN(t)) continue;
    for(let i=out.length-1;i>=0;i--){
      if(t>=out[i].start.getTime() && t<out[i].end.getTime()){
        if(r.success) out[i].ok++; else out[i].fail++;
        break;
      }
    }
  }
  return out;
}

function buildVerifIntervals(bucket, rows){
  const edges=[]; let cur=bucket.floor(new Date());
  for(let i=0;i<bucket.n;i++){ edges.unshift(new Date(cur)); cur=bucket.prev(cur); }
  const out=edges.map((start,i)=>({
    start, label:bucket.fmt(start),
    // Short form for the column chart. "20:00 → 21:00" is right in a ledger
    // row and unreadable under 24 narrow columns, where it collides with its
    // neighbours into "21:0023:00".
    shortLabel:(bucket.fmtShort||bucket.fmt)(start),
    end: i+1<edges.length ? edges[i+1] : new Date(8640000000000000),
    ok:0, fail:0,
  }));
  for(const r of rows||[]){
    const t=new Date(r.created_at).getTime();
    if(isNaN(t) || t<out[0].start.getTime()) continue;
    for(let i=out.length-1;i>=0;i--){
      if(t>=out[i].start.getTime()){ if(r.success) out[i].ok++; else out[i].fail++; break; }
    }
  }
  return out;
}


function VerifLiveDot({C}){
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,fontWeight:800,letterSpacing:1.2,color:C.tealInk,textTransform:"uppercase"}}>
      <style>{`
        @keyframes lcVerifPulse{0%,100%{opacity:1}50%{opacity:.22}}
        .lc-verif-dot{animation:lcVerifPulse 1.6s ease-in-out infinite}
        @media (prefers-reduced-motion:reduce){.lc-verif-dot{animation:none}}
      `}</style>
      <i className="lc-verif-dot" style={{width:6,height:6,borderRadius:"50%",background:C.teal,display:"inline-block"}}/>
      Live
    </span>
  );
}

const vnum = (n) => Number(n || 0).toLocaleString("en-CA");

// Direction 23 — the isometric ledger (Vic's pick from the 35-direction board,
// design-admin-verifications-35.html). Every tracked thing is one row on a
// shared plane; a row LIFTS off that plane as it degrades, so a bad checkpoint
// is visible as height before you read a single number.
//
// `state` drives the whole rendering and there are four, not three:
//   ok          teal, flat to the plane
//   bad         coral, lifted in proportion to how far it has fallen
//   info        neutral teal, low — volume counters that can't be good or bad
//   unmeasured  a HOLLOW outline, never a filled slab. Nothing writes this
//               value yet, and a solid green row for something we do not
//               measure is the false all-clear this panel exists to prevent.
// Direction 1 — the extruded stack. One 3D column per interval: a green base
// block for verified reads, with a red block capping it for failed ones, so the
// failure share is the thing sitting on top rather than a colour buried inside
// a bar.
//
// Oblique projection (a flat depth offset), not isometric. Columns stand side
// by side and never stack, so the vertical-bleed problem that wrecked the iso
// ledger cannot arise here — the only constraint is horizontal, and
// w + dx = 0.84 * pitch guarantees no two columns ever touch, at any interval
// count from 7 to 30.
// Pick a specific day, month or year. Three levels, and each is one click:
// the year strip picks a year, a month chip picks that month, a day cell picks
// that day. Whichever you clicked last is what the chart shows, so "per year"
// is not a separate mode to learn — it is just stopping earlier.
function VerifCalendar({C, anchor, onPick, onClear}){
  const today=new Date();
  const [viewY,setViewY]=useState(()=>(anchor?.date||today).getFullYear());
  const [viewM,setViewM]=useState(()=>(anchor?.date||today).getMonth());
  const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const firstDow=new Date(viewY,viewM,1).getDay();          // 0=Sun
  const days=new Date(viewY,viewM+1,0).getDate();
  const cells=[...Array((firstDow+6)%7).fill(null), ...Array.from({length:days},(_,i)=>i+1)];

  const isSel=(kind,val)=>{
    if(!anchor) return false;
    const a=anchor.date;
    if(kind==="year")  return anchor.mode==="year"  && a.getFullYear()===val;
    if(kind==="month") return anchor.mode==="month" && a.getFullYear()===viewY && a.getMonth()===val;
    return anchor.mode==="day" && a.getFullYear()===viewY && a.getMonth()===viewM && a.getDate()===val;
  };
  const btn=(sel)=>({
    background: sel?C.teal:"transparent", color: sel?"#fff":C.ink,
    border:`1px solid ${sel?C.teal:C.line}`, borderRadius:8, cursor:"pointer",
    fontSize:12.5, fontWeight:sel?800:400, padding:"5px 0", fontFamily:"inherit",
  });

  return (
    <div style={{background:C.paper2,borderRadius:12,padding:"12px 14px",marginBottom:14}}>
      {/* Year */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <button onClick={()=>setViewY(y=>y-1)} style={{...btn(false),padding:"4px 10px"}}>‹</button>
        <button onClick={()=>onPick({mode:"year",date:new Date(viewY,0,1)})}
          style={{...btn(isSel("year",viewY)),padding:"5px 14px",fontWeight:800}}>{viewY}</button>
        <button onClick={()=>setViewY(y=>y+1)} style={{...btn(false),padding:"4px 10px"}}>›</button>
        <span style={{fontSize:11.5,color:C.inkFaint,marginLeft:4}}>click the year for all 12 months</span>
        {anchor && (
          <button onClick={onClear} style={{...btn(false),padding:"4px 12px",marginLeft:"auto",
                   color:C.inkFaint}}>Back to rolling</button>
        )}
      </div>

      {/* Months */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(12,1fr)",gap:4,marginBottom:8}}>
        {MON.map((m,i)=>(
          <button key={m} onClick={()=>{setViewM(i); onPick({mode:"month",date:new Date(viewY,i,1)});}}
            style={btn(isSel("month",i))}>{m}</button>
        ))}
      </div>

      {/* Days of the viewed month */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
        {["M","T","W","T","F","S","S"].map((d,i)=>(
          <div key={i} style={{fontSize:10.5,color:C.inkFaint,textAlign:"center",fontWeight:800}}>{d}</div>
        ))}
        {cells.map((n,i)=> n===null
          ? <div key={`b${i}`}/>
          : <button key={n} onClick={()=>onPick({mode:"day",date:new Date(viewY,viewM,n)})}
              style={btn(isSel("day",n))}>{n}</button>
        )}
      </div>
    </div>
  );
}

function VerifExtrudedStack({C, intervals, peak, labelEvery}){
  const H = 152, BASE = H - 24, LEFT = 26, RIGHT = 10;
  const usable = 620 - LEFT - RIGHT;
  const pitch = usable / Math.max(1, intervals.length);
  const w = pitch * 0.62, dx = pitch * 0.22, dy = dx * 0.7;
  const scale = (BASE - 16) / Math.max(1, peak);

  const block = (x, yTop, h, faceCol, capCol, key) => {
    if (h < 0.6) return null;
    const yBot = yTop + h;
    const pTop = `${x},${yTop} ${x + w},${yTop} ${x + w + dx},${yTop - dy} ${x + dx},${yTop - dy}`;
    const pSide = `${x + w},${yTop} ${x + w + dx},${yTop - dy} ${x + w + dx},${yBot - dy} ${x + w},${yBot}`;
    return (
      <g key={key}>
        <polygon points={pTop} fill={capCol}/>
        <polygon points={pSide} fill={capCol} opacity="0.72"/>
        <rect x={x} y={yTop} width={w} height={h} fill={faceCol}/>
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 620 ${H}`} style={{display:"block",width:"100%",overflow:"visible"}}>
      <line x1={LEFT - 8} y1={BASE} x2={612} y2={BASE} stroke={C.line}/>
      {intervals.map((r, i) => {
        const x = LEFT + i * pitch;
        const hOk = r.ok * scale, hNo = r.fail * scale;
        const n = r.ok + r.fail;
        return (
          <g key={i}>
            {n === 0
              // A dead interval keeps its slot and shows a floor tick. Dropping
              // it would make the neighbours look adjacent and hide the gap,
              // and the gap is the thing you most need to see.
              ? <line x1={x} y1={BASE} x2={x + w} y2={BASE} stroke={C.inkFaint} strokeWidth="1.5" opacity="0.45"/>
              : <>
                  {block(x, BASE - hOk, hOk, C.teal, C.tealInk, "ok")}
                  {block(x, BASE - hOk - hNo, hNo, C.coral, C.coralInk, "no")}
                </>}
            {i % labelEvery === 0 && (
              <text x={x + w / 2} y={BASE + 14} textAnchor="middle" fill={C.inkFaint}
                    fontSize="10.5" fontFamily="ui-monospace,Menlo,monospace">{r.shortLabel||r.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// One 3D treatment per surface: the columns above carry it, so these rows stay
// flat and quiet. State is a chip, not a shape — and `unmeasured` is hollow,
// never green, because nothing writes those values yet and a green row for
// something we do not measure is the false all-clear this panel exists to stop.
//
// `info` is NEUTRAL GREY, never green. It used to render teal-at-half-opacity,
// which at 9px is just green: "URL scans 4" sat in the same colour as a passing
// check while every actual checkpoint below it was hollow (Vic, 2026-08-15:
// "4 scans 2 green look the things it miss how it can be green?"). A count is
// not a verdict. Volume tells you something HAPPENED; it says nothing about
// whether the reports were any good — which is exactly the false all-clear this
// panel exists to prevent, one step removed. Green is reserved for a state
// something actually passed.
function VerifRowList({C, rows, picked, onPick}){
  return (
    <div>
      {rows.map((r, i) => r.sec ? (
        <div key={`s${i}`} style={{fontSize:11,fontWeight:800,letterSpacing:1.4,color:C.inkFaint,
                                   margin: i === 0 ? "0 0 6px" : "14px 0 6px"}}>{r.sec}</div>
      ) : (
        <div key={r.id} onClick={() => onPick && onPick(r.id)}
             style={{display:"flex",alignItems:"baseline",gap:10,padding:"6px 8px",cursor:"pointer",
                     borderBottom:`1px solid ${C.line}`,borderRadius:6,
                     background: picked === r.id ? C.tealBg : "transparent"}}>
          <span style={{width:9,height:9,borderRadius:2,flex:"none",
            background: r.state === "unmeasured" ? "transparent"
                      : r.state === "bad" ? C.coral
                      : r.state === "info" ? C.inkFaint
                      : C.teal,
            border: r.state === "unmeasured" ? `1px dashed ${C.inkFaint}` : "none"}}/>
          <span style={{fontSize:14,color:C.ink,flex:1}}>{r.name}</span>
          <span style={{fontSize:14,fontWeight:800,
            color: r.state === "bad" ? C.coralInk
                 : r.state === "unmeasured" ? C.inkFaint
                 : r.state === "info" ? C.ink
                 : C.tealInk}}>{r.value}</span>
          <span style={{fontSize:12.5,color:C.inkFaint,fontFamily:"ui-monospace,Menlo,monospace",
                        minWidth:200,textAlign:"right"}}>{r.note}</span>
        </div>
      ))}
    </div>
  );
}

// Provider cost + reliability, from provider_call (20260814_provider_call_log.sql).
//
// The point of this card is a decision, not a dashboard: Nimble's extract job
// and its search job are shown SEPARATELY, because only one of them has a
// replacement. Scrapfly's screenshot job sits next to Nimble's extract job on
// purpose — they do the same work on the same listings, so their failure rates
// are directly comparable and the keep-or-drop answer reads straight off.
//
// Nimble is reported in CALLS, not dollars. Their API exposes no per-call
// price, and a made-up cost on the screen you use to fire a vendor is worse
// than an honest blank.
function VerifProviderCosts({C, hours}){
  const [d,setD]=useState(null);
  const [state,setState]=useState("loading");

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_admin_provider_costs",{p_hours:hours});
        if(error) throw error;
        if(!cancelled){ setD(data||null); setState("ok"); }
      }catch(err){
        console.warn("provider costs unavailable:",err?.message||err);
        if(!cancelled){ setD(null); setState("absent"); }
      }
    })();
    return()=>{cancelled=true;};
  },[hours]);

  const byProv=d?.by_provider||[];
  const byOp=d?.by_operation||[];
  const hosts=d?.worst_hosts||[];
  const money=(n)=>`$${Number(n||0).toFixed(2)}`;
  const ms=(n)=>n==null?"—":`${(n/1000).toFixed(1)}s`;

  const nimbleExtract=byOp.find(o=>o.provider==="nimble"&&o.operation==="listing_extract");
  const scrapflyShot=byOp.find(o=>o.provider==="scrapfly"&&o.operation==="screenshot");

  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,letterSpacing:.8,marginBottom:8}}>
        PROVIDER COST + RELIABILITY
      </div>

      {state==="loading" && <div style={{color:C.inkFaint,fontSize:14,padding:"12px 0"}}>Reading provider_call…</div>}

      {state==="absent" && (
        <div style={{fontSize:13.5,color:C.inkFaint,lineHeight:1.65,padding:"6px 0"}}>
          No provider log yet — <span style={{fontFamily:"ui-monospace,Menlo,monospace"}}>20260814_provider_call_log.sql</span> is
          written but not applied, or no scans have run since it was. Every figure here stays blank until
          real calls land; nothing on this card is estimated.
        </div>
      )}

      {/* Plan ceilings. Spend without its ceiling is a number you can't act on:
          "$24.47" means nothing until you know the cap is $100. Limits live in
          admin_config so a plan change is an UPDATE, not a deploy. */}
      {state==="ok" && d?.config && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:14}}>
          {[
            {k:"Anthropic", used:Number(d.month_to_date?.anthropic_usd||0),
             cap:Number(d.config.limit_anthropic_usd_month||0),
             fmt:(n)=>`$${n.toFixed(2)}`, sub:"month to date · api_usage_log"},
            {k:"Scrapfly", used:Number(d.config.baseline_scrapfly_credits||0)+Number(d.month_to_date?.scrapfly_credits||0),
             cap:Number(d.config.limit_scrapfly_credits||0),
             fmt:(n)=>`${vnum(Math.round(n))} cr`, sub:`vendor baseline ${d.config.baseline_read_at||""} + since`},
            {k:"Nimble", used:Number(d.config.baseline_nimble_requests||0)+Number(d.month_to_date?.nimble_requests||0),
             cap:Number(d.config.limit_nimble_requests||0),
             fmt:(n)=>`${vnum(Math.round(n))} req`, sub:"free trial allowance"},
          ].map(m=>{
            const pct=m.cap>0?Math.min(100,(m.used/m.cap)*100):0;
            const hot=pct>=75;
            return (
              <div key={m.k} style={{background:C.paper2,borderRadius:10,padding:"10px 12px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                  <span style={{fontSize:13,fontWeight:800,color:C.ink}}>{m.k}</span>
                  <span style={{fontSize:12.5,color:C.inkFaint,fontFamily:"ui-monospace,Menlo,monospace"}}>
                    {Math.round(pct)}%
                  </span>
                </div>
                <div style={{fontSize:14,fontWeight:800,color:hot?C.coralInk:C.ink,marginTop:3,
                             fontFamily:"ui-monospace,Menlo,monospace"}}>
                  {m.fmt(m.used)} <span style={{color:C.inkFaint,fontWeight:400}}>/ {m.fmt(m.cap)}</span>
                </div>
                <div style={{height:4,borderRadius:2,background:C.line,marginTop:6,overflow:"hidden"}}>
                  <div style={{width:`${pct}%`,height:"100%",background:hot?C.coral:C.teal}}/>
                </div>
                <div style={{fontSize:11.5,color:C.inkFaint,marginTop:5}}>{m.sub}</div>
              </div>
            );
          })}
        </div>
      )}

      {state==="ok" && byProv.length===0 && (
        <div style={{fontSize:13.5,color:C.inkFaint,lineHeight:1.65,padding:"6px 0"}}>
          Table is live but empty — no provider calls recorded in this window yet.
        </div>
      )}

      {state==="ok" && byProv.length>0 && (<>
        <div style={{display:"grid",gridTemplateColumns:"1.1fr .7fr .7fr .8fr .7fr",gap:6,
                     fontSize:12,color:C.inkFaint,fontWeight:800,letterSpacing:.6,padding:"0 6px 4px"}}>
          <span>PROVIDER</span><span style={{textAlign:"right"}}>CALLS</span>
          <span style={{textAlign:"right"}}>FAIL</span><span style={{textAlign:"right"}}>COST</span>
          <span style={{textAlign:"right"}}>P95</span>
        </div>
        {byProv.map(p=>{
          const bad=Number(p.fail_pct)>=15;
          return (
            <div key={p.provider} style={{display:"grid",gridTemplateColumns:"1.1fr .7fr .7fr .8fr .7fr",gap:6,
                        alignItems:"baseline",padding:"6px",borderBottom:`1px solid ${C.line}`}}>
              <span style={{fontSize:14,color:C.ink,textTransform:"capitalize"}}>{p.provider}</span>
              <span style={{fontSize:14,textAlign:"right",color:C.inkSoft}}>{vnum(p.calls)}</span>
              <span style={{fontSize:14,textAlign:"right",fontWeight:800,color:bad?C.coralInk:C.tealInk}}>
                {p.fail_pct}%
              </span>
              <span style={{fontSize:14,textAlign:"right",color:Number(p.cost_usd)>0?C.ink:C.inkFaint}}>
                {Number(p.cost_usd)>0?money(p.cost_usd):(p.credits>0?`${vnum(p.credits)} cr`:"—")}
              </span>
              <span style={{fontSize:13.5,textAlign:"right",color:C.inkFaint}}>{ms(p.p95_ms)}</span>
            </div>
          );
        })}

        {/* The comparison the decision actually turns on. */}
        {(nimbleExtract||scrapflyShot) && (
          <div style={{marginTop:12,padding:"10px 12px",background:C.paper2,borderRadius:10}}>
            <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,marginBottom:6}}>
              SAME JOB, BOTH VENDORS
            </div>
            {[["Nimble — listing extract",nimbleExtract],["Scrapfly — screenshot",scrapflyShot]].map(([label,o])=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"3px 0"}}>
                <span style={{fontSize:13.5,color:C.ink}}>{label}</span>
                <span style={{fontSize:13.5,fontFamily:"ui-monospace,Menlo,monospace",
                              color:o&&Number(o.fail_pct)>=15?C.coralInk:C.tealInk}}>
                  {o?`${o.fail_pct}% fail of ${vnum(o.calls)}`:"no calls yet"}
                </span>
              </div>
            ))}
            <div style={{fontSize:12.5,color:C.inkFaint,marginTop:6,lineHeight:1.6}}>
              Nimble also runs the MSRP fallback search, which Scrapfly cannot replace — it renders a URL
              you already have, it does not find one. Judge the two jobs separately.
            </div>
          </div>
        )}

        {hosts.length>0 && (
          <div style={{marginTop:12}}>
            <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,marginBottom:4}}>
              WHERE READS FAIL
            </div>
            {hosts.slice(0,5).map(h=>(
              <div key={h.host} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}>
                <span style={{fontSize:13.5,color:C.inkSoft,fontFamily:"ui-monospace,Menlo,monospace"}}>{h.host}</span>
                <span style={{fontSize:13.5,color:C.coralInk,fontFamily:"ui-monospace,Menlo,monospace"}}>
                  {h.failed}/{h.calls} failed
                </span>
              </div>
            ))}
            <div style={{fontSize:12.5,color:C.inkFaint,marginTop:6,lineHeight:1.6}}>
              Concentrated failures mean a platform is walled, not that the vendor is bad. Spread-out
              failures mean the vendor is.
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}

// Operational cost — what LotCheck pays to run, against what it processes.
//
// The provider card answers "what did the API calls cost". This answers the
// question that decides the business: what does a check COST, versus what a
// check SELLS for. Credit packs put a check at roughly CA$1.50-2.00, so the
// fixed monthly burn over monthly checks is the whole unit-economics story.
//
// Every USD line is converted at a STORED rate with the date it was read, not
// a hardcoded one. A cost panel running on a silently ageing FX rate is how you
// end up planning against a number that stopped being true months ago.
function VerifOperationalCost({C}){
  const [d,setD]=useState(null);
  const [state,setState]=useState("loading");

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_admin_operational_cost");
        if(error) throw error;
        if(!cancelled){ setD(data||null); setState("ok"); }
      }catch(err){
        console.warn("operational cost unavailable:",err?.message||err);
        if(!cancelled){ setD(null); setState("absent"); }
      }
    })();
    return()=>{cancelled=true;};
  },[]);

  const cad=(n)=>`CA$${Number(n||0).toLocaleString("en-CA",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const today=new Date().getDate();
  const lines=d?.lines||[];
  const billed=lines.filter(l=>l.billing_day).sort((a,b)=>a.billing_day-b.billing_day);
  const rev=Number(d?.revenue_per_report_cad||0);

  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,letterSpacing:.8,marginBottom:8}}>
        OPERATIONAL COST vs USAGE
      </div>

      {state==="loading" && <div style={{color:C.inkFaint,fontSize:14,padding:"12px 0"}}>Reading operational_cost…</div>}
      {state==="absent" && (
        <div style={{fontSize:13.5,color:C.inkFaint,lineHeight:1.65,padding:"6px 0"}}>
          Not applied yet — <span style={{fontFamily:"ui-monospace,Menlo,monospace"}}>20260814_operational_cost.sql</span>.
        </div>
      )}

      {state==="ok" && d && (<>
        {/* Two blocks, because these are two different kinds of money. Green is
            what the founders owe whatever happens; red is what users cause by
            running scans and what report revenue has to cover. The old card put
            them in one row of tiles and computed "cost per check" as burn over
            checks — not a unit cost at all, and it made CA$1.50 look like a
            cost when it is the SELLING price. */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:12,marginBottom:14}}>

          {/* GREEN — founders */}
          <div style={{background:C.tealBg,border:`1px solid ${C.teal}`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.tealInk}}>
              FOUNDERS PAY — FIXED EVERY MONTH
            </div>
            <div style={{fontSize:30,fontWeight:800,color:C.tealInk,marginTop:6,letterSpacing:-1,
                         fontFamily:"ui-monospace,Menlo,monospace"}}>
              {cad(d.fixed_per_founder)}
            </div>
            <div style={{fontSize:13,color:C.tealInk,opacity:.85,marginTop:2}}>
              each · {cad(d.fixed_month_cad)} split {d.active_founders} ways
            </div>
            <div style={{fontSize:11.5,color:C.inkFaint,marginTop:8,lineHeight:1.6}}>
              Claude subscription and the Scrapfly plan. These do not move with how many reports run —
              you owe them at zero users and at ten thousand.
            </div>
          </div>

          {/* RED — users */}
          <div style={{background:C.coralBg,border:`1px solid ${C.coral}`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.coralInk}}>
              USERS DRIVE — COST PER REPORT
            </div>
            <div style={{fontSize:30,fontWeight:800,color:C.coralInk,marginTop:6,letterSpacing:-1,
                         fontFamily:"ui-monospace,Menlo,monospace"}}>
              {d.variable_per_report_cad==null ? "—" : `CA$${Number(d.variable_per_report_cad).toFixed(2)}`}
            </div>
            <div style={{fontSize:13,color:C.coralInk,opacity:.85,marginTop:2}}>
              {d.variable_per_report_cad==null
                ? "no reports run this month yet"
                : `${cad(d.variable_month_cad)} over ${vnum(d.checks_this_month)} reports`}
            </div>
            <div style={{fontSize:11.5,color:C.inkFaint,marginTop:8,lineHeight:1.6}}>
              Claude API tokens for reading listings, billed on what was actually consumed. Every URL a
              user runs adds to this.
            </div>
          </div>
        </div>

        {/* The unit economics, stated so CA$1.50 cannot be mistaken for a cost. */}
        <div style={{background:C.paper2,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,marginBottom:8}}>
            PER REPORT
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
            {[
              ["Sells for", cad(d.revenue_per_report_cad), C.tealInk, "10-pack unit price"],
              ["Costs us", d.variable_per_report_cad==null?"—":`CA$${Number(d.variable_per_report_cad).toFixed(2)}`, C.coralInk, "API tokens"],
              ["Margin", d.margin_per_report_cad==null?"—":`CA$${Number(d.margin_per_report_cad).toFixed(2)}`,
               d.margin_per_report_cad!=null&&Number(d.margin_per_report_cad)>0?C.tealInk:C.coralInk, "keeps the lights on"],
              ["Break-even", vnum(d.breakeven_reports), C.ink, "paid reports / month"],
            ].map(([k,v,col,sub])=>(
              <div key={k}>
                <div style={{fontSize:11.5,color:C.inkFaint}}>{k}</div>
                <div style={{fontSize:19,fontWeight:800,color:col,marginTop:2,
                             fontFamily:"ui-monospace,Menlo,monospace"}}>{v}</div>
                <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11.5,color:C.inkFaint,marginTop:10,lineHeight:1.6}}>
            CA$1.50 is what a report <b>sells</b> for — the 10-pack unit price ($14.99 ÷ 10), the
            conservative end of the ladder since the 5-pack earns $2.00. Break-even is how many paid
            reports cover the fixed {cad(d.fixed_month_cad)} at the current margin.
          </div>
        </div>

        {/* Billing calendar — the month has two fixed hits, two days apart. */}
        <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,marginBottom:6}}>
          BILLING CALENDAR
        </div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap",marginBottom:8}}>
          {Array.from({length:28},(_,i)=>i+1).map(day=>{
            const hit=billed.find(l=>l.billing_day===day);
            const isToday=day===today;
            return (
              <div key={day} title={hit?`${hit.label} — ${cad(hit.cad)}`:`day ${day}`}
                   style={{width:26,height:26,borderRadius:6,display:"flex",alignItems:"center",
                           justifyContent:"center",fontSize:12,fontFamily:"ui-monospace,Menlo,monospace",
                           background: hit ? C.coralBg : isToday ? C.tealBg : "transparent",
                           border: isToday ? `1px solid ${C.teal}` : `1px solid ${C.line}`,
                           color: hit ? C.coralInk : isToday ? C.tealInk : C.inkFaint,
                           fontWeight: hit||isToday ? 800 : 400}}>
                {day}
              </div>
            );
          })}
        </div>
        <div style={{fontSize:12.5,color:C.inkFaint,marginBottom:10}}>
          {billed.map(l=>`${l.billing_day}th — ${l.label} ${cad(l.cad)}`).join("  ·  ")}
          {billed.length>0 && "  ·  outlined = today"}
        </div>

        {/* Per-line, biggest first. */}
        {lines.map(l=>(
          <div key={l.vendor+l.label} style={{display:"flex",alignItems:"baseline",gap:10,padding:"6px 2px",
                      borderBottom:`1px solid ${C.line}`}}>
            <span style={{fontSize:14,color:C.ink,flex:1}}>{l.label}</span>
            <span style={{fontSize:12.5,color:C.inkFaint,fontFamily:"ui-monospace,Menlo,monospace"}}>
              {l.currency==="USD" ? `US$${Number(l.amount).toFixed(2)}` : ""}
            </span>
            <span style={{fontSize:14,fontWeight:800,color:Number(l.cad)>0?C.ink:C.tealInk,
                          fontFamily:"ui-monospace,Menlo,monospace",minWidth:86,textAlign:"right"}}>
              {Number(l.cad)>0 ? cad(l.cad) : "free"}
            </span>
            <span style={{fontSize:12,color:C.inkFaint,minWidth:64,textAlign:"right"}}>
              {l.billing_day ? `the ${l.billing_day}th` : "on demand"}
            </span>
          </div>
        ))}

        <div style={{fontSize:12.5,color:C.inkFaint,marginTop:9,lineHeight:1.65}}>
          USD billed at {d.fx_usd_cad} — the rate your card actually charges, not mid-market
          ({d.fx_usd_cad_interbank} on {d.fx_read_at}). That spread is {d.fx_markup_pct}%, about{" "}
          the card's conversion fee on every USD line — a real cost, not a rounding difference.
          Both rates live in admin_config.
        </div>
      </>)}
    </div>
  );
}

// Founder ledger — approve the monthly statement, see balances, record payments.
//
// This is the surface the approval rule needs: the statement is staged by cron
// and goes nowhere until it is approved HERE, with the frozen total shown
// beside the current one so a mid-month cost jump is visible before JC and
// Josh are billed rather than after.
function VerifFounderLedger({C, readOnly}){
  const [runs,setRuns]=useState(null);
  const [bal,setBal]=useState(null);
  const [state,setState]=useState("loading");
  const [busy,setBusy]=useState(null);
  const [pay,setPay]=useState({email:"",amount:"",line:"",month:"",covered:""});
  const [msg,setMsg]=useState(null);

  const [owed,setOwed]=useState(null);
  const load=async()=>{
    try{
      const [r,b,o]=await Promise.all([
        supabase.rpc("fn_admin_statement_runs"),
        supabase.rpc("fn_admin_founder_balances"),
        supabase.rpc("fn_admin_owed_to_payer"),
      ]);
      if(r.error) throw r.error;
      if(b.error) throw b.error;
      setRuns(r.data||[]); setBal(b.data||[]); setOwed(o.error?null:(o.data||null)); setState("ok");
    }catch(err){
      console.warn("founder ledger unavailable:",err?.message||err);
      setState("absent");
    }
  };
  useEffect(()=>{load();},[]);

  const cad=(n)=>`CA$${Number(n||0).toLocaleString("en-CA",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const act=async(fn,args,label)=>{
    setBusy(label); setMsg(null);
    try{
      const {error}=await supabase.rpc(fn,args);
      if(error) throw error;
      setMsg({ok:true,text:`${label} — done`});
      await load();
    }catch(err){ setMsg({ok:false,text:err?.message||String(err)}); }
    finally{ setBusy(null); }
  };

  const pending=(runs||[]).filter(r=>r.status==="pending_approval");

  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,letterSpacing:.8,marginBottom:8}}>
        FOUNDER LEDGER
      </div>

      {state==="loading" && <div style={{color:C.inkFaint,fontSize:14,padding:"12px 0"}}>Loading…</div>}
      {state==="absent" && (
        <div style={{fontSize:13.5,color:C.inkFaint,lineHeight:1.65,padding:"6px 0"}}>
          Not applied yet — <span style={{fontFamily:"ui-monospace,Menlo,monospace"}}>20260814_founder_ledger.sql</span>.
        </div>
      )}

      {state==="ok" && (<>
        {/* Approval — nothing reaches JC or Josh without this click. Hidden in
            the founders view; the RPC would refuse them anyway. */}
        {readOnly ? null : pending.length===0 ? (
          <div style={{fontSize:13.5,color:C.inkFaint,marginBottom:12}}>
            No statement awaiting approval. The cron stages one on the 1st; nothing sends until you approve it here.
          </div>
        ) : pending.map(r=>{
          const drift=Number(r.total_now_cad||0)-Number(r.total_cad||0);
          return (
            <div key={r.id} style={{background:C.paper2,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:8}}>
                <span style={{fontSize:14.5,fontWeight:800,color:C.ink}}>
                  {new Date(r.period_month+"T00:00:00").toLocaleDateString("en-CA",{month:"long",year:"numeric"})} — awaiting your approval
                </span>
                <span style={{fontSize:15,fontWeight:800,color:C.ink,fontFamily:"ui-monospace,Menlo,monospace"}}>{cad(r.total_cad)}</span>
              </div>
              {Math.abs(drift)>0.005 && (
                <div style={{fontSize:13.5,color:C.coralInk,marginTop:5,fontWeight:700}}>
                  Costs changed since this was staged: now {cad(r.total_now_cad)} ({drift>0?"+":""}{cad(drift)}).
                  Approving re-freezes at the current figure.
                </div>
              )}
              <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                <button disabled={busy} onClick={()=>act("fn_admin_approve_statement",{p_id:r.id},"Approved")}
                  style={{background:C.teal,color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",
                          fontSize:13.5,fontWeight:800,cursor:busy?"wait":"pointer"}}>
                  Approve
                </button>
                <button disabled={busy} onClick={()=>act("fn_admin_cancel_statement",{p_id:r.id},"Cancelled")}
                  style={{background:"transparent",color:C.inkSoft,border:`1px solid ${C.line}`,borderRadius:8,
                          padding:"7px 14px",fontSize:13.5,cursor:busy?"wait":"pointer"}}>
                  Cancel
                </button>
              </div>
              <div style={{fontSize:12.5,color:C.inkFaint,marginTop:7}}>
                Approving accrues this month's charges and authorises the send. It does not email anyone by
                itself — run the Founder statement workflow in send mode after approving.
              </div>
            </div>
          );
        })}

        {/* Owed to the founder whose card pays the vendors — the number that
            actually matters to the person out of pocket. */}
        {owed?.payer && Number(owed.total_cad)>0.005 && (
          <div style={{background:C.paper2,borderRadius:10,padding:"11px 13px",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint}}>
                OWED TO {String(owed.payer).toUpperCase()}
              </span>
              <span style={{fontSize:17,fontWeight:800,color:C.tealInk,
                            fontFamily:"ui-monospace,Menlo,monospace"}}>{cad(owed.total_cad)}</span>
            </div>
            <div style={{fontSize:13,color:C.inkFaint,marginTop:4}}>
              {(owed.from||[]).map(x=>`${x.name} ${cad(x.owes_cad)}`).join("  ·  ")}
            </div>
            <div style={{fontSize:12.5,color:C.inkFaint,marginTop:5,lineHeight:1.55}}>
              {owed.payer}'s card pays the vendors, so his own share settles automatically and
              everyone else's balance is money owed to him.
            </div>
          </div>
        )}

        {/* Balances */}
        <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,marginBottom:4}}>BALANCES</div>
        {(bal||[]).map(f=>(
          <div key={f.email} style={{padding:"7px 2px",borderBottom:`1px solid ${C.line}`}}>
            <div style={{display:"flex",alignItems:"baseline",gap:10}}>
              <span style={{fontSize:14,color:C.ink,flex:1,fontWeight:700}}>{f.name}</span>
              <span style={{fontSize:13,color:C.inkFaint}}>paid {cad(f.paid_cad)}</span>
              <span style={{fontSize:14.5,fontWeight:800,fontFamily:"ui-monospace,Menlo,monospace",
                            color:Number(f.balance_cad)>0.005?C.coralInk:C.tealInk,minWidth:88,textAlign:"right"}}>
                {cad(f.balance_cad)}
              </span>
            </div>
            {(f.unpaid_lines||[]).length>0 && (
              <div style={{fontSize:12.5,color:C.inkFaint,marginTop:3,paddingLeft:2}}>
                {f.unpaid_lines.map(u=>
                  `${new Date(u.month+"T00:00:00").toLocaleDateString("en-CA",{month:"short",year:"numeric"})} ${u.line} ${cad(u.amount_cad)}`
                ).join("  ·  ")}
              </div>
            )}
          </div>
        ))}

        {/* Record a payment — Vic only. fn_admin_record_payment gates on
            fn_is_admin(), so this is a courtesy, not the control. */}
        {readOnly ? (
          <div style={{fontSize:12.5,color:C.inkFaint,marginTop:14,lineHeight:1.65}}>
            Payments are recorded by Vic. If a figure here does not match what you have paid, tell him
            rather than assuming it will sort itself out — the ledger is append-only, so a correction is
            a new entry and the history stays intact.
          </div>
        ) : (<>
        <div style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:C.inkFaint,margin:"14px 0 6px"}}>
          RECORD A PAYMENT
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6}}>
          <select value={pay.email} onChange={e=>setPay({...pay,email:e.target.value})}
            style={{fontSize:13.5,padding:"7px 8px",borderRadius:8,border:`1px solid ${C.line}`,
                    background:C.paper2,color:C.ink}}>
            <option value="">Who paid…</option>
            {(bal||[]).map(f=><option key={f.email} value={f.email}>{f.name}</option>)}
          </select>
          <input placeholder="Amount CAD" value={pay.amount} inputMode="decimal"
            onChange={e=>setPay({...pay,amount:e.target.value})}
            style={{fontSize:13.5,padding:"7px 8px",borderRadius:8,border:`1px solid ${C.line}`,
                    background:C.paper2,color:C.ink}}/>
          <input placeholder="Line (optional)" value={pay.line}
            onChange={e=>setPay({...pay,line:e.target.value})}
            style={{fontSize:13.5,padding:"7px 8px",borderRadius:8,border:`1px solid ${C.line}`,
                    background:C.paper2,color:C.ink}}/>
          <input placeholder="Month YYYY-MM-01" value={pay.month}
            onChange={e=>setPay({...pay,month:e.target.value})}
            style={{fontSize:13.5,padding:"7px 8px",borderRadius:8,border:`1px solid ${C.line}`,
                    background:C.paper2,color:C.ink}}/>
          <select value={pay.covered} onChange={e=>setPay({...pay,covered:e.target.value})}
            style={{fontSize:13.5,padding:"7px 8px",borderRadius:8,border:`1px solid ${C.line}`,
                    background:C.paper2,color:C.ink}}>
            <option value="">Paid it themselves</option>
            {(bal||[]).map(f=><option key={f.email} value={f.email}>Fronted by {f.name}</option>)}
          </select>
          <button disabled={busy||!pay.email||!pay.amount}
            onClick={()=>act("fn_admin_record_payment",{
              p_founder_email:pay.email,
              p_amount_cad:Number(pay.amount),
              p_period_month:pay.month||null,
              p_covered_by_email:pay.covered||null,
              p_line_label:pay.line||null,
              p_note:null,
            },"Payment recorded")}
            style={{background:C.teal,color:"#fff",border:"none",borderRadius:8,padding:"7px 12px",
                    fontSize:13.5,fontWeight:800,cursor:(busy||!pay.email||!pay.amount)?"not-allowed":"pointer",
                    opacity:(busy||!pay.email||!pay.amount)?.5:1}}>
            Record
          </button>
        </div>
        <div style={{fontSize:12.5,color:C.inkFaint,marginTop:7,lineHeight:1.6}}>
          "Fronted by" records that someone else paid the vendor on their behalf — the charge stays
          outstanding, because that moves the debt to the founder who paid, it does not clear it.
          The ledger is append-only; a mistake is corrected with another entry, never an edit.
        </div>
        </>)}

        {msg && (
          <div style={{fontSize:13.5,marginTop:9,color:msg.ok?C.tealInk:C.coralInk,fontWeight:700}}>
            {msg.text}
          </div>
        )}
      </>)}
    </div>
  );
}

// Why we pay for each thing — written for JC and Josh, not for engineers.
//
// They are asked to fund a share every month, so they are owed a plain answer
// to "what is this and why do we need it". Each entry says what the service
// does, what happens without it, and what it costs — including the two we pay
// nothing for, because "free" is worth knowing too.
const SERVICE_NOTES = [
  {
    name: "Claude subscription",
    cost: "CA$294.00 / month · billed the 8th",
    type: "fixed",
    what: "The Claude Code subscription the product is built with — writing, reviewing and fixing LotCheck itself.",
    why: "This is development capacity, not something the running site consumes. It is the one line that buys build speed rather than serving a buyer.",
    without: "Work slows to whatever can be written by hand.",
  },
  {
    name: "Claude API credits",
    cost: "billed on actual use · ~US$24 in August",
    type: "variable",
    what: "Every time a buyer runs a check, a Claude API call reads the dealer listing and extracts price, VIN, odometer, fees and financing.",
    why: "This is the product. It is also the only cost that grows with usage — more reports, more tokens — which is why report revenue has to cover it.",
    without: "No reports. This is the engine.",
  },
  {
    name: "Scrapfly",
    cost: "US$30.00 / month · billed the 10th",
    type: "fixed",
    what: "Loads dealer pages that block ordinary requests, and takes the sealed full-page screenshot attached to every report.",
    why: "Most dealer sites are JavaScript-rendered and bot-protected; a plain fetch gets an empty shell. The screenshot is also the buyer's evidence of what the page said at report time.",
    without: "Roughly half of dealer listings become unreadable, and reports lose the capture that makes them dispute-proof.",
  },
  {
    name: "Nimble",
    cost: "free — trial, 5,000 requests",
    type: "free",
    what: "A second listing reader, plus the search that finds a manufacturer's MSRP page when our catalog has no row for a trim.",
    why: "Under review. Its success rate over 973 requests was 52.7%, spread evenly across 51 domains — which points at the vendor rather than at two awkward dealer platforms.",
    without: "The extract job is largely covered by Scrapfly. The MSRP search has no replacement yet, which is the open question.",
  },
  {
    name: "Supabase",
    cost: "free tier today",
    type: "free",
    what: "The database and the edge functions — the MSRP catalog, credits, the delivery ledger, and this admin panel.",
    why: "Everything LotCheck knows lives here. Free until roughly 10,000 checks a day, then US$25/month.",
    without: "There is no product.",
  },
  {
    name: "Resend",
    cost: "free tier today",
    type: "free",
    what: "Sends the report email with its PDF, and will send these founder statements.",
    why: "Transactional email from our own domain, so a report lands in an inbox rather than a spam folder.",
    without: "Reports can be read on screen but not kept.",
  },
];

// What a URL scan costs us vs what the buyer pays for it, per pricing tier.
//
// This is the founders' number. A scan costs about CA$0.03 in Claude tokens and
// sells for CA$2.60-4.99, so the gross margin per report is over 99% and the
// whole business reduces to one question: do enough reports sell to cover the
// fixed CA$339 a month. Everything past that line is nearly pure margin, which
// is why "bills paid" is the headline and not revenue.
function VerifPackEconomics({C}){
  const [d,setD]=useState(null);
  const [state,setState]=useState("loading");

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_admin_pack_economics");
        if(error) throw error;
        if(!cancelled){ setD(data||null); setState("ok"); }
      }catch(err){
        console.warn("pack economics unavailable:",err?.message||err);
        if(!cancelled) setState("absent");
      }
    })();
    return()=>{cancelled=true;};
  },[]);

  const cad=(n,dp=2)=>`CA$${Number(n||0).toLocaleString("en-CA",{minimumFractionDigits:dp,maximumFractionDigits:dp})}`;
  const packs=d?.packs||[];
  const pct=Math.min(100,Number(d?.bills_paid_pct||0));

  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:C.inkFaint,letterSpacing:.8,marginBottom:4}}>
        WHAT A SCAN COSTS US vs WHAT THE USER PAYS
      </div>

      {state==="loading" && <div style={{color:C.inkFaint,fontSize:13,padding:"12px 0"}}>Loading…</div>}
      {state==="absent" && (
        <div style={{fontSize:12.5,color:C.inkFaint,lineHeight:1.65,padding:"6px 0"}}>
          Not applied yet — <span style={{fontFamily:"ui-monospace,Menlo,monospace"}}>20260815_credit_packs.sql</span>.
        </div>
      )}

      {state==="ok" && d && (<>
        {/* Bills paid — the only line that decides whether the month worked. */}
        <div style={{background:d.bills_paid?C.tealBg:C.paper2,border:`1px solid ${d.bills_paid?C.teal:C.line}`,
                     borderRadius:12,padding:"13px 15px",marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:8}}>
            <span style={{fontSize:12,fontWeight:800,letterSpacing:.8,color:d.bills_paid?C.tealInk:C.inkFaint}}>
              {d.bills_paid ? "BILLS ARE PAID" : "BILLS NOT YET COVERED"}
            </span>
            <span style={{fontSize:14,fontWeight:800,color:d.bills_paid?C.tealInk:C.ink,
                          fontFamily:"ui-monospace,Menlo,monospace"}}>
              {cad(d.revenue_month_cad)} / {cad(d.fixed_month_cad)}
            </span>
          </div>
          <div style={{height:6,borderRadius:3,background:C.line,marginTop:8,overflow:"hidden"}}>
            <div style={{width:`${pct}%`,height:"100%",background:d.bills_paid?C.teal:C.butter}}/>
          </div>
          <div style={{fontSize:12.5,color:C.inkFaint,marginTop:6}}>
            {d.bills_paid
              ? "Every report from here is nearly pure margin."
              : `${cad(d.still_needed_cad)} still to cover this month's fixed cost.`}
          </div>
        </div>

        {/* The eye-opener, per tier. */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(215px,1fr))",gap:12}}>
          {packs.map(p=>(
            <div key={p.key} style={{border:`1px solid ${p.best_value?C.teal:C.line}`,borderRadius:12,
                        padding:"13px 15px",background:p.best_value?C.tealBg:"transparent"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <span style={{fontSize:15,fontWeight:800,color:C.ink}}>{p.name}</span>
                <span style={{fontSize:17,fontWeight:800,color:C.ink,
                              fontFamily:"ui-monospace,Menlo,monospace"}}>{cad(p.price_cad)}</span>
              </div>

              <div style={{marginTop:10,display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                <span style={{fontSize:12.5,color:C.inkFaint}}>User pays / scan</span>
                <span style={{fontSize:15,fontWeight:800,color:C.tealInk,
                              fontFamily:"ui-monospace,Menlo,monospace"}}>{cad(p.user_pays_per_scan)}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginTop:3}}>
                <span style={{fontSize:12.5,color:C.inkFaint}}>Scan cost (Claude)</span>
                <span style={{fontSize:15,fontWeight:800,color:C.coralInk,
                              fontFamily:"ui-monospace,Menlo,monospace"}}>−{cad(p.scan_cost_per_pack)}</span>
              </div>
              {/* Stripe on its own line. On the $4.99 tier the processor costs
                  more than fifteen times the compute — the flat 30c lands
                  hardest on the smallest basket. */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginTop:3}}>
                <span style={{fontSize:12.5,color:C.inkFaint}}>Stripe fee</span>
                <span style={{fontSize:15,fontWeight:800,color:C.coralInk,
                              fontFamily:"ui-monospace,Menlo,monospace"}}>−{cad(p.stripe_fee_cad)}</span>
              </div>
              <div style={{fontSize:11.5,color:C.inkFaint,textAlign:"right",marginTop:1}}>
                {p.stripe_pct_of_price}% of the sale
              </div>

              <div style={{borderTop:`1px solid ${C.line}`,marginTop:9,paddingTop:9}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                  <span style={{fontSize:12.5,color:C.inkFaint}}>Net profit / pack</span>
                  <span style={{fontSize:16,fontWeight:800,color:C.tealInk,
                                fontFamily:"ui-monospace,Menlo,monospace"}}>{cad(p.net_profit_per_pack)}</span>
                </div>
                <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>{p.net_margin_pct}% after both costs</div>
              </div>

              <div style={{marginTop:9,fontSize:12.5,color:C.ink,lineHeight:1.55}}>
                <b>{vnum(p.packs_to_pay_bills)}</b> sold covers the month
              </div>
            </div>
          ))}
        </div>

        <div style={{fontSize:12.5,color:C.inkFaint,marginTop:12,lineHeight:1.65}}>
          Scan cost is <b>{d.cost_basis}</b> — Claude tokens for reading the listing, about{" "}
          {cad(d.cost_per_scan_cad,3)} each. Stripe is {d.stripe_fee_pct}% + {cad(d.stripe_fee_fixed_cad)}
          {" "}per sale, which on the smallest pack costs{" "}
          <b style={{color:C.coralInk}}>
            {packs[0] ? Math.round(Number(packs[0].stripe_fee_cad)/Math.max(Number(d.cost_per_scan_cad),0.0001)) : "—"}×
          </b>{" "}
          the compute — the flat {cad(d.stripe_fee_fixed_cad)} lands hardest on the smallest basket, which is
          the argument for the 3- and 5-packs. Both rates live in admin_config; international cards cost more.
        </div>
      </>)}
    </div>
  );
}

function VerifWhyWePay({C}){
  const tone=(t)=> t==="variable" ? {bg:C.coralBg,ink:C.coralInk,label:"scales with usage"}
                 : t==="free"    ? {bg:C.tealBg,ink:C.tealInk,label:"free today"}
                 :                  {bg:C.butterBg,ink:C.butterInk,label:"fixed monthly"};
  return (
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:C.inkFaint,letterSpacing:.8,marginBottom:4}}>
        WHAT WE PAY FOR, AND WHY
      </div>
      <div style={{fontSize:12.5,color:C.inkFaint,marginBottom:12,lineHeight:1.6}}>
        For JC and Josh. Every service the three of us fund, what it does, and what breaks without it.
      </div>
      {SERVICE_NOTES.map(s=>{
        const t=tone(s.type);
        return (
          <div key={s.name} style={{borderTop:`1px solid ${C.line}`,padding:"12px 0"}}>
            <div style={{display:"flex",alignItems:"baseline",gap:10,flexWrap:"wrap"}}>
              <span style={{fontSize:15,fontWeight:800,color:C.ink}}>{s.name}</span>
              <span style={{fontSize:11,fontWeight:800,padding:"2px 8px",borderRadius:999,
                            background:t.bg,color:t.ink}}>{t.label}</span>
              <span style={{fontSize:12.5,color:C.inkSoft,marginLeft:"auto",
                            fontFamily:"ui-monospace,Menlo,monospace"}}>{s.cost}</span>
            </div>
            <div style={{fontSize:13.5,color:C.ink,marginTop:6,lineHeight:1.65}}>{s.what}</div>
            <div style={{fontSize:13,color:C.inkSoft,marginTop:5,lineHeight:1.65}}>{s.why}</div>
            <div style={{fontSize:12.5,color:C.inkFaint,marginTop:5,lineHeight:1.6}}>
              <b style={{color:C.inkSoft}}>Without it:</b> {s.without}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VerificationTab({apiUsage, apiUsageLoading, readOnly}){
  const {C}=useAdminTheme();
  const [range,setRange]=useState("24h");
  const bucket=VERIF_BUCKETS.find(b=>b.k===range)||VERIF_BUCKETS[1];

  // Delivery ledger (20260814_report_delivery.sql). Absent until that
  // migration is applied — which renders as "not instrumented", exactly as it
  // did before, rather than as an error. The panel must never imply a send was
  // recorded when the table that would record it does not exist.
  const [ledger,setLedger]=useState(null);
  useEffect(()=>{
    let cancelled=false;
    const hours={"1h":1,"24h":24,"7d":168,"30d":720,"1y":8760}[range]||24;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_admin_delivery_ledger",{p_hours:hours});
        if(error) throw error;
        if(!cancelled) setLedger(data||null);
      }catch(err){
        console.warn("delivery ledger unavailable (migration applied?):",err?.message||err);
        if(!cancelled) setLedger(null);
      }
    })();
    return()=>{cancelled=true;};
  },[range]);

  const [picked,setPicked]=useState(null);

  // A calendar pick overrides the rolling window. Null = rolling, which is the
  // default because "how are we doing right now" is the everyday question.
  const [anchor,setAnchor]=useState(null);
  const [calOpen,setCalOpen]=useState(false);

  const intervals=useMemo(
    ()=> anchor ? buildAnchoredIntervals(anchor,apiUsage) : buildVerifIntervals(bucket,apiUsage),
    [anchor,bucket,apiUsage]);

  const anchorLabel = anchor && (
    anchor.mode==="day"   ? anchor.date.toLocaleDateString("en-CA",{weekday:"long",month:"long",day:"numeric",year:"numeric"})
  : anchor.mode==="month" ? anchor.date.toLocaleDateString("en-CA",{month:"long",year:"numeric"})
  :                         String(anchor.date.getFullYear()));
  const totOk=intervals.reduce((a,r)=>a+r.ok,0);
  const totFail=intervals.reduce((a,r)=>a+r.fail,0);
  const tot=totOk+totFail;
  const rate=tot?((totOk/tot)*100).toFixed(1):null;
  // Per-feature volume. `tot` above counts EVERY row, which was fine while
  // analyze-listing-url was the only writer -- but analyze-quote started
  // logging on 2026-08-15, so an upload would have been silently counted as a
  // URL scan. Same window as the intervals, so the two agree.
  const winStart=intervals.length?intervals[0].start.getTime():0;
  const winEnd=intervals.length?intervals[intervals.length-1].end.getTime():0;
  const inWindow=(apiUsage||[]).filter(r=>{
    const t=new Date(r.created_at).getTime();
    return !isNaN(t)&&t>=winStart&&t<winEnd;
  });
  const totUrl=inWindow.filter(r=>r.feature==="listing_url").length;
  const totQuote=inWindow.filter(r=>r.feature==="quote").length;
  // Delivered, but missing core points -- logged as success with a "degraded:"
  // note. Counting these as clean successes is what made a hollow report look
  // identical to a complete one.
  const isDegraded=r=>r.success&&typeof r.error_message==="string"&&r.error_message.startsWith("degraded:");
  const totDegraded=inWindow.filter(isDegraded).length;
  const totUrlDegraded=inWindow.filter(r=>r.feature==="listing_url"&&isDegraded(r)).length;
  const totQuoteDegraded=inWindow.filter(r=>r.feature==="quote"&&isDegraded(r)).length;
  const peak=Math.max(1,...intervals.map(r=>r.ok+r.fail));
  const loaded=!apiUsageLoading;

  // Per-checkpoint outcomes (20260815_verification_check.sql). Read over the
  // SAME window as the intervals above -- rolling or calendar-anchored, both
  // reduce to a since/until pair -- so the checkpoint rates and the volume
  // chart can never describe different periods. Absent until the migration is
  // applied, which renders hollow rather than green.
  const [checks,setChecks]=useState(null);
  const [checksLoading,setChecksLoading]=useState(true);
  useEffect(()=>{
    if(!winStart||!winEnd) return;
    let cancelled=false;
    (async()=>{
      setChecksLoading(true);
      try{
        const {data,error}=await supabase.rpc("fn_admin_verification_checks",{
          p_since:new Date(winStart).toISOString(),
          p_until:new Date(winEnd).toISOString(),
        });
        if(error) throw error;
        if(!cancelled) setChecks(data||[]);
      }catch(err){
        console.warn("verification_check unavailable (migration applied?):",err?.message||err);
        if(!cancelled) setChecks(null);
      }finally{ if(!cancelled) setChecksLoading(false); }
    })();
    return()=>{cancelled=true;};
  },[winStart,winEnd]);

  // green = the check produced a backed answer; red = it did not. not_applicable
  // is excluded from the denominator -- it is the only outcome that can be, and
  // the writer may only emit it on a positive fact -- so the n/a count is shown
  // beside every rate. An n/a share that starts climbing is the tell that the
  // vocabulary is being abused to flatter the number.
  const CHECK_TARGET_PCT = 1;
  const checkStats=useMemo(()=>{
    if(!Array.isArray(checks)) return null;
    const by=new Map();
    for(const r of checks){
      let s=by.get(r.checkpoint);
      if(!s){ s={green:0,red:0,na:0,reasons:new Map()}; by.set(r.checkpoint,s); }
      if(r.outcome==="verified"||r.outcome==="checked_no_match") s.green++;
      else if(r.outcome==="not_applicable") s.na++;
      else { s.red++; if(r.detail) s.reasons.set(r.detail,(s.reasons.get(r.detail)||0)+1); }
    }
    for(const s of by.values()){
      s.attempts=s.green+s.red;
      s.failPct=s.attempts?(s.red/s.attempts)*100:null;
      s.passPct=s.attempts?(s.green/s.attempts)*100:null;
      s.top=[...s.reasons.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3);
    }
    return by;
  },[checks]);

  // The headline Vic asked for: one failure rate across every checkpoint of
  // every report in the window, against the 1% bar.
  const checkTotals=useMemo(()=>{
    if(!checkStats) return null;
    let green=0,red=0,na=0;
    for(const s of checkStats.values()){ green+=s.green; red+=s.red; na+=s.na; }
    const attempts=green+red;
    const worst=[...checkStats.entries()]
      .filter(([,s])=>s.attempts>0&&s.red>0)
      .sort((a,b)=>b[1].failPct-a[1].failPct);
    return {green,red,na,attempts,failPct:attempts?(red/attempts)*100:null,worst};
  },[checkStats]);

  // The ledger's rows, in report order. Volume first (what came in), delivery
  // second (what went out), then the 13 checkpoints that decide whether the
  // report was worth sending.
  const isoRows = useMemo(()=>{
    const unmeasured = (id,name,needs,proof) =>
      ({id, name, value:"—", note:needs, state:"unmeasured", proof});
    const rows = [
      {sec:"VOLUME"},
      {id:"url", name:"URL scans", value:apiUsageLoading?"…":vnum(totUrl),
       // The count alone reads as an all-clear, so carry the health beside it.
       note:totUrlDegraded>0?`${totUrlDegraded} incomplete · feature=listing_url`:"api_usage_log · feature=listing_url",
       state:totUrlDegraded>0?"bad":"info",
       proof:"Every scan the URL path logged in this window, pass and fail together. Written by logUsage in analyze-listing-url on each run. Counted by feature — before 2026-08-15 this figure counted EVERY row, so once uploads started logging they would have been miscounted as URL scans."},
      {id:"degraded", name:"Delivered but incomplete", value:apiUsageLoading?"…":vnum(totDegraded),
       note:"success=true · degraded", state:totDegraded>0?"bad":"info",
       proof:"Reports that were delivered and charged for, but reached the buyer missing one or more core points (price, MSRP, VIN, recalls, APR). These log as success because a report WAS returned — this row is what stops a hollow report reading as a clean one. A non-zero count here is the number of people who paid and got less than the product promises."},
      {id:"file", name:"Uploaded files (PDF path)", value:apiUsageLoading?"…":vnum(totQuote),
       note:totQuoteDegraded>0?`${totQuoteDegraded} incomplete · feature=quote`:"api_usage_log · feature=quote",
       state:totQuoteDegraded>0?"bad":"info",
       proof:"Every upload analyze-quote logged in this window, pass and fail together. Wired 2026-08-15 — before that this path wrote no telemetry at all, which is why an expired API key took the product down unnoticed. A row logged success:true but carrying a 'degraded: missing …' note means a report was delivered without some of its core points (price, MSRP, VIN, recalls, APR) — delivered is not the same as complete."},
      {sec:"DELIVERY"},
    ];
    if (ledger) {
      const attempts = ledger.attempts || 0;
      const okPct = attempts ? (ledger.accepted / attempts) * 100 : 100;
      const delivPct = ledger.accepted ? (ledger.delivered / ledger.accepted) * 100 : 100;
      rows.push(
        {id:"sent", name:"Emails sent with the PDF", value:vnum(ledger.accepted),
         note:`${vnum(attempts)} attempted · ${vnum(ledger.provider_err)} rejected`,
         state:(ledger.provider_err||0)>0?"bad":"ok", pct:okPct,
         proof:"One row per attempt in report_delivery, written before the send and carrying the SHA-256 of the exact PDF bytes handed to Resend. A customer forwards their PDF, you hash it, and it matches a row or it does not."},
        {id:"deliv", name:"Delivery confirmed by provider", value:vnum(ledger.delivered),
         note:`${vnum(ledger.bounced)} bounced · ${vnum(ledger.complained)} complaints`,
         state:(ledger.bounced||0)>0?"bad":"ok", pct:delivPct,
         proof:"Resend's own webhook events. A confirmed delivery means the receiving mail server accepted the message — not that it reached the inbox, and not that anyone read it. Opens are deliberately not shown: image blocking hides them and Apple Mail Privacy Protection invents them, so an open proves nothing either way."},
        {id:"stall", name:"Accepted, unresolved over 1h", value:vnum(ledger.stalled_1h),
         note:`${vnum(ledger.no_msg_id)} with no provider id`,
         state:(ledger.stalled_1h||0)>0?"bad":"ok", pct:(ledger.stalled_1h||0)>0?60:100,
         proof:"Sends Resend accepted but never resolved to delivered or bounced. A non-zero count here is the early warning that delivery reporting has stopped flowing, not that the mail failed."},
      );
    } else {
      rows.push(
        unmeasured("sent","Emails sent with the PDF","report_delivery.pdf_sha256",
          "The ledger tables are written but not applied — supabase/migrations/20260814_report_delivery.sql. Until that migration runs, sends are recorded nowhere and this row stays hollow."),
        unmeasured("deliv","Delivery confirmed by provider","report_delivery_event",
          "Needs the same migration plus the resend-webhook function deployed and RESEND_WEBHOOK_SECRET set."),
      );
    }
    rows.push({sec:`CHECKPOINTS · ${VERIF_CHECKPOINTS.length} PER REPORT`});

    // The headline: every checkpoint of every report in this window, against
    // the 1% bar. Shown before the individual rows so a green wall can never be
    // the first thing read while the aggregate is failing.
    if (checkTotals && checkTotals.attempts > 0) {
      const f = checkTotals.failPct;
      rows.push({
        id:"cp-all", name:"All checkpoints — failure rate",
        value:`${f.toFixed(f < 10 ? 2 : 1)}%`,
        note:`${vnum(checkTotals.red)} red of ${vnum(checkTotals.attempts)} checks · ${vnum(checkTotals.na)} n/a · target under ${CHECK_TARGET_PCT}%`,
        state:f > CHECK_TARGET_PCT ? "bad" : "ok",
        pct:checkTotals.attempts?(checkTotals.green/checkTotals.attempts)*100:0,
        proof:`Every one of the ${VERIF_CHECKPOINTS.length} checkpoints, on every report in this window, counted individually — not one boolean per report. A checkpoint that did not resolve is red whatever the reason: catalog gap, unreadable page, missing trim. The buyer paid for ${VERIF_CHECKPOINTS.length} points, so 12 of 13 is a failure of the 13th.\n\nOnly "not applicable" is excluded, and only when the writer could prove it from a positive fact — a gas car has no EV rebate, a new car has no odometer history. Not knowing something is never n/a; it is red. The n/a count sits in this row so that if it starts climbing, you see it.${checkTotals.worst.length?`\n\nWorst right now: ${checkTotals.worst.slice(0,3).map(([k,s])=>`${k} ${s.failPct.toFixed(0)}%`).join(", ")}.`:""}`,
      });
    }

    for (const [label, needs] of VERIF_CHECKPOINTS) {
      const key = needs.split(".")[1];
      const s = checkStats?.get(key);
      if (!checkStats) {
        rows.push(unmeasured(needs, label, needs,
          `verification_check is written by both analyze functions but the table is not applied yet — supabase/migrations/20260815_verification_check.sql. Until it runs, this row stays hollow rather than green: unmeasured is not passing.`));
      } else if (!s || s.attempts === 0) {
        // No REPORTS in the window is different from no data: say which.
        rows.push(unmeasured(needs, label, s ? `${s.na} n/a · 0 judged` : needs,
          s ? `Every ${label.toLowerCase()} check in this window was not-applicable, so there is nothing to score. That is only legitimate if each one rested on a positive fact about the vehicle — if this row is permanently n/a, the writer is excusing itself.`
            : `No reports ran in this window, so this checkpoint has nothing to report. It is blank, not passing.`));
      } else {
        const over = s.failPct > CHECK_TARGET_PCT;
        rows.push({
          id:needs, name:label,
          value:`${s.failPct.toFixed(s.failPct < 10 ? 2 : 1)}%`,
          note:`${vnum(s.red)} red of ${vnum(s.attempts)}${s.na?` · ${vnum(s.na)} n/a`:""}`,
          state:over ? "bad" : "ok",
          pct:s.passPct,
          proof:(over
            ? `Above the ${CHECK_TARGET_PCT}% bar — a defect to fix, not a number to explain.`
            : `Within the ${CHECK_TARGET_PCT}% bar.`)
            + ` ${vnum(s.green)} of ${vnum(s.attempts)} judged checks resolved with a backed answer.`
            + (s.na ? ` ${vnum(s.na)} were not applicable and are excluded from the rate.` : "")
            + (s.top.length ? `\n\nWhy it failed:\n${s.top.map(([why,n])=>`  ${vnum(n)}×  ${why}`).join("\n")}` : ""),
        });
      }
    }
    return rows;
  },[ledger,tot,apiUsageLoading,checkStats,checkTotals]);


  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginBottom:14}}>
        <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1}}>
          VERIFICATION LEDGER {loaded && <VerifLiveDot C={C}/>}
        </div>
        <div style={{display:"flex",gap:4,background:C.card,border:`1px solid ${C.line}`,borderRadius:999,padding:3}}>
          {VERIF_BUCKETS.map(b=>(
            <button key={b.k} onClick={()=>setRange(b.k)} style={{
              background: range===b.k ? C.tealBg : "transparent",
              color: range===b.k ? C.tealInk : C.inkFaint,
              border:"none",borderRadius:999,padding:"5px 13px",fontSize:13.5,fontWeight:700,cursor:"pointer",
            }}>{b.k}</button>
          ))}
        </div>
      </div>

      {/* ---- volume + pass rate, real, from api_usage_log ---- */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16}}>
        {[
          ["Checks", apiUsageLoading?"…":tot.toLocaleString("en-CA"), C.ink, bucket.label],
          ["Verified", apiUsageLoading?"…":totOk.toLocaleString("en-CA"), C.tealInk, rate?`${rate}% of all checks`:"no checks in range"],
          ["Failed", apiUsageLoading?"…":totFail.toLocaleString("en-CA"), totFail?C.coralInk:C.inkFaint, totFail?"each one is an open error code":"none in range"],
        ].map(([k,v,col,sub])=>(
          <div key={k} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"12px 14px"}}>
            <div style={{fontSize:12.5,fontWeight:800,letterSpacing:1,color:C.inkFaint,textTransform:"uppercase"}}>{k}</div>
            <div style={{fontSize:26,fontWeight:800,color:col,marginTop:4,letterSpacing:-1}}>{v}</div>
            <div style={{fontSize:13,color:C.inkFaint,marginTop:2}}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ---- every interval, separated ---- */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                     flexWrap:"wrap",gap:8,marginBottom:8}}>
          <span style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,letterSpacing:.8}}>
            EVERY INTERVAL, SEPARATED — {(anchorLabel||bucket.label).toUpperCase()}
          </span>
          <button onClick={()=>setCalOpen(o=>!o)}
            style={{background:calOpen||anchor?C.tealBg:"transparent",
                    border:`1px solid ${calOpen||anchor?C.teal:C.line}`,borderRadius:999,
                    padding:"5px 14px",fontSize:12.5,fontWeight:800,cursor:"pointer",
                    color:calOpen||anchor?C.tealInk:C.inkSoft,fontFamily:"inherit"}}>
            {anchor ? "Change date" : "Pick a day, month or year"}
          </button>
        </div>

        {calOpen && (
          <VerifCalendar C={C} anchor={anchor}
            onPick={a=>{setAnchor(a);}}
            onClear={()=>{setAnchor(null); setCalOpen(false);}}/>
        )}

        {apiUsageLoading ? (
          <div style={{color:C.inkFaint,fontSize:14,padding:"14px 0"}}>Reading api_usage_log…</div>
        ) : (
          <>
            <VerifExtrudedStack C={C} intervals={intervals} peak={peak}
              labelEvery={intervals.length > 24 ? 5 : intervals.length > 20 ? 4 : intervals.length > 12 ? 3 : 1}/>
            <div style={{fontSize:13,color:C.inkFaint,marginTop:6}}>
              One column per interval — teal base is verified, the coral cap on top is failed reads,
              so the failure share sits above the stack instead of hiding inside it. An interval with
              no checks keeps its slot and shows a floor tick: a gap you can see is the point.
            </div>
          </>
        )}
      </div>

      <VerifOperationalCost C={C}/>

      <VerifFounderLedger C={C} readOnly={readOnly}/>

      <VerifPackEconomics C={C}/>

      <VerifWhyWePay C={C}/>

      <VerifProviderCosts C={C} hours={{"1h":1,"24h":24,"7d":168,"30d":720,"1y":8760}[range]||24}/>

      {/* ---- the ledger: volume + delivery + 13 checks ---- */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"14px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:2}}>
          <span style={{fontSize:13.5,fontWeight:800,color:C.inkFaint,letterSpacing:.8}}>
            LEDGER — {bucket.label.toUpperCase()}
          </span>
          <span style={{fontSize:13,color:C.inkFaint}}>
            hollow = not instrumented yet
          </span>
        </div>
        <VerifRowList C={C} rows={isoRows} picked={picked} onPick={setPicked}/>
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:6,paddingTop:10,fontSize:13,color:C.inkFaint,lineHeight:1.65}}>
          {picked
            ? (isoRows.find(r=>r.id===picked)?.proof || "")
            : "Click any row for what backs it. Hollow rows are deliberately not green: nothing writes that value yet, and a checkpoint painted as passing while unmeasured is the false all-clear this panel exists to prevent."}
        </div>
      </div>
    </div>
  );
}

// ── Founders panel (/founders) ───────────────────────────────────────────────
// JC and Josh fund a third of the bill each, so they get to see what they are
// paying for. This is the Verification tab and nothing else: making them admins
// would hand over dealer records, the review queue, credit grants and the
// free-check breaker, none of which is theirs to touch.
//
// READ-ONLY BY CONSTRUCTION, at both ends. The UI hides Vic-only controls, and
// the database refuses them anyway — fn_can_read_costs() lets founders read,
// while every write still gates on fn_is_admin() (20260815_founder_access.sql
// asserts that rather than assuming it). Hiding a button is a courtesy; the
// grant is the control.
//
// Reuses AdminLogin and the admin theme so it is the same product, not a
// separate-looking thing they have to learn.
function FoundersPanel(){
  const [session,setSession]=useState(null);
  const [checkingSession,setCheckingSession]=useState(true);
  const [allowed,setAllowed]=useState(null);   // null = still checking
  const themeState=useThemeState();
  const {C}=themeState;
  const {usage:apiUsage, usageLoading:apiUsageLoading}=useApiUsage();

  useEffect(()=>{
    let active=true;
    supabase.auth.getSession().then(({data})=>{
      if(!active) return;
      setSession(data.session||null);
      setCheckingSession(false);
    });
    const {data:sub}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s||null));
    return()=>{ active=false; sub.subscription.unsubscribe(); };
  },[]);

  // Ask the database, not the email string. A founder is whoever has an active
  // row in `founder` — the same source the split and the statement use — so
  // access can never drift from who is actually being billed.
  useEffect(()=>{
    if(!session){ setAllowed(null); return; }
    let active=true;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_is_founder");
        if(error) throw error;
        if(active) setAllowed(!!data);
      }catch(err){
        console.warn("founder check failed:",err?.message||err);
        if(active) setAllowed(false);
      }
    })();
    return()=>{active=false;};
  },[session]);

  const shell=(inner)=>(
    <AdminThemeContext.Provider value={themeState}>
      <div style={{minHeight:"100dvh",background:C.paper,color:C.ink,padding:"24px",fontSize:15,
                   fontFamily:"'Poppins',Helvetica,Arial,sans-serif"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                     flexWrap:"wrap",gap:12,maxWidth:1100,margin:"0 auto 20px"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <LogoMark size={32}/>
            <div>
              <div style={{fontWeight:800,fontSize:18,color:C.ink}}>
                LotCheck<sup style={{fontSize:"0.45em",fontWeight:700,marginLeft:2}}>™</sup> Founders
              </div>
              <div style={{fontSize:12,color:C.inkFaint}}>What the three of us are paying for</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <ThemeToggle/>
            {session && (
              <button onClick={()=>supabase.auth.signOut()} style={{background:C.card,
                border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 14px",color:C.inkSoft,
                fontSize:13.5,cursor:"pointer",fontFamily:"inherit"}}>Sign out</button>
            )}
          </div>
        </div>
        <div style={{maxWidth:1100,margin:"0 auto"}}>{inner}</div>
      </div>
    </AdminThemeContext.Provider>
  );

  if(checkingSession) return shell(<div style={{color:C.inkFaint}}>Loading…</div>);
  if(!session) return <AdminLogin/>;
  if(allowed===null) return shell(<div style={{color:C.inkFaint}}>Checking access…</div>);

  if(!allowed) return shell(
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"20px 22px"}}>
      <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:6}}>Not a founder account</div>
      <div style={{fontSize:13.5,color:C.inkSoft,lineHeight:1.65}}>
        This page is limited to the accounts that fund LotCheck's operating cost. If that should include
        you, ask Vic to add your address to the founder list — access follows the same list the monthly
        split is calculated from, so it cannot drift from who is actually being billed.
      </div>
    </div>
  );

  return shell(<VerificationTab apiUsage={apiUsage} apiUsageLoading={apiUsageLoading} readOnly/>);
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

  // Unit Economics: one admin-gated RPC snapshot of aggregate-only figures.
  const [econ,setEcon]=useState(null);
  const [econLoading,setEconLoading]=useState(true);
  const [econError,setEconError]=useState(null);

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
        const {data,error}=await supabase.from("page_views").select("created_at, visitor_id, referrer_source, city, country, latitude, longitude, device").order("created_at",{ascending:true}).limit(50000);
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

  async function fetchEcon(){
    setEconLoading(true); setEconError(null);
    try{
      const {data,error}=await supabase.rpc("fn_admin_economics");
      if(error) throw error;
      setEcon(data||null);
    }catch(err){
      console.warn("⚠️ fn_admin_economics failed (did you run 20260730_admin_economics.sql, and is your login in admin_config.admin_emails?):",err.message);
      setEcon(null);
      setEconError(err.message||"Couldn't load economics.");
    }finally{
      setEconLoading(false);
    }
  }
  useEffect(()=>{ if(session) fetchEcon(); else { setEcon(null); setEconError(null); } },[session]);

  // Live-adjust the anonymous free-check daily cap via the admin-gated update
  // RPC, then re-pull the snapshot so the breaker card reflects the new limit.
  async function setFreeCap(value){
    const {data,error}=await supabase.rpc("fn_admin_set_free_checks_per_day",{p_value:Math.round(Number(value)||0)});
    if(error){ alert("Couldn't update the free-check cap: "+error.message); return null; }
    await fetchEcon();
    return data;
  }

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
  // Device / OS breakdown (iPhone vs Android vs Desktop) — captured server-side
  // in /api/track-visit from the User-Agent. Rows before this shipped have no
  // device, shown as "Unknown (before tracking)".
  const trafficDevices={};
  pageViews.forEach(v=>{ const d=v.device||"Unknown (before tracking)"; trafficDevices[d]=(trafficDevices[d]||0)+1; });
  const sortedDevices=Object.entries(trafficDevices).sort((a,b)=>b[1]-a[1]);

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
    <div style={{minHeight:"100dvh",background:C.paper,color:C.ink,padding:"24px",fontSize:15,
                 fontFamily:"'Poppins',Helvetica,Arial,sans-serif"}}>
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
          <AdminTabButton active={tab==="review"} onClick={()=>setTab("review")}>Review</AdminTabButton>
          <AdminTabButton active={tab==="revenue"} onClick={()=>setTab("revenue")}>Revenue</AdminTabButton>
          <AdminTabButton active={tab==="profit"} onClick={()=>setTab("profit")}>Profit</AdminTabButton>
          <AdminTabButton active={tab==="economics"} onClick={()=>setTab("economics")}>Unit Economics</AdminTabButton>
          <AdminTabButton active={tab==="gifts"} onClick={()=>setTab("gifts")}>Give a Check</AdminTabButton>
          <AdminTabButton active={tab==="alerts"} onClick={()=>setTab("alerts")}>MSRP Alerts</AdminTabButton>
          <AdminTabButton active={tab==="verification"} onClick={()=>setTab("verification")}>Verification</AdminTabButton>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <ThemeToggle/>
          <button onClick={()=>supabase.auth.signOut()} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 14px",color:C.inkSoft,fontSize:14.5,cursor:"pointer"}}>Sign out</button>
        </div>
      </div>

      <div style={{maxWidth:1100,margin:"0 auto"}}>
        {tab==="overview" && (<>
          <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>
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
                    <div style={{fontSize:13.5,color:C.inkFaint,marginBottom:6}}>{label}</div>
                    <div style={{fontSize:22,fontWeight:800,color:C.ink}}>{stats.visitors.toLocaleString()}</div>
                    <div style={{fontSize:13,color:C.inkFaint}}>unique visitor{stats.visitors===1?"":"s"} · {stats.views.toLocaleString()} view{stats.views===1?"":"s"}</div>
                  </div>
                ))}
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft}}>Visits over time</div>
                  <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                    {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                      <button key={key} onClick={()=>setTrafficGranularity(key)}
                        style={{background:trafficGranularity===key?C.tealBg:"transparent",color:trafficGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:13.5,fontWeight:700,cursor:"pointer"}}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedTraffic} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:12,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:13,fill:C.inkFaint}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v,name)=>[v,name==="views"?"Views":name]}
                        contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:13.5,fontWeight:700,color:"#fff"}}
                        labelStyle={{color:"#D9DBEF",fontSize:13}}
                      />
                      <Bar dataKey="views" radius={[3,3,0,0]}>
                        {bucketedTraffic.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.views>=bucketedTraffic[i-1].views?C.teal:C.butter}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:13,color:C.inkFaint}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.teal,marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.butter,marginRight:5}}/>Down from previous period</span>
                </div>
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
                <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft,marginBottom:12}}>Where visits come from</div>
                {sortedSources.every(([src])=>src==="Unknown (recorded before tracking)")?(
                  <div style={{color:C.inkFaint,fontSize:14.5,lineHeight:1.6}}>
                    Source tracking just went live — every visit before this update was recorded without it, so there's nothing real to show yet. This will fill in from here forward.
                  </div>
                ):(
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {sortedSources.map(([src,count])=>{
                      const pct=Math.round((count/pageViews.length)*100);
                      return(
                        <div key={src}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:13.5,marginBottom:3}}>
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
                <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft,marginBottom:12}}>What visitors are on</div>
                {sortedDevices.every(([d])=>d==="Unknown (before tracking)")?(
                  <div style={{color:C.inkFaint,fontSize:14.5,lineHeight:1.6}}>
                    Device tracking just went live — iPhone / Android / Desktop will fill in from here forward.
                  </div>
                ):(
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {sortedDevices.map(([d,count])=>{
                      const pct=Math.round((count/pageViews.length)*100);
                      return(
                        <div key={d}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:13.5,marginBottom:3}}>
                            <span style={{color:C.ink,fontWeight:700}}>{d==="iOS"?"iPhone / iPad (iOS)":d}</span>
                            <span style={{color:C.inkFaint}}>{count.toLocaleString()} · {pct}%</span>
                          </div>
                          <div style={{background:C.paper2,borderRadius:4,height:6,overflow:"hidden"}}>
                            <div style={{width:`${pct}%`,height:"100%",background:d==="iOS"?C.teal:d==="Android"?C.butterInk:d==="Desktop"?C.ink:C.inkFaint}}/>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
                <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft,marginBottom:12}}>Where visitors are located</div>
                <VisitorMap pageViews={pageViews}/>
              </div>
            </>
          )}

          <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10}}>LISTINGS · {listingsLoading?"loading…":`${liveListings.length} live`}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:16}}>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{liveListings.length}</div>
              <div style={{fontSize:13.5,color:C.inkFaint}}>Total live listings</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.tealInk}}>{evapCount}</div>
              <div style={{fontSize:13.5,color:C.inkFaint}}>EVAP-eligible (new, verified)</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{Object.keys(byProvince).length}</div>
              <div style={{fontSize:13.5,color:C.inkFaint}}>Provinces covered</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{reportLeads.length}</div>
              <div style={{fontSize:13.5,color:C.inkFaint}}>Report emails captured</div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:"16px"}}>
              <div style={{fontSize:26,fontWeight:800,color:C.ink}}>{avgDaysOnMarket==null?"—":`${avgDaysOnMarket}d`}</div>
              <div style={{fontSize:13.5,color:C.inkFaint}}>Avg. days on market</div>
            </div>
          </div>

          <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px",marginBottom:28}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:14.5,fontWeight:800,color:C.inkSoft}}>New listings tracked over time</div>
              <div style={{display:"flex",gap:4,background:C.paper,border:`1px solid ${C.line}`,borderRadius:8,padding:3}}>
                {[["hour","1H"],["day","Day"],["week","Week"],["month","Month"]].map(([key,label])=>(
                  <button key={key} onClick={()=>setListingsGranularity(key)}
                    style={{background:listingsGranularity===key?C.tealBg:"transparent",color:listingsGranularity===key?C.tealInk:C.inkFaint,border:"none",borderRadius:6,padding:"5px 12px",fontSize:13.5,fontWeight:700,cursor:"pointer"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {firstSeenTimestamps.length===0?(
              <div style={{color:C.inkFaint,fontSize:14.5,textAlign:"center",padding:"20px 0"}}>No listing history recorded yet.</div>
            ):(
              <>
                <div style={{height:180}}>
                  <ResponsiveContainer>
                    <BarChart data={bucketedListings} margin={{top:4,right:4,bottom:0,left:0}}>
                      <XAxis dataKey="label" tick={{fontSize:12,fill:C.inkFaint}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                      <YAxis tick={{fontSize:13,fill:C.inkFaint}} tickLine={false} axisLine={false} width={30} allowDecimals={false}/>
                      <Tooltip
                        formatter={(v)=>[v,"New listings"]}
                        contentStyle={{background:C.ink,border:"none",borderRadius:8,fontSize:13.5,fontWeight:700,color:"#fff"}}
                        labelStyle={{color:"#D9DBEF",fontSize:13}}
                      />
                      <Bar dataKey="count" radius={[3,3,0,0]}>
                        {bucketedListings.map((entry,i)=>(
                          <Cell key={i} fill={i===0||entry.count>=bucketedListings[i-1].count?C.teal:C.butter}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"flex",gap:16,marginTop:8,fontSize:13,color:C.inkFaint}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.teal,marginRight:5}}/>Up from previous period</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:C.butter,marginRight:5}}/>Down from previous period</span>
                </div>
              </>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:28}}>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:13.5,fontWeight:800,color:C.inkSoft,marginBottom:10}}>By province</div>
              {Object.entries(byProvince).sort((a,b)=>b[1]-a[1]).map(([p,c])=>(
                <div key={p} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.line}`,fontSize:14.5}}>
                  <span style={{color:C.inkSoft}}>{p}</span><span style={{fontWeight:800,color:C.ink}}>{c}</span>
                </div>
              ))}
            </div>
            <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"16px"}}>
              <div style={{fontSize:13.5,fontWeight:800,color:C.inkSoft,marginBottom:10}}>By fuel type</div>
              {Object.entries(byFuel).sort((a,b)=>b[1]-a[1]).map(([f,c])=>(
                <div key={f} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${C.line}`,fontSize:14.5}}>
                  <span style={{color:C.inkSoft}}>{f}</span><span style={{fontWeight:800,color:C.ink}}>{c}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{fontSize:14.5,fontWeight:800,color:C.inkFaint,letterSpacing:1,marginBottom:10,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
            <span>REPORT EMAILS · {reportLeadsLoading?"loading…":`${reportLeads.length} total`}</span>
            {!reportLeadsLoading&&reportLeads.length>0&&(
              <button onClick={exportReportLeadsCsv}
                style={{fontSize:13,fontWeight:700,letterSpacing:0,padding:"5px 12px",borderRadius:6,cursor:"pointer",background:"transparent",border:`1px solid ${C.line}`,color:C.inkSoft}}>
                Export CSV
              </button>
            )}
          </div>
          {reportLeadsLoading?(
            <div style={{color:C.inkFaint,fontSize:14.5}}>Loading report emails…</div>
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
                    {l.source&&<div style={{fontSize:13.5,color:C.inkFaint,marginTop:2}}>Re: {l.source}</div>}
                  </div>
                  <div style={{fontSize:13,color:C.inkFaint}}>{new Date(l.created_at).toLocaleString("en-CA")}</div>
                </div>
              ))}
            </div>
          )}
        </>)}

        {tab==="review" && (
          <ReviewTab
            reviewListings={reviewListings} reviewLoading={reviewLoading}
            rejectedListings={rejectedListings}
            onApprove={approveReview} onReject={rejectReview}
          />
        )}

        {tab==="revenue" && <RevenueTab dealers={dealers} apiUsage={apiUsage} apiUsageLoading={apiUsageLoading}/>}
        {tab==="profit" && <ProfitTrackerTab/>}
        {tab==="economics" && <UnitEconomicsTab econ={econ} econLoading={econLoading} econError={econError} apiUsage={apiUsage} apiUsageLoading={apiUsageLoading} onSetCap={setFreeCap} onRefresh={fetchEcon}/>}
        {tab==="gifts" && <GiveCheckTab/>}
        {tab==="alerts" && <AlertFoldersTab/>}
        {tab==="verification" && <VerificationTab apiUsage={apiUsage} apiUsageLoading={apiUsageLoading}/>}
      </div>
    </div>
    </AdminThemeContext.Provider>
  );
}

// "Orbital Halo" -- the upload-zone idle teaser AND the full-screen scan
// takeover's centerpiece (one consistent visual instead of two different
// ring styles): three dashed elliptical rings, each carrying a glowing
// satellite dot riding its edge, around a document glyph. speed="active"
// (used while a scan is actually running) halves each ring's rotation
// duration for a faster, more urgent feel than the idle resting state.
// The outer ring doubles as a real progress arc (strokeDashoffset driven by
// `progress`, 0..1) -- at rest progress is 0, so only the faint track shows;
// during a scan it's the one place this visual reports actual completion
// rather than just implying "work is happening."
function OrbitalHaloVisual({C, progress=0, speed="idle"}){
  const f=speed==="active"?0.5:1; // active = twice as fast
  const R=100, CIRC=2*Math.PI*R;
  const offset=CIRC*(1-Math.max(0,Math.min(1,progress)));
  const rings=[
    {rx:86, ry:36, color:C.teal,   dur:6*f,   rev:false, dotAngle:0},
    {rx:64, ry:27, color:"#7c6cf0",dur:4.5*f, rev:true,  dotAngle:140},
    {rx:42, ry:18, color:C.teal,   dur:3.2*f, rev:false, dotAngle:250},
  ];
  return (
    <div className="lc-orbital" style={{position:"relative",width:220,height:220,margin:"0 auto"}}>
      <style>{`
        @keyframes lcOrbitalSpin { to { transform: rotate(360deg); } }
        @keyframes lcOrbitalSpinRev { to { transform: rotate(-360deg); } }
        .lc-orbital svg.lco-ring { position:absolute; inset:0; width:220px; height:220px; fill:none; transform-origin:center; }
        @media (prefers-reduced-motion: reduce) { .lc-orbital svg.lco-ring { animation:none !important; } }
      `}</style>
      {rings.map((r,i)=>{
        const rad=(r.dotAngle*Math.PI)/180;
        const dx=110+Math.cos(rad)*r.rx, dy=110+Math.sin(rad)*r.ry;
        return (
          <svg key={i} className="lco-ring" viewBox="0 0 220 220"
            style={{animation:`${r.rev?"lcOrbitalSpinRev":"lcOrbitalSpin"} ${r.dur}s linear infinite`}}>
            <ellipse cx="110" cy="110" rx={r.rx} ry={r.ry} stroke={r.color} strokeWidth="1.4" strokeDasharray="3 8" opacity=".55"/>
            <circle cx={dx} cy={dy} r="3" fill={r.color} style={{filter:`drop-shadow(0 0 4px ${r.color})`}}/>
          </svg>
        );
      })}
      <svg className="lco-ring" viewBox="0 0 220 220">
        <circle cx="110" cy="110" r={R} stroke={C.line} strokeWidth="3" fill="none"/>
        <circle cx="110" cy="110" r={R} stroke={C.teal} strokeWidth="3" fill="none" strokeLinecap="round"
          transform="rotate(-90 110 110)" strokeDasharray={CIRC} strokeDashoffset={offset}
          style={{transition:"stroke-dashoffset .3s ease",filter:`drop-shadow(0 0 5px ${C.teal})`}}/>
      </svg>
      <svg className="lco-ring" viewBox="0 0 220 220" style={{animation:"none"}}>
        <rect x="88" y="80" width="44" height="60" rx="7" fill="#f7f4ea"/>
        <rect x="96" y="92" width="28" height="4" rx="2" fill="#d9d4c2"/>
        <rect x="96" y="102" width="20" height="4" rx="2" fill="#d9d4c2"/>
        <rect x="96" y="112" width="28" height="4" rx="2" fill={C.teal}/>
        <rect x="96" y="122" width="16" height="4" rx="2" fill="#d9d4c2"/>
      </svg>
    </div>
  );
}

// Full-screen scan takeover -- replaces the old inline "analyzing" card.
// Reuses the same .lc-modal-overlay used by SignInModal/QuotePaywallModal, so
// it matches their exact backdrop/positioning (centered on desktop, bottom
// sheet on mobile) instead of inventing new modal chrome. `progress` is a
// genuine elapsed-time curve (not a hardcoded animation) because a URL scan
// is ~30-60s and a file scan ~5-25s -- it eases toward 92% over `estimate`
// seconds and holds there for however long the real fetch actually takes, so
// it never lies by finishing before the backend responds. phase="success" is
// a brief (900ms, see QuoteCheckPage) closing beat once the real result has
// actually landed -- never shown on an error, since that would be dishonest.
function ScanTakeover({C, cardStyle, phase, attemptType, fileName, stageText}){
  const estimate=attemptType==="url"?45:15;
  const [elapsed,setElapsed]=useState(0);

  useEffect(()=>{
    if(phase!=="running") return;
    const t0=Date.now();
    const id=setInterval(()=>{ setElapsed((Date.now()-t0)/1000); },250);
    return ()=>clearInterval(id);
  },[phase]);

  const progress=phase==="success"?1:Math.min(0.92,1-Math.exp(-elapsed/estimate));
  const remaining=Math.max(0,Math.round(estimate-elapsed));

  return (
    <div className="lc-modal-overlay">
      <div style={{...cardStyle,width:"100%",maxWidth:400,margin:16,marginBottom:16,textAlign:"center",padding:"36px 28px 30px",boxShadow:C.cardShadow}}>
        <OrbitalHaloVisual C={C} progress={progress} speed="active"/>
        {phase==="success"?(
          <>
            <div style={{width:52,height:52,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
              margin:"16px auto 14px",background:C.tealBg,border:`1.5px solid ${C.teal}`,color:C.tealInk,fontSize:24}}>✓</div>
            <div style={{color:C.ink,fontWeight:1000,fontSize:17,marginBottom:6}}>
              {attemptType==="file"?"Document successfully scanned":"URL successfully scanned"}
            </div>
            <div style={{color:C.inkFaint,fontSize:12.5}}>{fileName}</div>
          </>
        ):(
          <>
            <div style={{color:C.ink,fontWeight:1000,marginTop:16,marginBottom:6}}>
              {attemptType==="url"?`Scanning ${fileName}…`:`Reading ${fileName}…`}
            </div>
            <div style={{color:C.inkFaint,fontSize:13,marginBottom:10,minHeight:18,transition:"opacity .2s"}}>{stageText}</div>
            <div style={{display:"flex",justifyContent:"center",gap:8,fontSize:13,color:C.tealInk,fontVariantNumeric:"tabular-nums"}}>
              <span>{Math.round(progress*100)}%</span>
              <span style={{color:C.inkFaint}}>·</span>
              <span style={{color:C.inkFaint}}>{remaining>0?`~${remaining}s left`:"Almost there…"}</span>
            </div>
            {attemptType==="url"&&(
              <div style={{color:C.inkFaint,fontSize:11,marginTop:12,opacity:.75}}>Reading a live dealer page can take up to a minute — hang tight.</div>
            )}
          </>
        )}
      </div>
    </div>
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

// Quote Check credits are enforced server-side (Phase 3): 1 anonymous free
// check per device, then sign-in; signed-in checks draw on server-authoritative
// personal credits, with an HTTP 402 {error:"out_of_credits"} opening the paywall.

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

// ── Financing breakdown ───────────────────────────────────────────────────
// Pure amortization off the quoted price. Nothing here is fetched from a
// catalog or guessed from a model: given a price, an APR the buyer sets, a
// down payment, a term and a payment frequency, the periodic payment is
// deterministic and always correct. The only external rate anchors shown are
// ones that are actually real -- the rate the quote itself disclosed, any
// manufacturer rate the backend already resolved (finance_rate_catalog), and
// the Bank of Canada policy rate fetched LIVE from the BoC Valet API (dated,
// with a source link). No illustrative payment is ever labelled a firm offer.
const FIN_DOWN = [0, 5000, 10000, 15000, 20000];
const FIN_TERMS = [24, 36, 48, 60, 72, 84];
const FIN_FREQS = [
  { key: "monthly",  label: "Monthly",   per: 12 },
  { key: "biweekly", label: "Bi-weekly", per: 26 },
  { key: "weekly",   label: "Weekly",    per: 52 },
];

// Standard amortized payment. principal in $, annualPct in %, per = periods/yr.
// i===0 (0% promo) collapses to straight-line principal / n.
function amortPayment(principal, annualPct, per, termMonths){
  if(!(principal > 0)) return 0;
  const n = Math.round((termMonths / 12) * per);
  if(!n) return 0;
  const i = (Number(annualPct) || 0) / 100 / per;
  if(i === 0) return principal / n;
  return principal * i / (1 - Math.pow(1 + i, -n));
}

// Traffic-light banding (ported from financing-examples-15.html):
//   green  if apr <= benchmark + 0.25
//   amber  if apr <= benchmark + 2
//   red    beyond
// Benchmark is the manufacturer APR (new) or BoC+2.5 (used); when it can't be
// determined (no manufacturer rate on a new car / BoC not loaded on a used
// car) we return null = neutral, so no green/amber/red claim is fabricated.
function bandOf(apr, benchmark){
  if(benchmark == null || !Number.isFinite(apr)) return null;
  if(apr <= benchmark + 0.25) return "g";
  if(apr <= benchmark + 2)    return "a";
  return "r";
}
// Heatmap tertiles over a 0..1 relative-interest position. Greener = cheaper.
function heatOf(t){ return t < 0.34 ? "g" : (t < 0.67 ? "a" : "r"); }

function FinancingBreakdown({ analysis, C, cardStyle }){
  // ── Price-verification gate ──────────────────────────────────────────────
  // The financing math is only as trustworthy as the price it runs on. A
  // listing whose real price we couldn't extract must NEVER present MSRP-based
  // payments as if they were the listing's actual payments -- a confidently-
  // wrong payment number is a trust failure. We therefore track the price's
  // SOURCE and render differently for each:
  //   'listing' -> analysis.quotedPrice is a verified listing price. Normal.
  //   'msrp'    -> only an MSRP is known. ESTIMATE MODE: a loud warning, the
  //                hero relabelled "from MSRP", never the word "listed", and an
  //                editable price so the buyer can enter the real number.
  //   'none'    -> no price at all. Prompt for one; don't render the matrix.
  // A price the USER types is treated as confirmed ('user'): it recomputes the
  // whole card and drops the warning, but is deliberately NOT written back to
  // analysis.quotedPrice, so the verified-only overprice-vs-MSRP flag (which
  // keys off analysis.quotedPrice) stays off for an unverified number.
  const quotedPrice = Number(analysis?.quotedPrice) || 0;
  const msrpVal = Number(analysis?.msrp) || 0;
  const baseSource = quotedPrice > 0 ? "listing" : msrpVal > 0 ? "msrp" : "none";
  const [priceStr, setPriceStr] = useState(baseSource === "msrp" ? String(msrpVal) : "");
  const [priceConfirmed, setPriceConfirmed] = useState(false);
  const enteredPrice = Number(priceStr) || 0;
  // Effective price + source that everything below renders from. A price the
  // user TYPES wins over everything — including a verified listing price — but
  // is always labelled "the price you entered", never "listed", and is never
  // written back to analysis.quotedPrice (price-verification gate).
  let priceSource, price;
  if (priceConfirmed && enteredPrice > 0) { priceSource = "user"; price = enteredPrice; }
  else if (baseSource === "listing") { priceSource = "listing"; price = quotedPrice; }
  else if (baseSource === "msrp") { priceSource = "msrp"; price = msrpVal; }
  else { priceSource = "none"; price = 0; }
  const disclosedRate = Number(analysis?.financing?.rate) || null;
  const mfr = analysis?.financeRates?.manufacturer || null;
  const mfrRate = mfr?.apr != null ? Number(mfr.apr) : null;
  const dealerRate = analysis?.financeRates?.dealer?.apr != null
    ? Number(analysis.financeRates.dealer.apr)
    : (disclosedRate || null);
  const lease = analysis?.leaseRates?.manufacturer || null;
  const leaseRate = lease?.apr != null ? Number(lease.apr) : null;
  const leaseKm = lease?.annualKm || null;
  const leaseTerm = lease?.termMonths || null;
  const disclosedTerm = Number(analysis?.financing?.termMonths) || null;
  const disclosedFreq = analysis?.financing?.paymentFrequency || null;
  // New-vs-used: main keys new/used on analysis.vehicleCondition==="new". A
  // manufacturer advertised/promo rate is a NEW-vehicle offer, so on a used
  // vehicle it's a labelled reference, never this car's applicable rate.
  const isNew = analysis?.vehicleCondition === "new";
  // How far THIS dealer's disclosed APR sits above the manufacturer's
  // advertised rate (only meaningful when both exist) -- drives the markup
  // warning below, same threshold/math as main's "Financing examples" card.
  const spread = (dealerRate != null && mfrRate != null) ? (dealerRate - mfrRate) : null;
  // Freshness of the manufacturer rate data (finance_rate_catalog /
  // lease_rate_catalog effective_date). Refreshed daily by the rates job.
  const fmtDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s||"")); const MO=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return m ? `${MO[+m[2]-1]} ${+m[3]}, ${m[1]}` : s; };
  const ratesAsOf = [mfr?.effectiveDate, lease?.effectiveDate].filter(Boolean).sort().pop() || null;

  // The quote's term/down anchor the hero payment and the highlighted grid
  // cell. analysis carries no disclosed down-payment, so the quote row is $0.
  const quoteTerm = FIN_TERMS.includes(disclosedTerm) ? disclosedTerm : 60;
  const quoteDown = 0;

  const reduceMotion = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion:reduce)").matches : false;

  const defaultRate = dealerRate || mfrRate || 6.99;
  const rateIsReal = dealerRate != null || mfrRate != null;
  const [aprStr, setApr] = useState(String(defaultRate));
  const apr = Number(aprStr);
  const aprValid = Number.isFinite(apr) && apr >= 0 && apr < 40;
  const [freqKey, setFreqKey] = useState(
    FIN_FREQS.some(f => f.key === disclosedFreq) ? disclosedFreq : "monthly"
  );
  const freq = FIN_FREQS.find(f => f.key === freqKey) || FIN_FREQS[0];

  // Bank of Canada policy rate -- live, dated, real. null=loading,
  // "error"=fetch failed (fall back to a source link).
  const [boc, setBoc] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch("https://www.bankofcanada.ca/valet/observations/V39079/json?recent=1")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        const o = d?.observations?.[0];
        const rate = o?.V39079?.v;
        if(alive && rate) setBoc({ rate: Number(rate), date: o.d });
        else if(alive) setBoc("error");
      })
      .catch(() => { if(alive) setBoc("error"); });
    return () => { alive = false; };
  }, []);

  // User-typed down payment / term. Blank = the quote's own anchors; a valid
  // typed value re-anchors the hero payment (and the grid highlight) to it.
  const [downStr, setDownStr] = useState("");
  const [termStr, setTermStr] = useState("");
  const customDown = downStr !== "" && Number.isFinite(Number(downStr)) && Number(downStr) >= 0 ? Number(downStr) : null;
  const customTerm = termStr !== "" && Number.isFinite(Number(termStr)) && Number(termStr) >= 12 && Number(termStr) <= 120 ? Math.round(Number(termStr)) : null;
  const heroDown = customDown != null ? Math.min(customDown, Math.max(0, price)) : quoteDown;
  const heroTerm = customTerm != null ? customTerm : quoteTerm;

  // Hero payment (selected term/down, current rate & frequency) with a
  // reduced-motion-safe count-up.
  const Pq = Math.max(0, price - heroDown);
  const heroPay = aprValid ? amortPayment(Pq, apr, freq.per, heroTerm) : 0;
  const [shownPay, setShownPay] = useState(heroPay);
  const prevPayRef = useRef(heroPay);
  useEffect(() => {
    if(reduceMotion){ setShownPay(heroPay); prevPayRef.current = heroPay; return; }
    let raf, t0 = null; const from = prevPayRef.current;
    const step = ts => {
      t0 = t0 || ts; const k = Math.min(1, (ts - t0) / 480); const e = 1 - Math.pow(1 - k, 3);
      setShownPay(from + (heroPay - from) * e);
      if(k < 1) raf = requestAnimationFrame(step); else prevPayRef.current = heroPay;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [heroPay, reduceMotion]);

  // Card entrance fade-in + subtle pointer tilt (both reduced-motion-safe).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [tilt, setTilt] = useState("");
  // Progressive disclosure: the payment + rate comparison + key markup warning
  // stay visible (the collapsed summary); the full down-payment x term matrix,
  // "what we'd do", lease detail, and disclosures live behind this toggle.
  // Default collapsed; the expand animation is skipped under reduced-motion.
  const [expanded, setExpanded] = useState(false);
  const onTilt = e => {
    if(reduceMotion) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
    setTilt(`rotateY(${(px * 2.4).toFixed(2)}deg) rotateX(${(-py * 2.4).toFixed(2)}deg)`);
  };
  const clearTilt = () => setTilt("");

  // No early null-return on a missing price anymore: 'none' mode renders a
  // price prompt (below) instead of silently disappearing.

  const money = n => `$${Math.round(n).toLocaleString("en-CA")}`;
  const downs = FIN_DOWN.filter(d => d < price);

  // Traffic-light triad mapped to the theme-aware brand palette so it reads on
  // the report's light / dark / outdoor themes (green->teal, amber->butter,
  // red->coral -- the app's established good/caution/bad coding). Blue
  // (#3b82f6, already used elsewhere in the app) is reserved for interactive
  // accents only: the active frequency toggle and the quote-cell outline.
  const TL = {
    g: { fg:C.tealInk,   bg:C.tealBg,   bd:C.teal   },
    a: { fg:C.butterInk, bg:C.butterBg, bd:C.butter },
    r: { fg:C.coralInk,  bg:C.coralBg,  bd:C.coral  },
  };
  const BLUE = "#3b82f6";
  const bandLabel = b => b === "g" ? "Good rate" : b === "a" ? "Average rate" : b === "r" ? "High rate" : "Rate";
  const freqSuffix = { monthly:"/mo", biweekly:"/2wk", weekly:"/wk" }[freq.key] || "/mo";

  // Benchmark for the dealer/hero band: the manufacturer APR (new) or BoC+2.5
  // (used). null when it can't be determined -> neutral, never fabricated.
  const bocRate = (boc && boc !== "error") ? boc.rate : null;
  const benchmark = isNew ? mfrRate : (bocRate != null ? bocRate + 2.5 : null);
  const heroBand = aprValid ? bandOf(apr, benchmark) : null;
  const heroTL = heroBand ? TL[heroBand] : null;
  const dealerBand = dealerRate != null ? bandOf(dealerRate, benchmark) : null;
  const dealerTL = dealerBand ? TL[dealerBand] : null;

  // LEASE (Phase 1 -- rates only, no lease payment figures; those need
  // residual/advertised-payment data we don't yet capture). analysis exposes
  // only leaseRates.manufacturer (the advertised/manufacturer lease APR) --
  // there is NO dealer/listing-stated lease APR (no leaseRates.dealer analog
  // of financeRates.dealer), so the lease view is one-sided. The read below is
  // forward-compatible: if a leaseRates.dealer ever appears, the two-sided
  // comparison renders automatically.
  const leaseDealerRate = analysis?.leaseRates?.dealer?.apr != null ? Number(analysis.leaseRates.dealer.apr) : null;
  const leaseTwoSided = leaseDealerRate != null && leaseRate != null;
  // Band benchmark: the manufacturer lease APR when we're banding a *separate*
  // dealer lease rate against it (two-sided); otherwise BoC+2.5 (same external
  // benchmark the finance used-vehicle path uses) so a single advertised lease
  // rate still gets a real green/amber/red reading rather than being compared
  // to itself. null -> neutral, never fabricated.
  const leaseBenchmark = leaseTwoSided ? leaseRate : (bocRate != null ? bocRate + 2.5 : null);
  const leaseRateToBand = leaseTwoSided ? leaseDealerRate : leaseRate;
  // On a USED vehicle a manufacturer lease is a NEW-car promo -> reference
  // only, not this car's applicable rate (mirrors the finance guard), so no
  // applicable band is presented in that case.
  const leaseApplicable = isNew || leaseTwoSided;
  const leaseBand = (leaseApplicable && leaseRateToBand != null) ? bandOf(leaseRateToBand, leaseBenchmark) : null;
  const leaseTL = leaseBand ? TL[leaseBand] : null;
  const leaseSpread = leaseTwoSided ? (leaseDealerRate - leaseRate) : null;

  // Phase-2 lease PAYMENT. Two mutually-exclusive catalog shapes:
  //  - manufacturer.payment (source 'advertised'): a FIXED advertised example
  //    for the scraped dealer's own vehicle -- shown as a reference, NEVER
  //    recomputed for the user.
  //  - manufacturer.lease (source 'computed'): residual %, apr, term -> the
  //    payment is computed HERE on the USER's own price/msrp.
  const leaseAdvertised = lease?.payment?.source === "advertised" ? lease.payment : null;
  const leaseComputed = lease?.lease?.source === "computed" ? lease.lease : null;
  const userMsrp = Number(analysis?.msrp) || null;
  // Residual-based monthly lease payment for the USER's vehicle (validated
  // formula, within ~1.65% of a real advertised payment). residualValue =
  // residualPct x the USER's msrp; capCost = the USER's price minus the down
  // ($0-down here, matching the hero, so capCost = price). The catalog's
  // scraped cap_cost/down_payment/selling_price are deliberately NOT used.
  // No msrp -> no computed payment (a residual can't be honestly derived).
  let leaseComputedPayment = null;
  if (leaseApplicable && leaseComputed && userMsrp) {
    const lterm = leaseComputed.term || leaseTerm || 48;
    const residualValue = leaseComputed.residualPct * userMsrp;
    const capCost = Math.max(0, price - quoteDown);
    const depreciation = (capCost - residualValue) / lterm;
    const rent = (capCost + residualValue) * (leaseComputed.apr / 2400);
    const amount = depreciation + rent;
    if (amount > 0 && Number.isFinite(amount)) {
      leaseComputedPayment = { amount, term: lterm, annualKm: leaseComputed.annualKm ?? leaseKm, residualPct: leaseComputed.residualPct, apr: leaseComputed.apr };
    }
  }

  // Recommendation ("What we'd do") -- tailored bullets, ported from the
  // reference design's logic and wired to the resolved rates.
  const monthlyPay = a => amortPayment(Pq, a, 12, quoteTerm);
  const mpQt = aprValid ? monthlyPay(apr) : 0;
  const mpShorter = aprValid ? amortPayment(Pq, apr, 12, Math.max(24, quoteTerm > 36 ? quoteTerm - 12 : 24)) : 0;
  const shorter = quoteTerm > 36 ? quoteTerm - 12 : 24;
  const intNow = mpQt > 0 ? mpQt * quoteTerm - Pq : 0;
  const dInt = intNow - (mpShorter * shorter - Pq);
  const dPayMo = mpShorter - mpQt;
  const bullets = [];
  let recHead = "What we'd do";
  if(aprValid){
    if(isNew && mfrRate != null && apr - mfrRate > 0.1){
      const dMfr = (mpQt - monthlyPay(mfrRate)) * quoteTerm;
      bullets.push(<><b>Ask for {analysis.make}'s {mfrRate}%.</b> The dealer's {apr}% costs ~{money(dMfr)} more over {quoteTerm} months.</>);
    } else if(isNew && mfrRate != null){
      recHead = "✓ This one looks fair";
      bullets.push(<><b>Dealer is offering the advertised rate</b> — no markup to negotiate.</>);
    } else if(!isNew){
      if(bocRate != null){
        const preRate = Math.max(bocRate + 1.5, mfrRate ?? 0);
        const dPre = (mpQt - monthlyPay(preRate)) * quoteTerm;
        bullets.push(<><b>Get pre-approved first.</b> {apr}% is {(apr - bocRate).toFixed(1)} pts over the Bank of Canada rate; ~{preRate.toFixed(1)}% would save ~{money(dPre)} over {quoteTerm} months.</>);
      } else {
        bullets.push(<><b>Get pre-approved before you sign.</b> Used-car APRs vary widely by lender and credit — a competing pre-approval is your leverage.</>);
      }
    }
    if(dInt > 150) bullets.push(<><b>A shorter term saves interest.</b> {quoteTerm} mo pays {money(intNow)} in interest; {shorter} mo is +{money(dPayMo)}/mo but −{money(dInt)} overall.</>);
    if(!isNew && mfrRate != null) bullets.push(<><b>{analysis.make}'s rate is a new-car promo</b> — it doesn't apply here; negotiate the number above.</>);
  }
  const recColor = heroTL ? heroTL.fg : C.inkSoft;

  // Heatmap grid: shade each cell green->amber->red by its total interest
  // relative to the min/max across the visible grid. Greener = cheaper.
  const cellData = downs.map(d => FIN_TERMS.map(t => {
    const P = price - d;
    const m = (aprValid && P > 0) ? amortPayment(P, apr, freq.per, t) : 0;
    const n = (t / 12) * freq.per;
    const interest = m > 0 ? m * n - P : 0;
    return { d, t, P, m, interest };
  }));
  const allInterest = cellData.flat().filter(c => c.P > 0).map(c => c.interest);
  const mn = allInterest.length ? Math.min(...allInterest) : 0;
  const mx = allInterest.length ? Math.max(...allInterest) : 0;

  const vehLine = [analysis?.year, analysis?.make, analysis?.model].filter(Boolean).join(" ");
  const heroReady = mounted || reduceMotion;

  // 'none' mode: no price at all -- never fabricate a payment matrix off
  // nothing. Prompt for the real price; entering it flips to user-confirmed
  // ('user' source) and the full breakdown renders on the next pass.
  if (priceSource === "none") {
    return (
      <div style={{...cardStyle}}>
        <div style={{fontSize:14,fontWeight:800,color:C.ink,display:"flex",alignItems:"center",gap:7}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2.5" stroke="currentColor" strokeWidth="2"/><path d="M2 9.5h20" stroke="currentColor" strokeWidth="2"/><path d="M6 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          Financing breakdown
        </div>
        {vehLine && <div style={{fontSize:12,color:C.inkFaint,marginTop:3}}>{vehLine}{analysis?.vehicleCondition?` · ${analysis.vehicleCondition}`:""}</div>}
        <div style={{fontSize:12.5,color:C.inkSoft,marginTop:10,lineHeight:1.55}}>
          We couldn't find this vehicle's price, so there's nothing to base a payment on yet. Enter the price to see your financing breakdown.
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,background:C.paper,border:`2px solid ${C.line}`,borderRadius:11,padding:"8px 12px"}}>
            <span style={{color:C.inkFaint,fontSize:15}}>$</span>
            <input type="number" inputMode="numeric" min="0" placeholder="e.g. 32,000" value={priceStr}
              onChange={e=>{setPriceStr(e.target.value);setPriceConfirmed(true);}}
              style={{width:120,background:"transparent",border:0,color:C.ink,fontSize:18,fontWeight:700,outline:"none"}}/>
          </div>
          <span style={{fontSize:12,color:C.inkFaint}}>The vehicle's price before tax.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ perspective: reduceMotion ? undefined : 1400 }} onMouseMove={onTilt} onMouseLeave={clearTilt}>
      <div style={{
        ...cardStyle,
        transform: tilt || undefined,
        transformStyle: "preserve-3d",
        opacity: heroReady ? 1 : 0,
        translate: heroReady ? "0 0" : "0 16px",
        transition: reduceMotion ? "none" : "transform .18s cubic-bezier(.16,1,.3,1), opacity .5s ease, translate .5s cubic-bezier(.16,1,.3,1)",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:14,fontWeight:800,color:C.ink,display:"flex",alignItems:"center",gap:7}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2.5" stroke="currentColor" strokeWidth="2"/><path d="M2 9.5h20" stroke="currentColor" strokeWidth="2"/><path d="M6 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          Financing breakdown
        </div>
            <div style={{fontSize:12,color:C.inkFaint,marginTop:3}}>
              {vehLine ? `${vehLine} · ` : ""}
              {priceSource === "msrp"
                ? <>estimated from the <b style={{color:C.inkSoft}}>{money(price)}</b> MSRP</>
                : priceSource === "user"
                ? <>based on the price you entered <b style={{color:C.inkSoft}}>{money(price)}</b></>
                : <>based on the listed price <b style={{color:C.inkSoft}}>{money(price)}</b></>}
              {analysis?.vehicleCondition ? ` · ${analysis.vehicleCondition}` : ""}
              {priceSource === "listing" && analysis?.quotedPriceSource === "sm360_feed" && (
                <span style={{color:C.tealInk,fontWeight:700}}> · verified from dealer listing</span>
              )}
            </div>
          </div>
        </div>

        {/* HERO: the payment leads, with the editable APR as the hero control.
            Glow + band pill are traffic-light coloured by how the rate compares
            to its benchmark (manufacturer when new, BoC+2.5 when used). */}
        <div style={{
          marginTop:14, borderRadius:16, padding:"16px 18px",
          display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, flexWrap:"wrap",
          background: heroTL ? heroTL.bg : C.paper2,
          border: `1px solid ${heroTL ? heroTL.bd : C.line}`,
          boxShadow: (heroTL && !reduceMotion) ? `0 0 34px -12px ${heroTL.bd}` : "none",
          transition: reduceMotion ? "none" : "box-shadow .4s ease, border-color .4s ease, background .4s ease",
        }}>
          <div>
            <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>{priceSource === "msrp" ? "Estimated payment (from MSRP)" : "Your estimated payment"}</div>
            <div style={{fontSize:40,fontWeight:800,letterSpacing:-1.5,lineHeight:1,marginTop:5,color:C.ink,fontVariantNumeric:"tabular-nums"}}>
              {aprValid ? money(shownPay) : "—"}<span style={{fontSize:14,color:C.inkFaint,fontWeight:600,letterSpacing:0}}>{aprValid ? freqSuffix : ""}</span>
            </div>
            <div style={{fontSize:12,color:C.inkFaint,marginTop:7}}>at {aprValid ? apr : "—"}% · {money(heroDown)} down · {heroTerm} months</div>
            {heroBand && (
              <div style={{display:"inline-block",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,marginTop:9,background:heroTL.bg,color:heroTL.fg}}>{bandLabel(heroBand)}</div>
            )}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:7,alignItems:"flex-end"}}>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:7,alignItems:"flex-end"}}>
                <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>Purchase price (edit)</div>
                <div style={{display:"flex",alignItems:"center",gap:6,background:C.paper,border:`2px solid ${C.line}`,borderRadius:11,padding:"6px 10px"}}>
                  <span style={{color:C.inkFaint,fontSize:14}}>$</span>
                  <input type="number" inputMode="numeric" min="0" value={priceConfirmed ? priceStr : (price ? String(Math.round(price)) : "")}
                    onChange={e => { setPriceStr(e.target.value); setPriceConfirmed(true); }}
                    style={{width:92,background:"transparent",border:0,color:C.ink,fontSize:19,fontWeight:700,textAlign:"right",outline:"none"}}/>
                </div>
                {priceSource === "user" && baseSource === "listing" && (
                  <button onClick={() => { setPriceConfirmed(false); setPriceStr(""); }}
                    style={{background:"none",border:0,padding:0,color:C.tealInk,fontSize:11,fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>
                    use listed {money(quotedPrice)}
                  </button>
                )}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:7,alignItems:"flex-end"}}>
                <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>Your rate (edit)</div>
                <div style={{display:"flex",alignItems:"center",gap:6,background:C.paper,border:`2px solid ${aprValid ? C.line : C.coral}`,borderRadius:11,padding:"6px 10px"}}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" max="39.99" value={aprStr}
                    onChange={e => setApr(e.target.value)}
                    style={{width:70,background:"transparent",border:0,color:C.ink,fontSize:19,fontWeight:700,textAlign:"right",outline:"none"}}/>
                  <span style={{color:C.inkFaint,fontSize:14}}>%</span>
                </div>
              </div>
            </div>
            <div style={{display:"inline-flex",gap:4,background:C.paper2,borderRadius:10,padding:3}}>
              {FIN_FREQS.map(f => (
                <button key={f.key} onClick={() => setFreqKey(f.key)}
                  style={{background:freqKey===f.key?BLUE:"transparent",color:freqKey===f.key?"#fff":C.inkSoft,border:"none",borderRadius:8,padding:"5px 11px",fontSize:12,fontWeight:800,cursor:"pointer",transition:reduceMotion?"none":"background .18s"}}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ESTIMATE MODE (source 'msrp'): the listing's real price wasn't
            confirmed, so everything below is computed off MSRP. Loud, unmissable
            warning + an editable price. Typing a real price flips the card to
            user-confirmed and drops this banner. Never call an MSRP "listed". */}
        {priceSource === "msrp" && (
          <div style={{marginTop:14,background:C.coralBg,border:`1px solid ${C.coral}`,borderRadius:12,padding:"12px 14px"}}>
            <div style={{fontSize:12.5,color:C.coralInk,fontWeight:800,lineHeight:1.55}}>
              ⚠ We couldn't confirm this listing's actual price. The payments below are <b>ESTIMATED from the MSRP ({money(msrpVal)})</b> — the real price is usually higher, so your actual payments will differ. Enter the listing price for an accurate breakdown.
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,color:C.coralInk}}>Actual listing price:</span>
              <div style={{display:"flex",alignItems:"center",gap:6,background:C.paper,border:`2px solid ${C.coral}`,borderRadius:11,padding:"6px 10px"}}>
                <span style={{color:C.inkFaint,fontSize:14}}>$</span>
                <input type="number" inputMode="numeric" min="0" value={priceStr}
                  onChange={e=>{setPriceStr(e.target.value);setPriceConfirmed(true);}}
                  style={{width:110,background:"transparent",border:0,color:C.ink,fontSize:18,fontWeight:700,textAlign:"right",outline:"none"}}/>
              </div>
            </div>
          </div>
        )}

        {/* User-confirmed price (source 'user'): the buyer typed a real price,
            so the card recomputed off it and the estimate warning is gone. Keep
            the field visible so they can correct it. */}
        {priceSource === "user" && (
          <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.inkSoft}}>Using the price you entered:</span>
            <div style={{display:"flex",alignItems:"center",gap:6,background:C.paper,border:`2px solid ${C.line}`,borderRadius:11,padding:"5px 9px"}}>
              <span style={{color:C.inkFaint,fontSize:13}}>$</span>
              <input type="number" inputMode="numeric" min="0" value={priceStr}
                onChange={e=>{setPriceStr(e.target.value);setPriceConfirmed(true);}}
                style={{width:100,background:"transparent",border:0,color:C.ink,fontSize:16,fontWeight:700,textAlign:"right",outline:"none"}}/>
            </div>
          </div>
        )}

        {/* ── COLLAPSED SUMMARY ────────────────────────────────────────────
            The rate comparison (on-your-quote vs manufacturer vs Bank of
            Canada) and the key markup warning stay visible above the toggle,
            per the approved condensed layout. The full payment matrix, the
            "what we'd do" recommendation, lease detail, and all disclosures
            move behind the expander below. */}

        {/* Rate anchors -- only real ones; each coloured by its own band */}
        <div style={{display:"flex",gap:9,flexWrap:"wrap",marginTop:14}}>
          {dealerRate != null && (
            <div style={{borderRadius:13,padding:"8px 12px",minWidth:108,flex:"1 1 120px",background:dealerTL?dealerTL.bg:C.paper2,border:`1px solid ${dealerTL?dealerTL.bd:C.line}`}}>
              <div style={{fontSize:10.5,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>On your quote</div>
              <div style={{fontSize:16,fontWeight:800,marginTop:2,color:dealerTL?dealerTL.fg:C.ink,fontVariantNumeric:"tabular-nums"}}>{dealerRate}%</div>
              <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>{dealerBand?bandLabel(dealerBand).toLowerCase():"dealer / lender APR"}</div>
            </div>
          )}
          {mfrRate != null && (
            <div style={{borderRadius:13,padding:"8px 12px",minWidth:108,flex:"1 1 120px",background:isNew?C.tealBg:"transparent",border:isNew?`1px solid ${C.teal}`:`1px dashed ${C.line}`,opacity:isNew?1:.72}}>
              <div style={{fontSize:10.5,color:isNew?C.tealInk:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>{analysis.make||"Manufacturer"} {isNew?`advertised${mfr?.promo?" · promo":""}`:"new-car"}</div>
              <div style={{fontSize:16,fontWeight:800,marginTop:2,color:isNew?C.tealInk:C.inkSoft,fontVariantNumeric:"tabular-nums"}}>{mfrRate}%</div>
              <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>{isNew?(mfr?.effectiveDate?`as of ${mfr.effectiveDate}`:"best available"):"reference only"}</div>
            </div>
          )}
          {/* LEASE APR (Phase 1: rates only). Two-sided (dealer-lease vs
              manufacturer-lease, with spread) only if a dealer/listing lease
              APR is ever present; today analysis has only the advertised
              manufacturer lease rate, so this renders one clearly-labelled,
              band-coloured chip. On used, the manufacturer lease is a NEW-car
              promo -> reference only (dashed, no applicable band). */}
          {leaseTwoSided && (
            <div style={{borderRadius:13,padding:"8px 12px",minWidth:108,flex:"1 1 120px",background:leaseTL?leaseTL.bg:C.paper2,border:`1px solid ${leaseTL?leaseTL.bd:C.line}`}}>
              <div style={{fontSize:10.5,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Lease · on your quote</div>
              <div style={{fontSize:16,fontWeight:800,marginTop:2,color:leaseTL?leaseTL.fg:C.ink,fontVariantNumeric:"tabular-nums"}}>{leaseDealerRate}%</div>
              <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>{leaseBand?bandLabel(leaseBand).toLowerCase():"dealer lease APR"}</div>
            </div>
          )}
          {leaseRate != null && (
            <div style={{
              borderRadius:13,padding:"8px 12px",minWidth:108,flex:"1 1 120px",
              background: leaseApplicable ? (leaseTL?leaseTL.bg:C.paper2) : "transparent",
              border: leaseApplicable ? `1px solid ${leaseTL?leaseTL.bd:C.line}` : `1px dashed ${C.line}`,
              opacity: leaseApplicable ? 1 : .72,
            }}>
              <div style={{fontSize:10.5,color:leaseApplicable&&leaseTL?leaseTL.fg:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>{leaseTwoSided?`${analysis.make||"Manufacturer"} lease`:`${analysis.make||"Advertised"} ${isNew?"advertised lease":"new-car lease"}`}</div>
              <div style={{fontSize:16,fontWeight:800,marginTop:2,color:leaseApplicable?(leaseTL?leaseTL.fg:C.ink):C.inkSoft,fontVariantNumeric:"tabular-nums"}}>{leaseRate}%</div>
              <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>{leaseApplicable&&!leaseTwoSided&&leaseBand?`${bandLabel(leaseBand).toLowerCase()} · `:""}{!leaseApplicable?"reference only":`${leaseTerm?`${leaseTerm}mo`:"lease rate"}${leaseKm?` · ${leaseKm.toLocaleString()} km/yr`:""}`}</div>
            </div>
          )}
          <div style={{borderRadius:13,padding:"8px 12px",minWidth:108,flex:"1 1 120px",background:C.paper2,border:`1px solid ${C.line}`}}>
            <div style={{fontSize:10.5,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Bank of Canada</div>
            {boc === null ? (
              <div style={{fontSize:16,fontWeight:800,marginTop:2,color:C.inkFaint}}>…</div>
            ) : boc === "error" ? (
              <a href="https://www.bankofcanada.ca/rates/interest-rates/canadian-interest-rates/" target="_blank" rel="noopener noreferrer"
                 style={{fontSize:13,fontWeight:800,color:BLUE,textDecoration:"none"}}>see current rate →</a>
            ) : (
              <>
                <div style={{fontSize:16,fontWeight:800,marginTop:2,color:C.ink,fontVariantNumeric:"tabular-nums"}}>{boc.rate}%</div>
                <div style={{fontSize:10.5,color:C.inkFaint,marginTop:1}}>policy rate · as of {boc.date}</div>
              </>
            )}
          </div>
        </div>

        {/* Dealer-vs-manufacturer markup warning -- same gate (new vehicle,
            spread > 0.1%) and extra-cost math (both APRs amortized over 60 mo
            on the price, difference of totals) as main's card. Kept in the
            collapsed summary as the key warning. */}
        {isNew && spread != null && spread > 0.1 && (()=>{
          const pd = price*(dealerRate/1200)/(1-Math.pow(1+dealerRate/1200,-60));
          const pm = price*(mfrRate/1200)/(1-Math.pow(1+mfrRate/1200,-60));
          const extra = Math.round((pd-pm)*60);
          return (
            <div style={{marginTop:12,background:C.coralBg,border:`1px solid ${C.coral}`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontSize:12,color:C.coralInk,fontWeight:800,lineHeight:1.5}}>⚠ This dealer's rate is {spread.toFixed(2)}% above {analysis.make}'s advertised rate — roughly ${extra.toLocaleString()} more over 60 months. Ask them to match the manufacturer rate.</div>
            </div>
          );
        })()}

        {/* Expand/collapse control for the full breakdown. Reduced-motion-safe:
            the chevron rotation and the grid-rows reveal both drop their
            transition when the user prefers reduced motion. */}
        <button onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}
          style={{width:"100%",marginTop:14,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:12,color:C.ink,font:"inherit",fontWeight:800,fontSize:13,padding:"11px 14px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span>{expanded?"Hide the full breakdown":"Explore down payment & term — every scenario"}</span>
          <span style={{transform:expanded?"rotate(180deg)":"none",transition:reduceMotion?"none":"transform .3s ease",lineHeight:1}}>▾</span>
        </button>

        {/* ── EXPANDED DETAIL (default collapsed) ──────────────────────────── */}
        <div style={{display:"grid",gridTemplateRows:expanded?"1fr":"0fr",transition:reduceMotion?"none":"grid-template-rows .35s ease",overflow:"hidden"}}>
          <div style={{minHeight:0,overflow:"hidden"}}>
            <div style={{paddingTop:16}}>

        {/* Heatmap: down payment x term, shaded by relative total interest */}
        <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6,marginTop:0,marginBottom:6}}>Explore down payment &amp; term — greener = cheaper</div>
        {/* Type-your-own down + term: re-anchors the hero payment above (and
            the grid outline when the values match a preset cell). Blank =
            back to the quote's own anchors. */}
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",margin:"2px 0 10px"}}>
          <span style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.6}}>Or type your own:</span>
          <div style={{display:"flex",alignItems:"center",gap:5,background:C.paper,border:`1px solid ${C.line}`,borderRadius:10,padding:"5px 9px"}}>
            <span style={{color:C.inkFaint,fontSize:12}}>$</span>
            <input type="number" inputMode="numeric" min="0" placeholder="down" value={downStr}
              onChange={e=>setDownStr(e.target.value)}
              style={{width:70,background:"transparent",border:0,color:C.ink,fontSize:13.5,fontWeight:700,outline:"none"}}/>
            <span style={{color:C.inkFaint,fontSize:11}}>down</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,background:C.paper,border:`1px solid ${termStr!==""&&customTerm==null?C.coral:C.line}`,borderRadius:10,padding:"5px 9px"}}>
            <input type="number" inputMode="numeric" min="12" max="120" step="12" placeholder="term" value={termStr}
              onChange={e=>setTermStr(e.target.value)}
              style={{width:52,background:"transparent",border:0,color:C.ink,fontSize:13.5,fontWeight:700,textAlign:"right",outline:"none"}}/>
            <span style={{color:C.inkFaint,fontSize:11}}>months</span>
          </div>
          {(downStr!==""||termStr!=="")&&(
            <button onClick={()=>{setDownStr("");setTermStr("");}}
              style={{background:"none",border:0,padding:0,color:C.tealInk,fontSize:11,fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>reset</button>
          )}
          {(customDown!=null||customTerm!=null)&&aprValid&&price>0&&(
            <span style={{fontSize:12,color:C.inkSoft}}>
              → <b style={{color:C.ink,fontVariantNumeric:"tabular-nums"}}>{money(heroPay)}{freqSuffix}</b> at {apr}% · the payment above follows your numbers
            </span>
          )}
          {termStr!==""&&customTerm==null&&<span style={{fontSize:11,color:C.coralInk}}>term must be 12–120 months</span>}
        </div>
        <div style={{overflowX:"auto",margin:"0 -4px"}}>
          <table style={{width:"100%",borderCollapse:"separate",borderSpacing:2,fontSize:12,minWidth:360}}>
            <thead>
              <tr>
                <th style={{textAlign:"left",color:C.inkFaint,fontWeight:600,fontSize:10,textTransform:"uppercase",letterSpacing:.3,padding:"6px 5px"}}>Down \ term</th>
                {FIN_TERMS.map(t => (
                  <th key={t} style={{textAlign:"right",color:C.inkFaint,fontWeight:600,fontSize:10,textTransform:"uppercase",letterSpacing:.3,padding:"6px 5px"}}>{t} mo</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cellData.map((row,ri) => (
                <tr key={downs[ri]}>
                  <td style={{textAlign:"left",color:C.inkSoft,fontWeight:700,padding:"6px 5px",whiteSpace:"nowrap"}}>{downs[ri]===0?"$0":money(downs[ri])}</td>
                  {row.map(cell => {
                    const tt = mx > mn ? (cell.interest - mn) / (mx - mn) : 0;
                    const h = (aprValid && cell.P > 0) ? heatOf(tt) : null;
                    const hTL = h ? TL[h] : null;
                    const isQuote = cell.d === heroDown && cell.t === heroTerm;
                    return (
                      <td key={cell.t} style={{
                        textAlign:"right", padding:"6px 5px", borderRadius:8, whiteSpace:"nowrap",
                        background: hTL ? hTL.bg : "transparent",
                        outline: isQuote ? `2px solid ${BLUE}` : "none", outlineOffset:-2,
                      }}>
                        {aprValid && cell.P > 0 ? (
                          <>
                            <div style={{fontWeight:700,color:C.ink,fontVariantNumeric:"tabular-nums"}}>{money(cell.m)}</div>
                            <div style={{fontSize:10,color:hTL?hTL.fg:C.inkFaint,fontVariantNumeric:"tabular-nums"}}>{money(cell.interest)}</div>
                          </>
                        ) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{fontSize:10.5,color:C.inkFaint,marginTop:10,lineHeight:1.5}}>
          Top number is the {freq.label.toLowerCase()} payment; below it is the total interest. Cell shade = relative total interest across this grid; <span style={{color:BLUE,fontWeight:800}}>blue outline</span> = your quote's {quoteTerm}-mo term.
        </div>

        {/* New-vs-used guard: on a USED vehicle the manufacturer's advertised
            rate is a NEW-car offer, flagged reference-only (main's exact copy). */}
        {mfrRate != null && !isNew && (
          <div style={{fontSize:12,color:C.inkSoft,marginTop:12,lineHeight:1.5,padding:"8px 10px",background:C.paper,border:`1px dashed ${C.line}`,borderRadius:10}}>
            Reference only: {analysis.make} advertises this on a NEW {analysis.make}. This vehicle is USED, so it doesn't apply — used-car financing is set by the dealer/lender and is usually higher.
          </div>
        )}

        {/* Recommendation: what we'd do, bullets coloured by the rate's band */}
        {bullets.length > 0 && (
          <div style={{marginTop:14,borderRadius:14,padding:"12px 14px",background:C.paper2,border:`1px solid ${C.line}`}}>
            <div style={{fontSize:12.5,fontWeight:800,color:C.ink}}>{recHead}</div>
            <ul style={{margin:"8px 0 0",padding:0,listStyle:"none",display:"flex",flexDirection:"column",gap:6}}>
              {bullets.map((b,i) => (
                <li key={i} style={{fontSize:12,color:C.inkSoft,lineHeight:1.5,display:"flex",gap:8}}>
                  <span style={{color:recColor,fontWeight:900}}>→</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* LEASE markup warning (forward-compatible): only when a dealer/listing
            lease APR exists alongside the manufacturer lease rate on a new
            vehicle. Mirrors the finance spread treatment, rate-only (no lease
            extra-cost dollar figure). */}
        {leaseTwoSided && isNew && leaseSpread != null && leaseSpread > 0.1 && (
          <div style={{marginTop:12,background:C.coralBg,border:`1px solid ${C.coral}`,borderRadius:12,padding:"12px 14px"}}>
            <div style={{fontSize:12,color:C.coralInk,fontWeight:800,lineHeight:1.5}}>⚠ This dealer's lease rate is {leaseSpread.toFixed(2)}% above {analysis.make}'s advertised lease rate. Ask them to match the manufacturer lease rate.</div>
          </div>
        )}

        {/* Phase-2 lease payment (COMPUTED track: Ford/Nissan etc). Residual-
            based estimate on the USER's own price/msrp -- assumptions visible.
            Only when applicable (never presented as this car's rate on a used
            vehicle) and only when we have the user's msrp to derive a residual. */}
        {leaseComputedPayment && (
          <div style={{marginTop:12,borderRadius:12,padding:"12px 14px",background:leaseTL?leaseTL.bg:C.tealBg,border:`1px solid ${leaseTL?leaseTL.bd:C.teal}55`}}>
            <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Estimated lease payment</div>
            <div style={{fontSize:24,fontWeight:800,marginTop:2,color:leaseTL?leaseTL.fg:C.ink,fontVariantNumeric:"tabular-nums"}}>
              {money(leaseComputedPayment.amount)}<span style={{fontSize:13,color:C.inkFaint,fontWeight:600}}>/mo</span>
            </div>
            <div style={{fontSize:11.5,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>
              Residual-based on your {money(price)} price at {leaseComputedPayment.apr}% · {(leaseComputedPayment.residualPct*100).toFixed(0)}% residual of {money(userMsrp)} MSRP · {leaseComputedPayment.term} mo{leaseComputedPayment.annualKm?` · ${leaseComputedPayment.annualKm.toLocaleString()} km/yr`:""} · $0 down.
            </div>
            <div style={{fontSize:10.5,color:C.inkFaint,marginTop:6,lineHeight:1.5}}>
              Estimate from the manufacturer's residual and lease rate applied to your vehicle — excludes tax, fees, and any lease incentives. Confirm the residual and money factor with the dealer.
            </div>
          </div>
        )}

        {/* Phase-2 lease payment (ADVERTISED track: BMW/Mercedes/Infiniti/GM).
            A FIXED advertised example for the scraped dealer's vehicle -- shown
            as a reference, NOT recomputed for the user's price. Suppressed on a
            used vehicle (new-car advertised promo doesn't apply). */}
        {leaseAdvertised && leaseAdvertised.amount != null && leaseApplicable && (
          <div style={{marginTop:12,borderRadius:12,padding:"12px 14px",background:C.paper2,border:`1px solid ${C.line}`}}>
            <div style={{fontSize:11,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Dealer's advertised lease example</div>
            <div style={{fontSize:24,fontWeight:800,marginTop:2,color:C.ink,fontVariantNumeric:"tabular-nums"}}>
              {money(leaseAdvertised.amount)}<span style={{fontSize:13,color:C.inkFaint,fontWeight:600}}>/mo</span>
              {leaseAdvertised.withTax != null && <span style={{fontSize:12,color:C.inkFaint,fontWeight:600}}> · {money(leaseAdvertised.withTax)}/mo w/ tax</span>}
            </div>
            <div style={{fontSize:11.5,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>
              {analysis.make}'s advertised example{leaseAdvertised.sellingPrice!=null?` for a ${money(leaseAdvertised.sellingPrice)} vehicle`:""}{leaseAdvertised.term?` · ${leaseAdvertised.term} mo`:""}{leaseAdvertised.annualKm?` · ${leaseAdvertised.annualKm.toLocaleString()} km/yr`:""}{leaseRate!=null?` · at ${leaseRate}%`:""}.
            </div>
            <div style={{fontSize:10.5,color:C.inkFaint,marginTop:6,lineHeight:1.5}}>
              A fixed advertised figure — not recomputed for your {money(price)} vehicle. Your payment depends on the negotiated price, down payment, and term.
            </div>
          </div>
        )}

        {/* One-sided lease note: analysis carries only the advertised lease
            rate, so there's no dealer-lease rate to compare against. Keep it
            honest -- say so, and don't invent a second number. */}
        {leaseRate != null && !leaseTwoSided && (
          <div style={{fontSize:12,color:C.inkSoft,marginTop:12,lineHeight:1.5,padding:"8px 10px",background:C.paper,border:`1px dashed ${C.line}`,borderRadius:10}}>
            {isNew
              ? <>Lease shown is {analysis.make}'s advertised lease APR. A side-by-side lease comparison — your dealer's lease rate vs this — needs a lease rate stated on the listing.</>
              : <>{analysis.make}'s lease rate is a new-car promo, shown for reference — it doesn't apply to a used vehicle. A side-by-side lease comparison needs a lease rate stated on the listing.</>}
          </div>
        )}

        {!rateIsReal && (
          <div style={{fontSize:12,color:C.inkFaint,marginTop:12,lineHeight:1.5}}>
            Your quote didn't disclose a financing rate, so the numbers use a rate you can edit above.
            The Bank of Canada rate is the benchmark lenders price off — your car-loan APR sits above it.
          </div>
        )}

        {analysis.financingCheck?.checked && analysis.financingCheck.note && (
          <div style={{...cardStyle,marginTop:12,marginBottom:0,background:analysis.financingCheck.consistent?C.tealBg:C.coralBg,border:`1px solid ${(analysis.financingCheck.consistent?C.teal:C.coral)}55`,boxShadow:"none"}}>
            <div style={{fontSize:12,fontWeight:800,color:analysis.financingCheck.consistent?C.tealInk:C.coralInk,marginBottom:4}}>
              {analysis.financingCheck.consistent?"✓ Disclosed payments reconcile":"⚠️ Disclosed payments don't reconcile"}
            </div>
            <div style={{fontSize:12,color:C.ink,lineHeight:1.5}}>{analysis.financingCheck.note}</div>
          </div>
        )}

        {ratesAsOf && (
          <div style={{fontSize:11,color:C.inkFaint,marginTop:12,display:"flex",alignItems:"center",gap:6}}>
            <span>🕑</span>
            <span>Manufacturer {leaseRate!=null&&mfrRate!=null?"finance & lease ":mfrRate!=null?"finance ":"lease "}rates as of <b>{fmtDate(ratesAsOf)}</b>, from {analysis.make||"the maker"}'s advertised rates — refreshed daily.</span>
          </div>
        )}

        <div style={{fontSize:11,color:C.inkFaint,marginTop:12,lineHeight:1.5}}>
          Estimate only. Financed amount = price − down payment; excludes tax, fees, trade-in, and any manufacturer promo. Actual payments depend on the APR and term you're approved for.
        </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Magic-link sign-in modal ──────────────────────────────────────────────────
// Passwordless (OTP) sign-in for the public app. Sends a one-time sign-in link
// to the entered email via supabase.auth.signInWithOtp; the link returns the
// user to /quote-check, where detectSessionInUrl establishes the session. Themed
// with the QuoteCheckPage palette (C) so it matches whatever mode the page is in
// (dark/light/outdoor), reusing the app's .lc-modal-overlay backdrop. This only
// requests the link -- session creation happens on the redirect back.
// Small envelope glyph shared by the sign-in hero + success animation. Pure
// SVG (no emoji) so it stays crisp and takes the stroke colour of whatever
// chip it sits on.
function SignInEnvelope({size=22, stroke="#fff", width=2}){
  return (
    <svg width={size} height={Math.round(size*0.72)} viewBox="0 0 24 17" fill="none" aria-hidden="true">
      <rect x="1" y="1.2" width="22" height="14.6" rx="2.6" stroke={stroke} strokeWidth={width}/>
      <path d="M2.4 3.2 12 10l9.6-6.8" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// LotCheck-style isometric hero for the sign-in form: a tilted violet runway
// down which one-time-link chips advance forward toward the viewer, aiming at
// a glowing teal destination line (the inbox). Matches the app's IsoScanVisual
// idiom (perspective + rotateX(52deg) tilt + translateZ) and the referral/MSRP
// 3D language (violet #8b5cf6 / teal #4fd8c4 glass, forward-moving chips).
// Motion is CSS-only; prefers-reduced-motion parks each chip on its inline
// resting frame (a static isometric stack) via the QC_CSS media query.
function SignInLinkHero(){
  const V="#8b5cf6", VL="#a78bfa", TB="#4fd8c4";
  const face={
    position:"absolute",width:46,height:32,margin:"-16px 0 0 -23px",borderRadius:9,
    transform:"rotateX(-52deg)",display:"grid",placeItems:"center",
    background:`linear-gradient(150deg, ${VL}, ${V})`,
    boxShadow:`0 12px 24px -8px ${V}99, inset 0 1px 0 rgba(255,255,255,.4)`,
  };
  // Each chip: a moving wrapper (animated) + a billboarded face. The inline
  // transform is the reduced-motion resting frame; the animation overrides it
  // while running.
  const chips=[
    {"--x":"-9px", delay:"0s",    rest:"translate3d(-9px,-30px,8px)"},
    {"--x":"6px",  delay:"0.8s",  rest:"translate3d(6px,0px,30px)"},
    {"--x":"-3px", delay:"1.6s",  rest:"translate3d(-3px,30px,50px)"},
  ];
  return (
    <div style={{height:104,perspective:600,perspectiveOrigin:"50% 40%",position:"relative",margin:"2px 0 6px"}}>
      <div style={{position:"absolute",inset:0,transformStyle:"preserve-3d",transform:"translateY(8px) rotateX(52deg)"}}>
        {/* isometric floor grid */}
        <div style={{
          position:"absolute",left:"50%",top:"46%",width:200,height:150,margin:"-75px 0 0 -100px",
          background:"linear-gradient(rgba(139,92,246,.16) 1px,transparent 1px) 0 0/28px 28px,"
            +"linear-gradient(90deg,rgba(139,92,246,.16) 1px,transparent 1px) 0 0/28px 28px",
          WebkitMaskImage:"radial-gradient(circle at 50% 46%,#000 30%,transparent 74%)",
          maskImage:"radial-gradient(circle at 50% 46%,#000 30%,transparent 74%)",
        }}/>
        {/* glowing teal destination line (the inbox the link is headed to) */}
        <div className="lc-si-line" style={{
          position:"absolute",left:"50%",top:"63%",width:118,height:4,margin:"-2px 0 0 -59px",borderRadius:3,
          background:`linear-gradient(90deg,transparent,${TB},transparent)`,
          boxShadow:`0 0 14px ${TB}`,animation:"lc-si-glow 2.4s ease-in-out infinite",
        }}/>
        {/* forward-advancing link chips */}
        {chips.map((c,i)=>(
          <div key={i} className="lc-si-chip" style={{
            position:"absolute",left:"50%",top:"46%",width:0,height:0,opacity:1,
            transform:c.rest, "--x":c["--x"],
            animation:"lc-si-advance 2.4s linear infinite", animationDelay:c.delay,
          }}>
            <div style={face}><SignInEnvelope size={20}/></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Success ("link sent") 3D element: a teal envelope that flies forward once,
// growing and rising toward the camera -- reinforcing "your link is on its
// way." Reduced motion parks it on the arrived frame (its inline transform).
function SignInSentHero(){
  const restFrame="translate3d(0px,24px,58px) scale(1)"; // final = arrived frame
  return (
    <div style={{height:96,perspective:620,perspectiveOrigin:"50% 42%",position:"relative",margin:"0 0 4px"}}>
      <div style={{position:"absolute",inset:0,transformStyle:"preserve-3d",transform:"translateY(6px) rotateX(52deg)"}}>
        {/* two speed lines on the runway to sell the forward launch */}
        {[-16,16].map((x,i)=>(
          <div key={i} className="lc-si-line" style={{
            position:"absolute",left:"50%",top:"50%",width:3,height:70,margin:"-35px 0 0 -1.5px",
            transform:`translate3d(${x}px,0px,0px)`,borderRadius:3,
            background:"linear-gradient(rgba(79,216,196,.55),transparent)",
            animation:"lc-si-glow 1.4s ease-in-out infinite",animationDelay:i?"0.2s":"0s",
          }}/>
        ))}
        <div className="lc-si-env" style={{
          position:"absolute",left:"50%",top:"42%",width:0,height:0,opacity:1,transform:restFrame,
          animation:"lc-si-fly 1.15s cubic-bezier(.4,0,.2,1) forwards",
        }}>
          <div style={{
            position:"absolute",width:66,height:46,margin:"-23px 0 0 -33px",borderRadius:12,
            transform:"rotateX(-52deg)",display:"grid",placeItems:"center",
            background:"linear-gradient(150deg,#5ff0d6,#2bb39c)",
            boxShadow:"0 16px 30px -8px rgba(79,216,196,.6), inset 0 1px 0 rgba(255,255,255,.45)",
          }}>
            <SignInEnvelope size={30} stroke="#06342e" width={2.1}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// Disposable / temporary-email domains. Free personal credit is no longer minted
// on signup (see fn_grant_signup), so this is not the primary farming defense —
// it just keeps obvious throwaway inboxes out of the magic-link flow. Small,
// hand-kept list of the common ones rather than an exhaustive service.
const DISPOSABLE_EMAIL_DOMAINS=new Set([
  "mailinator.com","guerrillamail.com","guerrillamail.info","sharklasers.com",
  "10minutemail.com","10minutemail.net","tempmail.com","temp-mail.org","tempmail.net",
  "tempmailo.com","yopmail.com","yopmail.fr","throwawaymail.com","getnada.com",
  "nada.email","trashmail.com","trashmail.de","dispostable.com","maildrop.cc",
  "mailnesia.com","fakeinbox.com","mohmal.com","emailondeck.com","mytemp.email",
  "spam4.me","moakt.com","tempr.email","discard.email","getairmail.com",
]);

// Normalize an email for comparison/dedupe: lowercase + trim, and for Gmail
// (gmail.com / googlemail.com) strip the +tag and dots in the local part, since
// Gmail treats those as the same inbox. NOTE: Supabase Auth stores its own copy
// of the email, so this is mainly for future client-side dedupe — the real
// multi-account farming defense is the share-only signup grant, not this.
export function normalizeEmail(email){
  const raw=(email||"").trim().toLowerCase();
  const at=raw.lastIndexOf("@");
  if(at<0) return raw;
  let local=raw.slice(0,at);
  const domain=raw.slice(at+1);
  if(domain==="gmail.com"||domain==="googlemail.com"){
    local=local.split("+")[0].replace(/\./g,"");
  }
  return local+"@"+domain;
}

function isDisposableEmail(email){
  const at=(email||"").trim().toLowerCase().lastIndexOf("@");
  if(at<0) return false;
  const domain=(email||"").trim().toLowerCase().slice(at+1);
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

function SignInModal({C, cardStyle, onClose, notice}){
  const [email,setEmail]=useState("");
  const [phase,setPhase]=useState("form"); // form | sending | sent | error
  const [errMsg,setErrMsg]=useState("");

  function validEmail(v){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v||"").trim());
  }

  async function sendLink(){
    const addr=email.trim();
    if(!validEmail(addr)){
      setPhase("error");
      setErrMsg("That doesn't look like a valid email address.");
      return;
    }
    if(isDisposableEmail(addr)){
      setPhase("error");
      setErrMsg("Please use a permanent email address.");
      return;
    }
    setErrMsg("");
    setPhase("sending");
    try{
      const {error}=await supabase.auth.signInWithOtp({
        email:addr,
        options:{emailRedirectTo:window.location.origin+"/quote-check"},
      });
      if(error){
        setPhase("error");
        setErrMsg(error.message||"Couldn't send the sign-in link. Please try again.");
        return;
      }
      setPhase("sent");
    }catch(err){
      setPhase("error");
      setErrMsg("Couldn't reach the sign-in service. Check your connection and try again.");
    }
  }

  const inputStyle={
    width:"100%",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,
    padding:"12px 14px",color:C.ink,fontSize:15,outline:"none",boxSizing:"border-box",
  };

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{...cardStyle,width:"100%",maxWidth:420,margin:16,marginBottom:16,boxShadow:C.cardShadow,fontFamily:"'Nunito',system-ui,-apple-system,sans-serif"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:16,fontWeight:1000,color:C.ink}}>Sign in to LotCheck</div>
          <button onClick={onClose} aria-label="Close" style={{background:"transparent",border:"none",color:C.inkFaint,cursor:"pointer",lineHeight:1,display:"grid",placeItems:"center",padding:2}}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>

        {notice&&phase!=="sent"&&(
          <div style={{background:C.tealBg,border:`1px solid ${C.teal}55`,borderRadius:10,padding:"10px 12px",marginBottom:14,fontSize:13,color:C.tealInk,fontWeight:700,lineHeight:1.5}}>
            {notice}
          </div>
        )}

        {phase==="sent"?(
          <div style={{textAlign:"center",padding:"0 0 4px"}}>
            <SignInSentHero/>
            <div style={{fontSize:16,fontWeight:800,color:C.ink,marginBottom:6}}>Check your inbox</div>
            <div style={{fontSize:13,color:C.inkSoft,lineHeight:1.6,marginBottom:16}}>
              We sent a sign-in link to <span style={{fontWeight:800,color:C.ink}}>{email.trim()}</span>. Open it on this device to finish signing in.
            </div>
            <button onClick={onClose} style={{background:C.ink,border:"none",borderRadius:999,padding:"11px 22px",color:C.paper,fontWeight:800,fontSize:14,cursor:"pointer"}}>Got it</button>
          </div>
        ):(
          <>
            <SignInLinkHero/>
            {/* The free check is the reason to sign in, so it leads. Gating it
                behind the magic link only works if the visitor knows the link
                is what buys it. */}
            <div style={{background:C.tealBg,border:`1px solid ${C.teal}55`,borderRadius:10,
                         padding:"10px 12px",marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:800,color:C.tealInk}}>Your first check is free</div>
              <div style={{fontSize:12.5,color:C.tealInk,opacity:.85,marginTop:2,lineHeight:1.5}}>
                Plus one to share with someone else. No card, no subscription.
              </div>
            </div>
            <div style={{fontSize:13,color:C.inkSoft,lineHeight:1.6,marginBottom:14}}>
              Enter your email and we'll send you a one-time sign-in link. No password needed.
            </div>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@email.com"
              value={email}
              onChange={e=>{setEmail(e.target.value);if(phase==="error")setPhase("form");}}
              onKeyDown={e=>{if(e.key==="Enter"&&phase!=="sending")sendLink();}}
              style={inputStyle}
            />
            {phase==="error"&&(
              <div style={{fontSize:12,color:C.coralInk,marginTop:8,fontWeight:700}}>{errMsg}</div>
            )}
            <button
              onClick={sendLink}
              disabled={phase==="sending"}
              style={{width:"100%",marginTop:14,background:phase==="sending"?C.inkFaint:C.teal,border:"none",borderRadius:12,padding:"14px 0",color:"#fff",fontSize:15,fontWeight:800,cursor:phase==="sending"?"default":"pointer",opacity:phase==="sending"?0.8:1}}>
              {phase==="sending"?"Sending…":"Email me a sign-in link →"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Quote Check paywall ─────────────────────────────────────────────────
// Opened when a signed-in user is out of credits (the edge function returns
// HTTP 402 {error:"out_of_credits"}). Shows the three packs. Real Stripe
// checkout is a later phase, so every Buy button is disabled / "Coming soon" --
// this is display-only, it never grants credits client-side. Styled to match
// SignInModal (same lc-modal-overlay + cardStyle + QC theme colours).
function QuotePaywallModal({C, cardStyle, onClose}){
  // Ladder as of 2026-08-15. Entry is $4.99 for a single check: most buyers are
  // looking at one or two cars, and the old $9.99 five-pack minimum priced them
  // out of trying it at all. The 5-pack is $12.99 rather than $14.99 so the
  // last two checks cost $1.50 each — at $14.99 the marginal price was flat and
  // the pack gave nobody a reason to trade up. Mirrors credit_pack in the DB.
  // The free check is still here — it just lives behind the magic link now.
  // Shown first and explicitly, because a giveaway you don't advertise buys
  // nothing: the whole point of gating it is that signing in is the price.
  const packs=[
    {name:"First check free", price:"$0", checks:"1 check", share:"+1 to share",
     note:"just sign in", best:false, free:true},
    {name:"1 check",  price:"$4.99",  checks:"1 check",  share:null,          note:null,          best:false},
    {name:"3 checks", price:"$9.99",  checks:"3 checks", share:"+1 to share", note:"$3.33 each",  best:false},
    {name:"5 checks", price:"$12.99", checks:"5 checks", share:"+2 to share", note:"$2.60 each",  best:true},
  ];
  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{...cardStyle,width:"100%",maxWidth:460,margin:16,marginBottom:16,boxShadow:C.cardShadow,fontFamily:"'Nunito',system-ui,-apple-system,sans-serif"}}>
        <style>{`
          /* Solid, bold, BRIGHT letters (fully legible) with a scanner nod:
             the ISBN line + a thin sweeping beam — no stripe-clipping of text. */
          .fx-barcode{
            position:relative; display:inline-block;
            font-family:'Nunito',system-ui,-apple-system,sans-serif;
            font-weight:900; font-size:21px; line-height:1.15; letter-spacing:.005em;
            color:var(--fx-ink);
            text-shadow:0 0 18px color-mix(in srgb, var(--fx-ink) 45%, transparent);
            padding-bottom:14px;
          }
          .fx-barcode::before{
            content:"9 780316 668111";
            position:absolute; top:100%; left:0; margin-top:-10px;
            font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;
            font-size:9px; letter-spacing:.26em; white-space:nowrap;
            color:color-mix(in srgb, var(--fx-ink) 62%, transparent);
          }
          .fx-barcode::after{
            content:""; position:absolute; top:-8%; bottom:26%; left:-3%; width:2px;
            background:var(--fx-beam); opacity:.9;
            box-shadow:0 0 8px var(--fx-beam), 0 0 18px var(--fx-beam);
            animation:fx-barcode-scan 2s ease-in-out infinite alternate;
          }
          @keyframes fx-barcode-scan{ 0%{left:-3%} 100%{left:101%} }
          @media (prefers-reduced-motion:reduce){ .fx-barcode::after{ animation:none; opacity:.4 } }
        `}</style>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div className="fx-barcode" style={{"--fx-ink":C.teal,"--fx-beam":C.tealInk||C.teal||"#4fd8c4"}}>You're out of checks</div>
          <button onClick={onClose} aria-label="Close" style={{background:"transparent",border:"none",color:C.inkFaint,fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:13,color:C.inkSoft,lineHeight:1.6,marginBottom:16}}>
          Top up to keep checking quotes. Every pack includes a couple of shareable checks to send a friend.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {packs.map((p,i)=>(
            <div key={i} style={{
              position:"relative",display:"flex",alignItems:"center",gap:12,
              background:p.best?C.tealBg:C.paper2,
              border:`${p.best?"2px":"1px"} solid ${p.best?C.teal:C.line}`,
              borderRadius:14,padding:"14px 16px",
            }}>
              {p.best&&(
                <div style={{position:"absolute",top:-10,right:14,background:C.teal,color:"#fff",fontSize:10,fontWeight:800,letterSpacing:.4,padding:"3px 8px",borderRadius:999}}>BEST VALUE</div>
              )}
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:15,fontWeight:900,color:C.ink}}>{p.checks}</span>
                  <span style={{fontSize:12,fontWeight:700,color:C.tealInk}}>{p.share}</span>
                </div>
                <div style={{fontSize:12,color:C.inkFaint,marginTop:2}}>{p.note||`${p.price} one-time`}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontSize:18,fontWeight:900,color:C.ink,marginBottom:6}}>{p.price}</div>
                <button disabled aria-disabled="true"
                  style={{background:"transparent",border:`1px solid ${C.line}`,borderRadius:10,padding:"7px 14px",color:C.inkFaint,fontSize:12,fontWeight:800,cursor:"not-allowed",whiteSpace:"nowrap"}}>
                  {p.name==="Free"?"Current plan":"Coming soon"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div style={{fontSize:11,color:C.inkFaint,textAlign:"center",marginTop:14,lineHeight:1.5}}>
          Paid packs aren't live yet — checkout is coming soon.
        </div>
      </div>
    </div>
  );
}

// ── Quote Check: upload a dealer quote PDF, get an AI-read breakdown of
// MSRP vs quoted price, flagged add-ons, and warranty analysis. Nothing is
// uploaded to Supabase Storage or saved anywhere -- the file is read in the
// browser, sent once to the edge function for analysis, and discarded.
// Collapsible "show details" wrapper: the caller renders the section's
// headline/summary (always visible); this tucks the long detail behind a tap so
// a thorough report stays short by default. Owns its state -> safe to reuse many
// times on one report (recall detail, fee line items, review highlights).
function DetailToggle({C, moreLabel, lessLabel, children, defaultOpen=false}){
  const [open,setOpen]=useState(defaultOpen);
  return (
    <div>
      <button onClick={()=>setOpen(o=>!o)} aria-expanded={open}
        style={{marginTop:10,background:"transparent",border:`1px solid ${C.line}`,borderRadius:9,padding:"7px 13px",color:C.inkSoft,fontSize:12,fontWeight:800,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:7}}>
        {open?(lessLabel||"Hide details"):(moreLabel||"Show details")}
        <span style={{fontSize:9,display:"inline-block",transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}>▼</span>
      </button>
      {open&&<div style={{marginTop:4}}>{children}</div>}
    </div>
  );
}

// ── Self-contained share link ───────────────────────────────────────────────
// The report is packed into the URL FRAGMENT (never sent to a server, never
// stored) so a shared link reconstructs the report entirely client-side —
// keeping LotCheck's "analyzed once, never stored" promise literally true. A
// compact field subset keeps the link short; long recall summaries are dropped
// (the flip-book shows systems + dates only).
// Does this report have a sticker precise enough to make an over/under-MSRP
// claim? Only an EXACT trim figure qualifies: a "starting_at" floor (base trim
// or adjacent model year) is a reference, and an option-loaded car sitting above
// it is NOT "over MSRP". Three surfaces re-derived this rule independently, and
// the scroll view's copy referenced its variable from outside the scope that
// declared it -- a ReferenceError that took the ENTIRE scroll view down for
// every report, silently, because an undefined identifier is not a build error.
// One definition now; check:parity pins it there.
function isExactMsrp(a){ return !!(a && Number(a.msrp) > 0 && a.msrpBasis === "exact"); }

// Containment for the report render. A single throwing card used to take the
// ENTIRE page to a white screen -- twice, from the same cause (an identifier
// referenced one scope too high). check:undef now catches that class before it
// ships; this is the second layer, so if anything else throws at runtime the
// buyer still sees who we are and what to do, never a blank page.
//
// It does NOT swallow the error: it re-throws to the console so the failure
// stays visible in logs and in development. Silent degradation would violate
// the rule that a miss must never read as an all-clear.
// Runs a render function inside a CHILD component's own render pass. Without
// this, `<ReportBoundary>{(()=>{...})()}</ReportBoundary>` evaluates its children
// in the parent, so the boundary never sees the throw -- verified by injecting a
// deliberate error, which produced a blank page until this indirection existed.
// The report block contains no hooks, so relocating it changes nothing else.
function RenderSlot({ fn }){ return fn(); }

class ReportBoundary extends Component {
  constructor(props){ super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){ console.error("[LotCheck] report render failed:", err, info?.componentStack); }
  render(){
    if (!this.state.err) return this.props.children;
    const C = this.props.C || {};
    return (
      <div style={{ border: `1px solid ${C.line || "rgba(0,0,0,.12)"}`, borderRadius: 14, padding: 20, background: C.card || "#fff", color: C.ink || "#33305A" }}>
        <div style={{ fontSize: 15, fontWeight: 900, marginBottom: 6 }}>This report couldn't be displayed</div>
        <div style={{ fontSize: 13, color: C.inkSoft || "#5B5885", lineHeight: 1.55 }}>
          Your scan completed — the problem is on our side, in how this page draws the result, not in the figures.
          Reload the page to try again. If it keeps happening, send us the link and we'll fix it.
        </div>
        <div style={{ fontSize: 11.5, color: C.inkFaint || "#706D96", marginTop: 10, fontFamily: "ui-monospace,monospace" }}>{String(this.state.err?.message || this.state.err).slice(0, 160)}</div>
      </div>
    );
  }
}

// Module-level money formatter. Four components each declare their own local
// `money`, which shadows this one and leaves their behaviour untouched -- but
// QuoteCheckPage never had one, so `money(...)` in the msrpReference note was an
// undefined reference that blanked the ENTIRE scroll view whenever a report
// carried a starting-at reference price. Found by check:undef, reproduced live.
function money(n){ const v = Number(n); return (!n || Number.isNaN(v)) ? "—" : "$" + Math.round(v).toLocaleString("en-CA"); }

function encodeReport(a){
  const c={v:a.vehicle,y:a.year,mk:a.make,md:a.model,tr:a.trim,dn:a.dealerName,dc:a.dealerCity,cond:a.vehicleCondition,
    qp:a.quotedPrice,ms:a.msrp,
    fin:a.financing?{p:a.financing.paymentAmount,f:a.financing.paymentFrequency,r:a.financing.rate,t:a.financing.termMonths}:null,
    fr:a.financeRates?{d:a.financeRates.dealer?.apr??null,m:a.financeRates.manufacturer?.apr??null}:null,
    rc:a.recalls?.checked?{n:a.recalls.count,it:(a.recalls.items||[]).slice(0,6).map(x=>({s:x.system,d:x.date}))}:null,
    ao:(a.addOns||[]).map(x=>({n:x.name,p:x.price,vd:x.verdict||(x.flagged?"flagged":"standard")})),
    tf:a.totalFlaggedCost,
    ds:a.dealerSentiment?{r:a.dealerSentiment.rating,c:a.dealerSentiment.reviewCount,h:(a.dealerSentiment.highlights||[]).slice(0,3).map(x=>({r:x.rating,t:x.text}))}:null,
    lv:a.leverageScore?{s:a.leverageScore.score,n:a.leverageScore.note}:null,
    sw:a.standardWarranty?.coverage?{c:a.standardWarranty.coverage}:null,
    sm:a.summary,
    rid:a.reportId||null,ia:a.issuedAt||null,vp:a.verifyPayload||null,sg:a.sig||null,kid:a.keyId||null,
    dol:a.daysOnLot?{d:a.daysOnLot.days,s:a.daysOnLot.since||null,sl:a.daysOnLot.sourceLabel||null}:null,
    pd:a.priceDisclosure||null,mb:a.msrpBasis||null,mt:a.msrpTrim||null,my:a.msrpYear||null,
    ai:a.allInPricing?{b:a.allInPricing.body}:null,
    cs:a.counterScript?{m:(a.counterScript.moves||[]).slice(0,12).map(x=>({t:x.topic,s:x.say})),c:!!a.counterScript.clean}:null,
    dcx:a.disclaimerCheck?{t:String(a.disclaimerCheck.text).slice(0,500),n:a.disclaimerCheck.note,e:!!a.disclaimerCheck.escapeHatch,x:!!a.disclaimerCheck.contradiction}:null,
    tw:a.tradeInWidget&&a.tradeInWidget.detected?{v:a.tradeInWidget.vendor||null}:null,
    fcx:a.financeContingent&&a.financeContingent.contingent?{r:a.financeContingent.reasons||[],e:a.financeContingent.evidence||""}:null,
    pb:a.msrpPriceBasis||null,
    omsrp:a.originalMsrp?{m:a.originalMsrp.msrp,t:a.originalMsrp.trim||null,y:a.originalMsrp.year||null}:null,
    mun:a.msrpUnavailable?{n:a.msrpUnavailable.note}:null,
    mref:a.msrpReference&&a.msrpReference.msrp>0?{m:a.msrpReference.msrp,t:a.msrpReference.trim||null,u:a.msrpReference.sourceUrl||null,mk:a.msrpReference.make||null}:null,
    lic:a.dealerLicence&&a.dealerLicence.status?{s:a.dealerLicence.status,st:a.dealerLicence.state,n:a.dealerLicence.legalName||null,no:a.dealerLicence.licenceNumber||null,e:a.dealerLicence.expiryDate||null}:null,
    sh:a.listingShotSha256||null};
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
  catch{ return ""; }
}
function decodeReport(s){
  try{
    const b=s.replace(/-/g,"+").replace(/_/g,"/");
    const c=JSON.parse(decodeURIComponent(escape(atob(b))));
    return {vehicle:c.v,year:c.y,make:c.mk,model:c.md,trim:c.tr,dealerName:c.dn,dealerCity:c.dc,vehicleCondition:c.cond,
      quotedPrice:c.qp,msrp:c.ms,
      financing:c.fin?{paymentAmount:c.fin.p,paymentFrequency:c.fin.f,rate:c.fin.r,termMonths:c.fin.t}:null,
      financeRates:c.fr?{dealer:c.fr.d!=null?{apr:c.fr.d}:null,manufacturer:c.fr.m!=null?{apr:c.fr.m}:null}:null,
      recalls:c.rc?{checked:true,count:c.rc.n,items:(c.rc.it||[]).map(x=>({system:x.s,date:x.d})),source:"Transport Canada VRDB"}:null,
      addOns:(c.ao||[]).map(x=>({name:x.n,price:x.p,verdict:x.vd})),
      totalFlaggedCost:c.tf,
      dealerSentiment:c.ds?{rating:c.ds.r,reviewCount:c.ds.c,highlights:(c.ds.h||[]).map(x=>({rating:x.r,text:x.t})),dealerName:c.dn}:null,
      leverageScore:c.lv?{score:c.lv.s,note:c.lv.n,computed:true}:null,
      standardWarranty:c.sw?{coverage:c.sw.c}:null,
      summary:c.sm,
      reportId:c.rid||null,issuedAt:c.ia||null,verifyPayload:c.vp||null,sig:c.sg||null,keyId:c.kid||null,
      daysOnLot:c.dol?{days:c.dol.d,since:c.dol.s||null,sourceLabel:c.dol.sl||null,source:"dealer_platform_feed"}:null,
      priceDisclosure:c.pd||null,msrpBasis:c.mb||null,msrpTrim:c.mt||null,msrpYear:c.my||null,
      allInPricing:c.ai?{body:c.ai.b}:null,
      counterScript:c.cs?{moves:(c.cs.m||[]).map(x=>({topic:x.t,say:x.s})),clean:!!c.cs.c}:null,
      disclaimerCheck:c.dcx?{text:c.dcx.t,note:c.dcx.n,escapeHatch:!!c.dcx.e,contradiction:!!c.dcx.x}:null,
      tradeInWidget:c.tw?{detected:true,vendor:c.tw.v||null}:null,
      financeContingent:c.fcx?{contingent:true,reasons:c.fcx.r||[],evidence:c.fcx.e||""}:null,
      msrpPriceBasis:c.pb||null,
      originalMsrp:c.omsrp?{msrp:c.omsrp.m,trim:c.omsrp.t||null,year:c.omsrp.y||null}:null,
      msrpUnavailable:c.mun?{note:c.mun.n}:null,
      msrpReference:c.mref?{msrp:c.mref.m,trim:c.mref.t||null,sourceUrl:c.mref.u||null,make:c.mref.mk||null,basis:"starting_at"}:null,
      dealerLicence:c.lic?{status:c.lic.s,state:c.lic.st,legalName:c.lic.n||null,licenceNumber:c.lic.no||null,expiryDate:c.lic.e||null,source:"AMVIC public registry"}:null,
      listingShotSha256:c.sh||null,__shared:true};
  }catch{ return null; }
}

// ── Report flip-book ("Report view") ────────────────────────────────────────
// Presents the report as a two-page magazine spread you flip through (arrows /
// ← → keys), instead of a long scroll. Pages are built DYNAMICALLY from the
// analysis so variable content (0 vs many recalls, short/long fee lists) never
// breaks a fixed layout — a page only appears when it has real data. Its own
// "printed report" palette (paper + violet/teal), independent of the app theme.
// The real LotCheck logo (isometric gate + car) as a reusable mark — same art
// as the site header. Rendered via innerHTML so the raw SVG polygons drop in
// without JSX conversion. Used on the report cover + end page.
const LOGO_INNER=`<polygon points="0,-36 170,49 30,119 -140,34" fill="rgb(184,222,184)"/><polygon points="-140,48 30,133 30,119 -140,34" fill="rgb(160,203,160)"/><polygon points="170,63 30,133 30,119 170,49" fill="rgb(136,172,136)"/><polygon points="-50,5 100,80 52,104 -98,29" fill="#D9DBEF"/><polygon points="-4,-26 8,-20 -4,-14 -16,-20" fill="rgb(182,171,228)"/><polygon points="-16,22 -4,28 -4,-14 -16,-20" fill="rgb(158,145,210)"/><polygon points="8,22 -4,28 -4,-14 8,-20" fill="rgb(135,124,179)"/><polygon points="-72,8 -60,14 -72,20 -84,14" fill="rgb(182,171,228)"/><polygon points="-84,56 -72,62 -72,20 -84,14" fill="rgb(158,145,210)"/><polygon points="-60,56 -72,62 -72,20 -60,14" fill="rgb(135,124,179)"/><polygon points="1,-38.5 11,-33.5 -77,10.5 -87,5.5" fill="rgb(194,184,235)"/><polygon points="-87,16.5 -77,21.5 -77,10.5 -87,5.5" fill="rgb(172,160,218)"/><polygon points="11,-22.5 -77,21.5 -77,10.5 11,-33.5" fill="rgb(146,136,185)"/><polygon points="6,17 -82,61 -82,17 6,-27" fill="rgba(47,167,154,.22)"/><polygon points="-13,33.5 40,60 13,73.5 -40,47" fill="rgba(51,48,90,.10)"/><polygon points="-12,25 34,48 12,59 -34,36" fill="rgb(244,150,130)"/><polygon points="-34,44 12,67 12,59 -34,36" fill="rgb(227,123,100)"/><polygon points="34,56 12,67 12,59 34,48" fill="rgb(193,104,85)"/><polygon points="-5,23.5 17,34.5 1,42.5 -21,31.5" fill="rgb(244,150,130)"/><polygon points="-21,39.5 1,50.5 1,42.5 -21,31.5" fill="rgb(227,123,100)"/><polygon points="17,42.5 1,50.5 1,42.5 17,34.5" fill="rgb(193,104,85)"/><polygon points="17,42.5 1,50.5 1,43.5 17,35.5" fill="#E6F4F6"/><polygon points="-18,40 -1,48.5 -1,43.5 -18,35" fill="#DDEDF2"/><polygon points="-25,43.5 -18,47 -22,49 -29,45.5" fill="rgb(98,93,130)"/><polygon points="-29,50.5 -22,54 -22,49 -29,45.5" fill="rgb(64,59,100)"/><polygon points="-18,52 -22,54 -22,49 -18,47" fill="rgb(55,50,85)"/><polygon points="1,56.5 8,60 4,62 -3,58.5" fill="rgb(98,93,130)"/><polygon points="-3,63.5 4,67 4,62 -3,58.5" fill="rgb(64,59,100)"/><polygon points="8,65 4,67 4,62 8,60" fill="rgb(55,50,85)"/><polygon points="30,55 25,57.5 25,54.5 30,52" fill="#FFF3C9"/>`;
function RealLogo({width=40}){ return <svg width={width} height={Math.round(width*182/320)} viewBox="-145 -44 320 182" aria-hidden="true" dangerouslySetInnerHTML={{__html:LOGO_INNER}}/>; }

// Three presentations of the SAME audit data, toggled in-place: #24 deck
// (one card at a time, natural height), #17 heatmap (the 10-point audit as a
// grid, hot = flagged), #18 sidebar (rail + wide panel). A VERDICT cover leads;
// EVIDENCE (signature + Internet Archive snapshot) and SAY-THIS close it. Money
// items glow cyan. Email + copy-link live in here so these views are self-serve.
// #21 "Drone Delivery" — Vic's pick (2026-08-14) from the 35-concept 3D
// email-sent gallery: a quadcopter carries the envelope across the
// confirmation row, rotors blurring, hovers a beat mid-flight, then exits
// right. Plays ONCE per send (it mounts only when emailStatus flips to
// "sent"), then the plain "Sent to …" text remains. Pure CSS transforms —
// no emoji glyphs (3D/animated-icons rule). Static under reduced-motion.
function DroneSentBeat({compact,body,accent}){
  const w=compact?72:96,h=compact?24:30,s=compact?.72:1;
  return (
    <span aria-hidden="true" style={{position:"relative",display:"inline-block",width:w,height:h,overflow:"hidden",verticalAlign:"middle",flex:"0 0 auto"}}>
      <style>{`
        @keyframes lcDroneX{0%{left:-58px}55%{left:calc(50% - 26px)}72%{left:calc(50% - 26px)}100%{left:110%}}
        @keyframes lcDroneBob{0%,100%{transform:translateY(0) scale(${s})}50%{transform:translateY(2.5px) scale(${s})}}
        @keyframes lcRotor{0%{transform:scaleX(1)}50%{transform:scaleX(.18)}100%{transform:scaleX(1)}}
        @keyframes lcSentFade{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
        @media (prefers-reduced-motion: reduce){
          .lcDroneTrack{animation:none !important;left:110% !important}
          .lcDroneRotor{animation:none !important}
          .lcSentFade{animation:none !important;opacity:1 !important;transform:none !important}
        }
      `}</style>
      <span className="lcDroneTrack" style={{position:"absolute",top:1,left:-58,animation:"lcDroneX 2.6s ease-in-out 1 forwards"}}>
        <span style={{display:"block",transformOrigin:"top center",animation:"lcDroneBob 1.1s ease-in-out infinite"}}>
          <span style={{display:"block",position:"relative",width:44,height:4,borderRadius:3,background:body}}>
            <span className="lcDroneRotor" style={{position:"absolute",top:-5,left:-6,width:20,height:3,borderRadius:2,background:accent,animation:"lcRotor .16s linear infinite"}}/>
            <span className="lcDroneRotor" style={{position:"absolute",top:-5,right:-6,width:20,height:3,borderRadius:2,background:accent,animation:"lcRotor .16s linear infinite"}}/>
            <span style={{position:"absolute",top:4,left:21,width:1.5,height:5,background:body}}/>
            <span style={{position:"absolute",top:9,left:14,width:16,height:11,borderRadius:2,border:`1.2px solid ${accent}`,background:"rgba(34,211,238,.08)"}}>
              <span style={{position:"absolute",inset:0,background:`linear-gradient(to bottom right,transparent 44%,${accent} 48%,transparent 54%),linear-gradient(to bottom left,transparent 44%,${accent} 48%,transparent 54%)`,opacity:.7}}/>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

function ReportViews({ analysis: a, view, onView, onExit, onShare, copied, shared, ink, emailInput, setEmailInput, emailStatus, emailErr, setEmailErr, onSend }){
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 80); return () => clearTimeout(t); }, []);

  const money = (n) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "—" : "$" + Math.round(v).toLocaleString("en-CA"); };
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0, delta = (qp && ms) ? qp - ms : 0;
  // Only an EXACT trim MSRP supports an over/under claim. A "starting_at" floor
  // (base trim / adjacent model year) is a reference, not this unit's sticker —
  // an option-loaded car above the base floor is NOT "over MSRP".
  const msrpExact = isExactMsrp(a);
  const deltaOk = !!(qp && ms && msrpExact);
  // Derived once here and read by BOTH the rebate card and its plain-language
  // explainer below — the two used to read a server field that is never set.
  const evap = resolveEvap(a);
  // "Contact Us For Price" — the page deliberately withholds the number
  // (detected from the page's own call-to-action text). A tactic, not a miss.
  const priceGated = !qp && a.priceDisclosure === "contact_for_price";
  const priceVerified = a.priceVerified !== undefined ? !!a.priceVerified : (qp > 0);
  const score = (a.leverageScore && a.leverageScore.score != null) ? Math.max(0, Math.min(10, Number(a.leverageScore.score) || 0)) : null;
  const fr = score != null ? score / 10 : 0;
  const CIRC = 314.159, fillOffset = CIRC * (1 - fr), needleDeg = -90 + fr * 180;
  const rno = a.reportId || "LC-—";
  const issued = a.issuedAt ? new Date(a.issuedAt) : null;
  const verifyHref = (typeof verifyLinkFor === "function") ? verifyLinkFor(a) : null;

  const CY = "#22d3ee", TEAL = "#10b981", ROSE = "#f43f5e", AMBER = "#fbbf24", TX = "#e2e8f0", MUT = "#64748b", MUT2 = "#94a3b8", BORD = "#1e293b";
  const mono = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  const flagged = (a.addOns || []).filter((x) => x.verdict === "flagged");
  const flaggedTotal = Number(a.totalFlaggedCost) || flagged.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const klabel = { fontSize: 12, color: MUT2, textTransform: "uppercase", letterSpacing: ".08em", fontFamily: mono };
  const scoreColor = score == null ? CY : score >= 7 ? TEAL : score >= 4 ? AMBER : ROSE;
  const linkBtn = { fontSize: 12.5, fontFamily: mono, color: CY, textDecoration: "none", border: "1px solid rgba(34,211,238,.35)", borderRadius: 999, padding: "7px 13px", background: "rgba(8,51,68,.25)", whiteSpace: "nowrap", cursor: "pointer" };

  const [vCopied, setVCopied] = useState(false);
  const sourceUrl = a.sourceUrl || a.listingUrl || null;
  const capturedAt = a.capturedAt ? new Date(a.capturedAt) : issued;
  const archiveViewUrl = sourceUrl ? "https://web.archive.org/web/2999/" + sourceUrl : null; // far-future ts -> latest capture (not the calendar)
  const listingShot = a.listingShot || null;
  // #14 photo proof lock: recompute the displayed screenshot's SHA-256 in the
  // browser and compare against the hash sealed in the signature.
  const [shotSealOk, setShotSealOk] = useState(null); // true | false | null (no photo / not checkable)
  useEffect(() => {
    if (!(a.listingShot && a.listingShotSha256)) { setShotSealOk(null); return; }
    (async () => {
      try {
        const b64 = String(a.listingShot).split(",")[1] || "";
        const bin = atob(b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dig = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
        setShotSealOk(hex === a.listingShotSha256);
      } catch { setShotSealOk(null); }
    })();
  }, [a.listingShot, a.listingShotSha256]);

  useEffect(() => { if (!sourceUrl) return; try { fetch("https://web.archive.org/save/" + sourceUrl, { mode: "no-cors" }).catch(() => {}); } catch (e) {} }, [sourceUrl]);

  const Chip = ({ txt, tone }) => { const c = tone === "flag" ? ROSE : tone === "pass" ? TEAL : MUT2; const bg = tone === "flag" ? "rgba(244,63,94,.14)" : tone === "pass" ? "rgba(16,185,129,.14)" : "rgba(148,163,184,.12)"; return <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 700, color: c, background: bg, border: `1px solid ${c}55`, borderRadius: 8, padding: "4px 10px", margin: "0 6px 6px 0", fontFamily: mono }}>{txt}</span>; };
  const KV = ({ k, v, c }) => (<div><div style={{ color: MUT, fontSize: 11, fontFamily: mono }}>{k}</div><div style={{ fontSize: 24, fontWeight: 700, color: c || "#fff", fontFamily: mono, marginTop: 4 }}>{v}</div></div>);
  const Simple = ({ big, c, note }) => (<div><div style={{ fontSize: 20, fontWeight: 800, fontFamily: mono, color: c || "#fff" }}>{big}</div>{note && <div style={{ fontSize: 12.5, color: MUT2, marginTop: 8, lineHeight: 1.55 }}>{note}</div>}</div>);

  const verdictBody = (
    <div style={{ textAlign: "center" }}>
      {score != null ? (<>
        <div style={{ position: "relative", width: 200, maxWidth: "100%", margin: "0 auto" }}>
          <svg viewBox="0 0 220 132" style={{ display: "block", width: "100%", height: "auto", overflow: "visible" }}>
            <path d="M 10 120 A 100 100 0 0 1 210 120" fill="none" stroke={BORD} strokeWidth="14" strokeLinecap="round" />
            <path d="M 10 120 A 100 100 0 0 1 210 120" fill="none" stroke={scoreColor} strokeWidth="14" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={mounted ? fillOffset : CIRC} style={{ transition: "stroke-dashoffset 1.3s cubic-bezier(.4,0,.2,1)", filter: `drop-shadow(0 0 6px ${scoreColor}88)` }} />
            <g style={{ transformOrigin: "110px 120px", transform: mounted ? `rotate(${needleDeg}deg)` : "rotate(-90deg)", transition: "transform 1.3s cubic-bezier(.34,1.4,.5,1)" }}><line x1="110" y1="120" x2="110" y2="34" stroke="#f8fafc" strokeWidth="3" strokeLinecap="round" /></g>
            <circle cx="110" cy="120" r="6" fill="#e2e8f0" /><circle cx="110" cy="120" r="2.5" fill="#0b1220" />
          </svg>
        </div>
        <div style={{ fontSize: 40, fontWeight: 800, color: "#fff", lineHeight: 1, fontFamily: mono, marginTop: -6 }}>{score.toFixed(1)}<span style={{ fontSize: 16, color: MUT }}>/10</span></div>
        <div style={{ fontSize: 11, color: MUT, letterSpacing: ".12em", textTransform: "uppercase", marginTop: 6, fontFamily: mono }}>Negotiation leverage</div>
      </>) : <div style={{ padding: "24px 0", color: MUT, fontSize: 13 }}>Leverage score isn't available.</div>}
      {(qp || ms) > 0 && <div style={{ marginTop: 16, fontFamily: mono, fontSize: 14, fontWeight: 700, color: deltaOk && delta > 0 ? ROSE : TEAL }}>{qp ? money(qp) + " asking" : ""}{deltaOk ? (delta === 0 ? " · at MSRP" : delta > 0 ? ` · ▲ ${money(delta)} over MSRP` : ` · ▼ ${money(-delta)} under MSRP`) : (ms ? ` · base MSRP from ${money(ms)}` : "")}</div>}
      <div style={{ marginTop: 14 }}>
        {flagged.length > 0 && <Chip txt={`⚠ ${flagged.length} watch-out${flagged.length > 1 ? "s" : ""}`} tone="flag" />}
        {a.recalls?.checked && a.recalls.count > 0 && <Chip txt={`⚠ ${a.recalls.count} recall${a.recalls.count > 1 ? "s" : ""}`} tone="flag" />}
        {a.recalls?.checked && a.recalls.count === 0 && a.recalls.confirmed !== false && <Chip txt="✓ No recalls" tone="pass" />}
        {a.vinCheck?.present && a.vinCheck.valid && <Chip txt="✓ VIN valid" tone="pass" />}
      </div>
      {a.summary && <div style={{ marginTop: 14, fontSize: 13.5, lineHeight: 1.6, color: "#e2e8f0", fontStyle: "italic", borderTop: `1px solid ${BORD}`, paddingTop: 14, textAlign: "left" }}>{a.summary}</div>}
    </div>
  );

  // ── the canonical 10-point audit — always 10, each with its result + body ──
  const P = [];
  // 1 Price vs MSRP
  P.push({ title: "Price vs MSRP", tone: priceGated ? "flag" : !priceVerified ? "flag" : (!ms ? "muted" : (deltaOk ? (delta > 0 ? "flag" : "pass") : "muted")), v: priceGated ? "HIDDEN BY DEALER" : deltaOk ? (delta === 0 ? "AT MSRP" : delta > 0 ? money(delta) + " OVER" : money(-delta) + " UNDER") : (ms ? "FROM " + money(ms) : (priceVerified ? "—" : "UNVERIFIED")),
    body: <div><div style={{ fontSize: 26, fontWeight: 800, fontFamily: mono, color: (priceGated || !priceVerified) ? ROSE : (deltaOk && delta > 0 ? ROSE : TEAL) }}>{priceGated ? "Hidden by the dealer" : deltaOk ? (delta === 0 ? "At MSRP" : delta > 0 ? money(delta) + " over" : money(-delta) + " under") : (qp ? money(qp) : "Not shown")}</div><div style={{ fontSize: 13, color: MUT2, marginTop: 6 }}>{qp ? money(qp) : "—"}{deltaOk ? ` vs ${money(ms)} MSRP` : (()=>{const cc=qualifyCeilingClaim(a);if(a.allInPricing && cc.floor && cc.ceiling) return ` · ${a.make || "the manufacturer"} sells this model from ${money(cc.floor)} to ${money(cc.ceiling)} all-in`;return ms ? ` · base MSRP from ${money(ms)} — this unit's options are extra, so no over/under-MSRP claim is made` : "";})()} · {priceVerified ? "price verified" : "price not verified"}</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 18 }}><KV k={a.allInPricing ? "ASKING PRICE · ALL-IN" : "ASKING PRICE"} v={qp ? money(qp) : "—"} />{(()=>{const cc=qualifyCeilingClaim(a);if(a.allInPricing && cc.floor && cc.ceiling && !msrpExact) return <KV k={`${a.make || "MSRP"} ALL-IN RANGE`.toUpperCase()} v={cc.floor===cc.ceiling?money(cc.ceiling):`${money(cc.floor)}–${money(cc.ceiling)}`} c={MUT2} />;return <KV k={a.msrpBasis === "original_when_new" ? "MSRP WHEN NEW" : a.msrpBasis === "dealer_stated" ? "MSRP · AS STATED BY DEALER" : a.msrpBasis === "starting_at" ? `MSRP · STARTING AT${a.msrpYear && a.msrpYear !== a.year ? ` (${a.msrpYear} MY)` : ""}` : (a.msrpTrim ? `MSRP · ${String(a.msrpTrim).toUpperCase()}` : (msrpExact ? "MSRP" : "CATALOG MSRP"))} v={ms ? money(ms) : "—"} c={msrpExact ? "#fff" : MUT2} />;})()}</div>{a.msrpBasis === "original_when_new" && a.originalMsrp && <div style={{ fontSize: 12, color: MUT2, marginTop: 10, lineHeight: 1.55 }}>That MSRP is what this {a.originalMsrp.year || a.year} {a.model || "vehicle"}{a.originalMsrp.trim ? ` (${a.originalMsrp.trim})` : ""} cost <strong style={{ color: "#fff" }}>when new</strong> — useful context, but it is not a sticker to measure a used price against, so no over/under-MSRP claim is made.</div>}{(()=>{const cc=qualifyCeilingClaim(a); if(!cc.exceeds) return null; return <div style={{ fontSize: 12.5, color: ROSE, marginTop: 12, lineHeight: 1.6, padding: "10px 12px", background: "rgba(242,131,107,.10)", borderRadius: 9, border: "1px solid rgba(242,131,107,.35)" }}><strong style={{ color: "#fff" }}>Above every trim {a.make || "the manufacturer"} sells.</strong> The most expensive {a.year} {a.model}{cc.trim ? ` (${cc.trim})` : ""} is <strong style={{ color: "#fff" }}>{money(cc.ceiling)}</strong> all-in, including the maximum dealer fee. This listing is <strong style={{ color: "#fff" }}>{money(cc.over)}</strong> above that ceiling — a figure that holds whichever trim this turns out to be, because there is no higher grade to compare it to.</div>;})()}{a.msrpUnavailable && <div style={{ fontSize: 12, color: MUT2, marginTop: 10, lineHeight: 1.55 }}>{a.msrpUnavailable.note}</div>}{a.msrpBasis === "dealer_stated" && <div style={{ fontSize: 12, color: "#f0997b", marginTop: 10, lineHeight: 1.55 }}>This MSRP is the figure <strong>this dealer states on their own page</strong> — we could not verify it against {a.make || "the manufacturer"}'s published price, so no over/under-MSRP claim is made from it. Ask for the factory build sheet showing how it is made up.</div>}{a.msrpReference && a.msrpReference.msrp > 0 && <div style={{ fontSize: 12, color: MUT2, marginTop: 8, lineHeight: 1.55 }}>For reference, {a.msrpReference.make || "the manufacturer"} publishes this model{a.msrpReference.trim ? ` (${a.msrpReference.trim})` : ""} from <strong style={{ color: "#fff" }}>{money(a.msrpReference.msrp)}</strong>. Options, drivetrain and packages sit above that — ask which ones account for the difference.{a.msrpReference.sourceUrl ? <> <a href={a.msrpReference.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: CY }}>See their page ↗</a></> : null}</div>}{msrpExact && a.allInPricing && a.allInPricing.body && a.msrpPriceBasis !== "incl_freight" && <div style={{ fontSize: 12, color: MUT2, marginTop: 10, lineHeight: 1.55 }}>Basis note: the asking price is <strong style={{ color: "#fff" }}>all-in</strong> ({a.allInPricing.body}), while a published MSRP normally <strong style={{ color: "#fff" }}>excludes freight &amp; PDI</strong> (typically $2,000–$2,600). Part of the gap above is that freight — ask the dealer to show freight and PDI as their own line.</div>}{a.msrpSourceUrl && <div style={{ marginTop: 10 }}><a href={a.msrpSourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: CY, textDecoration: "underline" }}>See the manufacturer's own page for this MSRP ↗</a></div>}{a.allInPricing && a.allInPricing.body && <div style={{ fontSize: 12, color: MUT2, marginTop: 14, lineHeight: 1.55 }}>Asking price is the <strong style={{ color: "#fff" }}>all-in total</strong> — {a.allInPricing.body} all-in advertising folds every mandatory fee into the posted price. The only things that can be added at signing are GST, licensing &amp; insurance.</div>}{a.msrpInflation && a.msrpInflation.dealerStated && <div style={{ fontSize: 12, color: ROSE, marginTop: 12, lineHeight: 1.55 }}>⚠ Dealer advertises MSRP at <strong>{money(a.msrpInflation.dealerStated)}</strong>, but {a.make || "the manufacturer"}&rsquo;s MSRP for this trim is <strong style={{ color: "#fff" }}>{money(a.msrpInflation.manufacturer)}</strong> — the sticker is inflated {money(a.msrpInflation.overBy)}, so any advertised &ldquo;saving&rdquo; is measured against a padded number. Price vs MSRP above uses the true manufacturer figure.</div>}</div> });
  // 2 Recalls
  { const r = a.recalls; const tone = !r?.checked ? "muted" : r.count > 0 ? "flag" : (r.confirmed === false ? "muted" : "pass"); const v = !r?.checked ? "COULDN'T VERIFY" : r.count > 0 ? r.count + " OPEN" : (r.confirmed === false ? "UNCONFIRMED" : "NONE OPEN");
    let body; if (!r?.checked) body = <Simple big="Couldn't reach the registry" c={MUT2} note="Check open recalls by VIN at Transport Canada before you sign." />;
    else if (r.count > 0) body = <div><div style={{ fontSize: 24, fontWeight: 800, color: ROSE, fontFamily: mono }}>{r.count} open recall{r.count > 1 ? "s" : ""}</div>{(r.items || []).slice(0, 4).map((it, i) => (<div key={i} style={{ padding: "9px 0", borderTop: `1px solid ${BORD}` }}><div style={{ fontSize: 13, fontWeight: 700, color: ROSE }}>{it.system || "Recall"}{it.date && !Number.isNaN(new Date(it.date).getFullYear()) ? ` · ${new Date(it.date).getFullYear()}` : ""}</div>{it.summary && <div style={{ fontSize: 12, color: MUT2, marginTop: 3, lineHeight: 1.5 }}>{it.summary}</div>}</div>))}<div style={{ fontSize: 11, color: MUT, marginTop: 10 }}>Repaired free of charge — confirm the fix status by VIN before you sign.</div></div>;
    else if (r.confirmed === false) body = <Simple big="Couldn't confirm this exact model" c={AMBER} note="Not an all-clear — check open recalls by VIN at Transport Canada before you sign." />;
    else body = <Simple big="✓ No open recalls found" c={TEAL} note="Transport Canada's registry shows none for this year/make/model." />;
    P.push({ title: "Transport Canada recalls", tone, v, body }); }
  // 3 Add-ons & fees
  { const tone = flagged.length ? "flag" : (a.addOns || []).length ? "pass" : "muted"; const v = flagged.length ? flagged.length + " FLAGGED" : (a.addOns || []).length ? "TRANSPARENT" : "NONE LISTED";
    const body = (a.addOns || []).length ? <div>{flagged.length > 0 && <div style={{ fontSize: 22, fontWeight: 800, color: ROSE, fontFamily: mono, marginBottom: 10 }}>{money(flaggedTotal)} · {flagged.length} to question</div>}{(a.addOns || []).map((x, i) => (<div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: i > 0 ? `1px solid ${BORD}` : "none" }}><div><div style={{ fontSize: 14, color: "#e2e8f0" }}>{x.verdict === "flagged" ? "🔻 " : ""}{x.name}</div>{x.reason && <div style={{ fontSize: 12, color: MUT2, marginTop: 2, lineHeight: 1.5 }}>{x.reason}</div>}</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: mono, whiteSpace: "nowrap", color: x.verdict === "flagged" ? ROSE : "#e2e8f0" }}>{money(x.price)}</div></div>))}</div> : <Simple big="None listed" c={MUT2} note="No dealer add-ons or fees were itemized on this quote." />;
    P.push({ title: "Add-ons & fee audit", tone, v, body }); }
  // 4 Financing APR
  { const dr = a.financeRates?.dealer?.apr, mr = a.financeRates?.manufacturer?.apr, high = dr != null && mr != null && dr - mr > 0.1; const price = qp || ms || 0; let extra = null; if (high && price) { const rd = dr / 1200, rm = mr / 1200; extra = Math.round((price * rd / (1 - Math.pow(1 + rd, -60)) - price * rm / (1 - Math.pow(1 + rm, -60))) * 60); }
    const fSuf = { weekly: "/wk", biweekly: "/2wk", monthly: "/mo" }; const tone = high ? "flag" : "muted"; const v = dr != null ? dr + "%" + (high ? " HIGH" : "") : (mr != null ? mr + "% OEM REF" : "NONE ADVERTISED");
    const body = (dr != null || a.financing?.paymentAmount) ? <div>{a.financing?.paymentAmount && <div style={{ fontSize: 24, fontWeight: 800, fontFamily: mono, color: "#fff" }}>{money(a.financing.paymentAmount)}<span style={{ fontSize: 14, color: MUT2 }}>{fSuf[a.financing.paymentFrequency] || ""}</span></div>}{dr != null && <div style={{ fontSize: a.financing?.paymentAmount ? 16 : 24, fontWeight: 800, fontFamily: mono, color: high ? ROSE : "#fff", marginTop: a.financing?.paymentAmount ? 6 : 0 }}>{dr}%<span style={{ fontSize: 13, color: high ? ROSE : MUT2, fontWeight: 700 }}> {high ? "· high" : "· this dealer"}</span></div>}{high ? <div style={{ fontSize: 13.5, color: "#e2e8f0", marginTop: 10, lineHeight: 1.6 }}>{(dr - mr).toFixed(2)}% above {a.make || "the manufacturer"}'s advertised {mr}%{extra ? <> — about <b style={{ color: ROSE }}>{money(extra)}</b> more over 60 months</> : null}. Ask them to match it.</div> : (mr != null ? <div style={{ fontSize: 12.5, color: MUT2, marginTop: 8 }}>{a.make || "Manufacturer"} advertises {mr}% on new.</div> : null)}</div> : <Simple big="Not shown" c={MUT2} note="No financing rate was quoted." />;
    P.push({ title: "Financing APR", tone, v, body }); }
  // 5 Financing math
  { const fc = a.financingCheck; const tone = fc?.checked ? (fc.consistent ? "pass" : "flag") : "muted"; const v = fc?.checked ? (fc.consistent ? "RECONCILES" : "DOESN'T ADD UP") : "NOT CHECKED";
    P.push({ title: "Financing math", tone, v, body: <Simple big={fc?.checked ? (fc.consistent ? "✓ Payments reconcile" : "⚠ Numbers don't add up") : "Not checked"} c={fc?.checked ? (fc.consistent ? TEAL : ROSE) : MUT2} note={fc?.note || (fc?.checked ? "The advertised payment, price, rate and term were cross-checked." : "Not enough financing detail was published to re-check the math.")} /> }); }
  // 6 Odometer
  { const o = a.odometerCheck; const isNew = a.vehicleCondition === "new"; const tone = o?.checked ? (o.flag ? "flag" : "pass") : "muted"; const v = o?.checked ? Number(o.km).toLocaleString() + " km" + (o.flag ? " FLAG" : "") : (isNew ? "N/A (NEW)" : "NOT ON QUOTE");
    P.push({ title: "Odometer", tone, v, body: <Simple big={o?.checked ? Number(o.km).toLocaleString() + " km" : (isNew ? "N/A — new vehicle" : "Not on quote")} c={o?.flag ? ROSE : "#fff"} note={o?.note || (isNew ? "New vehicles carry delivery-only mileage." : "No odometer reading was on this quote.")} /> }); }
  // 7 VIN
  { const vc = a.vinCheck; const tone = vc?.present ? (vc.valid ? "pass" : "flag") : "muted"; const v = vc?.present ? (vc.valid ? "VALID" : "CHECK PATTERN") : "NOT ON QUOTE";
    P.push({ title: "VIN check", tone, v, body: <Simple big={vc?.present ? (vc.valid ? "✓ Valid VIN pattern" : "⚠ VIN doesn't validate") : "Not on quote"} c={vc?.present ? (vc.valid ? TEAL : ROSE) : MUT2} note={vc?.vin ? "VIN " + vc.vin : "No VIN was listed to check."} /> }); }
  // 8 EV / PHEV rebate — via resolveEvap so this panel can never disagree with
  // the scroll view or the emailed report (it used to read a server field that
  // was never populated, rendering a dead "—" on every EV).
  { const ev = evap.rebate, eft = evap.effectiveFuelType;
    const notEv = !!eft && eft !== "BEV" && eft !== "PHEV";
    const tone = ev?.eligible ? "pass" : "muted";
    const v = ev?.eligible ? money(ev.total) + " ELIGIBLE" : (ev?.ineligibleReason ? "NOT ELIGIBLE" : notEv ? `N/A (${String(eft).toUpperCase()})` : "NOT DETERMINED");
    P.push({ title: "EV / PHEV rebate", tone, v, body: <Simple big={ev?.eligible ? money(ev.total) + " available" : (ev?.ineligibleReason ? "Not eligible" : notEv ? `N/A — ${String(eft).toLowerCase()} vehicle` : "Not determined")} c={ev?.eligible ? TEAL : MUT2} note={ev?.ineligibleReason || (ev?.eligible ? `${money(ev.federal)} federal${ev.provincial > 0 ? " + " + money(ev.provincial) + " provincial" : ""}` : notEv ? "Federal and provincial EV incentives don't apply to this drivetrain." : "We couldn't confirm this vehicle's drivetrain from the listing, so no rebate claim is made — ask the dealer to confirm it in writing.")} /> }); }
  // 9 Included warranty
  { const w = a.standardWarranty; const tone = w?.coverage ? "pass" : "muted"; const v = w?.coverage ? "INCLUDED" : "NOT SHOWN";
    P.push({ title: "Included warranty", tone, v, body: <Simple big={w?.coverage ? "✓ Manufacturer warranty" : "Not shown"} c={w?.coverage ? TEAL : MUT2} note={w?.coverage || "No standard warranty coverage was stated on the quote."} /> }); }
  // 10 Dealer reputation
  { const d = a.dealerSentiment; const tone = d?.rating ? (Number(d.rating) >= 4 ? "pass" : "muted") : "muted"; const v = d?.rating ? Number(d.rating).toFixed(1) + "★ / " + Number(d.reviewCount || 0).toLocaleString() : "NOT FOUND";
    const body = d?.rating ? <div><div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>★ {Number(d.rating).toFixed(1)}<span style={{ fontSize: 12, color: MUT2, fontWeight: 600 }}>{d.reviewCount ? ` · ${Number(d.reviewCount).toLocaleString()} Google reviews` : ""}</span></div>{(d.highlights || []).slice(0, 3).map((h, i) => (<div key={i} style={{ padding: "7px 0", borderTop: `1px solid ${BORD}`, fontSize: 12.5, color: "#e2e8f0", lineHeight: 1.5 }}><span style={{ color: TEAL, fontWeight: 700 }}>★{h.rating}</span> {h.text}</div>))}</div> : <Simple big="Not found" c={MUT2} note="No public Google reviews were located for this dealer." />;
    P.push({ title: "Dealer reputation", tone, v, body }); }

  // ── "What this means" — every card carries a plain-language translation of
  // its data, written for a first-time buyer (no jargon). Deterministic: built
  // from the same verified fields the card shows, never free-styled, so the
  // explanation can't drift from the evidence (claims-must-stay-backed).
  const explainFor = {
    "Price vs MSRP": priceGated
      ? `The dealer chose not to publish a price — the page says "contact us" instead. That's a lead-capture tactic: they want you on the phone, where their salespeople control the conversation.${ms && isManufacturerFigure(a.msrpBasis) ? ` Your anchor is ${a.make || "the manufacturer"}'s MSRP, starting at ${money(ms)}.` : ""} Don't negotiate blind — get their full all-in price in writing before you visit.`
      : !qp
      ? "We couldn't read an asking price off this listing, so there's nothing to compare yet. Get the full price in writing from the dealer before anything else."
      : deltaOk
        ? (delta > 0
          ? `MSRP is the manufacturer's own sticker price for this exact version of the car. This dealer is asking ${money(delta)} MORE than that sticker. Anything over sticker is pure negotiation room.`
          : delta === 0
            ? "MSRP is the manufacturer's own sticker price for this exact version of the car. This dealer is asking exactly the sticker — not a markup, but not a deal either."
            : `MSRP is the manufacturer's own sticker price for this exact version of the car. This dealer is asking ${money(-delta)} BELOW that sticker — a real discount, worth confirming nothing was added back in fees.`)
        : ms
          ? `The manufacturer's price for this model STARTS at ${money(ms)} for the base version. This exact car has extra options on top, so we don't call it "over" or "under" — use the base number as your reference point and make the dealer justify everything above it.`
          : "We couldn't verify the manufacturer's sticker price for this exact car, so no over/under comparison is made — never trust a 'savings' claim you can't check.",
    "Transport Canada recalls": a.recalls?.checked && a.recalls.count > 0
      ? `A recall means the manufacturer found a safety defect and must fix it FREE of charge. This vehicle's model has ${a.recalls.count} unfixed recall${a.recalls.count > 1 ? "s" : ""} on record — tell the dealer to complete the repair before you take delivery. It costs you nothing.`
      : a.recalls?.checked && a.recalls.confirmed !== false
        ? "A recall means the manufacturer found a safety defect they must fix for free. Canada's government registry shows none outstanding for this model — a clean bill on this point."
        : "We couldn't confirm this exact model in the government recall registry, so don't treat this as an all-clear — check by VIN at Transport Canada (free) before signing.",
    "Add-ons & fee audit": (a.addOns || []).length
      ? "These are things the DEALER added on top of the car's price — packages, accessories, protection products. They're where dealers make extra margin, and you can say no to most of them. Every line here is one you're allowed to question."
      : "The listing doesn't itemize any dealer extras. That doesn't mean there are none — ask for the full out-the-door breakdown in writing before you agree to anything.",
    "Financing APR": a.financeRates?.dealer?.apr != null
      ? `APR is the yearly interest rate on the loan. This dealer advertises ${a.financeRates.dealer.apr}% — compare it against your own bank or credit union before accepting, because dealer rates often carry hidden markup.`
      : "The listing doesn't advertise a financing rate. Get the APR in writing and compare it with your own bank before you sign anything in the finance office.",
    "Financing math": a.financingCheck?.checked
      ? (a.financingCheck.consistent
        ? "We recomputed the advertised payment from the price, rate and term — the numbers line up. No hidden amount is baked into the payment."
        : "We recomputed the advertised payment from the price, rate and term — and they DON'T line up. Something extra is baked into the payment. Ask them to show the calculation line by line.")
      : "The listing doesn't show enough financing detail (payment, term and total) for us to re-check the math. Ask for all three in writing — then the payment can be verified.",
    "Odometer": a.odometerCheck?.checked
      ? `This is how far the car has actually been driven: ${Number(a.odometerCheck.km).toLocaleString()} km. ${a.vehicleCondition === "new" ? "A truly new car should be near zero — anything in the thousands means it's been driven (demo/loaner) and should be priced below new." : "Compare it against the age of the car — roughly 15,000–20,000 km per year is typical."}`
      : "No odometer reading was shown. Always read it off the dash yourself before signing — never off the paperwork alone.",
    "VIN check": a.vinCheck?.present
      ? "The VIN is the car's unique fingerprint. This one has a valid format — before you sign, match it against the plate at the base of the windshield so the paperwork is for THIS exact car."
      : "The listing doesn't show the VIN (the car's unique fingerprint). Ask for it — it lets you verify recalls, history and that the paperwork matches the actual car.",
    "EV / PHEV rebate": evap.rebate?.eligible
      ? `Government money you may qualify for on this vehicle: ${money(evap.rebate.total)}. The dealer doesn't control this — it's a federal/provincial program. Make sure it's applied on top of your negotiated price, not instead of a discount.`
      : evap.show
        ? "This electric/plug-in vehicle doesn't qualify for the federal rebate (usually the price cap or the model list). Don't let anyone imply a government discount that isn't there."
        : evap.effectiveFuelType
          ? `Rebates only apply to electric and plug-in vehicles — this one is ${String(evap.effectiveFuelType).toLowerCase()}, so there's no government money in play.`
          : "We couldn't confirm this vehicle's drivetrain from the listing, so we make no rebate claim either way — ask the dealer to state it in writing.",
    "Included warranty": a.standardWarranty?.coverage
      ? "Every new vehicle already includes the manufacturer's factory warranty at no charge — shown here. When the finance office pitches an 'extended warranty,' remember this coverage is already yours for free."
      : "We couldn't confirm the factory warranty terms from this listing. Every new vehicle includes one — ask exactly what's covered and for how long, in writing, before considering any paid coverage.",
    "Dealer reputation": a.dealerSentiment?.rating
      ? `This is the dealer's public Google rating from real customers — ${Number(a.dealerSentiment.rating).toFixed(1)} stars over ${Number(a.dealerSentiment.reviewCount || 0).toLocaleString()} reviews. It tells you how they treat people after the handshake.`
      : "We couldn't find public reviews for this dealer. That's not a red flag by itself — but walk in knowing you have no track record to lean on.",
  };
  const ExplainBox = ({ txt }) => txt ? (
    <div style={{ marginTop: 16, background: "rgba(34,211,238,.06)", border: `1px solid rgba(34,211,238,.25)`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: CY, fontWeight: 800, marginBottom: 6 }}>What this means</div>
      <div style={{ fontSize: 13, color: "#dbeafe", lineHeight: 1.65 }}>{txt}</div>
    </div>
  ) : null;

  const pointItems = P.slice(0, 10).map((p, i) => ({ key: "p" + i, title: p.title, tone: p.tone, v: p.v, glow: p.tone === "flag", point: true, body: (<>{p.body}<ExplainBox txt={explainFor[p.title]} /></>) }));

  const evidenceItem = { key: "evidence", title: "Evidence · dispute-proof", tone: "muted", glow: false, body: (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "#e2e8f0" }}>Report <b style={{ color: CY, fontFamily: mono }}>{rno}</b> is ECDSA-signed — change any figure and the ID stops matching.{capturedAt ? ` Checked ${capturedAt.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}` : ""}</div>
      {sourceUrl && <div style={{ fontSize: 12, color: MUT2, fontFamily: mono, wordBreak: "break-all" }}>Source: {sourceUrl}</div>}
      {listingShot && (
        <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
          {/* Collapsed proof: a small window onto the capture, not a page dump.
              The full image opens on demand (blob URL — browsers block direct
              data: navigation). The evidence is the HASH in the signature; the
              picture is there for when it matters, not to dominate the card. */}
          <div style={{ flex: "none", width: 120, height: 90, overflow: "hidden", borderRadius: 8, border: `1px solid ${shotSealOk === false ? ROSE : BORD}`, background: "#fff" }}>
            <img src={listingShot} alt="Listing at report time" style={{ width: "100%", objectFit: "cover", objectPosition: "top" }} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
            <div style={{ fontSize: 12.5, color: "#e2e8f0", lineHeight: 1.5 }}>Full-page capture of the listing, taken when this report was generated.</div>
            <button onClick={() => { try { const b64 = String(listingShot).split(",")[1] || ""; const mime = (String(listingShot).match(/^data:([^;]+)/) || [])[1] || "image/jpeg"; const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); const u = URL.createObjectURL(new Blob([bytes], { type: mime })); window.open(u, "_blank"); setTimeout(() => URL.revokeObjectURL(u), 60_000); } catch (e) {} }}
              style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${BORD}`, borderRadius: 999, padding: "6px 14px", color: CY, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              View full capture ↗
            </button>
          </div>
        </div>
      )}
      {a.listingShotSha256 && (
        <div style={{ fontSize: 11, fontFamily: mono, lineHeight: 1.5, color: shotSealOk === false ? ROSE : shotSealOk ? TEAL : MUT2 }}>
          {shotSealOk === false
            ? "This photo does NOT match the fingerprint sealed in the signature -- it was altered."
            : `Photo sealed in the signature · SHA-256 ${String(a.listingShotSha256).slice(0, 12)}...${shotSealOk ? " · verified, matches this image" : ""} -- what the page looked like at report time, tamper-evident.`}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {verifyHref && <a href={verifyHref} target="_blank" rel="noopener noreferrer" style={linkBtn}>Verify report ↗</a>}
        {archiveViewUrl && <a href={archiveViewUrl} target="_blank" rel="noopener noreferrer" style={linkBtn}>Internet Archive snapshot ↗</a>}
        {verifyHref && <button onClick={() => { try { navigator.clipboard.writeText(verifyHref).then(() => { setVCopied(true); setTimeout(() => setVCopied(false), 2000); }).catch(() => {}); } catch (e) {} }} style={linkBtn}>{vCopied ? "Verify link copied \u2713" : "Copy verify link"}</button>}
      </div>
      {a.disclaimerCheck && (
        <div style={{ borderTop: `1px solid ${BORD}`, paddingTop: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: AMBER, fontWeight: 800, marginBottom: 6 }}>The dealer's own fine print — captured</div>
          <div style={{ fontSize: 12, color: MUT2, lineHeight: 1.55, fontStyle: "italic" }}>"{String(a.disclaimerCheck.text).slice(0, 420)}{String(a.disclaimerCheck.text).length > 420 ? "…" : ""}"</div>
          <div style={{ fontSize: 12.5, color: "#e2e8f0", lineHeight: 1.6, marginTop: 8 }}>{a.disclaimerCheck.note}</div>
        </div>
      )}
      <div style={{ fontSize: 12, color: MUT, lineHeight: 1.6, borderTop: `1px solid ${BORD}`, paddingTop: 12 }}>LotCheck stores nothing. Your proof is this signed report plus an independent Internet Archive snapshot of the listing{sourceUrl ? " (preserved when this report was generated)" : ""} — so if the dealer edits the page later, the original still stands.{listingShot && a.verifyPayload && a.sig ? " Email the report to yourself and this capture rides along as its own photo file — drop that file on lotcheck.ca/verify anytime to prove it's untouched." : ""}
        <span style={{ display: "block", marginTop: 6 }}>Heads-up: dealer pages are app-style, so the archived copy often won't LOOK like the live site — that's normal. The page's code and data (price, dates, fine print) are preserved inside it either way{a.listingShot ? "; the sealed photo above is your visual copy" : ""}.</span>
      </div>
    </div>
  )};

  const cs = a.counterScript;
  const sayItem = (cs && Array.isArray(cs.moves) && cs.moves.length) ? { key: "say", title: cs.clean ? "★ Say this to confirm" : "★ Say this at the table", tone: "pass", glow: true, body: <div>{cs.moves.map((mv, i) => (<div key={i} style={{ fontSize: 14, color: "#e2e8f0", padding: "9px 0", borderTop: i > 0 ? `1px solid ${BORD}` : "none", lineHeight: 1.55 }}><b style={{ color: TEAL }}>{i + 1}.</b> {String(mv?.say || "")}</div>))}</div> } : null;

  // Days on lot — motivated-seller leverage from the dealer's OWN inventory
  // data (SM360 daysInInventory/dateEntry; later our observation network).
  // Uiverse-style 3D striped card (imtausef) with the traffic-light system:
  // ≤30 green · 31–89 amber · 90–119 red · 120+ blinking red. Only rendered
  // when real data exists — never estimated.
  let daysLotItem = null;
  if (a.daysOnLot && Number(a.daysOnLot.days) > 0) {
    const d = Number(a.daysOnLot.days);
    const dolMonths = d >= 60 ? (d / 30.4).toFixed(1).replace(/\.0$/, "") : null;
    const dolState = d >= 90 ? "red" : d >= 31 ? "amber" : "green";
    const ACC = dolState === "green" ? "#8ed500" : dolState === "amber" ? "#ffb020" : "#ff3b5c";
    const sinceD = a.daysOnLot.since ? new Date(a.daysOnLot.since + "T00:00:00") : null;
    const M3 = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const bulb = (on, color) => (
      <span key={color} style={{ display: "block", width: 14, height: 14, borderRadius: 999, margin: "4px auto", background: on ? color : "#2a2a2a", boxShadow: on ? `0 0 10px 2px ${color}` : "none" }} />
    );
    daysLotItem = { key: "dayslot", title: d >= 90 ? "⚠ Days on lot" : "Days on lot", tone: d >= 90 ? "flag" : (d >= 31 ? "muted" : "pass"), glow: d >= 90, body: (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <style>{`
          .lc-dol-parent { width: min(320px, 100%); perspective: 1000px; }
          .lc-dol-card { padding-top: 50px; border: 3px solid #141414; transform-style: preserve-3d;
            background: #ffffff;
            width: 100%; position: relative;
            box-shadow: rgba(0, 0, 0, 0.45) 0px 30px 30px -10px; transition: all 0.5s ease-in-out; }
          .lc-dol-card:hover { transform: rotate3d(0.5, 1, 0, 22deg); }
          .lc-dol-content { background: ${ACC}; transition: all 0.5s ease-in-out; padding: 56px 22px 22px 22px; transform-style: preserve-3d; }
          .lc-dol-title { display: inline-block; color: #141414; font-size: 24px; font-weight: 900; transform: translate3d(0,0,50px); transition: all .5s; }
          .lc-dol-text { margin-top: 10px; font-size: 12px; font-weight: 700; color: #141414; line-height: 1.55; transform: translate3d(0,0,30px); transition: all .5s; padding-right: 34px; }
          .lc-dol-chip { cursor: default; margin-top: 1rem; display: inline-block; font-weight: 900; font-size: 9px;
            text-transform: uppercase; color: ${ACC}; background: #141414; padding: 0.5rem 0.7rem; transform: translate3d(0,0,20px); }
          .lc-dol-datebox { position: absolute; top: 26px; right: 26px; height: 62px; width: 62px; background: #141414;
            border: 1px solid ${ACC}; padding: 8px 6px; transform: translate3d(0,0,80px); box-shadow: rgba(0,0,0,.35) 0 17px 10px -10px; z-index: 2; }
          .lc-dol-logo { position: absolute; top: 8px; left: 10px; transform: translate3d(0,0,80px); z-index: 2; }
          .lc-dol-light { position: absolute; top: 96px; right: 34px; background: #141414; border: 1px solid #2a2a2a;
            border-radius: 999px; padding: 5px 4px; transform: translate3d(0,0,70px); z-index: 2; }
        `}</style>
        <div className="lc-dol-parent">
          <div className="lc-dol-card">
            <div className="lc-dol-logo"><LogoMark size={34} /></div>
            <div className="lc-dol-datebox">
              {sinceD ? (<>
                <span style={{ display: "block", textAlign: "center", color: ACC, fontSize: 9, fontWeight: 700 }}>{M3[sinceD.getMonth()]} {sinceD.getFullYear()}</span>
                <span style={{ display: "block", textAlign: "center", color: ACC, fontSize: 20, fontWeight: 900 }}>{sinceD.getDate()}</span>
                <span style={{ display: "block", textAlign: "center", color: ACC, fontSize: 7, fontWeight: 700, letterSpacing: ".08em" }}>FIRST SEEN</span>
              </>) : (
                <span style={{ display: "block", textAlign: "center", color: ACC, fontSize: 18, fontWeight: 900, marginTop: 10 }}>{d}d</span>
              )}
            </div>
            <div className="lc-dol-light">
              {bulb(dolState === "red", "#ff3b5c")}
              {bulb(dolState === "amber", "#ffb020")}
              {bulb(dolState === "green", "#8ed500")}
            </div>
            <div className="lc-dol-content">
              <span className="lc-dol-title">{d.toLocaleString()} DAYS ON LOT</span>
              <div className="lc-dol-text">
                {dolMonths ? `About ${dolMonths} months` : `${d.toLocaleString()} days`} on the dealer's lot{a.daysOnLot.since ? ` — first seen ${a.daysOnLot.since}` : ""}. Source: {a.daysOnLot.sourceLabel || "dealer inventory data"}.
                {d >= 90
                  ? " Well past the typical turn window — every extra week costs the dealer real money. Concrete discount leverage."
                  : d >= 31
                    ? " A month-plus on the lot — worth asking what they'll do on price to move it."
                    : " Recently listed — limited sitting-time leverage on this unit."}
                {dolCareAsk(d)}
              </div>
              <span className="lc-dol-chip">{d >= 31 ? "Ask for a discount" : "Fresh on the lot"}</span>
            </div>
          </div>
        </div>
        <div style={{ width: "min(320px, 100%)" }}>
          <ExplainBox txt={`This is how long this exact car has been sitting unsold — ${d.toLocaleString()} days, counted by the dealer's own inventory system (not our guess). Dealers pay interest on unsold cars every single week, so the longer one sits, the more motivated they are to move it. ${d >= 90 ? "At this age, you're doing them a favour by buying it — negotiate like it." : d >= 31 ? "A month-plus of sitting is real carrying cost — reasonable grounds to ask for a better price." : "This one is fresh, so sitting-time won't move the price much yet."}${d >= 31 ? " A car that sits also sits mechanically — the oil clock, the 12-volt battery and the tires all run on time, which is why the card suggests asking what lot care was done." : ""}`} />
        </div>
      </div>
    )};
  }

  // S36 — trade-in instant-offer widget on the listing. Factual detection
  // (AccuTrade/TradePending/KBB ICO/CBB/generic) + the decoupling coach; the
  // counter-script "Trade-in" move ships from the server alongside it.
  let tradeInItem = null;
  if (a.tradeInWidget && a.tradeInWidget.detected) {
    const tv = a.tradeInWidget.vendor;
    tradeInItem = { key: "tradein", title: "Trade-in tool on this listing", tone: "muted", v: tv || "detected", body: (
      <div>
        <div style={{ fontSize: 13.5, color: "#e2e8f0", lineHeight: 1.6 }}>
          This listing embeds {tv ? <b>{tv}</b> : <b>a “value your trade” tool</b>} — an instant trade-in appraisal widget.
          The number it shows is anchored to the <b>wholesale</b> side of the market (what dealers pay each other),
          it is non-binding, and it appears in exchange for your contact and vehicle details.
        </div>
        <div style={{ fontSize: 13, color: "#e2e8f0", marginTop: 10, lineHeight: 1.65 }}>
          <div><b style={{ color: TEAL }}>1.</b> Settle this vehicle's price first — the trade comes after, never blended into one payment.</div>
          <div><b style={{ color: TEAL }}>2.</b> Get the trade offer in writing, on its own line of the bill of sale.</div>
          <div><b style={{ color: TEAL }}>3.</b> Know your own number first — check retail listings for your car before disclosing anything.</div>
        </div>
        <ExplainBox txt={`The "value your trade" button on this dealer's site runs an appraisal tool${tv ? ` (${tv})` : ""} that quotes what dealers pay at wholesale — usually thousands below what your car sells for at retail. It also isn't a promise: the number routinely drops at the in-person inspection. Treat it as the dealer's opening bid, keep it separate from the price of the car you're buying, and come armed with your own retail comparison.`} />
      </div>
    )};
  }

  // S37 — the advertised price is conditional on financing with the dealer.
  // This is a flag, not a muted note: the buyer paying cash or arriving with
  // their own bank approval believes they hold the strongest hand, and this is
  // the clause that quietly takes the discount back at signing. Evidence is the
  // page's own words, so it is the dealer's statement we are repeating.
  let financeContingentItem = null;
  if (a.financeContingent && a.financeContingent.contingent) {
    const F = a.financeContingent;
    financeContingentItem = { key: "fincontingent", title: "⚠ Price depends on financing with the dealer", tone: "flag", glow: true, v: "Conditional", body: (
      <div>
        <div style={{ fontSize: 13.5, color: "#e2e8f0", lineHeight: 1.6 }}>
          This listing's own wording ties the advertised price to taking <b>the dealer's financing</b>.
          Pay cash or use your own bank and the price can legitimately change — the discount is often funded by
          the dealer's commission on the loan, so it goes away with the loan.
        </div>
        <div style={{ fontSize: 12, color: MUT2, marginTop: 8, lineHeight: 1.55 }}>
          Detected: {F.reasons.join(" · ")}
        </div>
        {F.evidence && <div style={{ fontSize: 12, color: "#cbd5e1", marginTop: 8, padding: "8px 10px", borderLeft: `2px solid ${ROSE}`, background: "rgba(255,255,255,.03)", lineHeight: 1.5, fontStyle: "italic" }}>“…{F.evidence}…”</div>}
        <div style={{ fontSize: 13, color: "#e2e8f0", marginTop: 10, lineHeight: 1.65 }}>
          <div><b style={{ color: TEAL }}>Ask before you go in:</b> “What is the price if I pay cash or use my own bank — and if it changes, by exactly how much?” Get the answer in writing.</div>
        </div>
        <ExplainBox txt={`Dealers earn a commission when you finance through them, and they often fund part of the advertised discount out of it. So the headline price can be a financed price. That is not necessarily improper — but it has to be disclosed, and it means a cash buyer may not get the number they came for. Settle this in writing before you're at the desk, because that is where the price gets "corrected".`} />
      </div>
    )};
  }

  // #11 — AMVIC dealer licence. Only rendered on a confident registry match;
  // the status is the regulator's own wording, verbatim. A valid licence is
  // quiet reassurance; expired/closed/suspended is a real flag with the ask.
  let licItem = null;
  if (a.dealerLicence && a.dealerLicence.status) {
    const L = a.dealerLicence, st = L.state;
    const good = st === "valid";
    const label = good ? "Dealer licence · AMVIC verified" : "⚠ Dealer licence · AMVIC";
    licItem = { key: "licence", title: label, tone: good ? "pass" : "flag", glow: !good, v: good ? "Valid" : (L.status || "Check"), body: (
      <div>
        <div style={{ fontSize: 22, fontWeight: 1000, color: good ? TEAL : ROSE, lineHeight: 1.15 }}>{L.status}</div>
        <div style={{ fontSize: 12, color: MUT2, marginTop: 6, lineHeight: 1.55 }}>
          {L.legalName ? <>Registry record: <b style={{ color: "#e2e8f0" }}>{L.legalName}</b>. </> : null}
          {L.licenceNumber ? <>Licence {L.licenceNumber}. </> : null}
          {L.expiryDate ? <>Expiry {L.expiryDate}. </> : null}
          Source: AMVIC's public licensee registry.
        </div>
        {!good && <div style={{ fontSize: 12.5, color: "#e2e8f0", marginTop: 8, lineHeight: 1.55 }}>Ask them to confirm their current AMVIC licence number and status <b>in writing before any deposit</b>.</div>}
        <a href="https://amvic.ca.thentiacloud.net/webs/amvic/register/" target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: CY, fontWeight: 800, marginTop: 8, display: "inline-block" }}>Check it yourself on AMVIC's registry ↗</a>
        <ExplainBox txt={good
          ? `AMVIC is Alberta's regulator — every business selling vehicles here must hold a licence. We matched this dealer to AMVIC's public registry and it currently reads "${L.status}", which is what you want to see. Nothing to do.`
          : `AMVIC is Alberta's regulator, and its public registry currently lists this business as "${L.status}". That does not always mean they can't sell you a car — records lag and businesses reapply — but it is the regulator's own wording, and it is worth clearing up before money changes hands. Ask for their current licence number in writing, then check it yourself on AMVIC's site.`} />
      </div>
    )};
  }

  const heatItems = [...pointItems, ...(daysLotItem ? [{ ...daysLotItem, v: Number(a.daysOnLot?.days || 0).toLocaleString() + " days" }] : []), ...(tradeInItem ? [tradeInItem] : []), ...(financeContingentItem ? [financeContingentItem] : []), ...(licItem ? [licItem] : [])];
  // Every view that surfaces "things to watch" draws from this one pool, so a
  // new flag cannot reach one view and miss another (report-features-all-views).
  const flagPool = [...pointItems, ...(financeContingentItem ? [financeContingentItem] : []), ...(daysLotItem ? [daysLotItem] : [])];
  const verdictItem = { key: "verdict", title: "The verdict", cosmic: true, body: verdictBody };
  const items = [verdictItem, ...pointItems, ...(financeContingentItem ? [financeContingentItem] : []), ...(licItem ? [licItem] : []), ...(daysLotItem ? [daysLotItem] : []), ...(tradeInItem ? [tradeInItem] : []), evidenceItem, ...(sayItem ? [sayItem] : [])];

  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState(0);
  const [selP, setSelP] = useState(0);
  const [btab, setBtab] = useState("deal"); // bento view's active tab
  const N = items.length;
  const go = (d) => setIdx((i) => Math.max(0, Math.min(N - 1, i + d)));
  const touchX = useRef(null);

  const toneColor = (c) => c.cosmic ? CY : c.tone === "flag" ? ROSE : c.tone === "pass" ? TEAL : MUT2;
  const cardBox = (c) => ({ borderRadius: 16, padding: 22, boxSizing: "border-box", display: "flex", flexDirection: "column", border: `1px solid ${c.glow ? CY : BORD}`, background: c.cosmic ? "linear-gradient(160deg,#101a30,#080808)" : (c.tone === "flag" ? "rgba(76,5,25,.12)" : "rgba(15,23,42,.45)"), boxShadow: c.glow ? `0 0 0 1px ${CY}, 0 0 24px 2px rgba(34,211,238,.25)` : "none" });
  const navBtn = (side) => ({ position: "absolute", [side]: -6, top: 90, zIndex: 3, width: 38, height: 38, borderRadius: 999, border: `1px solid ${BORD}`, background: "rgba(2,6,23,.85)", color: TX, fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" });
  const Head = ({ c, n }) => (<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, gap: 8 }}><span style={{ ...klabel, color: c.glow ? CY : MUT2 }}>{c.title}</span>{n && <span style={{ fontSize: 11, fontFamily: mono, color: MUT }}>{n}</span>}</div>);
  const vb = (v, label) => <button key={v} onClick={() => onView && onView(v)} style={{ background: view === v ? CY : "transparent", color: view === v ? "#04222b" : MUT2, border: "none", borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>{label}</button>;

  return (
    <div style={{ background: "#050505", borderRadius: 20, padding: 20, fontFamily: "inherit", color: TX, maxWidth: 1120, margin: "0 auto" }}>
      <style>{`@keyframes rvIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={onExit} style={{ background: "transparent", border: `1px solid ${BORD}`, borderRadius: 10, padding: "8px 12px", color: TX, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>‹ Scroll</button>
        <div style={{ display: "flex", gap: 3, background: "rgba(15,23,42,.6)", border: `1px solid ${BORD}`, borderRadius: 10, padding: 3 }}>{vb("heatmap", "Heatmap")}{vb("sidebar", "Sidebar")}</div>
        <div style={{ fontSize: 11, fontFamily: mono, color: MUT }}><span style={{ color: CY }}>{rno}</span></div>
        {emailStatus === "sent"
          ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, color: TEAL, fontWeight: 700, fontSize: 12.5 }}><DroneSentBeat compact body="#3b3f7a" accent={TEAL}/><span className="lcSentFade" style={{ animation: "lcSentFade .5s ease .9s both" }}>Emailed</span></span>
          : <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <input type="email" placeholder="you@email.com — email the PDF" value={emailInput || ""} onChange={(e) => { setEmailInput && setEmailInput(e.target.value); if (emailErr && setEmailErr) setEmailErr(""); }} disabled={emailStatus === "sending"} style={{ width: 210, maxWidth: "48vw", background: "#020617", border: `1px solid ${emailErr ? ROSE : BORD}`, borderRadius: 9, padding: "8px 11px", color: TX, fontSize: 12.5, outline: "none", boxSizing: "border-box" }} />
              <button onClick={onSend} disabled={emailStatus === "sending"} style={{ background: CY, border: "none", borderRadius: 9, padding: "8px 15px", color: "#04222b", fontWeight: 800, fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" }}>{emailStatus === "sending" ? "Sending…" : "Send email"}</button>
            </div>}
      </div>
      {emailErr && <div style={{ fontSize: 11.5, color: ROSE, textAlign: "right", marginBottom: 6 }}>{emailErr}</div>}


      {view === "sidebar" && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 6 }}>
          <div style={{ flex: "0 0 190px", minWidth: 150, display: "flex", flexDirection: "column", gap: 5 }}>
            {items.map((c, i) => (<button key={c.key} onClick={() => setSel(i)} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8, background: sel === i ? "rgba(15,23,42,.85)" : "transparent", border: `1px solid ${sel === i ? (c.glow ? CY : BORD) : "transparent"}`, borderRadius: 10, padding: "9px 11px", color: sel === i ? "#fff" : MUT2, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}><span style={{ width: 7, height: 7, borderRadius: 99, background: toneColor(c), boxShadow: c.glow ? `0 0 6px ${CY}` : "none", flexShrink: 0 }} /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span></button>))}
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}><div style={cardBox(items[sel])}><Head c={items[sel]} /><div>{items[sel].body}</div></div></div>
        </div>
      )}

      {view === "heatmap" && (<>
        <div style={{ fontSize: 11, color: MUT, fontFamily: mono, margin: "6px 0 10px" }}>The 10-point verification — hot squares are flagged</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(88px,1fr))", gap: 8 }}>
          {heatItems.map((c, i) => (<button key={c.key} onClick={() => setSelP(i)} title={c.title} style={{ minHeight: 84, borderRadius: 10, border: `1px solid ${selP === i ? "#fff" : (c.glow ? CY : BORD)}`, background: c.tone === "flag" ? "rgba(244,63,94,.16)" : c.tone === "pass" ? "rgba(16,185,129,.14)" : "rgba(148,163,184,.08)", boxShadow: c.glow ? `0 0 0 1px ${CY}, 0 0 12px ${CY}55` : "none", cursor: "pointer", padding: 9, display: "flex", flexDirection: "column", justifyContent: "space-between", textAlign: "left" }}><span style={{ fontSize: 10, fontFamily: mono, color: toneColor(c) }}>{String(i + 1).padStart(2, "0")} · {c.v}</span><span style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2, color: "#cbd5e1" }}>{c.title}</span></button>))}
        </div>
        <div style={{ marginTop: 14 }}><div style={cardBox(heatItems[Math.min(selP, heatItems.length - 1)])}><Head c={heatItems[Math.min(selP, heatItems.length - 1)]} n={`point ${Math.min(selP, heatItems.length - 1) + 1} / ${heatItems.length}`} /><div>{heatItems[Math.min(selP, heatItems.length - 1)].body}</div></div></div>
      </>)}


      {shared && <div style={{ textAlign: "center", fontSize: 11, color: MUT, marginTop: 12 }}>Shared LotCheck report · reconstructed from the link — nothing was stored.</div>}
    </div>
  );
}

function ReportFlipbook({analysis:a, onExit, onShare, copied, shared, ink}){
  const [cur,setCur]=useState(0);
  const money=(n)=>`$${Math.round(Number(n)||0).toLocaleString("en-CA")}`;
  const qp=Number(a.quotedPrice)||0, ms=Number(a.msrp)||0, delta=qp&&ms?qp-ms:0;
  const feeItems=(a.addOns||[]).filter(x=>x.price!=null);
  const flaggedTotal=feeItems.filter(x=>x.verdict==="flagged").reduce((s,x)=>s+(x.price||0),0);
  const feesTotal=feeItems.reduce((s,x)=>s+(x.price||0),0);
  const vehName=a.vehicle||[a.year,a.make,a.model].filter(Boolean).join(" ")||"Vehicle";
  const fLbl={weekly:"Weekly",biweekly:"Bi-weekly",monthly:"Monthly"}, fSuf={weekly:"/wk",biweekly:"/2wk",monthly:"/mo"};

  // Build the page list — only pages backed by real data.
  const P=[];
  P.push({t:"cover"});
  if(qp||ms) P.push({t:"deal"});
  if(a.financing?.paymentAmount||a.financeRates?.dealer||a.financeRates?.manufacturer||a.financeContingent?.contingent) P.push({t:"fin"});
  if(a.recalls?.checked) P.push({t:"recalls"});
  if(feeItems.length) P.push({t:"fees"});
  if(a.dealerSentiment?.rating) P.push({t:"rep"});
  if((Number(a.daysOnLot?.days)||0)>0||a.tradeInWidget?.detected) P.push({t:"lev"});
  if(a.leverageScore||a.summary) P.push({t:"bottom"});
  if(P.length%2) P.push({t:"blank"});
  const leaves=[]; for(let i=0;i<P.length;i+=2) leaves.push([P[i],P[i+1]]);
  const N=leaves.length;
  useEffect(()=>{
    const h=(e)=>{ if(e.key==="ArrowRight"&&cur<N)setCur(cur+1); if(e.key==="ArrowLeft"&&cur>0)setCur(cur-1); };
    window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h);
  },[cur,N]);

  const Page=({p,side})=>{
    if(!p||p.t==="blank") return <div className="rfb-pg" style={{background:"#123f3a"}}/>;
    const num=<div className={`rfb-pn ${side}`}>{p.t==="cover"?"":String(P.indexOf(p)+1).padStart(2,"0")}</div>;
    if(p.t==="cover") return (
      <div className="rfb-pg rfb-cover">
        <div><div className="rfb-brand"><RealLogo width={38}/>LotCheck</div>
          <div className="rfb-ct">Quote Check Report</div>
          <div className="rfb-veh">{a.year} {a.make}<br/>{a.model}</div>
          <div className="rfb-dl">{[a.trim,a.dealerName,a.dealerCity].filter(Boolean).join(" · ")}</div></div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          <div className="rfb-seal">◈ Verified{a.vehicleCondition?` · ${a.vehicleCondition}`:""}</div>
        </div>
      </div>);
    if(p.t==="deal"){ const exactFb = isExactMsrp(a);
      return (<div className="rfb-pg">{num}
      <div className="rfb-k">The deal</div>
      <h2 className="rfb-h2">{exactFb?(delta>0?`Priced ${money(delta)} over MSRP`:delta<0?`${money(-delta)} below MSRP`:"Priced at MSRP"):(ms>0?`Base MSRP from ${money(ms)}`:(qp>0?`Asking ${money(qp)}`:"The deal"))}</h2>
      {qp>0&&<div className="rfb-stat"><div className="rfb-lab">Asking price · before tax</div><div className="rfb-big">{money(qp)}</div><div className="rfb-sub">the dealer's all-in price</div></div>}
      {ms>0&&<div className="rfb-stat"><div className="rfb-lab">{exactFb?"Verified MSRP":"MSRP · starting at"}</div><div className="rfb-big" style={{color:"#159e8f"}}>{money(ms)}</div>{exactFb&&delta>0&&<div className="rfb-sub"><span className="rfb-tag bad">▲ {money(delta)} over MSRP</span></div>}{!exactFb&&<div className="rfb-sub">base model — this unit's options are extra</div>}</div>}
      <div className="rfb-lede" style={{marginTop:"auto"}}>{a.summary?a.summary.slice(0,190)+(a.summary.length>190?"…":""):"See the pages ahead for financing, recalls, fees and reputation."}</div>
    </div>); }
    if(p.t==="fin"){ const fin=a.financing, r=fin?.rate, dRate=a.financeRates?.dealer?.apr, mRate=a.financeRates?.manufacturer?.apr;
      return (<div className="rfb-pg">{num}<div className="rfb-k">Financing</div>
      <h2 className="rfb-h2">{dRate&&mRate&&dRate>mRate?`Rate is ${(dRate-mRate).toFixed(2)}% over ${a.make}'s`:"Payment breakdown"}</h2>
      {fin?.paymentAmount&&fin?.paymentFrequency&&<div className="rfb-stat"><div className="rfb-lab">On your quote</div><div className="rfb-big">{money(fin.paymentAmount)}<span style={{fontSize:16,color:"#9a94b4"}}>{fSuf[fin.paymentFrequency]}</span></div><div className="rfb-sub">{r?`${r}% APR · `:""}{fin.termMonths?`${fin.termMonths} months`:""}</div></div>}
      <div className="rfb-rows">
        {dRate!=null&&<div className="rfb-r"><span className="rfb-n">This dealer</span><span className="rfb-v bad">{dRate}%</span></div>}
        {mRate!=null&&<div className="rfb-r"><span className="rfb-n">{a.make} advertised</span><span className="rfb-v">{mRate}%</span></div>}
      </div>
      {dRate&&mRate&&dRate>mRate&&<div className="rfb-why warn"><div className="rfb-wh" style={{color:"#c78a1e"}}>Worth pushing back</div><div className="rfb-wt">{(dRate-mRate).toFixed(2)}% above {a.make}'s advertised rate — ask them to match the manufacturer rate.</div></div>}
      {a.financeContingent?.contingent&&<div className="rfb-why warn"><div className="rfb-wh" style={{color:"#e0503c"}}>This price depends on financing with the dealer</div><div className="rfb-wt">The listing's own wording ties the advertised price to taking their financing — the discount is often funded by their commission on the loan, so a cash buyer can lose it. Ask in writing: <b>what is the price if I pay cash or use my own bank, and by exactly how much does it change?</b></div></div>}
    </div>); }
    if(p.t==="recalls"){ const r=a.recalls;
      return (<div className="rfb-pg">{num}<div className="rfb-k">Safety</div>
      <h2 className="rfb-h2">{r.count>0?`${r.count} open recall${r.count>1?"s":""}`:"No open recalls"}</h2>
      {r.count>0?<>
        <div className="rfb-why"><div className="rfb-wh">Why you're seeing this</div><div className="rfb-wt">Open safety-recall campaigns <b>Transport Canada</b> publishes for this year/make/model — read live from the federal Vehicle Recall Database. Government data, not our opinion. Confirm by <b>VIN</b> with the dealer.</div></div>
        <div className="rfb-rows">{(r.items||[]).slice(0,5).map((it,i)=><div className="rfb-r" key={i}><span className="rfb-n">{it.system||"Recall"}{it.date?` · ${new Date(it.date).getFullYear()||""}`:""}</span></div>)}</div>
        <div className="rfb-lede" style={{marginTop:10,fontSize:12}}>All recall repairs are free of charge.</div>
      </>:<div className="rfb-lede">Transport Canada's registry shows no open recalls for this year/make/model.</div>}
    </div>); }
    if(p.t==="lev"){ const d=Math.round(Number(a.daysOnLot?.days)||0); const tiw=a.tradeInWidget;
      return (<div className="rfb-pg">{num}<div className="rfb-k">Leverage</div>
      <h2 className="rfb-h2">{d>0?`${d.toLocaleString()} days on the lot`:"Trade-in tool on this listing"}</h2>
      {d>0&&<div className="rfb-stat"><div className="rfb-lab">Days on lot{a.daysOnLot.since?` · first seen ${a.daysOnLot.since}`:""}</div><div className="rfb-big" style={{color:d>=90?"#e0503c":d>=31?"#c78a1e":"#159e8f"}}>{d.toLocaleString()} days</div><div className="rfb-sub">{a.daysOnLot.sourceLabel||"dealer inventory data"} — the dealer's own clock, not our guess</div></div>}
      {d>0&&<div className="rfb-lede" style={{fontSize:12}}>{d>=90?"Well past the typical turn window — every extra week costs the dealer real money. Concrete discount leverage.":d>=31?"A month-plus of sitting is real carrying cost — reasonable grounds to ask for a better price.":"Recently listed — limited sitting-time leverage on this unit."}{dolCareAsk(d)}</div>}
      {tiw?.detected&&<div className="rfb-why warn"><div className="rfb-wh" style={{color:"#c78a1e"}}>Trade-in tool on this listing{tiw.vendor?` · ${tiw.vendor}`:""}</div><div className="rfb-wt">Its instant number is the <b>wholesale</b> side of the market (what dealers pay each other) and it's non-binding. Settle this vehicle's price first; get the trade offer in writing on its own line — never one blended payment.</div></div>}
    </div>); }
    if(p.t==="fees") return (<div className="rfb-pg">{num}<div className="rfb-k">Add-ons &amp; fees</div>
      <h2 className="rfb-h2">{flaggedTotal>0?`${money(flaggedTotal)} worth questioning`:"Fees itemized"}</h2>
      <div className="rfb-rows">{feeItems.slice(0,6).map((x,i)=><div className="rfb-r" key={i}><span className="rfb-n" style={x.verdict==="flagged"?{color:"#d6533f"}:null}>{x.verdict==="flagged"?"⚑ ":""}{x.name}</span><span className={`rfb-v ${x.verdict==="flagged"?"bad":""}`}>{money(x.price)}</span></div>)}</div>
      <div className="rfb-r" style={{border:0,paddingTop:12}}><span className="rfb-n" style={{fontSize:14}}>Add-ons total</span><span className="rfb-v" style={{fontSize:16}}>{money(feesTotal)}</span></div>
    </div>);
    if(p.t==="rep"){ const d=a.dealerSentiment;
      return (<div className="rfb-pg">{num}<div className="rfb-k">Reputation</div>
      <h2 className="rfb-h2">{d.dealerName||"This dealer"}</h2>
      <div className="rfb-stat"><div className="rfb-lab">Google reviews</div><div className="rfb-big">{Number(d.rating).toFixed(1)}<span style={{fontSize:16,color:"#9a94b4"}}> · {Number(d.reviewCount||0).toLocaleString()}</span></div></div>
      <div className="rfb-rows">{(d.highlights||[]).slice(0,3).map((h,i)=><div className="rfb-r" key={i}><span className="rfb-n">★{h.rating} · {h.text}</span></div>)}</div>
      <div className="rfb-lede" style={{marginTop:10,fontSize:12}}>Public Google reviews — snippets shown, linked to source.</div>
    </div>); }
    if(p.t==="bottom"){ const lv=a.leverageScore;
      return (<div className="rfb-pg" style={{background:"linear-gradient(160deg,#fbf7ef,#f0eafc)"}}>{num}<div className="rfb-k">Bottom line</div>
      <h2 className="rfb-h2">{lv?`Leverage ${lv.score} / 10`:"The bottom line"}</h2>
      {lv&&<div className="rfb-stat"><div className="rfb-big" style={{fontSize:44,color:"#6d4bd8"}}>{lv.score}<span style={{fontSize:18,color:"#9a94b4"}}>/10</span></div><div className="rfb-sub">Computed only from the verified findings — not an opinion.</div></div>}
      {a.summary&&<div className="rfb-lede" style={{marginTop:6}}>{a.summary}</div>}
    </div>); }
    return <div className="rfb-pg"/>;
  };

  return (
    <div className="rfb-wrap" style={{color:ink||"#241f3a"}}>
      <style>{RFB_CSS}</style>
      <div className="rfb-bar">
        <button className="rfb-exit" onClick={onExit}>‹ Scroll view</button>
        <div className="rfb-count">{cur===0?"Cover":(cur===N?"End":`Spread ${cur} / ${N-1}`)}</div>
        <button className="rfb-share" onClick={onShare}>{copied?"Link copied":"Copy share link"}</button>
      </div>
      <div className="rfb-book">
        <div className="rfb-base l"><div className="rfb-inside"><div className="rfb-vmark">LotCheck · Verified</div></div></div>
        <div className="rfb-base r"><div className="rfb-end"><div style={{marginBottom:14}}><RealLogo width={52}/></div><h3>That's your report.</h3><p>Every figure traces to a real source — no invented scores.</p><div className="rfb-fine">Analyzed once, never stored</div></div></div>
        {leaves.map((lf,i)=>(
          <div className={`rfb-leaf ${i<cur?"flipped":""}`} key={i} style={{zIndex:i<cur?i:N-i}}>
            <div className="rfb-face front"><Page p={lf[0]} side="r"/></div>
            <div className="rfb-face back"><Page p={lf[1]} side="l"/></div>
          </div>
        ))}
      </div>
      <div className="rfb-ctr">
        <button className="rfb-nav" onClick={()=>cur>0&&setCur(cur-1)} disabled={cur===0} aria-label="Previous">‹</button>
        <button className="rfb-nav" onClick={()=>cur<N&&setCur(cur+1)} disabled={cur===N} aria-label="Next">›</button>
      </div>
      {shared&&<div className="rfb-shared">Shared LotCheck report · reconstructed from the link — nothing was stored.</div>}
    </div>
  );
}

const RFB_CSS=`
  .rfb-wrap{display:flex;flex-direction:column;align-items:center;padding:8px 0 24px}
  .rfb-bar{display:flex;align-items:center;gap:12px;width:100%;max-width:860px;margin-bottom:14px;flex-wrap:wrap}
  .rfb-exit,.rfb-share{background:transparent;border:1px solid rgba(120,110,160,.55);border-radius:10px;padding:8px 14px;font:inherit;font-weight:800;font-size:13px;color:inherit;cursor:pointer}
  .rfb-share{margin-left:auto;background:#6d4bd8;border-color:#6d4bd8;color:#fff}
  .rfb-count{font-family:'JetBrains Mono',monospace;font-size:12px;opacity:.7}
  .rfb-book{position:relative;width:min(860px,96vw);height:min(560px,68vh);perspective:2400px;box-shadow:0 40px 60px -30px rgba(0,0,0,.45)}
  .rfb-base{position:absolute;top:0;bottom:0;width:50%;overflow:hidden}
  .rfb-base.l{left:0;border-radius:10px 4px 4px 10px}.rfb-base.r{right:0;border-radius:4px 10px 10px 4px}
  .rfb-inside{position:absolute;inset:0;background:linear-gradient(135deg,#123f3a,#171235);display:grid;place-items:center}
  .rfb-vmark{font-family:'Space Grotesk',sans-serif;font-weight:700;letter-spacing:.3em;color:rgba(127,224,211,.4);text-transform:uppercase;font-size:12px;transform:rotate(-90deg);white-space:nowrap}
  .rfb-end{position:absolute;inset:0;background:linear-gradient(150deg,#171235,#123f3a);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:34px}
  .rfb-mk2{width:40px;height:40px;border-radius:11px;background:conic-gradient(from 210deg,#8b5cf6,#39d3c0,#8b5cf6);margin-bottom:14px}
  .rfb-end h3{font-family:'Space Grotesk';font-weight:700;font-size:21px;margin:0 0 8px}
  .rfb-end p{color:#c9c2ee;font-size:13px;margin:0;max-width:24ch;line-height:1.5}
  .rfb-fine{color:#6f68a0;font-size:11px;margin-top:14px}
  .rfb-leaf{position:absolute;top:0;right:0;width:50%;height:100%;transform-origin:left center;transform-style:preserve-3d;transition:transform .95s cubic-bezier(.2,.72,.2,1)}
  .rfb-leaf.flipped{transform:rotateY(-180deg)}
  .rfb-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden;background:#fbf7ef}
  .rfb-face.front{border-radius:4px 10px 10px 4px;box-shadow:inset 22px 0 40px -30px rgba(0,0,0,.35)}
  .rfb-face.back{transform:rotateY(180deg);border-radius:10px 4px 4px 10px;box-shadow:inset -22px 0 40px -30px rgba(0,0,0,.35)}
  .rfb-pg{position:absolute;inset:0;padding:32px 30px;display:flex;flex-direction:column;color:#241f3a;font-family:'Nunito',sans-serif}
  .rfb-k{font-size:10.5px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;color:#6d4bd8}
  .rfb-h2{font-family:'Space Grotesk';font-weight:700;font-size:23px;margin:6px 0 14px;line-height:1.12}
  .rfb-pn{position:absolute;bottom:16px;font-size:10px;font-weight:800;color:#9a94b4;letter-spacing:.1em}
  .rfb-pn.l{left:30px}.rfb-pn.r{right:30px}
  .rfb-stat{margin-bottom:13px}.rfb-lab{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#9a94b4}
  .rfb-big{font-family:'JetBrains Mono',monospace;font-weight:800;font-size:29px;line-height:1.1}
  .rfb-sub{font-size:12px;color:#5d5878;margin-top:2px}
  .rfb-tag{display:inline-block;font-size:11px;font-weight:800;border-radius:6px;padding:2px 8px}
  .rfb-tag.bad{background:#fbe7e2;color:#d6533f}
  .rfb-rows{border-top:1px solid #e7e0d2;margin-top:4px}
  .rfb-r{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #e7e0d2;font-size:12.5px}
  .rfb-n{color:#241f3a;font-weight:700}.rfb-v{font-family:'JetBrains Mono';font-weight:800;white-space:nowrap}.rfb-v.bad{color:#d6533f}
  .rfb-why{margin-top:12px;background:#fbe7e2;border:1px solid #eec3b8;border-radius:12px;padding:10px 12px}
  .rfb-why.warn{background:#fbf0d8;border-color:#e9d29a}
  .rfb-wh{font-size:12px;font-weight:1000;color:#d6533f;margin-bottom:4px}
  .rfb-wt{font-size:11.5px;color:#241f3a;line-height:1.5;font-weight:600}
  .rfb-lede{font-size:13px;color:#5d5878;line-height:1.55}
  .rfb-cover{background:linear-gradient(150deg,#171235,#241a52 55%,#123f3a);color:#fff;justify-content:space-between;padding:38px 32px}
  .rfb-brand{display:flex;align-items:center;gap:11px;font-weight:1000;font-size:22px}
  .rfb-mk{width:36px;height:36px;border-radius:10px;background:conic-gradient(from 210deg,#8b5cf6,#39d3c0,#8b5cf6);box-shadow:0 6px 20px rgba(0,0,0,.4)}
  .rfb-ct{font-family:'Space Grotesk';font-weight:700;font-size:14px;letter-spacing:.24em;text-transform:uppercase;color:#7fe0d3;margin-top:24px}
  .rfb-veh{font-family:'Space Grotesk';font-weight:700;font-size:28px;line-height:1.12;margin:8px 0 6px}
  .rfb-dl{color:#c9c2ee;font-size:12.5px}
  .rfb-seal{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(127,224,211,.5);border-radius:999px;padding:7px 14px;font-size:11px;font-weight:800;color:#7fe0d3;text-transform:capitalize}
  .rfb-ctr{display:flex;gap:14px;margin-top:18px}
  .rfb-nav{width:44px;height:44px;border-radius:50%;border:1px solid rgba(120,110,160,.55);background:rgba(120,110,160,.18);color:inherit;font-size:20px;cursor:pointer}
  .rfb-nav:disabled{opacity:.3;cursor:default}
  .rfb-shared{font-size:11px;opacity:.6;margin-top:12px}
  @media(max-width:640px){.rfb-pg{padding:22px 18px}.rfb-h2{font-size:19px}.rfb-big{font-size:25px}}
`;

// ── Dispute-proof report identity (Option A: self-authenticating, NOTHING
// stored). The report ID is a fingerprint of the report's own contents +
// issued-at timestamp: change any figure and the ID changes, so it's
// tamper-evident. /verify?d=<payload> recomputes the fingerprint from the
// link and shows the same ID + figures — the buyer compares that ID to the one
// printed on their report. LotCheck stores nothing; the buyer's copy is the
// record. (Keeps the "analyzed once, never stored" promise — see the
// always-check-legally-clear analysis: Alberta PIPA/PIPEDA + Consumer
// Protection Act.)
async function sha256Hex(str){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
function b64urlEncode(str){ return btoa(unescape(encodeURIComponent(str))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64urlDecode(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); return decodeURIComponent(escape(atob(s))); }
// Parked-time care asks for the Days-on-Lot card — one helper so every surface
// (deck card, scroll view, flipbook; mirrored server-side for email + PDF)
// prints the identical wording. Backed: GM dealer-inventory bulletin
// 09-00-89-002K (battery test + move every 30 days in stock; oil advisory past
// 7 months; tires can flat-spot toward permanent past 90 days; storage
// deterioration excluded from the new-vehicle warranty) and every OEM oil
// schedule's months clause (Ford "never exceed one year", Honda 12 months,
// Toyota 12 months/16,000 km). Ask-framed on purpose: we advise questions,
// never assert the car is damaged (defamation-proof rule).
function dolCareAsk(d){
  if(d>=90) return " Parked this long, the car sits mechanically too — ask when the oil was last changed (manufacturers cap oil life by time, not just km), whether the 12-volt battery was tested and the car moved every 30 days (GM's own dealer-inventory guidance calls for both), and ask to see the completed pre-delivery inspection sheet.";
  if(d>=31) return " Worth asking too: whether the 12-volt battery has been tested and the car moved during storage — manufacturer lot-care guidance calls for both every 30 days.";
  return "";
}
function makeReportId(fpHex){ return "LC-"+fpHex.slice(0,4).toUpperCase()+"-"+fpHex.slice(4,7).toUpperCase(); }
// Canonical, fixed-order projection of ONLY what the report shows. This exact
// object is what gets fingerprinted and what /verify re-hashes — so both sides
// must build it identically.
function canonicalReport(a){
  const num=(x)=>{const v=Number(x);return Number.isFinite(v)?v:null;};
  return {
    v:1,
    vehicle:a.vehicle||[a.year,a.make,a.model].filter(Boolean).join(" ")||null,
    dealer:{name:a.dealerName||null,city:a.dealerCity||null},
    price:{asking:num(a.quotedPrice),msrp:num(a.msrp),verified:a.priceVerified!==undefined?!!a.priceVerified:(num(a.quotedPrice)>0)},
    leverage:a.leverageScore&&a.leverageScore.score!=null?Number(a.leverageScore.score):null,
    recalls:a.recalls&&a.recalls.checked?{count:a.recalls.count||0,confirmed:a.recalls.confirmed!==false,items:(a.recalls.items||[]).map(it=>({system:it.system||null,date:it.date||null}))}:null,
    addOns:(a.addOns||[]).map(x=>({name:x.name||null,price:num(x.price),verdict:x.verdict||null})),
    finance:a.financeRates?{dealer:a.financeRates.dealer&&a.financeRates.dealer.apr!=null?a.financeRates.dealer.apr:null,manufacturer:a.financeRates.manufacturer&&a.financeRates.manufacturer.apr!=null?a.financeRates.manufacturer.apr:null,math:a.financingCheck&&a.financingCheck.checked?!!a.financingCheck.consistent:null}:null,
    reputation:a.dealerSentiment&&a.dealerSentiment.rating?{rating:Number(a.dealerSentiment.rating),reviews:Number(a.dealerSentiment.reviewCount||0)}:null,
    marketValue:a.marketValue&&a.marketValue.average!=null?{avg:num(a.marketValue.average),below:num(a.marketValue.below),above:num(a.marketValue.above),mileage:num(a.marketValue.mileage),source:a.marketValue.source||null}:null,
    summary:a.summary||null,
    shot:a.listingShotSha256||null,
    vin:a.vin||null,
    odo:num(a.odometerKm),
    dol:a.daysOnLot&&Number(a.daysOnLot.days)>0?{d:Math.round(Number(a.daysOnLot.days)),s:a.daysOnLot.since||null}:null,
    pd:a.priceDisclosure||null,
    basis:a.msrpBasis?{b:a.msrpBasis,t:a.msrpTrim||null,y:a.msrpYear||null}:null,
    allIn:a.allInPricing?.body||null,
    disc:a.disclaimerCheck?{e:!!a.disclaimerCheck.escapeHatch,x:!!a.disclaimerCheck.contradiction}:null,
    fcx:a.financeContingent?.contingent?{r:a.financeContingent.reasons||[]}:null,
    source:(a.sourceUrl||a.capturedAt)?{url:a.sourceUrl||null,capturedAt:a.capturedAt||null}:null,
    issuedAt:a.issuedAt||null,
  };
}
// Stamp issuedAt + reportId onto a fresh analysis. Non-fatal: if crypto is
// unavailable (very old/insecure context), fall back to a plain timestamp id
// so the report still renders — it just isn't cryptographically verifiable.
//
// issuedAt is set by the SERVER (analyze-quote / analyze-listing-url stamp it
// from the trusted server clock) and preferred here, so a user changing their
// device clock cannot alter the report's issued date — which is fingerprinted
// into the report ID. We only fall back to the local clock when the server
// didn't provide one (older responses / non-server paths). See make-it-
// dispute-proof.
async function finalizeReport(analysis){
  // The server (analyze-quote / analyze-listing-url) already finalizes the
  // report — it stamps issuedAt, computes the ID + payload, and SIGNS them.
  // Trust that verbatim: the signature is over the server's exact canonical
  // bytes, so recomputing here would break it. Only compute client-side when
  // the server didn't (older responses / local demos) — that path is unsigned.
  if(analysis?.verifyPayload && analysis?.reportId) return analysis;
  const issuedAt = analysis?.issuedAt || new Date().toISOString();
  const withTime = {...analysis, issuedAt};
  try{
    const str = JSON.stringify(canonicalReport(withTime));
    const fp = await sha256Hex(str);
    return {...withTime, reportId: makeReportId(fp), verifyPayload: b64urlEncode(str)};
  }catch{
    return {...withTime, reportId: "LC-"+String(Date.parse(issuedAt)).slice(-6), verifyPayload: null};
  }
}
function verifyBaseUrl(){
  try{ return (window.location.origin||"https://lotcheck.ca"); }catch{ return "https://lotcheck.ca"; }
}
// Build the shareable verify link. Carries the self-contained payload (d), the
// claimed report id, and — when the report was signed — the signature (s) +
// key id (k). /verify recomputes the id AND checks the signature.
function verifyLinkFor(a){
  if(!a||!a.verifyPayload) return null;
  const id=a.reportId?`&id=${encodeURIComponent(a.reportId)}`:"";
  const s=a.sig?`&s=${encodeURIComponent(a.sig)}`:"";
  const k=a.keyId?`&k=${encodeURIComponent(a.keyId)}`:"";
  return `${verifyBaseUrl()}/verify?d=${a.verifyPayload}${id}${s}${k}`;
}

// ── Report signing (provenance). Public keys only — safe to ship. Each report
// carries a keyId so keys can rotate; keep retired public keys here so old
// links keep verifying. Private key lives only on the server.
// ROTATION: the email function keeps its own copy of this registry
// (supabase/functions/email-quote-report/index.ts REPORT_PUBLIC_KEYS) — update
// BOTH or sealed captures silently stop attaching (verifySealedShot → null).
const REPORT_PUBLIC_KEYS = {
  k1: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErEpWm/YsbAN9i9RkuGAPDadAp8BJ+i3j7V1WVUtvsQgmBN04hEQksYdyUksotL6LYOrPAnRkpqh6DXmMlTI7FA==",
};
function b64urlToBytes(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; const bin=atob(s); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i); return arr; }
// Verify an ECDSA P-256 signature over the payload bytes with the named public
// key. Returns true only on a cryptographically valid signature from LotCheck.
async function verifyReportSignature(payloadB64url, sigB64url, keyId){
  try{
    const pubB64 = REPORT_PUBLIC_KEYS[keyId];
    if(!pubB64 || !sigB64url) return false;
    const spki = Uint8Array.from(atob(pubB64), c=>c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", spki, {name:"ECDSA",namedCurve:"P-256"}, false, ["verify"]);
    return await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, key, b64urlToBytes(sigB64url), b64urlToBytes(payloadB64url));
  }catch(e){ return false; }
}
// Verify a signature directly over payload BYTES (the decompressed canonical).
async function verifyReportSignatureBytes(payloadBytes, sigB64url, keyId){
  try{
    const pubB64 = REPORT_PUBLIC_KEYS[keyId];
    if(!pubB64 || !sigB64url) return false;
    const spki = Uint8Array.from(atob(pubB64), c=>c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", spki, {name:"ECDSA",namedCurve:"P-256"}, false, ["verify"]);
    return await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, key, b64urlToBytes(sigB64url), payloadBytes);
  }catch(e){ return false; }
}
// Verify payloads are gzip-compressed (so the QR stays scannable). Detect the
// gzip magic header and inflate; legacy uncompressed payloads pass through
// unchanged, so old report links still verify.
async function maybeGunzip(bytes){
  try{
    if(bytes.length>=2 && bytes[0]===0x1f && bytes[1]===0x8b && typeof DecompressionStream!=="undefined"){
      const ds=new DecompressionStream("gzip");
      const w=ds.writable.getWriter(); w.write(bytes); w.close();
      const ab=await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(ab);
    }
  }catch(e){ /* fall through to raw */ }
  return bytes;
}

// ── Unique visual signature ("LotCheck seal"). A guilloché rosette whose exact
// shape is DERIVED from the report's ECDSA signature (falls back to reportId),
// so every report's seal is different and none can be reproduced without our
// private key — alter any figure and the signature (and the seal) changes. The
// generator is byte-identical to the one in the email edge function so the seal
// matches on-screen, on the PDF, and on /verify.
function sealSeed(s){ let h=2166136261>>>0; const str=String(s||"lotcheck"); for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h>>>0; }
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function guillocheRings(seed,cx,cy,R,steps){
  const rnd=mulberry32(seed);
  const petal=4+Math.floor(rnd()*7), fine=16+Math.floor(rnd()*26), ph=rnd()*6.28318;
  const a1=R*(0.10+rnd()*0.13), a2=R*(0.04+rnd()*0.07);
  const ring=(scale,off)=>{ let d=""; const n=steps||600; for(let i=0;i<=n;i++){ const t=i/n*6.28318; const rr=R*scale+a1*Math.sin(petal*t+ph)+a2*Math.sin(fine*t); const x=cx+(rr+off)*Math.cos(t), y=cy+(rr+off)*Math.sin(t); d+=(i?"L":"M")+x.toFixed(1)+" "+y.toFixed(1)+" "; } return d; };
  return [ring(1,0),ring(1,2.4),ring(0.66,0),ring(0.66,1.9)];
}
function Seal({seed,size=120,gid,ink="#eafff6"}){
  const S=size, cx=S/2, cy=S/2, R=S*0.34;
  const rings=guillocheRings(seed,cx,cy,R,700);
  const id=gid||("sg"+seed);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true">
      <defs><radialGradient id={id}><stop offset="0" stopColor="#5dcaa5"/><stop offset="0.6" stopColor="#8b7be6"/><stop offset="1" stopColor="#6d3bd6"/></radialGradient></defs>
      {/* certificate frame — makes it read as a proper stamp/seal */}
      <circle cx={cx} cy={cy} r={S*0.47} fill="none" stroke="#8b7be6" strokeWidth={S*0.012} opacity="0.9"/>
      <circle cx={cx} cy={cy} r={S*0.43} fill="none" stroke="#5dcaa5" strokeWidth={S*0.006} opacity="0.8"/>
      {rings.map((d,i)=><path key={i} d={d} fill="none" stroke={`url(#${id})`} strokeWidth={i%2?0.5:0.75} opacity={i%2?0.55:0.95}/>)}
      <circle cx={cx} cy={cy} r={R*0.30} fill="none" stroke="#8b7be6" strokeWidth="0.8" opacity="0.7"/>
      <text x={cx} y={cy+3.5} textAnchor="middle" fontFamily="ui-monospace,Menlo,Consolas,monospace" fontSize={S*0.09} fontWeight="700" fill={ink}>LC</text>
    </svg>
  );
}
// ── Verification shield (replaces the padlock). state: "idle" | "ok" | "bad".
// When "ok" the shield fills and the check draws in; "bad" shows an X. CSS
// keyframes (shFill/shDraw/shCheck) are injected by the host page's <style>.
function Shield({state="idle",size=64}){
  const col=state==="ok"?"#34d399":state==="bad"?"#f0997b":"#8b7be6";
  const bg=state==="ok"?"#0f6e56":state==="bad"?"#7a2417":"#2a2740";
  const P="M50 6 L90 22 L90 58 C90 90 72 106 50 114 C28 106 10 90 10 58 L10 22 Z";
  const cls=state==="ok"?"sh-anim":"";
  return (
    <svg className={cls} width={size} height={size*1.2} viewBox="0 0 100 120" aria-hidden="true">
      <defs><clipPath id={"scl"+state}><path d={P}/></clipPath></defs>
      <path d={P} fill={bg} opacity="0.5"/>
      <g clipPath={`url(#scl${state})`}><rect className="sh-fill" x="0" y="0" width="100" height="120" fill={col} opacity="0.32"/></g>
      <path className="sh-outline" d={P} fill="none" stroke={col} strokeWidth="4" strokeDasharray="420"/>
      {state==="bad"
        ? <path d="M36 44 L64 76 M64 44 L36 76" stroke="#fff" strokeWidth="7" strokeLinecap="round" fill="none"/>
        : state==="idle"
        ? <g><rect x="40" y="52" width="20" height="18" rx="3" fill="none" stroke="#cfc9f5" strokeWidth="4"/><path d="M43 52 v-6 a7 7 0 0 1 14 0 v6" fill="none" stroke="#cfc9f5" strokeWidth="4"/></g>
        : <path className="sh-check" d="M34 60 L46 74 L70 40" fill="none" stroke="#eafff6" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>}
    </svg>
  );
}
const SHIELD_CSS=`
  .sh-fill{transform:translateY(60px)}
  .sh-anim .sh-fill{animation:shFill 3.6s ease-in-out infinite}
  @keyframes shFill{0%,8%{transform:translateY(60px)}42%,92%{transform:translateY(0)}100%{transform:translateY(60px)}}
  .sh-anim .sh-outline{animation:shDraw 3.6s ease-in-out infinite}
  @keyframes shDraw{0%{stroke-dashoffset:420}30%,100%{stroke-dashoffset:0}}
  .sh-anim .sh-check{stroke-dasharray:80;animation:shCheck 3.6s ease-in-out infinite}
  @keyframes shCheck{0%,45%{stroke-dashoffset:80;opacity:0}55%{opacity:1}62%,92%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:80;opacity:0}}
  @media(prefers-reduced-motion:reduce){.sh-fill{transform:translateY(0)!important}.sh-anim *{animation:none!important}}`;

// ── /verify?d=<payload> — recomputes the fingerprint from the link and shows
// the report's ID + figures. Purely client-side; nothing is fetched or stored.
function VerifyPage(){
  const [state,setState]=useState({phase:"loading"});
  const [input,setInput]=useState("");
  const [hint,setHint]=useState("");
  // Sealed-photo check: hash a dropped/chosen image ENTIRELY in the browser and
  // compare it to the SHA-256 sealed in this report's SIGNED canonical. Nothing
  // is uploaded — the file never leaves the device, keeping the "nothing
  // stored" promise while making the emailed capture file provable. Only
  // rendered for signature-valid reports: the hash in an unsigned link proves
  // nothing (anyone can seal a doctored image's hash into a link they minted).
  const [photoCheck,setPhotoCheck]=useState({status:"idle"});
  const [zoneUi,setZoneUi]=useState({drag:false,focus:false});
  // Monotonic token: a result may only land if no newer drop and no report
  // change superseded it (two quick drops race — last-started must win).
  const photoSeqRef=useRef(0);
  // Hashing guard only — deliberately far above the server's ~12 MB capture
  // cap, so any real LotCheck capture passes and only absurd files skip the
  // in-browser SHA-256.
  const PHOTO_CHECK_MAX_BYTES=64*1024*1024;
  async function checkPhotoFile(file,sealedHex){
    if(!file) return;
    const seq=++photoSeqRef.current;
    try{
      if(file.size>PHOTO_CHECK_MAX_BYTES){ setPhotoCheck({status:"toobig"}); return; }
      setPhotoCheck({status:"hashing"});
      const buf=await file.arrayBuffer();
      const dig=await crypto.subtle.digest("SHA-256",buf);
      const hex=Array.from(new Uint8Array(dig)).map(b=>b.toString(16).padStart(2,"0")).join("");
      if(seq!==photoSeqRef.current) return;
      const sealed=sealedHex?String(sealedHex).toLowerCase():null;
      setPhotoCheck({status:sealed?(hex===sealed.trim()?"match":"mismatch"):"noseal",hex});
    }catch(e){ if(seq===photoSeqRef.current) setPhotoCheck({status:"error"}); }
  }
  async function runVerify(d,id,s,k){
    setState({phase:"loading"});
    photoSeqRef.current++;
    setPhotoCheck({status:"idle"});
    try{
      if(!d){ setState({phase:"empty"}); return; }
      // Payload is gzip-compressed (falls back to raw for legacy links). Inflate
      // to the canonical string, then hash + verify the signature over those
      // exact bytes — the same bytes the server signed.
      const canonBytes=await maybeGunzip(b64urlToBytes(d));
      const str=new TextDecoder().decode(canonBytes);
      const obj=JSON.parse(str);
      const rid=makeReportId(await sha256Hex(str));   // recomputed from the link
      const signed=!!(s&&k);
      const sigValid=signed?await verifyReportSignatureBytes(canonBytes,s,k):false;
      // Provenance (strongest): a valid signature proves LotCheck issued it AND
      // nothing changed. Integrity (fallback): unsigned -> only id-match.
      const phase=signed?(sigValid?"signed":"altered"):(id?(id===rid?"ok":"altered"):"unclaimed");
      setState({phase,id:rid,claimed:id,obj,signed,sigValid,sig:s});
    }catch(e){ setState({phase:"bad"}); }
  }
  useEffect(()=>{ const q=new URLSearchParams(window.location.search); runVerify(q.get("d"),q.get("id"),q.get("s"),q.get("k")); },[]);
  function verifyFromInput(){
    const raw=(input||"").trim(); if(!raw){ setHint("Paste the verify link from your LotCheck report, or scan the QR on the PDF."); return; }
    let d=null,id=null,s=null,k=null;
    try{ const u=new URL(raw); d=u.searchParams.get("d"); id=u.searchParams.get("id"); s=u.searchParams.get("s"); k=u.searchParams.get("k"); }
    catch{ try{ const qs=raw.includes("?")?raw.slice(raw.indexOf("?")+1):raw; const p=new URLSearchParams(qs); d=p.get("d"); id=p.get("id"); s=p.get("s"); k=p.get("k"); }catch{} }
    if(!d){
      // No payload to verify. The most common mistake: pasting the report ID
      // (e.g. LC-5369-4D9), which is a one-way fingerprint — nothing is stored
      // to look it up. Point the user to the full verify link / QR instead.
      const looksLikeId=/^LC[-\s]?[0-9A-Z]{3,4}[-\s]?[0-9A-Z]{2,4}$/i.test(raw);
      setHint(looksLikeId
        ? "That's the report ID — it can't be checked on its own (nothing is stored to look it up). Use the “Copy verify link” button on your report, or scan the QR on the emailed PDF. The link looks like lotcheck.ca/verify?d=…"
        : "That doesn't look like a LotCheck verify link. Paste the full link — it starts with lotcheck.ca/verify?d=… — or scan the QR on the PDF.");
      return;
    }
    setHint("");
    runVerify(d,id,s,k);
  }

  const P=state.phase;
  const authentic=P==="signed"||P==="ok", isBad=P==="altered"||P==="bad";
  // Dark/bright toggle — synced to the site-wide lc-theme key, colors identical
  // to the MSRP Alerts / Price Index tokens so Verify matches the rest of the site.
  const [vTheme,setVTheme]=useState(()=>{ try{ const s=localStorage.getItem("lc-theme"); if(s==="dark")return "dark"; if(s==="light"||s==="outdoor")return "light"; return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"; }catch{ return "dark"; } });
  const toggleVTheme=()=>{ const n=vTheme==="dark"?"light":"dark"; setVTheme(n); try{ localStorage.setItem("lc-theme",n); }catch{} };
  const vdark=vTheme==="dark";
  const T=vdark?{
    pageBg:"radial-gradient(120% 90% at 72% 25%,#141238 0%,#080a1c 55%,#05060f 100%)", text:"#e7ecf3", soft:"#c7cee6", faint:"#8b95a6",
    navBg:"rgba(10,10,22,.55)", navBorder:"rgba(255,255,255,.08)", logoText:"#fff", link:"#b6b1d6", cyan:"#3ae0ff", eyebrow:"#8b83de", heading:"#fff",
    card:"rgba(255,255,255,.03)", cardBd:"rgba(255,255,255,.08)", rowBd:"rgba(255,255,255,.08)", inputBg:"rgba(255,255,255,.06)", inputBd:"rgba(255,255,255,.14)",
  }:{
    pageBg:"#f5f7fa", text:"#141c28", soft:"#5a6577", faint:"#8590a0",
    navBg:"rgba(253,254,255,.82)", navBorder:"rgba(22,32,52,.1)", logoText:"#141c28", link:"#5a6577", cyan:"#0d8fb0", eyebrow:"#6f57e6", heading:"#141c28",
    card:"rgba(255,255,255,.72)", cardBd:"rgba(22,32,52,.1)", rowBd:"rgba(22,32,52,.1)", inputBg:"rgba(255,255,255,.92)", inputBd:"rgba(22,32,52,.16)",
  };
  const mono='ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  const money=(n)=>{const v=Number(n);return(!n||Number.isNaN(v))?"—":"$"+v.toLocaleString("en-CA");};
  const idText=state.id||"LC-••••-•••";
  const seal=authentic?{bg:"#0f6e56",bd:"#34d399",gl:P==="signed"?"🔏":"✓"}:isBad?{bg:"#7a2417",bd:"#f0997b",gl:"✕"}:{bg:"#2a2740",bd:"#7f77dd",gl:"🔒"};
  // Whole-card edge flashes green when the report verifies, red when it fails.
  const edgeBorder=authentic?"#10b981":isBad?"#f43f5e":T.cardBd;
  const edgeAnim=authentic?"vEdgeOk 1.15s ease-out 3 forwards":isBad?"vEdgeBad 1.15s ease-out 3 forwards":"none";
  const css=`
  @keyframes vFloat{0%,100%{transform:translateY(0) rotateX(8deg) rotateY(-9deg)}50%{transform:translateY(-9px) rotateX(8deg) rotateY(-9deg)}}
  @keyframes vSweep{0%{top:-10%;opacity:0}12%{opacity:1}88%{opacity:1}100%{top:108%;opacity:0}}
  @keyframes vSeal{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1);opacity:1}}
  @keyframes vRing{0%{transform:scale(.6);opacity:.7}100%{transform:scale(2.4);opacity:0}}
  @keyframes vGrid{0%{background-position:0 0}100%{background-position:0 26px}}
  @keyframes vEdgeOk{0%{box-shadow:0 0 0 1px rgba(16,185,129,.4),0 0 12px 2px rgba(16,185,129,.25)}50%{box-shadow:0 0 0 2.5px #10b981,0 0 44px 9px rgba(16,185,129,.6)}100%{box-shadow:0 0 0 1.5px rgba(16,185,129,.5),0 0 22px 4px rgba(16,185,129,.32)}}
  @keyframes vEdgeBad{0%{box-shadow:0 0 0 1px rgba(244,63,94,.4),0 0 12px 2px rgba(244,63,94,.25)}50%{box-shadow:0 0 0 2.5px #f43f5e,0 0 44px 9px rgba(244,63,94,.6)}100%{box-shadow:0 0 0 1.5px rgba(244,63,94,.5),0 0 22px 4px rgba(244,63,94,.32)}}
  .lc-gate-car{animation:lcGateDrive 4s linear infinite}
  @keyframes lcGateDrive{0%{transform:translate(-95px,-47px);opacity:0}10%{opacity:1}50%{transform:translate(0,0)}90%{opacity:1}100%{transform:translate(95px,47px);opacity:0}}
  .lc-gate-window{animation:lcGateFlash 4s linear infinite}
  @keyframes lcGateFlash{0%,40%{opacity:.22}50%{opacity:.68}60%,100%{opacity:.22}}
  @media(prefers-reduced-motion:reduce){.vfloatK,.vsweepK,.vsealK,.vringK,.vgridK,.vedge,.lc-gate-car,.lc-gate-window{animation:none!important}}
  @media(max-width:760px){.vgc{grid-template-columns:1fr!important}}
  @media(max-width:900px){.vnav-links{display:none!important}.vnav-cta{margin-left:auto!important}}
  .vnav-links a:hover{color:${T.cyan}!important}`+SHIELD_CSS;
  const Row=({t,v,c})=>(<div style={{display:"flex",justifyContent:"space-between",gap:12,padding:"9px 0",borderTop:`1px solid ${T.rowBd}`}}><span style={{fontSize:13,color:T.soft}}>{t}</span><span style={{fontFamily:mono,fontWeight:700,color:c||T.text,whiteSpace:"nowrap",fontSize:13}}>{v}</span></div>);

  const NAV=[["MSRP Price Index","/live-price-index"],["Alberta Dealers Map","/alberta"],["How it works","/#how"],["10-point lane","/#pipeline"],["Sample report","/#report"],["What LotCheck does","/#what"],["MSRP Notifier","/msrp-alerts"],["Verify report","/verify"]];
  return (
    <div style={{minHeight:"100vh",background:T.pageBg,color:T.text,transition:"background .4s ease,color .4s ease",fontFamily:"system-ui,-apple-system,'Nunito',sans-serif"}}>
      <style dangerouslySetInnerHTML={{__html:css}}/>
      <nav style={{position:"sticky",top:0,zIndex:300,background:T.navBg,backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:`1px solid ${T.navBorder}`}}>
        <div style={{maxWidth:1120,margin:"0 auto",padding:"11px clamp(16px,3vw,28px)",display:"flex",alignItems:"center",gap:16}}>
          <a href="/" style={{display:"flex",alignItems:"center",gap:9,textDecoration:"none",color:T.logoText,fontWeight:800,fontSize:"1.05rem"}}><SiteLogo size={45}/>LotCheck</a>
          <div className="vnav-links" style={{display:"flex",gap:14,marginLeft:"auto",alignItems:"center",flexWrap:"nowrap"}}>
            {NAV.map(([label,href])=>{const active=label==="Verify";return <a key={label} href={href} style={{fontSize:".9rem",fontWeight:active?800:600,color:active?T.cyan:T.link,textDecoration:"none",whiteSpace:"nowrap"}}>{label}</a>;})}
          </div>
          <button onClick={toggleVTheme} aria-label={vdark?"Switch to bright mode":"Switch to dark mode"} title={vdark?"Bright mode":"Dark mode"} style={{background:"transparent",border:`1px solid ${T.navBorder}`,color:T.link,borderRadius:999,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,flexShrink:0}}>{vdark?"☀":"☾"}</button>
          <a href="/quote-check" className="vnav-cta" style={{background:"#2FA79A",color:"#fff",fontWeight:800,fontSize:".85rem",textDecoration:"none",padding:"8px 15px",borderRadius:10,whiteSpace:"nowrap"}}>Analyze my quote</a>
        </div>
      </nav>
      <div style={{padding:"28px 18px",display:"flex",justifyContent:"center"}}>
      <div style={{width:"100%",maxWidth:920}}>
        <div style={{color:T.eyebrow,fontSize:11,letterSpacing:"2px",textTransform:"uppercase",fontWeight:700,marginBottom:14,fontFamily:mono}}>LotCheck · Verify</div>
        <div className="vgc vedge" style={{display:"grid",gridTemplateColumns:"1.05fr .95fr",background:T.card,border:`1px solid ${edgeBorder}`,borderRadius:18,overflow:"hidden",boxShadow:vdark?"none":"0 20px 50px rgba(51,48,90,.12)",animation:edgeAnim}}>

          <div style={{position:"relative",minHeight:340,padding:22,display:"flex",flexDirection:"column",justifyContent:"flex-end",borderRight:`1px solid ${T.cardBd}`,overflow:"hidden",background:vdark?"transparent":"linear-gradient(180deg,#141238,#0e0b1c)"}}>
            <div className="vgridK" style={{position:"absolute",left:"-25%",right:"-25%",bottom:0,height:"55%",backgroundImage:"linear-gradient(rgba(52,211,153,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(139,131,222,.16) 1px,transparent 1px)",backgroundSize:"26px 26px",transform:"perspective(420px) rotateX(60deg)",transformOrigin:"bottom",WebkitMaskImage:"linear-gradient(to top,#000 5%,transparent 78%)",maskImage:"linear-gradient(to top,#000 5%,transparent 78%)",animation:"vGrid 3.4s linear infinite"}}/>
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
              <svg viewBox="-145 -44 320 182" aria-hidden="true" style={{width:"78%",maxWidth:300,filter:`drop-shadow(0 24px 44px ${seal.bd}44)`}}>
                <polygon points="0,-36 170,49 30,119 -140,34" fill="rgb(184,222,184)"/><polygon points="-140,48 30,133 30,119 -140,34" fill="rgb(160,203,160)"/><polygon points="170,63 30,133 30,119 170,49" fill="rgb(136,172,136)"/><polygon points="-50,5 100,80 52,104 -98,29" fill="#D9DBEF"/><polygon points="-4,-26 8,-20 -4,-14 -16,-20" fill="rgb(182,171,228)"/><polygon points="-16,22 -4,28 -4,-14 -16,-20" fill="rgb(158,145,210)"/><polygon points="8,22 -4,28 -4,-14 8,-20" fill="rgb(135,124,179)"/><polygon points="-72,8 -60,14 -72,20 -84,14" fill="rgb(182,171,228)"/><polygon points="-84,56 -72,62 -72,20 -84,14" fill="rgb(158,145,210)"/><polygon points="-60,56 -72,62 -72,20 -60,14" fill="rgb(135,124,179)"/><polygon points="1,-38.5 11,-33.5 -77,10.5 -87,5.5" fill="rgb(194,184,235)"/><polygon points="-87,16.5 -77,21.5 -77,10.5 -87,5.5" fill="rgb(172,160,218)"/><polygon points="11,-22.5 -77,21.5 -77,10.5 11,-33.5" fill="rgb(146,136,185)"/><g className="lc-gate-window"><polygon points="6,17 -82,61 -82,17 6,-27" fill="rgba(47,167,154,.22)"/></g><g className="lc-gate-car"><polygon points="-13,33.5 40,60 13,73.5 -40,47" fill="rgba(51,48,90,.10)"/><polygon points="-12,25 34,48 12,59 -34,36" fill="rgb(244,150,130)"/><polygon points="-34,44 12,67 12,59 -34,36" fill="rgb(227,123,100)"/><polygon points="34,56 12,67 12,59 34,48" fill="rgb(193,104,85)"/><polygon points="-5,23.5 17,34.5 1,42.5 -21,31.5" fill="rgb(244,150,130)"/><polygon points="-21,39.5 1,50.5 1,42.5 -21,31.5" fill="rgb(227,123,100)"/><polygon points="17,42.5 1,50.5 1,42.5 17,34.5" fill="rgb(193,104,85)"/><polygon points="17,42.5 1,50.5 1,43.5 17,35.5" fill="#E6F4F6"/><polygon points="-18,40 -1,48.5 -1,43.5 -18,35" fill="#DDEDF2"/><polygon points="-25,43.5 -18,47 -22,49 -29,45.5" fill="rgb(98,93,130)"/><polygon points="-29,50.5 -22,54 -22,49 -29,45.5" fill="rgb(64,59,100)"/><polygon points="-18,52 -22,54 -22,49 -18,47" fill="rgb(55,50,85)"/><polygon points="1,56.5 8,60 4,62 -3,58.5" fill="rgb(98,93,130)"/><polygon points="-3,63.5 4,67 4,62 -3,58.5" fill="rgb(64,59,100)"/><polygon points="8,65 4,67 4,62 8,60" fill="rgb(55,50,85)"/><polygon points="30,55 25,57.5 25,54.5 30,52" fill="#FFF3C9"/></g>
              </svg>
            </div>
            <div key={P} style={{position:"absolute",right:14,bottom:44,zIndex:3,filter:`drop-shadow(0 0 16px ${seal.bd}66)`,animation:"vSeal 1s ease-out both"}}><Shield state={authentic?"ok":isBad?"bad":"idle"} size={56}/></div>
            <div style={{position:"relative",zIndex:2,display:"inline-flex",alignItems:"center",gap:7,fontSize:11,fontWeight:700,color:"#5dcaa5",background:"rgba(52,211,153,.12)",border:"1px solid rgba(52,211,153,.35)",borderRadius:8,padding:"6px 11px",alignSelf:"flex-start"}}>Tamper-proof · nothing stored</div>
          </div>

          <div style={{padding:"24px 22px",color:T.text}}>
            {P==="loading"&&<div style={{color:T.soft,fontSize:14}}>Verifying…</div>}
            {(P==="empty"||P==="bad")&&(<>
              <div style={{fontSize:11,letterSpacing:2,textTransform:"uppercase",color:T.eyebrow,fontWeight:700}}>Verify</div>
              <div style={{fontSize:22,fontWeight:700,margin:"6px 0",color:T.heading}}>Is this LotCheck report real?</div>
              <div style={{fontSize:13,color:T.soft,lineHeight:1.6,marginBottom:14}}>{P==="bad"?"That link's data is incomplete or was altered, so its fingerprint doesn't compute. Paste the original link from your LotCheck report.":"Paste the verify link, or scan the QR on any LotCheck PDF — we recompute its fingerprint and check the signature, nothing stored. The report ID on its own can't be checked (there's nothing stored to look it up)."}</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <input value={input} onChange={e=>{setInput(e.target.value);if(hint)setHint("");}} onKeyDown={e=>{if(e.key==="Enter")verifyFromInput();}} placeholder="lotcheck.ca/verify?d=…" style={{flex:"1 1 200px",background:T.inputBg,border:`1px solid ${hint?"rgba(240,153,123,.6)":T.inputBd}`,borderRadius:10,padding:"11px 12px",fontSize:12.5,color:T.text,outline:"none",boxSizing:"border-box"}}/>
                <button onClick={verifyFromInput} style={{background:"#2FA79A",color:"#fff",border:"none",borderRadius:10,padding:"11px 18px",fontSize:13,fontWeight:800,cursor:"pointer"}}>Verify</button>
              </div>
              {hint
                ? <div style={{marginTop:11,fontSize:12,lineHeight:1.55,color:"#c0532f",background:"rgba(240,153,123,.14)",border:"1px solid rgba(240,153,123,.4)",borderRadius:9,padding:"9px 11px"}}>{hint}</div>
                : <div style={{marginTop:12,fontSize:11.5,color:T.faint}}>Paste the link, or scan the QR on the printed report — the report ID alone can’t be checked.</div>}
            </>)}
            {(P==="signed"||P==="ok"||P==="altered"||P==="unclaimed")&&(()=>{
              const o=state.obj||{};
              const issued=o.issuedAt?new Date(o.issuedAt):null;
              // This page is stamped "Signed & authentic — not one figure has
              // changed", and it was publishing an over/under claim the report it
              // authenticates explicitly refuses to make. A dealer opening the QR
              // off the PDF saw LotCheck's own tamper-proof page assert a
              // discount the report denied. Same rule as every other surface now.
              const vclaim=qualifyMsrpClaim({msrp:o.price?.msrp,quotedPrice:o.price?.asking,
                msrpBasis:o.basis?.b,msrpTrim:o.basis?.t,msrpYear:o.basis?.y,
                year:o.year,priceVerified:o.price?.verified});
              const delta=vclaim.delta??0;
              const title=P==="signed"?"Signed & authentic":P==="ok"?"Authentic report":P==="altered"?(state.signed?"Signature check failed":"This report was altered"):"Confirm the report ID";
              const accent=authentic?"#34d399":isBad?"#f0997b":"#7f77dd";
              return (<div>
                <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:6}}>
                  <span style={{width:24,height:24,borderRadius:999,background:accent,color:"#0e0b1c",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:900}}>{authentic?"✓":isBad?"✕":"?"}</span>
                  <div style={{fontSize:18,fontWeight:800,color:T.heading}}>{title}</div>
                </div>
                <div style={{fontSize:12.5,color:T.soft,lineHeight:1.6,marginBottom:12}}>
                  {P==="signed"&&<>Valid LotCheck signature over <b style={{fontFamily:mono,color:T.text}}>{state.id}</b>. Could only have been issued by LotCheck, and not one figure has changed.</>}
                  {P==="ok"&&<>Contents produce <b style={{fontFamily:mono,color:T.text}}>{state.id}</b>, matching the claimed ID. Every figure below is unaltered.</>}
                  {P==="altered"&&state.signed&&<>The signature is <b style={{color:"#d6533f"}}>not valid</b> for these contents — altered after signing, or not from LotCheck. Don't trust the figures.</>}
                  {P==="altered"&&!state.signed&&<>Claims to be <b style={{fontFamily:mono}}>{state.claimed}</b> but produces <b style={{fontFamily:mono,color:"#d6533f"}}>{state.id}</b>. A figure was changed after issue.</>}
                  {P==="unclaimed"&&<>Contents produce <b style={{fontFamily:mono,color:T.text}}>{state.id}</b>. Confirm it matches the ID printed on your report.</>}
                </div>
                {P==="signed"&&state.sig&&(
                  <div style={{display:"flex",alignItems:"center",gap:12,margin:"2px 0 14px",padding:"10px 12px",background:vdark?"rgba(127,119,221,.08)":"rgba(111,87,230,.08)",border:`1px solid ${vdark?"rgba(127,119,221,.25)":"rgba(111,87,230,.28)"}`,borderRadius:10}}>
                    <div style={{flex:"none"}}><Seal seed={sealSeed(state.sig)} size={66} gid="vseal"/></div>
                    <div style={{fontSize:11.5,color:T.soft,lineHeight:1.5}}>This report's <b style={{color:T.eyebrow}}>unique seal</b> — drawn from its signature. No other report has it, and it can't be reproduced without LotCheck's key.</div>
                  </div>
                )}
                <div style={{background:vdark?"rgba(255,255,255,.04)":"rgba(255,255,255,.6)",border:`1px solid ${T.cardBd}`,borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:15,fontWeight:700,color:T.heading}}>{o.vehicle||"Vehicle"}</div>
                  <div style={{fontSize:12.5,color:T.soft,fontStyle:"italic",marginBottom:4}}>{[o.dealer?.name,o.dealer?.city].filter(Boolean).join(", ")}{issued?` · ${issued.toLocaleString("en-CA",{dateStyle:"medium",timeStyle:"short"})}`:""}</div>
                  <Row t="Asking price" v={o.price?.asking?money(o.price.asking)+(o.allIn?" · all-in":""):(o.pd==="contact_for_price"?"Hidden by the dealer":"Not shown")} c={(!o.price?.asking&&o.pd==="contact_for_price")?"#f0997b":undefined}/>
                  {/* The label came from o.price.verified, which is the ASKING
                      PRICE's flag, not the MSRP's — so a dealer's own unverified
                      sticker was printed as "MSRP (verified)" in green on the
                      verification page. The label now follows the BASIS. */}
                  {o.price?.msrp&&<Row t={vclaim.label} v={money(o.price.msrp)} c={vclaim.comparable?"#34d399":T.soft}/>}
                  {vclaim.comparable&&delta!==0&&<Row t="Price vs MSRP" v={delta<0?money(-delta)+" under":money(delta)+" over"} c={delta<=0?"#34d399":"#f0997b"}/>}
                  {!vclaim.comparable&&vclaim.refusal&&<div style={{fontSize:12,color:T.soft,lineHeight:1.5,marginTop:6}}>{vclaim.refusal}</div>}
                  <Row t="VIN" v={o.vin||"Not published — ask the dealer"} c={o.vin?undefined:T.soft}/>
                  {o.odo!=null&&<Row t="Odometer" v={`${Number(o.odo).toLocaleString()} km`}/>}
                  {o.dol&&<Row t="Days on lot" v={`${Number(o.dol.d).toLocaleString()} days${o.dol.s?` · since ${o.dol.s}`:""}`} c={o.dol.d>=90?"#f0997b":o.dol.d>=31?"#eab308":"#34d399"}/>}
                  {o.fcx&&<Row t="Price conditions" v="Tied to dealer financing" c="#f0997b"/>}
                  {o.leverage!=null&&<Row t="Leverage score" v={`${Number(o.leverage).toFixed(1)} / 10`}/>}
                  {o.recalls&&<Row t="Recalls · Transport Canada" v={o.recalls.count>0?`${o.recalls.count} open`:(o.recalls.confirmed===false?"Not confirmed":"None open")} c={o.recalls.count>0?"#f0997b":"#34d399"}/>}
                  {o.finance&&(o.finance.dealer!=null||o.finance.manufacturer!=null)&&<Row t="Financing APR" v={`${o.finance.dealer!=null?o.finance.dealer+"% dealer":""}${o.finance.dealer!=null&&o.finance.manufacturer!=null?" · ":""}${o.finance.manufacturer!=null?o.finance.manufacturer+"% advertised":""}`}/>}
                  {o.finance&&o.finance.math!=null&&<Row t="Financing math" v={o.finance.math?"Reconciles":"Doesn't add up"} c={o.finance.math?"#34d399":"#f0997b"}/>}
                  {o.reputation&&<Row t="Dealer reputation" v={`${Number(o.reputation.rating).toFixed(1)}★ · ${Number(o.reputation.reviews||0).toLocaleString()} reviews`}/>}
                  {o.marketValue&&o.marketValue.avg!=null&&<Row t={`Market value · ${o.marketValue.source||"independent"}`} v={money(o.marketValue.avg)}/>}
                  {o.allIn&&<Row t="Price basis" v={`All-in (${o.allIn})`} c="#34d399"/>}
                  {o.disc&&(o.disc.e||o.disc.x)&&<Row t="Dealer fine print" v={o.disc.x?"Self-contradictory":"Hedges the price"} c="#f0997b"/>}
                  {/* Green "Sealed" ONLY behind a valid signature — in ok/altered/
                      unclaimed phases the hash is just a claim in a link anyone
                      could mint, and stamping it "Sealed" lends a doctored
                      image LotCheck's credibility. */}
                  {o.shot&&P==="signed"&&<Row t="Listing photo" v={`Sealed · ${String(o.shot).slice(0,10)}…`} c="#34d399"/>}
                  {(o.addOns||[]).length>0&&(
                    <div style={{borderTop:`1px solid ${T.rowBd}`,paddingTop:9,marginTop:2}}>
                      <div style={{fontSize:12,color:T.soft,marginBottom:4,fontWeight:700}}>Add-ons & line items</div>
                      {(o.addOns||[]).slice(0,8).map((x,i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",gap:10,padding:"3px 0",fontSize:12.5}}>
                          <span style={{color:x.verdict==="flagged"?"#f0997b":T.soft}}>{x.verdict==="flagged"?"⚑ ":""}{x.name}</span>
                          <span style={{fontFamily:mono,color:T.text}}>{money(x.price)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {o.recalls&&(o.recalls.items||[]).length>0&&(
                    <div style={{borderTop:`1px solid ${T.rowBd}`,paddingTop:9,marginTop:2}}>
                      <div style={{fontSize:12,color:T.soft,marginBottom:4,fontWeight:700}}>Open recalls</div>
                      {(o.recalls.items||[]).slice(0,6).map((it,i)=>(
                        <div key={i} style={{fontSize:12.5,color:"#f0997b",padding:"2px 0"}}>{it.system||"Recall"}{it.date&&!Number.isNaN(new Date(it.date).getFullYear())?` · ${new Date(it.date).getFullYear()}`:""}</div>
                      ))}
                    </div>
                  )}
                  {o.summary&&<div style={{borderTop:`1px solid ${T.rowBd}`,paddingTop:10,marginTop:4,fontSize:12.5,color:T.soft,lineHeight:1.6,fontStyle:"italic"}}>{o.summary}</div>}
                </div>
                {o.shot&&P==="signed"&&(()=>{
                  const pc=photoCheck;
                  // Verdict inks flip with the theme — the dark-palette greens/
                  // salmons wash out to ~2:1 contrast on the bright background.
                  const okInk=vdark?"#34d399":"#047857";
                  const badInk=vdark?"#f0997b":"#b4490f";
                  const zoneBd=pc.status==="match"?okInk:(pc.status==="mismatch"||pc.status==="toobig")?badInk:zoneUi.drag?T.cyan:T.cardBd;
                  return (
                    <div
                      onDragEnter={e=>{e.preventDefault();setZoneUi(u=>({...u,drag:true}));}}
                      onDragOver={e=>{e.preventDefault();if(!zoneUi.drag)setZoneUi(u=>({...u,drag:true}));}}
                      onDragLeave={e=>{if(e.currentTarget.contains(e.relatedTarget))return;setZoneUi(u=>({...u,drag:false}));}}
                      onDrop={e=>{e.preventDefault();setZoneUi(u=>({...u,drag:false}));const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];checkPhotoFile(f,o.shot);}}
                      style={{marginTop:12,border:`1.5px dashed ${zoneBd}`,borderRadius:12,padding:"13px 15px",background:zoneUi.drag?(vdark?"rgba(58,224,255,.06)":"rgba(13,143,176,.06)"):vdark?"rgba(255,255,255,.03)":"rgba(255,255,255,.55)"}}>
                      <div style={{fontSize:12.5,fontWeight:800,color:T.heading,marginBottom:4}}>Check the sealed photo</div>
                      <div style={{fontSize:12,color:T.soft,lineHeight:1.55}}>This signed report seals a full-page photo of the listing (fingerprint <span style={{fontFamily:mono}}>{String(o.shot).slice(0,10)}…</span>). Drop the “listing-capture” file from your LotCheck email here — your browser recomputes its fingerprint and compares. Nothing is uploaded.</div>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginTop:9,flexWrap:"wrap"}}>
                        <label style={{position:"relative",display:"inline-flex",alignItems:"center",minHeight:44,background:"transparent",border:`1px solid ${zoneUi.focus?T.cyan:T.cardBd}`,boxShadow:zoneUi.focus?`0 0 0 2px ${vdark?"rgba(58,224,255,.35)":"rgba(13,143,176,.3)"}`:"none",borderRadius:9,padding:"10px 16px",fontSize:12,fontWeight:700,color:T.cyan,cursor:"pointer"}}>
                          Choose photo
                          {/* Visually hidden, NOT display:none — keeps the input in the tab
                              order so keyboard users can reach the file picker (drag-and-drop
                              has no keyboard path). */}
                          <input type="file" accept="image/*"
                            style={{position:"absolute",opacity:0,width:1,height:1,overflow:"hidden",pointerEvents:"none"}}
                            onFocus={()=>setZoneUi(u=>({...u,focus:true}))}
                            onBlur={()=>setZoneUi(u=>({...u,focus:false}))}
                            onChange={e=>{const f=e.target.files&&e.target.files[0];checkPhotoFile(f,o.shot);e.target.value="";}}/>
                        </label>
                        {pc.status==="hashing"&&<span style={{fontSize:12,color:T.soft}}>Checking…</span>}
                      </div>
                      <div role="status" aria-live="polite">
                        {pc.status==="match"&&<div style={{marginTop:10,fontSize:12,lineHeight:1.55,color:okInk,background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.35)",borderRadius:9,padding:"9px 11px"}}>This photo is the untouched original — its fingerprint matches the one sealed in this signed report. It shows the listing exactly as it looked at report time.</div>}
                        {pc.status==="mismatch"&&<div style={{marginTop:10,fontSize:12,lineHeight:1.55,color:badInk,background:"rgba(240,153,123,.12)",border:"1px solid rgba(240,153,123,.4)",borderRadius:9,padding:"9px 11px"}}>This image doesn't match the sealed fingerprint (it computes <span style={{fontFamily:mono}}>{String(pc.hex||"").slice(0,10)}…</span>). That only means it isn't the exact original file — images that were edited, re-saved, screenshotted or recompressed by another app also stop matching. Try the original “listing-capture” attachment from your LotCheck email.</div>}
                        {pc.status==="toobig"&&<div style={{marginTop:10,fontSize:12,lineHeight:1.55,color:badInk}}>That file is too large to be a LotCheck capture — use the “listing-capture” image attached to your LotCheck email.</div>}
                        {pc.status==="noseal"&&<div style={{marginTop:10,fontSize:12,lineHeight:1.55,color:T.soft}}>This report link doesn't carry a sealed photo fingerprint, so there's nothing to compare against.</div>}
                        {pc.status==="error"&&<div style={{marginTop:10,fontSize:12,color:T.soft}}>Couldn't read that file — try again with the image file from your LotCheck email.</div>}
                      </div>
                    </div>
                  );
                })()}
                <div style={{display:"flex",gap:10,marginTop:12,flexWrap:"wrap"}}>
                  <button onClick={()=>{if(window.history.length>1)window.history.back();else window.location.href="/quote-check";}} style={{background:T.eyebrow,border:"none",color:"#0b0b14",borderRadius:9,padding:"8px 16px",fontSize:12,fontWeight:800,cursor:"pointer"}}>Back to report</button>
                  <button onClick={()=>{setInput("");photoSeqRef.current++;setPhotoCheck({status:"idle"});setState({phase:"empty"});}} style={{background:"transparent",border:`1px solid ${T.cardBd}`,color:T.soft,borderRadius:9,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Verify another</button>
                </div>
              </div>);
            })()}
          </div>
        </div>
        <p style={{color:T.faint,fontSize:12,lineHeight:1.6,marginTop:16,maxWidth:640}}>LotCheck doesn't store your report — this page recomputes its fingerprint and checks the signature live from the link. Every figure traces to a public source you can re-check: recalls to Transport Canada, MSRP to the manufacturer catalogue, reviews to Google.</p>
        <a href="/real" style={{display:"inline-block",marginTop:10,fontSize:12.5,fontWeight:700,color:T.eyebrow,textDecoration:"none"}}>Worried about fakes? How to spot a real LotCheck report →</a>
      </div>
      </div>
    </div>
  );
}

function QuoteCheckPage(){
  // Alberta-only gate. Hooks must run unconditionally, so this sits at the top
  // and the early return happens after every other hook has been declared.
  const region=useRegionGate();
  // Current signed-in user (magic-link). Single source of truth via the shared
  // hook; null when logged out. Drives the header entry point and the
  // result-first sign-in prompt below. No gating/enforcement here (Phase 2).
  const user=useSupabaseUser();
  const [showSignIn,setShowSignIn]=useState(false);
  // Optional nudge shown inside SignInModal — set when an anonymous user hits
  // the global free-check breaker (HTTP 429 free_limit_reached), cleared on close.
  const [signInNotice,setSignInNotice]=useState(null);
  // Phase 4 credits. Balance is server-authoritative -- read from fn_my_credits
  // on load / auth change and refreshed from each check's `credits.personal`;
  // never computed client-side. `freeUsed` gates the single anonymous free
  // check via a per-device localStorage flag. `showPaywall` opens on HTTP 402.
  const [balance,setBalance]=useState(null); // {personal, shareable} | null (signed-out or not yet loaded)
  const [freeUsed,setFreeUsed]=useState(isFreeCheckUsed);
  const [showPaywall,setShowPaywall]=useState(false);
  // Gift-link redemption (…/quote-check?gift=CODE). The code is stashed in
  // localStorage on arrival so it survives the magic-link sign-in round-trip
  // (which returns to /quote-check WITHOUT the query param), then redeemed the
  // moment a session exists. giftClaim drives the banner: pending -> waiting for
  // sign-in; success/already/error -> outcome message.
  const [giftPending,setGiftPending]=useState(null); // the code, or null
  const [giftClaim,setGiftClaim]=useState(null);     // {status:"success"|"already"|"error", msg} | null
  useEffect(()=>{
    try{
      const url=new URL(window.location.href);
      const g=url.searchParams.get("gift");
      if(g){
        localStorage.setItem("lc_pending_gift", g.trim().toUpperCase());
        url.searchParams.delete("gift");
        window.history.replaceState({}, "", url.pathname+url.search+url.hash);
      }
      const stashed=localStorage.getItem("lc_pending_gift");
      if(stashed) setGiftPending(stashed);
    }catch{}
  },[]);
  // Redeem as soon as we have both a signed-in user and a pending code.
  useEffect(()=>{
    if(!user||!giftPending) return;
    let active=true;
    (async()=>{
      try{
        const {data,error}=await supabase.rpc("fn_redeem_gift",{p_code:giftPending});
        if(!active) return;
        if(error){
          const m=/already claimed a free/i.test(error.message)?"You've already had a free check on this account."
                 :/already used/i.test(error.message)?"This link was already used."
                 :/not valid/i.test(error.message)?"This link isn't valid."
                 :/cancelled/i.test(error.message)?"This link was cancelled."
                 :"Couldn't claim this free check.";
          setGiftClaim({status:"error",msg:m});
        }else{
          if(data&&typeof data.personal==="number") setBalance(prev=>({personal:data.personal,shareable:prev?.shareable??0}));
          setGiftClaim({status:data?.already?"already":"success",msg:data?.already?"You've already claimed this check.":"Free check added to your account."});
        }
      }catch(e){
        if(active) setGiftClaim({status:"error",msg:"Couldn't claim this free check."});
      }finally{
        try{ localStorage.removeItem("lc_pending_gift"); }catch{}
        if(active) setGiftPending(null);
      }
    })();
    return ()=>{ active=false; };
  },[user,giftPending]);
  const [status,setStatus]=useState("idle"); // idle | analyzing | choose | done | error
  // Set when one uploaded image turned out to hold several different vehicles
  // (a Google "Sponsored Vehicles" carousel, a dealer results page). We ask
  // which one rather than reporting on whichever the model saw first.
  const [vehicleChoices,setVehicleChoices]=useState(null);
  const [scanMsg,setScanMsg]=useState(""); // rotating progress line shown while status==="analyzing"
  // Brief (900ms) success beat shown in the full-screen ScanTakeover right as
  // a scan actually finishes -- tracked separately from `status` because the
  // takeover needs to keep rendering for a moment *after* status has already
  // flipped to "done" (report is already computed and rendering underneath).
  // Only fires on a real analyzing->done transition, never on error/idle, so
  // the "successfully scanned" message is never shown for a scan that failed.
  const prevStatusRef=useRef("idle");
  const [scanFlash,setScanFlash]=useState(false);
  const [analysis,setAnalysis]=useState(null);
  // Report presentation: "scroll" (default, canonical) or "flip" (the flip-book
  // "Report view"). `sharedReport` is true when the analysis was reconstructed
  // from a self-contained share link (#r=...), never fetched or stored.
  const [reportView,setReportView]=useState("scroll"); // the scroll is the default "full story" view (Bento/Deck/Scorecard/HUD removed 2026-08-12 — too many display modes)
  const [sharedReport,setSharedReport]=useState(false);
  // Authenticity of an OPENED shared report: "valid" | "invalid" | null
  // (null = no signature to check / crypto unavailable — say "fingerprint only").
  const [sharedAuth,setSharedAuth]=useState(null);
  const [linkCopied,setLinkCopied]=useState(false);
  // On mount, reconstruct a shared report entirely client-side from the URL
  // fragment — nothing hits a server, nothing is stored (keeps "never stored").
  useEffect(()=>{
    try{
      const m=(window.location.hash||"").match(/[#&]r=([^&]+)/);
      if(m){
        const rep=decodeReport(m[1]);
        if(rep){ setAnalysis(rep); setAnalysisSource("listing"); setStatus("done"); setReportView("flip"); setSharedReport(true);
          window.history.replaceState({},"",window.location.pathname);
          // Check the seal: the report carries its own ECDSA signature; verify
          // it right here with our public key so the recipient sees a live
          // authenticity verdict on top of the FULL report.
          if(rep.verifyPayload&&rep.sig&&rep.keyId){
            verifyReportSignature(rep.verifyPayload,rep.sig,rep.keyId)
              .then((ok)=>setSharedAuth(ok?"valid":"invalid"))
              .catch(()=>setSharedAuth(null));
          }
        }
      }
    }catch{}
  },[]);
  const copyShareLink=async()=>{
    if(!analysis) return;
    const url=window.location.origin+"/quote-check#r="+encodeReport(analysis);
    try{ await navigator.clipboard.writeText(url); setLinkCopied(true); setTimeout(()=>setLinkCopied(false),2200); }
    catch{ setLinkCopied(false); }
  };
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
  // reportId is passed so the reputation checkpoint this function records lands
  // against the same report as the other twelve. Without it the row is orphaned
  // and the ledger can count reputation but never tie it to a report.
  const fetchDealerSentiment=async(dealerName,dealerCity,reportId)=>{
    if(!dealerName) return;
    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/get-dealer-sentiment",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({dealerName,dealerCity,reportId:reportId??null}),
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
  const [verifyCopied,setVerifyCopied]=useState(false);
  const [scriptCopied,setScriptCopied]=useState(false);
  function copyCounterScript(){
    const cs=analysis?.counterScript; if(!cs?.moves?.length) return;
    const text=cs.moves.map((m,i)=>`${i+1}. ${m.say}`).join("\n");
    try{ navigator.clipboard.writeText(text).then(()=>{setScriptCopied(true);setTimeout(()=>setScriptCopied(false),2200);}); }catch(e){}
  }

  // Native VIN history removed — VinAudit subscription cancelled. History is
  // handled via the CARFAX hand-off; a new provider can slot in here later.

  // Copy the tamper-evident VERIFY link (payload + claimed id) to the clipboard.
  // Distinct from copyShareLink above, which copies the "#r=" full-report link:
  // this one goes to /verify and proves the figures are unaltered. Nothing is
  // stored server-side — the link itself is the whole record.
  function copyVerifyLink(){
    // ONE link: the self-contained share link — it reconstructs the ENTIRE
    // report client-side AND carries the signature, so the recipient sees the
    // whole report under an authenticity banner (not the bare-fingerprint
    // /verify summary, which stays available as the secondary "check the seal"
    // link). Nothing stored server-side — the proof travels inside the link.
    const url=window.location.origin+"/quote-check#r="+encodeReport(analysis);
    if(!url) return;
    try{
      navigator.clipboard.writeText(url).then(()=>{setVerifyCopied(true);setTimeout(()=>setVerifyCopied(false),2200);});
    }catch(e){ /* clipboard blocked — link is still shown for manual copy */ }
  }

  function isValidEmail(v){
    // Deliberately simple -- catches typos ("bob@gmailcom") without the
    // false-negative risk of a stricter regex rejecting a real address.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  async function sendReportEmail(overrideEmail){
    // overrideEmail lets the auto-send effect pass the address explicitly
    // instead of reading emailInput -- state set via setEmailInput() in the
    // same tick isn't guaranteed to have committed yet by the time this runs.
    const email=(overrideEmail??emailInput).trim();
    if(!isValidEmail(email)){
      setEmailErr("That doesn't look like a valid email address.");
      return;
    }
    setEmailErr("");
    setEmailStatus("sending");
    // The on-screen EVAP rebate card is computed client-side, so attach the
    // computed rebate to the payload so the emailed report includes it too.
    let emailAnalysis=analysis;
    try{
      const {show,rebate}=resolveEvap(analysis);
      if(show&&rebate) emailAnalysis={...analysis,evapRebate:rebate};
    }catch{}
    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/email-quote-report",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
          "Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A",
        },
        body:JSON.stringify({email,analysis:emailAnalysis,reportUrl:(window.location.origin+"/quote-check#r="+encodeReport(analysis)),verifyUrl:verifyLinkFor(analysis)||undefined}),
      });
      const data=await res.json();
      if(!res.ok||data.error){
        setEmailStatus("error");
        // Prefer the human `message` over the machine `error` code. The
        // function returns structured errors (e.g. pdf_generation_failed) and
        // showing the raw slug to a buyer is worse than showing nothing.
        setEmailErr(data.message||data.error||"Couldn't send that email. Please try again.");
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
  // Dark = the cosmic palette from the MSRP Notifier page: near-black indigo
  // chrome + cyan hero accent. Coral (flags) and butter (caution) stay warm so
  // the color-coding still reads. Light/outdoor modes are unchanged.
  const QC_DARK={
    ink:"#eaf0ff", inkSoft:"#c7cee6", inkFaint:"#9aa2c4",
    paper:"#080a1c", paper2:"#0f1228", card:"#15163a",
    line:"rgba(150,170,255,.16)", borderWidth:"1px", cardShadow:"0 20px 60px -20px rgba(0,0,0,.6)",
    teal:"#3ae0ff", tealInk:"#8fe9ff", tealBg:"rgba(58,224,255,.14)",
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

  // ── Vision normalization ───────────────────────────────────────────────────
  // Claude's vision API hard-rejects a single image over ~5MB, and it scales
  // anything past ~1568px on the long edge down before the model ever sees it.
  // We were sending the raw file: the client allowed 15MB and the edge function
  // allowed a 20M-char base64, so every upload in the ~5-15MB band sailed past
  // both guards and came back a 400 from Anthropic, surfacing as the generic
  // "The analysis service returned an error" card (confirmed 2026-08-15 on a
  // PNG screenshot of a Google results page). Sending oversized bytes never
  // bought detail -- it only bought that failure.
  //
  // Tall screenshots are THE primary upload here (screenshot-first directive),
  // and naively fitting a 1920x9000 capture inside 1568 on the long edge would
  // squeeze it to ~334px wide -- every number on it unreadable. So width is
  // what we cap; height is SLICED into overlapping tiles that each stay within
  // budget and each keep full horizontal resolution. Claude reads them as one
  // continuous page (the server labels them top-to-bottom and says so).
  const VISION_MAX_W=1568;        // Anthropic's own downscale target
  const VISION_MAX_TILE_H=1568;   // keep each tile within the same budget
  const VISION_TILE_OVERLAP=110;  // px repeated between tiles so a line of text
                                  // split across a seam is whole in one of them
  const VISION_MAX_TILES=8;       // hard ceiling on request weight
  const VISION_JPEG_QUALITY=0.92;
  // Tiling exists for SCROLLING SCREENSHOTS -- a capture of a whole web page,
  // which is narrow and enormously tall. An ordinary phone photo of a paper
  // quote is ~3:4 and reads fine as one downscaled image; slicing it would
  // double the request weight and cost for the most common upload while
  // helping nothing. So the trigger is the aspect ratio, not raw height.
  const VISION_TALL_RATIO=2.2;
  // Long edge of the cheap triage frame. Small enough to cost roughly a tenth
  // of a full read, large enough to count distinct vehicle cards on a grid.
  const VISION_TRIAGE_MAX_EDGE=800;

  async function decodeImage(file){
    // createImageBitmap is the fast path and avoids EXIF orientation quirks on
    // iOS; the <img> fallback keeps older/locked-down browsers working rather
    // than handing the person a dead end (own-the-process-no-user-limits).
    if(typeof globalThis.createImageBitmap==="function"){
      try{ return await globalThis.createImageBitmap(file); }catch{}
    }
    const url=URL.createObjectURL(file);
    try{
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        img.onload=()=>resolve(img);
        img.onerror=()=>reject(new Error("decode failed"));
        img.src=url;
      });
    } finally { setTimeout(()=>URL.revokeObjectURL(url),0); }
  }

  function canvasToBase64(canvas,quality){
    return new Promise((resolve,reject)=>{
      if(canvas.toBlob){
        canvas.toBlob((blob)=>{
          if(!blob) return reject(new Error("encode failed"));
          const reader=new FileReader();
          reader.onload=()=>resolve(reader.result.split(",")[1]);
          reader.onerror=()=>reject(new Error("encode read failed"));
          reader.readAsDataURL(blob);
        },"image/jpeg",quality);
      } else {
        try{ resolve(canvas.toDataURL("image/jpeg",quality).split(",")[1]); }
        catch(e){ reject(e); }
      }
    });
  }

  // Returns [{b64, mediaType}] -- one entry for a normal image, several for a
  // tall screenshot. Throws only if the image can't be decoded at all; the
  // caller falls back to sending the original bytes so a normalization bug can
  // never be the thing that blocks a report.
  async function normalizeImageForVision(file){
    const bmp=await decodeImage(file);
    const srcW=bmp.width||bmp.naturalWidth, srcH=bmp.height||bmp.naturalHeight;
    if(!srcW||!srcH) throw new Error("no dimensions");

    const isTall=srcH/srcW>=VISION_TALL_RATIO;
    let outW,outH;
    if(isTall){
      // Keep full horizontal detail and slice vertically (below).
      const scale=Math.min(1,VISION_MAX_W/srcW);
      outW=Math.max(1,Math.round(srcW*scale));
      outH=Math.max(1,Math.round(srcH*scale));
    } else {
      // Ordinary photo/screenshot: one image, fit inside the long-edge cap.
      const scale=Math.min(1,VISION_MAX_W/Math.max(srcW,srcH));
      outW=Math.max(1,Math.round(srcW*scale));
      outH=Math.max(1,Math.round(srcH*scale));
    }

    // A page so tall it would exceed the tile ceiling gets scaled down the rest
    // of the way rather than truncated -- a shorter read of the WHOLE page beats
    // a sharp read of its top third (report-never-empty).
    const stride=VISION_MAX_TILE_H-VISION_TILE_OVERLAP;
    if(isTall){
      const tilesNeeded=outH<=VISION_MAX_TILE_H?1:Math.ceil((outH-VISION_TILE_OVERLAP)/stride);
      if(tilesNeeded>VISION_MAX_TILES){
        const maxH=VISION_MAX_TILE_H+stride*(VISION_MAX_TILES-1);
        const extra=maxH/outH;
        outW=Math.max(1,Math.round(outW*extra));
        outH=Math.max(1,Math.round(outH*extra));
      }
    }

    const canvas=document.createElement("canvas");
    const ctx=canvas.getContext("2d");
    const out=[];
    if(!isTall||outH<=VISION_MAX_TILE_H){
      canvas.width=outW; canvas.height=outH;
      ctx.drawImage(bmp,0,0,srcW,srcH,0,0,outW,outH);
      out.push({b64:await canvasToBase64(canvas,VISION_JPEG_QUALITY),mediaType:"image/jpeg"});
    } else {
      for(let top=0,n=0;top<outH&&n<VISION_MAX_TILES;top+=stride,n++){
        const h=Math.min(VISION_MAX_TILE_H,outH-top);
        if(h<=0) break;
        canvas.width=outW; canvas.height=h;
        ctx.clearRect(0,0,outW,h);
        // Map this destination slice back to its source rectangle.
        const sy=(top/outH)*srcH, sh=(h/outH)*srcH;
        ctx.drawImage(bmp,0,sy,srcW,sh,0,0,outW,h);
        out.push({b64:await canvasToBase64(canvas,VISION_JPEG_QUALITY),mediaType:"image/jpeg"});
        if(top+h>=outH) break;
      }
    }
    // Cheap triage frame: the WHOLE image at low resolution, used to answer
    // one question before we pay for the expensive read -- "is this one
    // vehicle or a page full of them?" A dealer inventory grid costs us a
    // full multi-tile vision read today and returns a picker we deliberately
    // don't charge for, so one credit could fund unlimited paid reads
    // (cost-exploit-guards). Classifying on ~1/10th the tokens collapses that.
    // Only produced when the upload is big enough to be worth screening --
    // a single-tile phone photo of a quote skips this entirely and pays no
    // latency for it.
    let triage=null;
    if(out.length>1){
      try{
        const tScale=Math.min(1,VISION_TRIAGE_MAX_EDGE/Math.max(srcW,srcH));
        const tw=Math.max(1,Math.round(srcW*tScale)),th=Math.max(1,Math.round(srcH*tScale));
        canvas.width=tw; canvas.height=th;
        ctx.clearRect(0,0,tw,th);
        ctx.drawImage(bmp,0,0,srcW,srcH,0,0,tw,th);
        triage={b64:await canvasToBase64(canvas,0.8),mediaType:"image/jpeg"};
      }catch(e){ /* triage is an optimization, never a requirement */ }
    }

    if(bmp.close) try{ bmp.close(); }catch{}
    if(!out.length) throw new Error("no tiles");
    return {tiles:out,triage};
  }

  // Load the server-authoritative balance whenever auth changes. Signed-out ->
  // no balance (the header chip falls back to the free-check state). Signed-in ->
  // call fn_my_credits (RLS-scoped to the caller). Handles both a single-object
  // and a single-row-array return shape defensively.
  useEffect(()=>{
    let active=true;
    if(!user){ setBalance(null); return; }
    supabase.rpc("fn_my_credits").then(({data,error})=>{
      if(!active||error||!data) return;
      const row=Array.isArray(data)?data[0]:data;
      if(!row) return;
      setBalance({personal:Number(row.personal)||0,shareable:Number(row.shareable)||0});
    });
    return ()=>{ active=false; };
  },[user]);

  // Builds the fetch headers for the two analyze edge functions. `apikey` is
  // always the anon key. The Bearer is the signed-in user's access token when a
  // session exists (so the edge function runs its credit path), otherwise the
  // anon key (the free/anonymous path -- behaves exactly as before Phase 4).
  const buildAnalyzeHeaders=async()=>{
    let bearer=SB_ANON_KEY;
    if(user){
      try{
        const {data}=await supabase.auth.getSession();
        if(data.session?.access_token) bearer=data.session.access_token;
      }catch{}
    }
    return {
      "Content-Type":"application/json",
      "apikey":SB_ANON_KEY,
      "Authorization":`Bearer ${bearer}`,
    };
  };

  // Applies the outcome of a successful check: refresh the displayed balance
  // from the server's `credits.personal` (signed-in), or burn the anonymous
  // free check (signed-out). Server stays the source of truth either way.
  const applyCheckSuccess=(data)=>{
    if(data&&data.credits&&typeof data.credits.personal==="number"){
      setBalance(prev=>({personal:data.credits.personal,shareable:prev?.shareable??0}));
    }
    // user===null, not !user: during the session-resolution window a signed-in
    // user would otherwise have the local free-check flag stamped on them.
    if(user===null){ markFreeCheckUsed(); setFreeUsed(true); }
  };

  // Gate an analyze attempt before any work runs. Signed-in -> always proceed
  // (the server enforces via 402).
  //
  // ANONYMOUS -> sign in. The free check moved BEHIND the magic link on
  // 2026-08-15: the anonymous allowance was gated only by a localStorage flag,
  // which clearing site data resets, so it was a standing invitation to farm
  // free reports with throwaway addresses. A verified email costs an abuser
  // real effort and gives us a contact worth having — the same giveaway now
  // buys an acquisition instead of funding a bot.
  //
  // Server-side this is enforced by app_config.free_checks_per_day = 0, which
  // makes fn_try_free_check return false. This client gate only saves a
  // pointless round trip; it is not the control.
  const gateAttempt=()=>{
    if(user) return true;
    // Session not resolved yet — proceed and let the SERVER decide. It is the
    // authority anyway: it returns 402 out_of_credits or 429 free_limit_reached
    // and both are handled below. Bouncing on an unresolved session is how a
    // signed-in user with credits got shown the sign-in modal for pasting a URL.
    if(user===undefined) return true;
    setShowSignIn(true);
    return false;
  };

  // focusVehicle: set when the person has picked one car out of a screenshot
  // that showed several (see the "choose" status). It re-runs the SAME file,
  // pinned to that vehicle -- this is the pass that actually costs a credit.
  const handleFile=async(file,focusVehicle=null)=>{
    if(!file) return;
    if(!gateAttempt()) return;
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
    // Fresh email state per scan -- otherwise a second report in the same
    // session would inherit "sent" from the first and never auto-send again.
    setEmailInput(""); setEmailStatus("idle"); setEmailErr("");
    setVehicleChoices(null);

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

      // Images get normalized/sliced to stay inside Claude's vision limits (see
      // normalizeImageForVision). PDFs go through untouched -- they take the
      // document path server-side, which has its own limits. Any failure here
      // falls back to the original bytes: a normalization bug must never be the
      // reason someone can't get a report.
      const isPdfUpload=(fileToSend.type||"")==="application/pdf";
      let images=null,triageImage=null;
      if(!isPdfUpload){
        try{
          const norm=await normalizeImageForVision(fileToSend);
          images=norm.tiles; triageImage=norm.triage;
        }
        catch(normErr){ console.warn("Image normalization failed; sending original bytes.",normErr); }
      }

      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-quote",{
        method:"POST",
        headers:await buildAnalyzeHeaders(),
        body:JSON.stringify(Object.assign(
          images&&images.length
            ? {images,mediaType:"image/jpeg",fileBase64:images[0].b64}
            : {fileBase64:base64,mediaType:fileToSend.type||"image/jpeg"},
          // Skipped once they've chosen — the second pass is already committed
          // to one vehicle, so there's nothing left to triage.
          triageImage&&!focusVehicle?{triageImage}:{},
          focusVehicle?{focusVehicle}:{},
          // Alberta-only gate. The token is minted by /api/geo (Vercel sees the
          // real IP); the browser never states its own province.
          regionAttestation(),
        )),
      });

      // Out of credits -> not an analysis failure. Return to idle and open the
      // paywall instead of the error card.
      if(res.status===402){
        let body={}; try{ body=await res.json(); }catch{}
        if(body.error==="out_of_credits"){ setStatus("idle"); setShowPaywall(true); return; }
      }
      // Anonymous free-check breaker tripped (global daily cap). Not an analysis
      // failure and distinct from out_of_credits (a signed-in user at 0). Nudge
      // to sign in + buy a pack, since paid checks aren't limited by the breaker.
      if(res.status===429){
        let body={}; try{ body=await res.json(); }catch{}
        if(body.error==="free_limit_reached"){
          setStatus("idle");
          setSignInNotice("Sign in to claim your free check — one email, no card.");
          setShowSignIn(true);
          return;
        }
      }
      const data=await res.json();
      if(!res.ok||data.error){
        setStatus("error");
        setErrorMsg(data.error||"Something went wrong analyzing that quote.");
        return;
      }
      // Several cars in one image (a Google ad carousel, a dealer results
      // page). We never guess which one — reporting a real price against the
      // wrong vehicle is the worst thing this product can do. No credit was
      // charged for this pass; the choice triggers the real, paid read.
      if(data.needsVehicleChoice&&Array.isArray(data.vehicles)&&data.vehicles.length){
        setVehicleChoices({list:data.vehicles,pageKind:data.pageKind||"several_vehicles",totalSeen:data.totalSeen||data.vehicles.length});
        setStatus("choose");
        return;
      }
      setAnalysis(await finalizeReport(data.analysis));
      setAnalysisSource("quote");
      fetchDealerSentiment(data.analysis?.dealerName,data.analysis?.dealerCity,data.analysis?.reportId);
      applyCheckSuccess(data);
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

  // Fires the ScanTakeover's success beat exactly once, only on a genuine
  // analyzing->done transition (never on the initial mount, never on
  // error/idle -- see scanFlash declaration above for why this exists).
  useEffect(()=>{
    const prev=prevStatusRef.current;
    prevStatusRef.current=status;
    if(prev==="analyzing"&&status==="done"){
      setScanFlash(true);
      const id=setTimeout(()=>setScanFlash(false),900);
      return ()=>clearTimeout(id);
    }
  },[status]);

  // Logged-in users get their own copy emailed automatically, right alongside
  // the report that's still fully shown on the page -- this doesn't replace
  // or hide anything on-screen, it just removes the "forgot to send it, got
  // distracted, closed the tab" failure mode (Vic, 2026-08-13).
  //
  // Deliberately a SEPARATE effect from the scanFlash one above, watching
  // `user` as a real dependency rather than reading it once inside a
  // status-only effect. Matters concretely: a report opened from a shared
  // `#r=` link sets status straight to "done" on mount (never passes through
  // "analyzing"), and useSupabaseUser()'s auth check is itself async -- at
  // that exact mount instant `user` is essentially always still null, so
  // logic nested inside a `[status]`-only effect would silently see a stale
  // null and never fire even once auth resolves moments later. Confirmed
  // live, 2026-08-14: a report was fully displayed and NO send was ever
  // attempted (checked quote_report_leads directly -- zero rows). Watching
  // `user` here means the effect re-fires the moment auth catches up,
  // regardless of how the report got on screen.
  useEffect(()=>{
    if(status==="done"&&user?.email&&!emailInput&&emailStatus==="idle"){
      setEmailInput(user.email);
      sendReportEmail(user.email);
    }
  },[status,user,emailInput,emailStatus]);

  // Hybrid policy: LotCheck reads DEALER-OWN sites only. These third-party
  // listing marketplaces/aggregators are blocked (their ToS bar automated
  // access — Century 21 v. Zoocasa); the edge function enforces the same list
  // server-side. Buyers use the dealer's own link or upload a screenshot.
  const AGGREGATOR_HOSTS=["autotrader.ca","autotrader.com","cargurus.ca","cargurus.com","kijiji.ca","kijijiautos.ca","ebay.ca","ebay.com","facebook.com","fb.com","carfax.ca","carfax.com","clutch.ca","carpages.ca","cars.com","truecar.com","carvana.com"];
  function isAggregatorUrl(raw){
    let host; try{ host=new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./,""); }catch{ return false; }
    return AGGREGATOR_HOSTS.some(d=>host===d||host.endsWith("."+d));
  }

  const handleUrlAnalyze=async()=>{
    const url=urlInput.trim();
    if(!isValidUrl(url)){
      setStatus("error");
      setErrorMsg("That doesn't look like a valid URL — paste the full link, starting with http:// or https://.");
      return;
    }
    // Blocked marketplaces: don't even call the function — steer to a dealer
    // link or upload. (Server-side enforcement lives in the edge function too.)
    if(isAggregatorUrl(url)){
      setLastAttemptType("url");
      setStatus("error");
      setErrorMsg("That's a listing marketplace (AutoTrader, CarGurus, Kijiji, eBay, or Facebook). We can't check those by link — paste the dealer's own website link for the same vehicle, or upload a screenshot of the listing instead.");
      return;
    }
    if(!gateAttempt()) return;
    setFileName(new URL(url).hostname);
    setLastAttemptType("url");
    setStatus("analyzing");
    setErrorMsg("");
    // Fresh email state per scan -- otherwise a second report in the same
    // session would inherit "sent" from the first and never auto-send again.
    setEmailInput(""); setEmailStatus("idle"); setEmailErr("");
    setVehicleChoices(null);

    try{
      const res=await fetch("https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-listing-url",{
        method:"POST",
        headers:await buildAnalyzeHeaders(),
        body:JSON.stringify({url,...regionAttestation()}),
      });

      // Out of credits -> not an analysis failure. Return to idle and open the
      // paywall instead of the error card.
      if(res.status===402){
        let body={}; try{ body=await res.json(); }catch{}
        if(body.error==="out_of_credits"){ setStatus("idle"); setShowPaywall(true); return; }
      }
      // Anonymous free-check breaker tripped (global daily cap). Not an analysis
      // failure and distinct from out_of_credits (a signed-in user at 0). Nudge
      // to sign in + buy a pack, since paid checks aren't limited by the breaker.
      if(res.status===429){
        let body={}; try{ body=await res.json(); }catch{}
        if(body.error==="free_limit_reached"){
          setStatus("idle");
          setSignInNotice("Sign in to claim your free check — one email, no card.");
          setShowSignIn(true);
          return;
        }
      }
      // The listing couldn't be read (JS-rendered / bot-protected dealer site,
      // no price found). NOT charged. Steer to the photo/PDF upload, which reads
      // the real quote reliably — don't dump an empty "report" on the buyer.
      if(res.status===422){
        let body={}; try{ body=await res.json(); }catch{}
        if(body.error==="unreadable_listing"){
          // Existing error card already shows an "Upload a screenshot instead →"
          // CTA for url attempts; the message tells them they weren't charged.
          setStatus("error");
          setErrorMsg(body.message||"Sorry — we couldn't read the price on this dealer listing, so there's no report to give you. Your credit has already been refunded. Upload a screenshot or PDF of the quote instead, or try the same vehicle at another dealer.");
          return;
        }
        if(body.error==="aggregator_not_supported"){
          // Server-side backstop for a marketplace link (the client normally
          // blocks these pre-flight via isAggregatorUrl).
          setStatus("error");
          setErrorMsg(body.message||"That listing marketplace can't be checked by link — paste the dealer's own website link, or upload a screenshot instead.");
          return;
        }
      }
      const data=await res.json();
      if(!res.ok||data.error){
        setStatus("error");
        setErrorMsg(data.error||"Something went wrong analyzing that listing.");
        return;
      }
      setAnalysis(await finalizeReport({ ...data.analysis, sourceUrl: url, capturedAt: new Date().toISOString() }));
      setAnalysisSource("listing");
      fetchDealerSentiment(data.analysis?.dealerName,data.analysis?.dealerCity,data.analysis?.reportId);
      applyCheckSuccess(data);
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
    setVehicleChoices(null);
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
    /* Sign-in modal hero: link chips advance down the runway toward the
       viewer (translateY moves along the tilted floor, translateZ lifts it
       off the floor toward the camera) then recycle -- always forward. Each
       chip runs the same loop on a stagger so the stream never stalls. */
    @keyframes lc-si-advance {
      0%   { opacity:0; transform:translate3d(var(--x,0px),-62px,0px); }
      14%  { opacity:1; }
      80%  { opacity:1; }
      100% { opacity:0; transform:translate3d(var(--x,0px),60px,54px); }
    }
    /* Sign-in success: the envelope flies forward once (grows + rises toward
       the camera) -- "your link is on its way." forwards-fills to its arrived
       frame. */
    @keyframes lc-si-fly {
      0%   { opacity:0; transform:translate3d(0px,-26px,0px) scale(.55); }
      35%  { opacity:1; }
      100% { opacity:1; transform:translate3d(0px,24px,58px) scale(1); }
    }
    /* Soft pulse on the destination line the chips advance toward. */
    @keyframes lc-si-glow {
      0%,100% { opacity:.32; }
      50%     { opacity:.72; }
    }
    /* Reduced motion: park every sign-in animation on its resting frame
       (each element carries an inline transform that reads as a static
       isometric composition when the animation is off). */
    @media (prefers-reduced-motion: reduce) {
      .lc-si-chip, .lc-si-env, .lc-si-line { animation: none !important; }
    }
    /* Narrow phones: the top-bar controls (theme switch + credits chip +
       sign-in) can't stay pinned right on their own wrapped line without
       overflowing, so let them span the full row and wrap internally. */
    @media (max-width:560px) {
      .qc-topbar-controls { width:100%; margin-left:0 !important; justify-content:flex-start; }
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

  // Out of area: the check is replaced by the waitlist card. Placed AFTER every
  // hook above so hook order never changes between renders.
  if(region.blocked){
    return(
      <>
        <style>{GLOBAL_CSS}</style>
        <style>{QC_CSS}</style>
        <div style={{minHeight:"100dvh",background:"#020617",fontFamily:"'Nunito',system-ui,-apple-system,sans-serif"}}>
          <RegionBlockCard state={region.state} onDeclare={region.declare}/>
        </div>
      </>
    );
  }

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      <style>{QC_CSS}</style>
      <div style={{minHeight:"100dvh",background:qcTheme==="dark"?"radial-gradient(125% 120% at 78% 4%,#141238 0%,#080a1c 46%,#05060f 100%) no-repeat":C.paper,backgroundColor:qcTheme==="dark"?"#05060f":undefined,fontFamily:"'Nunito',system-ui,-apple-system,sans-serif"}}>
        {/* Full-width site nav -- the same tabs as the rest of LotCheck, so the
            Quote Check page reads as part of the site, not a detached tool. The
            theme toggle, credits chip and Sign in live on its right side. */}
        <nav aria-label="Main" style={{position:"sticky",top:0,zIndex:50,background:qcTheme==="dark"?"rgba(10,10,22,.72)":C.paper,backdropFilter:qcTheme==="dark"?"blur(12px)":"none",WebkitBackdropFilter:qcTheme==="dark"?"blur(12px)":"none",borderBottom:`1px solid ${C.line}`}}>
          <div style={{maxWidth:1180,margin:"0 auto",display:"flex",alignItems:"center",gap:14,padding:"11px 16px",flexWrap:"wrap"}}>
            <a href="/" aria-label="LotCheck home" style={{display:"flex",alignItems:"center",gap:9,textDecoration:"none",flexShrink:0}}>
              <LogoMark size={45}/>
              <span style={{fontWeight:1000,fontSize:19,color:C.ink}}>LotCheck</span>
            </a>
            <div style={{display:"flex",alignItems:"center",gap:2,flexWrap:"wrap",flex:"1 1 auto"}}>
              {[
                ["/live-price-index","MSRP Price Index"],
                ["/alberta","Alberta Dealers Map"],
                ["/#how","How it works"],
                ["/#pipeline","10-point lane"],
                ["/#report","Sample report"],
                ["/#what","What LotCheck does"],
                ["/msrp-alerts","MSRP Notifier"],
                ["/verify","Verify report"],
              ].map(([href,label])=>(
                <a key={href} href={href}
                  style={{color:C.inkSoft,textDecoration:"none",fontWeight:800,fontSize:13.5,padding:"7px 10px",borderRadius:9,whiteSpace:"nowrap"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=C.paper2;e.currentTarget.style.color=C.ink;}}
                  onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color=C.inkSoft;}}>
                  {label}
                </a>
              ))}
            </div>
            <div className="qc-topbar-controls" style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,flexWrap:"wrap"}}>
            {lastAttemptType&&(
              <button onClick={handleRefresh} disabled={status==="analyzing"} aria-label="Re-run this report"
                title="Re-run this report from scratch"
                style={{display:"flex",alignItems:"center",justifyContent:"center",width:34,height:34,borderRadius:10,background:C.paper2,border:`1px solid ${C.line}`,color:C.inkSoft,cursor:status==="analyzing"?"default":"pointer",opacity:status==="analyzing"?0.5:1,flexShrink:0,fontSize:15}}>
                🔄
              </button>
            )}
            <div style={{display:"flex",gap:3,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:10,padding:3,flexShrink:0}}>
              {[
                ["dark","Dark",(
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>
                  </svg>
                )],
                ["light","Light",(
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
                  </svg>
                )],
                ["outdoor","Outdoor",(
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="5" fill="currentColor"/>
                    <path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M20 4l-2 2M6 18l-2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                )],
              ].map(([k,label,icon])=>(
                <button key={k} onClick={()=>setQcThemeAndPersist(k)} aria-label={`Switch to ${k} mode`}
                  style={{display:"inline-flex",alignItems:"center",gap:5,background:qcTheme===k?C.tealBg:"transparent",color:qcTheme===k?C.tealInk:C.inkSoft,border:"none",borderRadius:7,padding:"6px 10px",fontSize:11.5,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {icon}
                  {label}
                </button>
              ))}
            </div>

            {/* Credits chip (Phase 4). Signed-in -> server balance ("{n} quotes
                left", amber when low). Signed-out -> the one free check, or a
                subtle nudge to sign in once it's spent. Display-only. */}
            {(()=>{
              if(user){
                if(balance===null) return null; // balance not loaded yet -> show nothing rather than a wrong number
                const low=balance.personal<=2;
                return(
                  <span title={`${balance.personal} personal quote${balance.personal===1?"":"s"} left${balance.shareable?` · ${balance.shareable} to share`:""}`}
                    style={{fontSize:12,fontWeight:800,whiteSpace:"nowrap",flexShrink:0,borderRadius:999,padding:"6px 12px",
                      color:low?C.butterInk:C.inkSoft,background:low?C.butterBg:C.paper2,border:`1px solid ${low?C.butter+"55":C.line}`}}>
                    {balance.personal} quote{balance.personal===1?"":"s"} left
                  </span>
                );
              }
              if(!freeUsed) return(
                <span style={{fontSize:12,fontWeight:800,whiteSpace:"nowrap",flexShrink:0,borderRadius:999,padding:"6px 12px",color:C.tealInk,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                  1 free check
                </span>
              );
              return(
                <button onClick={()=>setShowSignIn(true)}
                  style={{fontSize:12,fontWeight:700,whiteSpace:"nowrap",flexShrink:0,borderRadius:999,padding:"6px 12px",color:C.inkFaint,background:"transparent",border:`1px solid ${C.line}`,cursor:"pointer"}}>
                  Sign in for more
                </button>
              );
            })()}

            {/* Auth entry point. Logged out -> a "Sign in" button that opens the
                magic-link modal. Logged in -> an email chip + Sign out. Phase 2:
                no gating anywhere, this is purely account presence. */}
            {user?(
              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                <span title={user.email} style={{maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12,fontWeight:800,color:C.ink,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:999,padding:"6px 12px"}}>
                  {user.email}
                </span>
                <button onClick={()=>supabase.auth.signOut()} aria-label="Sign out"
                  style={{background:C.paper2,border:`1px solid ${C.line}`,borderRadius:10,padding:"6px 12px",color:C.inkSoft,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                  Sign out
                </button>
              </div>
            ):(
              <button onClick={()=>setShowSignIn(true)}
                style={{background:C.teal,border:"none",borderRadius:10,padding:"8px 16px",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                Sign in
              </button>
            )}
            </div>
          </div>
        </nav>
        <div style={{maxWidth:640,margin:"0 auto",padding:"24px 16px"}}>
          <div style={{marginBottom:24}}>
            <div style={{fontWeight:1000,fontSize:22,color:C.ink}}>LotCheck Quote Check</div>
            <div style={{fontSize:13,color:C.inkSoft,marginTop:2}}>Upload your dealer quote. We'll tell you what's real and what's padding.</div>
          </div>

          {/* Gift-link claim banner: someone arrived via …/quote-check?gift=CODE */}
          {(giftPending&&!user)&&(
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",background:C.tealBg,border:`1px solid ${C.teal}66`,borderRadius:16,padding:"14px 18px",marginBottom:18}}>
              <div style={{flex:"1 1 240px",minWidth:0}}>
                <div style={{fontWeight:900,color:C.tealInk,fontSize:15}}>A free Quote Check is waiting for you</div>
                <div style={{fontSize:12.5,color:C.inkSoft,marginTop:3,lineHeight:1.5}}>Sign in to claim it — one tap, no card needed. It lands on your account instantly.</div>
              </div>
              <button onClick={()=>setShowSignIn(true)}
                style={{background:C.teal,border:"none",borderRadius:10,padding:"11px 20px",color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                Sign in to claim
              </button>
            </div>
          )}
          {giftClaim&&(
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",
                background:giftClaim.status==="error"?C.coralBg:C.tealBg,
                border:`1px solid ${(giftClaim.status==="error"?C.coral:C.teal)}66`,
                borderRadius:16,padding:"14px 18px",marginBottom:18}}>
              <div style={{flex:"1 1 240px",minWidth:0,fontWeight:800,fontSize:14,
                color:giftClaim.status==="error"?C.coralInk:C.tealInk}}>
                {giftClaim.status==="success"&&"You're all set — "}{giftClaim.msg}
              </div>
              <button onClick={()=>setGiftClaim(null)} aria-label="Dismiss"
                style={{background:"transparent",border:`1px solid ${C.line}`,borderRadius:8,padding:"7px 14px",color:C.inkSoft,fontSize:13,fontWeight:700,cursor:"pointer",flexShrink:0}}>Got it</button>
            </div>
          )}

          {status==="idle"&&(
            <>
            {/* PRIMARY: paste a DEALER-OWN listing link (hybrid). Third-party
                aggregators/marketplaces (AutoTrader, CarGurus, Kijiji, eBay,
                Facebook) are blocked client-side (isAggregatorUrl) AND in the
                edge function, pending legal sign-off — see Century 21 v. Zoocasa. */}
            <div onClick={e=>e.stopPropagation()} style={{background:C.card,border:`2px solid ${C.teal}`,borderRadius:22,padding:"22px 22px",boxShadow:"0 18px 40px -18px rgba(51,48,90,.18)"}}>
              <div style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:11,fontWeight:800,letterSpacing:.4,color:C.tealInk,background:C.tealBg,borderRadius:999,padding:"4px 11px",marginBottom:10}}>🔗 Fastest way</div>
              <div style={{color:C.ink,fontWeight:1000,fontSize:18,marginBottom:6}}>Paste a dealer's website link</div>
              <div style={{fontSize:13,color:C.inkSoft,marginBottom:14,lineHeight:1.5}}>We open the live dealer page and read the price, fees, financing and specs — even on sites that load the price with scripts. Use the <strong>dealer's own website</strong>.</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <input
                  type="url"
                  placeholder="https://dealer-site.com/inventory/..."
                  value={urlInput}
                  onChange={e=>setUrlInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter") handleUrlAnalyze();}}
                  style={{flex:"1 1 240px",background:C.paper,border:`2px solid ${C.line}`,borderRadius:10,padding:"13px 16px",color:C.ink,fontSize:15,outline:"none",boxSizing:"border-box"}}
                />
                <button onClick={handleUrlAnalyze}
                  style={{background:C.teal,border:"none",borderRadius:10,padding:"13px 26px",color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer",whiteSpace:"nowrap"}}>
                  Analyze →
                </button>
              </div>
              <div style={{fontSize:11.5,color:C.inkFaint,marginTop:10,lineHeight:1.5,display:"flex",gap:6,alignItems:"flex-start"}}>
                <span aria-hidden="true">🚫</span>
                <span><strong>Don't use listing marketplaces</strong> — AutoTrader, CarGurus, Kijiji, eBay, or Facebook Marketplace links aren't supported here. Paste the dealer's own site, or upload a screenshot instead.</span>
              </div>
            </div>

            <div style={{display:"flex",alignItems:"center",gap:12,margin:"18px 0"}}>
              <div style={{flex:1,height:1,background:C.line}}/>
              <div style={{fontSize:11,color:C.inkFaint,fontWeight:800}}>OR UPLOAD A QUOTE</div>
              <div style={{flex:1,height:1,background:C.line}}/>
            </div>

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
              <OrbitalHaloVisual C={C} progress={0} speed="idle"/>

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
              <div style={{color:C.inkFaint,fontSize:13}}>PDF, JPG, PNG, WEBP or HEIC · up to {MAX_FILE_SIZE_MB}MB · takes a couple of seconds to analyze</div>
              {/* Say what a good upload looks like BEFORE the attempt, not in an
                  error afterwards. Every line here is a real failure we've seen
                  and can prevent (own-the-process-no-user-limits). */}
              <div style={{marginTop:14,textAlign:"left",display:"inline-block",background:C.tealBg,border:`1px solid ${C.teal}44`,borderRadius:12,padding:"12px 16px",maxWidth:420}}>
                <div style={{fontSize:11.5,fontWeight:900,color:C.tealInk,letterSpacing:".5px",marginBottom:8}}>FOR A CLEAN SCAN</div>
                {[
                  "Include the price and any fee lines — that's what gets checked",
                  "A full-page screenshot works better than a cropped one",
                  "One vehicle per upload; if a page shows several, we'll ask which",
                  "Straight-on and in focus — glare and angle hide the fine print",
                ].map((tip,i)=>(
                  <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i===3?0:6}}>
                    <span aria-hidden="true" style={{flex:"0 0 auto",width:5,height:5,borderRadius:"50%",background:C.teal,marginTop:6}}/>
                    <span style={{fontSize:12.5,color:C.inkSoft,lineHeight:1.5}}>{tip}</span>
                  </div>
                ))}
              </div>
              {/* Scope, answered before it's asked: LotCheck covers every
                  condition — the #1 user question ("is this for new or used?")
                  should never need asking. Chips, not fine print. */}
              <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:6,flexWrap:"wrap",marginTop:12}}>
                <span style={{fontSize:11.5,color:C.inkFaint,fontWeight:700}}>Works with</span>
                {["New","Demo","Certified","Used"].map(c=>(
                  <span key={c} style={{fontSize:11.5,fontWeight:800,color:C.tealInk,background:C.tealBg,border:`1px solid ${C.teal}44`,borderRadius:999,padding:"3px 10px"}}>{c}</span>
                ))}
                <span style={{fontSize:11.5,color:C.inkFaint,fontWeight:700}}>— listings & quotes</span>
              </div>
              <input ref={fileInputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" style={{display:"none"}}
                onChange={e=>handleFile(e.target.files[0])}/>
            </div>

            <div style={{display:"flex",gap:20,marginTop:26,flexWrap:"wrap"}}>
              {[
                {n:"1",label:"Upload your quote",desc:"Drop a file, click to browse, or paste a screenshot (Ctrl+V / Cmd+V)"},
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
            <ScanTakeover C={C} cardStyle={cardStyle} phase="running"
              attemptType={lastAttemptType} fileName={fileName}
              stageText={scanMsg||"Checking MSRP, add-ons, and warranty terms"}/>
          )}
          {scanFlash&&(
            <ScanTakeover C={C} cardStyle={cardStyle} phase="success"
              attemptType={lastAttemptType} fileName={fileName}/>
          )}

          {/* Several cars in one screenshot -- ask which, never guess. Putting
              a real price against the wrong vehicle is the worst failure this
              product has, so this is a deliberate stop rather than a silent
              pick. Nothing has been charged at this point. */}
          {status==="choose"&&vehicleChoices&&Array.isArray(vehicleChoices.list)&&(()=>{
            const isGrid=vehicleChoices.pageKind==="inventory_results";
            return (
            <div style={{...cardStyle,padding:"26px 24px"}}>
              <div style={{fontWeight:1000,fontSize:17,color:C.ink,marginBottom:6}}>
                {isGrid
                  ? "That's a search results page, not one vehicle"
                  : `That screenshot shows ${vehicleChoices.list.length} vehicles`}
              </div>
              <div style={{fontSize:13.5,color:C.inkSoft,marginBottom:4,lineHeight:1.6}}>
                {isGrid
                  ? <>It lists {vehicleChoices.totalSeen>vehicleChoices.list.length?`about ${vehicleChoices.totalSeen} cars`:"several cars"}, and the cards don't carry a VIN — so a report built from this page couldn't check recalls or confirm the exact car. <b>Open the vehicle you want and upload that page instead</b>, and you'll get the full report.</>
                  : "Pick the one you want checked and LotCheck will run the full report on it."}
              </div>
              <div style={{fontSize:12,color:C.inkFaint,marginBottom:18}}>
                Nothing has been used from your balance — you're only charged for a report you actually get.
              </div>
              {isGrid&&(
                <div style={{fontSize:11.5,fontWeight:900,color:C.inkFaint,letterSpacing:".4px",marginBottom:8}}>
                  WHAT WE READ ON THIS PAGE
                </div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {vehicleChoices.list.map((v,i)=>{
                  const title=[v.year,v.make,v.model,v.trim].filter(Boolean).join(" ")||v.label||`Vehicle ${i+1}`;
                  const sub=[
                    v.price?`$${Number(v.price).toLocaleString("en-CA")}`:null,
                    v.stockNumber?`Stock ${v.stockNumber}`:null,
                    v.duplicateCount>1?`${v.duplicateCount} listed at this price`:null,
                    v.dealerName,
                  ].filter(Boolean).join(" · ");
                  return (
                    <button key={i}
                      onClick={()=>{ if(lastFile) handleFile(lastFile,v.label||title); }}
                      style={{textAlign:"left",background:C.card,border:`2px solid ${C.line}`,borderRadius:12,padding:"13px 15px",cursor:"pointer",color:C.ink,transition:"border-color .15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=C.teal;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.line;}}>
                      <div style={{fontWeight:900,fontSize:14.5}}>{title}</div>
                      {sub&&<div style={{fontSize:12.5,color:C.inkFaint,marginTop:3}}>{sub}</div>}
                    </button>
                  );
                })}
              </div>
              {isGrid&&(
                <div style={{fontSize:11.5,color:C.inkFaint,marginTop:12,lineHeight:1.5}}>
                  You can still pick one above — the report will cover that configuration, but without a VIN it can't include the VIN check or recall lookup for that exact car.
                </div>
              )}
              <button onClick={reset}
                style={{marginTop:16,background:"transparent",border:`1px solid ${C.line}`,borderRadius:999,padding:"9px 18px",color:C.inkSoft,fontWeight:800,fontSize:13,cursor:"pointer"}}>
                Upload something else
              </button>
            </div>
            );
          })()}

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

          {status==="done"&&analysis&&<ReportBoundary C={C}><RenderSlot fn={()=>{
            // ── Shared report computations (used by the summary hero tiles and
            //    the grouped Rebates & conditions card below). Every value is
            //    derived from real analysis fields -- nothing fabricated. ──
            // EVAP: mirror the card's own gate/logic exactly so the hero tile
            // and the Rebates card always agree (lifted out of the card's old
            // inline IIFE so both can read the same result).
            const {show:evapShow,rebate,effectiveFuelType,fuelMismatch,listMatch:evapListMatch}=resolveEvap(analysis);
            // Watch-outs tile: a COUNT of the report's own flagged items
            // (recalls, odometer flag, invalid VIN, flagged add-ons) -- a
            // factual tally of what's flagged below, never an invented rating.
            let watchOuts=0;
            if(analysis.recalls?.checked&&analysis.recalls.count>0) watchOuts+=analysis.recalls.count;
            if(analysis.odometerCheck?.flag) watchOuts+=1;
            if(analysis.vinCheck?.present&&!analysis.vinCheck.valid) watchOuts+=1;
            if(analysis.financeContingent?.contingent) watchOuts+=1;
            if(analysis.addOns?.length) watchOuts+=analysis.addOns.filter(a=>(a.verdict||(a.flagged?"flagged":"standard"))==="flagged").length;
            // Summary tiles -- factual figures only (no verdict chip). Built
            // adaptively: only tiles backed by real data render.
            const tiles=[];
            const qPrice=Number(analysis.quotedPrice)||0;
            const mPrice=Number(analysis.msrp)||0;
            if(qPrice>0) tiles.push({label:"Price",value:`$${qPrice.toLocaleString()}`,sub:"quoted, before tax"});
            else if(mPrice>0) tiles.push({label:"Price (MSRP)",value:`$${mPrice.toLocaleString()}`,sub:"quote didn't show a price"});
            // Payment tile: prefer the dealer's DISCLOSED payment; otherwise a
            // bi-weekly ESTIMATE, shown only on a verified listing price with a
            // real rate -- never off an MSRP fallback, consistent with the
            // financing card's price-verification gate.
            (()=>{
              const fr=analysis.financing?.paymentFrequency;
              const fLbl={weekly:"Weekly",biweekly:"Bi-weekly",monthly:"Monthly"};
              const fSuf={weekly:"/wk",biweekly:"/2wk",monthly:"/mo"};
              if(analysis.financing?.paymentAmount&&fr){
                tiles.push({label:fLbl[fr]||"Payment",value:`$${Math.round(analysis.financing.paymentAmount).toLocaleString()}`,valueSuffix:fSuf[fr]||"",sub:`${analysis.financing.rate?`${analysis.financing.rate}% · `:""}disclosed on quote`});
                return;
              }
              const rate=analysis.financeRates?.dealer?.apr??analysis.financing?.rate??analysis.financeRates?.manufacturer?.apr??null;
              if(qPrice>0&&rate!=null){
                const termRaw=Number(analysis.financing?.termMonths)||0;
                const term=FIN_TERMS.includes(termRaw)?termRaw:60;
                const biw=amortPayment(qPrice,Number(rate),26,term);
                if(biw>0) tiles.push({label:"Bi-weekly est.",value:`$${Math.round(biw).toLocaleString()}`,valueSuffix:"/2wk",sub:`${rate}% · ${term} mo · $0 down`});
              }
            })();
            if(rebate?.eligible) tiles.push({label:"EVAP rebate",value:`$${rebate.total.toLocaleString()}`,sub:`$${rebate.federal.toLocaleString()} federal${rebate.provincial>0?` + $${rebate.provincial.toLocaleString()}`:""}`});
            if(analysis.daysOnLot&&Number(analysis.daysOnLot.days)>0) tiles.push({label:"Days on lot",value:Number(analysis.daysOnLot.days).toLocaleString(),sub:analysis.daysOnLot.since?`first seen ${analysis.daysOnLot.since}`:"dealer inventory data",flag:Number(analysis.daysOnLot.days)>=90});
            if(analysis.tradeInWidget&&analysis.tradeInWidget.detected) tiles.push({label:"Trade-in tool",value:analysis.tradeInWidget.vendor||"On this listing",sub:"wholesale-anchored — keep it a separate written line",flag:false});
            if(analysis.financeContingent&&analysis.financeContingent.contingent) tiles.push({label:"Price conditions",value:"Financing-tied",sub:"cash or your own bank may not get this price — ask in writing",flag:true});
            if(analysis.dealerLicence&&analysis.dealerLicence.status) tiles.push({label:"Dealer licence · AMVIC",value:analysis.dealerLicence.state==="valid"?"Valid":analysis.dealerLicence.status,sub:analysis.dealerLicence.licenceNumber?`licence ${analysis.dealerLicence.licenceNumber}`:"AMVIC public registry",flag:analysis.dealerLicence.state!=="valid"});
            tiles.push({label:"Watch-outs",value:String(watchOuts),sub:watchOuts===0?"nothing flagged":"flagged items below",flag:watchOuts>0});
            const vehName=analysis.vehicle||[analysis.year,analysis.make,analysis.model].filter(Boolean).join(" ")||"Vehicle";
            const metaBits=[analysis.vehicleCondition,analysis.odometerKm?`${analysis.odometerKm.toLocaleString()} km`:null,analysis.dealerSentiment?.dealerName].filter(Boolean);
            // Flip-book "Report view" replaces the scroll body when selected.
            // Authenticity banner for OPENED shared links — sits above the full
            // report in every view, so "verify" = see the whole report + verdict.
            const sharedBanner = sharedReport ? (
              <div style={{...cardStyle, background: sharedAuth==="invalid"?C.coralBg:C.tealBg, border:`1px solid ${(sharedAuth==="invalid"?C.coral:C.teal)}55`, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap"}}>
                {(analysis.sig||analysis.reportId)&&<Seal seed={sealSeed(analysis.sig||analysis.reportId)} size={44} gid="shseal" ink={sharedAuth==="invalid"?C.coralInk:C.tealInk}/>}
                <div style={{flex:"1 1 240px",minWidth:0}}>
                  <div style={{fontSize:14.5,fontWeight:900,color:sharedAuth==="invalid"?C.coralInk:C.tealInk}}>
                    {sharedAuth==="invalid"?"Seal broken — this copy was altered":sharedAuth==="valid"?"Authentic LotCheck report":"Shared LotCheck report"}
                  </div>
                  <div style={{fontSize:12,color:C.inkSoft,lineHeight:1.5,marginTop:2}}>
                    {sharedAuth==="invalid"
                      ?"This copy does not match what LotCheck issued — at least one figure was changed after signing. Ask the sender for the original link."
                      :sharedAuth==="valid"
                        ?`Signed by LotCheck${analysis.issuedAt?` on ${new Date(analysis.issuedAt).toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"})}`:""} — not one figure has been changed since. The full report is below.`
                        :`Report ${analysis.reportId||""} — the ID is a fingerprint of its contents; the full report is below.`}
                  </div>
                </div>
              </div>
            ) : null;
            if(reportView==="heatmap"||reportView==="sidebar") return <div>{sharedBanner}<ReportViews analysis={analysis} view={reportView} onView={setReportView} onExit={()=>setReportView("scroll")} onShare={copyShareLink} copied={linkCopied} shared={sharedReport} ink={C.ink} emailInput={emailInput} setEmailInput={setEmailInput} emailStatus={emailStatus} emailErr={emailErr} setEmailErr={setEmailErr} onSend={sendReportEmail}/></div>;
            if(reportView==="flip") return <div>{sharedBanner}<ReportFlipbook analysis={analysis} onExit={()=>setReportView("scroll")} onShare={copyShareLink} copied={linkCopied} shared={sharedReport} ink={C.ink}/></div>;
            // 3-way view toggle (scroll / report / orrery), active state highlighted.
            const vBtn=(v,label)=>(<button key={v} onClick={()=>setReportView(v)} style={{background:reportView===v?C.teal:"transparent",color:reportView===v?"#fff":C.inkSoft,border:"none",borderRadius:8,padding:"7px 13px",fontSize:12.5,fontWeight:800,cursor:"pointer"}}>{label}</button>);
            const viewToggle=(
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:14}}>
                <div style={{display:"flex",gap:3,background:C.paper2,border:`1px solid ${C.line}`,borderRadius:10,padding:3}}>
                  {vBtn("scroll","Scroll")}{vBtn("heatmap","Heatmap")}{vBtn("sidebar","Sidebar")}{vBtn("flip","Book")}{vBtn("orrery","3D")}
                </div>
                {/* The delivery confirmation belongs on EVERY view, not just the
                    two that happen to route through ReportViews. It lived only
                    in that component's header, so Scroll, Book and 3D showed
                    nothing at all once a report had been emailed — including on
                    the auto-send path, which is the one most buyers hit. Same
                    beat, same copy, so the surfaces agree. */}
                {emailStatus==="sent"&&(
                  <span style={{display:"inline-flex",alignItems:"center",gap:6,color:C.tealInk,fontWeight:700,fontSize:12.5}}>
                    <DroneSentBeat compact body={C.inkFaint} accent={C.teal}/>
                    <span className="lcSentFade" style={{animation:"lcSentFade .5s ease .9s both"}}>Emailed</span>
                  </span>
                )}
                <button onClick={copyShareLink} style={{marginLeft:"auto",background:C.paper2,border:`1px solid ${C.line}`,borderRadius:10,padding:"8px 14px",color:C.inkSoft,fontSize:12.5,fontWeight:800,cursor:"pointer"}}>{linkCopied?"Link copied":"Copy share link"}</button>
              </div>
            );
            // 3D Orrery view — the deal as a navigable hologram (real WebGL).
            if(reportView==="orrery") return (
              <div>
                {viewToggle}
                {sharedBanner}
                <DealOrrery analysis={analysis} height={540}/>
                <div style={{fontSize:12,color:C.inkFaint,textAlign:"center",marginTop:8,lineHeight:1.5}}>Drag to orbit · scroll to zoom. Your quote is the core; fees orbit it (bigger = pricier), <b style={{color:C.coralInk}}>flagged fees glow red</b>, and the teal ring is MSRP.</div>
              </div>
            );
            return (
            <div>
              {viewToggle}
              {sharedBanner}
              {/* Result-first sign-in invitation. Non-blocking: the full report
                  renders below regardless. Only shown to logged-out visitors --
                  once signed in it disappears. No paywall, no enforcement
                  (Phase 2 is auth primitives only). */}
              {user===null&&(
                <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`,boxShadow:"none",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                  <div style={{fontSize:26,flexShrink:0}}>🔖</div>
                  <div style={{flex:"1 1 200px",minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:800,color:C.ink,marginBottom:2}}>Sign in to save this report and run more checks</div>
                    <div style={{fontSize:12,color:C.inkSoft,lineHeight:1.5}}>Keep a copy in your account and pick up where you left off — takes a few seconds, no password.</div>
                  </div>
                  <button onClick={()=>setShowSignIn(true)}
                    style={{background:C.teal,border:"none",borderRadius:10,padding:"10px 18px",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                    Sign in →
                  </button>
                </div>
              )}

              {/* ── Summary hero: the vehicle, then a row of factual tiles
                     (price, payment, rebate, watch-out count). Figures only --
                     no verdict chip (house rule). Tiles are built adaptively
                     above; 2-4 render depending on what real data exists. ── */}
              <div style={cardStyle}>
                <div style={{fontSize:20,fontWeight:1000,color:C.ink,letterSpacing:-.3,lineHeight:1.15}}>{vehName}</div>
                {metaBits.length>0&&<div style={{fontSize:12.5,color:C.inkSoft,marginTop:4}}>{metaBits.join(" · ")}</div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginTop:16}}>
                  {tiles.map((t,i)=>(
                    <div key={i} style={{background:C.paper2,border:`1px solid ${C.line}`,borderRadius:14,padding:"11px 13px"}}>
                      <div style={{fontSize:10.5,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,fontWeight:800}}>{t.label}</div>
                      <div style={{fontSize:19,fontWeight:1000,marginTop:3,letterSpacing:-.3,color:t.flag?C.butterInk:C.ink}}>{t.value}{t.valueSuffix&&<span style={{fontSize:12,color:C.inkFaint,fontWeight:700}}>{t.valueSuffix}</span>}</div>
                      {t.sub&&<div style={{fontSize:11,color:C.inkSoft,marginTop:2}}>{t.sub}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Feed-fallback notice: the dealer page itself couldn't be read,
                  so this report was built from the dealer's SM360 inventory
                  feed. Surface that honestly so the buyer knows fees/financing
                  from the page aren't included here. */}
              {analysis.source==="sm360_feed_fallback"&&(
                <div style={{...cardStyle,background:C.butterBg,border:`1px solid ${C.butter}55`,boxShadow:"none"}}>
                  <div style={{fontSize:12,fontWeight:800,color:C.butterInk,marginBottom:4}}>Built from the dealer's inventory feed</div>
                  <div style={{fontSize:12,color:C.ink,lineHeight:1.5}}>{analysis.sourceNote||"The dealer's listing page couldn't be loaded, so this report was built from the dealer's own inventory feed. Itemized fees and the page's financing terms aren't included -- confirm them with the dealer."}</div>
                </div>
              )}

              {/* TL;DR -- the "Bottom line", promoted from the very bottom of the
                  report to the top as its summary. Same analysis.summary text as
                  before, unchanged. */}
              {analysis.summary&&(
                <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`,borderLeft:`3px solid ${C.teal}`}}>
                  <div style={{fontSize:12,fontWeight:800,color:C.tealInk,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>Bottom line</div>
                  <div style={{color:C.ink,fontSize:14,lineHeight:1.6}}>{analysis.summary}</div>
                </div>
              )}

              {/* Financing breakdown -- payment matrix (down payment x term x
                  frequency) computed purely from the quoted price, plus the
                  real rate anchors (quote / manufacturer finance & lease
                  catalog / live Bank of Canada) and the payment-reconciliation
                  (financingCheck) note. This is the single financing UI --
                  replaces the earlier "Financing examples" card. Renders itself
                  null when there's no quoted price. Now condensed: a summary
                  with the full matrix behind an expander. */}
              <FinancingBreakdown analysis={analysis} C={C} cardStyle={cardStyle}/>

              {/* ── Detail cards in a 2-column grid on desktop, collapsing to a
                     single column on mobile. auto-fit + minmax does the collapse
                     with no media query; rowGap:0 defers vertical rhythm to each
                     card's own marginBottom (from cardStyle). ── */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",columnGap:16,rowGap:0,alignItems:"start"}}>

              {/* MSRP on its own -- just the manufacturer's number, nothing
                  else mixed into this card. The comparison against what the
                  buyer is actually being asked to pay lives in the Quoted
                  price card right below, colored against this figure. */}
              <div style={cardStyle}>
                <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>{analysis.msrpBasis==="dealer_stated"?"MSRP · as stated by dealer":analysis.msrpBasis==="starting_at"?`MSRP · starting at${analysis.msrpYear&&analysis.msrpYear!==analysis.year?` (${analysis.msrpYear} MY)`:""}`:analysis.msrpTrim?`MSRP · ${String(analysis.msrpTrim).toUpperCase()}`:"MSRP"}</div>
                <div style={{fontSize:22,fontWeight:1000,color:C.ink}}>{analysis.msrp?`$${analysis.msrp.toLocaleString()}`:"Not shown on quote"}</div>
                {isExactMsrp(analysis)&&analysis.allInPricing&&analysis.allInPricing.body&&analysis.msrpPriceBasis!=="incl_freight"&&<div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>Basis note: the asking price is all-in ({analysis.allInPricing.body}), while a published MSRP normally excludes freight &amp; PDI (typically $2,000–$2,600) — part of the gap is that freight. Ask for freight and PDI as their own line.</div>}
                {analysis.msrpBasis==="original_when_new"&&<div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>This is what the vehicle cost <b>when new</b> — context, not a sticker to measure a used price against, so no over/under-MSRP claim is made.</div>}
                {analysis.msrpUnavailable&&<div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>{analysis.msrpUnavailable.note}</div>}
                {analysis.msrpBasis==="dealer_stated"&&<div style={{fontSize:12,color:C.coralInk,marginTop:4,lineHeight:1.5}}>This is the figure the dealer states on their own page — not verified against {analysis.make||"the manufacturer"}'s published price, so no over/under-MSRP claim is made from it.</div>}
                {analysis.msrpReference&&analysis.msrpReference.msrp>0&&<div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>For reference, {analysis.msrpReference.make||"the manufacturer"} publishes this model{analysis.msrpReference.trim?` (${analysis.msrpReference.trim})`:""} from <b>{money(analysis.msrpReference.msrp)}</b> — options and drivetrain sit above that. Ask which ones make up the difference.</div>}
                {analysis.msrpBasis==="starting_at"&&<div style={{fontSize:12,color:C.inkSoft,marginTop:4,lineHeight:1.5}}>The manufacturer's base price for this model — this exact unit's options are extra, so no over/under-MSRP claim is made from it.</div>}
                {analysis.msrpSourceUrl&&<a href={analysis.msrpSourceUrl} target="_blank" rel="noopener noreferrer" style={{display:"inline-block",marginTop:6,fontSize:12,color:C.tealInk,textDecoration:"underline"}}>See the manufacturer's own page for this MSRP ↗</a>}
              </div>

              {/* Quoted price colored against MSRP: teal/green at-or-under
                  MSRP, coral/red over it. hasMsrpCompare guards against
                  coloring when either number is missing (e.g. MSRP wasn't
                  on the quote) -- no color claim without both values. */}
              {(()=>{
                // Over/under-MSRP claims require an EXACT trim MSRP. A
                // "starting_at" floor (base trim / adjacent MY) is a reference,
                // not this unit's sticker — an option-loaded car above the base
                // floor is NOT "over MSRP", so the compare stays neutral.
                const msrpExactScroll=isExactMsrp(analysis);
                const hasMsrpCompare=!!(msrpExactScroll&&analysis.quotedPrice);
                const overMsrp=hasMsrpCompare&&analysis.quotedPrice>analysis.msrp;
                const diff=hasMsrpCompare?Math.abs(analysis.quotedPrice-analysis.msrp):0;
                const priceColor=hasMsrpCompare?(overMsrp?C.coralInk:C.tealInk):C.ink;
                const gated=!analysis.quotedPrice&&analysis.priceDisclosure==="contact_for_price";
                return (
                  <div style={{...cardStyle,...(hasMsrpCompare?{background:overMsrp?C.coralBg:C.tealBg,border:`1px solid ${overMsrp?C.coral:C.teal}55`}:gated?{background:C.coralBg,border:`1px solid ${C.coral}55`}:{})}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Quoted price{analysis.allInPricing?" · all-in":""}</div>
                    <div style={{fontSize:22,fontWeight:1000,color:gated?C.coralInk:priceColor}}>{analysis.quotedPrice?`$${analysis.quotedPrice.toLocaleString()}`:gated?"Hidden by the dealer":"Not found"}</div>
                    {gated&&(
                      <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.55}}>
                        The page says <b style={{color:C.ink}}>"Contact us for price"</b> — the dealer chose not to publish the number. That's a lead-capture tactic: they want you on the phone, where their salespeople run the conversation.{analysis.msrp&&isManufacturerFigure(analysis.msrpBasis)?<> Your anchor: <b style={{color:C.ink}}>{`${analysis.make||"the manufacturer"}'s MSRP starts at $${Number(analysis.msrp).toLocaleString()}`}</b>.</>:null} Don't negotiate blind — ask for their full all-in price <b style={{color:C.ink}}>in writing</b> before you visit.
                      </div>
                    )}
                    {hasMsrpCompare&&(
                      <div style={{fontSize:12,fontWeight:700,color:priceColor,marginTop:4}}>
                        {diff===0?"= Exactly at MSRP":overMsrp?`▲ $${diff.toLocaleString()} over MSRP`:`▼ $${diff.toLocaleString()} under MSRP`}
                      </div>
                    )}
                    {!hasMsrpCompare&&analysis.msrp&&analysis.quotedPrice&&(
                      <div style={{fontSize:12,fontWeight:700,color:C.inkSoft,marginTop:4}}>base MSRP from ${Number(analysis.msrp).toLocaleString()} — options extra, no over/under claim</div>
                    )}
                  </div>
                );
              })()}

              {/* ── Verification checks (the real 10-point results) rendered
                  from the edge function's structured output: leverage,
                  recalls, odometer, VIN, financing math. Each card only
                  appears when its check ran, and reuses the same teal=good /
                  coral=concern language as the price cards above. ── */}

              {/* Independent used-market value (provider-agnostic, auto when a
                  VIN is present + a market-value provider is live). Buyer-side
                  value anchor — NOT the dealer's trade-in number. Source label
                  comes from the data so it stays accurate as providers change. */}
              {analysis.marketValue&&analysis.marketValue.average!=null&&(()=>{
                const mv=analysis.marketValue;
                const asking=Number(analysis.quotedPrice)||0;
                const avg=Number(mv.average);
                const delta=(asking&&avg)?asking-avg:0;
                const good=delta<=0;
                return (
                  <div style={{...cardStyle,background:good?C.tealBg:C.coralBg,border:`1px solid ${(good?C.teal:C.coral)}55`}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Market value · {mv.source||"independent"}</div>
                    <div style={{fontSize:18,fontWeight:1000,color:good?C.tealInk:C.coralInk,lineHeight:1.1}}>
                      {(asking&&avg)?`Asking is ${delta<=0?`$${Math.abs(delta).toLocaleString()} under`:`$${delta.toLocaleString()} over`} market`:`Market average $${avg.toLocaleString()}`}
                    </div>
                    <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>
                      Typical market range <b>${Number(mv.below).toLocaleString()}–${Number(mv.above).toLocaleString()}</b>{mv.mileage?` at ~${Number(mv.mileage).toLocaleString()} km`:""}{(mv.comps||mv.count)?`, from ${Number(mv.comps||mv.count).toLocaleString()} recent listings`:""}. This is the independent market value — not the dealer's trade-in number.
                    </div>
                  </div>
                );
              })()}

              {analysis.leverageScore?.computed&&(
                <div style={{...cardStyle,background:C.tealBg,border:`1px solid ${C.teal}55`}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Negotiation leverage</div>
                  <div style={{fontSize:28,fontWeight:1000,color:C.ink,lineHeight:1}}>{analysis.leverageScore.score}<span style={{fontSize:15,color:C.inkFaint,fontWeight:800}}> /10</span></div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>{analysis.leverageScore.note}</div>
                </div>
              )}

              {/* Fine print — the dealer's own disclaimer, captured as evidence.
                  AMVIC has ruled disclaimers don't exempt all-in pricing, so the
                  hatch language is the dealer's posture on record. */}
              {analysis.disclaimerCheck&&(
                <div style={{...cardStyle,background:C.butterBg,border:`1px solid ${C.butter}66`}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>The dealer's own fine print · captured at scan time</div>
                  <div style={{fontSize:12,color:C.inkSoft,fontStyle:"italic",lineHeight:1.5}}>"{String(analysis.disclaimerCheck.text).slice(0,380)}{String(analysis.disclaimerCheck.text).length>380?"…":""}"</div>
                  <div style={{fontSize:12.5,color:C.ink,lineHeight:1.55,marginTop:8}}>{analysis.disclaimerCheck.note}</div>
                </div>
              )}

              {/* Days on lot — the motivated-seller clock, from the dealer's OWN
                  inventory data (never estimated). Traffic-light: ≤30 green ·
                  31–89 amber · 90+ red. Same data as the deck's First Seen card. */}
              {analysis.daysOnLot&&Number(analysis.daysOnLot.days)>0&&(()=>{
                const d=Number(analysis.daysOnLot.days);
                const hot=d>=90, warm=d>=31&&d<90;
                const bg=hot?C.coralBg:warm?undefined:C.tealBg;
                const bd=hot?C.coral:warm?"#ffb020":C.teal;
                const inkC=hot?C.coralInk:warm?C.ink:C.tealInk;
                const months=d>=60?(d/30.4).toFixed(1).replace(/\.0$/,""):null;
                return (
                  <div style={{...cardStyle,...(bg?{background:bg}:{}),border:`1px solid ${bd}55`}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Days on lot · {analysis.daysOnLot.sourceLabel||"dealer inventory data"}</div>
                    <div style={{fontSize:28,fontWeight:1000,color:inkC,lineHeight:1}}>{d.toLocaleString()} days{months?<span style={{fontSize:15,color:C.inkFaint,fontWeight:800}}> · ~{months} months</span>:null}</div>
                    {analysis.daysOnLot.since&&<div style={{fontSize:12,fontWeight:700,color:C.inkSoft,marginTop:4}}>First seen {analysis.daysOnLot.since}</div>}
                    <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.5}}>
                      This is how long this exact car has sat unsold — counted by the dealer's own inventory system, not our guess. Dealers pay interest on unsold stock every week, so the longer it sits, the more motivated they are.{" "}
                      {hot?"At this age, you're doing them a favour by buying it — negotiate like it.":warm?"A month-plus of sitting is real carrying cost — reasonable grounds to ask for a better price.":"This one is fresh, so sitting-time won't move the price much yet."}
                      {dolCareAsk(d)}
                    </div>
                  </div>
                );
              })()}

              {/* #11 — AMVIC dealer licence, verbatim from the regulator's registry. */}
              {analysis.dealerLicence&&analysis.dealerLicence.status&&(()=>{
                const L=analysis.dealerLicence, good=L.state==="valid";
                return (
                  <div style={{...cardStyle,...(good?{}:{background:C.coralBg}),border:`1px solid ${(good?C.teal:C.coral)}55`}}>
                    <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Dealer licence · AMVIC public registry</div>
                    <div style={{fontSize:20,fontWeight:1000,color:good?C.tealInk:C.coralInk,lineHeight:1.2}}>{L.status}</div>
                    <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.55}}>
                      {L.legalName?`Registry record: ${L.legalName}. `:""}{L.licenceNumber?`Licence ${L.licenceNumber}. `:""}{L.expiryDate?`Expiry ${L.expiryDate}. `:""}
                      {good?"That's the status you want to see.":"Ask them to confirm their current AMVIC licence number and status in writing before any deposit."}
                    </div>
                    <a href="https://amvic.ca.thentiacloud.net/webs/amvic/register/" target="_blank" rel="noopener noreferrer" style={{fontSize:11.5,color:C.tealInk,fontWeight:800,marginTop:8,display:"inline-block"}}>Check it yourself on AMVIC's registry ↗</a>
                  </div>
                );
              })()}

              {/* S37 — advertised price conditional on dealer financing. Same
                  data and same ask as the deck's card; a cash buyer never learns
                  this from the page's own headline. */}
              {analysis.financeContingent&&analysis.financeContingent.contingent&&(
                <div style={{...cardStyle,borderLeft:`3px solid ${C.coral}`}}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Price conditions · {(analysis.financeContingent.reasons||[]).join(" · ")}</div>
                  <div style={{fontSize:15,fontWeight:900,color:C.ink,lineHeight:1.35}}>This price depends on financing with the dealer</div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.55}}>
                    The listing's own wording ties the advertised price to taking the dealer's financing. Pay cash, or use your own bank, and the price can legitimately change — the discount is often funded by the dealer's commission on the loan, so it leaves with the loan.
                  </div>
                  {analysis.financeContingent.evidence&&(
                    <div style={{fontSize:12,color:C.inkSoft,marginTop:8,fontStyle:"italic",lineHeight:1.5}}>“…{analysis.financeContingent.evidence}…”</div>
                  )}
                  <div style={{fontSize:12,color:C.ink,marginTop:8,lineHeight:1.55}}>
                    <b>Ask before you go in:</b> “What is the price if I pay cash or use my own bank — and if it changes, by exactly how much?” In writing.
                  </div>
                </div>
              )}

              {/* S36 — trade-in instant-offer widget: name the mechanism, coach the
                  decoupling play. Same data as the deck's Trade-in card. */}
              {analysis.tradeInWidget&&analysis.tradeInWidget.detected&&(
                <div style={cardStyle}>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:4}}>Trade-in tool on this listing{analysis.tradeInWidget.vendor?` · ${analysis.tradeInWidget.vendor}`:""}</div>
                  <div style={{fontSize:15,fontWeight:900,color:C.ink,lineHeight:1.35}}>This dealer runs an instant trade-in appraisal widget</div>
                  <div style={{fontSize:12,color:C.inkSoft,marginTop:6,lineHeight:1.55}}>
                    Its number is anchored to the wholesale side of the market (what dealers pay each other), it's non-binding, and it appears in exchange for your contact and vehicle details.
                    If you have a trade: settle this vehicle's price first; get the trade offer in writing on its own line — never one blended payment; and check retail listings for your own car before disclosing anything.
                  </div>
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
                    {/* Why-this-shows explainer -- pre-empts a dealer's "that's not
                        true" dispute by grounding the recalls in public government
                        data and pointing to VIN confirmation. Deliberately bold and
                        high-contrast so it isn't missed. */}
                    <div style={{marginTop:10,background:C.paper2,border:`1.5px solid ${C.coral}66`,borderRadius:12,padding:"12px 14px"}}>
                      <div style={{fontSize:13,fontWeight:1000,color:C.coralInk,marginBottom:6,letterSpacing:0.2}}>Why you're seeing this</div>
                      <div style={{fontSize:12.5,color:C.ink,lineHeight:1.6,fontWeight:700}}>
                        These are open safety-recall campaigns <b>Transport Canada</b> has published for this vehicle's <b>year, make and model</b> — read live from the official federal <b>Vehicle Recall Database</b>. This is public government data, not LotCheck's opinion. Recalls are issued per model, so the dealer can confirm by <b>VIN</b> whether this exact vehicle is affected or has already had the free remedy done — ask them to show the VIN's recall status in writing before you sign.
                      </div>
                    </div>
                    <DetailToggle C={C} moreLabel={`Show ${r.count} recall detail${r.count>1?"s":""}`} lessLabel="Hide recall details">
                      {(r.items||[]).slice(0,4).map((it,i)=>(
                        <div key={i} style={{fontSize:12,color:C.ink,marginTop:8,paddingTop:8,borderTop:`1px solid ${C.line}`}}>
                          <div style={{fontWeight:800}}>{it.system||"Recall"}{it.date?yr(it.date):""}</div>
                          {it.summary&&<div style={{color:C.inkSoft,marginTop:2,lineHeight:1.5}}>{it.summary}</div>}
                        </div>
                      ))}
                    </DetailToggle>
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
                  <DetailToggle C={C} moreLabel={`Show ${sampledHighlights.length} review highlight${sampledHighlights.length>1?"s":""}`} lessLabel="Hide highlights">
                    {sampledHighlights.map((h,i)=>(
                      <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",padding:"6px 0",borderTop:i>0?`1px solid ${C.line}`:"none"}}>
                        <span style={{color:ratingColor(h.rating),fontWeight:800,fontSize:12,lineHeight:"20px",whiteSpace:"nowrap"}}>★{h.rating}</span>
                        <span style={{fontSize:13,color:C.ink,lineHeight:1.5}}>{h.text}</span>
                      </div>
                    ))}
                  </DetailToggle>
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

              {/* Used vehicles: how much of the ORIGINAL manufacturer warranty is
                  left, estimated from the verified catalog terms + model year +
                  odometer. Labelled ESTIMATED (the clock starts at the in-service
                  date, which we approximate with the model year). */}
              {analysis.remainingWarranty&&(analysis.remainingWarranty.basic||analysis.remainingWarranty.powertrain)&&(()=>{
                const rw=analysis.remainingWarranty;
                const anyActive=(rw.basic&&rw.basic.active)||(rw.powertrain&&rw.powertrain.active);
                const Term=({label,t})=>{
                  if(!t) return null;
                  const parts=[];
                  if(t.active){
                    parts.push(`~${t.yearsLeft} yr`);
                    if(t.kmUnlimited) parts.push("unlimited km");
                    else if(t.odometerKnown&&t.kmLeft!=null) parts.push(`${Number(t.kmLeft).toLocaleString()} km`);
                  }
                  return (
                    <div style={{display:"flex",justifyContent:"space-between",gap:12,padding:"7px 0",borderTop:`1px solid ${C.line}`}}>
                      <span style={{fontSize:13,color:C.ink}}>{label} <span style={{color:C.inkFaint}}>({t.term})</span></span>
                      <span style={{fontSize:13,fontWeight:800,color:t.active?C.tealInk:C.coralInk,whiteSpace:"nowrap"}}>{t.active?`${parts.join(" / ")} left`:"Expired"}</span>
                    </div>
                  );
                };
                return (
                  <div style={{...cardStyle,border:`1px solid ${anyActive?C.teal+"55":C.line}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:4}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>Factory warranty remaining</div>
                      <span style={{fontSize:10.5,fontWeight:800,color:C.inkFaint,background:C.paper2,borderRadius:5,padding:"2px 7px",letterSpacing:.3}}>ESTIMATED</span>
                    </div>
                    <div style={{fontSize:12,color:C.inkFaint,marginBottom:2}}>Based on the {rw.modelYear} model year{rw.odometerKm!=null?` and ${Number(rw.odometerKm).toLocaleString()} km`:""}{rw.make?` · ${rw.make}`:""}.</div>
                    <Term label="Basic / comprehensive" t={rw.basic}/>
                    <Term label="Powertrain" t={rw.powertrain}/>
                    <div style={{fontSize:11.5,color:C.inkFaint,lineHeight:1.55,marginTop:8}}>
                      Coverage ends at whichever comes first — years or kilometres. Estimated from the model year; the clock actually starts on the in-service date, so confirm it on the VIN/CARFAX report{rw.odometerKm==null?" (the odometer wasn't listed, so this is time-based only)":""}.
                    </div>
                    {rw.sourceUrl&&<a href={rw.sourceUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:C.tealInk,textDecoration:"none",fontWeight:700,display:"inline-block",marginTop:6}}>Manufacturer's official terms ↗</a>}
                  </div>
                );
              })()}

              {/* Native VIN history removed (VinAudit cancelled). The CARFAX
                  hand-off above is the history path; a new provider can slot in
                  behind the same card later. */}

              {/* ── Rebates & conditions ─────────────────────────────────────
                  Groups the EVAP rebate check, any advertised conditional
                  savings, and the itemized discounts/add-ons into ONE card per
                  the approved layout. Each inner block keeps its own
                  conditional, colour semantics, and honesty copy -- nothing is
                  dropped or restated.

                  EVAP note (unchanged rationale): the rebate status is shown for
                  ANY BEV/PHEV, new or used, since for a real EV that status is
                  information a buyer wants; only gas/diesel are hidden.
                  effectiveFuelType/evapShow/rebate/fuelMismatch are computed once
                  at the top of this report from the curated EVAP_LIST (a source
                  of truth the page's own fuelType label isn't -- a stale
                  inventory "Gas" read must not hide a real EV rebate) and reused
                  by both the hero tile and this card so they always agree. ── */}
              {/* S3 — "What you'll really pay": reconcile the selling price up to
                  the real out-the-door, splitting unavoidable fees from removable
                  dealer add-ons so the buyer sees exactly how much markup they
                  can decline. See dealer-tactics-safeguards.md (S3). */}
              {analysis.reconciliation&&(()=>{
                const r=analysis.reconciliation;
                const m=(n)=>n==null?"—":`$${Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}`;
                const removable=Number(r.addonsTotal)||0, feesT=Number(r.feesTotal)||0, added=Number(r.addedOnTop)||0;
                if(!added&&r.sellingPrice==null) return null;
                const names=(r.addons||[]).map(a=>a.name).filter(Boolean);
                const Row=({label,val,sub,tone,strong})=>(
                  <div style={{display:"flex",justifyContent:"space-between",gap:12,padding:"8px 0",borderTop:`1px solid ${C.line}`}}>
                    <div><div style={{fontSize:13,fontWeight:strong?800:600,color:C.ink}}>{label}</div>{sub&&<div style={{fontSize:11,color:C.inkFaint,marginTop:1}}>{sub}</div>}</div>
                    <div style={{fontSize:strong?16:14,fontWeight:strong?1000:800,color:tone==="coral"?C.coralInk:C.ink,whiteSpace:"nowrap"}}>{val}</div>
                  </div>
                );
                return (
                  <div style={cardStyle}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:6}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>What you'll really pay</div>
                      <span style={{fontSize:10.5,fontWeight:800,color:C.inkFaint,background:C.paper2,borderRadius:5,padding:"2px 7px",letterSpacing:.3}}>OUT-THE-DOOR</span>
                    </div>
                    {r.sellingPrice!=null&&<Row label="Selling price" val={m(r.sellingPrice)}/>}
                    {feesT>0&&<Row label="Unavoidable fees" sub="doc, registration, freight, tax" val={`+ ${m(feesT)}`}/>}
                    {removable>0&&<Row label="Dealer add-ons — removable" sub="negotiable · you can decline these" val={`+ ${m(removable)}`} tone="coral"/>}
                    {r.realPreTax!=null&&<Row label="Real price, before tax" val={m(r.realPreTax)} strong/>}
                    {removable>0&&(
                      <div style={{marginTop:10,background:C.coralBg,border:`1px solid ${C.coral}55`,borderRadius:11,padding:"11px 13px",fontSize:12.5,color:C.ink,lineHeight:1.55}}>
                        <b style={{color:C.coralInk}}>${removable.toLocaleString()}</b> of this quote is <b>removable dealer add-ons</b>{names.length?` (${names.slice(0,3).join(", ")}${names.length>3?"…":""})`:""}. They're negotiable — ask to have them taken off before you sign.
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* S11 — financing-contingent-discount trap. Frames the counter-
                  question and quantifies the trade-off when rate data is present.
                  See dealer-tactics-safeguards.md (S11). */}
              {analysis.financingTrap&&(()=>{
                const t=analysis.financingTrap;
                const m=(n)=>n==null?"—":`$${Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}`;
                const trap=t.mode==="quantified"&&t.isTrap;
                const bg=trap?C.coralBg:C.butterBg, br=trap?C.coral:C.butter, ink=trap?C.coralInk:C.butterInk;
                return (
                  <div style={{...cardStyle,background:bg,border:`1px solid ${br}55`}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8}}>
                      <FlagWaveIcon size={15}/>
                      <div style={{fontSize:13,fontWeight:800,color:ink}}>{trap?"Financing trap — the discount may cost you":"Discount vs. financing — ask before you sign"}</div>
                    </div>
                    <div style={{fontSize:12.5,color:C.ink,lineHeight:1.6,marginBottom:8}}>
                      {t.mode==="quantified"?(trap
                        ? <>This <b>{m(t.discount)} discount</b> may be tied to dealer financing. If so, financing at <b>{t.dealerApr}%</b> instead of the <b>{t.promoApr}%</b> promo adds about <b style={{color:C.coralInk}}>{m(t.extraInterest)}</b> in interest over {t.term} months — <b>more than the discount</b>. You'd net <b style={{color:C.coralInk}}>lose {m(Math.abs(t.net))}</b>.</>
                        : <>This <b>{m(t.discount)} discount</b> beats the higher rate here: financing at {t.dealerApr}% vs the {t.promoApr}% promo adds about {m(t.extraInterest)}, so the discount still nets you about <b style={{color:C.tealInk}}>{m(t.net)}</b> — but confirm you can keep the promo rate.</>)
                      : <>This discount may be offered <b>"in lieu of special financing"</b> — meaning you might not also get the low promo APR. A higher rate can quietly erase a discount over the life of the loan.</>}
                    </div>
                    <div style={{fontSize:12.5,color:ink,fontWeight:800,background:"#fff8",borderRadius:9,padding:"9px 12px"}}>
                      Ask: "Is this price in lieu of special financing? Can I get the discount <i>and</i> the promo APR?"
                    </div>
                  </div>
                );
              })()}

              {/* S12 — doc-fee vs jurisdiction benchmark. Fail-safe: only renders
                  when the server had a backed benchmark. See dealer-tactics-
                  safeguards.md (S12). */}
              {analysis.docFeeCheck&&(()=>{
                const d=analysis.docFeeCheck;
                const m=(n)=>`$${Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}`;
                const clean=d.kind==="within_cap";
                const bg=clean?C.tealBg:C.butterBg, br=clean?C.teal:C.butter, ink=clean?C.tealInk:C.butterInk;
                return (
                  <div style={{...cardStyle,background:bg,border:`1px solid ${br}55`}}>
                    <div style={{fontSize:13,fontWeight:800,color:ink,marginBottom:6}}>
                      {clean?"✓ Doc fee in line":"Doc fee — worth questioning"}
                    </div>
                    <div style={{fontSize:12.5,color:C.ink,lineHeight:1.6}}>
                      {d.kind==="allin"&&<>Your <b>{m(d.docFee)} doc/admin fee</b> — {d.jurisdiction} requires <b>all-in advertised pricing</b> ({d.body}), so this should already be <b>inside the advertised price</b>. Ask why it's separate.</>}
                      {d.kind==="over_cap"&&<>Your <b>{m(d.docFee)} doc fee</b> is about <b style={{color:C.coralInk}}>{m(d.overBy)} above</b> {d.jurisdiction}'s ~{m(d.benchmark)} cap ({d.note}). It's negotiable — push back.</>}
                      {d.kind==="over_norm"&&<>{d.jurisdiction} doesn't cap doc fees, and your <b>{m(d.docFee)}</b> is at the high end ({d.note}). Negotiable — ask them to reduce it.</>}
                      {d.kind==="within_cap"&&<>Your <b>{m(d.docFee)} doc fee</b> is within {d.jurisdiction}'s ~{m(d.benchmark)} cap ({d.note}). Nothing to flag here.</>}
                    </div>
                    <a href={d.source} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:C.tealInk,textDecoration:"none",fontWeight:700,display:"inline-block",marginTop:7}}>Source ↗</a>
                  </div>
                );
              })()}

              {/* Counter-script — the actionable capstone: exactly what to say to
                  get a better deal, aggregated from every safeguard above.
                  Green-when-clean if there's nothing to push on. */}
              {analysis.counterScript?.moves?.length>0&&(()=>{
                const cs=analysis.counterScript;
                return (
                  <div style={{...cardStyle,border:`1px solid ${(cs.clean?C.teal:C.tealInk)}55`}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:4}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>{cs.clean?"Say this to confirm":"What to say — your counter-script"}</div>
                      <span style={{fontSize:10.5,fontWeight:800,color:C.tealInk,background:C.tealBg,borderRadius:5,padding:"2px 7px",letterSpacing:.3}}>USE ON THE CALL</span>
                    </div>
                    <div style={{fontSize:12,color:C.inkFaint,lineHeight:1.5,marginBottom:10}}>
                      {cs.clean
                        ?"This deal looks straight — no add-ons or traps flagged. Just lock in the number:"
                        :"Read these to the dealer, in order. Every line comes from a finding above — say them and hold."}
                    </div>
                    <div>
                      {cs.moves.map((mv,i)=>(
                        <div key={i} style={{display:"flex",gap:10,padding:"9px 0",borderTop:i>0?`1px solid ${C.line}`:"none"}}>
                          <span style={{flexShrink:0,width:20,height:20,borderRadius:999,background:C.tealBg,color:C.tealInk,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{i+1}</span>
                          <div style={{fontSize:13.5,color:C.ink,lineHeight:1.5}}>{mv.say}</div>
                        </div>
                      ))}
                    </div>
                    <button onClick={copyCounterScript} style={{marginTop:12,width:"100%",background:scriptCopied?C.tealInk:C.teal,border:"none",borderRadius:10,padding:"11px 16px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>{scriptCopied?"✓ Copied — paste it into your notes":"Copy script"}</button>
                  </div>
                );
              })()}

              {(evapShow||analysis.totalFlaggedCost>0||analysis.addOns?.length>0)&&(
                <div style={cardStyle}>
                  <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:12}}>Rebates &amp; conditions</div>

                  {evapShow&&(
                    <div style={{borderRadius:14,padding:"13px 15px",marginBottom:12,background:rebate.eligible?C.tealBg:C.butterBg,border:`1px solid ${rebate.eligible?C.teal:C.butter}55`}}>
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
                  )}

                  {analysis.totalFlaggedCost>0&&(
                    <div style={{borderRadius:14,padding:"13px 15px",marginBottom:12,background:C.coralBg,border:`1px solid ${C.coral}55`}}>
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
                    <div>
                      <div style={{fontSize:12.5,fontWeight:800,color:C.inkSoft,marginBottom:2}}>{!addOnsAreFees?"Discounts & conditions":"Add-ons & fees"}</div>
                      <DetailToggle C={C} moreLabel={`Show all ${analysis.addOns.length} line item${analysis.addOns.length>1?"s":""}`} lessLabel="Hide line items">
                      {analysis.addOns.map((a,i)=>{
                        // verdict: "good" (genuine buyer benefit), "flagged"
                        // (worth questioning), or "standard" (a mandatory,
                        // unremarkable pass-through shown plainly).
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
                      </DetailToggle>
                      {/* Subtotal -- only for genuine fees, never discounts/
                          conditions. When kind data exists, sums only the
                          fee-kind items so a mixed report doesn't fold a
                          discount into a pure cost total. */}
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

              {analysis.warranty?.offered&&(()=>{
                // A SOLD extended warranty / protection plan is always an optional
                // add-on. Flag it as such and, when we know the free coverage this
                // vehicle already carries, put the two side by side so the buyer
                // has the leverage to decline or negotiate. Neutral + factual:
                // no "overpriced"/"ripoff" language (see neutral-factual-language,
                // defamation-proof-and-compliant).
                const w=analysis.warranty;
                const sw=analysis.standardWarranty;
                const isNew=analysis.vehicleCondition==="new";
                const price=w.price?`$${Number(w.price).toLocaleString()}`:null;
                return (
                  <div style={{...cardStyle,border:`1px solid ${C.butter}`,background:C.butterBg}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:8}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.inkSoft}}>Extended warranty / protection plan</div>
                      <span style={{fontSize:10.5,fontWeight:800,color:C.butterInk,background:C.butter+"66",borderRadius:5,padding:"2px 8px",letterSpacing:.3}}>⚠ OPTIONAL ADD-ON</span>
                    </div>
                    <div style={{color:C.ink,fontSize:15,fontWeight:800,marginBottom:6}}>{w.offered}{price?` — ${price}`:""}</div>
                    {isNew&&sw?.coverage?(
                      <div style={{fontSize:12.5,color:C.ink,lineHeight:1.6,marginBottom:6}}>
                        You already get <b>{sw.coverage}</b> at no cost on this new {analysis.make||"vehicle"}{sw.verified?" — verified against the manufacturer's official Canadian terms":""}. This plan is <b>optional and negotiable</b>: you can decline it, and extended coverage can usually be bought later or from another provider.
                      </div>
                    ):(
                      <div style={{fontSize:12.5,color:C.ink,lineHeight:1.6,marginBottom:6}}>
                        This is an <b>optional add-on</b>. Confirm whether the original manufacturer warranty is still active first (it usually runs from the in-service date, not the sale date) — extended coverage is negotiable and can be declined or purchased later.
                      </div>
                    )}
                    {w.assessment&&<div style={{fontSize:12,color:C.inkFaint,lineHeight:1.5}}>{w.assessment}</div>}
                  </div>
                );
              })()}

              </div>{/* ── end detail grid ── */}

              {analysis.reportId&&(
                <div style={cardStyle}>
                  {/* 3D animated lock — the icon IS the meaning (no emojis):
                      the shackle drops closed on mount, the whole lock tilts in
                      3D on hover. Same visual language as the site's 3D logo. */}
                  <style>{`
                    @keyframes lcLockClose { 0% { transform: translateY(-5px); } 60% { transform: translateY(1px); } 100% { transform: translateY(0); } }
                    .lc-lock3d { width: 30px; height: 34px; position: relative; flex: none; perspective: 300px; }
                    .lc-lock3d .sh { position: absolute; top: 0; left: 6px; width: 18px; height: 15px; border: 3.5px solid ${C.tealInk}; border-bottom: none; border-radius: 10px 10px 0 0; animation: lcLockClose .8s cubic-bezier(.34,1.4,.5,1) both; }
                    .lc-lock3d .bd { position: absolute; bottom: 0; left: 0; width: 30px; height: 21px; border-radius: 6px; background: linear-gradient(150deg, ${C.teal}, ${C.tealInk}); box-shadow: inset -3px -3px 6px rgba(0,0,0,.25), 0 4px 8px -3px rgba(0,0,0,.35); }
                    .lc-lock3d .kh { position: absolute; bottom: 7px; left: 13px; width: 4px; height: 8px; border-radius: 3px; background: rgba(255,255,255,.85); }
                    .lc-lock3d:hover { transform: rotate3d(.5, 1, 0, 24deg); transition: transform .4s ease-out; }
                  `}</style>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
                      <div className="lc-lock3d"><span className="sh"/><span className="bd"/><span className="kh"/></div>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:15,fontWeight:900,color:C.ink}}>This report is locked</div>
                        <div style={{fontSize:12,fontFamily:"ui-monospace,Menlo,Consolas,monospace",color:C.inkFaint,marginTop:2}}>{analysis.reportId}{analysis.issuedAt?` · ${new Date(analysis.issuedAt).toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"})}`:""}</div>
                      </div>
                    </div>
                    {(analysis.sig||analysis.reportId)&&<div style={{flex:"none",textAlign:"center"}}><Seal seed={sealSeed(analysis.sig||analysis.reportId)} size={62} gid="rseal" ink="#33305a"/><div style={{fontSize:8.5,fontWeight:700,letterSpacing:.5,color:C.inkFaint,marginTop:1}}>ITS SEAL</div></div>}
                  </div>
                  <div style={{fontSize:12.5,color:C.inkSoft,lineHeight:1.55,margin:"8px 0 12px"}}>
                    If anyone changes a single number, the seal breaks. Share the link — whoever opens it sees the full report and can check it's genuine.
                  </div>
                  {analysis.verifyPayload&&(
                    <div>
                      <button onClick={copyVerifyLink} style={{width:"100%",background:verifyCopied?C.tealInk:C.teal,border:"none",borderRadius:10,padding:"12px 16px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>{verifyCopied?"Link copied":"Copy the link"}</button>
                      <a href={verifyLinkFor(analysis)} target="_blank" rel="noopener noreferrer" style={{display:"inline-block",marginTop:8,fontSize:12,color:C.inkFaint,textDecoration:"underline"}}>or check this report's seal yourself</a>
                    </div>
                  )}
                </div>
              )}

              <div style={cardStyle}>
                <div style={{fontSize:13,fontWeight:800,color:C.inkSoft,marginBottom:10}}>Email me this report</div>
                {emailStatus==="sent"?(
                  <div style={{display:"flex",alignItems:"center",gap:8,color:C.tealInk,fontWeight:700,fontSize:14}}>
                    <DroneSentBeat body={C.inkFaint} accent={C.teal}/>
                    <span className="lcSentFade" style={{animation:"lcSentFade .5s ease .9s both"}}>Sent to {emailInput.trim()}</span>
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
            );
          }}/></ReportBoundary>}

          <div style={{textAlign:"center",marginTop:20,fontSize:11,color:C.inkFaint}}>
            LotCheck never saves your quote to our own systems. It's analyzed once, then discarded on our end — nothing is stored.
          </div>
        </div>
      </div>
      {showSignIn&&<SignInModal C={C} cardStyle={cardStyle} notice={signInNotice} onClose={()=>{setShowSignIn(false);setSignInNotice(null);}}/>}
      {showPaywall&&<QuotePaywallModal C={C} cardStyle={cardStyle} onClose={()=>setShowPaywall(false)}/>}
    </>
  );
}

// Trust page (/real): turns the cryptographic signing into user-facing brand
// protection — how to tell a genuine, verifiable LotCheck report from a fake.
// VinAudit can only post a "beware" banner; we can prove authenticity, so this
// page teaches the one-scan check. Nav on top per the site-wide rule.
function TrustPage(){
  const NAV=[["MSRP Price Index","/live-price-index"],["Alberta Dealers Map","/alberta"],["How it works","/#how"],["10-point lane","/#pipeline"],["Sample report","/#report"],["What LotCheck does","/#what"],["MSRP Notifier","/msrp-alerts"],["Verify report","/verify"]];
  const card={background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:16};
  const css=`@media(max-width:900px){.tnav-links{display:none!important}.tnav-cta{margin-left:auto!important}}
  @media(max-width:600px){.tsteps,.tcols{grid-template-columns:1fr!important}}
  .tnav-links a:hover{color:#fff!important}`+SHIELD_CSS;
  return (
    <div style={{minHeight:"100vh",background:"radial-gradient(120% 90% at 30% 8%,#221f3a 0%,#161327 55%,#0e0b1c 100%)",fontFamily:"system-ui,-apple-system,'Nunito',sans-serif",color:"#e9e6f5"}}>
      <style dangerouslySetInnerHTML={{__html:css}}/>
      <nav style={{position:"sticky",top:0,zIndex:300,background:"rgba(14,11,28,.82)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
        <div style={{maxWidth:1120,margin:"0 auto",padding:"11px clamp(16px,3vw,28px)",display:"flex",alignItems:"center",gap:22}}>
          <a href="/" style={{display:"flex",alignItems:"center",gap:9,textDecoration:"none",color:"#fff",fontWeight:800,fontSize:"1.05rem"}}><SiteLogo size={45}/>LotCheck</a>
          <div className="tnav-links" style={{display:"flex",gap:19,marginLeft:"auto",alignItems:"center",flexWrap:"nowrap"}}>
            {NAV.map(([label,href])=><a key={label} href={href} style={{fontSize:".9rem",fontWeight:600,color:"#b6b1d6",textDecoration:"none",whiteSpace:"nowrap"}}>{label}</a>)}
          </div>
          <a href="/quote-check" className="tnav-cta" style={{background:"#2FA79A",color:"#fff",fontWeight:800,fontSize:".85rem",textDecoration:"none",padding:"8px 15px",borderRadius:10,whiteSpace:"nowrap"}}>Analyze my quote</a>
        </div>
      </nav>

      <div style={{maxWidth:720,margin:"0 auto",padding:"28px 18px"}}>
        <button onClick={()=>{if(window.history.length>1)window.history.back();else window.location.href="/";}} style={{background:"transparent",border:"1px solid rgba(255,255,255,.14)",color:"#b6b1d6",borderRadius:9,padding:"7px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer",marginBottom:14}}>← Back</button>
        <div style={{background:"radial-gradient(120% 90% at 30% 8%,#221f3a,#0e0b1c)",border:"1px solid rgba(255,255,255,.08)",borderRadius:16,padding:24}}>
          <div style={{fontSize:11,letterSpacing:"2px",textTransform:"uppercase",fontWeight:800,color:"#7f77dd",fontFamily:"ui-monospace,Menlo,Consolas,monospace"}}>LotCheck · Trust</div>
          <div style={{fontSize:26,fontWeight:800,color:"#fff",margin:"8px 0 6px"}}>Is it a real LotCheck report?</div>
          <div style={{fontSize:14.5,color:"#b6b1d6",lineHeight:1.6}}>Every genuine LotCheck report proves itself. Scammers can copy a look — they can't copy the math. Here's the 10-second check.</div>
          <div style={{marginTop:16,display:"flex",gap:12,alignItems:"center",background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.3)",borderRadius:12,padding:"14px 16px"}}>
            <div style={{flex:"none"}}><Shield state="ok" size={52}/></div>
            <div style={{fontSize:13.5,lineHeight:1.55,color:"#dffff2"}}>The one rule: scan the QR (or open the verify link) — it must open <b style={{color:"#5dcaa5"}}>lotcheck.ca/verify</b> and show a green <b style={{color:"#5dcaa5"}}>“Signed &amp; authentic”</b> seal. No green check = not a real LotCheck report.</div>
          </div>
        </div>

        <div className="tsteps" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,margin:"18px 0"}}>
          {[["1","Find the QR code at the bottom of the PDF, or the verify link in your email."],["2","Scan it. It opens lotcheck.ca/verify and re-checks the report live."],["3","Green “Signed & authentic” = real. Red or no result = fake or altered."]].map(([n,t])=>(
            <div key={n} style={card}>
              <div style={{width:24,height:24,borderRadius:"50%",background:"#2FA79A",color:"#fff",fontWeight:900,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>{n}</div>
              <p style={{fontSize:12.5,color:"#c3bfe0",lineHeight:1.5,margin:0}}>{t}</p>
            </div>
          ))}
        </div>

        <div className="tcols" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div style={{...card,background:"rgba(127,119,221,.08)",borderColor:"rgba(127,119,221,.3)"}}>
            <h3 style={{fontSize:13,margin:"0 0 10px",fontWeight:800,color:"#a99ff0"}}>🔒 Why a fake can't pass</h3>
            <ul style={{margin:0,padding:0}}>
              {["Each report is cryptographically signed with a key only LotCheck holds — can't be forged.","The report ID is a fingerprint of its contents — change one figure and it stops matching.","The check runs on our site with our public key — a copycat site can't fake a pass.","We store nothing — the proof travels inside the link."].map((t,i)=>(
                <li key={i} style={{fontSize:12.5,color:"#c3bfe0",lineHeight:1.5,marginBottom:7,listStyle:"none",paddingLeft:16,position:"relative"}}><span style={{position:"absolute",left:0}}>·</span>{t}</li>
              ))}
            </ul>
          </div>
          <div style={{...card,background:"rgba(240,153,123,.08)",borderColor:"rgba(240,153,123,.3)"}}>
            <h3 style={{fontSize:13,margin:"0 0 10px",fontWeight:800,color:"#f0b79b"}}>⚠ Red flags of a fake</h3>
            <ul style={{margin:0,padding:0}}>
              {["Won't verify at lotcheck.ca/verify — or has no QR/link at all.","Shows a “verified” result on some other website.","Report ID fails or shows “altered.”","Came from a look-alike domain (the real site is lotcheck.ca).","Asks you to pay on an unfamiliar site."].map((t,i)=>(
                <li key={i} style={{fontSize:12.5,color:"#c3bfe0",lineHeight:1.5,marginBottom:7,listStyle:"none",paddingLeft:16,position:"relative"}}><span style={{position:"absolute",left:0,color:"#f0997b"}}>›</span>{t}</li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{marginTop:20,textAlign:"center"}}>
          <a href="/verify" style={{display:"inline-block",background:"#2FA79A",color:"#fff",fontWeight:800,fontSize:15,textDecoration:"none",padding:"13px 26px",borderRadius:11}}>Verify a report now →</a>
          <div style={{fontSize:11.5,color:"#8b86ad",marginTop:9}}>Nothing is stored. The check runs from the report's own link.</div>
        </div>
      </div>
    </div>
  );
}

// ── MSRP Alerts page (concept #11 "Cosmic Weather Station") ───────────────────
// A React route (/msrp-alerts) that replaces the old static live-price-index
// widget. The 3D planet is decorative; the copy stays an HONEST WAITLIST — live
// price tracking isn't running yet, so we never imply an alert will fire. Submits
// to the same SECURITY DEFINER RPC fn_alert_subscribe (CASL consent required;
// anon can insert, never read). [[nothing-published-without-verification]],
// [[alerts-are-bridge-inventory]] (signups file by make+city into demand folders).
// Top new models sold in Canada (trucks, SUVs, sedans, minivans, EVs) — the cars
// a buyer is most likely to want an MSRP alert on. year=2026 model-year default.
// Full A-Z Canadian lineup (2027 model year) — mainstream, luxury, exotic, EV,
// PHEV. Grouped by make (alphabetical). Obvious non-real entries from the source
// directory (e.g. Bentley "Torcal", a revived BMW "i3") were dropped so a dealer
// can actually match every option.
const MAL_VEHICLE_MAP={
  Acura:["Integra","TLX","MDX","RDX","ZDX"],
  "Alfa Romeo":["Giulia","Stelvio","Tonale"],
  "Aston Martin":["Vantage","DB12","DBX707"],
  Audi:["A4","A5","Q3","Q4 e-tron","Q5","Q6 e-tron","Q7","Q8","Q8 e-tron"],
  Bentley:["Continental GT","Flying Spur","Bentayga"],
  BMW:["3 Series","5 Series","X1","X3","X5","X7","i4","iX","iX3"],
  Buick:["Encore GX","Envista","Envision","Enclave"],
  Cadillac:["CT5","XT4","XT5","XT6","Escalade","Escalade IQ","Lyriq","Optiq","Celestiq"],
  Chevrolet:["Trax","Trailblazer","Equinox","Equinox EV","Blazer","Blazer EV","Traverse","Tahoe","Suburban","Colorado","Silverado 1500","Silverado EV","Bolt EV","Corvette"],
  Chrysler:["Pacifica","Pacifica PHEV","Grand Caravan"],
  Dodge:["Hornet","Durango","Charger","Charger Daytona EV"],
  Ferrari:["Roma","296 GTB","12Cilindri","Purosangue","F80"],
  Fiat:["500e"],
  Ford:["Maverick","Ranger","F-150","F-150 Lightning","Super Duty","Escape","Edge","Explorer","Bronco Sport","Bronco","Expedition","Mustang","Mustang Mach-E"],
  Genesis:["G70","G80","G90","GV60","GV70","GV80","GV80 Coupe"],
  GMC:["Terrain","Acadia","Canyon","Sierra 1500","Sierra EV","Yukon","Hummer EV"],
  Honda:["Civic","Accord","HR-V","CR-V","Passport","Pilot","Ridgeline","Odyssey","Prologue"],
  Hyundai:["Venue","Kona","Kona Electric","Tucson","Santa Fe","Palisade","Elantra","Sonata","Santa Cruz","Ioniq 5","Ioniq 6","Ioniq 9"],
  Infiniti:["QX50","QX60","QX80"],
  Jaguar:["F-Pace","I-Pace"],
  Jeep:["Compass","Wrangler","Wrangler 4xe","Grand Cherokee","Grand Cherokee 4xe","Gladiator","Wagoneer","Grand Wagoneer","Wagoneer S","Recon"],
  Kia:["Soul","Seltos","Sportage","Sorento","Telluride","Forte","K5","Carnival","Niro","EV3","EV6","EV9"],
  Lamborghini:["Revuelto","Temerario","Urus SE"],
  "Land Rover":["Range Rover","Range Rover Sport","Range Rover Velar","Range Rover Evoque","Range Rover Electric","Defender","Discovery"],
  Lexus:["UX","NX","RX","TX","GX","ES","IS","RZ"],
  Lincoln:["Corsair","Nautilus","Aviator","Navigator"],
  Lotus:["Emira","Eletre","Emeya"],
  Maserati:["Grecale","GranTurismo","MC20"],
  Mazda:["Mazda3","CX-30","CX-5","CX-50","CX-70","CX-90","MX-5"],
  McLaren:["Artura","750S"],
  "Mercedes-Benz":["GLA","GLB","GLC","GLC EV","GLE","GLS","G-Class","C-Class","E-Class","EQB","EQE","EQS"],
  MINI:["Cooper","Countryman"],
  Mitsubishi:["RVR","Eclipse Cross","Outlander","Outlander PHEV"],
  Nissan:["Versa","Sentra","Altima","Kicks","Rogue","Murano","Pathfinder","Armada","Frontier","Titan","Leaf","Ariya"],
  Polestar:["Polestar 2","Polestar 3","Polestar 4"],
  Porsche:["Macan","Macan Electric","Cayenne","911","Panamera","Taycan"],
  Ram:["1500","1500 REV","Ramcharger","2500","3500","ProMaster"],
  Rivian:["R1T","R1S"],
  "Rolls-Royce":["Ghost","Phantom","Cullinan","Spectre"],
  Subaru:["Impreza","Crosstrek","Forester","Outback","Legacy","Ascent","WRX","BRZ","Solterra"],
  Tesla:["Model 3","Model Y","Model S","Model X","Cybertruck"],
  Toyota:["Corolla","Corolla Cross","Camry","Prius","RAV4","RAV4 Prime","Highlander","Grand Highlander","4Runner","Tacoma","Tundra","Sequoia","Sienna","C-HR","Crown","bZ","GR86","Supra"],
  Volkswagen:["Jetta","Golf GTI","Golf R","Taos","Tiguan","Atlas","Atlas Cross Sport","ID.4","ID.Buzz"],
  Volvo:["XC40","XC40 Recharge","XC60","XC90","S60","C40","EX30","EX90"],
};
const MAL_VEHICLES=Object.entries(MAL_VEHICLE_MAP).flatMap(([make,models])=>models.map((model)=>({label:`2027 ${make} ${model}`,make,model,year:2027})));

// Alberta municipalities that have new-car dealerships. Major metros first, then
// alphabetical, so a buyer can find their town. All province "AB".
const MAL_CITIES=(()=>{const c=[
  "Calgary","Edmonton","Red Deer","Lethbridge","Medicine Hat","Fort McMurray","Grande Prairie",
  "Airdrie","St. Albert","Sherwood Park","Spruce Grove","Leduc","Camrose","Lloydminster","Cochrane",
  "Okotoks","Fort Saskatchewan","Wetaskiwin","Lacombe","Sylvan Lake","Brooks","Cold Lake","Canmore",
  "High River","Stony Plain","Drayton Valley","Hinton","Edson","Whitecourt","Peace River","Drumheller",
  "Olds","Ponoka","Wainwright","Vegreville","Stettler","Rocky Mountain House","Bonnyville","Slave Lake",
  "Taber","Strathmore","Innisfail","Westlock","Barrhead","St. Paul","Vermilion","Claresholm","Pincher Creek",
  "Cardston","Provost",
];return c.map(city=>({label:`${city}, AB`,city,province:"AB"}));})();
const MAL_NAV=[["MSRP Price Index","/live-price-index"],["Alberta Dealers Map","/alberta"],["How it works","/#how"],["Sample report","/#report"],["What LotCheck does","/#what"],["MSRP Notifier","/msrp-alerts"],["Verify report","/verify"]];

function MsrpAlertsPage(){
  const [tilt,setTilt]=useState(23);
  const [dens,setDens]=useState(9);          // slider 0–20; density = dens/10
  const [veh,setVeh]=useState(0);
  const [city,setCity]=useState(0);
  const [email,setEmail]=useState("");
  const [thr,setThr]=useState("at_msrp");
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [emailed,setEmailed]=useState(false);   // did the confirmation email actually send?
  const [err,setErr]=useState("");

  const climate = dens<5?"Clear — near MSRP":dens<12?"Cloudy — small markup":"Stormy — over sticker";

  // Dark/bright toggle — shares the site-wide "lc-theme" key so it stays in sync
  // with Quote Check / the Price Index. Defaults to the OS preference.
  // Only "dark" is dark; light + outdoor both map to the bright theme, so landing
  // here from any Quote Check / Price Index mode reads consistently.
  const [theme,setTheme]=useState(()=>{ try{ const s=localStorage.getItem("lc-theme"); if(s==="dark")return "dark"; if(s==="light"||s==="outdoor")return "light"; return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"; }catch{ return "dark"; } });
  const toggleTheme=()=>{ const n=theme==="dark"?"light":"dark"; setTheme(n); try{ localStorage.setItem("lc-theme",n); }catch{} };
  const dark=theme==="dark";
  // Colors mirror the MSRP Price Index tokens exactly (dark: cosmic + #3ae0ff;
  // light: #f5f7fa bg, #0d8fb0 cyan, #141c28 ink) so the two pages never diverge.
  // Starry in both modes (cosmic scene). Dark = deep night; "light" = a lighter
  // blue-twilight sky — both keep white stars visible and light, readable text.
  const T = dark ? {
    pageBg:"radial-gradient(ellipse at bottom,#1b2735 0%,#090a0f 100%)", text:"#e7ecf3", soft:"#c7cee6", faint:"#8b95a6",
    navBg:"rgba(10,10,22,.55)", navBorder:"rgba(255,255,255,.08)", logoText:"#fff", link:"#b6b1d6",
    panelBg:"rgba(16,18,38,.6)", panelBorder:"rgba(150,170,255,.22)", panel2Bg:"rgba(16,18,38,.5)", panel2Border:"rgba(150,170,255,.2)",
    inputBg:"rgba(8,10,24,.6)", inputBorder:"rgba(150,170,255,.25)", segBg:"rgba(8,10,24,.5)", segBorder:"rgba(150,170,255,.2)",
    rangeTrack:"rgba(150,170,255,.25)", thumbBorder:"#071018", cyan:"#3ae0ff", heroGrad:"linear-gradient(100deg,#eaf0ff,#3ae0ff 55%,#b090ff)",
  } : {
    pageBg:"radial-gradient(ellipse at bottom,#26324f 0%,#0e1424 100%)", text:"#eef2fb", soft:"#c3cbe0", faint:"#8f99b4",
    navBg:"rgba(14,20,36,.55)", navBorder:"rgba(255,255,255,.08)", logoText:"#fff", link:"#c3cbe0",
    panelBg:"rgba(20,26,48,.58)", panelBorder:"rgba(150,170,255,.24)", panel2Bg:"rgba(20,26,48,.48)", panel2Border:"rgba(150,170,255,.2)",
    inputBg:"rgba(12,16,32,.55)", inputBorder:"rgba(150,170,255,.26)", segBg:"rgba(12,16,32,.5)", segBorder:"rgba(150,170,255,.2)",
    rangeTrack:"rgba(150,170,255,.25)", thumbBorder:"#0b1220", cyan:"#3ae0ff", heroGrad:"linear-gradient(100deg,#eaf0ff,#3ae0ff 55%,#b090ff)",
  };

  async function submit(){
    setErr("");
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())){ setErr("Enter a valid email so we can reach you."); return; }
    if(!consent){ setErr("Please tick the box so we're allowed to email you."); return; }
    setBusy(true);
    const v=MAL_VEHICLES[veh], c=MAL_CITIES[city];
    const body={ email:email.trim(), make:v.make, model:v.model, year:v.year,
      province:c.province, city:c.city, threshold:thr, pct:null, consent:true };
    // Preferred path: the alert-subscribe edge fn records the row AND sends the
    // CASL confirmation email. If it's unreachable, fall back to the anon RPC so
    // the signup is never lost — the buyer just won't get a confirm email (no SPOF).
    let ok=false, sentEmail=false;
    try{
      const {data,error}=await supabase.functions.invoke("alert-subscribe",{body});
      if(!error && data && data.ok){ ok=true; sentEmail=!!data.emailed; }
      else if(data && data.error){ setErr("Couldn't save that — "+data.error); }
    }catch(_){ /* fall through to RPC */ }
    if(!ok){
      const {error}=await supabase.rpc("fn_alert_subscribe",{
        p_email:email.trim(), p_make:v.make, p_model:v.model, p_year:v.year,
        p_province:c.province, p_city:c.city, p_threshold:thr, p_pct:null, p_consent:true,
      });
      if(!error){ ok=true; }
      else if(!err){ setErr("Couldn't save that — "+(error.message||"please try again.")); }
    }
    setBusy(false);
    if(ok){ setEmailed(sentEmail); setDone(true); setErr(""); }
  }

  const css=`
    .mal-hero h1{font-size:clamp(30px,5vw,52px);line-height:1.02;letter-spacing:-.02em;margin:14px 0 10px;font-weight:800;
      background:${T.heroGrad};-webkit-background-clip:text;background-clip:text;color:transparent}
    .mal select,.mal input[type=email]{width:100%;background:${T.inputBg};color:${T.text};border:1px solid ${T.inputBorder};
      border-radius:11px;padding:10px 11px;font:600 13px/1.1 inherit;outline:none;box-sizing:border-box}
    .mal select:focus,.mal input[type=email]:focus{border-color:${T.cyan}}
    .mal input[type=range]{-webkit-appearance:none;width:100%;height:4px;border-radius:3px;background:${T.rangeTrack};outline:none}
    .mal input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:${T.cyan};box-shadow:0 0 12px ${T.cyan};cursor:pointer;border:2px solid ${T.thumbBorder}}
    .mal-seg{display:flex;gap:6px}
    .mal-seg button{flex:1;background:${T.segBg};border:1px solid ${T.segBorder};color:${T.faint};border-radius:9px;padding:7px;font:700 11px inherit;cursor:pointer}
    .mal-seg button.on{border-color:${T.cyan};color:${T.cyan};background:${dark?"rgba(58,224,255,.08)":"rgba(14,138,168,.10)"}}
    .mal-col{scrollbar-width:none;-ms-overflow-style:none}
    .mal-col::-webkit-scrollbar{display:none}
    .mal-navlinks{scrollbar-width:none;-ms-overflow-style:none}
    .mal-navlinks::-webkit-scrollbar{display:none}
    @media(max-width:900px){.mal-panel{display:none!important}.mal-hero h1{font-size:34px}}
    @media(max-width:640px){.mal-col{position:static!important;transform:none!important;margin:78px auto 24px!important;width:min(400px,92vw)!important;max-height:none!important}}
    @media(max-height:780px){.mal-col{top:70px!important;transform:none!important}}
    .mal-stars{position:absolute;inset:0;overflow:hidden;z-index:0;pointer-events:none}
    .mal-star{position:absolute;top:0;left:0;background:transparent;animation-name:malStar;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}
    @keyframes malStar{from{transform:translateY(0)}to{transform:translateY(-2000px)}}
    @media(prefers-reduced-motion:reduce){.mal-star{animation:none}}`;

  // Generate the three star layers once (stable across re-renders) — a
  // box-shadow starfield scrolling upward behind the planet, in both themes.
  const [starLayers,setStarLayers]=useState([]);
  useEffect(()=>{
    let t;
    const build=()=>{
      // Cover the FULL current viewport width (TVs, wide monitors, browser
      // zoom-out). Density scales with width so phones stay light.
      const W=Math.max(window.innerWidth,document.documentElement.clientWidth,360);
      const gen=(n)=>{const a=[];const cnt=Math.max(1,Math.round(n*W/2000));for(let i=0;i<cnt;i++)a.push(`${Math.random()*W|0}px ${Math.random()*2000|0}px #fff`);return a.join(",");};
      setStarLayers([{sh:gen(600),sz:1,dur:"50s"},{sh:gen(220),sz:2,dur:"100s"},{sh:gen(90),sz:3,dur:"150s"}]);
    };
    build();
    const onR=()=>{clearTimeout(t);t=setTimeout(build,200);};  // rebuild on resize/zoom/rotate
    window.addEventListener("resize",onR);
    return ()=>{clearTimeout(t);window.removeEventListener("resize",onR);};
  },[]);

  return (
    <div style={{position:"relative",height:"100vh",overflow:"hidden",background:T.pageBg,fontFamily:"'Nunito',system-ui,-apple-system,sans-serif",color:T.text,transition:"background .4s ease,color .4s ease"}}>
      <style dangerouslySetInnerHTML={{__html:css}}/>
      <div className="mal-stars" aria-hidden="true">
        {starLayers.flatMap((L,i)=>[
          <div key={i+"a"} className="mal-star" style={{width:L.sz,height:L.sz,boxShadow:L.sh,animationDuration:L.dur}}/>,
          <div key={i+"b"} className="mal-star" style={{width:L.sz,height:L.sz,boxShadow:L.sh,animationDuration:L.dur,top:2000}}/>,
        ])}
      </div>
      <PlanetAlerts tilt={tilt} density={dens/10} theme={theme}/>

      <nav style={{position:"absolute",top:0,left:0,right:0,zIndex:20,background:T.navBg,backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderBottom:`1px solid ${T.navBorder}`}}>
        <div style={{maxWidth:1320,margin:"0 auto",padding:"11px clamp(16px,3vw,26px)",display:"flex",alignItems:"center",gap:14}}>
          <a href="/" style={{display:"flex",alignItems:"center",gap:9,textDecoration:"none",color:T.logoText,fontWeight:800,fontSize:"1.05rem"}}><SiteLogo size={45}/>LotCheck</a>
          <div className="mal-navlinks" style={{display:"flex",gap:14,marginLeft:"auto",alignItems:"center",flexWrap:"nowrap",overflowX:"auto"}}>
            {MAL_NAV.map(([label,href])=>{const active=label==="MSRP Notifier";return <a key={label} href={href} style={{fontSize:".9rem",fontWeight:active?800:600,color:active?T.cyan:T.link,textDecoration:"none",whiteSpace:"nowrap"}}>{label}</a>;})}
          </div>
          <button onClick={toggleTheme} aria-label={dark?"Switch to bright mode":"Switch to dark mode"} title={dark?"Bright mode":"Dark mode"} style={{background:"transparent",border:`1px solid ${T.navBorder}`,color:T.link,borderRadius:999,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,flexShrink:0}}>{dark?"☀":"☾"}</button>
          <a href="/quote-check" style={{background:"#2FA79A",color:"#fff",fontWeight:800,fontSize:".85rem",textDecoration:"none",padding:"8px 15px",borderRadius:10,whiteSpace:"nowrap"}}>Analyze my quote</a>
        </div>
      </nav>

      <div className="mal-col" style={{position:"absolute",left:"clamp(20px,4vw,48px)",top:"50%",transform:"translateY(-50%)",width:"min(400px,90vw)",maxHeight:"calc(100vh - 92px)",overflowY:"auto",zIndex:10,display:"flex",flexDirection:"column"}}>
      <div className="mal-hero" style={{marginBottom:16}}>
        <div style={{font:"800 11px/1 ui-monospace,Menlo,Consolas,monospace",letterSpacing:".32em",color:T.cyan,textTransform:"uppercase"}}>LotCheck · MSRP Alerts</div>
        <h1>The moment it's at MSRP, you'll know.</h1>
        <p style={{fontSize:15,lineHeight:1.6,color:T.soft,maxWidth:"36ch",margin:0}}>Pick your car and city. Join the waitlist — MSRP tracking launches in Alberta soon, and you'll be first in line.</p>
      </div>

      <div className="mal" style={{width:"100%",padding:18,borderRadius:20,boxSizing:"border-box",
        background:T.panelBg,border:`1px solid ${T.panelBorder}`,backdropFilter:"blur(16px)",WebkitBackdropFilter:"blur(16px)",boxShadow:dark?"0 20px 60px rgba(0,0,0,.5)":"0 20px 50px rgba(51,48,90,.14)"}}>
        {done ? (
          <div style={{textAlign:"center",padding:"6px 4px"}}>
            <div style={{fontSize:26,marginBottom:8,color:T.cyan}}>✦</div>
            <div style={{fontWeight:800,fontSize:16,marginBottom:8}}>{emailed?"Check your email to confirm.":"You're on the waitlist."}</div>
            <div style={{fontSize:13,color:T.soft,lineHeight:1.5}}>
              {emailed
                ? <>We sent a confirmation link for the {MAL_VEHICLES[veh].label.replace(/^\d+\s/,"")} in {MAL_CITIES[city].city}. Click it and you're set — that one click is what lets us email you. Live tracking rolls out across Alberta soon.</>
                : <>{MAL_VEHICLES[veh].label.replace(/^\d+\s/,"")} · {MAL_CITIES[city].city}. Live tracking isn't running there yet — we'll email you the moment it launches.</>}
            </div>
            <button onClick={()=>{setDone(false);setConsent(false);}} style={{marginTop:14,background:"none",border:`1px solid ${T.panelBorder}`,color:T.faint,borderRadius:10,padding:"8px 14px",font:"700 12px inherit",cursor:"pointer"}}>Add another car</button>
          </div>
        ) : (
          <>
            <div style={{marginBottom:11}}><label style={{font:"700 11px/1 inherit",letterSpacing:".06em",textTransform:"uppercase",color:T.faint,display:"block",marginBottom:5}}>Vehicle</label>
              <select value={veh} onChange={e=>setVeh(+e.target.value)}>{Object.keys(MAL_VEHICLE_MAP).map((mk)=>(
                <optgroup key={mk} label={mk}>{MAL_VEHICLES.map((v,i)=>v.make===mk?<option key={i} value={i}>{v.model}</option>:null)}</optgroup>
              ))}</select></div>
            <div style={{display:"flex",gap:8,marginBottom:11}}>
              <div style={{flex:1}}><label style={{font:"700 11px/1 inherit",letterSpacing:".06em",textTransform:"uppercase",color:T.faint,display:"block",marginBottom:5}}>City</label>
                <select value={city} onChange={e=>setCity(+e.target.value)}>{MAL_CITIES.map((c,i)=><option key={i} value={i}>{c.label}</option>)}</select></div>
            </div>
            <div style={{marginBottom:11}}><label style={{font:"700 11px/1 inherit",letterSpacing:".06em",textTransform:"uppercase",color:T.faint,display:"block",marginBottom:5}}>Alert me when it's</label>
              <div className="mal-seg">
                <button className={thr==="at_msrp"?"on":""} onClick={()=>setThr("at_msrp")}>At MSRP</button>
                <button className={thr==="below_msrp"?"on":""} onClick={()=>setThr("below_msrp")}>Below MSRP</button>
              </div></div>
            <div style={{marginBottom:12}}><label style={{font:"700 11px/1 inherit",letterSpacing:".06em",textTransform:"uppercase",color:T.faint,display:"block",marginBottom:5}}>Email</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com"/></div>
            <label style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:11.5,color:T.faint,lineHeight:1.4,cursor:"pointer",marginBottom:12}}>
              <input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} style={{marginTop:2,accentColor:T.cyan}}/>
              <span>Email me when MSRP tracking launches for this car in my city. I can unsubscribe anytime. No spam.</span></label>
            {err && <div style={{fontSize:12,color:"#e05a3c",marginBottom:9}}>{err}</div>}
            <button onClick={submit} disabled={busy} style={{width:"100%",border:"none",borderRadius:12,padding:12,font:"800 14px inherit",color:"#04121a",cursor:busy?"default":"pointer",opacity:busy?.7:1,
              background:"linear-gradient(100deg,#3ae0ff,#b090ff)",boxShadow:"0 8px 26px rgba(58,224,255,.35)"}}>{busy?"Joining…":"Notify me when it hits MSRP"}</button>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:11}}>
              <span style={{font:"800 9.5px/1 ui-monospace,monospace",letterSpacing:".08em",textTransform:"uppercase",color:T.cyan,border:`1px solid ${T.cyan}`,borderRadius:999,padding:"5px 8px"}}>Waitlist</span>
              <small style={{fontSize:11.5,color:T.faint,lineHeight:1.4}}>Live price tracking isn't running yet — join to be first when it launches in Alberta.</small>
            </div>
          </>
        )}
      </div>
      </div>

      <div style={{position:"absolute",left:0,right:0,bottom:8,textAlign:"center",fontSize:11,color:T.faint,letterSpacing:".4px",zIndex:5,pointerEvents:"none"}}>drag to orbit · scroll to zoom</div>
    </div>
  );
}

// The CASL double-opt-in landing page. The confirmation email links here with
// ?token=<uuid>; we call fn_alert_confirm (anon; the token IS the auth) which
// flips the row 'waitlist' -> 'confirmed'. Only confirmed rows are ever alerted.
function AlertConfirmPage(){
  const [state,setState]=useState("working");   // working | ok | bad
  const [veh,setVeh]=useState("");
  useEffect(()=>{
    const token=new URLSearchParams(window.location.search).get("token");
    if(!token){ setState("bad"); return; }
    (async()=>{
      const {data,error}=await supabase.rpc("fn_alert_confirm",{p_token:token});
      if(!error && data && data.ok){
        setVeh([data.make,data.model].filter(Boolean).join(" ")+(data.city?" · "+data.city:""));
        setState("ok");
      }else setState("bad");
    })();
  },[]);
  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:24,
      background:"radial-gradient(120% 90% at 72% 25%,#141238 0%,#080a1c 55%,#05060f 100%)",fontFamily:"'Nunito',system-ui,sans-serif",color:"#eaf0ff"}}>
      <div style={{maxWidth:440,textAlign:"center",background:"rgba(16,18,38,.6)",border:"1px solid rgba(150,170,255,.22)",borderRadius:20,padding:"34px 28px",backdropFilter:"blur(16px)"}}>
        <div style={{font:"800 11px/1 ui-monospace,monospace",letterSpacing:".32em",color:"#3ae0ff",textTransform:"uppercase",marginBottom:14}}>LotCheck · MSRP Alerts</div>
        {state==="working" && <div style={{fontSize:15,color:"#c7cee6"}}>Confirming…</div>}
        {state==="ok" && <>
          <div style={{fontSize:34,marginBottom:10}}>✦</div>
          <h1 style={{fontSize:24,fontWeight:800,margin:"0 0 10px"}}>You're confirmed.</h1>
          <p style={{fontSize:14.5,lineHeight:1.6,color:"#c7cee6",margin:"0 0 8px"}}>{veh?<>We'll email you when a <b style={{color:"#fff"}}>{veh}</b> is offered at or below MSRP.</>:"Your MSRP alert is active."}</p>
          <p style={{fontSize:12.5,color:"#8a92b4",margin:"0 0 20px"}}>Live tracking is rolling out city by city in Alberta — you're in line.</p>
          <a href="/quote-check" style={{display:"inline-block",background:"linear-gradient(100deg,#3ae0ff,#b090ff)",color:"#04121a",fontWeight:800,fontSize:14,textDecoration:"none",padding:"12px 24px",borderRadius:12}}>Check a quote now →</a>
        </>}
        {state==="bad" && <>
          <div style={{fontSize:34,marginBottom:10}}>⚠️</div>
          <h1 style={{fontSize:22,fontWeight:800,margin:"0 0 10px"}}>That link didn't work.</h1>
          <p style={{fontSize:14,lineHeight:1.6,color:"#c7cee6",margin:"0 0 20px"}}>The confirmation link may have expired or already been used. You can sign up again in a moment.</p>
          <a href="/msrp-alerts" style={{display:"inline-block",background:"linear-gradient(100deg,#3ae0ff,#b090ff)",color:"#04121a",fontWeight:800,fontSize:14,textDecoration:"none",padding:"12px 24px",borderRadius:12}}>Back to MSRP Alerts</a>
        </>}
      </div>
    </div>
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
      {path.startsWith("/founders") ? <FoundersPanel/>
        : path.startsWith("/admin") ? <AdminPanel/>
        : path.startsWith("/verify") ? <VerifyPage/>
        : path.startsWith("/real") ? <TrustPage/>
        : path.startsWith("/quote-check") ? <QuoteCheckPage/>
        : path.startsWith("/alert-confirm") ? <AlertConfirmPage/>
        : path.startsWith("/msrp-alerts") ? <MsrpAlertsPage/>
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
            <LogoMark size={48}/>
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
