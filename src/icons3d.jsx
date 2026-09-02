// ─────────────────────────────────────────────────────────────────────────────
// LotCheck 3D icon set.
//
// Replaces every emoji that was doing an icon's job in the UI. Emoji were the
// wrong tool twice over: they are out of product UI by rule, and the glyph is
// whatever the device happens to ship — so a report looked like a different
// product on Android than it did on macOS, and the one thing a buyer is meant
// to trust is that the report is the same everywhere.
//
// WHAT MAKES THESE 3D rather than flat glyphs, consistently across the set:
//   · one light source, upper-left, on every icon
//   · a lit face and a darker turned face, or a gradient that rolls the form
//     away from that light
//   · a specular highlight where the light would actually land
//   · a contact shadow or darker rim so the object sits on the surface
//
// EACH ANIMATION DESCRIBES ITS SUBJECT. Nothing spins for decoration: bars
// grow, sand falls, the clock hand sweeps, the bolt discharges, the truck
// drives, the magnifier hunts. If an icon's motion could be swapped onto
// another icon without looking wrong, it is the wrong motion.
//
// Every icon carries its own colour rather than inheriting the theme, because
// these sit on both the dark report surface and the light admin card. Motion
// stops under prefers-reduced-motion; the lighting stays, so an icon still
// reads as an object when it is still.
// ─────────────────────────────────────────────────────────────────────────────

export const ICON3D_CSS = `
@keyframes i3Bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.1px)}}
@keyframes i3Drive{0%{transform:translateX(-1.3px)}50%{transform:translateX(1.3px)}100%{transform:translateX(-1.3px)}}
@keyframes i3Roll{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes i3Spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes i3Sweep{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes i3Tick{0%,100%{transform:rotate(0)}50%{transform:rotate(180deg)}}
@keyframes i3Flash{0%,72%,100%{opacity:1}78%{opacity:.25}84%{opacity:1}90%{opacity:.4}}
@keyframes i3Glow{0%,100%{opacity:.28}50%{opacity:.6}}
@keyframes i3Pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}
@keyframes i3Grow{0%{transform:scaleY(.45)}55%,100%{transform:scaleY(1)}}
@keyframes i3Sand{0%{transform:translateY(-2px);opacity:0}25%{opacity:1}90%{transform:translateY(4px);opacity:1}100%{opacity:0}}
@keyframes i3Flip{0%,100%{transform:rotate(0)}50%{transform:rotate(180deg)}}
@keyframes i3Hunt{0%,100%{transform:translate(0,0)}30%{transform:translate(1.6px,-1.2px)}65%{transform:translate(-1.3px,1px)}}
@keyframes i3Rise{0%{transform:translateY(2.5px);opacity:0}30%{opacity:1}100%{transform:translateY(-3.5px);opacity:0}}
@keyframes i3Shake{0%,88%,100%{transform:rotate(0)}92%{transform:rotate(-7deg)}96%{transform:rotate(7deg)}}
@keyframes i3Fill{0%{transform:scaleX(.25)}100%{transform:scaleX(1)}}
@keyframes i3Shine{0%{transform:translateX(-14px)}55%,100%{transform:translateX(16px)}}
@keyframes i3Wave{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}
.i3-bob{animation:i3Bob 2.8s ease-in-out infinite}
.i3-drive{animation:i3Drive 3.2s ease-in-out infinite}
.i3-roll{animation:i3Roll 1.5s linear infinite;transform-box:fill-box;transform-origin:center}
.i3-spin{animation:i3Spin 4.5s linear infinite;transform-box:fill-box;transform-origin:center}
.i3-sweep{animation:i3Sweep 6s linear infinite;transform-box:fill-box;transform-origin:center}
.i3-tick{animation:i3Tick 4s steps(2,end) infinite;transform-box:fill-box;transform-origin:center}
.i3-flash{animation:i3Flash 3.4s ease-in-out infinite}
.i3-glow{animation:i3Glow 3s ease-in-out infinite}
.i3-pulse{animation:i3Pulse 2.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.i3-grow{animation:i3Grow 3s ease-in-out infinite;transform-box:fill-box;transform-origin:bottom}
.i3-sand{animation:i3Sand 2.2s linear infinite}
.i3-flip{animation:i3Flip 5s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.i3-hunt{animation:i3Hunt 4.2s ease-in-out infinite}
.i3-rise{animation:i3Rise 2.6s ease-in-out infinite}
.i3-shake{animation:i3Shake 4.6s ease-in-out infinite;transform-box:fill-box;transform-origin:top center}
.i3-fill{animation:i3Fill 3.4s ease-in-out infinite alternate;transform-box:fill-box;transform-origin:left}
.i3-shine{animation:i3Shine 4.4s ease-in-out infinite}
.i3-wave{animation:i3Wave 3s ease-in-out infinite;transform-box:fill-box;transform-origin:bottom center}
.i3-d2{animation-delay:.28s}
.i3-d3{animation-delay:.56s}
.i3-d4{animation-delay:.84s}
@media (prefers-reduced-motion:reduce){
  .i3-bob,.i3-drive,.i3-roll,.i3-spin,.i3-sweep,.i3-tick,.i3-flash,.i3-glow,.i3-pulse,
  .i3-grow,.i3-sand,.i3-flip,.i3-hunt,.i3-rise,.i3-shake,.i3-fill,.i3-shine,.i3-wave{animation:none}
}
`;

