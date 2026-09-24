# LotCheck app icons — 07b "Sticker + Scan"

Source of truth: the 64-unit mark in `public/brand/lotcheck-mark.svg` (navy on white) and
`public/brand/lotcheck-app-icon.svg` (the navy tile). Every PNG here is rendered from that geometry.

| File | Where it goes |
|---|---|
| `ios/AppIcon-1024.png` | App Store Connect marketing icon — opaque, no alpha, square (iOS rounds it) |
| `ios/AppIcon-180.png` | iPhone home screen @3x |
| `ios/AppIcon-167.png` | iPad Pro home screen |
| `ios/AppIcon-152.png` | iPad home screen @2x |
| `ios/AppIcon-120.png` | iPhone home screen @2x |
| `android/play-store-512.png` | Google Play listing icon (full bleed; Play applies the mask) |
| `android/ic_launcher_foreground-432.png` | Adaptive icon foreground layer (432 px = 108 dp @xxxhdpi); mark sits inside the 72 dp safe zone. Background layer: solid `#0B1B3F` |
| `android/ic_launcher-192.png` | Legacy (pre-adaptive) launcher icon |

The web copies (served) live in `public/`: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`,
`icon-96/152/192/512.png` and `icon-maskable-192/512.png` (Android PWA, mark inside the 80% safe circle).
