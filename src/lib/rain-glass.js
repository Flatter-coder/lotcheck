/*
 * rain-glass.js - rain on a night window. Raw WebGL1, no dependencies.
 *
 *   const fx = mountRainGlass(canvasEl, { density: 1.2 });   // -> { destroy() }
 *
 * Size the canvas with CSS (e.g. position:absolute; inset:0). The module sets
 * canvas.dataset.rain = "live" after the first frame is drawn, and "off" when
 * WebGL is missing or the context is lost, so CSS can keep a static navy
 * background underneath (fade the canvas in on [data-rain=live]).
 *
 * How it works
 *   1. The street behind the glass is procedural: soft light sprites over a
 *      navy gradient, rendered once per resize at three focus levels
 *      (sharp = seen through a drop, mid = clear glass, fog = condensation).
 *   2. Raindrops are simulated on the CPU (impacts, merging, stick-slip runs,
 *      trail beads) and splatted as additive metaball quads into a "water map":
 *      R = height, GB = position inside the drop, A = drop size.
 *   3. One full-screen pass thresholds the water map, refracts the sharp scene
 *      through each drop (inverted, with slight colour dispersion), darkens the
 *      rims, adds a glint, fine condensation beads, grain and a navy grade.
 *   Running drops also paint a low-res "wipe" map that clears fog and beads;
 *   it fogs back over clearTime seconds.
 */
