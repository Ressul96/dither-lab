# Algorithms and Color Spec

## Algorithm Catalog

Total algorithms: 27

### Error diffusion (11)

1. Floyd-Steinberg
2. False Floyd-Steinberg
3. Jarvis-Judice-Ninke
4. Stucki
5. Atkinson
6. Burkes
7. Sierra
8. Two-Row Sierra
9. Sierra Lite
10. Stevenson-Arce
11. Riemersma

Notes:
- Error-diffusion algorithms are inherently sequential.
- They run on CPU in v1.
- All support serpentine scan direction when applicable.
- All relevant ones support `errorStrength`.

Reference characteristics:
- Floyd-Steinberg: `[* 7] / [3 5 1] / 16`
- False Floyd-Steinberg: `[* 3] / [3 2] / 8`
- Atkinson diffuses only `6/8` of the error, giving its softer signature look.
- Riemersma walks a Hilbert curve and diffuses error along a 1D path.

### Ordered / Bayer (8)

12. Bayer 2x2
13. Bayer 4x4
14. Bayer 8x8
15. Bayer 16x16
16. Clustered Dot 4x4
17. Clustered Dot 8x8
18. Halftone
19. Dispersed Dot

Notes:
- Use threshold matrices.
- These are good candidates for WebGL acceleration.

### Threshold / Noise (4)

20. Simple Threshold
21. Random
22. Blue Noise
23. Interleaved Gradient Noise

Notes:
- Blue Noise samples from a precomputed texture.
- Random and noise-driven algorithms must honor seed lock.

### Pattern (4)

24. Cross-hatch
25. Horizontal lines
26. Vertical lines
27. Dot pattern

## Algorithm Registry Shape

```js
{
  id: 'floyd-steinberg',
  name: 'Floyd-Steinberg',
  family: 'error-diffusion',
  type: 'cpu', // 'cpu' | 'gl'
  supportsSerpentine: true,
  supportsErrorStrength: true,
  run: (imageData, params, palette) => imageData
}
```

## Color and Palette System

Each palette is shaped like:

```js
{
  id: 'gameboy-dmg',
  name: 'Gameboy DMG',
  colors: [
    [15, 56, 15],
    [48, 98, 48],
    [139, 172, 15],
    [155, 188, 15]
  ]
}
```

### Built-in palettes

- Monochrome
- Grayscale 2-bit
- Grayscale 4-bit
- Gameboy DMG
- Gameboy Pocket
- CGA Mode 4 Palette 1
- CGA Mode 5
- NES
- Commodore 64
- Mac Plus
- ZX Spectrum
- Teletext
- Pico-8
- Apple II Lo-Res

### Palette matching

- Default matching: nearest color in RGB space for speed
- Future option: CIE Lab matching for more accurate but slower results
- Palette LUT should be precomputed for performance

### Palette extraction

- Extract from current frame or sampled trim range
- User chooses the extracted palette size
- Result lands in the custom palette editor
- Locked swatches remain preserved during re-extraction

## Color Consistency Rules

- The same palette mapping logic must be used in preview and export.
- Seed-locked algorithms and effect layers must produce identical results in preview and export.
- EXR exposure and tonemap happen before dithering and before palette matching.
- Hidden layers do not influence export color output.

