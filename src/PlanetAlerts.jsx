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
  useEffect(() => { if (uniformsRef.current) uniformsRef.current.uDensity.value = Math.max(0.05, density); }, [density]);

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

    const uniforms = { uTime: { value: 0 }, uLight: { value: new THREE.Vector3(1.0, 0.35, 0.55).normalize() }, uDensity: { value: Math.max(0.05, density) } };
    uniformsRef.current = uniforms;

    const vert = `varying vec3 vN;varying vec3 vP;varying vec3 vV;
      void main(){vN=normalize(mat3(modelMatrix)*normal);vP=position;
      vec4 wp=modelMatrix*vec4(position,1.0);vV=normalize(cameraPosition-wp.xyz);
      gl_Position=projectionMatrix*viewMatrix*wp;}`;
    const frag = `precision highp float;varying vec3 vN;varying vec3 vP;varying vec3 vV;
      uniform float uTime;uniform vec3 uLight;uniform float uDensity;
      float hash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
       return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                  mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float fbm(vec3 p){float s=0.0,a=0.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p*=2.03;a*=0.5;}return s;}
      void main(){
       vec3 N=normalize(vN);
       float land=fbm(vP*1.7);float lm=smoothstep(0.52,0.6,land);
       vec3 ocean=vec3(0.03,0.12,0.28);
       vec3 grnd=mix(vec3(0.10,0.42,0.34),vec3(0.55,0.42,0.22),smoothstep(0.6,0.8,land));
       float ice=smoothstep(0.72,0.9,abs(vP.y));
       vec3 dayCol=mix(ocean,grnd,lm);dayCol=mix(dayCol,vec3(0.85,0.92,1.0),ice);
       float cl=fbm(vP*2.3+vec3(uTime*0.02,0.0,uTime*0.015));
       float cloud=smoothstep(0.55,0.75,cl);dayCol=mix(dayCol,vec3(0.95,0.97,1.0),cloud*0.75);
       float lambert=dot(N,normalize(uLight));float dayA=smoothstep(-0.08,0.28,lambert);
       float city=smoothstep(0.62,0.66,fbm(vP*8.0))*lm;
       vec3 night=mix(vec3(0.06,0.03,0.16),vec3(0.14,0.06,0.28),fbm(vP*1.2));
       night+=city*vec3(1.0,0.75,0.35)*1.4;
       vec3 col=mix(night,dayCol,dayA);
       float fres=pow(1.0-max(dot(N,normalize(vV)),0.0),3.0);float d=uDensity;
       col+=vec3(0.22,0.85,1.0)*fres*d*(0.4+0.6*dayA);
       col+=vec3(0.62,0.45,1.0)*pow(fres,1.6)*d*0.5*(1.0-dayA);
       col.r+=fres*d*0.06;col.b+=fres*d*0.10;
       gl_FragColor=vec4(col,1.0);}`;
    const planetGeo = new THREE.SphereGeometry(1.5, 96, 96);
    const planet = new THREE.Mesh(planetGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag }));
    const tiltGroup = new THREE.Group(); tiltGroup.add(planet);
    tiltGroup.rotation.z = (tilt * Math.PI) / 180;
    tiltObjRef.current = tiltGroup;
    const spin = new THREE.Group(); spin.add(tiltGroup); scene.add(spin);

    // atmosphere glow shell
    const glowGeo = new THREE.SphereGeometry(1.72, 64, 64);
    const glow = new THREE.Mesh(glowGeo, new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, uniforms,
      vertexShader: `varying vec3 vN;varying vec3 vV;void main(){vN=normalize(mat3(modelMatrix)*normal);
        vec4 wp=modelMatrix*vec4(position,1.0);vV=normalize(cameraPosition-wp.xyz);gl_Position=projectionMatrix*viewMatrix*wp;}`,
      fragmentShader: `varying vec3 vN;varying vec3 vV;uniform float uDensity;
        void main(){float f=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),2.6);
        gl_FragColor=vec4(mix(vec3(0.35,0.55,1.0),vec3(0.20,0.85,1.0),0.5),f*uDensity*0.8);}`,
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

    const onResize = () => { if (!renderer) return; camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); };
    window.addEventListener("resize", onResize);

    const loop = (t) => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      uniforms.uTime.value = t * 0.001;
      planet.rotation.y = t * 0.00002;
      ring.rotation.z += 0.0006;
      stars.rotation.y += 0.0002;
      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize);
      controls.dispose();
      [sg, planetGeo, glowGeo, ringGeo, rtex].forEach((d) => d && d.dispose && d.dispose());
      scene.traverse((o) => { if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose && m.dispose(); }); } });
      renderer.dispose();
      uniformsRef.current = null; tiltObjRef.current = null;
      if (app) app.innerHTML = "";
    };
  }, []);

  return <div ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}
