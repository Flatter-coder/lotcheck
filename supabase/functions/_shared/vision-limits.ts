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

/**
 * JPEG dimensions live in the SOFn frame header, which -- unlike PNG's IHDR --
 * is not at a fixed offset: it sits after whatever quantisation tables, Exif
 * and comment segments the encoder chose to emit first. So this walks the
 * marker chain to find it.
 *
 * WHY IT HAD TO EXIST. pngDimensions returns null for a JPEG, and the verdict
 * below then fell through to "dimensions unreadable, non-PNG" and answered
 * ok:true on the byte ceiling alone. Scrapfly returns JPEG BY DEFAULT and this
 * file's own header names a 17,729px-tall capitalchev.ca capture as the case
 * that "fails outright" -- so the guard written to stop exactly that image was
 * blind to the only format we ever produce. A tall page compresses well: it
 * can sit far under 4.5 MB and still be 17,729 px on the long edge, sail past
 * this function, and take the HTTP 400 downstream that the whole module exists
 * to prevent.
 *
 * `maxScanBytes` bounds the walk: a header is a few KB in practice, and a
 * truncated or hostile file must cost O(1), not a scan of several megabytes.
 * Not finding SOFn inside the budget returns null, which lands on the same
 * byte-only verdict as before -- no worse than today, never a false reject.
 */
export function jpegDimensions(b64: string, maxScanBytes = 262_144): { width: number; height: number } | null {
  try {
    // 4 b64 chars per 3 bytes; atob only the prefix we intend to walk.
    const head = atob(b64.slice(0, Math.ceil((maxScanBytes * 4) / 3)));
    if (head.charCodeAt(0) !== 0xFF || head.charCodeAt(1) !== 0xD8) return null; // not SOI
    let i = 2;
    while (i + 9 < head.length) {
      if (head.charCodeAt(i) !== 0xFF) return null;           // desynchronised
      const m = head.charCodeAt(i + 1);
      if (m === 0xFF) { i++; continue; }                       // fill byte
      // Standalone markers carry no length payload.
      if (m === 0x01 || m === 0xD8 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xDA || m === 0xD9) return null;               // entropy data / end: past the header
      const len = (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3);
      if (len < 2) return null;                                // malformed; a 0 would loop forever
      // SOF0..SOF15 carry the frame size. DHT (C4), JPG (C8) and DAC (CC) sit
      // inside that numeric range and are NOT frame headers.
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        const height = (head.charCodeAt(i + 5) << 8) | head.charCodeAt(i + 6);
        const width = (head.charCodeAt(i + 7) << 8) | head.charCodeAt(i + 8);
        if (!(width > 0 && height > 0)) return null;
        return { width, height };
      }
      i += 2 + len;
    }
    return null;
  } catch { return null; }
}

/** Dimensions of whichever of the two formats we actually produce. */
export function imageDimensions(b64: string): { width: number; height: number } | null {
  return pngDimensions(b64) ?? jpegDimensions(b64);
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

  const dim = imageDimensions(b64);
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

  // Neither header was readable — a truncated file, or a frame header past the
  // scan budget. The byte ceiling above is then the only gate, which is where
  // EVERY jpeg used to land before jpegDimensions existed.
  return { ok: true, bytes, reason: "within the byte limit (dimensions unreadable)" };
}
