# Sigmax brand assets

Extracted and cleaned from the **"Cipher / encrypted / confidential"** design file
(`Cipher _ encrypted _ confidential.html`). The mark is **"cipher bands"** — staggered rounded bands
(a redaction / encryption motif) with a single emerald accent band among ink bands.

## Files
| File | Use |
|---|---|
| `sigmax-mark.svg` | Primary mark on **light** backgrounds (ink bands + emerald accent). |
| `sigmax-mark-dark.svg` | Mark on **dark** backgrounds (ivory bands + brighter emerald accent). |
| `sigmax-icon.svg` | App icon / favicon — ink rounded-square tile, ivory bands + emerald accent. |

All are `viewBox="0 0 100 100"`, transparent (except the icon tile), and scale cleanly to any size.

## Colors
| Token | Hex |
|---|---|
| Ink | `#191E29` |
| Emerald (accent) | `#0E9C78` |
| Emerald (light, for dark bg) | `#19B58C` |
| Ivory | `#FBFBF9` |

## Geometry (if you need to recreate/tweak)
Four bands, each `48 × 11`, `rx 1.5`, staggered horizontally:

| Band | x | y | fill |
|---|---|---|---|
| 1 | 33 | 20 | ink |
| 2 | 19 | 37 | ink |
| 3 | 33 | 54 | **emerald (accent)** |
| 4 | 19 | 71 | ink |

## Exporting PNGs (favicon etc.)
No rasterizer is installed locally. Export from any editor/browser, e.g.:
```bash
# with librsvg
rsvg-convert -w 512 -h 512 brand/sigmax-icon.svg -o sigmax-512.png
# or with Inkscape
inkscape brand/sigmax-icon.svg -w 512 -h 512 -o sigmax-512.png
```
Recommended sizes: 16, 32, 64, 256, 512.

## Wordmark
The full logo is this mark + the wordmark **"Sigmax"** set in a clean semibold sans with tight
letter-spacing (matches the app's heading style).
