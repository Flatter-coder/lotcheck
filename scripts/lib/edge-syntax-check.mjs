// Pure checking logic for the edge-function syntax+scope gate, split out of
// scripts/check-edge-function-syntax.mjs so the exact code that ships can be
// exercised directly by scripts/test-edge-function-syntax.mjs against
// synthetic cases -- including both real shapes of the 2026-08-19 recall-
// consolidation corruption -- not just eyeballed against whatever happens to
// be in the tree today. See that test file for why this needs TWO checks:
// Babel's parser is stricter than Node's own `node --check` and independently
// catches one real corrupted shape by parse failure alone, while the other
// real shape parses cleanly under either parser and is caught only by the
// scope-resolution check below.
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default || _traverse;

// Deno/web-standard globals the checking process (Node) does not natively
// provide, or that are worth naming explicitly for clarity even where Node
// happens to have an equivalent. Built empirically against every file under
// supabase/functions/ at the time this gate was added.
export const DENO_GLOBALS = new Set([
  "Deno",
  "fetch", "Response", "Request", "Headers", "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "crypto", "TextEncoder", "TextDecoder",
  "ReadableStream", "WritableStream", "TransformStream",
  "CompressionStream", "DecompressionStream", "btoa", "atob",
  "structuredClone", "queueMicrotask", "FormData", "Blob", "File",
  "performance", "WebSocket",
]);

export const PARSE_PLUGINS = [
  "typescript", "topLevelAwait", "classProperties", "optionalChaining",
  "nullishCoalescingOperator", "dynamicImport",
];

// Checks one file's source. Returns { parseError: string|null, scopeErrors: [{name,line,snippet}] }.
// Never throws -- a parse failure is reported as data, not an exception.
export function checkSource(src) {
  let ast;
  try {
    ast = parse(src, { sourceType: "module", plugins: PARSE_PLUGINS, errorRecovery: false });
  } catch (e) {
    return { parseError: String(e.message || e).split("\n")[0], scopeErrors: [] };
  }

  const scopeErrors = [];
  traverse(ast, {
    // TypeScript-only reference positions Babel's traverse does not already
    // exclude the way it does for plain JS -- these name types, not values,
    // so a type named the same as a runtime-only identifier must never flag.
    TSTypeReference(path) { path.skip(); },
    TSTypeQuery(path) { path.skip(); },
    TSInterfaceDeclaration(path) { path.skip(); },
    TSTypeAliasDeclaration(path) { path.skip(); },
    // A function TYPE's own parameter names -- e.g. `behave: (n: number) =>
    // ...` -- are documentation, never a runtime binding or a reference to
    // one; skip the whole type subtree the same way as the other TS-only
    // node types above.
    TSFunctionType(path) { path.skip(); },
    ImportSpecifier(path) {
      // `import type { Foo } from "..."` -- a type-only import creates no
      // runtime binding to check against, and has none to falsely flag either.
      if (path.node.importKind === "type" || path.parentPath.node.importKind === "type") path.skip();
    },
    ReferencedIdentifier(path) {
      const name = path.node.name;
      if (name === "undefined" || name === "NaN" || name === "Infinity" || name === "arguments") return;
      if (path.scope.hasBinding(name, /* noGlobals */ false)) return;
      if (DENO_GLOBALS.has(name)) return;
      if (Object.prototype.hasOwnProperty.call(globalThis, name)) return;
      if (typeof globalThis[name] !== "undefined") return;

      scopeErrors.push({
        name, line: path.node.loc?.start?.line ?? "?",
        snippet: src.split("\n")[(path.node.loc?.start?.line ?? 1) - 1]?.trim().slice(0, 100),
      });
    },
  });
  return { parseError: null, scopeErrors };
}
