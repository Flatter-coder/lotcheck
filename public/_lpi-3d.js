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

  /* ---- median pedestal: pointer parallax ---- */
  var pod = document.getElementById("idxPodium");
  if (pod && !RM) {
    addEventListener("mousemove", function (e) {
      pod.style.setProperty("--pry", ((e.clientX / innerWidth - 0.5) * 12).toFixed(2) + "deg");
      pod.style.setProperty("--prx", (13 - (e.clientY / innerHeight - 0.5) * 8).toFixed(2) + "deg");
    }, { passive: true });
  }
})();