// Injected once, on import, rather than mounted by each surface.
//
// Icons render on five different roots here — the app, the admin panel, the
// founders panel, the verify page and the shared-report view — and a surface
// that forgot to mount the stylesheet would still render every icon, just
// frozen. That is a bug nobody reports and nobody sees in review, so the
// stylesheet is not something a caller can forget.
let injected = false;
function injectIcon3DCss(){
  if(injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.setAttribute("data-lc-icons3d","");
  el.textContent = ICON3D_CSS;
  document.head.appendChild(el);
}
injectIcon3DCss();

// Still exported for anywhere that renders outside the document head's reach.
export function Icon3DStyles(){ return <style>{ICON3D_CSS}</style>; }

// A lit face and its turned face, in one place, so all 35 icons agree on where
// the light is instead of each one guessing.
function Lit({id,from,mid,to}){
  return (
    <linearGradient id={id} x1="18%" y1="6%" x2="82%" y2="96%">
      <stop offset="0%" stopColor={from}/>
      {mid&&<stop offset="48%" stopColor={mid}/>}
      <stop offset="100%" stopColor={to}/>
    </linearGradient>
  );
}
function Ball({id,from,mid,to}){
  return (
    <radialGradient id={id} cx="34%" cy="27%" r="80%">
      <stop offset="0%" stopColor={from}/>
      {mid&&<stop offset="46%" stopColor={mid}/>}
      <stop offset="100%" stopColor={to}/>
    </radialGradient>
  );
}
// The contact shadow. Without it every icon floats.
function Ground({cx=12,cy=21.2,rx=7,o=.20}){
  return <ellipse cx={cx} cy={cy} rx={rx} ry="1.35" fill="#000" opacity={o}/>;
}

const I = {
  // ── success ───────────────────────────────────────────────────────────────
  // Vic keeps the checkmarks, so this is a check — given a body, a rim and a
  // light, and landing rather than merely appearing.
  check:()=>(<>
    <defs><Ball id="i3-check-a" from="#8FF3CE" mid="#2FCB92" to="#0C7C56"/></defs>
    <Ground o={.18}/>
    <g className="i3-pulse">
      <circle cx="12" cy="11.4" r="8.4" fill="url(#i3-check-a)"/>
      <ellipse cx="9.3" cy="7.6" rx="2.9" ry="1.9" fill="#EAFFF6" opacity=".45"/>
      <circle cx="12" cy="11.4" r="8.4" fill="none" stroke="#075A3E" strokeOpacity=".4" strokeWidth=".8"/>
      <path d="M7.9 11.6l2.8 2.8 5.5-5.7" fill="none" stroke="#04372A" strokeOpacity=".35" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7.7 11.3l2.8 2.8 5.5-5.7" fill="none" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"/>
    </g>
  </>),

  // ── vehicles ──────────────────────────────────────────────────────────────
  car:()=>(<>
    <defs>
      <Lit id="i3-car-a" from="#8FC2FF" mid="#3E86E8" to="#1B4E9B"/>
      <Lit id="i3-car-b" from="#DCEBFF" to="#9DC4F2"/>
    </defs>
    <Ground cy={20.4} rx={8}/>
    <g className="i3-drive">
      <path d="M4.2 15.4c0-1 .5-2.4 1.3-3l1.7-2.5C7.7 9 8.6 8.5 9.6 8.5h4.8c1 0 1.9.5 2.4 1.4l1.7 2.5c.8.6 1.3 2 1.3 3v1.5c0 .6-.5 1-1 1h-.9v.6c0 .6-.5 1-1.1 1h-1c-.6 0-1.1-.4-1.1-1v-.6H9.3v.6c0 .6-.5 1-1.1 1h-1c-.6 0-1.1-.4-1.1-1v-.6h-.8c-.6 0-1-.4-1-1z" fill="url(#i3-car-a)"/>
      <path d="M8.6 10.4c.2-.4.6-.6 1-.6h4.8c.4 0 .8.2 1 .6l1.3 2.1H7.3z" fill="url(#i3-car-b)"/>
      <ellipse cx="8.4" cy="13.9" rx="1.5" ry=".85" fill="#EAF3FF" opacity=".5"/>
      <circle cx="8.5" cy="16.1" r="1.05" fill="#12305E"/><circle cx="8.5" cy="16.1" r=".42" fill="#B9D3F5"/>
      <circle cx="15.5" cy="16.1" r="1.05" fill="#12305E"/><circle cx="15.5" cy="16.1" r=".42" fill="#B9D3F5"/>
    </g>
  </>),

  truck:()=>(<>
    <defs>
      <Lit id="i3-truck-a" from="#FFE9A8" mid="#F2B33C" to="#B26F09"/>
      <Lit id="i3-truck-b" from="#C9D6EA" to="#7C8CA6"/>
    </defs>
    <Ground cy={20.4} rx={8.4}/>
    <g className="i3-drive">
      <rect x="2.6" y="8.4" width="10.2" height="8" rx="1.1" fill="url(#i3-truck-a)"/>
      <rect x="2.6" y="8.4" width="10.2" height="2.5" rx="1.1" fill="#FFF3CE" opacity=".45"/>
      <path d="M12.8 10.9h3.5c.4 0 .8.2 1 .6l1.9 2.8c.2.3.3.6.3.9v1.2c0 .6-.5 1-1 1h-5.7z" fill="url(#i3-truck-b)"/>
      <rect x="13.9" y="11.9" width="2.9" height="2.1" rx=".4" fill="#DCE6F5" opacity=".8"/>
      <circle cx="6.6" cy="17.1" r="1.35" fill="#2A2438"/><circle cx="6.6" cy="17.1" r=".52" fill="#B9B2CE"/>
      <circle cx="15.6" cy="17.1" r="1.35" fill="#2A2438"/><circle cx="15.6" cy="17.1" r=".52" fill="#B9B2CE"/>
    </g>
  </>),

  fuel:()=>(<>
    <defs><Lit id="i3-fuel-a" from="#B9C6DC" mid="#7387A6" to="#3E4C63"/></defs>
    <Ground cy={20.6} rx={6}/>
    <g className="i3-bob">
      <rect x="4.3" y="5.4" width="8" height="14" rx="1.3" fill="url(#i3-fuel-a)"/>
      <rect x="4.3" y="5.4" width="2.4" height="14" rx="1.2" fill="#E2EAF6" opacity=".34"/>
      <rect x="5.9" y="7.3" width="4.8" height="3.9" rx=".6" fill="#16233A"/>
      <rect x="6.3" y="7.7" width="1.6" height="1.5" rx=".3" fill="#7FE3C0" opacity=".85"/>
      <path d="M12.8 8.6h2.1c.7 0 1.2.6 1.2 1.3v5.2c0 .7.5 1.2 1.1 1.2s1.1-.5 1.1-1.2V10l-1.6-1.9" fill="none" stroke="#5A6A85" strokeWidth="1.35" strokeLinecap="round"/>
      <circle className="i3-glow" cx="17.2" cy="9.7" r="2.6" fill="#7FE3C0"/>
    </g>
  </>),

  // ── charts ────────────────────────────────────────────────────────────────
  chartBar:()=>(<>
    <defs><Lit id="i3-cb-a" from="#C9C2FF" mid="#7C6FE8" to="#3F339C"/></defs>
    <Ground cy={20.4} rx={7.6}/>
    <rect x="4" y="18.4" width="16" height="1.5" rx=".5" fill="#4A4270" opacity=".55"/>
    <g fill="url(#i3-cb-a)">
      <rect className="i3-grow" x="5" y="11.5" width="3.4" height="7" rx=".7"/>
      <rect className="i3-grow i3-d2" x="10.3" y="7.6" width="3.4" height="10.9" rx=".7"/>
      <rect className="i3-grow i3-d3" x="15.6" y="13.4" width="3.4" height="5.1" rx=".7"/>
    </g>
    <g fill="#EFEBFF" opacity=".42">
      <rect className="i3-grow" x="5" y="11.5" width="1.1" height="7" rx=".5"/>
      <rect className="i3-grow i3-d2" x="10.3" y="7.6" width="1.1" height="10.9" rx=".5"/>
      <rect className="i3-grow i3-d3" x="15.6" y="13.4" width="1.1" height="5.1" rx=".5"/>
    </g>
  </>),

  chartUp:()=>(<>
    <defs><Lit id="i3-cu-a" from="#9FF3D2" mid="#2FCB92" to="#0B7150"/></defs>
    <Ground cy={20.4} rx={7.6}/>
    <rect x="4" y="18.4" width="16" height="1.5" rx=".5" fill="#0B5B41" opacity=".5"/>
    <path d="M5 16.4l4.3-4.5 3.1 2.6 6-6.4" fill="none" stroke="#0A5C42" strokeOpacity=".4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.8 16.1l4.3-4.5 3.1 2.6 6-6.4" fill="none" stroke="url(#i3-cu-a)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M14.4 7.2h4.4v4.4" fill="none" stroke="url(#i3-cu-a)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    <circle className="i3-pulse" cx="18.2" cy="7.8" r="2" fill="#5FE0B0" opacity=".38"/>
  </>),

  chartDown:()=>(<>
    <defs><Lit id="i3-cd-a" from="#FFC3AC" mid="#E8663A" to="#8E2F10"/></defs>
    <Ground cy={20.4} rx={7.6}/>
    <rect x="4" y="18.4" width="16" height="1.5" rx=".5" fill="#6E2A11" opacity=".5"/>
    <path d="M5 8.2l4.3 4.5 3.1-2.6 6 6.4" fill="none" stroke="#75260C" strokeOpacity=".4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.8 7.9l4.3 4.5 3.1-2.6 6 6.4" fill="none" stroke="url(#i3-cd-a)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M14.4 16.6h4.4v-4.4" fill="none" stroke="url(#i3-cd-a)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    <circle className="i3-pulse" cx="18.2" cy="16.1" r="2" fill="#F08A63" opacity=".38"/>
  </>),

  // ── time ──────────────────────────────────────────────────────────────────
  clock:()=>(<>
    <defs><Ball id="i3-clock-a" from="#FFFFFF" mid="#CBD3EC" to="#6E769B"/></defs>
    <Ground cy={20.8} rx={6.6}/>
    <circle cx="12" cy="12" r="8.2" fill="url(#i3-clock-a)"/>
    <circle cx="12" cy="12" r="6.5" fill="#20263C"/>
    <ellipse cx="9.6" cy="8.6" rx="2.6" ry="1.7" fill="#FFFFFF" opacity=".2"/>
    <g className="i3-sweep"><rect x="11.5" y="7.4" width="1" height="5.1" rx=".5" fill="#7FE3C0"/></g>
    <g className="i3-tick"><rect x="11.6" y="8.9" width=".8" height="3.6" rx=".4" fill="#EDEFFA"/></g>
    <circle cx="12" cy="12" r=".95" fill="#EDEFFA"/>
  </>),

  hourglass:()=>(<>
    <defs><Lit id="i3-hg-a" from="#FFE7A6" mid="#F0B740" to="#A8720A"/></defs>
    <Ground cy={20.8} rx={5.6}/>
    <rect x="6.2" y="3.4" width="11.6" height="1.9" rx=".9" fill="url(#i3-hg-a)"/>
    <rect x="6.2" y="18.7" width="11.6" height="1.9" rx=".9" fill="url(#i3-hg-a)"/>
    <path d="M7.8 5.3h8.4v2.1L12 12l4.2 4.6v2.1H7.8v-2.1L12 12 7.8 7.4z" fill="#C9D4EA" opacity=".38"/>
    <path d="M8.9 6.2h6.2v1.1L12 11 8.9 7.3z" fill="url(#i3-hg-a)" opacity=".9"/>
    <path d="M9.6 17.8h4.8L12 14.4z" fill="url(#i3-hg-a)"/>
    <rect className="i3-sand" x="11.65" y="11.4" width=".7" height="2.4" rx=".35" fill="#F0B740"/>
  </>),

  calendar:()=>(<>
    <defs>
      <Lit id="i3-cal-a" from="#FFFFFF" mid="#E4E8F6" to="#AEB6D2"/>
      <Lit id="i3-cal-b" from="#8FA8FF" mid="#4F6BE0" to="#2A3E96"/>
    </defs>
    <Ground cy={20.8} rx={7}/>
    <rect x="3.6" y="5.6" width="16.8" height="14.4" rx="2" fill="url(#i3-cal-a)"/>
    <rect x="3.6" y="5.6" width="16.8" height="4.2" rx="2" fill="url(#i3-cal-b)"/>
    <rect x="3.6" y="8" width="16.8" height="1.8" fill="url(#i3-cal-b)"/>
    <rect x="6.6" y="3.2" width="1.9" height="4.2" rx=".95" fill="#7E88AC"/>
    <rect x="15.5" y="3.2" width="1.9" height="4.2" rx=".95" fill="#7E88AC"/>
    <g fill="#8E97BC">
      <rect x="6" y="11.6" width="2.6" height="2.3" rx=".5"/>
      <rect x="10.7" y="11.6" width="2.6" height="2.3" rx=".5"/>
      <rect x="15.4" y="11.6" width="2.6" height="2.3" rx=".5"/>
      <rect x="6" y="15.4" width="2.6" height="2.3" rx=".5"/>
    </g>
    <rect className="i3-pulse" x="10.7" y="15.4" width="2.6" height="2.3" rx=".5" fill="#4F6BE0"/>
  </>),

  // ── money / value ─────────────────────────────────────────────────────────
  money:()=>(<>
    <defs><Ball id="i3-money-a" from="#FFF3C2" mid="#F5C63A" to="#A9740A"/></defs>
    <Ground cy={20.6} rx={7}/>
    <g className="i3-bob">
      <ellipse cx="12" cy="16.6" rx="7" ry="2.5" fill="#8E6208"/>
      <rect x="5" y="12.4" width="14" height="4.2" fill="#B9840D"/>
      <ellipse cx="12" cy="12.4" rx="7" ry="2.5" fill="url(#i3-money-a)"/>
      <ellipse cx="12" cy="12.4" rx="4.6" ry="1.5" fill="#FFEFB0" opacity=".5"/>
      <ellipse cx="9.6" cy="11.5" rx="2" ry=".8" fill="#FFFDF0" opacity=".55"/>
      <g className="i3-shine" opacity=".5"><rect x="7" y="10.2" width="1.6" height="4.4" rx=".8" fill="#FFFFFF"/></g>
    </g>
  </>),

  // ── energy ────────────────────────────────────────────────────────────────
  bolt:()=>(<>
    <defs><Lit id="i3-bolt-a" from="#FFF6B0" mid="#FFC420" to="#C77A00"/></defs>
    <circle className="i3-glow" cx="12" cy="12" r="8.6" fill="#FFD34D"/>
    <g className="i3-flash">
      <path d="M13.6 2.6l-7.2 10h4.3l-1.4 8.8 7.3-10.4h-4.4z" fill="#8A5300" opacity=".45" transform="translate(.5 .5)"/>
      <path d="M13.6 2.6l-7.2 10h4.3l-1.4 8.8 7.3-10.4h-4.4z" fill="url(#i3-bolt-a)"/>
      <path d="M13.2 4.4l-5 6.9h2.6z" fill="#FFFBDC" opacity=".55"/>
    </g>
  </>),

  battery:()=>(<>
    <defs>
      <Lit id="i3-bat-a" from="#DCE4F4" mid="#9AA6C4" to="#5A6482"/>
      <Lit id="i3-bat-b" from="#9FF3D2" mid="#2FCB92" to="#0B7150"/>
    </defs>
    <Ground cy={20.2} rx={7.4}/>
    <rect x="2.6" y="7.4" width="16.4" height="9.2" rx="2" fill="url(#i3-bat-a)"/>
    <rect x="2.6" y="7.4" width="16.4" height="2.6" rx="2" fill="#F1F5FF" opacity=".34"/>
    <rect x="19.6" y="10.4" width="2.2" height="3.2" rx=".9" fill="#6A7492"/>
    <rect x="4.3" y="9.1" width="13" height="5.8" rx="1.1" fill="#1B2233"/>
    <rect className="i3-fill" x="5.1" y="9.9" width="11.4" height="4.2" rx=".8" fill="url(#i3-bat-b)"/>
  </>),

  // ── trust ─────────────────────────────────────────────────────────────────
  shield:()=>(<>
    <defs><Lit id="i3-sh-a" from="#A9C8FF" mid="#4472D8" to="#1D3C87"/></defs>
    <Ground cy={21} rx={5.6}/>
    <g className="i3-pulse">
      <path d="M12 2.6l7.2 2.9v5.6c0 4.5-3 8.3-7.2 9.7-4.2-1.4-7.2-5.2-7.2-9.7V5.5z" fill="url(#i3-sh-a)"/>
      <path d="M12 2.6L4.8 5.5v5.6c0 4.5 3 8.3 7.2 9.7z" fill="#DCE8FF" opacity=".2"/>
      <path d="M8.6 11.7l2.5 2.5 4.6-4.8" fill="none" stroke="#12305E" strokeOpacity=".45" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8.4 11.4l2.5 2.5 4.6-4.8" fill="none" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
    </g>
  </>),

  lock:()=>(<>
    <defs>
      <Lit id="i3-lock-a" from="#FFE6A6" mid="#F0B740" to="#A0700B"/>
      <Lit id="i3-lock-b" from="#D6DEF0" to="#7C87A6"/>
    </defs>
    <Ground cy={20.8} rx={6.2}/>
    <path d="M8.1 10.4V8.2a3.9 3.9 0 017.8 0v2.2" fill="none" stroke="url(#i3-lock-b)" strokeWidth="2.1" strokeLinecap="round"/>
    <rect x="4.9" y="10.2" width="14.2" height="9.6" rx="2.1" fill="url(#i3-lock-a)"/>
    <rect x="4.9" y="10.2" width="3.4" height="9.6" rx="2" fill="#FFF6D8" opacity=".33"/>
    <circle cx="12" cy="14.1" r="1.75" fill="#6B4A05"/>
    <rect className="i3-pulse" x="11.35" y="14.1" width="1.3" height="3.1" rx=".65" fill="#6B4A05"/>
  </>),

  // ── warning / blocked ─────────────────────────────────────────────────────
  warning:()=>(<>
    <defs><Lit id="i3-warn-a" from="#FFE293" mid="#F0A81E" to="#A65E04"/></defs>
    <Ground cy={20.6} rx={7.8}/>
    <g className="i3-shake">
      <path d="M13.5 3.6l7.3 14.1c.6 1.2-.2 2.5-1.5 2.5H4.7c-1.3 0-2.1-1.3-1.5-2.5l7.3-14.1c.6-1.2 2.4-1.2 3 0z" fill="#8A5104" opacity=".4" transform="translate(.4 .5)"/>
      <path d="M13.5 3.6l7.3 14.1c.6 1.2-.2 2.5-1.5 2.5H4.7c-1.3 0-2.1-1.3-1.5-2.5l7.3-14.1c.6-1.2 2.4-1.2 3 0z" fill="url(#i3-warn-a)"/>
      <path d="M12 3.1L4.2 18.1c-.3.7 0 1.3.5 1.6L12 3.1z" fill="#FFF3CE" opacity=".3"/>
      <rect x="11.05" y="8.4" width="1.9" height="6" rx=".95" fill="#5C3502"/>
      <circle cx="12" cy="16.6" r="1.15" fill="#5C3502"/>
    </g>
  </>),

  blocked:()=>(<>
    <defs><Ball id="i3-blk-a" from="#FFB9AE" mid="#E24B3A" to="#8B1E10"/></defs>
    <Ground cy={21} rx={6.4}/>
    <g className="i3-pulse">
      <circle cx="12" cy="12" r="8.6" fill="url(#i3-blk-a)"/>
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="#FFFFFF" strokeWidth="2"/>
      <rect x="11" y="5.4" width="2" height="13.2" rx="1" fill="#FFFFFF" transform="rotate(45 12 12)"/>
      <ellipse cx="9.4" cy="8.4" rx="2.7" ry="1.8" fill="#FFE6E0" opacity=".3"/>
    </g>
  </>),

  // ── information ───────────────────────────────────────────────────────────
  info:()=>(<>
    <defs><Ball id="i3-info-a" from="#BEDCFF" mid="#3E86E8" to="#164787"/></defs>
    <Ground cy={21} rx={6.2}/>
    <g className="i3-bob">
      <circle cx="12" cy="12" r="8.5" fill="url(#i3-info-a)"/>
      <ellipse cx="9.4" cy="8.4" rx="2.8" ry="1.9" fill="#F0F6FF" opacity=".4"/>
      <circle cx="12" cy="7.9" r="1.25" fill="#FFFFFF"/>
      <rect x="10.95" y="10.4" width="2.1" height="6.4" rx="1.05" fill="#FFFFFF"/>
    </g>
  </>),

  bulb:()=>(<>
    <defs><Ball id="i3-bulb-a" from="#FFFCE0" mid="#FFD84A" to="#C08A05"/></defs>
    <circle className="i3-glow" cx="12" cy="10.2" r="8" fill="#FFD84A"/>
    <path d="M12 2.9a6 6 0 00-3.4 10.9c.6.4 1 1.1 1 1.9v.5h4.8v-.5c0-.8.4-1.5 1-1.9A6 6 0 0012 2.9z" fill="url(#i3-bulb-a)"/>
    <ellipse cx="9.7" cy="7.2" rx="2" ry="2.7" fill="#FFFEF2" opacity=".45" transform="rotate(-22 9.7 7.2)"/>
    <rect x="9.4" y="16.7" width="5.2" height="1.7" rx=".85" fill="#8E7A2A"/>
    <rect x="9.9" y="18.9" width="4.2" height="1.6" rx=".8" fill="#6E5D1E"/>
  </>),

  // ── search ────────────────────────────────────────────────────────────────
  search:()=>(<>
    <defs>
      <Ball id="i3-srch-a" from="#EAF3FF" mid="#9FC4F0" to="#4C74AE"/>
      <Lit id="i3-srch-b" from="#D6DEF0" to="#6C7794"/>
    </defs>
    <Ground cy={21} rx={6}/>
    <g className="i3-hunt">
      <rect x="13.4" y="13.4" width="7.4" height="3.1" rx="1.55" fill="url(#i3-srch-b)" transform="rotate(45 13.4 13.4)"/>
      <circle cx="10.6" cy="10.3" r="6.6" fill="url(#i3-srch-a)" opacity=".55"/>
      <circle cx="10.6" cy="10.3" r="6.6" fill="none" stroke="url(#i3-srch-b)" strokeWidth="2.2"/>
      <ellipse cx="8.4" cy="7.9" rx="2.3" ry="1.5" fill="#FFFFFF" opacity=".5"/>
    </g>
  </>),

  // ── places / things ───────────────────────────────────────────────────────
  building:()=>(<>
    <defs>
      <Lit id="i3-bld-a" from="#C6D2EA" mid="#8A98B8" to="#4B5771"/>
      <Lit id="i3-bld-b" from="#E6EDF9" to="#A9B5CE"/>
    </defs>
    <Ground cy={20.6} rx={7.4}/>
    <rect x="4.4" y="6.4" width="8.4" height="13.4" rx="1" fill="url(#i3-bld-a)"/>
    <rect x="12.8" y="9.8" width="6.8" height="10" rx="1" fill="url(#i3-bld-b)"/>
    <rect x="4.4" y="6.4" width="2.4" height="13.4" fill="#EEF3FC" opacity=".26"/>
    <g fill="#22304A" opacity=".72">
      <rect x="6" y="8.3" width="1.9" height="1.9" rx=".35"/><rect x="9.3" y="8.3" width="1.9" height="1.9" rx=".35"/>
      <rect x="6" y="11.7" width="1.9" height="1.9" rx=".35"/><rect x="9.3" y="11.7" width="1.9" height="1.9" rx=".35"/>
      <rect x="6" y="15.1" width="1.9" height="1.9" rx=".35"/>
      <rect x="14.3" y="11.6" width="1.7" height="1.7" rx=".3"/><rect x="16.8" y="11.6" width="1.7" height="1.7" rx=".3"/>
      <rect x="14.3" y="14.7" width="1.7" height="1.7" rx=".3"/><rect x="16.8" y="14.7" width="1.7" height="1.7" rx=".3"/>
    </g>
    <rect className="i3-glow" x="9.3" y="15.1" width="1.9" height="1.9" rx=".35" fill="#7FE3C0"/>
  </>),

  map:()=>(<>
    <defs>
      <Lit id="i3-map-a" from="#CFE6D4" mid="#8FBE9C" to="#4E7A5C"/>
      <Ball id="i3-map-b" from="#FFC3AC" mid="#E2503A" to="#8B1E10"/>
    </defs>
    <Ground cy={20.8} rx={7.6}/>
    <path d="M2.8 6.4l6-2.1v13.4l-6 2.1z" fill="url(#i3-map-a)"/>
    <path d="M8.8 4.3l6.4 2.1v13.4L8.8 17.7z" fill="url(#i3-map-a)" opacity=".78"/>
    <path d="M15.2 6.4l6-2.1v13.4l-6 2.1z" fill="url(#i3-map-a)" opacity=".92"/>
    <path d="M2.8 6.4l6-2.1v3.2l-6 2.1z" fill="#F2FAF4" opacity=".28"/>
    <g className="i3-bob">
      <path d="M14.4 6.6c1.9 0 3.4 1.5 3.4 3.4 0 2.5-3.4 6-3.4 6s-3.4-3.5-3.4-6c0-1.9 1.5-3.4 3.4-3.4z" fill="url(#i3-map-b)"/>
      <circle cx="14.4" cy="9.9" r="1.35" fill="#FFF0EC"/>
    </g>
  </>),

  camera:()=>(<>
    <defs>
      <Lit id="i3-cam-a" from="#4C5670" mid="#2E3648" to="#171C28"/>
      <Ball id="i3-cam-b" from="#EAF3FF" mid="#5E93D8" to="#1E3A66"/>
    </defs>
    <Ground cy={20.6} rx={7.6}/>
    <rect x="2.8" y="7.2" width="18.4" height="11.6" rx="2.4" fill="url(#i3-cam-a)"/>
    <path d="M8.6 7.2l1.2-2h4.4l1.2 2z" fill="url(#i3-cam-a)"/>
    <rect x="2.8" y="7.2" width="18.4" height="2.4" rx="2.2" fill="#7C879E" opacity=".28"/>
    <circle cx="12" cy="13.2" r="4.3" fill="#0F1420"/>
    <circle cx="12" cy="13.2" r="3.2" fill="url(#i3-cam-b)"/>
    <ellipse cx="10.7" cy="11.9" rx="1.2" ry=".85" fill="#FFFFFF" opacity=".6"/>
    <circle className="i3-glow" cx="18.4" cy="9.6" r="1" fill="#FF8A6B"/>
  </>),

  clipboard:()=>(<>
    <defs>
      <Lit id="i3-clip-a" from="#FFF6E2" mid="#E8D6B0" to="#A8926A"/>
      <Lit id="i3-clip-b" from="#C6D2EA" to="#6C7794"/>
    </defs>
    <Ground cy={20.8} rx={6.6}/>
    <rect x="4.6" y="4.6" width="14.8" height="15.4" rx="1.9" fill="url(#i3-clip-a)"/>
    <rect x="4.6" y="4.6" width="3.2" height="15.4" fill="#FFFDF6" opacity=".38"/>
    <rect x="8.4" y="2.9" width="7.2" height="3.4" rx="1.2" fill="url(#i3-clip-b)"/>
    <g fill="#9A8763">
      <rect x="7.4" y="9.2" width="9.2" height="1.5" rx=".75"/>
      <rect x="7.4" y="12.2" width="9.2" height="1.5" rx=".75"/>
      <rect className="i3-fill" x="7.4" y="15.2" width="6" height="1.5" rx=".75"/>
    </g>
  </>),

  document:()=>(<>
    <defs><Lit id="i3-doc-a" from="#FFFFFF" mid="#E2E7F4" to="#A8B1CC"/></defs>
    <Ground cy={20.8} rx={6.2}/>
    <path d="M5.6 3.4h7.6l5.2 5.2v12a1.8 1.8 0 01-1.8 1.8H5.6a1.8 1.8 0 01-1.8-1.8V5.2a1.8 1.8 0 011.8-1.8z" fill="url(#i3-doc-a)"/>
    <path d="M13.2 3.4l5.2 5.2h-3.8a1.4 1.4 0 01-1.4-1.4z" fill="#96A0BE"/>
    <path d="M5.6 3.4h2.2v17H5.6a1.8 1.8 0 01-1.8-1.8V5.2a1.8 1.8 0 011.8-1.8z" fill="#FFFFFF" opacity=".45"/>
    <g fill="#98A2C0">
      <rect x="6.6" y="11.4" width="9.4" height="1.4" rx=".7"/>
      <rect x="6.6" y="14.2" width="9.4" height="1.4" rx=".7"/>
      <rect className="i3-fill" x="6.6" y="17" width="6.2" height="1.4" rx=".7"/>
    </g>
  </>),

  bookmark:()=>(<>
    <defs><Lit id="i3-bm-a" from="#FFC0D2" mid="#D8457A" to="#7E1B41"/></defs>
    <Ground cy={21} rx={5}/>
    <g className="i3-bob">
      <path d="M6.4 2.9h11.2c.8 0 1.4.6 1.4 1.4v16.4L12 16.4l-7 4.3V4.3c0-.8.6-1.4 1.4-1.4z" fill="url(#i3-bm-a)"/>
      <path d="M6.4 2.9h2.4v16.2l-3.8 1.6V4.3c0-.8.6-1.4 1.4-1.4z" fill="#FFE2EB" opacity=".33"/>
    </g>
  </>),

  megaphone:()=>(<>
    <defs>
      <Lit id="i3-meg-a" from="#FFD9A6" mid="#F08A3C" to="#9C4A07"/>
      <Lit id="i3-meg-b" from="#D6DEF0" to="#77839F"/>
    </defs>
    <Ground cy={20.8} rx={6.4}/>
    <g className="i3-wave">
      <path d="M4.2 9.6l11.4-5.2v15.2L4.2 14.4z" fill="url(#i3-meg-a)"/>
      <path d="M4.2 9.6l3.1-1.4v7.6l-3.1-1.4z" fill="#FFF0D8" opacity=".34"/>
      <rect x="15.6" y="3.4" width="2.8" height="17.2" rx="1.4" fill="url(#i3-meg-b)"/>
      <path d="M6.4 14.9l3 1.3v3.1a1.5 1.5 0 01-3 0z" fill="url(#i3-meg-a)" opacity=".9"/>
    </g>
    <g className="i3-glow" fill="none" stroke="#FFC06B" strokeWidth="1.5" strokeLinecap="round">
      <path d="M19.9 8.8a5 5 0 010 6.4"/>
    </g>
  </>),

  link:()=>(<>
    <defs><Lit id="i3-lnk-a" from="#B7E6FF" mid="#3FA9DE" to="#155A82"/></defs>
    <Ground cy={20.8} rx={6.4}/>
    <g className="i3-bob">
      <path d="M9.6 14.4l4.8-4.8" stroke="url(#i3-lnk-a)" strokeWidth="2.2" strokeLinecap="round" fill="none"/>
      <path d="M13.1 7.5l1.6-1.6a3.9 3.9 0 015.5 5.5l-1.6 1.6" fill="none" stroke="url(#i3-lnk-a)" strokeWidth="2.4" strokeLinecap="round"/>
      <path d="M10.9 16.5l-1.6 1.6a3.9 3.9 0 01-5.5-5.5l1.6-1.6" fill="none" stroke="url(#i3-lnk-a)" strokeWidth="2.4" strokeLinecap="round"/>
      <path d="M14.7 5.9a3.9 3.9 0 013.2 1.1l-3.2-1.1z" fill="#E2F5FF" opacity=".5"/>
    </g>
  </>),

  refresh:()=>(<>
    <defs><Lit id="i3-rf-a" from="#9FF3D2" mid="#2FCB92" to="#0B7150"/></defs>
    <Ground cy={21} rx={6.2}/>
    <g className="i3-spin">
      <path d="M12 4.4a7.6 7.6 0 016.9 4.4" fill="none" stroke="url(#i3-rf-a)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M12 19.6a7.6 7.6 0 01-6.9-4.4" fill="none" stroke="url(#i3-rf-a)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M19.6 4.9v4.2h-4.2" fill="none" stroke="url(#i3-rf-a)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4.4 19.1v-4.2h4.2" fill="none" stroke="url(#i3-rf-a)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </g>
  </>),

  celebrate:()=>(<>
    <defs><Lit id="i3-cel-a" from="#FFE3A6" mid="#F0913C" to="#9C4A07"/></defs>
    <Ground cy={20.8} rx={6.8}/>
    <path d="M3.4 20.6l4.9-11.2 6.3 6.3z" fill="url(#i3-cel-a)"/>
    <path d="M3.4 20.6l4.9-11.2 1.9 1.9z" fill="#FFF0D8" opacity=".33"/>
    <g className="i3-rise">
      <rect x="14.6" y="3.6" width="1.9" height="1.9" rx=".4" fill="#4FD8A6" transform="rotate(22 15.5 4.5)"/>
      <rect x="18.2" y="7.4" width="1.7" height="1.7" rx=".4" fill="#F0648A" transform="rotate(-18 19 8.2)"/>
      <circle cx="17" cy="12.2" r=".95" fill="#6FA8F0"/>
      <circle cx="12.8" cy="5.4" r=".85" fill="#FFD34D"/>
    </g>
  </>),

  handshake:()=>(<>
    <defs>
      <Lit id="i3-hs-a" from="#FFD9BC" mid="#E09A62" to="#8E5222"/>
      <Lit id="i3-hs-b" from="#FFE9D6" mid="#EFB98A" to="#A0663A"/>
    </defs>
    <Ground cy={20.4} rx={7.6}/>
    <g className="i3-bob">
      <path d="M2.6 10.2l3.6-2.4 4.4 3.2-2.2 2.2a1.5 1.5 0 01-2 .1L2.6 10.2z" fill="url(#i3-hs-a)"/>
      <path d="M21.4 10.2l-3.6-2.4-4.4 3.2 2.2 2.2c.6.5 1.4.5 2 .1z" fill="url(#i3-hs-b)"/>
      <path d="M8.4 11.6l2.6-2.2c.6-.5 1.4-.5 2 0l2.6 2.2-2.2 2.4c-.8.9-2.2.9-3 0z" fill="url(#i3-hs-b)"/>
      <path d="M6.2 7.8L2.6 10.2l1.4 1.4 3.4-2.4z" fill="#FFF1E2" opacity=".38"/>
    </g>
  </>),

  // ── theme ─────────────────────────────────────────────────────────────────
  // These two sit in the theme toggle, where the pill swaps backgrounds
  // underneath them — dark when Dark is active, light card when Bright is —
  // which is the reason every icon in this set carries its own light instead
  // of inheriting the theme's.
  moon:()=>(<>
    <defs>
      <Ball id="i3-moon-a" from="#FFFFFF" mid="#D6DAF2" to="#848AB6"/>
      {/* a real crescent: sphere minus an offset sphere, so the lit edge curves
          like a terminator and the craters fall off toward it */}
      <mask id="i3-moon-m">
        <rect width="24" height="24" fill="#000"/>
        <circle cx="12" cy="12" r="8.2" fill="#fff"/>
        <circle cx="17.6" cy="8.4" r="7.3" fill="#000"/>
      </mask>
    </defs>
    <circle className="i3-glow" cx="12" cy="12" r="9.7" fill="#AEB4E6"/>
    <g mask="url(#i3-moon-m)">
      <circle cx="12" cy="12" r="8.2" fill="url(#i3-moon-a)"/>
      <ellipse cx="9.0" cy="14.7" rx="1.5" ry="1.15" fill="#8F95C2" opacity=".5"/>
      <ellipse cx="7.5" cy="10.1" rx="1.0" ry=".8"  fill="#8F95C2" opacity=".42"/>
      <ellipse cx="11.1" cy="17.5" rx=".8" ry=".6"  fill="#8F95C2" opacity=".34"/>
    </g>
  </>),

  sun:()=>(<>
    <defs><Ball id="i3-sun-a" from="#FFF6D0" mid="#FFC534" to="#D97A00"/></defs>
    <g className="i3-sweep" fill="#FFB020">
      {[0,45,90,135,180,225,270,315].map(a=>(
        <rect key={a} x="11.1" y="1" width="1.8" height="3.6" rx=".9"
              transform={`rotate(${a} 12 12)`} opacity={a%90===0?.95:.58}/>
      ))}
    </g>
    <circle cx="12" cy="12" r="5.6" fill="url(#i3-sun-a)"/>
    <ellipse cx="10.1" cy="9.9" rx="1.9" ry="1.35" fill="#FFFBE8" opacity=".6"/>
    <circle cx="12" cy="12" r="5.6" fill="none" stroke="#A85B00" strokeOpacity=".3" strokeWidth=".7"/>
  </>),
};

/**
 * One icon. `name` must exist in the set — an unknown name renders nothing
 * rather than a broken box, and says so in the console, because a missing icon
 * in a report should be a gap you notice, not a glyph that looks deliberate.
 */
export function Icon3D({name,size=18,title,style,className}){
  const draw = I[name];
  if(!draw){
    if(typeof console!=="undefined") console.warn(`Icon3D: no icon named "${name}"`);
    return null;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" data-icon={name}
         role={title?"img":undefined} aria-hidden={title?undefined:"true"}
         focusable="false" className={className}
         style={{display:"inline-block",verticalAlign:"-0.15em",flexShrink:0,...style}}>
      {title&&<title>{title}</title>}
      {draw()}
    </svg>
  );
}

export const ICON3D_NAMES = Object.keys(I);
