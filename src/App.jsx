import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

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

  /* ── Live background animation ──────────────────────────────────────────── */
  .lc-live-bg {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    background: #020617;
  }
  .lc-live-bg::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 20% 30%, rgba(22,163,74,0.06) 0%, transparent 40%),
      radial-gradient(circle at 80% 70%, rgba(14,165,233,0.06) 0%, transparent 40%);
  }
  .lc-pulse-dot {
    position: absolute;
    border-radius: 50%;
    background: #16a34a;
    box-shadow: 0 0 12px 2px rgba(22,163,74,0.6);
    animation: lc-pulse-fade 3.5s ease-in-out infinite;
  }
  .lc-pulse-dot.blue {
    background: #0ea5e9;
    box-shadow: 0 0 12px 2px rgba(14,165,233,0.6);
  }
  @keyframes lc-pulse-fade {
    0%   { opacity: 0; transform: scale(0.4); }
    15%  { opacity: 0.9; transform: scale(1); }
    40%  { opacity: 0.5; }
    100% { opacity: 0; transform: scale(1.6); }
  }
  .lc-grid-line {
    position: absolute;
    background: linear-gradient(90deg, transparent, rgba(22,163,74,0.15), transparent);
    height: 1px;
    width: 100%;
    animation: lc-scan 8s linear infinite;
  }
  @keyframes lc-scan {
    0%   { transform: translateY(-10vh); opacity: 0; }
    10%  { opacity: 1; }
    90%  { opacity: 1; }
    100% { transform: translateY(110vh); opacity: 0; }
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
  }


  /* Header */
  .lc-header {
    background: #060d18;
    border-bottom: 1px solid #1e293b;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
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
  .lc-stat-label { font-size: 10px; color: #475569; margin-bottom: 3px; }
  .lc-stat-value { font-size: 15px; font-weight: 700; color: #f1f5f9; }

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

const LISTINGS=[
  {id:1,name:"2025 Toyota RAV4 Prime XSE",make:"Toyota",model:"RAV4 Prime",year:2025,price:49900,km:8000,fuel:"PHEV",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:2,name:"2025 Hyundai IONIQ 5 Preferred",make:"Hyundai",model:"IONIQ 5",year:2025,price:48500,km:5200,fuel:"BEV",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:3,name:"2026 Chevrolet Equinox EV LT",make:"Chevrolet",model:"Equinox EV",year:2026,price:47498,km:1200,fuel:"BEV",province:"AB",city:"Edmonton",source:"Kijiji",dealer:true},
  {id:4,name:"2022 Toyota Tundra Platinum",make:"Toyota",model:"Tundra",year:2022,price:47698,km:151041,fuel:"Hybrid",province:"AB",city:"Calgary",source:"Kijiji",dealer:false},
  {id:5,name:"2025 Kia EV6 Standard RWD",make:"Kia",model:"EV6",year:2025,price:44900,km:3100,fuel:"BEV",province:"BC",city:"Vancouver",source:"Kijiji",dealer:true},
  {id:6,name:"2024 Toyota RAV4 Prime XSE",make:"Toyota",model:"RAV4 Prime",year:2024,price:47500,km:18000,fuel:"PHEV",province:"BC",city:"Victoria",source:"Facebook",dealer:false},
  {id:7,name:"2025 Ford Escape PHEV SE",make:"Ford",model:"Escape",year:2025,price:44999,km:9000,fuel:"PHEV",province:"ON",city:"Toronto",source:"Kijiji",dealer:true},
  {id:8,name:"2025 Hyundai IONIQ 6 Preferred",make:"Hyundai",model:"IONIQ 6",year:2025,price:47499,km:4100,fuel:"BEV",province:"ON",city:"Ottawa",source:"Kijiji",dealer:true},
  {id:9,name:"2025 Chevrolet Bolt EV LT",make:"Chevrolet",model:"Bolt EV",year:2025,price:38998,km:500,fuel:"BEV",province:"QC",city:"Montreal",source:"Kijiji",dealer:true},
  {id:10,name:"2025 VW ID.4 Pro AWD",make:"Volkswagen",model:"ID.4",year:2025,price:49500,km:2200,fuel:"BEV",province:"AB",city:"Calgary",source:"Facebook",dealer:false},
  {id:11,name:"2024 Toyota Tacoma TRD Off-Road",make:"Toyota",model:"Tacoma",year:2024,price:55900,km:12300,fuel:"Gas",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:12,name:"2023 Toyota Camry XSE",make:"Toyota",model:"Camry",year:2023,price:38900,km:33000,fuel:"Gas",province:"AB",city:"Calgary",source:"Kijiji",dealer:true},
  {id:13,name:"2025 Kia Niro EV Wind",make:"Kia",model:"Niro EV",year:2025,price:39995,km:4500,fuel:"BEV",province:"NS",city:"Halifax",source:"Kijiji",dealer:true},
  {id:14,name:"2025 Mitsubishi Outlander PHEV",make:"Mitsubishi",model:"Outlander",year:2025,price:44998,km:6200,fuel:"PHEV",province:"QC",city:"Quebec City",source:"Kijiji",dealer:true},
];

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
  const l=score>=70?"🔥 Hot":score>=45?"Fair":"High";
  return<span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}35`}}>{l} · {score}</span>;
}
function FuelTag({fuel}){
  const c={BEV:"#22c55e",PHEV:"#3b82f6",Hybrid:"#8b5cf6",Gas:"#64748b"}[fuel]||"#64748b";
  return<span className="badge" style={{background:c+"18",color:c,border:`1px solid ${c}30`}}>{fuel}</span>;
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
        <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>No credit card. Cancel anytime. Then $29/mo CAD.</div>
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
  const unlockPrice={vin:2.99,cbb:1.99};

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
        {[["chart","📈 Chart"],["rebates","⚡ Rebates"],["cbb",isUnlocked("cbb")?"📊 Black Book":"🔒 Black Book $1.99"],["vin",isUnlocked("vin")?"🔍 VIN History":"🔒 VIN History $2.99"],["insurance","🛡️ Insurance"]].map(([t,l])=>(
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
              <XAxis dataKey="date" tick={{fontSize:9,fill:"#475569"}} interval={15} tickLine={false} axisLine={false}/>
              <YAxis domain={domain} tick={{fontSize:9,fill:"#475569"}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={36}/>
              <Tooltip formatter={v=>[`$${v.toLocaleString()}`,"Price"]} contentStyle={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:8,fontSize:12}} labelStyle={{color:"#94a3b8"}}/>
              <ReferenceLine y={avgHist} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{value:`avg`,fill:"#f59e0b",fontSize:9,position:"insideTopRight"}}/>
              <Line type="monotone" dataKey="price" stroke="#16a34a" strokeWidth={2} dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="lc-stats">
          {[["Asking",`$${listing.price.toLocaleString()}`],["LotScore",`${score}/100`],["Location",`${listing.city}, ${listing.province}`],["Odometer",`${listing.km.toLocaleString()} km`]].map(([l,v])=>(
            <div key={l} className="lc-stat"><div className="lc-stat-label">{l}</div><div className="lc-stat-value">{v}</div></div>
          ))}
        </div>
      </>}
      {/* Rebates */}
      {tab==="rebates"&&<>
        {rebate.total>0?(
          <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:14,padding:"16px"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#22c55e",marginBottom:12}}>⚡ Available rebates in {PROVINCES[listing.province]||listing.province}</div>
            {rebate.federal>0&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#0a1e10",borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                <div><div style={{fontSize:14,color:"#e2e8f0",fontWeight:600}}>Federal EVAP</div><div style={{fontSize:11,color:"#475569"}}>Transport Canada · all provinces</div></div>
                <div style={{fontSize:18,fontWeight:700,color:"#22c55e"}}>${rebate.federal.toLocaleString()}</div>
              </div>
            )}
            {rebate.provincial>0&&(
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#0a1e10",borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                <div><div style={{fontSize:14,color:"#e2e8f0",fontWeight:600}}>{rebate.prov_name}</div><div style={{fontSize:11,color:"#475569"}}>Provincial · {PROVINCES[listing.province]}</div></div>
                <div style={{fontSize:18,fontWeight:700,color:"#3b82f6"}}>${rebate.provincial.toLocaleString()}</div>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#052010",borderRadius:10,padding:"12px 14px",marginBottom:8}}>
              <div style={{fontSize:14,color:"#94a3b8"}}>Total stacked</div>
              <div style={{fontSize:20,fontWeight:800,color:"#22c55e"}}>${rebate.total.toLocaleString()}</div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#052010",borderRadius:10,padding:"12px 14px"}}>
              <div style={{fontSize:14,color:"#94a3b8"}}>After all rebates</div>
              <div style={{fontSize:20,fontWeight:800,color:"#f1f5f9"}}>${(listing.price-rebate.total).toLocaleString()}</div>
            </div>
            {rebate.note&&<div style={{fontSize:12,color:"#475569",marginTop:10}}>{rebate.note}</div>}
          </div>
        ):(
          <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:14,padding:"16px",color:"#64748b",fontSize:14}}>
            No EV/PHEV rebates apply to this vehicle in {PROVINCES[listing.province]||listing.province}.
          </div>
        )}
      </>}
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

// ── Live Background — pulsing dots + scanning lines, evokes a live market ─────
function LiveBackground(){
  const [dots,setDots]=useState([]);
  const idRef=useRef(0);

  useEffect(()=>{
    const spawn=()=>{
      const id=idRef.current++;
      const dot={
        id,
        top:Math.random()*100,
        left:Math.random()*100,
        size:4+Math.random()*6,
        blue:Math.random()>0.5,
      };
      setDots(prev=>[...prev.slice(-14),dot]);
    };
    spawn();
    const interval=setInterval(spawn,900);
    return()=>clearInterval(interval);
  },[]);

  return(
    <div className="lc-live-bg" aria-hidden="true">
      <div className="lc-grid-line" style={{left:"15%",animationDelay:"0s"}}/>
      <div className="lc-grid-line" style={{left:"55%",animationDelay:"2.5s"}}/>
      <div className="lc-grid-line" style={{left:"85%",animationDelay:"5s"}}/>
      {dots.map(d=>(
        <div key={d.id} className={`lc-pulse-dot${d.blue?" blue":""}`}
          style={{top:`${d.top}%`,left:`${d.left}%`,width:d.size,height:d.size}}/>
      ))}
    </div>
  );
}

// ── Live Ticker — scrolling strip of "live" price movements ───────────────────
function LiveTicker(){
  const [items,setItems]=useState(()=>
    LISTINGS.map(l=>({
      id:l.id,
      name:`${l.make} ${l.model}`,
      price:l.price,
      change:Math.round((Math.random()-0.5)*1200),
    }))
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
          <span key={i} className="lc-ticker-item">
            <span className="lc-ticker-dot"/>
            <span className="name">{it.name}</span>
            <span>${it.price.toLocaleString()}</span>
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

  useEffect(()=>{
    const handler=()=>setIsMobile(window.innerWidth<768);
    window.addEventListener("resize",handler);
    return()=>window.removeEventListener("resize",handler);
  },[]);

  const filtered=LISTINGS.filter(l=>{
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
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:34,height:34,background:"linear-gradient(135deg,#16a34a,#0ea5e9)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>✅</div>
            <div>
              <div style={{fontWeight:800,fontSize:18,letterSpacing:"-0.5px",lineHeight:1}}>LotCheck</div>
              <div style={{fontSize:10,color:"#334155",fontStyle:"italic"}}>Did you LotCheck it?</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={()=>setShowAppraisal(true)} style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:10,padding:"8px 12px",color:"#60a5fa",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>💰 My car's worth</button>
            {isPro
              ?<div style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:8,padding:"6px 12px",fontSize:12,color:"#22c55e",fontWeight:700}}>✅ Pro · 3d left</div>
              :<button onClick={()=>setShowPro(true)} style={{background:"#16a34a",border:"none",borderRadius:10,padding:"8px 16px",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Try Pro free</button>
            }
          </div>
        </header>

        <LiveTicker/>

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
                  <button key={f} className={`lc-fuel-btn${fuelFilter===f?" active":""}`} onClick={()=>setFuelFilter(f)}>{f}</button>
                ))}
              </div>
            </div>
            <div className="lc-listings">
              <div style={{fontSize:12,color:"#334155",marginBottom:8}}>{filtered.length} listings · Canada</div>
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
