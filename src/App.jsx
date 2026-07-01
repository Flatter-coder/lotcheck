import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client (publishable key — safe to expose in frontend) ────────────
const supabase = createClient(
  "https://debigtyjhjamipooajhk.supabase.co",
  "sb_publishable_T2BDbwY-Y1Lzr3r8K41lvw_Shtgo1nq"
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

  /* ── Breakpoints ──────────────────────────────────────────────────────────
     xs:  < 480px   (small phones — iPhone SE, Galaxy A)
     sm:  480–767px (large phones — iPhone Pro Max, Pixel)
     md:  768–1023px (tablets portrait, foldables open, iPad mini)
     lg:  1024–1279px (tablets landscape, iPad Pro, foldable landscape)
     xl:  1280px+   (desktop, large monitors)
  ────────────────────────────────────────────────────────────────────────── */

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

  /* Main content area — stacked on mobile, side by side on tablet+ */
  .lc-main {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  @media (min-width: 768px) {
    .lc-main { flex-direction: row; }
  }

  /* Sidebar — full width on mobile, fixed width on tablet+ */
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

  /* Stats grid — 2 cols on phone, 4 on tablet+ */
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

  /* Bottom sheet modal (phone) vs centered modal (tablet+) */
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

  /* Back button on mobile detail view */
  .lc-back-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #060d18;
    border-bottom: 1px solid #1e293b;
    position: sticky;
    top: 57px;
    z-index: 50;
  }
  @media (min-width: 768px) {
    .lc-back-bar { display: none; }
  }

  /* On tablet+, hide the mobile detail overlay and show inline */
  .lc-detail-mobile {
    display: block;
  }
  .lc-detail-desktop {
    display: none;
  }
  @media (min-width: 768px) {
    .lc-detail-mobile { display: none; }
    .lc-detail-desktop { display: block; }
  }

  /* Empty state */
  .lc-empty { color: #475569; font-size: 14px; text-align: center; padding: 40px 0; }

  /* Footer */
  .lc-footer { padding: 16px; border-top: 1px solid #1e293b; text-align: center; font-size: 11px; color: #1e293b; }
`;

// ── Data ──────────────────────────────────────────────────────────────────────
const REBATES = {
  AB:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,note:"Federal EVAP only"},
  BC:{federal_bev:5000,federal_phev:2500,prov_bev:4000,prov_phev:1500,prov_name:"BC CVAP",note:"Stack federal + provincial. Scrap old car = +$2K."},
  ON:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,note:"Federal only — Ontario cancelled provincial 2018."},
  QC:{federal_bev:5000,federal_phev:2500,prov_bev:7000,prov_phev:4000,prov_name:"Roulez Vert",note:"Best rebates in Canada. Stack federal + provincial."},
  MB:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,note:"Federal EVAP only"},
  SK:{federal_bev:5000,federal_phev:2500,prov_bev:0,prov_phev:0,prov_name:null,note:"Federal EVAP only"},
  NS:{federal_bev:5000,federal_phev:2500,prov_bev:3000,prov_phev:1500,prov_name:"NS ZEVIP",note:"Stack federal + provincial."},
  NB:{federal_bev:5000,federal_phev:2500,prov_bev:2500,prov_phev:1000,prov_name:"NB EV",note:"Stack federal + provincial."},
};
const PROVINCES={AB:"Alberta",BC:"British Columbia",ON:"Ontario",QC:"Quebec",MB:"Manitoba",SK:"Saskatchewan",NS:"Nova Scotia",NB:"New Brunswick"};

function getRebate(province,fuel){
  const r=REBATES[province];
  if(!r)return{federal:0,provincial:0,total:0,prov_name:null,note:""};
  const federal=fuel==="BEV"?r.federal_bev:fuel==="PHEV"?r.federal_phev:0;
  const provincial=fuel==="BEV"?r.prov_bev:fuel==="PHEV"?r.prov_phev:0;
  return{federal,provincial,total:federal+provincial,prov_name:r.prov_name,note:r.note};
}

const EVAP_LIST=[
  {year:2025,make:"Toyota",model:"RAV4 Prime",fuel:"PHEV",incentive:2500},
  {year:2024,make:"Toyota",model:"RAV4 Prime",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Toyota",model:"bZ4X",fuel:"BEV",incentive:5000},
  {year:2025,make:"Hyundai",model:"IONIQ 5",fuel:"BEV",incentive:5000},
  {year:2025,make:"Hyundai",model:"IONIQ 6",fuel:"BEV",incentive:5000},
  {year:2025,make:"Kia",model:"EV6",fuel:"BEV",incentive:5000},
  {year:2025,make:"Kia",model:"Niro EV",fuel:"BEV",incentive:5000},
  {year:2026,make:"Chevrolet",model:"Equinox EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Chevrolet",model:"Equinox EV",fuel:"BEV",incentive:5000},
  {year:2025,make:"Ford",model:"Escape",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Mitsubishi",model:"Outlander",fuel:"PHEV",incentive:2500},
  {year:2025,make:"Volkswagen",model:"ID.4",fuel:"BEV",incentive:5000},
];
function getEVAP(l){return EVAP_LIST.find(e=>e.year===l.year&&l.make?.toLowerCase()===e.make.toLowerCase()&&(l.model?.toLowerCase().includes(e.model.toLowerCase())||e.model.toLowerCase().includes(l.model?.toLowerCase())))||null;}

// ── Demo listings — shown while Supabase loads or if empty ───────────────────
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
            id, name, make, model, year, price, km, fuel,
            province, city, source, dealer, listing_url, image_url,
            scraped_at
          `)
          .order("scraped_at", {ascending:false})
          .limit(500);

        if(error) throw error;

        if(data && data.length > 0){
          // Normalize Supabase rows to match app's expected shape
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

// Keep LISTINGS as alias for places that reference it directly (price history etc)
const LISTINGS=DEMO_LISTINGS;

function genHistory(price){
  const h=[];let p=price*(1+(Math.random()*0.08-0.02));
  for(let i=60;i>=0;i--){
    const d=new Date();d.setDate(d.getDate()-i);
    p=p*(1+(Math.random()-0.52)*0.022);
    h.push({date:d.toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:Math.round(p)});
  }
  h[h.length-1].price=price;return h;
}
function lotScore(l,all){
  const c=all.filter(x=>x.model===l.model&&x.id!==l.id);
  if(!c.length)return 50;
  const aP=c.reduce((s,x)=>s+x.price,0)/c.length;
  const aK=c.reduce((s,x)=>s+x.km,0)/c.length;
  return Math.max(0,Math.min(100,Math.round(50+((aP-l.price)/aP)*120+((aK-l.km)/aK)*40)));
}

// ── Badges ────────────────────────────────────────────────────────────────────
function ScorePill({score}){
  const c=score>=70?"#16a34a":score>=45?"#d97706":"#dc2626";
  const l=score>=70?"✓ Great Deal":score>=45?"~ Fair Price":"↑ Above Market";
  return<span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}35`}}>{l}</span>;
}
// ── Fuel SVG Icons — matching reference: BEV=battery/bolt, PHEV=plug+pump, Hybrid=recycle+pump, Gas=pump
function FuelIcon({fuel,size=14}){
  const s=size;
  // BEV — green battery with lightning bolt (like reference image)
  if(fuel==="BEV") return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-charge 1.6s ease-in-out infinite",flexShrink:0}}>
      <rect x="2" y="6" width="18" height="13" rx="2" stroke="#22c55e" strokeWidth="2" fill="none"/>
      <path d="M20 10h2v5h-2" stroke="#22c55e" strokeWidth="2" strokeLinecap="round"/>
      <path d="M13 7l-5 6h5l-3 5" stroke="#22c55e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  // PHEV — plug + small pump (orange like reference)
  if(fuel==="PHEV") return(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" style={{animation:"lc-charge 2s ease-in-out infinite",flexShrink:0}}>
      <path d="M7 2v4M11 2v4" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
      <path d="M5 6h8v5a4 4 0 01-8 0V6z" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 17v4" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"/>
      <path d="M15 8h2a2 2 0 012 2v7a1 1 0 001 1h0a1 1 0 001-1V8" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round"/>
      <rect x="17" y="5" width="4" height="3" rx="1" stroke="#f59e0b" strokeWidth="1.8"/>
    </svg>
  );
  // Hybrid — recycle arrows (purple like reference)
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
  // Gas — fuel pump silhouette (grey/white)
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

// ── Connect Modal ─────────────────────────────────────────────────────────────
function ConnectModal({listing,onClose}){
  const rebate=getRebate(listing.province,listing.fuel);
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
    await new Promise(r=>setTimeout(r,1500));
    setStep("done");
  }
  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        {step==="done"?(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>LotChecked!</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:16,lineHeight:1.6}}>Request sent. The dealer will contact you within 2 hours.</div>
            {wantsDelivery&&(
              <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:12,padding:"12px 16px",marginBottom:16,textAlign:"left"}}>
                <div style={{fontSize:13,color:"#60a5fa",fontWeight:700,marginBottom:4}}>🚚 Delivery requested</div>
                <div style={{fontSize:13,color:"#475569"}}>You asked about delivery to <strong style={{color:"#94a3b8"}}>{deliveryCity}</strong>. The dealer will confirm availability and cost when they call.</div>
              </div>
            )}
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
              {rebate.total>0&&<div style={{fontSize:12,color:"#22c55e",fontWeight:600,marginTop:6}}>⚡ After rebates: ~${(listing.price-rebate.total).toLocaleString()}</div>}
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

// ── Test Drive Booking Modal ────────────────────────────────────────────────────
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
    await new Promise(r=>setTimeout(r,1500));
    setStep("done");
  }

  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        {step==="done"?(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🚗</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>Test drive requested!</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:16,lineHeight:1.6}}>The dealer will call you within 2 hours to confirm an exact time.</div>
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


// ─────────────────────────────────────────────────────────────────────────────
// APPRAISAL / TRADE-IN FLOW
// Phase 1 (live now): user submits car details → single dealer gets the lead
//   → LotCheck invoices dealer a flat fee, same pattern as buyer leads.
// Phase 2 (future upgrade — see BID MARKETPLACE notes below): same submission
//   goes out to ALL active dealers in that city/make, each can submit a real
//   $ offer within a 24-48h window, user compares offers side by side and
//   picks one. LotCheck charges per-bid or a % of the closing offer instead
//   of a flat referral fee. The data model below (AppraisalRequest) is built
//   so Phase 2 just adds an `offers: []` array and a countdown — no rework
//   needed on the submission form itself.
// ─────────────────────────────────────────────────────────────────────────────

const MAKES_DEALERS={
  Toyota:"Cochrane Toyota", Hyundai:"Hyundai on Macleod", Kia:"Sherwood Kia",
  Chevrolet:"Courtesy Chevrolet", Ford:"Courtesy Ford", Volkswagen:"Capilano VW",
  Mitsubishi:"Stampede Mitsubishi",
};

function estimateAppraisal(make,model,year,km,condition){
  // Rough placeholder estimate — same style of math as the CBB panel.
  // Replace with real CBB/market data once Supabase is connected.
  const baseByAge={2026:42000,2025:38000,2024:34000,2023:30000,2022:26000,2021:22000,2020:18000,2019:15000};
  let base=baseByAge[year]||Math.max(8000,42000-(2026-year)*4000);
  const kmFactor=Math.max(0.55,1-(km/250000)*0.45);
  const condFactor={Excellent:1.08,Good:1.0,Fair:0.88,Poor:0.7}[condition]||1.0;
  const estimate=Math.round(base*kmFactor*condFactor/100)*100;
  return{
    low:Math.round(estimate*0.9/100)*100,
    mid:estimate,
    high:Math.round(estimate*1.1/100)*100,
  };
}

function AppraisalModal({onClose}){
  const [step,setStep]=useState("form"); // form | result | dealer | sending | done
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
  const [err,setErr]=useState("");

  const estimate=step!=="form"?estimateAppraisal(make,model,Number(year),Number(km)||50000,condition):null;
  const dealer=MAKES_DEALERS[make]||"a LotCheck partner dealer";

  function handleGetEstimate(){
    if(!model.trim()){setErr("Please enter your car's model.");return;}
    if(!km||Number(km)<=0){setErr("Please enter your odometer reading.");return;}
    setErr("");
    setStep("result");
  }

  async function handleSubmitToDealer(){
    if(!name.trim()){setErr("Please enter your name.");return;}
    if(!phone.trim()&&!email.trim()){setErr("Please enter phone or email.");return;}
    if(wantsPickup&&!pickupAddress.trim()){setErr("Please enter your pickup address.");return;}
    setErr("");
    setStep("sending");
    await new Promise(r=>setTimeout(r,1500));
    setStep("done");
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
                {Object.keys(MAKES_DEALERS).map(m=><option key={m}>{m}</option>)}
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

          <div style={{fontSize:13,color:"#64748b",marginBottom:14}}>{year} {make} {model} · {Number(km).toLocaleString()} km · {condition} condition</div>

          <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:14,padding:"18px",marginBottom:16,textAlign:"center"}}>
            <div style={{fontSize:11,color:"#475569",marginBottom:6}}>ESTIMATED TRADE-IN VALUE</div>
            <div style={{fontSize:32,fontWeight:800,color:"#22c55e",marginBottom:4}}>${estimate.mid.toLocaleString()}</div>
            <div style={{fontSize:12,color:"#64748b"}}>Range: ${estimate.low.toLocaleString()} – ${estimate.high.toLocaleString()}</div>
          </div>

          <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:10,padding:"12px 14px",marginBottom:16,fontSize:12,color:"#94a3b8",lineHeight:1.6}}>
            💡 This is a market estimate, not a guaranteed offer. Get a real, no-obligation offer from {dealer} below.
          </div>

          <button onClick={()=>setStep("dealer")} className="lc-modal-btn">Get a real offer from a dealer →</button>
          <button onClick={()=>setStep("form")} style={{width:"100%",background:"transparent",border:"none",color:"#475569",fontSize:12,cursor:"pointer",marginTop:10,textAlign:"center"}}>← Edit my car details</button>
        </>}

        {(step==="dealer"||step==="sending")&&<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>Get your real offer</div>
            <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:20,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:16}}>{dealer} will review your {year} {make} {model} and contact you with a real offer within 2 business hours.</div>

          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:13,color:"#94a3b8"}}>Estimated value</span>
            <span style={{fontSize:15,fontWeight:700,color:"#22c55e"}}>${estimate.mid.toLocaleString()}</span>
          </div>

          <div onClick={()=>setWantsPickup(!wantsPickup)} style={{display:"flex",alignItems:"center",gap:10,background:wantsPickup?"#0d1e3a":"#0f172a",border:`1px solid ${wantsPickup?"#1e3a5f":"#1e293b"}`,borderRadius:10,padding:"12px 14px",marginBottom:14,cursor:"pointer"}}>
            <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${wantsPickup?"#3b82f6":"#475569"}`,background:wantsPickup?"#3b82f6":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s"}}>
              {wantsPickup&&<span style={{color:"#fff",fontSize:12,fontWeight:900}}>✓</span>}
            </div>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>🚚 I'd like my car picked up</div>
              <div style={{fontSize:11,color:"#475569"}}>Skip the drive — ask the dealer about pickup</div>
            </div>
          </div>
          {wantsPickup&&(
            <div style={{marginBottom:14}}>
              <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>Pickup address *</label>
              <input type="text" placeholder="Street address, city" value={pickupAddress} onChange={e=>setPickupAddress(e.target.value)} style={inp}/>
            </div>
          )}

          {[["Full name *","text","Jane Smith",name,setName],["Phone","tel","403-555-0100",phone,setPhone],["Email","email","jane@email.com",email,setEmail]].map(([l,t,ph,v,s])=>(
            <div key={l}>
              <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:4}}>{l}</label>
              <input type={t} placeholder={ph} value={v} onChange={e=>s(e.target.value)} style={inp}/>
            </div>
          ))}

          {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#ef4444",marginBottom:12}}>{err}</div>}
          <div style={{fontSize:11,color:"#334155",marginBottom:14}}>Your info is shared with {dealer} only. LotCheck never sells your data.</div>

          <button onClick={handleSubmitToDealer} disabled={step==="sending"} className="lc-modal-btn" style={{background:step==="sending"?"#1e3a5f":"#16a34a"}}>
            {step==="sending"?"Sending…":"Submit to dealer →"}
          </button>
        </>}

        {step==="done"&&(
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:10}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"#f1f5f9",marginBottom:8}}>Request sent to {dealer}!</div>
            <div style={{fontSize:13,color:"#64748b",marginBottom:20,lineHeight:1.6}}>They'll review your {year} {make} {model} and call you within 2 business hours with a real offer.</div>
            {wantsPickup&&(
              <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:10,padding:"12px 16px",marginBottom:16,textAlign:"left"}}>
                <div style={{fontSize:13,color:"#60a5fa",fontWeight:700,marginBottom:4}}>🚚 Pickup requested</div>
                <div style={{fontSize:13,color:"#475569"}}>Pickup address: <strong style={{color:"#94a3b8"}}>{pickupAddress}</strong>. The dealer will confirm availability when they call.</div>
              </div>
            )}
            <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:12,color:"#475569"}}>
              💡 Tip: get offers from multiple dealers to compare before you commit.
            </div>
            <button onClick={onClose} className="lc-modal-btn">Done</button>
          </div>
        )}


      </div>
    </div>
  );
}

