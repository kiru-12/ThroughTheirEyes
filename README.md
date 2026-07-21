# ThroughTheirEyes

A mobile-first PWA that uses your device's camera and WebGL to simulate 13 vision conditions in real time. See the world through the eyes of someone with colour blindness, glaucoma, cataracts, myopia, and more — no install required.

**[Live demo →](https://kiru-12.github.io/ThroughTheirEyes/)**

> ⚕️ **Disclaimer:** This is an educational simulation, not a diagnostic tool or
> medical advice. It is an artistic approximation of how these conditions *may*
> appear, not a measurement of any individual's vision. If you have any concern
> about your eyesight, please see an optometrist or ophthalmologist.

---

## Features

- **13 vision conditions** simulated in real time at 60 fps via WebGL
- **Scientifically grounded** — Machado 2009 (protan/deutan), Brettel 1997 (tritan), and clinically validated structural models
- **Daltonization** — a "Correct" mode on the colour-vision conditions redistributes lost colour information instead of simulating the loss
- **Condition-specific controls** — adjust subtype, stage, severity, and axis for each condition
- **Split-screen mode** — compare normal and simulated vision side by side, with a draggable divider
- **Hold-to-compare** — instantly toggle back to normal vision (hold the A|B button or Space)
- **Photo mode** — load any image and simulate on it, no camera needed (great for checking your own designs)
- **Sample plates** — procedurally generated pseudo-Ishihara test plates when no camera is available
- **Freeze-frame** — pause the feed and adjust severity on a still frame
- **Snapshot** — save or share a PNG of the simulated view
- **Torch & zoom** — camera flashlight and zoom controls where the hardware supports them
- **Keyboard shortcuts** — 0-9 select conditions, Space compares, S splits, F freezes, M opens the menu
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

## How accurate is this?

Accuracy varies by condition, and it's worth being honest about it:

- **Colour-vision deficiency** (protan/deutan/tritan) uses the same peer-reviewed
  models as research and browser tooling (Machado 2009, Brettel 1997) with a
  correct sRGB↔linear pipeline. This part is research-grade.
- **Structural and refractive conditions** (glaucoma, AMD, cataracts, retinitis
  pigmentosa, myopia, etc.) are **illustrative approximations**, not validated
  models. Scotoma shapes are procedurally generated to look organic rather than
  fitted to any individual's visual-field data, and a 2D camera cannot reproduce
  the depth-dependent focus of real refractive errors.

Treat it as an empathy and awareness tool, not a clinical reference.

## Testing

The pure-math modules (CVD matrices, condition registry, label formatters) are
unit-tested with Node's built-in test runner — no dependencies:

```bash
npm test
```

## Tech stack

- Vanilla HTML / CSS / JavaScript — no framework, no build step
- WebGL (with WebGL 2 / WebGL 1 fallback)
- GLSL fragment shaders for all simulation math
- `getUserMedia` for live camera feed

## Algorithms

- **Protanopia / Deuteranopia** — Machado, Oliveira & Fernandes 2009 severity matrices, applied in linear RGB; the intensity slider drives clinical severity
- **Tritanopia** — Brettel, Viénot & Mollon 1997 two-plane projection (sRGB-adapted constants from DaltonLens); the Machado severity fit is unreliable for tritan
- **Daltonization** — Fidaner et al. 2005 error redistribution ("Correct" mode)
- **Achromatopsia** — rod-weighted (scotopic) luminance + photophobia bloom
- **sRGB pipeline** — full IEC 61966-2-1 encode/decode on every pixel

## License

MIT
