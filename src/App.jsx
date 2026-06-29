import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from "recharts";

// ── Brand ─────────────────────────────────────────────────────────────────────
const BRAND = {
  name: "LotCheck",
  tagline: "Did you LotCheck it?",
  description: "Canada's car market intelligence platform",
  color: "#16a34a",
  colorAccent: "#0ea5e9",
  emoji: "✅",
};

// ── Provincial rebates ────────────────────────────────────────────────────────
const REBATES = {
  AB: { federal_bev:5000, federal_phev:2500, prov_bev:0,    prov_phev:0,    prov_name:null,          note:"Federal EVAP only" },
  BC: { federal_bev:5000, federal_phev:2500, prov_bev:4000, prov_phev:1500, prov_name:"BC CVAP",     note:"Stack federal + provincial. Scrap old car = +$2K." },
  ON: { federal_bev:5000, federal_phev:2500, prov_bev:0,    prov_phev:0,    prov_name:null,          note:"Ontario cancelled provincial rebate 2018. Federal only." },
  QC: { federal_bev:5000, federal_phev:2500, prov_bev:7000, prov_phev:4000, prov_name:"Roulez Vert", note:"Best rebates in Canada. Stack federal + provincial." },
  MB: { federal_bev:5000, federal_phev:2500, prov_bev:0,    prov_phev:0,    prov_name:null,          note:"Federal EVAP only" },
  SK: { federal_bev:5000, federal_phev:2500, prov_bev:0,    prov_phev:0,    prov_name:null,          note:"Federal EVAP only" },
  NS: { federal_bev:5000, federal_phev:2500, prov_bev:3000, prov_phev:1500, prov_name:"NS ZEVIP",    note:"Stack federal + provincial." },
  NB: { federal_bev:5000, federal_phev:2500, prov_bev:2500, prov_phev:1000, prov_name:"NB EV",       note:"Stack federal + provincial." },
};

const PROVINCES = {
  AB:"Alberta", BC:"British Columbia", ON:"Ontario", QC:"Quebec",
  MB:"Manitoba", SK:"Saskatchewan", NS:"Nova Scotia", NB:"New Brunswick",
};

function getRebate(province, fuel) {
  const r = REBATES[province];
  if (!r) return { federal:0, provincial:0, total:0, prov_name:null, note:"" };
  const federal    = fuel==="BEV"?r.federal_bev:fuel==="PHEV"?r.federal_phev:0;
  const provincial = fuel==="BEV"?r.prov_bev:fuel==="PHEV"?r.prov_phev:0;
  return { federal, provincial, total:federal+provincial, prov_name:r.prov_name, note:r.note };
}

// ── EVAP list (Transport Canada) ──────────────────────────────────────────────
const EVAP_VEHICLES = [
  {year:2025,make:"Toyota",   model:"RAV4 Prime",  fuel:"PHEV", incentive:2500},
  {year:2024,make:"Toyota",   model:"RAV4 Prime",  fuel:"PHEV", incentive:2500},
  {year:2025,make:"Toyota",   model:"bZ4X",        fuel:"BEV",  incentive:5000},
  {year:2025,make:"Hyundai",  model:"IONIQ 5",     fuel:"BEV",  incentive:5000},
  {year:2025,make:"Hyundai",  model:"IONIQ 6",     fuel:"BEV",  incentive:5000},
  {year:2025,make:"Kia",      model:"EV6",         fuel:"BEV",  incentive:5000},
  {year:2025,make:"Kia",      model:"Niro EV",     fuel:"BEV",  incentive:5000},
  {year:2026,make:"Chevrolet",model:"Equinox EV",  fuel:"BEV",  incentive:5000},
  {year:2025,make:"Chevrolet",model:"Equinox EV",  fuel:"BEV",  incentive:5000},
  {year:2027,make:"Chevrolet",model:"Bolt EV",     fuel:"BEV",  incentive:5000},
  {year:2025,make:"Volkswagen",model:"ID.4",       fuel:"BEV",  incentive:5000},
  {year:2025,make:"Ford",     model:"Escape",      fuel:"PHEV", incentive:2500},
  {year:2025,make:"Mitsubishi",model:"Outlander",  fuel:"PHEV", incentive:2500},
  {year:2026,make:"Dodge",    model:"Charger",     fuel:"BEV",  incentive:5000},
];

function getEVAP(listing) {
  return EVAP_VEHICLES.find(e =>
    e.year===listing.year &&
    listing.make?.toLowerCase()===e.make.toLowerCase() &&
    (listing.model?.toLowerCase().includes(e.model.toLowerCase()) ||
     e.model.toLowerCase().includes(listing.model?.toLowerCase()))
  ) || null;
}