(function (root) {
  'use strict';

  /* ---- tweakables (all overridable per mount) ---- */
  var DEFAULTS = {
    density: 1,       // raindrop impacts, relative
    speed: 1,         // how fast big drops run down
    dropSize: 1,      // raindrop radius multiplier
    micro: 1,         // fine condensation beads (0 = none)
    blur: 1,          // how far out of focus the street is
    fog: 0.35,        // condensation haze; running drops wipe it clear
    clearTime: 10,    // seconds for a wiped trail to fog over again
    tint: 0.18,       // pull toward the brand navy (0..1)
    lens: 1,          // how wide a view each drop refracts
    grain: 0.03,      // film grain amplitude
    dprCap: 1.5,      // never render above this devicePixelRatio
    maxPixels: 2.2e6, // cap on drawing-buffer pixels
    warm: 14,         // seconds of rain simulated before the first frame
    still: false,     // force a single still frame (reduced motion is automatic)
    horizon: 0,       // street horizon as a fraction of height (0 = auto: .54 landscape, .5 portrait)
    seed: 11          // street layout seed
  };

  var MAXQ = 1600, SREF = 28; // quad budget; drop radius (css px) that encodes as size 1

  var HEAD = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  var VS_FULL = 'attribute vec2 aP;varying vec2 vUv;void main(){vUv=aP*.5+.5;gl_Position=vec4(aP,0.,1.);}';
  var VS_SPR = 'attribute vec2 aP;attribute vec2 aL;attribute vec3 aC;attribute vec2 aK;' +
    'varying vec2 vL;varying vec3 vC;varying vec2 vK;void main(){vL=aL;vC=aC;vK=aK;gl_Position=vec4(aP,0.,1.);}';
  var VS_DROP = 'attribute vec2 aP;attribute vec2 aL;attribute vec3 aC;' +
    'varying vec2 vL;varying vec3 vD;void main(){vL=aL;vD=aC;gl_Position=vec4(aP,0.,1.);}';

  // night sky -> horizon glow -> wet road
  var FS_BG = [
    'uniform float uHz;uniform float uSoft;varying vec2 vUv;',
    'void main(){',
    ' float y=vUv.y;',
    ' vec3 sky=mix(vec3(.05,.10,.23),vec3(.010,.026,.075),smoothstep(uHz,1.,y));',
    ' vec3 road=mix(vec3(.012,.028,.07),vec3(.04,.08,.18),smoothstep(0.,uHz,y));',
    ' gl_FragColor=vec4(mix(road,sky,smoothstep(uHz-uSoft,uHz+uSoft,y)),1.);',
    '}'].join('\n');

  var FS_FILL = 'uniform vec4 uC;void main(){gl_FragColor=uC;}';

  // one light: superellipse (disc..box), crisp bokeh edge or gaussian glow
  var FS_SPR = [
    'varying vec2 vL;varying vec3 vC;varying vec2 vK;',
    'void main(){',
    ' vec2 q=abs(vL);float n=mix(10.,2.,vK.y);',
    ' float d=pow(pow(q.x,n)+pow(q.y,n),1./n);',
    ' float s=max(vK.x,.02);',
    ' float disc=(1.-smoothstep(1.-s,1.,d))*(1.+.25*(1.-s)*smoothstep(.5,.97,d));',
    ' float glow=exp(-4.5*d*d)*(1.-smoothstep(.8,1.,d));',
    ' gl_FragColor=vec4(vC*mix(disc,glow,smoothstep(.6,1.,s)),1.);',
    '}'].join('\n');

  // a drop / trail streak splatted into the water map (mode 0) or wipe map (mode 1)
  var FS_DROP = [
    'uniform float uMode;varying vec2 vL;varying vec3 vD;',
    'void main(){',
    ' float w=1.-vD.y*smoothstep(-.5,1.,vL.y);', // running drops taper toward their tail
    ' vec2 q=vec2(vL.x/max(w,.25),vL.y);',
    ' float d2=dot(q,q);if(d2>=1.)discard;',
    ' float f=1.-d2;f*=f;',
    ' if(uMode>.5){gl_FragColor=vec4(f*vD.z);return;}',
    ' float amp=vD.z;vec2 pv=q*1.4142;',
    ' if(amp<.99){amp*=1.-smoothstep(-.4,1.,vL.y);pv.y*=.15;}', // tails: thin, lens only across
    ' pv=clamp(pv,-1.,1.);float h=.5*f*amp;',
    ' gl_FragColor=vec4(h,h*(.5+.5*pv),h*vD.x);',
    '}'].join('\n');

  var FS_COMP = [
    'uniform sampler2D uS;uniform sampler2D uM;uniform sampler2D uF;uniform sampler2D uW;uniform sampler2D uX;',
    'uniform vec2 uR;uniform vec2 uK;uniform float uPx;uniform float uT;uniform float uRef;uniform vec4 uA;uniform float uTint;',
    'varying vec2 vUv;',
    'float hs(vec2 p){p=fract(p*vec2(.1031,.1123));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x*1.7);}',
    // lens: every drop shows the same wide, inverted view of the street (the angle depends on
    // the surface slope, not the drop size). Small drops can't resolve it, so they read the
    // pre-blurred levels instead of aliasing the sharp one.
    'vec3 tap(vec2 uv,vec2 pv,float rpx){',
    ' vec2 o=-pv*(1.+1.2*dot(pv,pv))*uK;',
    ' vec3 c=mix(texture2D(uF,uv+o).rgb*1.15,texture2D(uM,uv+o).rgb,smoothstep(2.,6.,rpx));',
    ' float k=smoothstep(5.,16.,rpx);',
    ' if(k>0.)c=mix(c,vec3(texture2D(uS,uv+o*1.04).r,texture2D(uS,uv+o).g,texture2D(uS,uv+o*.96).b),k);',
    ' return c;',
    '}',
    'vec3 water(vec3 bg,vec2 uv,vec2 pv,float rpx){',
    ' float r=length(pv);',
    ' vec3 c=tap(uv,pv,rpx)*(1.15+.55*(1.-smoothstep(-.9,.15,pv.y)));', // light pools low in the drop
    ' c=mix(c,bg*.25,smoothstep(.72,1.02,r));',                           // dark refracting rim
    ' float s=1.-smoothstep(0.,.3,length(pv-vec2(-.32,.44)));',
    ' c+=vec3(.78,.88,1.)*s*s*.55*smoothstep(1.5,5.,rpx);',                                     // glint
    ' c+=vec3(.25,.4,.7)*.12*smoothstep(.75,.98,r)*(1.-smoothstep(-.2,.6,pv.y));', // caught edge light
    ' return c;',
    '}',
    'float bead(vec2 p,float cell,float prob,float wipe,out vec2 pv,out float rpx){',
    ' vec2 id=floor(p/cell);',
    ' float a=hs(id),b=hs(id+17.31),c=hs(id+41.93);',
    ' float grow=smoothstep(b*.7,b*.7+.25,1.-wipe);',
    ' float rad=cell*(.1+.2*c*c)*grow;',
    ' vec2 ctr=(id+.28+.44*vec2(hs(id+5.17),hs(id+8.71)))*cell;',
    ' pv=(p-ctr)/max(rad,1e-3);rpx=rad*uPx;',
    ' return step(a,prob)*(1.-smoothstep(1.-1.4/max(rpx,.7),1.,length(pv)));',
    '}',
    'void main(){',
    ' vec2 uv=vUv;',
    ' float wipe=texture2D(uX,uv).r;',
    ' vec3 col=mix(texture2D(uM,uv).rgb,texture2D(uF,uv).rgb*1.06+vec3(.008,.016,.034),uA.y*(1.-wipe));',
    ' vec2 p=gl_FragCoord.xy/uPx,pv;float rp,m;',
    ' if(uA.z>0.){',
    '  m=bead(p,9.,.2*uA.z,wipe,pv,rp);if(m>0.)col=mix(col,water(col,uv,pv,rp),m*.8);',
    '  m=bead(p+vec2(31.7,17.3),19.,.22*uA.z,wipe,pv,rp);if(m>0.)col=mix(col,water(col,uv,pv,rp),m);',
    ' }',
    ' vec4 w=texture2D(uW,uv);',
    ' if(w.r>.02){',
    '#ifdef DERIV',
    '  float fw=fwidth(w.r)*.7+.001;',
    '#else',
    '  float fw=.012;',
    '#endif',
    '  m=smoothstep(.125-fw,.125+fw,w.r);',
    '  if(m>0.)col=mix(col,water(col,uv,w.gb/w.r*2.-1.,w.a/w.r*uRef),m);',
    ' }',
    ' float l=dot(col,vec3(.3,.55,.15));',
    ' col=mix(col,l*vec3(.6,.85,1.35),uTint);',
    ' vec2 v=uv-.5;col*=1.-dot(v,v)*.55;',
    ' col+=(hs(gl_FragCoord.xy+fract(uT*7.31)*517.)-.5)*uA.w;',
    ' gl_FragColor=vec4(col,1.);',
    '}'].join('\n');

  function rng(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- the street: a night dealership lot, in CSS px (y down) ---- */
  function buildScene(W, H, seed, horizon) {
    var R = rng(seed), S = [], i, t, x, y, r, gy, tr, c;
    var port = H > W * 1.1, hz = H * (horizon || (port ? 0.5 : 0.54));
    function add(x, y, rx, ry, c, i, k, z) { S.push([x, y, rx, ry, [c[0] * i, c[1] * i, c[2] * i], k || 0, z || 1]); }
    var BLUE = [0.3, 0.61, 1], ICE = [0.62, 0.76, 1], SODIUM = [1, 0.62, 0.3], TAIL = [1, 0.12, 0.09];

    // haze: showroom light spilling into wet air, cool sky glow, sodium bloom
    add(W * 0.74, hz - H * 0.07, W * 0.44, H * 0.32, [0.1, 0.28, 0.75], 0.62, 2);
    add(W * 0.22, hz - H * 0.03, W * 0.42, H * 0.16, [0.06, 0.14, 0.36], 0.5, 2);
    add(W * 0.97, H * 0.12, W * 0.24, H * 0.2, [0.55, 0.3, 0.12], 0.24, 2);
    // wet lot in the foreground: broad cool sheen, a warm pool under the nearest lamp
    add(W * 0.78, hz + H * 0.3, W * 0.36, H * 0.16, [0.12, 0.26, 0.62], 0.34, 2);
    add(W * 0.96, hz + H * 0.36, W * 0.16, H * 0.12, [0.7, 0.38, 0.16], 0.2, 2);

    // an office block behind the lot: scattered lit windows, warm and cool
    for (y = H * 0.1; y < hz - H * 0.17; y += H * 0.034)
      for (x = W * (port ? 0.5 : 0.55); x < W * (port ? 0.95 : 0.82); x += W * 0.021)
        if (R() < 0.32) add(x, y, W * 0.006 + 1, H * 0.008 + 1, R() < 0.6 ? [0.95, 0.8, 0.6] : [0.6, 0.75, 1], 0.22 + R() * 0.3, 1);
    // showroom: interior spill, glazing panes, a row of ceiling downlights, a brand-blue sign
    var x0 = W * (port ? 0.3 : 0.5), x1 = W * 1.03, sy = hz - H * 0.085, sh = H * 0.05, n = 7, pw = (x1 - x0) / n;
    add((x0 + x1) / 2, sy, (x1 - x0) * 0.55, sh * 1.8, ICE, 0.24, 2);
    for (i = 0; i < n; i++) {
      x = x0 + pw * (i + 0.5);
      add(x, sy + sh * (R() - 0.5) * 0.2, pw * 0.43, sh * (0.8 + R() * 0.25), ICE, 0.16 + R() * 0.22, 1);
      if (R() < 0.6) add(x, hz + H * 0.11, pw * 0.2, H * 0.07, ICE, 0.12 + R() * 0.1, 0, 1.3);  // smear on wet asphalt
    }
    for (i = 0; i < 16; i++) add(x0 + (x1 - x0) * (i + 0.5) / 16, sy - sh * 0.72, 1.7, 1.2, [0.92, 0.96, 1], 1.1 + R() * 0.5, 0);
    x = x0 + (x1 - x0) * 0.3; y = sy - sh - H * 0.045;
    add(x, y, W * 0.045, H * 0.009, BLUE, 1.8, 1);
    add(x, y, W * 0.09, H * 0.045, BLUE, 0.22, 2);
    add(x, hz + H * 0.16, W * 0.03, H * 0.05, BLUE, 0.3, 0, 1.3);

    // sodium lamps receding to a vanishing point, each with a streak on the wet road
    var vx = W * (port ? 0.18 : 0.34), vy = hz - H * 0.07;
    for (i = 0; i < 7; i++) {
      t = Math.pow(0.7, i);
      x = vx + (W * 1.03 - vx) * t; y = vy + (H * 0.08 - vy) * t; r = H * 0.014 * t + 1.6;
      add(x, y, r, r * 0.75, SODIUM, 1.7, 0, 1 + t);
      add(x, y, r * 6, r * 5, [0.9, 0.45, 0.2], 0.12, 2);
      gy = vy + (H * 1.05 - vy) * t;
      add(x, gy + H * 0.09 * t, r * 1.1, H * 0.1 * t + 2, [1, 0.55, 0.25], 0.42, 0, 1.2);
    }
    // parked cars: uneven roof-line sheen, a few tail-light pairs, one set of headlights
    for (i = 0; i < 11; i++) {
      x = W * (port ? 0.06 : 0.3) + i * W * 0.07 + (R() - 0.5) * W * 0.03;
      y = hz + H * (0.03 + R() * 0.045);
      add(x, y, W * (0.008 + R() * 0.012) + 1.5, H * 0.003 + 1, [0.6, 0.72, 1], 0.25 + R() * 0.45, 0);
      t = R();
      if (t < 0.3 || t > 0.93) {
        tr = 1.2 + R() * 0.9; c = t < 0.3 ? TAIL : [1, 0.9, 0.75];
        add(x - W * 0.01, y + H * 0.016, tr, tr * 0.7, c, 1.4, 0);
        add(x + W * 0.01, y + H * 0.016, tr, tr * 0.7, c, 1.4, 0);
        add(x, y + H * 0.08, W * 0.012, H * 0.05, c, 0.14, 0, 1.2);
      }
    }
    // distant city, sparse on the left so copy sits on quiet ground
    for (i = 0; i < 80; i++) {
      x = R() * W; y = hz - H * (0.01 + Math.pow(R(), 1.6) * 0.18);
      if (x < W * 0.42 && R() < 0.6) continue;
      t = R(); c = t < 0.28 ? [1, 0.7, 0.4] : t < 0.64 ? [0.75, 0.85, 1] : [0.35, 0.6, 1];
      r = 0.8 + R() * 1.7;
      add(x, y, r, r, c, 0.45 + R() * 0.9, 0);
    }
    // a traffic signal on the far left, over its own reflection
    add(W * 0.15, hz - H * 0.09, 2.2, 2.2, [0.25, 1, 0.6], 1.1, 0);
    add(W * 0.15, hz + H * 0.08, 2, H * 0.05, [0.2, 0.9, 0.5], 0.22, 0);
    return { hz: hz, list: S };
  }

  function mountRainGlass(canvas, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] != null) o[k] = opts[k];

    var mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    var gl, P, B = {}, T = {}, half = null, deriv = false;
    var W = 0, H = 0, bw = 0, bh = 0, px = 1, quality = 1, scene;
    var drops = [], spawnAcc = 0, fadeAcc = 0, time = 0;
    var raf = 0, last = 0, running = false, onscreen = true, lost = false, dead = false;
    var perfN = 0, perfT = 0, io = null, ro = null, rt = 0, meter = { n: 0, dt: 0, cpu: 0 };
    var verts = new Float32Array(MAXQ * 28), sverts = new Float32Array(400 * 36);

    function prog(vs, fs) {
      var p = gl.createProgram();
      [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].forEach(function (s) {
        var sh = gl.createShader(s[0]);
        gl.shaderSource(sh, s[1]); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.warn('[rain-glass]', gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      });
      ['aP', 'aL', 'aC', 'aK'].forEach(function (n, i) { gl.bindAttribLocation(p, i, n); });
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
      return { p: p, u: {} };
    }
    function U(p, n) { return p.u[n] || (p.u[n] = gl.getUniformLocation(p.p, n)); }

    function initGL() {
      var attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
      if (!gl) return false;
      deriv = !!gl.getExtension('OES_standard_derivatives');
      var hf = gl.getExtension('OES_texture_half_float');
      gl.getExtension('EXT_color_buffer_half_float');
      half = hf ? hf.HALF_FLOAT_OES : null;
      P = {
        bg: prog(VS_FULL, HEAD + FS_BG), fill: prog(VS_FULL, HEAD + FS_FILL),
        spr: prog(VS_SPR, HEAD + FS_SPR), drop: prog(VS_DROP, HEAD + FS_DROP),
        comp: prog(VS_FULL, (deriv ? '#extension GL_OES_standard_derivatives : enable\n#define DERIV\n' : '') + HEAD + FS_COMP)
      };
      for (k in P) if (!P[k]) return false;
      B.full = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, B.full);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      var idx = new Uint16Array(MAXQ * 6);
      for (var i = 0; i < MAXQ; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      B.idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      B.drop = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, B.drop);
      gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW);
      B.spr = gl.createBuffer();
      gl.disable(gl.DEPTH_TEST);
      return true;
    }

    function target(w, h, type) {
      var t = gl.createTexture(), f = gl.createFramebuffer(), lin = type === gl.UNSIGNED_BYTE;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, type, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) { gl.deleteTexture(t); gl.deleteFramebuffer(f); return null; }
      return { t: t, f: f, w: w, h: h };
    }
    function freeTargets() {
      for (var n in T) if (T[n]) { gl.deleteTexture(T[n].t); gl.deleteFramebuffer(T[n].f); }
      T = {};
    }
    function makeTargets() {
      freeTargets();
      var UB = gl.UNSIGNED_BYTE, s2 = function (v, f) { return Math.max(1, Math.round(v * f)); };
      T.S = target(s2(bw, 0.5), s2(bh, 0.5), UB);
      T.M = target(s2(bw, 0.5), s2(bh, 0.5), UB);
      T.F = target(s2(bw, 0.25), s2(bh, 0.25), UB);
      T.W = (half && target(bw, bh, half)) || target(bw, bh, UB);
      T.X = target(s2(bw, 0.25), s2(bh, 0.25), UB);
      for (var n in T) if (!T[n]) return false;
      bindTarget(T.X); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return true;
    }

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.f : null);
      gl.viewport(0, 0, t ? t.w : bw, t ? t.h : bh);
    }
    function layout(buf, stride, specs) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (var i = 0; i < 4; i++) gl.disableVertexAttribArray(i);
      specs.forEach(function (s) {
        gl.enableVertexAttribArray(s[0]);
        gl.vertexAttribPointer(s[0], s[1], gl.FLOAT, false, stride * 4, s[2] * 4);
      });
    }
    function drawFull() {
      layout(B.full, 2, [[0, 2, 0]]);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    function measure() {
      W = Math.max(1, canvas.clientWidth); H = Math.max(1, canvas.clientHeight);
      px = Math.min(Math.min(root.devicePixelRatio || 1, o.dprCap) * quality, Math.sqrt(o.maxPixels / (W * H)));
      bw = Math.max(1, Math.round(W * px)); bh = Math.max(1, Math.round(H * px));
      canvas.width = bw; canvas.height = bh;
    }

    /* scene sprites at one focus level: b = defocus radius (css px), edge = bokeh edge softness */
    function emitScene(b, edge) {
      var L = scene.list, n = 0, sx = 2 / W, sy = 2 / H;
      for (var i = 0; i < L.length && n < 400; i++) {
        var s = L[i], rx = s[2], ry = s[3], bz = b * s[6], I = 1, soft = 1, round = 1, ex, ey;
        if (s[5] === 2) { ex = rx + bz; ey = ry + bz; }
        else {
          ex = Math.sqrt(rx * rx + bz * bz); ey = Math.sqrt(ry * ry + bz * bz);
          I = Math.pow((rx * ry) / (ex * ey), 0.42);
          soft = edge;
          round = s[5] === 1 ? Math.min(1, bz / Math.min(rx, ry) * 0.35) : 1;
          if (edge >= 1) { ex *= 1.35; ey *= 1.35; I *= 1.5; }
        }
        var x0 = (s[0] - ex) * sx - 1, x1 = (s[0] + ex) * sx - 1, y0 = 1 - (s[1] + ey) * sy, y1 = 1 - (s[1] - ey) * sy;
        var c = s[4], q = [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1]];
        for (var j = 0; j < 4; j++) sverts.set([q[j][0], q[j][1], q[j][2], q[j][3], c[0] * I, c[1] * I, c[2] * I, soft, round], (n * 4 + j) * 9);
        n++;
      }
      return n;
    }
    function renderScene() {
      scene = buildScene(W, H, o.seed, o.horizon);
      var D = Math.sqrt(W * H) * o.blur;
      [[T.S, 0.009 * D, 0.12], [T.M, 0.034 * D, 0.4], [T.F, 0.075 * D, 1]].forEach(function (L) {
        bindTarget(L[0]);
        gl.disable(gl.BLEND);
        gl.useProgram(P.bg.p);
        gl.uniform1f(U(P.bg, 'uHz'), 1 - scene.hz / H);
        gl.uniform1f(U(P.bg, 'uSoft'), L[1] / H * 1.5 + 0.015);
        drawFull();
        var n = emitScene(L[1], L[2]);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(P.spr.p);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.spr);
        gl.bufferData(gl.ARRAY_BUFFER, sverts.subarray(0, n * 36), gl.DYNAMIC_DRAW);
        layout(B.spr, 9, [[0, 2, 0], [1, 2, 2], [2, 3, 4], [3, 2, 7]]);
        gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
      });
    }

    /* ---- rain simulation, css px, y down ---- */
    function rnd() { return Math.random(); }
    function slideR() { return 13 * o.dropSize; }
    function grow(d, r) { d.r = Math.min(Math.sqrt(d.r * d.r + r * r), 34 * o.dropSize); }
    function add(x, y, r) {
      var d = { x: x, y: y, r: r, v: 0, vx: 0, slide: false, stall: 0, dist: 0, tail: 0, sx: 0.88 + rnd() * 0.24, pin: 0.72 + rnd() * 0.75, dead: false };
      drops.push(d); return d;
    }
    function impact(x, y, r, cap) {
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i], dx = d.x - x, dy = d.y - y, lim = (d.r + r) * 0.8;
        if (dx * dx + dy * dy < lim * lim) { grow(d, r); return; }
      }
      if (drops.length < cap) add(x, y, r);
    }
    function step(dt) {
      var area = W * H / 1e6, cap = Math.min(1150, 800 * area * o.density), rs = slideR(), i, j, d, e;
      spawnAcc += dt * 60 * area * o.density;
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        var u = rnd(); impact(rnd() * W, rnd() * H, (1.5 + 10 * Math.pow(u, 1.8)) * o.dropSize, cap);
      }
      for (i = 0; i < drops.length; i++) {
        d = drops[i];
        if (d.dead) continue;
        if (!d.slide) {
          if (d.r > rs * d.pin && rnd() < dt * (d.r - rs * d.pin) * 0.3) { d.slide = true; d.v = 0; d.vx = 0; }
          continue;
        }
        if (d.stall > 0) { d.stall -= dt; d.v *= Math.max(0, 1 - dt * 12); }
        else {
          var target = (18 + (d.r - rs * 0.6) * 15) * o.speed;
          d.v += (target - d.v) * Math.min(1, dt * 2.5);
          if (rnd() < dt * 1.1 * rs / d.r) d.stall = rnd() * rnd() * 0.9;
          if (rnd() < dt * 1.4) d.vx = (rnd() - 0.5) * 0.32;
        }
        var dy = d.v * dt;
        d.y += dy; d.x += d.vx * dy; d.dist += dy;
        d.tail = dy > 0.2 * dt * 60 ? Math.min(d.tail + dy, d.r * 10) : Math.max(0, d.tail - dt * 14);
        if (d.dist > d.r * (0.7 + rnd() * 1.2)) {           // leave a bead behind
          d.dist = 0;
          var br = d.r * (0.12 + rnd() * 0.2);
          if (br > 0.8 && drops.length < cap + 200) add(d.x + (rnd() - 0.5) * d.r * 0.35, d.y - d.r * 1.25, br);
          d.r = Math.sqrt(Math.max(1, d.r * d.r - br * br * 0.5));
          if (d.r < rs * 0.55) d.slide = false;
        }
        for (j = 0; j < drops.length; j++) {                 // swallow whatever it runs into
          e = drops[j];
          if (j === i || e.dead) continue;
          var ex = e.x - d.x, ey = e.y - d.y, lim = (d.r + e.r) * 0.75;
          if (ey > -d.r * 1.1 && ex * ex + ey * ey < lim * lim) { grow(d, e.r); e.dead = true; }
        }
        if (d.y - d.r * 3 > H) d.dead = true;
      }
      if (drops.some(function (d) { return d.dead; })) drops = drops.filter(function (d) { return !d.dead; });
    }

    function quad(n, cx, cy, hx, hy, a, b, c) {
      var sx = 2 / W, sy = 2 / H, x0 = (cx - hx) * sx - 1, x1 = (cx + hx) * sx - 1, y0 = 1 - (cy + hy) * sy, y1 = 1 - (cy - hy) * sy;
      var i = n * 28;
      verts[i] = x0; verts[i + 1] = y0; verts[i + 2] = -1; verts[i + 3] = -1;
      verts[i + 7] = x1; verts[i + 8] = y0; verts[i + 9] = 1; verts[i + 10] = -1;
      verts[i + 14] = x1; verts[i + 15] = y1; verts[i + 16] = 1; verts[i + 17] = 1;
      verts[i + 21] = x0; verts[i + 22] = y1; verts[i + 23] = -1; verts[i + 24] = 1;
      for (var j = 0; j < 4; j++) { verts[i + j * 7 + 4] = a; verts[i + j * 7 + 5] = b; verts[i + j * 7 + 6] = c; }
      return n + 1;
    }
    function drawQuads(n, mode) {
      if (!n) return;
      gl.useProgram(P.drop.p);
      gl.uniform1f(U(P.drop, 'uMode'), mode);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.drop);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts.subarray(0, n * 28));
      layout(B.drop, 7, [[0, 2, 0], [1, 2, 2], [2, 3, 4]]);
      gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
    }

    /* running drops clear the condensation; it fogs back slowly */
    function wipe(dt) {
      bindTarget(T.X);
      gl.enable(gl.BLEND);
      fadeAcc += dt / o.clearTime;
      if (fadeAcc >= 1 / 255) {
        var s = Math.floor(fadeAcc * 255) / 255;
        fadeAcc -= s;
        gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(P.fill.p); gl.uniform4f(U(P.fill, 'uC'), s, s, s, s);
        drawFull();
        gl.blendEquation(gl.FUNC_ADD);
      }
      gl.blendFunc(gl.ONE, gl.ONE);
      var n = 0;
      for (var i = 0; i < drops.length && n < MAXQ; i++) {
        var d = drops[i];
        if (d.slide) n = quad(n, d.x, d.y, d.r * 1.25, d.r * 1.4, 0, 0, 0.45);
      }
      drawQuads(n, 1);
    }

    function render() {
      // water map
      bindTarget(T.W);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      var n = 0;
      for (var i = 0; i < drops.length && n < MAXQ - 2; i++) {
        var d = drops[i], r = d.r, sN = Math.min(1, r / SREF);
        if (d.slide) {
          var sp = Math.min(1, d.v / 110);
          if (d.tail > r * 0.6) n = quad(n, d.x, d.y - d.tail * 0.5 - r * 0.2, r * 0.45, d.tail * 0.5 + r * 0.4, sN * 0.3, 0, 0.7);
          n = quad(n, d.x, d.y, r * 1.414, r * 1.414 * (1 + 0.22 * sp), sN, 0.1 + 0.3 * sp, 1);
        } else n = quad(n, d.x, d.y, r * 1.414 * d.sx, r * 1.414 / d.sx, sN, 0, 1);
      }
      drawQuads(n, 0);
      // composite to screen
      gl.disable(gl.BLEND);
      bindTarget(null);
      var p = P.comp;
      gl.useProgram(p.p);
      ['uS', 'uM', 'uF', 'uW', 'uX'].forEach(function (name, unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, T[name.charAt(1)].t);
        gl.uniform1i(U(p, name), unit);
      });
      gl.activeTexture(gl.TEXTURE0);
      var md = Math.min(bw, bh) * 0.1 * o.lens;
      gl.uniform2f(U(p, 'uR'), bw, bh);
      gl.uniform2f(U(p, 'uK'), md / bw, md / bh);
      gl.uniform1f(U(p, 'uPx'), px);
      gl.uniform1f(U(p, 'uT'), time);
      gl.uniform1f(U(p, 'uRef'), SREF * px);
      gl.uniform4f(U(p, 'uA'), o.lens, o.fog, o.micro, o.grain);
      gl.uniform1f(U(p, 'uTint'), o.tint);
      drawFull();
    }

    function warmUp(sec) {
      for (var t = 0; t < sec; t += 1 / 30) { step(1 / 30); wipe(1 / 30); }
    }

    function frame(now) {
      raf = 0;
      if (!running) return;
      var dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now; time += dt;
      var t0 = root.performance ? performance.now() : 0;
      step(dt); wipe(dt); render();
      if (t0) { meter.n++; meter.dt += dt; meter.cpu += performance.now() - t0; }
      // adaptive quality: sustained < ~38 fps drops the internal resolution
      perfT += dt;
      if (++perfN >= 120) {
        if (perfT / perfN > 0.026 && quality > 0.6) { quality *= 0.8; setup(); }
        perfN = 0; perfT = 0;
      }
      raf = root.requestAnimationFrame(frame);
    }

    function update() {
      var go = !dead && !lost && !o.still && !mq.matches && !document.hidden && onscreen;
      if (go && !running) { running = true; last = 0; raf = root.requestAnimationFrame(frame); }
      else if (!go && running) { running = false; if (raf) root.cancelAnimationFrame(raf); raf = 0; }
    }

    // (re)build size-dependent resources and draw one frame
    function setup() {
      var oW = W, oH = H;
      measure();
      if (oW && (oW !== W || oH !== H)) {
        var keep = (W * H) / (oW * oH);                    // shrinking: thin the drops, keep density
        drops = drops.filter(function (d) { d.x *= W / oW; d.y *= H / oH; return keep >= 1 || rnd() < keep; });
      }
      if (!makeTargets()) { fail(); return false; }
      renderScene();
      render();
      return true;
    }
    function fail() { lost = true; canvas.dataset.rain = 'off'; update(); }

    function onResize() {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (dead || lost) return;
        if (canvas.clientWidth !== W || canvas.clientHeight !== H) setup();
      }, 150);
    }
    function onLost(e) { e.preventDefault(); lost = true; canvas.dataset.rain = 'off'; update(); }
    function onRestored() {
      lost = false; T = {};
      if (initGL() && setup()) { canvas.dataset.rain = 'live'; update(); } else fail();
    }
    function onMotion() { update(); }

    if (!initGL()) { canvas.dataset.rain = 'off'; return { destroy: function () {} }; }
    measure();
    if (!makeTargets()) { canvas.dataset.rain = 'off'; return { destroy: function () {} }; }
    renderScene();
    warmUp(o.warm);
    render();
    canvas.dataset.rain = 'live';

    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    document.addEventListener('visibilitychange', update);
    if (mq.addEventListener) mq.addEventListener('change', onMotion);
    if (root.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(canvas); }
    else root.addEventListener('resize', onResize);
    if (root.IntersectionObserver) {
      io = new IntersectionObserver(function (en) { onscreen = en[en.length - 1].isIntersecting; update(); });
      io.observe(canvas);
    }
    update();

    return {
      destroy: function () {
        dead = true; update(); clearTimeout(rt);
        if (io) io.disconnect();
        if (ro) ro.disconnect(); else root.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', update);
        if (mq.removeEventListener) mq.removeEventListener('change', onMotion);
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        var lc = gl.getExtension('WEBGL_lose_context');
        if (lc) lc.loseContext();
        delete canvas.dataset.rain;
      },
      // for debugging / tuning
      stats: function () {
        var m = meter.n || 1, r = { drops: drops.length, sliding: drops.filter(function (d) { return d.slide; }).length, w: bw, h: bh, px: +px.toFixed(3), quality: +quality.toFixed(2), half: !!half, running: running, fps: +(meter.n / (meter.dt || 1)).toFixed(1), cpuMs: +(meter.cpu / m).toFixed(2) };
        meter = { n: 0, dt: 0, cpu: 0 };
        return r;
      }
    };
  }

  root.mountRainGlass = mountRainGlass;
})(typeof window !== 'undefined' ? window : this);

// ES module entry for the app bundle (the IIFE above also sets window.mountRainGlass for plain pages).
export const mountRainGlass = window.mountRainGlass;