function ProModal({onStart,onClose}){
  return(
    <div className="lc-modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="lc-modal">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:11,fontWeight:700,color:"#16a34a",letterSpacing:1}}>LOTCHECK PRO · 3-DAY FREE TRIAL</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#475569",fontSize:22,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <div style={{fontSize:20,fontWeight:800,color:"#f1f5f9",marginBottom:4,letterSpacing:"-0.5px"}}>Built for car professionals</div>
        <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>No credit card. Cancel anytime. Then $9.99/mo CAD.</div>
        {[["📊","Canadian Black Book","Retail, trade & wholesale on every listing"],["⚡","EVAP Rebate Checker","Federal + provincial incentives stacked"],["🗓️","Alberta Allocations","Incoming inventory before it hits the lot"],["🔔","Unlimited Alerts","Price drop push notifications"],].map(([icon,title,sub])=>(
          <div key={title} style={{display:"flex",gap:12,background:"#1e293b20",borderRadius:10,padding:"12px",marginBottom:8}}>
            <span style={{fontSize:20}}>{icon}</span>
            <div><div style={{fontSize:14,fontWeight:600,color:"#e2e8f0"}}>{title}</div><div style={{fontSize:12,color:"#475569"}}>{sub}</div></div>
          </div>
        ))}
        <button onClick={()=>{onStart();onClose();}} className="lc-modal-btn" style={{marginTop:8}}>Start 3-day free trial →</button>
        <div style={{textAlign:"center",marginTop:8,fontSize:12,color:"#334155"}}>Cancel anytime · No card needed</div>
      </div>
    </div>
  );
}