// ── Listings ──────────────────────────────────────────────────────────────────
const ALL_LISTINGS = [
  {id:1,  name:"2025 Toyota RAV4 Prime XSE",      make:"Toyota",     model:"RAV4 Prime", year:2025, price:49900, km:8000,   fuel:"PHEV", province:"AB", city:"Calgary",   source:"Kijiji",   dealer:true},
  {id:2,  name:"2025 Hyundai IONIQ 5 Preferred",  make:"Hyundai",    model:"IONIQ 5",    year:2025, price:48500, km:5200,   fuel:"BEV",  province:"AB", city:"Calgary",   source:"Kijiji",   dealer:true},
  {id:3,  name:"2026 Chevrolet Equinox EV LT",    make:"Chevrolet",  model:"Equinox EV", year:2026, price:47498, km:1200,   fuel:"BEV",  province:"AB", city:"Edmonton",  source:"Kijiji",   dealer:true},
  {id:4,  name:"2022 Toyota Tundra Platinum",      make:"Toyota",     model:"Tundra",     year:2022, price:47698, km:151041, fuel:"Hybrid",province:"AB",city:"Calgary",   source:"Kijiji",   dealer:false},
  {id:5,  name:"2025 Kia EV6 Standard RWD",       make:"Kia",        model:"EV6",        year:2025, price:44900, km:3100,   fuel:"BEV",  province:"BC", city:"Vancouver", source:"Kijiji",   dealer:true},
  {id:6,  name:"2024 Toyota RAV4 Prime XSE",      make:"Toyota",     model:"RAV4 Prime", year:2024, price:47500, km:18000,  fuel:"PHEV", province:"BC", city:"Victoria",  source:"Facebook", dealer:false},
  {id:7,  name:"2025 Ford Escape PHEV SE",         make:"Ford",       model:"Escape",     year:2025, price:44999, km:9000,   fuel:"PHEV", province:"ON", city:"Toronto",   source:"Kijiji",   dealer:true},
  {id:8,  name:"2025 Hyundai IONIQ 6 Preferred",  make:"Hyundai",    model:"IONIQ 6",    year:2025, price:47499, km:4100,   fuel:"BEV",  province:"ON", city:"Ottawa",    source:"Kijiji",   dealer:true},
  {id:9,  name:"2025 Chevrolet Bolt EV LT",        make:"Chevrolet",  model:"Bolt EV",    year:2025, price:38998, km:500,    fuel:"BEV",  province:"QC", city:"Montreal",  source:"Kijiji",   dealer:true},
  {id:10, name:"2025 Mitsubishi Outlander PHEV",   make:"Mitsubishi", model:"Outlander",  year:2025, price:44998, km:6200,   fuel:"PHEV", province:"QC", city:"Quebec City",source:"Kijiji",  dealer:true},
  {id:11, name:"2025 VW ID.4 Pro AWD",             make:"Volkswagen", model:"ID.4",       year:2025, price:49500, km:2200,   fuel:"BEV",  province:"AB", city:"Calgary",   source:"Facebook", dealer:false},
  {id:12, name:"2024 Toyota Tacoma TRD Off-Road",  make:"Toyota",     model:"Tacoma",     year:2024, price:55900, km:12300,  fuel:"Gas",  province:"AB", city:"Calgary",   source:"Kijiji",   dealer:true},
  {id:13, name:"2023 Toyota Camry XSE",            make:"Toyota",     model:"Camry",      year:2023, price:38900, km:33000,  fuel:"Gas",  province:"AB", city:"Calgary",   source:"Kijiji",   dealer:true},
  {id:14, name:"2025 Kia Niro EV Wind",            make:"Kia",        model:"Niro EV",    year:2025, price:39995, km:4500,   fuel:"BEV",  province:"NS", city:"Halifax",   source:"Kijiji",   dealer:true},
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function genHistory(price) {
  const h=[]; let p=price*(1+(Math.random()*0.08-0.02));
  for(let i=60;i>=0;i--){
    const d=new Date(); d.setDate(d.getDate()-i);
    p=p*(1+(Math.random()-0.52)*0.022);
    h.push({date:d.toLocaleDateString("en-CA",{month:"short",day:"numeric"}),price:Math.round(p)});
  }
  h[h.length-1].price=price; return h;
}

function lotScore(l, all) {
  const comps=all.filter(x=>x.model===l.model&&x.id!==l.id);
  if(!comps.length) return 50;
  const aP=comps.reduce((s,x)=>s+x.price,0)/comps.length;
  const aK=comps.reduce((s,x)=>s+x.km,0)/comps.length;
  return Math.max(0,Math.min(100,Math.round(50+((aP-l.price)/aP)*120+((aK-l.km)/aK)*40)));
}

function cbb(l) {
  const age=Math.max(0.4,1-(2026-l.year)*0.08);
  const km=Math.max(0.7,1-(l.km/300000)*0.35);
  return {retail:Math.round(l.price*1.05), trade:Math.round(l.price*age*km*0.82), wholesale:Math.round(l.price*age*km*0.75)};
}

// ── Small components ──────────────────────────────────────────────────────────
function ScorePill({score}) {
  const c=score>=70?"#16a34a":score>=45?"#d97706":"#dc2626";
  const l=score>=70?"✅ Hot deal":score>=45?"Fair price":"Overpriced";
  return <span style={{background:c+"18",color:c,border:`1px solid ${c}35`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>{l} · {score}</span>;
}
function FuelBadge({fuel}) {
  const c={BEV:"#22c55e",PHEV:"#3b82f6",Hybrid:"#8b5cf6",Gas:"#64748b"}[fuel]||"#64748b";
  return <span style={{background:c+"18",color:c,border:`1px solid ${c}30`,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:600}}>{fuel}</span>;
}
function EVAPBadge({evap}) {
  if(!evap) return null;
  return <span style={{background:"#16a34a18",color:"#22c55e",border:"1px solid #22c55e30",borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700}}>⚡ EVAP ${evap.incentive.toLocaleString()}</span>;
}
function SourceBadge({source}) {
  const c=source==="Facebook"?"#1877F2":"#E8441F";
  return <span style={{background:c+"18",color:c,border:`1px solid ${c}30`,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:600}}>{source==="Facebook"?"FB Mkt":source}</span>;
}

// ── Pro trial modal ───────────────────────────────────────────────────────────
function TrialModal({onStart,onClose}) {
  const [step,setStep]=useState(0);
  const [email,setEmail]=useState("");
  const inp={width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:"9px 12px",color:"#f1f5f9",fontSize:13,boxSizing:"border-box",outline:"none",fontFamily:"inherit"};
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:16}}>
      <div style={{background:"#0d1526",border:"1px solid #16a34a40",borderRadius:20,padding:28,width:420,maxWidth:"100%",position:"relative",maxHeight:"90vh",overflowY:"auto"}}>
        {step===0?<>
          <div style={{fontSize:12,color:"#16a34a",fontWeight:700,letterSpacing:1,marginBottom:6}}>LOTCHECK PRO · 3-DAY FREE TRIAL</div>
          <div style={{fontSize:20,fontWeight:800,color:"#f1f5f9",marginBottom:6,letterSpacing:"-0.5px"}}>Built for car sales professionals</div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:20}}>No credit card. Cancel anytime. Then $29/mo CAD.</div>
          {[
            ["📊","Canadian Black Book (CBB)","Retail, trade & wholesale on every listing"],
            ["⚡","EVAP Rebate Checker","Federal + provincial incentives stacked"],
            ["🗓️","Alberta Allocations Tracker","Incoming inventory before it hits the lot"],
            ["🔔","Unlimited price alerts","Get notified the moment a deal drops"],
            ["🤝","Dealer connect network","Send buyers directly to partner dealers"],
            ["📈","Market trend reports","90-day price movement by model & trim"],
          ].map(([icon,title,sub])=>(
            <div key={title} style={{display:"flex",gap:12,alignItems:"flex-start",background:"#1e293b20",borderRadius:10,padding:"9px 12px",marginBottom:7}}>
              <span style={{fontSize:16,marginTop:1}}>{icon}</span>
              <div><div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{title}</div><div style={{fontSize:11,color:"#475569"}}>{sub}</div></div>
            </div>
          ))}
          <button onClick={()=>setStep(1)} style={{width:"100%",padding:"13px 0",background:"#16a34a",border:"none",borderRadius:10,color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",marginTop:6}}>Start 3-day free trial →</button>
          <div style={{textAlign:"center",marginTop:8,fontSize:11,color:"#334155"}}>Then $29/mo CAD · Cancel anytime · No card needed</div>
        </>:<>
          <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Create your Pro account</div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:18}}>3 days free, then $29/mo CAD.</div>
          {[["Work email","email","you@dealership.ca"],["Full name","text",""],["Dealership (optional)","text",""]].map(([l,t,ph])=>(
            <div key={l}><label style={{fontSize:11,color:"#94a3b8",display:"block",marginBottom:3}}>{l}</label>
            <input type={t} placeholder={ph} value={l==="Work email"?email:undefined} onChange={l==="Work email"?e=>setEmail(e.target.value):undefined} style={{...inp,marginBottom:10}}/></div>
          ))}
          <div style={{display:"flex",gap:10,marginTop:4}}>
            <button onClick={()=>setStep(0)} style={{flex:1,padding:"11px 0",background:"transparent",border:"1px solid #334155",borderRadius:8,color:"#94a3b8",cursor:"pointer",fontSize:13}}>Back</button>
            <button onClick={onStart} style={{flex:2,padding:"11px 0",background:"#16a34a",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Activate free trial →</button>
          </div>
        </>}
        <button onClick={onClose} style={{position:"absolute",top:14,right:18,background:"transparent",border:"none",color:"#475569",fontSize:18,cursor:"pointer"}}>✕</button>
      </div>
    </div>
  );
}

