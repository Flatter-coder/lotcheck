// The Deal Orrery — the buyer's quote as a navigable 3D hologram (Prometheus
// orrery, applied to the deal). Reads the SAME analysis the report already
// computes: quote at the core, fees/add-ons orbiting (sized by $, flagged =
// red), MSRP as the reference ring the deal floats above when it's over MSRP.
// Real Three.js/WebGL. Verified rendering before ship (nothing-published rule).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
// The same rule the edge functions and every other surface use.
import { qualifyMsrpClaim } from "../supabase/functions/_shared/msrp-claim.ts";

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-CA");

export default function DealOrrery({ analysis, height = 520 }) {
  const ref = useRef(null);
  useEffect(() => {
    const app = ref.current;
    if (!app) return;
    const W = () => app.clientWidth || 800;
    const H = () => height;

    const asking = Number(analysis?.quotedPrice) || 0;
    const msrp = Number(analysis?.msrp) || 0;
    // This view had NO basis check anywhere, so it was wrong in both directions
    // from the same ungated subtraction: it floated the quote above the ring and
    // said "$2,485 over MSRP" off a dealer's own unverified sticker, and it told
    // a used truck sitting $27,400 below its original sticker that it was "at
    // MSRP" — destroying the buyer's leverage rather than inventing an
    // accusation. One toggle away from the Scroll view saying the opposite.
    const claim = qualifyMsrpClaim(analysis);
    const vehicle = analysis?.vehicle || [analysis?.year, analysis?.make, analysis?.model].filter(Boolean).join(" ") || "Your vehicle";
    const fees = (analysis?.addOns || [])
      .filter((x) => Number(x?.price) > 0)
      .map((x) => ({ name: x.name || "Fee", amount: Number(x.price), flagged: x.verdict === "flagged" }))
      .sort((a, b) => b.amount - a.amount);

    let raf = 0, disposed = false;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04050c, 0.018);
    const camera = new THREE.PerspectiveCamera(55, W() / H(), 0.1, 400);
    camera.position.set(15, 11, 21);
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch (e) { app.innerHTML = '<div style="color:#8f97c4;font-size:13px;padding:24px;text-align:center">3D view needs WebGL — try the Scroll or Report view.</div>'; return; }
    renderer.setSize(W(), H());
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    app.appendChild(renderer.domElement);
    const labelR = new CSS2DRenderer();
    labelR.setSize(W(), H());
    Object.assign(labelR.domElement.style, { position: "absolute", top: "0", left: "0", pointerEvents: "none" });
    app.appendChild(labelR.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.06; controls.minDistance = 9; controls.maxDistance = 70;

    scene.add(new THREE.AmbientLight(0x8899ff, 0.6));
    const key = new THREE.PointLight(0x35e0d0, 120, 140); key.position.set(0, 7, 0); scene.add(key);

    // starfield
    const sg = new THREE.BufferGeometry(); const N = 800; const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const r = 60 + Math.random() * 120, t = Math.random() * 6.283, p = Math.acos(2 * Math.random() - 1); pos[i*3]=r*Math.sin(p)*Math.cos(t); pos[i*3+1]=r*Math.cos(p); pos[i*3+2]=r*Math.sin(p)*Math.sin(t); }
    sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x8b7be6, size: 0.5, transparent: true, opacity: 0.7 })));

    const disposables = [sg];
    const halo = (color, size) => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
      const col = new THREE.Color(color), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, `rgba(${col.r*255|0},${col.g*255|0},${col.b*255|0},.9)`); g.addColorStop(0.4, `rgba(${col.r*255|0},${col.g*255|0},${col.b*255|0},.25)`); g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g; x.fillRect(0, 0, 128, 128); const t = new THREE.Texture(c); t.needsUpdate = true;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })); s.scale.set(size, size, 1); return s;
    };
    const mkLabel = (html, color) => {
      const d = document.createElement("div");
      d.style.cssText = `color:${color||"#dfe6ff"};font:800 12px 'Nunito',system-ui,sans-serif;white-space:nowrap;text-shadow:0 0 8px rgba(0,0,0,.9);pointer-events:none`;
      d.innerHTML = html; return new CSS2DObject(d);
    };

    // MSRP reference ring
    if (msrp > 0) {
      const ringM = new THREE.MeshBasicMaterial({ color: 0x35e0d0, transparent: true, opacity: 0.55 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.06, 12, 120), ringM); ring.rotation.x = Math.PI / 2; scene.add(ring);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshBasicMaterial({ color: 0x35e0d0, transparent: true, opacity: 0.05, side: THREE.DoubleSide })); disc.rotation.x = -Math.PI / 2; scene.add(disc);
      const ml = mkLabel(claim.label.toUpperCase().replace(/^MSRP · /, "MSRP · ") + " " + money(msrp), "#5ff0e0"); ml.position.set(9.3, 0, 0); scene.add(ml);
      disposables.push(ring.geometry, disc.geometry);
      scene.userData.ring = ring;
    }

    // core = the quote, lifted above the ring by how far over MSRP it is
    const over = claim.comparable ? (claim.delta ?? 0) : 0;
    const coreY = Math.max(0, over) / 900;
    const core = new THREE.Group(); core.position.y = coreY; scene.add(core);
    const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 1), new THREE.MeshStandardMaterial({ color: 0x0b3b39, emissive: 0x35e0d0, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.35, flatShading: true }));
    core.add(coreMesh); core.add(halo(0x35e0d0, 10));
    disposables.push(coreMesh.geometry);
    const priceTxt = asking > 0 ? `<b style="color:#5ff0e0">${money(asking)}</b>` : "";
    // "at MSRP" is only sayable when we are actually allowed to compare. When we
    // are not, the ring is a reference the deal sits near, not a verdict.
    const overTxt = !claim.comparable ? ""
      : over > 0 ? ` · <span style="color:#ff8f77">${money(over)} over MSRP</span>`
      : over < 0 ? ` · <span style="color:#5ff0e0">${money(-over)} under MSRP</span>`
      : " · at MSRP";
    const cl = mkLabel(`<span style="font-size:14px;color:#fff">${vehicle}${priceTxt ? "<br>" + priceTxt + overTxt : ""}</span>`, "#fff"); cl.position.set(0, 3.2, 0); core.add(cl);
    if (coreY > 0.2) { const th = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -coreY, 0), new THREE.Vector3(0, 0, 0)]), new THREE.LineDashedMaterial({ color: 0xff8f77, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity: 0.6 })); th.computeLineDistances(); core.add(th); }

    // orbiting fees
    const maxAmt = Math.max(1, ...fees.map((f) => f.amount));
    const orbits = [];
    fees.forEach((f, i) => {
      const rad = 6.5 + i * 2.2;
      const pivot = new THREE.Group(); pivot.rotation.x = (-14 + i * 5) * Math.PI / 180; pivot.rotation.z = i * 7 * Math.PI / 180; pivot.rotation.y = i * 1.1; core.add(pivot);
      const pts = []; for (let a = 0; a <= 64; a++) { const t = a / 64 * 6.283; pts.push(new THREE.Vector3(Math.cos(t) * rad, 0, Math.sin(t) * rad)); }
      const pg = new THREE.BufferGeometry().setFromPoints(pts);
      pivot.add(new THREE.Line(pg, new THREE.LineBasicMaterial({ color: f.flagged ? 0xff6a4d : 0x8b7be6, transparent: true, opacity: 0.28 })));
      disposables.push(pg);
      const bp = new THREE.Group(); pivot.add(bp);
      const size = 0.5 + 1.4 * Math.sqrt(f.amount / maxAmt); const col = f.flagged ? 0xff6a4d : 0x8b7be6;
      const bg = new THREE.SphereGeometry(size, 24, 24);
      const body = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.4 })); body.position.x = rad; bp.add(body);
      disposables.push(bg);
      const h = halo(col, size * 4.2); h.position.x = rad; bp.add(h);
      const bl = mkLabel(`${f.name} <span style="font-family:ui-monospace,monospace">${money(f.amount)}</span>${f.flagged ? " ⚑" : ""}`, f.flagged ? "#ff8f77" : "#b3a6ff"); bl.position.set(rad, size + 0.9, 0); bp.add(bl);
      orbits.push({ bp, speed: 0.18 + (fees.length - i) * 0.03 });
    });

    const onResize = () => { if (!renderer) return; camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); labelR.setSize(W(), H()); };
    window.addEventListener("resize", onResize);

    let t0 = 0;
    const loop = (t) => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      const dt = (t - t0) / 1000 || 0; t0 = t;
      orbits.forEach((o) => (o.bp.rotation.y += o.speed * dt));
      core.rotation.y += 0.15 * dt; coreMesh.rotation.x += 0.1 * dt;
      if (scene.userData.ring) scene.userData.ring.rotation.z += 0.05 * dt;
      controls.update(); renderer.render(scene, camera); labelR.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize);
      controls.dispose();
      disposables.forEach((d) => d && d.dispose && d.dispose());
      scene.traverse((o) => { if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose && m.dispose(); }); } });
      renderer.dispose();
      if (app) app.innerHTML = "";
    };
  }, [analysis, height]);

  return <div ref={ref} style={{ position: "relative", width: "100%", height, background: "radial-gradient(120% 90% at 50% -10%,#0e1030,#04050c 60%)", borderRadius: 14, overflow: "hidden" }} />;
}
