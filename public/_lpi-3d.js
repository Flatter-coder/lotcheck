/* ── depth backdrop + 3D powertrain chart ───────────────────────────────────
   Additive and self-contained: reads the catalog the page already loaded and
   touches nothing else on it. If the catalog never arrives, the chart hides its
   own section rather than drawing an empty grid.

   The depth axis is a CATEGORY (powertrain), never a magnitude, and the
   projection is axonometric — a bar at the back is drawn at exactly the same
   scale as the same value at the front. Perspective separates the series; it
   never rescales a number you are comparing. */
(function () {
  var RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var rootCss = getComputedStyle(document.documentElement);
  function tok(n, f) { var v = rootCss.getPropertyValue(n).trim(); return v || f; }
  function isLight() {
    return document.documentElement.getAttribute("data-theme") === "light" ||
           document.body.classList.contains("light");
  }

  /* ---- receding wireframe plane ---- */
  var mc = document.getElementById("lcMesh");
  if (mc) {
    var g = mc.getContext("2d"), MW = 0, MH = 0, D = 1, t = 0, mvx = 0, mvy = 0;
    var msize = function () {
      D = Math.min(devicePixelRatio || 1, 2);
      MW = mc.width = innerWidth * D;
      MH = mc.height = mc.clientHeight * D;
    };
    addEventListener("mousemove", function (e) {
      mvx = e.clientX / innerWidth - 0.5; mvy = e.clientY / innerHeight - 0.5;
    }, { passive: true });
    var mesh = function () {
      g.clearRect(0, 0, MW, MH); g.lineWidth = D;
      var hz = MH * 0.05, rows = 20, cols = 24, amp = MH * 0.045, L = isLight();
      var P = function (gx, gz) {
        var d = 1 / (gz * 0.92 + 0.16);
        var w = Math.sin(gx * 2.6 + gz * 3.1 + t) * amp * (1 - gz) * 0.55;
        return [MW / 2 + (gx - 0.5) * MW * 1.8 * d, hz + (MH - hz) * d * 0.95 + w];
      };
      for (var r = 0; r <= rows; r++) {
        var gz = r / rows; g.beginPath();
        for (var c = 0; c <= cols; c++) { var q = P(c / cols, gz); c ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }
        g.strokeStyle = L ? "rgba(22,32,52," + ((1 - gz) * 0.22 + 0.03) + ")"
                          : "rgba(120,200,255," + ((1 - gz) * 0.30 + 0.03) + ")";
        g.stroke();
      }
      for (var c2 = 0; c2 <= cols; c2++) {
        g.beginPath();
        for (var r2 = 0; r2 <= rows; r2++) { var q2 = P(c2 / cols, r2 / rows); r2 ? g.lineTo(q2[0], q2[1]) : g.moveTo(q2[0], q2[1]); }
        g.strokeStyle = L ? "rgba(22,32,52,.07)" : "rgba(120,200,255,.09)";
        g.stroke();
      }
      if (!RM) t += 0.011;
      mc.style.transform = "translate3d(" + (mvx * -12).toFixed(1) + "px," + (mvy * -5).toFixed(1) + "px,0)";
      requestAnimationFrame(mesh);
    };
    msize(); mesh(); addEventListener("resize", msize);
  }

  /* ---- 3D chart: price band x powertrain ---- */
  var ch = document.getElementById("pt3d");
  if (!ch) return;
  var cg = ch.getContext("2d");
  var PT = [
    { k: "Gas", c: "#8b95a6" },
    { k: "Hybrid", c: tok("--cyan", "#3ae0ff") },
    { k: "PHEV", c: tok("--gate", "#8b7bff") },
    { k: "BEV", c: tok("--up", "#3ecf8e") }
  ];
  var CUT = [0, 30000, 45000, 60000, 80000, 100000, 130000, 170000, 1e9];
  var LBL = ["<30k", "30-45k", "45-60k", "60-80k", "80-100k", "100-130k", "130-170k", "170k+"];
  var series = null, CW = 0, CH = 0, DP = 1, grow = 1, yaw = 0.62, drag = false, lastX = 0;

  function build(rows) {
    var out = PT.map(function (p) {
      return { name: p.k, c: p.c, d: LBL.map(function () { return 0; }) };
    });
    rows.forEach(function (r) {
      var v = Number(r.msrp); if (!(v > 0)) return;
      var f = String(r.fuel_type || "").toUpperCase();
      var zi = (f.indexOf("PHEV") > -1 || f.indexOf("PLUG") > -1) ? 2
             : (f.indexOf("BEV") > -1 || f.indexOf("ELECTRIC") > -1) ? 3
             : (f.indexOf("HYBRID") > -1) ? 1
             : f ? 0 : -1;
      if (zi < 0) return;                 // untagged rows are never guessed into a bucket
      for (var b = 0; b < LBL.length; b++) {
        if (v >= CUT[b] && v < CUT[b + 1]) { out[zi].d[b]++; break; }
      }
    });
    return out.filter(function (s) { return s.d.some(function (n) { return n > 0; }); });
  }

  function shade(hex, amt) {
    var m = String(hex).trim();
    if (m.charAt(0) !== "#") return m;
    if (m.length === 4) m = "#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    var n = parseInt(m.slice(1), 16);
    var f = function (v) { return Math.max(0, Math.min(255, Math.round(v * amt))); };
    return "rgb(" + f((n >> 16) & 255) + "," + f((n >> 8) & 255) + "," + f(n & 255) + ")";
  }

  function size() {
    DP = Math.min(devicePixelRatio || 1, 2);
    CW = ch.width = ch.clientWidth * DP;
    CH = ch.height = ch.clientHeight * DP;
  }

  function draw() {
    if (!series || !series.length) return;
    var L = isLight();
    cg.clearRect(0, 0, CW, CH);
    var P = 30 * DP, depth = Math.min(CW * 0.27, 124 * DP);
    var dx = Math.cos(yaw) * depth, dy = Math.sin(yaw) * depth * 0.92, aw = 34 * DP;
    var pw = CW - P - aw - dx - 10 * DP, ph = CH - P - dy - 30 * DP;
    var ox = P + aw, oy = CH - P - 14 * DP;
    var zN = series.length, xN = LBL.length;
    var maxV = 0;
    series.forEach(function (s) { s.d.forEach(function (v) { if (v > maxV) maxV = v; }); });
    if (!(maxV > 0)) return;
    var pr = function (gx, gy, gz) { return [ox + gx * pw + gz * dx, oy - gy * ph - gz * dy]; };
    var line = function (a) { return L ? "rgba(22,32,52," + a + ")" : "rgba(160,190,255," + a + ")"; };

    cg.lineWidth = DP;
    for (var i = 0; i <= zN; i++) {
      var a = pr(0, 0, i / zN), b = pr(1, 0, i / zN);
      cg.beginPath(); cg.moveTo(a[0], a[1]); cg.lineTo(b[0], b[1]); cg.strokeStyle = line(0.28); cg.stroke();
    }
    for (var i2 = 0; i2 <= xN; i2++) {
      var a2 = pr(i2 / xN, 0, 0), b2 = pr(i2 / xN, 0, 1);
      cg.beginPath(); cg.moveTo(a2[0], a2[1]); cg.lineTo(b2[0], b2[1]); cg.strokeStyle = line(0.16); cg.stroke();
    }
    cg.font = (10 * DP) + "px ui-monospace,SFMono-Regular,Menlo,monospace";
    cg.fillStyle = L ? "#5a6579" : "#8b95a6";
    cg.textAlign = "right";
    for (var tk = 0; tk <= 3; tk++) {
      var gy = tk / 3, va = Math.round(maxV * gy);
      var p1 = pr(0, gy, 1), p2 = pr(1, gy, 1);
      cg.beginPath(); cg.moveTo(p1[0], p1[1]); cg.lineTo(p2[0], p2[1]); cg.strokeStyle = line(0.14); cg.stroke();
      cg.fillText(va, p1[0] - 7 * DP, p1[1] + 3.5 * DP);
    }

    var bw = pw / xN * 0.62, bd = 1 / zN * 0.50;
    for (var zi = zN - 1; zi >= 0; zi--) {          // painter's order: far row first
      var S = series[zi], gz0 = (zi + 0.19) / zN;
      for (var xi = xN - 1; xi >= 0; xi--) {
        var v = S.d[xi] * grow; if (v <= 0) continue;
        var gy2 = v / maxV, gx0 = xi / xN + (pw / xN - bw) / 2 / pw;
        var q = function (ax, ay, az) { return pr(gx0 + ax * (bw / pw), ay, gz0 + az * bd); };
        var A = q(0, gy2, 0), B = q(1, gy2, 0), C = q(1, gy2, 1), Dd = q(0, gy2, 1);
        var A0 = q(0, 0, 0), B0 = q(1, 0, 0), C0 = q(1, 0, 1);
        cg.beginPath(); cg.moveTo(A[0], A[1]); cg.lineTo(B[0], B[1]); cg.lineTo(B0[0], B0[1]); cg.lineTo(A0[0], A0[1]); cg.closePath();
        cg.fillStyle = shade(S.c, 0.72); cg.fill();
        cg.beginPath(); cg.moveTo(B[0], B[1]); cg.lineTo(C[0], C[1]); cg.lineTo(C0[0], C0[1]); cg.lineTo(B0[0], B0[1]); cg.closePath();
        cg.fillStyle = shade(S.c, 0.46); cg.fill();
        cg.beginPath(); cg.moveTo(A[0], A[1]); cg.lineTo(B[0], B[1]); cg.lineTo(C[0], C[1]); cg.lineTo(Dd[0], Dd[1]); cg.closePath();
        cg.fillStyle = shade(S.c, 1.06); cg.fill();
        cg.strokeStyle = L ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.10)"; cg.stroke();
      }
    }
    cg.fillStyle = L ? "#5a6579" : "#8b95a6";
    cg.textAlign = "center";
    var step = (pw / xN) < 34 * DP ? 2 : 1;   // thin the labels before they collide
    LBL.forEach(function (b, i) {
      if (i % step) return;
      var qq = pr(i / xN + 0.5 / xN, 0, 0);
      cg.fillText(b, qq[0], qq[1] + 15 * DP);
    });
  }

  // Correct first, animated second. requestAnimationFrame does not run in a
  // background tab, so an animation that OWNS the bars renders an empty grid to
  // anyone who opens the page in a new tab and comes back.
  function render() {
    size();
    grow = 1; draw();
    if (!RM && document.visibilityState === "visible") {
      grow = 0;
      (function step() {
        grow = Math.min(1, grow + 0.03); draw();
        if (grow < 1) requestAnimationFrame(step);
      })();
      setTimeout(function () { if (grow < 1) { grow = 1; draw(); } }, 1800);
    }
  }

  function load() {
    var cat = window.__lcCatalog;
    if (!cat || !cat.rows || !cat.rows.length) return false;
    series = build(cat.rows);
    var sec = ch.closest ? ch.closest("section") : null;
    if (!series.length) { if (sec) sec.style.display = "none"; return true; }
    var lg = document.getElementById("pt3dLg");
    if (lg) lg.innerHTML = series.map(function (s) {
      var n = s.d.reduce(function (a, b) { return a + b; }, 0);
      return '<span><i style="background:' + s.c + '"></i>' + s.name + " · " + n + "</span>";
    }).join("");
    render();
    return true;
  }

  addEventListener("lc-catalog", load);
  if (!load()) {
    var tries = 0;
    var iv = setInterval(function () { if (load() || ++tries > 40) clearInterval(iv); }, 300);
  }
  addEventListener("resize", function () { if (series) render(); });

  ch.addEventListener("pointerdown", function (e) { drag = true; lastX = e.clientX; ch.setPointerCapture(e.pointerId); });
  ch.addEventListener("pointerup", function () { drag = false; });
  ch.addEventListener("pointermove", function (e) {
    if (!drag) return;
    yaw = Math.max(0.18, Math.min(1.25, yaw + (e.clientX - lastX) * 0.006));
    lastX = e.clientX; draw();
  });

  // repaint on theme change (canvas colours are resolved at draw time)
  new MutationObserver(function () { if (series) draw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
})();
