# Third-party notices

This package aggregates code and marker data from several upstream projects.
The SPDX expression for the whole is:

```
MIT AND BSD-2-Clause AND BSD-3-Clause
```

Full licence texts are in `LICENSE.txt`.

> **Note on LGPL.** The 2.x line (`js-aruco2`) shipped `src/posit2.js`, a port
> of AForge.NET's `CoplanarPosit`, and carried the full LGPLv3 text in
> `LICENSE.txt` on its account. That file is not part of this rewrite, and the
> single remaining POSIT implementation (`src/posit.js`) descends from
> js-aruco's MIT-licensed `posit1.js`. There is no LGPL-licensed code in this
> package.

---

## Source code

### js-aruco — MIT
Copyright (c) 2011–2012 Juan Mellado.
`src/cv.js`, `src/svd.js` and `src/posit.js` are ports of the original js-aruco
implementation, with the fixes described in each file header.

### js-aruco2 — MIT
Copyright (c) 2020 Damiano Falcioni.
The multi-dictionary support this package builds on.

### Stack Blur — MIT
Copyright (c) 2010 Mario Klingemann.
The stack box blur in `src/cv.js` (`stackBoxBlur`) derives from the Stack Blur
algorithm.

### ArUco — BSD-2-Clause
Rafael Muñoz Salinas, University of Córdoba.
The detection pipeline follows the ArUco library's approach.

---

## Marker dictionaries

Dictionary code lists are data, reproduced from their upstream projects. Each
generated module in `src/dictionaries/` records its provenance.

### OpenCV — BSD-3-Clause
Copyright (c) 2000–2020, Intel Corporation, Willow Garage Inc., Itseez Inc.,
OpenCV Foundation, and contributors.

Covers the predefined dictionaries generated from OpenCV's
`predefined_dictionaries.hpp`:

- `DICT_4X4_50`, `DICT_4X4_100`, `DICT_4X4_250`, `DICT_4X4_1000`
- `DICT_5X5_50`, `DICT_5X5_100`, `DICT_5X5_250`, `DICT_5X5_1000`
- `DICT_6X6_50`, `DICT_6X6_100`, `DICT_6X6_250`, `DICT_6X6_1000`
- `DICT_7X7_50`, `DICT_7X7_100`, `DICT_7X7_250`, `DICT_7X7_1000`
- `ARUCO_DEFAULT_OPENCV`

### AprilTag — BSD-2-Clause
Copyright (c) 2013, The Regents of The University of Michigan.

Covers `APRILTAG_16h5`, `APRILTAG_25h7`, `APRILTAG_25h9`, `APRILTAG_36h9`,
`APRILTAG_36h10` and `APRILTAG_36h11`.

> The AprilTag authors note that the tag families are also available under
> alternative licensing terms; contact the University of Michigan Office of
> Technology Transfer if the BSD terms are unsuitable.

### ArUco / Rafael Muñoz Salinas — BSD-2-Clause
Copyright 2017 Rafael Muñoz Salinas. All rights reserved.

Covers `ARUCO`, `ARUCO_DEFAULT`, `ARUCO_MIP_16h3`, `ARUCO_MIP_25h7`,
`ARUCO_MIP_36h12`, `ARTAG`, `ARTOOLKITPLUS`, `ARTOOLKITPLUSBCH` and
`CHILITAGS`.

---

## Known defects in upstream dictionary data

These are properties of the published code lists, not of this implementation.
They are reported as `dictionary.warnings` at runtime and printed by
`npm run build:dictionaries`.

| Dictionary | Issue |
| --- | --- |
| `ARTAG` | Ids 57 and 1023 are bit-identical. Id 1023 is dropped; before 3.0.0 the collision made the computed `tau` 0, which silently disabled error correction for the whole dictionary. |
| `CHILITAGS` | Id 682 is 64 zero bits, so a solid dark quadrilateral matches it exactly. The detector rejects uniform grids unless `allowUniformCodes: true`. |
| `CHILITAGS` | The pre-3.0 data declared `tau: 5`; the measured minimum inter-code distance is 8. |
| `DICT_4X4_1000` | `tau` is 2, so `floor((tau-1)/2)` is 0: this dictionary cannot correct any bit error. OpenCV declares the same. |

---

## Development-only dependencies

`samples/debug-posit/` previously vendored a copy of three.js r70 (MIT,
copyright 2010–2015 three.js authors). It is now loaded from a CDN and is not
part of the published package.
