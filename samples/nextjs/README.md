# Next.js example

Drop-in App Router components for `@danielpaul/js-aruco2`. Copy
`ScannerClient.jsx` into your project and render it from a page.

```bash
npm install @danielpaul/js-aruco2
```

## Files

- **`ScannerClient.jsx`** — a `'use client'` component wiring the camera to the
  detection worker and drawing an overlay.
- **`page.jsx`** — a Server Component that renders it.
- **`next.config.mjs`** — optional headers, only needed if you later want
  `SharedArrayBuffer`.

## Notes

**Nothing needs transpiling.** The package ships ESM with an `exports` map, so
`transpilePackages` is not required.

**The worker resolves itself.** `useArucoDetector` instantiates it as
`new Worker(new URL('../worker/detector.worker.js', import.meta.url), { type: 'module' })`,
which both webpack and Turbopack understand. Pass `workerUrl` to override.

**Dictionaries are code-split.** Passing a dictionary *name* makes the worker
`await import()` just that dictionary, so its bytes stay out of your initial
chunk. Import the data module directly instead if you prefer a static dependency:

```js
import dict from '@danielpaul/js-aruco2/dictionaries/dict-5x5-50';
useArucoDetector({ dictionary: dict });
```

**Halve the resolution.** Feeding a 960×540 frame instead of 1920×1080 is worth
about 3× and returns the same ids — but raise `adaptiveThresholdOffset` to ~12
when you do, because a downscaled frame has less local contrast.

**Server Components are fine.** The library touches no DOM API, so importing it
server-side works. Detection is synchronous though, so a Route Handler calling
`detect()` blocks the event loop for every concurrent request.

## Printing markers

```js
import { Dictionary } from '@danielpaul/js-aruco2';
import def from '@danielpaul/js-aruco2/dictionaries/dict-5x5-50';

const svg = new Dictionary(def).toSVG(7, { moduleSize: 16 });
```

Keep the white quiet zone — the detector needs it to find the marker's outer
contour. `toSVG` includes one module's worth by default.
