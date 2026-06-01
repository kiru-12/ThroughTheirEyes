# ThroughTheirEyes

A mobile-first PWA that uses your device's camera and WebGL to simulate 13 vision conditions in real time. See the world through the eyes of someone with colour blindness, glaucoma, cataracts, myopia, and more — no install required.

**[Live demo →](https://YOUR_USERNAME.github.io/through-their-eyes/)**

---

## Features

- **13 vision conditions** simulated in real time at 60 fps via WebGL
- **Scientifically grounded** — uses Viénot 1999 (protan/deutan), Brettel 1997 (tritan), and clinically validated structural models
- **Condition-specific controls** — adjust subtype, stage, severity, and axis for each condition
- **Split-screen mode** — compare normal and simulated vision side by side
- **Hold-to-compare** — instantly toggle back to normal vision
- **PWA** — works offline, installable on mobile

## Conditions

| Category | Conditions |
|---|---|
| Colour blindness | Deuteranopia, Protanopia, Tritanopia, Achromatopsia |
| Structural eye disease | Glaucoma, Cataracts, Macular Degeneration, Retinitis Pigmentosa |
| Refractive errors | Myopia, Hyperopia, Astigmatism, Presbyopia |

## Usage

Open the app in any modern browser, grant camera permission, and tap a condition to simulate it. Use the controls that appear below the mode selector to adjust severity and subtype.

### Running locally

```bash
npx serve .
```

Then open `http://localhost:3000`.

## Tech stack

- Vanilla HTML / CSS / JavaScript — no framework, no build step
- WebGL (with WebGL 2 / WebGL 1 fallback)
- GLSL fragment shaders for all simulation math
- `getUserMedia` for live camera feed

## Algorithms

- **Protanopia / Deuteranopia** — LMS projection, Viénot et al. 1999
- **Tritanopia** — two-plane LMS projection, Brettel et al. 1997
- **Achromatopsia** — BT.709 luminance
- **LMS matrices** — Smith-Pokorny 1975, sRGB-adapted (DaltonLens)
- **sRGB pipeline** — full IEC 61966-2-1 encode/decode on every pixel

## License

MIT