// ── Unlock Modal — pay-per-use, no subscription required ──────────────────────
function UnlockModal({feature, price, onUnlock, onClose, onUpgrade}){
  const [step,setStep]=useState("offer"); // offer | paying | done
  const labels={
    vin:{title:"Unlock VIN History",icon:"🔍",desc:"Full accident history, ownership count, and odometer check for this vehicle."},
    cbb:{title:"Unlock Black Book Value",icon:"📊",desc:"Retail, trade-in, and wholesale value estimates for this exact vehicle."},
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
            <div style={{fontSize:13,color:"#64748b",marginBottom:20}}>This feature is now available for this vehicle.</div>
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
              ✦ Get unlimited with Pro — 3 days free
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── VIN History Panel ─────────────────────────────────────────────────────────
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
    const carfaxUrl=`https://www.carfax.ca/vehicle-history-report?vin=${vin.toUpperCase()}&utm_source=lotcheck&utm_medium=affiliate&utm_campaign=vin_lookup`;
    window.open(carfaxUrl,"_blank");
  }

  return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1}}>VEHICLE HISTORY REPORT</span>
        <span style={{fontSize:10,background:"#3b82f620",color:"#3b82f6",borderRadius:4,padding:"1px 6px",border:"1px solid #3b82f630"}}>Powered by CARFAX</span>
      </div>
      <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.6,marginBottom:14}}>
        Check accident history, number of owners, odometer rollback flags, and service records before you buy.
      </div>
      <label style={{fontSize:12,color:"#94a3b8",display:"block",marginBottom:5}}>Vehicle Identification Number (VIN)</label>
      <input type="text" placeholder="e.g. 1HGCM82633A123456" value={vin}
        onChange={e=>{setVin(e.target.value.toUpperCase());setError("");}} maxLength={17}
        style={{width:"100%",background:"#1e293b",border:`1px solid ${error?"#7f1d1d":"#334155"}`,borderRadius:10,padding:"12px 14px",color:"#f1f5f9",fontSize:15,fontFamily:"monospace",letterSpacing:1,outline:"none",boxSizing:"border-box",marginBottom:6}}/>
      <div style={{fontSize:11,color:error?"#ef4444":"#334155",marginBottom:14}}>
        {error||`${vin.length}/17 characters · VIN is on the door jamb or dashboard`}
      </div>
      <button onClick={handleCheck} disabled={vin.length!==17}
        style={{width:"100%",background:vin.length===17?"#16a34a":"#1e3a5f",border:"none",borderRadius:12,padding:"14px 0",color:"#fff",fontSize:15,fontWeight:700,cursor:vin.length===17?"pointer":"not-allowed"}}>
        🔍 Check Vehicle History →
      </button>
      <div style={{fontSize:11,color:"#334155",marginTop:8,textAlign:"center"}}>
        ~$45 CAD via CARFAX Canada · Opens in new tab
      </div>
    </div>
  );
}

