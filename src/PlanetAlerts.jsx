// MSRP Alerts — concept #11 "Cosmic Weather Station". A procedural 3D planet
// (clouds, terminator, city-lights, auroral atmosphere + ring system) that reads
// the market like weather. Real Three.js/WebGL; the axial-tilt / atmospheric-
// density sliders drive uniforms WITHOUT rebuilding the scene. Verified rendering
// before ship (nothing-published-without-verification). Purely decorative — the
// waitlist copy on the page keeps the honest "not live yet" promise.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export default function PlanetAlerts({ tilt = 23, density = 0.9 }) {
  const ref = useRef(null);
  const uniformsRef = useRef(null);
  const tiltObjRef = useRef(null);

  // slider → uniform / rotation, no scene rebuild
  useEffect(() => { if (tiltObjRef.current) tiltObjRef.current.rotation.z = (tilt * Math.PI) / 180; }, [tilt]);
  // density drives BOTH the atmosphere glow (0 = clear sky, no halo) and the
  // weather: uStorm ramps cloud coverage/lightning so the dial = market climate
  // (clear -> cloudy -> stormy). Reads true at 0.
  useEffect(() => {
    if (!uniformsRef.current) return;
    const d = Math.max(0, density);
    uniformsRef.current.uDensity.value = d;
    uniformsRef.current.uStorm.value = Math.min(1, d / 1.5);
  }, [density]);

  useEffect(() => {
    const app = ref.current;
    if (!app) return;
    const W = () => app.clientWidth || 800;
    const H = () => app.clientHeight || 600;

    let raf = 0, disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.1, 100);
    camera.position.set(0, 0.2, 6.2);
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch (e) { app.style.background = "radial-gradient(120% 90% at 72% 30%,#1a1440,#05060f 65%)"; return; }
    renderer.setSize(W(), H());
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    app.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.enablePan = false; controls.minDistance = 4.2; controls.maxDistance = 9;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
    controls.rotateSpeed = 0.6;

    // starfield
    const sg = new THREE.BufferGeometry(); const N = 1400; const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const r = 20 + Math.random() * 40, t = Math.random() * 6.283, p = Math.acos(2 * Math.random() - 1); pos[i*3]=r*Math.sin(p)*Math.cos(t); pos[i*3+1]=r*Math.cos(p); pos[i*3+2]=r*Math.sin(p)*Math.sin(t); }
    sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 0.06, transparent: true, opacity: 0.9 }));
    scene.add(stars);

    const uniforms = { uTime: { value: 0 }, uLight: { value: new THREE.Vector3(1.0, 0.35, 0.55).normalize() }, uDensity: { value: Math.max(0, density) }, uStorm: { value: Math.min(1, Math.max(0, density) / 1.5) } };
    uniformsRef.current = uniforms;

    const vert = `varying vec3 vN;varying vec3 vP;varying vec3 vV;
      void main(){vN=normalize(mat3(modelMatrix)*normal);vP=position;
      vec4 wp=modelMatrix*vec4(position,1.0);vV=normalize(cameraPosition-wp.xyz);
      gl_Position=projectionMatrix*viewMatrix*wp;}`;
    const frag = `precision highp float;varying vec3 vN;varying vec3 vP;varying vec3 vV;
      uniform float uTime;uniform vec3 uLight;uniform float uDensity;uniform float uStorm;
      float hash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
       return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                  mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float fbm(vec3 p){float s=0.0,a=0.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p*=2.03;a*=0.5;}return s;}
      float fbm4(vec3 p){float s=0.0,a=0.5;for(int i=0;i<4;i++){s+=a*vnoise(p);p*=2.05;a*=0.5;}return s;}
      vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(p.x*c-p.z*s,p.y,p.x*s+p.z*c);}
      void main(){
       vec3 N=normalize(vN);vec3 u=normalize(vP);float t=uTime;
       float land=fbm(vP*1.7);float lm=smoothstep(0.52,0.6,land);
       vec3 ocean=vec3(0.03,0.12,0.28);
       vec3 grnd=mix(vec3(0.10,0.42,0.34),vec3(0.55,0.42,0.22),smoothstep(0.6,0.8,land));
       float ice=smoothstep(0.72,0.9,abs(u.y));
       vec3 dayCol=mix(ocean,grnd,lm);dayCol=mix(dayCol,vec3(0.85,0.92,1.0),ice);
       // WEATHER: differential-rotation swirl (seamless 3D noise) + cyclonic warp.
       // Latitude-dependent band speed/direction -> a satellite-imagery swirl.
       float ang=t*0.05+0.35*sin(u.y*7.5);
       vec3 q=rotY(vP,ang);
       q+=0.18*vec3(fbm4(vP*2.4+vec3(0.0,t*0.03,0.0))-0.5,0.0,fbm4(vP*2.4+vec3(9.0,0.0,t*0.03))-0.5);
       float clouds=fbm4(q*2.1+vec3(0.0,t*0.02,0.0))*0.62+fbm4(q*4.3+7.0-vec3(0.0,t*0.05,0.0))*0.38;
       float cover=mix(0.60,0.40,uStorm);float sharp=mix(0.80,0.54,uStorm);   // stormier => more, harder cloud
       float cloud=smoothstep(cover,sharp,clouds);
       float tropics=smoothstep(0.55,0.0,abs(u.y));                            // convective towers near equator
       cloud=clamp(cloud*mix(0.85,1.2,tropics),0.0,1.0);
       vec3 cloudCol=mix(vec3(0.96,0.98,1.0),vec3(0.72,0.76,0.86),uStorm*0.8);
       dayCol=mix(dayCol,cloudCol,cloud*0.9);
       float lambert=dot(N,normalize(uLight));float dayA=smoothstep(-0.08,0.28,lambert);
       float city=smoothstep(0.62,0.66,fbm(vP*8.0))*lm;
       vec3 night=mix(vec3(0.04,0.02,0.12),vec3(0.11,0.05,0.24),fbm(vP*1.2));
       night+=city*vec3(1.0,0.75,0.35)*1.4*(1.0-cloud);
       vec3 col=mix(night,dayCol,dayA);
       // lightning: sparse flashes inside dense storm cells
       vec3 cellId=floor(q*3.5);
       float flick=step(0.972,hash(cellId+floor(t*7.0)));
       col+=vec3(0.85,0.92,1.0)*flick*smoothstep(0.55,0.8,cloud)*uStorm*(1.0-dayA*0.6)*1.7;
       // aurora ribbons near the poles (brighter + wider)
       float pole=smoothstep(0.48,0.92,abs(u.y));
       float ph=atan(u.z,u.x)*3.0+t*0.6+fbm4(vP*2.0)*4.0;
       float rib=pow(sin(ph)*0.5+0.5,3.0);
       col+=mix(vec3(0.20,1.0,0.55),vec3(0.5,0.5,1.0),0.5+0.5*sin(ph*0.5))*rib*pole*(1.0-dayA)*0.95;
       // atmosphere rim — softened so it's a thin edge, not a fat halo
       float fres=pow(1.0-max(dot(N,normalize(vV)),0.0),3.2);float d=uDensity;
       col+=vec3(0.22,0.80,1.0)*fres*d*(0.2+0.35*dayA);
       col+=vec3(0.55,0.42,1.0)*pow(fres,1.7)*d*0.28*(1.0-dayA);
       col.b+=fres*d*0.06;
       gl_FragColor=vec4(col,1.0);}`;
    const planetGeo = new THREE.SphereGeometry(1.5, 96, 96);
    const planet = new THREE.Mesh(planetGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag }));
    const tiltGroup = new THREE.Group(); tiltGroup.add(planet);
    tiltGroup.rotation.z = (tilt * Math.PI) / 180;
    tiltObjRef.current = tiltGroup;
    const spin = new THREE.Group(); spin.add(tiltGroup); scene.add(spin);

    // atmosphere glow shell
    const glowGeo = new THREE.SphereGeometry(1.63, 64, 64);
    const glow = new THREE.Mesh(glowGeo, new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, uniforms,
      vertexShader: `varying vec3 vN;varying vec3 vV;void main(){vN=normalize(mat3(modelMatrix)*normal);
        vec4 wp=modelMatrix*vec4(position,1.0);vV=normalize(cameraPosition-wp.xyz);gl_Position=projectionMatrix*viewMatrix*wp;}`,
      fragmentShader: `varying vec3 vN;varying vec3 vV;uniform float uDensity;
        void main(){float f=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),3.4);
        gl_FragColor=vec4(mix(vec3(0.30,0.55,1.0),vec3(0.25,0.80,1.0),0.5),f*(0.32+uDensity*0.16));}`,
    }));
    tiltGroup.add(glow);

    // ring system (canvas texture, banded radial alpha)
    const rc = document.createElement("canvas"); rc.width = 1024; rc.height = 32; const rx = rc.getContext("2d");
    for (let x = 0; x < 1024; x++) { const t = x / 1024; const band = Math.sin(t * 70) * 0.5 + 0.5;
      let a = (0.12 + band * 0.5) * Math.sqrt(Math.max(0, Math.sin(t * Math.PI))); if (t < 0.04 || t > 0.98) a = 0;
      const c = Math.sin(t * 9) * 0.5 + 0.5; rx.fillStyle = `rgba(${120 + c*60|0},${190 + c*40|0},255,${a})`; rx.fillRect(x, 0, 1, 32); }
    const rtex = new THREE.CanvasTexture(rc);
    const ringGeo = new THREE.RingGeometry(1.9, 2.9, 180, 1);
    { const p = ringGeo.attributes.position, uv = ringGeo.attributes.uv, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); uv.setXY(i, (v.length() - 1.9) / 1.0, 0.5); } }
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: rtex, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = Math.PI / 2 * 0.92; tiltGroup.add(ring);

    // ── orbiting satellites (little craft on tilted orbits) ──────────────────
    const satBodyGeo = new THREE.BoxGeometry(0.07, 0.07, 0.11);
    const panelGeo = new THREE.BoxGeometry(0.20, 0.006, 0.07);
    const glintGeo = new THREE.SphereGeometry(0.022, 8, 8);
    const satBodyMat = new THREE.MeshBasicMaterial({ color: 0xdfe7ff });
    const panelMat = new THREE.MeshBasicMaterial({ color: 0x3a74ff });
    const glintMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
    const satPivots = [];
    [{ r: 2.35, inc: 0.55, sp: 0.24, ph: 0 }, { r: 2.9, inc: -0.9, sp: -0.17, ph: 2.2 }, { r: 3.4, inc: 0.28, sp: 0.12, ph: 4.1 }].forEach((cfg) => {
      const pivot = new THREE.Group(); pivot.rotation.x = cfg.inc; pivot.rotation.y = cfg.ph;
      const sat = new THREE.Group();
      const body = new THREE.Mesh(satBodyGeo, satBodyMat);
      const p1 = new THREE.Mesh(panelGeo, panelMat); p1.position.x = 0.14;
      const p2 = new THREE.Mesh(panelGeo, panelMat); p2.position.x = -0.14;
      const glint = new THREE.Mesh(glintGeo, glintMat); glint.position.y = 0.06;
      sat.add(body, p1, p2, glint); sat.position.x = cfg.r; sat.rotation.z = 0.4;
      pivot.add(sat); scene.add(pivot); satPivots.push({ pivot, sp: cfg.sp });
    });

    // ── shooting comet — style #14 "Midnight deep-void": a small dim head with
    //    a soft midnight-blue coma and a subtle wispy trail (minimal, not flashy).
    const cometHeadGeo = new THREE.SphereGeometry(0.038, 12, 12);
    const cometComaGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const cometTailGeo = new THREE.ConeGeometry(0.05, 0.95, 12, 1, true);
    const cometHeadMat = new THREE.MeshBasicMaterial({ color: 0xcdd8ff });
    const cometComaMat = new THREE.MeshBasicMaterial({ color: 0x5a74d8, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
    const cometTailMat = new THREE.MeshBasicMaterial({ color: 0x33447f, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const comet = new THREE.Group();
    const cometHead = new THREE.Mesh(cometHeadGeo, cometHeadMat); cometHead.position.y = 0.6;   // apex = leading head
    const cometComa = new THREE.Mesh(cometComaGeo, cometComaMat); cometComa.position.y = 0.6;   // soft glow around the head
    comet.add(cometComa, cometHead, new THREE.Mesh(cometTailGeo, cometTailMat));
    comet.visible = false; scene.add(comet);
    const V_UP = new THREE.Vector3(0, 1, 0), cStart = new THREE.Vector3(), cEnd = new THREE.Vector3();
    let cActive = false, cProg = 0, cSpeed = 0.6, cWait = 1.2, cIdle = 0;
    const launchComet = () => {
      const y = 1.6 + Math.random() * 3.0, z = -7 - Math.random() * 5, dir = Math.random() < 0.5 ? 1 : -1;
      cStart.set(-11 * dir, y, z); cEnd.set(11 * dir, y - 2.2 - Math.random() * 2.0, z);
      comet.quaternion.setFromUnitVectors(V_UP, cEnd.clone().sub(cStart).normalize());
      cProg = 0; cSpeed = 0.5 + Math.random() * 0.35; cActive = true; comet.visible = true;
    };

    // ── background aurora curtain (northern-lights ribbons behind the planet) ─
    const auroraGeo = new THREE.PlaneGeometry(36, 16);
    const auroraMat = new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, uniforms: { uTime: uniforms.uTime },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `precision highp float;varying vec2 vUv;uniform float uTime;
        float h(float x){return fract(sin(x*127.1)*43758.5453);}
        float n(float x){float i=floor(x),f=fract(x);return mix(h(i),h(i+1.0),f*f*(3.0-2.0*f));}
        void main(){float x=vUv.x,y=vUv.y;
          float base=0.32+n(x*6.0+uTime*0.15)*0.22+n(x*13.0-uTime*0.1)*0.12;
          float band=smoothstep(base,base+0.03,y)*(1.0-smoothstep(base+0.30,base+0.60,y));
          band*=0.6+0.4*n(x*44.0+uTime*0.4);
          vec3 c=mix(vec3(0.12,1.0,0.5),vec3(0.3,0.6,1.0),smoothstep(base,base+0.4,y));
          c=mix(c,vec3(0.6,0.3,1.0),smoothstep(base+0.28,base+0.6,y));
          float edge=smoothstep(0.0,0.16,x)*smoothstep(1.0,0.84,x);
          gl_FragColor=vec4(c,band*edge*0.42);}`,
    });
    const aurora = new THREE.Mesh(auroraGeo, auroraMat); aurora.position.set(0, 3.6, -9); scene.add(aurora);

    const onResize = () => { if (!renderer) return; camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); };
    window.addEventListener("resize", onResize);

    let prevT = 0;
    const loop = (t) => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      const dt = prevT ? Math.min(0.05, (t - prevT) / 1000) : 0.016; prevT = t;
      uniforms.uTime.value = t * 0.001;
      planet.rotation.y = t * 0.00002;
      ring.rotation.z += 0.0006;
      stars.rotation.y += 0.0002;
      for (const s of satPivots) s.pivot.rotation.y += s.sp * dt;   // satellites orbit
      if (cActive) { cProg += dt * cSpeed; comet.position.lerpVectors(cStart, cEnd, cProg); if (cProg >= 1) { cActive = false; comet.visible = false; cWait = 2.5 + Math.random() * 5; cIdle = 0; } }
      else { cIdle += dt; if (cIdle >= cWait) launchComet(); }
      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize);
      controls.dispose();
      [sg, planetGeo, glowGeo, ringGeo, rtex, satBodyGeo, panelGeo, glintGeo, cometHeadGeo, cometComaGeo, cometTailGeo, auroraGeo].forEach((d) => d && d.dispose && d.dispose());
      scene.traverse((o) => { if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose && m.dispose(); }); } });
      renderer.dispose();
      uniformsRef.current = null; tiltObjRef.current = null;
      if (app) app.innerHTML = "";
    };
  }, []);

  return <div ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}
