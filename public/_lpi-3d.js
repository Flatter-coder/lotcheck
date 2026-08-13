/* ── MSRP Live Index: hero pedestal parallax ────────────────────────────────
   The median figure stands on a 3D disc (#idxPodium); this tilts it a few
   degrees to follow the pointer. That is ALL this file does — the wireframe
   backdrop and 3D powertrain chart that used to live here were removed on
   purpose (commit 2307a25, "screenshot is the spec"); do not re-add them.
   Additive and self-contained: if the element is missing or the user prefers
   reduced motion, it does nothing. */
(function () {
  var RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pod = document.getElementById("idxPodium");
  if (pod && !RM) {
    addEventListener("mousemove", function (e) {
      pod.style.setProperty("--pry", ((e.clientX / innerWidth - 0.5) * 12).toFixed(2) + "deg");
      pod.style.setProperty("--prx", (13 - (e.clientY / innerHeight - 0.5) * 8).toFixed(2) + "deg");
    }, { passive: true });
  }
})();