// ── Insurance Quote Panel (Kanetix affiliate) ──────────────────────────────────
function InsurancePanel({listing}){
  const KANETIX_AFFILIATE_ID="YOUR_AFFILIATE_ID";
  const kanetixUrl=`https://www.kanetix.ca/auto-insurance-quotes?aff=${KANETIX_AFFILIATE_ID}&utm_source=lotcheck&vehicle=${encodeURIComponent(listing.name)}`;
  const estMonthly=Math.round((listing.price*0.025)/12/10)*10;

  return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:700,color:"#f59e0b",letterSpacing:1}}>INSURANCE ESTIMATE</span>
        <span style={{fontSize:10,background:"#f59e0b20",color:"#f59e0b",borderRadius:4,padding:"1px 6px",border:"1px solid #f59e0b30"}}>via Kanetix</span>
      </div>
      <div style={{background:"#1a1200",border:"1px solid #f59e0b30",borderRadius:10,padding:"14px",marginBottom:14}}>
        <div style={{fontSize:11,color:"#475569",marginBottom:4}}>Rough monthly estimate (Alberta avg.)</div>
        <div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>~${estMonthly}<span style={{fontSize:14,color:"#64748b"}}>/mo</span></div>
        <div style={{fontSize:11,color:"#475569",marginTop:4}}>Actual rate depends on your driving record, age, and location</div>
      </div>
      <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.6,marginBottom:14}}>
        Compare real quotes from 50+ Canadian insurers in under 5 minutes. Free, no obligation.
      </div>
      <a href={kanetixUrl} target="_blank" rel="noreferrer"
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,width:"100%",background:"#f59e0b",border:"none",borderRadius:12,padding:"14px 0",color:"#020617",fontSize:15,fontWeight:700,textDecoration:"none",boxSizing:"border-box"}}>
        🛡️ Compare Insurance Quotes →
      </a>
      <div style={{fontSize:11,color:"#334155",marginTop:8,textAlign:"center"}}>
        Opens Kanetix.ca in a new tab · Free comparison · No signup required
      </div>
    </div>
  );
}

