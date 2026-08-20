/**
 * Deterministic synthetic marker renderer for the test harness.
 *
 * Renders a marker under a real perspective transform with supersampled
 * anti-aliasing, optional blur and deterministic noise, so detection can be
 * swept over size / tilt / roll / blur / noise without a camera.
 *
 * No dependency on the library under test: it takes a bit grid, not a Dictionary.
 */

/** Deterministic PRNG (mulberry32) so every run produces identical frames. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the full marker texture: quiet zone + black border ring + payload bits.
 * `bits` is a row-major array of 0/1 with length gridSize^2, where 1 === white.
 * Returns { size, get(x, y) -> 0|255 } in texture cell coordinates.
 */
export function markerTexture(bits, gridSize, quiet = 1) {
  const ring = gridSize + 2;          // payload + black border
  const size = ring + quiet * 2;      // + white quiet zone
  const cells = new Uint8Array(size * size);
  cells.fill(255);                    // quiet zone is white
  for (let y = 0; y < ring; y++) {
    for (let x = 0; x < ring; x++) {
      const onBorder = y === 0 || x === 0 || y === ring - 1 || x === ring - 1;
      let v;
      if (onBorder) v = 0;
      else v = bits[(y - 1) * gridSize + (x - 1)] ? 255 : 0;
      cells[(y + quiet) * size + (x + quiet)] = v;
    }
  }
  return { size, cells };
}

/** 3x3 matrix multiply. */
function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

/** Invert a 3x3 matrix. */
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    A * id, -(b * i - c * h) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
    C * id, -(a * h - b * g) * id, (a * e - b * d) * id,
  ];
}

/**
 * Homography mapping the unit square [0,1]^2 onto four image-space corners
 * (tl, tr, br, bl). Standard DLT for the square-to-quad case.
 */
function squareToQuad(q) {
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g, h;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

/**
 * Project the marker's four corners for a given pose.
 * tilt/roll/yaw in degrees, distance in "focal lengths" via sidePx.
 */
export function poseCorners({ sidePx, cx, cy, tiltDeg = 0, rollDeg = 0, yawDeg = 0, focal = 800 }) {
  const half = 0.5;
  const t = (tiltDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  const w = (yawDeg * Math.PI) / 180;
  // rotation: roll about Z, then tilt about X, then yaw about Y
  const cz = Math.cos(r), sz = Math.sin(r);
  const cx1 = Math.cos(t), sx1 = Math.sin(t);
  const cy1 = Math.cos(w), sy1 = Math.sin(w);
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cx1, -sx1, 0, sx1, cx1];
  const Ry = [cy1, 0, sy1, 0, 1, 0, -sy1, 0, cy1];
  const R = mul3(Ry, mul3(Rx, Rz));
  // choose Z so the fronto-parallel projected side is exactly sidePx
  const Z = (focal * 1.0) / (sidePx / 1.0);
  const src = [[-half, -half, 0], [half, -half, 0], [half, half, 0], [-half, half, 0]];
  return src.map(([X, Y, Zc]) => {
    const xr = R[0] * X + R[1] * Y + R[2] * Zc;
    const yr = R[3] * X + R[4] * Y + R[5] * Zc;
    const zr = R[6] * X + R[7] * Y + R[8] * Zc + Z;
    return [cx + (focal * xr) / zr, cy + (focal * yr) / zr];
  });
}

/**
 * Render one marker into an RGBA frame.
 *
 * opts: { bits, gridSize, width, height, sidePx, cx, cy, tiltDeg, rollDeg,
 *         yawDeg, quiet, supersample, blur, noise, seed, background }
 */
export function renderFrame(opts) {
  const {
    bits, gridSize,
    width = 640, height = 480,
    sidePx = 120,
    cx = width / 2, cy = height / 2,
    tiltDeg = 0, rollDeg = 0, yawDeg = 0,
    quiet = 1, supersample = 4,
    blur = 0, noise = 0, seed = 1,
    background = 210,
    markers = null,
  } = opts;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = background;
    data[i + 3] = 255;
  }

  // one or many markers
  const list = markers || [{ bits, gridSize, sidePx, cx, cy, tiltDeg, rollDeg, yawDeg }];
  for (const m of list) {
    const tex = markerTexture(m.bits, m.gridSize, quiet);
    // the projected quad covers the FULL texture (quiet zone included)
    const scale = (tex.size / (m.gridSize + 2));
    const corners = poseCorners({
      sidePx: (m.sidePx ?? sidePx) * scale,
      cx: m.cx ?? cx, cy: m.cy ?? cy,
      tiltDeg: m.tiltDeg ?? tiltDeg,
      rollDeg: m.rollDeg ?? rollDeg,
      yawDeg: m.yawDeg ?? yawDeg,
    });
    drawQuad(data, width, height, tex, corners, supersample);
  }

  if (blur > 0) boxBlur(data, width, height, blur);
  if (noise > 0) addNoise(data, noise, seed);
  return { width, height, data };
}

function drawQuad(data, width, height, tex, corners, ss) {
  const H = squareToQuad(corners);
  const Hi = inv3(H);
  if (!Hi) return;
  // bounding box of the quad
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const step = 1 / ss, base = step / 2;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let acc = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const X = px + base + sx * step;
          const Y = py + base + sy * step;
          const w = Hi[6] * X + Hi[7] * Y + Hi[8];
          if (w === 0) continue;
          const u = (Hi[0] * X + Hi[1] * Y + Hi[2]) / w;
          const v = (Hi[3] * X + Hi[4] * Y + Hi[5]) / w;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const tx = Math.min(tex.size - 1, (u * tex.size) | 0);
          const ty = Math.min(tex.size - 1, (v * tex.size) | 0);
          acc += tex.cells[ty * tex.size + tx];
          hits++;
        }
      }
      if (!hits) continue;
      const total = ss * ss;
      const cover = hits / total;
      const val = acc / hits;
      const p = (py * width + px) * 4;
      // composite over the background by coverage
      for (let c = 0; c < 3; c++) data[p + c] = data[p + c] * (1 - cover) + val * cover;
    }
  }
}

function boxBlur(data, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const src = new Uint8ClampedArray(data);
  const n = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          sum += src[(yy * width + xx) * 4];
        }
      }
      const p = (y * width + x) * 4;
      const v = sum / n;
      data[p] = data[p + 1] = data[p + 2] = v;
    }
  }
}

function addNoise(data, amount, seed) {
  const rand = rng(seed);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * amount;
    data[i] += n; data[i + 1] += n; data[i + 2] += n;
  }
}

/** A marker-free frame of random light/dark blocks — the false-positive probe. */
export function textureFrame({ width = 640, height = 480, block = 16, seed = 7 }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const v = rand() < 0.5 ? 20 : 235;
      for (let y = by; y < Math.min(height, by + block); y++) {
        let p = (y * width + bx) * 4;
        for (let x = bx; x < Math.min(width, bx + block); x++) {
          data[p] = data[p + 1] = data[p + 2] = v;
          data[p + 3] = 255;
          p += 4;
        }
      }
    }
  }
  return { width, height, data };
}

/** A plain dark rectangle on white — probes the all-zero-code failure. */
export function blackSquareFrame({ width = 640, height = 480, side = 120 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 245;
    data[i + 3] = 255;
  }
  const x0 = ((width - side) / 2) | 0, y0 = ((height - side) / 2) | 0;
  for (let y = y0; y < y0 + side; y++) {
    let p = (y * width + x0) * 4;
    for (let x = 0; x < side; x++) {
      data[p] = data[p + 1] = data[p + 2] = 10;
      p += 4;
    }
  }
  return { width, height, data };
}
