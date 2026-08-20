// UNDEFINED IDENTIFIER GATE — catches the class of bug that takes a whole view
// down while every other check stays green.
//
// WHY THIS EXISTS. On 2026-08-12 the scroll view crashed on EVERY report:
// src/App.jsx referenced `msrpExactScroll` from outside the scope that declared
// it (the const lived inside an IIFE further down the file). `npm run build` was
// green, the invariants passed, the copy gate passed, the parity gate passed —
// because an undefined identifier is a RUNTIME ReferenceError in JavaScript, not
// a build error. Nothing in the pipeline could see it. It only surfaced when the
// view was opened in a browser, and it had been shipping.
//
// App.jsx is a ~8,000-line monolith of deeply nested JSX and IIFEs. That is
// exactly the shape where a variable gets referenced one scope too high, so this
// cannot be a one-off fix -- it needs a gate.
//
// HOW. Real scope analysis via @babel/traverse (already installed as a
// transitive dependency of @vitejs/plugin-react — no new packages). For every
// referenced identifier we ask Babel's own scope chain whether a binding exists.
// This is what ESLint's no-undef does, minus the dependency.
//
// Run (from repo root):  npm run check:undef
// Exit 0 = clean; 1 = at least one identifier that will throw at runtime.
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default || _traverse;

const FILES = ["src/App.jsx", "src/main.jsx", "src/scraper.js", "src/verify.js", "src/icons3d.jsx"];

// Globals the browser (and our build) provide. Node's own globalThis covers the
// language builtins; this list covers the DOM/browser surface Node lacks.
const BROWSER_GLOBALS = new Set([
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "fetch", "Headers", "Request", "Response", "AbortController", "AbortSignal", "FormData",
  "Blob", "File", "FileReader", "Image", "URL", "URLSearchParams", "WebSocket", "Worker",
  "alert", "confirm", "prompt", "atob", "btoa", "escape", "unescape",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "getComputedStyle", "matchMedia", "IntersectionObserver", "ResizeObserver", "MutationObserver",
  "HTMLElement", "Element", "Node", "Event", "CustomEvent", "CanvasRenderingContext2D",
  "caches", "indexedDB", "crypto", "performance", "screen", "frames", "self", "top", "parent",
  "DOMParser", "XMLHttpRequest", "getSelection", "scrollTo", "open", "close", "print",
  "ServiceWorkerRegistration", "Notification", "MediaQueryList", "DeviceOrientationEvent",
  "SpeechSynthesisUtterance", "SpeechSynthesisEvent",
]);

const failures = [];

for (const file of FILES) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }

  const ast = parse(src, {
    sourceType: "module",
    plugins: ["jsx", "classProperties", "optionalChaining", "nullishCoalescingOperator", "dynamicImport"],
    errorRecovery: false,
  });

  traverse(ast, {
    ReferencedIdentifier(path) {
      const name = path.node.name;

      // JSX member expressions like <Foo.Bar> and object keys are not references.
      if (path.parentPath?.isJSXMemberExpression?.() && path.key === "property") return;
      // `undefined` / `NaN` / `Infinity` are legal identifiers, not bindings.
      if (name === "undefined" || name === "NaN" || name === "Infinity" || name === "arguments") return;

      if (path.scope.hasBinding(name, /* noGlobals */ false)) return;
      if (BROWSER_GLOBALS.has(name)) return;
      if (Object.prototype.hasOwnProperty.call(globalThis, name)) return;
      if (typeof globalThis[name] !== "undefined") return;

      failures.push({ file, line: path.node.loc?.start.line ?? 0, name });
    },
  });
}

if (failures.length) {
  console.error("UNDEFINED IDENTIFIER GATE — FAILED\n");
  // Same identifier can be referenced several times; report each site, it is
  // usually the same root cause and they should all be fixed together.
  for (const f of failures) {
    console.error(`  ✗ ${f.file}:${f.line}: '${f.name}' is not defined in this scope — it will throw a ReferenceError at runtime and take the whole view down.`);
  }
  console.error(`\n${failures.length} undefined reference(s). A green build does NOT catch these.`);
  process.exit(1);
}

console.log(`UNDEFINED IDENTIFIER GATE — clean (${FILES.length} files, full scope analysis).`);