// ── Connect modal ─────────────────────────────────────────────────────────────
function ConnectModal({listing,onClose}) {
  const evap=getEVAP(listing);
  const rebate=evap?evap.incentive:0;
  const [name,setName]=useState(""); const [phone,setPhone]=useState(""); const [email,setEmail]=useState(""); const [step,setStep]=useState("form"); const [err,setErr]=useState("");
  async function submit(){if(!name.trim())return setErr("Please enter your name.");if(!phone.trim()&&!email.trim())return setErr("Please enter a phone or email.");setErr("");setStep("sending");await new Promise(r=>setTimeout(r,1500));setStep("done");}
  const inp={width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:"9px 12px",color:"#f1f5f9",fontSize:13,boxSizing:"border-box",outline:"none",fontFamily:"inherit"};
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:16}}>
      <div style={{background:"#0d1526",border:"1px solid #1e3a5f",borderRadius:20,padding:28,width:420,maxWidth:"100%",position:"relative",maxHeight:"90vh",overflowY:"auto"}}>
        {step==="done"?<div style={{textAlign:"center",padding:"16px 0"}}>
          <div style={{fontSize:48,marginBottom:10}}>✅</div>
          <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9",marginBottom:6}}>LotChecked — request sent!</div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:16}}>The dealer has been notified and will contact you within 2 hours.</div>
          {rebate>0&&<div style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:10,padding:"10px 14px",marginBottom:16}}>
            <div style={{fontSize:12,color:"#22c55e",fontWeight:700,marginBottom:3}}>⚡ Remind them about your EVAP rebate</div>
            <div style={{fontSize:12,color:"#475569"}}>Up to <strong style={{color:"#22c55e"}}>${rebate.toLocaleString()}</strong> federal incentive · After rebate: ~<strong style={{color:"#22c55e"}}>${(listing.price-rebate).toLocaleString()}</strong></div>
          </div>}
          <button onClick={onClose} style={{background:"#16a34a",border:"none",borderRadius:10,padding:"11px 32px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Done</button>
        </div>:<>
          <div style={{fontSize:15,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Connect me with a dealer</div>
          <div style={{fontSize:12,color:"#475569",marginBottom:14}}>LotCheck sends your details to the dealer — they'll call you within 2 hours.</div>
          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0",marginBottom:5}}>{listing.name}</div>
            <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
              <FuelBadge fuel={listing.fuel}/><SourceBadge source={listing.source}/>
              <span style={{fontSize:12,color:"#64748b"}}>{listing.km.toLocaleString()} km</span>
              <span style={{fontSize:14,fontWeight:700,color:"#f1f5f9",marginLeft:"auto"}}>${listing.price.toLocaleString()}</span>
            </div>
            {rebate>0&&<div style={{fontSize:11,color:"#22c55e",fontWeight:600,marginTop:6}}>⚡ After EVAP: ~${(listing.price-rebate).toLocaleString()}</div>}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:14}}>
            {[["Full name *","Jane Smith",name,setName,"text"],["Phone","403-555-0100",phone,setPhone,"tel"],["Email","jane@email.com",email,setEmail,"email"]].map(([l,ph,v,s,t])=>(
              <div key={l}><label style={{fontSize:11,color:"#94a3b8",display:"block",marginBottom:3}}>{l}</label>
              <input type={t} placeholder={ph} value={v} onChange={e=>s(e.target.value)} style={inp}/></div>
            ))}
          </div>
          {err&&<div style={{background:"#7f1d1d20",border:"1px solid #7f1d1d50",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#ef4444",marginBottom:10}}>{err}</div>}
          <div style={{fontSize:11,color:"#334155",marginBottom:12}}>Your info is shared with the dealer only. LotCheck never sells your data.</div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={onClose} style={{flex:1,padding:"11px 0",background:"transparent",border:"1px solid #334155",borderRadius:10,color:"#94a3b8",cursor:"pointer",fontSize:13}}>Cancel</button>
            <button onClick={submit} disabled={step==="sending"} style={{flex:2,padding:"11px 0",background:step==="sending"?"#1e3a5f":"#16a34a",border:"none",borderRadius:10,color:"#fff",fontSize:13,fontWeight:700,cursor:step==="sending"?"not-allowed":"pointer"}}>
              {step==="sending"?"Sending…":"Connect me →"}
            </button>
          </div>
        </>}
        <button onClick={onClose} style={{position:"absolute",top:14,right:18,background:"transparent",border:"none",color:"#475569",fontSize:18,cursor:"pointer"}}>✕</button>
      </div>
    </div>
  );
}

// ── Listing card ──────────────────────────────────────────────────────────────
function ListingCard({listing,onClick,selected,all}) {
  const score=lotScore(listing,all);
  const evap=getEVAP(listing);
  const rebate=getRebate(listing.province,listing.fuel);
  return(
    <div onClick={()=>onClick(listing)} style={{background:selected?"#1a2744":"#0a0f1e",border:`1px solid ${selected?"#16a34a":"#1e293b"}`,borderRadius:12,padding:"12px 14px",cursor:"pointer",transition:"border 0.15s"}}>
      <div style={{fontSize:12,fontWeight:600,color:"#e2e8f0",marginBottom:5,lineHeight:1.3}}>{listing.name}</div>
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
        <ScorePill score={score}/>
        <FuelBadge fuel={listing.fuel}/>
        {evap&&<EVAPBadge evap={evap}/>}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:"#f1f5f9"}}>${listing.price.toLocaleString()}</div>
          {rebate.total>0&&<div style={{fontSize:10,color:"#22c55e"}}>~${(listing.price-rebate.total).toLocaleString()} after rebates</div>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,color:"#475569"}}>{listing.city}, {listing.province}</div>
          <div style={{fontSize:10,color:"#334155"}}>{listing.km.toLocaleString()} km</div>
        </div>
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function LotCheck() {
  const [isPro,setIsPro]=useState(false);
  const [showTrial,setShowTrial]=useState(false);
  const [showConnect,setShowConnect]=useState(false);
  const [selected,setSelected]=useState(ALL_LISTINGS[0]);
  const [history,setHistory]=useState(()=>genHistory(ALL_LISTINGS[0].price));
  const [search,setSearch]=useState("");
  const [province,setProvince]=useState("ALL");
  const [fuelFilter,setFuelFilter]=useState("All");
  const [tab,setTab]=useState("chart");
  const [isLive,setIsLive]=useState(false);
  const liveRef=useRef(null);

  useEffect(()=>{setHistory(genHistory(selected.price));},[selected]);
  useEffect(()=>{
    if(isLive) liveRef.current=setInterval(()=>setHistory(prev=>[...prev.slice(-59),{date:"Now",price:Math.round(prev[prev.length-1].price*(1+(Math.random()-0.5)*0.005))}]),1200);
    else clearInterval(liveRef.current);
    return()=>clearInterval(liveRef.current);
  },[isLive]);

  const filtered=ALL_LISTINGS.filter(l=>{
    const q=search.toLowerCase();
    return (province==="ALL"||l.province===province)
      &&(fuelFilter==="All"||l.fuel===fuelFilter)
      &&(l.name.toLowerCase().includes(q)||l.city.toLowerCase().includes(q)||l.make.toLowerCase().includes(q));
  });

  const score=lotScore(selected,ALL_LISTINGS);
  const evap=getEVAP(selected);
  const rebate=getRebate(selected.province,selected.fuel);
  const currentPrice=history[history.length-1]?.price??selected.price;
  const firstPrice=history[0]?.price??selected.price;
  const change=currentPrice-firstPrice;
  const avgHist=Math.round(history.reduce((s,h)=>s+h.price,0)/history.length);
  const domain=[Math.round(Math.min(...history.map(h=>h.price))*0.97),Math.round(Math.max(...history.map(h=>h.price))*1.03)];
  const comps=ALL_LISTINGS.filter(l=>l.model===selected.model&&l.id!==selected.id);
  const avgComp=comps.length?Math.round(comps.reduce((s,l)=>s+l.price,0)/comps.length):selected.price;
  const cbbData=cbb(selected);

  const tabs=[
    ["chart","📈 Price chart"],
    ["cbb",isPro?"📊 Black Book":"🔒 Black Book"],
    ["rebates","⚡ Rebates"],
    ["connect","🤝 Get a dealer"],
  ];

  return(
    <div style={{minHeight:"100vh",background:"#020617",color:"#e2e8f0",fontFamily:"'Inter','Segoe UI',sans-serif",display:"flex",flexDirection:"column"}}>

      {/* Header */}
      <div style={{background:"#060d18",borderBottom:"1px solid #1e293b",padding:"11px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:"linear-gradient(135deg,#16a34a,#0ea5e9)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>✅</div>
          <div>
            <span style={{fontWeight:800,fontSize:18,letterSpacing:"-0.5px"}}>LotCheck</span>
            <span style={{fontSize:11,color:"#334155",marginLeft:8,fontStyle:"italic"}}>Did you LotCheck it?</span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <button onClick={()=>setIsLive(!isLive)} style={{background:isLive?"#16a34a15":"transparent",border:`1px solid ${isLive?"#22c55e":"#334155"}`,borderRadius:6,padding:"5px 11px",color:isLive?"#22c55e":"#94a3b8",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",gap:5}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:isLive?"#22c55e":"#475569",display:"inline-block"}}/>
            {isLive?"Live":"Paused"}
          </button>
          {isPro
            ?<div style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:8,padding:"5px 12px",fontSize:12,color:"#22c55e",fontWeight:600}}>✅ Pro · 3 days left</div>
            :<button onClick={()=>setShowTrial(true)} style={{background:"#16a34a",border:"none",borderRadius:8,padding:"6px 14px",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700}}>Try Pro free →</button>
          }
        </div>
      </div>

      {/* Province bar */}
      <div style={{background:"#040810",borderBottom:"1px solid #1e293b",padding:"8px 16px",overflowX:"auto"}}>
        <div style={{display:"flex",gap:6,minWidth:"max-content"}}>
          <button onClick={()=>setProvince("ALL")} style={{padding:"4px 12px",background:province==="ALL"?"#1e293b":"transparent",border:`1px solid ${province==="ALL"?"#16a34a":"#1e293b"}`,borderRadius:20,color:province==="ALL"?"#e2e8f0":"#475569",cursor:"pointer",fontSize:11,whiteSpace:"nowrap",fontWeight:province==="ALL"?600:400}}>
            🇨🇦 All Canada
          </button>
          {Object.entries(PROVINCES).filter(([code])=>ALL_LISTINGS.some(l=>l.province===code)).map(([code,name])=>(
            <button key={code} onClick={()=>setProvince(code)} style={{padding:"4px 12px",background:province===code?"#1e293b":"transparent",border:`1px solid ${province===code?"#16a34a":"#1e293b"}`,borderRadius:20,color:province===code?"#e2e8f0":"#475569",cursor:"pointer",fontSize:11,whiteSpace:"nowrap",fontWeight:province===code?600:400}}>
              {code} · {ALL_LISTINGS.filter(l=>l.province===code).length}
            </button>
          ))}
        </div>
      </div>

      <div style={{display:"flex",flex:1,minHeight:0}}>

        {/* Sidebar */}
        <div style={{width:300,borderRight:"1px solid #1e293b",display:"flex",flexDirection:"column",background:"#040810"}}>
          <div style={{padding:"10px 10px 8px",borderBottom:"1px solid #1e293b"}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="LotCheck any make, model, city…"
              style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",borderRadius:8,padding:"8px 10px",color:"#e2e8f0",fontSize:12,boxSizing:"border-box",marginBottom:7}}/>
            <div style={{display:"flex",gap:4}}>
              {["All","BEV","PHEV","Hybrid","Gas"].map(f=>(
                <button key={f} onClick={()=>setFuelFilter(f)} style={{flex:1,padding:"4px 0",background:fuelFilter===f?"#1e293b":"transparent",border:`1px solid ${fuelFilter===f?"#16a34a":"#1e293b"}`,borderRadius:5,color:fuelFilter===f?"#e2e8f0":"#475569",cursor:"pointer",fontSize:10,fontWeight:fuelFilter===f?600:400}}>{f}</button>
              ))}
            </div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"8px",display:"flex",flexDirection:"column",gap:6}}>
            {filtered.length===0&&<div style={{color:"#475569",fontSize:12,textAlign:"center",padding:"30px 0"}}>No listings match</div>}
            {filtered.map(l=><ListingCard key={l.id} listing={l} onClick={setSelected} selected={selected.id===l.id} all={ALL_LISTINGS}/>)}
          </div>
          <div style={{borderTop:"1px solid #1e293b",padding:"7px 12px",fontSize:10,color:"#1e293b",display:"flex",justifyContent:"space-between"}}>
            <span>{filtered.length} listings · LotCheck</span>
            <span>Kijiji · FB Marketplace</span>
          </div>
        </div>

        {/* Main panel */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto"}}>
          <div style={{padding:"16px 22px 0",borderBottom:"1px solid #1e293b"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:19,fontWeight:800,color:"#f1f5f9",letterSpacing:"-0.5px",marginBottom:4}}>{selected.name}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <FuelBadge fuel={selected.fuel}/>
                  <ScorePill score={score}/>
                  <SourceBadge source={selected.source}/>
                  <span style={{fontSize:12,color:"#475569"}}>{selected.city}, {PROVINCES[selected.province]}</span>
                  {evap&&<EVAPBadge evap={evap}/>}
                </div>
              </div>
              {!isPro&&<button onClick={()=>setShowTrial(true)} style={{background:"#0d2010",border:"1px solid #16a34a40",borderRadius:8,padding:"6px 12px",color:"#22c55e",cursor:"pointer",fontSize:12,fontWeight:600}}>✅ Unlock Pro</button>}
            </div>
            <div style={{display:"flex",alignItems:"baseline",gap:14,padding:"8px 0 0",flexWrap:"wrap"}}>
              <div style={{fontSize:34,fontWeight:800,color:"#f1f5f9",letterSpacing:"-1px"}}>${currentPrice.toLocaleString()}</div>
              <div style={{fontSize:13,fontWeight:600,color:change>=0?"#ef4444":"#22c55e"}}>{change>=0?"▲":"▼"} ${Math.abs(change).toLocaleString()} ({change>=0?"+":""}{((change/firstPrice)*100).toFixed(1)}%) 60d</div>
              {rebate.total>0&&<div style={{fontSize:13,color:"#22c55e",fontWeight:700}}>After all rebates: ${(currentPrice-rebate.total).toLocaleString()}</div>}
            </div>
            <div style={{display:"flex",gap:0,marginTop:12}}>
              {tabs.map(([t,label])=>(
                <button key={t} onClick={()=>{if(t==="cbb"&&!isPro){setShowTrial(true);return;}setTab(t);}}
                  style={{padding:"7px 14px",background:"transparent",border:"none",borderBottom:`2px solid ${tab===t?"#16a34a":"transparent"}`,color:tab===t?"#22c55e":"#475569",cursor:"pointer",fontSize:12,fontWeight:tab===t?600:400}}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div style={{padding:"16px 22px",flex:1}}>

            {tab==="chart"&&<>
              <div style={{fontSize:11,color:"#475569",marginBottom:8}}>60-day price history · {selected.city} · LotCheck</div>
              <div style={{height:200,marginBottom:16}}>
                <ResponsiveContainer>
                  <LineChart data={history} margin={{top:4,right:10,bottom:0,left:4}}>
                    <XAxis dataKey="date" tick={{fontSize:10,fill:"#475569"}} interval={10} tickLine={false} axisLine={false}/>
                    <YAxis domain={domain} tick={{fontSize:10,fill:"#475569"}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} tickLine={false} axisLine={false} width={40}/>
                    <Tooltip formatter={v=>[`$${v.toLocaleString()}`,"Price"]} contentStyle={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:8,fontSize:12}} labelStyle={{color:"#aaa"}} itemStyle={{color:"#22c55e"}}/>
                    <ReferenceLine y={avgHist} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1} label={{value:`avg $${(avgHist/1000).toFixed(1)}k`,fill:"#f59e0b",fontSize:10,position:"insideTopRight"}}/>
                    <Line type="monotone" dataKey="price" stroke="#16a34a" strokeWidth={2} dot={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
                {[["Asking",`$${selected.price.toLocaleString()}`],["LotScore",`${score}/100`],[`Avg ${selected.model}`,`$${avgComp.toLocaleString()}`],["Location",`${selected.city}, ${selected.province}`]].map(([l,v])=>(
                  <div key={l} style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:9,padding:"10px 12px"}}>
                    <div style={{fontSize:10,color:"#475569",marginBottom:2}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{v}</div>
                  </div>
                ))}
              </div>
              {comps.length>0&&<>
                <div style={{fontSize:11,color:"#475569",marginBottom:7}}>Similar {selected.model} listings · LotChecked</div>
                {comps.slice(0,4).map(c=>{
                  const diff=c.price-selected.price; const ce=getEVAP(c);
                  return(
                    <div key={c.id} onClick={()=>setSelected(c)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:8,padding:"9px 12px",cursor:"pointer",marginBottom:5}}>
                      <div><div style={{fontSize:12,color:"#cbd5e1",fontWeight:500}}>{c.name}</div>
                      <div style={{display:"flex",gap:4,marginTop:2}}><span style={{fontSize:10,color:"#475569"}}>{c.km.toLocaleString()} km</span><FuelBadge fuel={c.fuel}/>{ce&&<EVAPBadge evap={ce}/>}</div></div>
                      <div style={{textAlign:"right"}}><div style={{fontSize:13,fontWeight:700,color:"#f1f5f9"}}>${c.price.toLocaleString()}</div>
                      <div style={{fontSize:10,color:diff>0?"#ef4444":"#22c55e"}}>{diff>0?`+$${diff.toLocaleString()}`:diff===0?"same":`-$${Math.abs(diff).toLocaleString()}`}</div></div>
                    </div>
                  );
                })}
              </>}
            </>}

            {tab==="cbb"&&isPro&&<>
              <div style={{background:"#0d1e3a",border:"1px solid #1e3a5f",borderRadius:12,padding:"16px 18px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#3b82f6",letterSpacing:1}}>CANADIAN BLACK BOOK</span>
                  <span style={{fontSize:10,background:"#3b82f620",color:"#3b82f6",borderRadius:4,padding:"1px 6px",border:"1px solid #3b82f630"}}>PRO</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
                  {[["Retail",cbbData.retail,"#22c55e"],["Trade-in",cbbData.trade,"#f59e0b"],["Wholesale",cbbData.wholesale,"#94a3b8"]].map(([l,v,c])=>(
                    <div key={l} style={{background:"#0a1628",borderRadius:8,padding:"10px 12px"}}>
                      <div style={{fontSize:10,color:"#475569",marginBottom:2}}>{l}</div>
                      <div style={{fontSize:16,fontWeight:700,color:c}}>${v.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <div style={{background:"#0a1628",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#475569"}}>
                  Spread vs trade-in: <strong style={{color:selected.price-cbbData.trade>5000?"#ef4444":"#22c55e"}}>{selected.price-cbbData.trade>0?"+":"-"}${Math.abs(selected.price-cbbData.trade).toLocaleString()}</strong>
                  · {selected.price-cbbData.trade>5000?"High margin room":"Normal dealer spread"}
                </div>
              </div>
            </>}

            {tab==="rebates"&&<>
              <div style={{fontSize:11,color:"#475569",marginBottom:12}}>All available rebates · {PROVINCES[selected.province]||selected.province}</div>
              {rebate.total>0?<>
                <div style={{background:"#0d2010",border:"1px solid #16a34a30",borderRadius:12,padding:"14px 16px",marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#22c55e",marginBottom:10}}>⚡ LotCheck found rebates for this vehicle</div>
                  {rebate.federal>0&&<div style={{display:"flex",justifyContent:"space-between",background:"#0a1e10",borderRadius:7,padding:"8px 12px",marginBottom:6}}>
                    <div><div style={{fontSize:12,color:"#e2e8f0",fontWeight:500}}>Federal EVAP</div><div style={{fontSize:10,color:"#475569"}}>Transport Canada · all provinces</div></div>
                    <div style={{fontSize:15,fontWeight:700,color:"#22c55e"}}>${rebate.federal.toLocaleString()}</div>
                  </div>}
                  {rebate.provincial>0&&<div style={{display:"flex",justifyContent:"space-between",background:"#0a1e10",borderRadius:7,padding:"8px 12px",marginBottom:6}}>
                    <div><div style={{fontSize:12,color:"#e2e8f0",fontWeight:500}}>{rebate.prov_name}</div><div style={{fontSize:10,color:"#475569"}}>Provincial · {PROVINCES[selected.province]} residents</div></div>
                    <div style={{fontSize:15,fontWeight:700,color:"#3b82f6"}}>${rebate.provincial.toLocaleString()}</div>
                  </div>}
                  <div style={{display:"flex",justifyContent:"space-between",background:"#052010",borderRadius:8,padding:"10px 14px"}}>
                    <span style={{fontSize:13,color:"#94a3b8"}}>Total stacked rebates</span>
                    <span style={{fontSize:18,fontWeight:700,color:"#22c55e"}}>${rebate.total.toLocaleString()}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",background:"#052010",borderRadius:8,padding:"10px 14px",marginTop:6}}>
                    <span style={{fontSize:13,color:"#94a3b8"}}>After all rebates</span>
                    <span style={{fontSize:18,fontWeight:700,color:"#f1f5f9"}}>${(selected.price-rebate.total).toLocaleString()}</span>
                  </div>
                  {rebate.note&&<div style={{fontSize:11,color:"#475569",marginTop:8}}>{rebate.note}</div>}
                </div>
              </>:<div style={{background:"#1a0a0a",border:"1px solid #7f1d1d30",borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:13,color:"#64748b"}}>No EV/PHEV rebates apply to this vehicle in {PROVINCES[selected.province]||selected.province}.</div>
              </div>}
            </>}

            {tab==="connect"&&<>
              <div style={{fontSize:11,color:"#475569",marginBottom:12}}>Connect with a dealer for this vehicle · Free · LotCheck handles everything</div>
              <div style={{background:"#0a0f1e",border:"1px solid #1e293b",borderRadius:12,padding:"16px 18px",marginBottom:12}}>
                <div style={{fontSize:14,fontWeight:600,color:"#f1f5f9",marginBottom:4}}>{selected.name}</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:6}}><FuelBadge fuel={selected.fuel}/><span style={{fontSize:12,color:"#64748b"}}>{selected.km.toLocaleString()} km</span></div>
                  <span style={{fontSize:18,fontWeight:700,color:"#f1f5f9"}}>${selected.price.toLocaleString()}</span>
                </div>
                {rebate.total>0&&<div style={{fontSize:11,color:"#22c55e",fontWeight:600,marginTop:6}}>⚡ After rebates: ~${(selected.price-rebate.total).toLocaleString()}</div>}
              </div>
              <button onClick={()=>setShowConnect(true)} style={{width:"100%",background:"#16a34a",border:"none",borderRadius:12,padding:"14px 0",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:10}}>
                <span>🤝</span> Connect me with a dealer
                {rebate.total>0&&<span style={{background:"rgba(255,255,255,0.2)",borderRadius:5,padding:"2px 8px",fontSize:12}}>⚡ ${rebate.total.toLocaleString()} rebate available</span>}
              </button>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {["Dealer gets your details by email instantly","You get a confirmation from LotCheck","Dealer calls within 2 hours","Free for you — dealer pays LotCheck $100"].map((s,i)=>(
                  <div key={i} style={{display:"flex",gap:8,alignItems:"center",fontSize:12,color:"#475569"}}>
                    <span style={{color:"#16a34a"}}>✅</span>{s}
                  </div>
                ))}
              </div>
            </>}

          </div>
        </div>
      </div>

      {showTrial&&<TrialModal onStart={()=>{setIsPro(true);setShowTrial(false);}} onClose={()=>setShowTrial(false)}/>}
      {showConnect&&<ConnectModal listing={selected} onClose={()=>setShowConnect(false)}/>}
      <style>{`*{box-sizing:border-box}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:4px}input::placeholder{color:#334155}select option{background:#0f172a}`}</style>
    </div>
  );
}