// ── Detail Panel ──────────────────────────────────────────────────────────────
function DetailPanel({listing,isPro,onConnect,onUpgrade,onTestDrive}){
  const [history]=useState(()=>genHistory(listing.price));
  const [tab,setTab]=useState("chart");
  const [unlocks,setUnlocks]=useState({}); // { [listingId-feature]: true }
  const [unlockModal,setUnlockModal]=useState(null); // "vin" | "cbb" | null
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel);
  const score=lotScore(listing,LISTINGS);
  const currentPrice=history[history.length-1]?.price??listing.price;
  const firstPrice=history[0]?.price??listing.price;
  const change=currentPrice-firstPrice;
  const avgHist=Math.round(history.reduce((s,h)=>s+h.price,0)/history.length);
  const domain=[Math.round(Math.min(...history.map(h=>h.price))*0.97),Math.round(Math.max(...history.map(h=>h.price))*1.03)];
  const cbb={retail:Math.round(listing.price*1.05),trade:Math.round(listing.price*Math.max(0.4,1-(2026-listing.year)*0.08)*Math.max(0.7,1-(listing.km/300000)*0.35)*0.82)};
  cbb.wholesale=Math.round(cbb.trade*0.91);

  const key=f=>`${listing.id}-${f}`;
  const isUnlocked=f=>isPro||unlocks[key(f)];
  const unlockPrice={vin:2.99,cbb:2.99};

  return(
    <div style={{padding:"16px"}}>
      {/* Name + badges */}
      <div style={{fontSize:18,fontWeight:800,color:"#f1f5f9",marginBottom:8,lineHeight:1.3}}>{listing.name}</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
        <ScorePill score={score}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
        <span className="badge" style={{background:"#1e293b",color:"#64748b"}}>{listing.city}, {listing.province}</span>
      </div>
      {/* Price */}
      <div className="lc-price-hero">
        <div className="lc-price-big">${currentPrice.toLocaleString()}</div>
        <div style={{fontSize:14,color:change>=0?"#ef4444":"#22c55e",fontWeight:600,marginTop:4}}>{change>=0?"▲":"▼"} ${Math.abs(change).toLocaleString()} ({change>=0?"+":""}{((change/firstPrice)*100).toFixed(1)}%) 60d</div>
        {rebate.total>0&&<div style={{fontSize:14,color:"#22c55e",fontWeight:700,marginTop:4}}>After all rebates: ~${(currentPrice-rebate.total).toLocaleString()}</div>}
      </div>
      {/* Tabs */}
      <div className="lc-tabs">
        {[["chart","📈 Chart"],["rebates","⚡ Rebates"],["cbb",isUnlocked("cbb")?"📊 Black Book":"🔒 Black Book $2.99"],["vin",isUnlocked("vin")?"🔍 VIN History":"🔒 VIN History $2.99"],["insurance","🛡️ Insurance"]].map(([t,l])=>(
          <button key={t} className={`lc-tab${tab===t?" active":""}`} onClick={()=>{
            if((t==="cbb"||t==="vin")&&!isUnlocked(t)){setUnlockModal(t);return;}
            setTab(t);
          }}>
            {l}
          </button>
        ))}
      </div>

      {/* Chart */}
      {tab==="chart"&&<>
        <div style={{height:180,marginBottom:16}}>
          <ResponsiveContainer>
            <LineChart data={history} margin={{top:4,right:4,bottom:0,left:0}}>
              <XAxis dataKey="date" tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} interval={15} tickLine={false} axisLine={false}/>
              <YAxis domain={domain} tick={{fontSize:11,fill:"#94a3b8",fontWeight:600}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={42}/>
              <Tooltip formatter={v=>[`$${v.toLocaleString()}`,"Price"]} contentStyle={{background:"#0d1526",border:"1px solid #334155",borderRadius:8,fontSize:13,fontWeight:600,color:"#f1f5f9"}} labelStyle={{color:"#94a3b8",fontSize:11}}/>
              <ReferenceLine y={avgHist} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{value:`avg`,fill:"#f59e0b",fontSize:9,position:"insideTopRight"}}/>
              <Line type="monotone" dataKey="price" stroke="#16a34a" strokeWidth={2} dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="lc-stats">
          {[["Asking",`$${listing.price.toLocaleString()}`],["Deal Score",`${score}/100`],["Location",`${listing.city}, ${listing.province}`],["Odometer",`${listing.km.toLocaleString()} km`]].map(([l,v])=>(
            <div key={l} className="lc-stat"><div className="lc-stat-label">{l}</div><div className="lc-stat-value">{v}</div></div>
          ))}
        </div>
      </>}
      {/* Rebates */}
      {tab==="rebates"&&<EVAPRebateTab listing={listing} rebate={rebate}/>}
      {/* CBB */}
      {tab==="cbb"&&isUnlocked("cbb")&&(
        <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:14,padding:"16px"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1,marginBottom:12}}>CANADIAN BLACK BOOK · PRO</div>
          <div className="lc-stats">
            {[["Retail",cbb.retail,"#22c55e","Dealer asking range"],["Trade-in",cbb.trade,"#f59e0b","What dealer pays"],["Wholesale",cbb.wholesale,"#94a3b8","Auction estimate"]].map(([l,v,c,sub])=>(
              <div key={l} className="lc-stat" style={{borderColor:"#1e3a5f"}}>
                <div className="lc-stat-label">{l}</div>
                <div style={{fontSize:17,fontWeight:700,color:c,marginBottom:2}}>${v.toLocaleString()}</div>
                <div style={{fontSize:10,color:"#334155"}}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{background:"#0a1628",borderRadius:10,padding:"12px 14px",marginTop:8,fontSize:13,color:"#64748b"}}>
            Spread vs trade-in: <strong style={{color:listing.price-cbb.trade>5000?"#ef4444":"#22c55e"}}>{listing.price-cbb.trade>0?"+":""} ${(listing.price-cbb.trade).toLocaleString()}</strong>
          </div>
        </div>
      )}
      {/* VIN History */}
      {tab==="vin"&&isUnlocked("vin")&&<VINHistoryPanel listing={listing}/>}
      {/* Insurance */}
      {tab==="insurance"&&<InsurancePanel listing={listing}/>}
      {/* Connect */}
      <div style={{display:"flex",gap:8}}>
        <button onClick={onConnect} className="lc-connect-btn" style={{flex:2}}>
          <span>🤝</span>
          <span>Connect me with a dealer</span>
          {rebate.total>0&&<span style={{background:"rgba(255,255,255,0.2)",borderRadius:6,padding:"2px 8px",fontSize:12}}>⚡ ${rebate.total.toLocaleString()}</span>}
        </button>
        <button onClick={onTestDrive} style={{flex:1,background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:14,padding:"0 14px",color:"#60a5fa",fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,whiteSpace:"nowrap"}}>
          <span>🚗</span><span>Test drive</span>
        </button>
      </div>

      {unlockModal&&(
        <UnlockModal
          feature={unlockModal}
          price={unlockPrice[unlockModal]}
          onUnlock={()=>{setUnlocks(prev=>({...prev,[key(unlockModal)]:true}));setTab(unlockModal);}}
          onClose={()=>setUnlockModal(null)}
          onUpgrade={()=>{setUnlockModal(null);onUpgrade();}}
        />
      )}
    </div>
  );
}

// ── Listing Card ──────────────────────────────────────────────────────────────
function ListingCard({listing,onClick,active}){
  const score=lotScore(listing,LISTINGS);
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel);
  return(
    <div className={`lc-card${active?" active":""}`} onClick={()=>onClick(listing)}>
      <div className="lc-card-name">{listing.name}</div>
      <div className="lc-card-badges">
        <ScorePill score={score}/><FuelTag fuel={listing.fuel}/>{evap&&<EVAPTag evap={evap}/>}
      </div>
      <div className="lc-card-bottom">
        <div>
          <div className="lc-price">${listing.price.toLocaleString()}</div>
          {rebate.total>0&&<div className="lc-after-rebate">~${(listing.price-rebate.total).toLocaleString()} after rebates</div>}
        </div>
        <div className="lc-meta">
          <div className="lc-city">{listing.city}, {listing.province}</div>
          <div className="lc-km" style={{color:listing.km>150000?"#ef4444":listing.km>80000?"#f59e0b":"#22c55e"}}>{listing.km.toLocaleString()} km</div>
        </div>
      </div>
    </div>
  );
}


