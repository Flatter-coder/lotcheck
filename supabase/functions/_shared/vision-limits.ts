// Will Anthropic accept this image? Decided BEFORE the request, not after.
//
// WHY THIS EXISTS. A Stampede Toyota listing failed for Vic on 2026-08-16 with
// "This dealer site may be blocking automated access". The dealer was not
// blocking: a plain curl returned HTTP 200 with the full 903 KB page and clean
// JSON-LD in 1.4 seconds. The edge logs told the real story —
//
//     scrapflyRender error: Signal timed out.
//     scrapfly-rescue Claude HTTP 400
//     Scrapfly render fallback produced no usable data
//
// — and an HTTP 400 from Anthropic is a MALFORMED REQUEST, i.e. ours. The
// rescue was posting whatever screenshot the render produced with no size check
// at all, even though the same file already carries a comment about a
// 17,729px-tall capitalchev.ca capture that "fails outright".
//
// The text path was sitting right underneath it, implemented and working. So
// the fix is not to retry the image — it is to not send one we already know
// will be refused, and take the text instead.
//
// LIMITS, deliberately conservative. Anthropic documents ~8000px on the long
// edge for a single image and rejects oversized payloads; the byte ceiling here
// sits below the documented maximum so a borderline capture degrades to text
// rather than gambling a paid scan on the boundary. Missing beats wrong applies
// to a rescue too: a text pass that works beats an image pass that 400s.

export const VISION_MAX_B64_BYTES = 4_500_000;   // under Anthropic's ~5 MB image ceiling
export const VISION_MAX_EDGE_PX   = 8_000;       // documented long-edge limit
export const VISION_MAX_PIXELS    = 30_000_000;  // matches capture.ts PNG_PIXEL_BUDGET

/** PNG dimensions live at a fixed offset in the IHDR chunk. Null if not a PNG. */
export function pngDimensions(b64: string): { width: number; height: number } | null {
  try {
    const head = atob(b64.slice(0, 120));
    if (head.charCodeAt(0) !== 0x89 || head.slice(1, 4) !== "PNG") return null;
    const be = (o: number) =>
      (head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) |
      (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3);
    const width = be(16), height = be(20);
    if (!(width > 0 && height > 0)) return null;
    return { width, height };
  } catch { return null; }
}

export type VisionVerdict = { ok: boolean; reason: string; bytes: number; width?: number; height?: number };

/**
 * `ok:false` means "do not send this image" — the caller should fall back to
 * text. It is never a hard error: a rescue that degrades still returns a report.
 */
export function visionImageVerdict(b64: string | null | undefined, _mime?: string | null): VisionVerdict {
  if (!b64) return { ok: false, reason: "no screenshot", bytes: 0 };

  // base64 encodes 3 bytes per 4 chars; the decoded size is what travels.
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > VISION_MAX_B64_BYTES) {
    return { ok: false, bytes, reason: `screenshot is ${(bytes / 1e6).toFixed(1)} MB, over the ${(VISION_MAX_B64_BYTES / 1e6).toFixed(1)} MB vision limit` };
  }

  const dim = pngDimensions(b64);
  if (dim) {
    const longEdge = Math.max(dim.width, dim.height);
    if (longEdge > VISION_MAX_EDGE_PX) {
      return { ok: false, bytes, width: dim.width, height: dim.height,
        reason: `screenshot is ${dim.width}x${dim.height}px; the ${VISION_MAX_EDGE_PX}px long-edge limit rejects it` };
    }
    if (dim.width * dim.height > VISION_MAX_PIXELS) {
      return { ok: false, bytes, width: dim.width, height: dim.height,
        reason: `screenshot is ${(dim.width * dim.height / 1e6).toFixed(1)} MP, over the ${(VISION_MAX_PIXELS / 1e6)} MP budget` };
    }
    return { ok: true, bytes, width: dim.width, height: dim.height, reason: "within vision limits" };
  }

  // Not a PNG (JPEG renders are common) — dimensions are not cheaply readable,
  // so the byte ceiling above is the only gate. It is the one that fires in
  // practice, because a very tall page produces a very large file.
  return { ok: true, bytes, reason: "within the byte limit (dimensions unreadable, non-PNG)" };
}
