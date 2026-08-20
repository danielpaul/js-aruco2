# aruco3

ArUco marker detection in pure JavaScript, for the browser and Node. Ships ESM,
TypeScript types, a Web Worker, and a React hook — no WebAssembly, no build step
on your side.

Supports the OpenCV predefined dictionaries (including **`DICT_5X5_50`**),
AprilTag, ARToolKitPlus, ARTag, ChiliTags and ArUco MIP, plus any custom square
marker set you define.

```bash
npm install aruco3
```

**This is version 3.** It is a rewrite of the 2.x library that finds markers 2.x
missed, stops reporting ones that were never there, and ships as a module you
can import. [What's new in 3.0](#whats-new-in-30) has the measurements;
[Migrating from 2.x](#migrating-from-2x) has the API changes.

The 2.x line is published as `js-aruco2`. This rewrite is a separate package —
installing `aruco3` does not upgrade an existing `js-aruco2` install, and the
two can sit side by side while you migrate.

---

## Quick start

```js
import { Detector, Dictionary } from 'aruco3';
import dict5x5_50 from 'aruco3/dictionaries/dict-5x5-50';

const detector = new Detector({ dictionary: new Dictionary(dict5x5_50) });

const ctx = canvas.getContext('2d', { willReadFrequently: true });
const markers = detector.detect(ctx.getImageData(0, 0, canvas.width, canvas.height));

for (const m of markers) {
  console.log(m.id, m.corners, m.hammingDistance);
}
```

`detect()` takes one object with `{ width, height, data }` — an `ImageData`
satisfies it directly.

Each result is:

```ts
{
  id: number,                              // marker id within the dictionary
  corners: { x: number, y: number }[],     // 4 corners, clockwise, marker-relative order
  hammingDistance: number,                 // 0 for an exact read
  rotation: number,                        // quarter turns applied to align the code
}
```

---

## What's new in 3.0

The detection pipeline is unchanged in spirit. What changed is that it now
returns correct results, can be imported, and runs off the main thread.

### It finds more markers, and stops inventing them

Same frames, same battery, 2.x baseline (kept in `legacy/`) against 3.0. Recall
is over the 26 markers the battery expects across 22 single-marker frames and
one four-marker frame; false positives are extra ids anywhere in the battery,
including three marker-free texture frames and a solid black square.
`npm run test:golden` reproduces this table and fails the build on any drift.

| Dictionary | 2.x recall / FP | 3.0 recall / FP |
| --- | --- | --- |
| `ARUCO_MIP_36h12` | 84.6% / 37 | **96.2% / 0** |
| `CHILITAGS` | 0.0% / 35 | **96.2% / 0** |
| `ARUCO_7X7_1000` | 80.8% / 0 | **96.2% / 0** |
| `ARUCO` | 96.2% / 0 | 96.2% / 0 |
| `ARUCO_5X5_1000` | 96.2% / 0 | 96.2% / 0 |

What was behind those numbers:

- The acceptance bound was `tau − 1`, treating the dictionary's minimum
  inter-code distance as an error budget. 14 of the 20 bundled dictionaries
  therefore matched *any* random bit pattern to some id. It is now
  `floor((tau − 1) / 2)`, with `tau` taken over all four relative rotations
  because `find()` matches every rotation, and it agrees with OpenCV's declared
  `maxCorrectionBits` for all 16 predefined sets.
- `warpSize` was hardcoded to 49 instead of derived from the dictionary grid, so
  CHILITAGS sampled the wrong cells and decoded nothing — while every solid dark
  rectangle decoded as its all-zero code at distance 0.
- The warp sampled one pixel off in both axes and read out of bounds on the last
  row and column.
- Candidates were deduplicated by a fixed 10 px threshold *before* decoding,
  which discarded the decodable quad in favour of its quiet-zone neighbour.
  Smallest reliable marker: 70 px → **12 px**.
- `svd.js` carried an unconverted 1-based loop that threw `TypeError` on 9.7% of
  fuzzed inputs.
- POSIT converged on a rounded-integer residual and reported it as `bestError`,
  so `bestError` read 0 for poses up to 35° wrong. Convergence and the reported
  error are sub-pixel floats now.
- `detect()` validates its input. A 16-byte buffer claiming to be 8000×8000 used
  to allocate ~2 GB and block for ten seconds.
- ARTag's 57 duplicate codes are dropped with a warning instead of collapsing
  `tau` to 0 and silently disabling error correction.

### It imports

ESM throughout, with an exports map, `.d.ts` types and a CJS build for
`require`. Importing 2.x as ESM threw `TypeError`. Dictionaries are
side-effect-free data modules rather than globals a bundler could drop, so
`sideEffects: false` is now true rather than a runtime crash — a webpack 5
one-dictionary bundle went 26.5 KB → 17.9 KB and loads. The tarball went
387 KB → 218 KB with the vendored three.js copy removed, and the licence is a
valid SPDX expression now that the LGPL-only `posit2.js` is gone.

### It is faster

| | 2.x → 3.0 |
| --- | --- |
| Dictionary match, per candidate | **197–249×** (all four rotations precomputed into uint32 lanes) |
| `ARTOOLKITPLUSBCH` construction | 3599 ms → **36 ms** (`tau` computed at build time) |
| Stream ingestion | **142×** (`TypedArray.set`) |
| `detect()` end to end | 1.07× on clean frames, **2.0–2.5×** on noisy ones |

Contour points live in flat `Int32Array` pools instead of one object per point,
and grayscale is Q16 fixed-point, bit-identical to the float form. Every
hardcoded pipeline constant is an option, which is what makes half-resolution
input viable — worth roughly another 3× on its own. See [Tuning](#tuning).

### It has more surface

The OpenCV `DICT_4X4`/`5X5`/`6X6`/`7X7` families at all four sizes (including
`DICT_5X5_50`), a Web Worker entry point, the `useArucoDetector` / `useCamera` /
`useVideoFrameLoop` hooks, and `StreamDecoder` / `MJPEGDemuxer` in place of the
old stream methods — the MJPEG path threw `TypeError` on its first call and had
never run. Behind it: 70 tests, the golden A/B harness above, browser-level
worker verification (skipped when Playwright is unavailable), and CI.

---

## In Next.js

Detection costs 8–120 ms per frame depending on resolution and how noisy the
scene is. That is too much for the main thread, so the supported path runs it in
a worker. Both hooks are client-side.

```tsx
'use client';
import { useArucoDetector, useCamera, useVideoFrameLoop } from 'aruco3/react';

export function Scanner() {
  const { videoRef, error: cameraError } = useCamera({ facingMode: 'environment' });
  const { markers, ready, error, detect } = useArucoDetector({
    dictionary: 'DICT_5X5_50',
    options: { adaptiveThresholdOffset: 12 },
  });

  useVideoFrameLoop(videoRef, detect, ready);

  if (cameraError) return <p role="alert">{cameraError.message}</p>;
  if (error) return <p role="alert">{error.message}</p>;

  return (
    <>
      <video ref={videoRef} playsInline muted />
      <ul>{markers.map((m) => <li key={m.id}>marker {m.id}</li>)}</ul>
    </>
  );
}
```

`useCamera` stops the track on unmount (so the camera indicator goes out), sets
`playsInline` and `muted` (without which iOS Safari takes the video fullscreen
and `drawImage` returns blank frames), and turns permission failures into a
readable `error` rather than a console line.

`useArucoDetector` owns the worker, transfers each frame's buffer instead of
copying it, and drops frames that arrive while the worker is busy — for a live
preview, showing the newest result beats processing every frame.

### Driving the worker yourself

```js
const worker = new Worker(
  new URL('aruco3/worker', import.meta.url),
  { type: 'module' }
);
worker.postMessage({ type: 'init', id: 1, dictionary: 'DICT_5X5_50' });
worker.postMessage({ type: 'detect', id: 2, width, height, data: buf }, [buf]);
// -> { type: 'markers', markers, stats, data }   `data` comes back for reuse
```

### Server components and route handlers

`src/` touches no DOM API, so importing it in a Server Component or Route
Handler is safe. Detection is still synchronous, though — a route handler that
calls `detect()` blocks the event loop for every concurrent request, so put it
behind a queue or a worker thread if it is on a hot path.

---

## Dictionaries

Import the one you need for a static dependency and the smallest bundle:

```js
import dict from 'aruco3/dictionaries/dict-5x5-50';
```

Or load by name to have your bundler code-split it:

```js
import { loadDictionary, DICTIONARY_NAMES } from 'aruco3/dictionaries';
const dict = await loadDictionary('DICT_5X5_50');   // cached
```

### OpenCV predefined

| Family | Sizes | Grid | Module |
| --- | --- | --- | --- |
| `DICT_4X4_*` | 50, 100, 250, 1000 | 4×4 | `dictionaries/dict-4x4-50` … |
| `DICT_5X5_*` | 50, 100, 250, 1000 | 5×5 | `dictionaries/dict-5x5-50` … |
| `DICT_6X6_*` | 50, 100, 250, 1000 | 6×6 | `dictionaries/dict-6x6-50` … |
| `DICT_7X7_*` | 50, 100, 250, 1000 | 7×7 | `dictionaries/dict-7x7-50` … |

These are byte-for-byte OpenCV's code lists, and their correction bounds match
OpenCV's declared `maxCorrectionBits` for every size — so a marker this library
accepts is one `cv2.aruco` would accept too.

### Also bundled

`ARUCO`, `ARUCO_DEFAULT`, `ARUCO_DEFAULT_OPENCV`, `ARUCO_MIP_16h3`,
`ARUCO_MIP_25h7`, `ARUCO_MIP_36h12`, `APRILTAG_16h5`, `APRILTAG_25h7`,
`APRILTAG_25h9`, `APRILTAG_36h9`, `APRILTAG_36h10`, `APRILTAG_36h11`, `ARTAG`,
`ARTOOLKITPLUS`, `ARTOOLKITPLUSBCH`, `CHILITAGS`.

Pre-3.0 names `ARUCO_4X4_1000`, `ARUCO_5X5_1000`, `ARUCO_6X6_1000` and
`ARUCO_7X7_1000` still resolve, to the matching `DICT_*` module.

### Custom dictionaries

```js
import { defineDictionary } from 'aruco3';

const mine = defineDictionary({
  name: 'MY_MARKERS',
  nBits: 25,                       // must be a perfect square
  codeList: [0x1084210, 0x1084217] // numbers, hex strings, or OpenCV byte arrays
  // tau and maxCorrectionBits are computed if omitted
});
```

Use hex strings above 53 bits — a numeric literal cannot round-trip exactly past
that point.

### Generating marker artwork

```js
const svg = dict.toSVG(7, { moduleSize: 16, quietZone: 1 });
```

---

## Tuning

Every pipeline parameter is an option. The defaults suit a well-lit 640×480
webcam frame.

| Option | Default | What it does |
| --- | --- | --- |
| `adaptiveThresholdKernel` | `2` | Box-blur radius for the local mean. Raise for noisy or unevenly-lit scenes. |
| `adaptiveThresholdOffset` | `7` | How far below the local mean counts as ink. **Raise to ~12 when feeding half-resolution frames.** |
| `minEdgeLength` | `10` | Shortest quad edge, in pixels, worth considering. |
| `polygonTolerance` | `0.05` | Douglas–Peucker tolerance, relative to contour length. |
| `cellSize` | `8` | Warp pixels per marker cell. `warpSize = markSize × cellSize`. |
| `cellMargin` | `1` | Pixels trimmed from each cell edge before sampling. |
| `borderErrorRate` | `0.35` | Fraction of border cells allowed to be non-black. |
| `maxHammingDistance` | dictionary bound | Acceptance radius, inclusive. See below. |
| `allowUniformCodes` | `false` | Permit solid grids to match a uniform code. |
| `maxPixels` | `1920×1080×4` | Rejects oversized or mis-declared frames. |

### Halving the resolution is the biggest single win

Processing a quarter of the pixels is worth more than every micro-optimisation
combined, and on these test frames it returns identical ids:

```js
// draw the video at half size — the downscale runs on the GPU
ctx.drawImage(video, 0, 0, video.videoWidth / 2, video.videoHeight / 2);
const detector = new Detector({ dictionary, adaptiveThresholdOffset: 12 });
```

Measured 1920×1080 → 960×540: **33.4 ms → 10.8 ms**, same marker ids.

### Error correction and false positives

`maxHammingDistance` defaults to `floor((tau − 1) / 2)`, where `tau` is the
dictionary's minimum inter-code Hamming distance. That is the largest radius at
which a corrupted read maps back to exactly one code.

Raising it past that default trades false positives for range, and the trade is
steep: at `tau` itself, 14 of the 20 bundled dictionaries will match *any*
random bit pattern to some id. Lower it to `0` if you only ever want exact reads.

---

## Pose estimation

```js
import { Posit } from 'aruco3';

const posit = new Posit(markerSizeMm, focalLengthPx);
const pose = posit.pose(centeredCorners);   // corners relative to the image centre
```

`pose.bestError` is the mean sub-pixel reprojection error. Threshold on it to
reject bad fits.

Two limitations worth knowing before you build on this:

- **Focal length matters a lot.** Passing `canvas.width` — as older examples did
  — assumes a 53° horizontal field of view. A 65° webcam then reports depth 27%
  too far, a 90° lens 100% too far. Calibrate, or at least derive the focal
  length from your camera's actual FOV: `f = (width / 2) / tan(hfov / 2)`.
- **Corners are not sub-pixel refined.** Recovered tilt below ~5° is
  unreliable, and small pose changes can read as a jump. There is no lens
  distortion model.

---

## API

### `new Detector({ dictionary, ...options })`
- `detect(image, { luma? })` → `Marker[]`. Pass `luma: true` for a
  single-channel plane (e.g. `VideoFrame` plane 0) to skip RGBA conversion.
- `stats` — `{ contours, candidates, decoded }` for the last frame.
- `warpSize` — derived from the dictionary.
- `dispose()` — release buffers.

### `new Dictionary(definition)`
- `find(packedBits, maxBits)` → `{ id, rotation, distance } | null`
- `bitsFor(id)` → `number[]`
- `toSVG(id, { moduleSize?, quietZone? })` → `string`
- `tau`, `maxCorrectionBits`, `gridSize`, `markSize`, `ids`, `warnings`

### `new StreamDecoder({ width, height, onFrame, copy?, channels? })`
Assembles fixed-size frames from arbitrarily-chunked input (an ffmpeg rawvideo
pipe, say). `push(chunk)`, `resync()`, `frames`, `dropped`.

### `new MJPEGDemuxer({ onImage, maxImageBytes? })`
Splits an MJPEG byte stream into JPEG images. Bounded, so a stream with no EOI
marker cannot pin memory.

### Errors
All failures throw `Error` subclasses — `UnknownDictionaryError`,
`InvalidDictionaryError`, `InvalidImageError`, `InvalidOptionError` — each
carrying structured fields.

---

## Accuracy and limitations

Measured on the synthetic battery in `test/`: `DICT_5X5_50`, 640×480, five ids
per data point, default options unless noted.

| | |
| --- | --- |
| Smallest marker | **12 px** (5/5); 10 px and below fail |
| In-plane rotation | full 360°, no loss |
| Out-of-plane tilt | 5/5 to **82°**; fails at 85° |
| Blur | 5/5 through a radius-6 box blur at 140 px; radius 3 at 48 px |
| Noise | 5/5 at ±70; 3/5 at ±90 (unchanged by a larger kernel) |
| False positives | 0 across 12 marker-free texture frames |

These are clean synthetic renders. Real camera frames add motion blur, rolling
shutter, compression artefacts and uneven lighting, so treat these as an upper
bound rather than a field spec.

Not implemented: sub-pixel corner refinement, lens distortion correction,
marker boards / ChArUco, inverted markers, and temporal tracking between frames.

---

## Migrating from 2.x

The package name is `aruco3`, and the global `AR` / `CV` / `POS` namespaces are
gone — everything is a named export.

| 2.x | 3.0 |
| --- | --- |
| `<script src="aruco.js">` / `require('js-aruco2')` | `import { ... } from 'aruco3'` |
| `new AR.Detector({ dictionaryName: 'X' })` | `new Detector({ dictionary })` |
| `AR.DICTIONARIES.X = {...}` | `defineDictionary({...})` |
| `detector.detect(imageData)` | unchanged |
| `detector.detect(w, h, data)` (documented, but threw) | `detect({ width, height, data })` |
| `detector.detectStreamInit/detectStream` | `new StreamDecoder({...})` |
| `detector.detectMJPEGStream` (threw on first call) | `new MJPEGDemuxer({...})` |
| `new AR.Dictionary('X').generateSVG(id)` | `dict.toSVG(id)` |
| `POS.Posit` from `posit1.js` / `posit2.js` | `Posit` (single implementation) |
| `marker.hammingDistance` | unchanged |
| thrown strings | `Error` subclasses |

**Detection results change**, deliberately. The 2.x acceptance bound admitted
distances up to `tau − 1`; 3.0 uses `floor((tau − 1) / 2)`. If you depended on
the old behaviour, set `maxHammingDistance` explicitly — but read
[Error correction and false positives](#error-correction-and-false-positives)
first.

`legacy/` keeps the 2.x implementation as the A/B reference the test suite
compares against. It is not published.

---

## Development

```bash
npm test                    # unit + browser tests
npm run test:golden         # A/B the current build against the 2.x baseline
npm run bench               # performance comparison
npm run build:dictionaries  # regenerate src/dictionaries from legacy/
npm run typecheck
```

`test/baseline.js capture` re-records the 2.x golden fixtures. Every performance
change is a bit-exactness claim, so run `test:golden` before and after one.

---

## Licence

MIT AND BSD-2-Clause AND BSD-3-Clause. See [`LICENSE.txt`](LICENSE.txt) and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Forked from [js-aruco2](https://github.com/damianofalcioni/js-aruco2) by Damiano
Falcioni, itself a fork of [js-aruco](https://github.com/jcmellado/js-aruco) by
Juan Mellado.