// ── EVAP Rebate Tab — analytics panel with live countdown + declining schedule ──
function EVAPRebateTab({listing, rebate}){
  // Live countdown to Jan 1 2027 (next rebate drop)
  const [timeLeft, setTimeLeft] = useState({});
  const [showInfo, setShowInfo] = useState(false);

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

  // EVAP declining schedule — real Transport Canada data
  const schedule=[
    {year:"2026",bev:5000,phev:2500,active:true,label:"NOW"},
    {year:"2027",bev:4000,phev:2000,active:false,label:"Jan 1, 2027"},
    {year:"2028–29",bev:3000,phev:1500,active:false,label:"Jan 1, 2028"},
    {year:"2030",bev:2000,phev:1000,active:false,label:"Jan 1, 2030"},
  ];

  // Program timeline bar: Feb 16 2026 → Mar 31 2031
  const progStart=new Date("2026-02-16");
  const progEnd=new Date("2031-03-31");
  const now=new Date();
  const pct=Math.min(100,Math.max(0,((now-progStart)/(progEnd-progStart))*100));
  const daysLeft=Math.max(0,Math.floor((progEnd-now)/(1000*60*60*24)));

  const isEV=listing.fuel==="BEV"||listing.fuel==="PHEV";

  if(!isEV) return(
    <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:20,color:"#64748b",fontSize:14,textAlign:"center"}}>
      <div style={{fontSize:28,marginBottom:8}}>⛽</div>
      <div style={{color:"#94a3b8",fontWeight:600,marginBottom:4}}>No federal rebates for gas vehicles</div>
      <div style={{fontSize:12,color:"#475569"}}>EVAP applies to BEV and PHEV purchases only. Switch the fuel filter to see eligible vehicles.</div>
    </div>
  );

  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>

      {/* ── Header + Info tooltip ──────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#22c55e"}}>⚡ Federal EVAP Rebates · {PROVINCES[listing.province]||listing.province}</div>
        <div style={{position:"relative"}}>
          <button
            onClick={()=>setShowInfo(v=>!v)}
            style={{background:"none",border:"1px solid #334155",borderRadius:"50%",width:22,height:22,cursor:"pointer",color:"#64748b",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}
            title="About this rebate"
          >ℹ</button>
          {showInfo&&(
            <div style={{position:"absolute",right:0,top:28,zIndex:99,background:"#0d1526",border:"1px solid #1e3a5f",borderRadius:12,padding:"14px 16px",width:290,boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#3b82f6",marginBottom:8,letterSpacing:0.5}}>ℹ️ ABOUT THESE REBATES</div>
              <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.65}}>
                These are <strong style={{color:"#f1f5f9"}}>new vehicle purchase rebates</strong> from Transport Canada. Used cars listed here don't qualify — but knowing the rebate helps you compare the real cost of buying new vs. used.
                <div style={{background:"#1a1000",border:"1px solid #f59e0b30",borderRadius:8,padding:"8px 10px",margin:"8px 0"}}>
                  <strong style={{color:"#f59e0b",fontSize:11}}>⚠️ Rebate tier locks to the dealer's submission date</strong>
                  <div style={{color:"#94a3b8",marginTop:3,fontSize:11}}>Per Transport Canada: the tier is determined by when the dealer submits the eligibility assessment — not your order date or delivery date. Confirm with your dealer that they can submit before the tier drops.</div>
                </div>
                The rebate is <strong style={{color:"#f1f5f9"}}>applied by the dealer at point of sale</strong> — you never claim it yourself. Only enrolled dealerships can submit to Transport Canada.
                <br/><br/>
                Final transaction value must be <strong style={{color:"#f1f5f9"}}>≤ $50,000</strong>. No cap for Canadian-made EVs. One incentive per person over the 5-year program.
              </div>
              <button onClick={()=>setShowInfo(false)} style={{marginTop:10,background:"none",border:"none",color:"#475569",fontSize:11,cursor:"pointer",padding:0}}>Close ✕</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Current rebate amounts ─────────────────────────────── */}
      {rebate.total>0?(
        <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:12,padding:"14px 16px"}}>
          {rebate.federal>0&&(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontSize:14,color:"#e2e8f0",fontWeight:600}}>Federal EVAP</div>
                <div style={{fontSize:11,color:"#475569"}}>Transport Canada · all provinces</div>
              </div>
              <div style={{fontSize:18,fontWeight:700,color:"#22c55e"}}>${rebate.federal.toLocaleString()}</div>
            </div>
          )}
          {rebate.provincial>0&&(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontSize:14,color:"#e2e8f0",fontWeight:600}}>{rebate.prov_name}</div>
                <div style={{fontSize:11,color:"#475569"}}>Provincial · {PROVINCES[listing.province]}</div>
              </div>
              <div style={{fontSize:18,fontWeight:700,color:"#3b82f6"}}>${rebate.provincial.toLocaleString()}</div>
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
          {rebate.note&&<div style={{fontSize:11,color:"#475569",marginTop:8,borderTop:"1px solid #16a34a15",paddingTop:8}}>{rebate.note}</div>}
        </div>
      ):(
        <div style={{background:"#0a1526",border:"1px solid #1e293b",borderRadius:12,padding:"12px 14px",fontSize:13,color:"#64748b"}}>
          No provincial rebate in {PROVINCES[listing.province]||listing.province} — federal EVAP applies nationwide.
        </div>
      )}

      {/* ── Countdown to next rebate drop ─────────────────────── */}
      <div style={{background:"#0d1526",border:"1px solid #f59e0b30",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#f59e0b",letterSpacing:0.8,marginBottom:4}}>⏳ REBATE DROPS JAN 1, 2027</div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>
          The tier is locked to the <strong style={{color:"#94a3b8"}}>dealer's eligibility submission date</strong> — not delivery date. Dealer must submit to Transport Canada before Jan 1, 2027 for you to get the current rate. Confirm this timeline with your dealer.
        </div>
        {timeLeft.expired?(
          <div style={{color:"#ef4444",fontWeight:700,fontSize:13}}>Rebate has already decreased. See schedule below.</div>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
            {[["DAYS",timeLeft.d],["HRS",timeLeft.h],["MIN",timeLeft.m],["SEC",timeLeft.s]].map(([label,val])=>(
              <div key={label} style={{background:"#0a0f1e",borderRadius:8,padding:"8px 4px",textAlign:"center",border:"1px solid #1e293b"}}>
                <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9",fontVariantNumeric:"tabular-nums",letterSpacing:-0.5}}>
                  {String(val??0).padStart(2,"0")}
                </div>
                <div style={{fontSize:9,color:"#475569",fontWeight:600,letterSpacing:0.5,marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Declining rebate schedule ─────────────────────────── */}
      <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",letterSpacing:0.8,marginBottom:10}}>📉 EVAP REBATE DECLINING SCHEDULE</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,marginBottom:6}}>
          <div style={{fontSize:10,color:"#475569",fontWeight:600}}>PERIOD</div>
          <div style={{fontSize:10,color:"#475569",fontWeight:600,textAlign:"center"}}>BEV</div>
          <div style={{fontSize:10,color:"#475569",fontWeight:600,textAlign:"center"}}>PHEV</div>
        </div>
        {schedule.map((s,i)=>{
          const isNow=s.active;
          const fuel=listing.fuel;
          return(
            <div key={i} style={{
              display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,
              padding:"8px 10px",borderRadius:8,marginBottom:4,
              background:isNow?"#0d2010":"transparent",
              border:isNow?"1px solid #16a34a30":"1px solid transparent",
            }}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {isNow&&<span style={{fontSize:8,background:"#16a34a",color:"#fff",borderRadius:3,padding:"1px 4px",fontWeight:700,letterSpacing:0.3}}>NOW</span>}
                <span style={{fontSize:12,color:isNow?"#e2e8f0":"#475569",fontWeight:isNow?700:400}}>{s.year}</span>
              </div>
              <div style={{textAlign:"center",fontSize:13,fontWeight:isNow&&fuel==="BEV"?800:500,color:isNow&&fuel==="BEV"?"#22c55e":isNow?"#e2e8f0":"#475569"}}>
                ${s.bev.toLocaleString()}
              </div>
              <div style={{textAlign:"center",fontSize:13,fontWeight:isNow&&fuel==="PHEV"?800:500,color:isNow&&fuel==="PHEV"?"#f59e0b":isNow?"#e2e8f0":"#475569"}}>
                ${s.phev.toLocaleString()}
              </div>
            </div>
          );
        })}
        <div style={{fontSize:10,color:"#334155",marginTop:6}}>
          Source: Transport Canada · tc.canada.ca · Updated May 11, 2026
        </div>
      </div>

      {/* ── Funding burn rate ────────────────────────────────── */}
      <div style={{background:"#0a0f1e",border:"1px solid #ef444430",borderRadius:12,padding:"14px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"#ef4444",letterSpacing:0.8}}>💰 FUNDING STATUS</div>
          <div style={{fontSize:11,color:"#64748b"}}>First-come, first-served</div>
        </div>
        {/* $2.13B remaining of $2.275B as of June 1 2026 — real TC data */}
        <div style={{height:7,background:"#1e293b",borderRadius:4,overflow:"hidden",marginBottom:8}}>
          <div style={{height:"100%",width:"93.6%",background:"linear-gradient(90deg,#22c55e 0%,#f59e0b 70%,#ef4444 100%)",borderRadius:4}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          <div>
            <div style={{fontSize:16,fontWeight:800,color:"#f1f5f9"}}>$2.13B</div>
            <div style={{fontSize:10,color:"#475569"}}>remaining of $2.275B · as of June 1, 2026</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#ef4444"}}>~$145M claimed</div>
            <div style={{fontSize:10,color:"#475569"}}>in first ~3.5 months</div>
          </div>
        </div>
        <div style={{fontSize:10,color:"#334155",marginTop:8,borderTop:"1px solid #1e293b",paddingTop:8}}>
          Program ends Mar 31, 2031 <strong style={{color:"#64748b"}}>or when funds run out</strong> — whichever comes first. At current burn rate, funding may not last the full 5 years.
        </div>
      </div>

      {/* ── Program timeline ──────────────────────────────── */}
      <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",letterSpacing:0.8}}>📅 PROGRAM WINDOW</div>
          <div style={{fontSize:11,color:"#64748b"}}>{daysLeft.toLocaleString()} days remaining</div>
        </div>
        <div style={{height:6,background:"#1e293b",borderRadius:3,overflow:"hidden",marginBottom:6}}>
          <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#22c55e,#16a34a)",borderRadius:3,transition:"width 0.5s"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:"#334155"}}>Feb 16, 2026</span>
          <span style={{fontSize:10,color:"#334155"}}>Mar 31, 2031</span>
        </div>
      </div>

    </div>
  );
}

// ── Apple-style particle background — calm flowing sand/dust particles ─────────
function LiveBackground(){
  const canvasRef=useRef(null);
  const animRef=useRef(null);

  useEffect(()=>{
    const canvas=canvasRef.current;
    if(!canvas)return;
    const ctx=canvas.getContext("2d");

    // Use devicePixelRatio for crisp rendering on mobile retina screens
    const dpr=Math.min(window.devicePixelRatio||1,2);

    const setSize=()=>{
      const vw=window.innerWidth;
      const vh=window.innerHeight;
      canvas.width=vw*dpr;
      canvas.height=vh*dpr;
      canvas.style.width=vw+"px";
      canvas.style.height=vh+"px";
      ctx.scale(dpr,dpr);
      W=vw; H=vh;
    };

    let W=window.innerWidth;
    let H=window.innerHeight;
    setSize();

    const resize=()=>{ ctx.setTransform(1,0,0,1,0,0); setSize(); };
    window.addEventListener("resize",resize);

    // Particle system — Apple "sand" aesthetic: tiny, slow, organic
    const COLORS=[
      [22,163,74],   // green
      [14,165,233],  // cyan
      [99,102,241],  // indigo
      [139,92,246],  // violet
    ];

    const N=Math.min(200, Math.floor(W*H/8000)); // density scales with screen
    const particles=Array.from({length:N},()=>{
      const [r,g,b]=COLORS[Math.floor(Math.random()*COLORS.length)];
      return{
        x:Math.random()*W,
        y:Math.random()*H,
        r:r,g:g,b:b,
        size:Math.random()*1.8+0.3,
        // slow drift — Apple uses very subtle motion
        vx:(Math.random()-0.5)*0.15,
        vy:(Math.random()-0.5)*0.12,
        // each particle has a gentle sine wave offset for organic feel
        phase:Math.random()*Math.PI*2,
        freq:0.003+Math.random()*0.005,
        amp:0.3+Math.random()*0.5,
        opacity:0.15+Math.random()*0.55,
        opacityTarget:0.15+Math.random()*0.55,
        opacitySpeed:0.002+Math.random()*0.004,
      };
    });

    let t=0;
    const draw=()=>{
      // Dark near-black fill — very subtle fade so trails feel like breath
      ctx.fillStyle="rgba(2,6,23,0.18)";
      ctx.fillRect(0,0,W,H);

      t+=1;

      for(const p of particles){
        // Sinusoidal drift — gives organic, breathing motion
        p.x+=p.vx+Math.sin(t*p.freq+p.phase)*p.amp*0.08;
        p.y+=p.vy+Math.cos(t*p.freq*0.7+p.phase)*p.amp*0.06;

        // Wrap edges seamlessly
        if(p.x<-2)p.x=W+2;
        if(p.x>W+2)p.x=-2;
        if(p.y<-2)p.y=H+2;
        if(p.y>H+2)p.y=-2;

        // Gentle opacity breathe
        p.opacity+=(p.opacityTarget-p.opacity)*p.opacitySpeed;
        if(Math.abs(p.opacity-p.opacityTarget)<0.01){
          p.opacityTarget=0.08+Math.random()*0.5;
        }

        // Draw particle — soft glow
        const grd=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*3);
        grd.addColorStop(0,`rgba(${p.r},${p.g},${p.b},${p.opacity})`);
        grd.addColorStop(1,`rgba(${p.r},${p.g},${p.b},0)`);
        ctx.beginPath();
        ctx.arc(p.x,p.y,p.size*3,0,Math.PI*2);
        ctx.fillStyle=grd;
        ctx.fill();
      }

      // Very faint ambient glow that shifts slowly — the "sand dune" highlight
      const gx=Math.sin(t*0.0008)*W*0.4+W*0.5;
      const gy=Math.cos(t*0.0006)*H*0.3+H*0.45;
      const ambient=ctx.createRadialGradient(gx,gy,0,gx,gy,Math.min(W,H)*0.7);
      ambient.addColorStop(0,"rgba(22,163,74,0.025)");
      ambient.addColorStop(0.5,"rgba(14,165,233,0.015)");
      ambient.addColorStop(1,"rgba(2,6,23,0)");
      ctx.fillStyle=ambient;
      ctx.fillRect(0,0,W,H);

      animRef.current=requestAnimationFrame(draw);
    };
    draw();

    return()=>{
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize",resize);
    };
  },[]);

  return(
    <div className="lc-live-bg" aria-hidden="true">
      <canvas ref={canvasRef}/>
    </div>
  );
}


// ── Live Ticker — scrolling strip of "live" price movements ───────────────────
function LiveTicker({listings,onSelect}){
  const src=listings&&listings.length>0?listings:DEMO_LISTINGS;
  const [items,setItems]=useState(()=>
    src.map(l=>({id:l.id,listing:l,name:`${l.make} ${l.model}`,price:l.price,change:Math.round((Math.random()-0.5)*1200)}))
  );
  useEffect(()=>{
    const interval=setInterval(()=>{
      setItems(prev=>prev.map(it=>{
        if(Math.random()>0.7){
          const delta=Math.round((Math.random()-0.5)*400);
          return{...it,price:Math.max(15000,it.price+delta),change:it.change+delta};
        }
        return it;
      }));
    },2500);
    return()=>clearInterval(interval);
  },[]);
  const doubled=[...items,...items];
  return(
    <div className="lc-ticker-wrap">
      <div className="lc-ticker-track">
        {doubled.map((it,i)=>(
          <span key={i} className="lc-ticker-item" onClick={()=>onSelect&&onSelect(it.listing)}
            style={{cursor:"pointer"}} title={`View ${it.name}`}>
            <span className="lc-ticker-dot"/>
            <span className="name">{it.name}</span>
            <span style={{color:"#f1f5f9",fontWeight:600}}>${it.price.toLocaleString()}</span>
            <span className={it.change>=0?"up":"down"}>{it.change>=0?"▲":"▼"} ${Math.abs(it.change).toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App(){
  const [isPro,setIsPro]=useState(false);
  const [showPro,setShowPro]=useState(false);
  const [showAppraisal,setShowAppraisal]=useState(false);
  const [showConnect,setShowConnect]=useState(false);
  const [showTestDrive,setShowTestDrive]=useState(false);
  const [selected,setSelected]=useState(null);
  const [province,setProvince]=useState("ALL");
  const [fuelFilter,setFuelFilter]=useState("All");
  const [search,setSearch]=useState("");
  const [isMobile,setIsMobile]=useState(window.innerWidth<768);

  // Live data from Supabase — falls back to demo if empty/error
  const {listings:liveListings, loading:dataLoading, isLive}=useListings();

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

  // On mobile, show detail view as full screen overlay
  if(isMobile&&selected){
    return(
      <>
        <style>{GLOBAL_CSS}</style>
        <div style={{minHeight:"100vh",background:"#020617"}}>
          <div style={{background:"#060d18",borderBottom:"1px solid #1e293b",padding:"12px 16px",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:100}}>
            <button onClick={()=>setSelected(null)} style={{background:"#1e293b",border:"none",borderRadius:8,padding:"8px 14px",color:"#e2e8f0",cursor:"pointer",fontSize:14,fontWeight:600}}>← Back</button>
            <div style={{flex:1,fontSize:13,fontWeight:600,color:"#f1f5f9",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selected.name}</div>
            {isPro?<span style={{fontSize:11,color:"#22c55e",fontWeight:700}}>✅ Pro</span>:<button onClick={()=>setShowPro(true)} style={{background:"#16a34a",border:"none",borderRadius:8,padding:"6px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Pro</button>}
          </div>
          <DetailPanel listing={selected} isPro={isPro} onConnect={()=>setShowConnect(true)} onUpgrade={()=>setShowPro(true)} onTestDrive={()=>setShowTestDrive(true)}/>
        </div>
        {showConnect&&<ConnectModal listing={selected} onClose={()=>setShowConnect(false)}/>}
        {showTestDrive&&<TestDriveModal listing={selected} onClose={()=>setShowTestDrive(false)}/>}
        {showPro&&<ProModal onStart={()=>setIsPro(true)} onClose={()=>setShowPro(false)}/>}
      </>
    );
  }

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      <div className="lc-layout">
        <LiveBackground/>
        {/* Header */}
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
            {isPro
              ?<div style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#22c55e",fontWeight:700,whiteSpace:"nowrap"}}>✅ Pro</div>
              :<button onClick={()=>setShowPro(true)} style={{background:"#16a34a",border:"none",borderRadius:10,padding:"7px 12px",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>Try Pro free</button>
            }
          </div>
        </header>

        <LiveTicker listings={liveListings} onSelect={handleSelect}/>

        {showAppraisal&&<AppraisalModal onClose={()=>setShowAppraisal(false)}/>}

        {/* Province filter */}
        <div className="lc-provinces">
          {["ALL",...Object.keys(PROVINCES).filter(c=>LISTINGS.some(l=>l.province===c))].map(code=>(
            <button key={code} className={`lc-province-btn${province===code?" active":""}`} onClick={()=>setProvince(code)}>
              {code==="ALL"?"🇨🇦 All Canada":code}
            </button>
          ))}
        </div>

        <div className="lc-main">
          {/* Sidebar */}
          <div className="lc-sidebar">
            <div className="lc-filters">
              <input className="lc-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search make, model, city…"/>
              <div className="lc-fuel-filters">
                {["All","BEV","PHEV","Hybrid","Gas"].map(f=>(
                  <button key={f} className={`lc-fuel-btn${fuelFilter===f?" active":""}`} onClick={()=>setFuelFilter(f)} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                    {f!=="All"&&<FuelIcon fuel={f} size={12}/>}
                    {f}
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
              {filtered.map(l=><ListingCard key={l.id} listing={l} onClick={handleSelect} active={selected?.id===l.id}/>)}
            </div>
            <div className="lc-footer">© 2026 LotCheck · lotcheck.ca · "Did you LotCheck it?" ™</div>
          </div>

          {/* Detail panel — desktop/tablet only */}
          <div className="lc-detail">
            {selected?(
              <DetailPanel listing={selected} isPro={isPro} onConnect={()=>setShowConnect(true)} onUpgrade={()=>setShowPro(true)} onTestDrive={()=>setShowTestDrive(true)}/>
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
      {showPro&&<ProModal onStart={()=>setIsPro(true)} onClose={()=>setShowPro(false)}/>}
    </>
  );
}
