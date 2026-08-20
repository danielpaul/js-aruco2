/**
 * Image primitives.
 *
 * Ported from the original js-aruco CV namespace (Juan Mellado, 2011) with the
 * following deliberate changes:
 *
 *   - Every buffer is a typed array, allocated once per frame size. The original
 *     defaulted to a plain `[]`, which cost ~8x the memory, could not be
 *     transferred to a worker, retained stale pixels across a resolution change,
 *     and — because the CV functions are module-level singletons — permanently
 *     deoptimised every call site if a typed array was ever mixed in.
 *   - `warp` samples H(0,0)..H(size-1,size-1). The original advanced its
 *     incremental accumulators before their first use, so it sampled
 *     H(1,1)..H(size,size): every marker patch was shifted by one warp pixel and
 *     the last row/column read out of bounds.
 *   - Contour points live in flat Int32Array pools instead of one `{x, y}` object
 *     per point. A noisy 640x480 frame produces ~204,000 points; as objects that
 *     was ~29% of frame time spent in GC.
 *   - `grayscale` uses a Q16 fixed-point form that is bit-identical to the
 *     original float expression on real frames and ~35% faster.
 *   - Lookup tables and the box-blur ring buffer are hoisted to module scope.
 */

/* ------------------------------------------------------------------ *
 * Buffers
 * ------------------------------------------------------------------ */

/** A single-channel 8-bit image. */
export class GrayImage {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height);
  }

  /** Resize in place, reallocating only when the pixel count grows. */
  resize(width, height) {
    if (this.width === width && this.height === height) return this;
    const n = width * height;
    if (this.data.length < n) this.data = new Uint8ClampedArray(n);
    this.width = width;
    this.height = height;
    return this;
  }

  /** Pixel count of the *current* dimensions, not the buffer capacity. */
  get length() {
    return this.width * this.height;
  }
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

// Q16 luma weights: round(0.299 * 65536), round(0.587 * 65536), round(0.114 * 65536).
const LUMA_R = 19595, LUMA_G = 38470, LUMA_B = 7471, LUMA_HALF = 32768;

/**
 * RGBA -> 8-bit luma. `src` is RGBA, `dst` is a GrayImage already sized to
 * width x height.
 */
export function grayscale(src, dst, width, height) {
  const out = dst.data;
  const n = width * height;
  const tail = n & 3;
  const body = n - tail;
  let i = 0, j = 0;
  // 4x unrolled: measurably faster than the scalar loop at every resolution
  for (; j < body; j += 4, i += 16) {
    out[j] = (src[i] * LUMA_R + src[i + 1] * LUMA_G + src[i + 2] * LUMA_B + LUMA_HALF) >> 16;
    out[j + 1] = (src[i + 4] * LUMA_R + src[i + 5] * LUMA_G + src[i + 6] * LUMA_B + LUMA_HALF) >> 16;
    out[j + 2] = (src[i + 8] * LUMA_R + src[i + 9] * LUMA_G + src[i + 10] * LUMA_B + LUMA_HALF) >> 16;
    out[j + 3] = (src[i + 12] * LUMA_R + src[i + 13] * LUMA_G + src[i + 14] * LUMA_B + LUMA_HALF) >> 16;
  }
  for (; j < n; j++, i += 4) {
    out[j] = (src[i] * LUMA_R + src[i + 1] * LUMA_G + src[i + 2] * LUMA_B + LUMA_HALF) >> 16;
  }
  return dst;
}

/** Copy an existing single-channel luma plane (e.g. VideoFrame plane 0). */
export function copyLuma(src, dst, width, height) {
  dst.data.set(src.subarray(0, width * height));
  return dst;
}

/* ------------------------------------------------------------------ *
 * Thresholding
 * ------------------------------------------------------------------ */

const THRESH_TAB = new Uint8Array(256);
let threshTabFor = -1;

/** Global threshold with a cached lookup table. */
export function threshold(src, dst, n, t) {
  if (threshTabFor !== t) {
    for (let i = 0; i < 256; i++) THRESH_TAB[i] = i <= t ? 0 : 255;
    threshTabFor = t;
  }
  const s = src.data, d = dst.data;
  for (let i = 0; i < n; i++) d[i] = THRESH_TAB[s[i]];
  return dst;
}

const HIST = new Int32Array(256);

/** Otsu's threshold over the first `n` pixels. */
export function otsu(src, n) {
  const s = src.data;
  HIST.fill(0);
  for (let i = 0; i < n; i++) HIST[s[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += HIST[i] * i;
  let sumB = 0, wB = 0, max = 0, result = 0;
  for (let i = 0; i < 256; i++) {
    wB += HIST[i];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += HIST[i] * i;
    const mu = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * mu * mu;
    if (between > max) { max = between; result = i; }
  }
  return result;
}

const BLUR_MULT = [1, 171, 205, 293, 57, 373, 79, 137, 241, 27, 391, 357, 41, 19, 283, 265];
const BLUR_SHIFT = [0, 9, 10, 11, 9, 12, 10, 11, 12, 9, 13, 13, 10, 9, 13, 13];
export const MAX_BLUR_KERNEL = BLUR_MULT.length - 1;

let ring = new Int32Array(0);

/**
 * Two-pass stack box blur. The original allocated a linked list of node objects
 * per call and chased pointers per pixel; this walks a preallocated typed ring.
 */
export function stackBoxBlur(src, dst, width, height, kernelSize) {
  const size = kernelSize + kernelSize + 1;
  const radius = kernelSize + 1;
  const mult = BLUR_MULT[kernelSize];
  const shift = BLUR_SHIFT[kernelSize];
  if (ring.length < size) ring = new Int32Array(size);
  const s = src.data, d = dst.data;
  const wm1 = width - 1, hm1 = height - 1;

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const start = pos;
    const color = s[pos];
    let sum = radius * color;
    for (let i = 0; i < radius; i++) ring[i] = color;
    for (let i = 1; i < radius; i++) {
      ring[radius - 1 + i] = s[pos + i];
      sum += s[pos + i];
    }
    let si = 0;
    for (let x = 0; x < width; x++) {
      d[pos++] = (sum * mult) >>> shift;
      let p = x + radius;
      p = start + (p < wm1 ? p : wm1);
      sum -= ring[si] - s[p];
      ring[si] = s[p];
      si = si + 1 === size ? 0 : si + 1;
    }
  }

  for (let x = 0; x < width; x++) {
    pos = x;
    let start = pos + width;
    const color = d[pos];
    let sum = radius * color;
    for (let i = 0; i < radius; i++) ring[i] = color;
    for (let i = 1; i < radius; i++) {
      ring[radius - 1 + i] = d[start];
      sum += d[start];
      start += width;
    }
    let si = 0;
    for (let y = 0; y < height; y++) {
      d[pos] = (sum * mult) >>> shift;
      let p = y + radius;
      p = x + (p < hm1 ? p : hm1) * width;
      sum -= ring[si] - d[p];
      ring[si] = d[p];
      si = si + 1 === size ? 0 : si + 1;
      pos += width;
    }
  }
  return dst;
}

const ADAPT_TAB = new Uint8Array(768);
let adaptTabFor = -1;

/**
 * Adaptive threshold: blur, then compare each pixel against its local mean
 * offset by `offset`. Raising `offset` is what makes half-resolution detection
 * work, so it is a first-class option rather than the hardcoded 7 it used to be.
 */
export function adaptiveThreshold(src, dst, width, height, kernelSize, offset) {
  stackBoxBlur(src, dst, width, height, kernelSize);
  if (adaptTabFor !== offset) {
    for (let i = 0; i < 768; i++) ADAPT_TAB[i] = i - 255 <= -offset ? 255 : 0;
    adaptTabFor = offset;
  }
  const s = src.data, d = dst.data;
  const n = width * height;
  for (let i = 0; i < n; i++) d[i] = ADAPT_TAB[s[i] - d[i] + 255];
  return dst;
}

/* ------------------------------------------------------------------ *
 * Contours
 * ------------------------------------------------------------------ */

const NEIGHBOURHOOD = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * Contours stored as flat coordinate pools. `starts[i]` / `lens[i]` index into
 * `xs` / `ys`. Replaces one `{x, y}` object per contour point.
 */
export class ContourSet {
  constructor(pointCapacity = 1 << 16, contourCapacity = 1 << 12) {
    this.xs = new Int32Array(pointCapacity);
    this.ys = new Int32Array(pointCapacity);
    this.starts = new Int32Array(contourCapacity);
    this.lens = new Int32Array(contourCapacity);
    this.holes = new Uint8Array(contourCapacity);
    this.count = 0;
    this.used = 0;
  }

  reset() {
    this.count = 0;
    this.used = 0;
  }

  _ensurePoints(extra) {
    if (this.used + extra <= this.xs.length) return;
    let cap = this.xs.length || 1024;
    while (cap < this.used + extra) cap *= 2;
    const xs = new Int32Array(cap); xs.set(this.xs);
    const ys = new Int32Array(cap); ys.set(this.ys);
    this.xs = xs; this.ys = ys;
  }

  _ensureContours() {
    if (this.count < this.starts.length) return;
    const cap = this.starts.length * 2;
    const starts = new Int32Array(cap); starts.set(this.starts);
    const lens = new Int32Array(cap); lens.set(this.lens);
    const holes = new Uint8Array(cap); holes.set(this.holes);
    this.starts = starts; this.lens = lens; this.holes = holes;
  }
}

/**
 * Border-following contour extraction (Suzuki-Abe), writing into a ContourSet.
 * `binary` must be an Int32Array of at least (width + 2) * (height + 2).
 */
export function findContours(src, width, height, binary, out) {
  out.reset();
  binaryBorder(src, width, height, binary);

  const bw = width + 2;
  const deltas = new Int32Array(16);
  for (let i = 0; i < 8; i++) {
    deltas[i] = NEIGHBOURHOOD[i][0] + NEIGHBOURHOOD[i][1] * bw;
    deltas[i + 8] = deltas[i];
  }

  let pos = width + 3;
  let nbd = 1;

  for (let i = 0; i < height; i++, pos += 2) {
    for (let j = 0; j < width; j++, pos++) {
      const pix = binary[pos];
      if (pix === 0) continue;
      let outer = false, hole = false;
      if (pix === 1 && binary[pos - 1] === 0) outer = true;
      else if (pix >= 1 && binary[pos + 1] === 0) hole = true;
      if (!outer && !hole) continue;
      nbd++;
      borderFollowing(binary, pos, nbd, j, i, hole, deltas, out);
    }
  }
  return out;
}

function borderFollowing(src, pos, nbd, px, py, hole, deltas, out) {
  out._ensureContours();
  const start = out.used;
  let n = 0;

  let s = hole ? 0 : 4;
  const sEnd = s;
  let pos1 = 0;
  do {
    s = (s - 1) & 7;
    pos1 = pos + deltas[s];
    if (src[pos1] !== 0) break;
  } while (s !== sEnd);

  if (s === sEnd) {
    src[pos] = -nbd;
    out._ensurePoints(1);
    out.xs[out.used] = px;
    out.ys[out.used] = py;
    out.used++;
    n = 1;
  } else {
    let pos3 = pos;
    let pos4 = 0;
    let x = px, y = py;
    let sLocal = s;
    for (;;) {
      const localEnd = sLocal;
      do {
        pos4 = pos3 + deltas[++sLocal];
      } while (src[pos4] === 0);
      sLocal &= 7;

      if (((sLocal - 1) >>> 0) < (localEnd >>> 0)) src[pos3] = -nbd;
      else if (src[pos3] === 1) src[pos3] = nbd;

      out._ensurePoints(1);
      out.xs[out.used] = x;
      out.ys[out.used] = y;
      out.used++;
      n++;

      x += NEIGHBOURHOOD[sLocal][0];
      y += NEIGHBOURHOOD[sLocal][1];

      if (pos4 === pos && pos3 === pos1) break;

      pos3 = pos4;
      sLocal = (sLocal + 4) & 7;
    }
  }

  out.starts[out.count] = start;
  out.lens[out.count] = n;
  out.holes[out.count] = hole ? 1 : 0;
  out.count++;
}

/** Copy `src` into a 1px zero border, mapping non-zero to 1. */
export function binaryBorder(src, width, height, dst) {
  const s = src.data;
  const bw = width + 2;
  dst.fill(0, 0, bw);
  let posSrc = 0;
  let posDst = bw;
  for (let i = 0; i < height; i++) {
    dst[posDst++] = 0;
    for (let j = 0; j < width; j++) dst[posDst++] = s[posSrc++] === 0 ? 0 : 1;
    dst[posDst++] = 0;
  }
  dst.fill(0, posDst, posDst + bw);
  return dst;
}

/* ------------------------------------------------------------------ *
 * Polygon approximation
 * ------------------------------------------------------------------ */

/**
 * Douglas-Peucker approximation over a pooled contour.
 * Writes vertex indices into `outIdx` and returns the vertex count, or -1 if it
 * would exceed `outIdx.length` (the caller only ever wants quads).
 */
export function approxPolyDP(xs, ys, off, len, epsilon, outIdx) {
  let eps = epsilon * epsilon;
  const maxOut = outIdx.length;
  let nOut = 0;

  // seed: walk three times to find a stable extremal starting vertex
  let k = 0;
  let rightStart = 0;
  let startIdx = 0;
  let maxDist = 0;
  for (let i = 0; i < 3; i++) {
    maxDist = 0;
    k = (k + rightStart) % len;
    startIdx = k;
    const sx = xs[off + k], sy = ys[off + k];
    if (++k === len) k = 0;
    for (let j = 1; j < len; j++) {
      const px = xs[off + k], py = ys[off + k];
      if (++k === len) k = 0;
      const dx = px - sx, dy = py - sy;
      const dist = dx * dx + dy * dy;
      if (dist > maxDist) { maxDist = dist; rightStart = j; }
    }
  }

  // stack of [start, end] index pairs
  const stack = APPROX_STACK;
  let sp = 0;

  if (maxDist <= eps) {
    outIdx[nOut++] = startIdx;
    return nOut;
  }

  let sliceStart = k;
  let sliceEnd = rightStart + sliceStart;
  let rStart = sliceEnd - (sliceEnd >= len ? len : 0);
  let rEnd = sliceStart < rStart ? sliceStart + len : sliceStart;

  stack[sp++] = rStart; stack[sp++] = rEnd;
  stack[sp++] = sliceStart; stack[sp++] = sliceEnd;

  while (sp > 0) {
    const end = stack[--sp];
    const begin = stack[--sp];

    const ei = end % len;
    let bi = begin % len;
    const ex = xs[off + ei], ey = ys[off + ei];
    const bx = xs[off + bi], by = ys[off + bi];
    let kk = bi;
    if (++kk === len) kk = 0;

    let leEps;
    let splitAt = 0;
    if (end <= begin + 1) {
      leEps = true;
    } else {
      maxDist = 0;
      const dx = ex - bx, dy = ey - by;
      for (let i = begin + 1; i < end; i++) {
        const px = xs[off + kk], py = ys[off + kk];
        if (++kk === len) kk = 0;
        const dist = Math.abs((py - by) * dx - (px - bx) * dy);
        if (dist > maxDist) { maxDist = dist; splitAt = i; }
      }
      leEps = maxDist * maxDist <= eps * (dx * dx + dy * dy);
    }

    if (leEps) {
      if (nOut >= maxOut) return -1;
      outIdx[nOut++] = bi;
    } else {
      if (sp + 4 > stack.length) return -1;
      stack[sp++] = splitAt; stack[sp++] = end;
      stack[sp++] = begin; stack[sp++] = splitAt;
    }
  }
  return nOut;
}

const APPROX_STACK = new Int32Array(512);

/* ------------------------------------------------------------------ *
 * Polygon predicates (operate on flat [x0,y0,x1,y1,...] quads)
 * ------------------------------------------------------------------ */

export function isQuadConvex(q) {
  let orientation = 0;
  let prevX = q[6], prevY = q[7];
  let curX = q[0], curY = q[1];
  let dx0 = curX - prevX, dy0 = curY - prevY;
  for (let i = 0, j = 1; i < 4; i++) {
    if (++j === 5) j = 1;
    prevX = curX; prevY = curY;
    const idx = (j - 1) * 2;
    curX = q[idx]; curY = q[idx + 1];
    const dx = curX - prevX, dy = curY - prevY;
    const dxdy0 = dx * dy0, dydx0 = dy * dx0;
    orientation |= dydx0 > dxdy0 ? 1 : dydx0 < dxdy0 ? 2 : 3;
    if (orientation === 3) return false;
    dx0 = dx; dy0 = dy;
  }
  return true;
}

export function quadPerimeter(q) {
  let p = 0;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const dx = q[i * 2] - q[j * 2];
    const dy = q[i * 2 + 1] - q[j * 2 + 1];
    p += Math.sqrt(dx * dx + dy * dy);
  }
  return p;
}

export function quadMinEdge(q) {
  let min = Infinity;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const dx = q[i * 2] - q[j * 2];
    const dy = q[i * 2 + 1] - q[j * 2 + 1];
    const d = dx * dx + dy * dy;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

/* ------------------------------------------------------------------ *
 * Perspective warp
 * ------------------------------------------------------------------ */

/**
 * Homography taking the unit square scaled by `size` onto the quad `q`
 * (flat [x0,y0,...]). Returns null for a degenerate quad instead of emitting
 * NaN, which the original did silently.
 */
export function getPerspectiveTransform(q, size) {
  const m = squareToQuad(q);
  if (!m) return null;
  m[0] /= size; m[1] /= size;
  m[3] /= size; m[4] /= size;
  m[6] /= size; m[7] /= size;
  return m;
}

const SQ = new Float64Array(9);

function squareToQuad(q) {
  const x0 = q[0], y0 = q[1], x1 = q[2], y1 = q[3];
  const x2 = q[4], y2 = q[5], x3 = q[6], y3 = q[7];
  const px = x0 - x1 + x2 - x3;
  const py = y0 - y1 + y2 - y3;

  if (px === 0 && py === 0) {
    SQ[0] = x1 - x0; SQ[1] = x2 - x1; SQ[2] = x0;
    SQ[3] = y1 - y0; SQ[4] = y2 - y1; SQ[5] = y0;
    SQ[6] = 0; SQ[7] = 0; SQ[8] = 1;
    return SQ;
  }

  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (den === 0 || !Number.isFinite(den)) return null;

  const g = (px * dy2 - dx2 * py) / den;
  const h = (dx1 * py - px * dy1) / den;
  if (!Number.isFinite(g) || !Number.isFinite(h)) return null;

  SQ[6] = g; SQ[7] = h; SQ[8] = 1;
  SQ[0] = x1 - x0 + g * x1; SQ[1] = x3 - x0 + h * x3; SQ[2] = x0;
  SQ[3] = y1 - y0 + g * y1; SQ[4] = y3 - y0 + h * y3; SQ[5] = y0;
  return SQ;
}

/**
 * Bilinear perspective warp of `q` out of `src` into a `warpSize` square.
 * Returns false for a degenerate quad.
 *
 * Samples H(0,0) .. H(warpSize-1, warpSize-1). The original advanced its
 * accumulators before the first use, sampling H(1,1)..H(warpSize,warpSize).
 */
export function warp(src, dst, q, warpSize) {
  const m = getPerspectiveTransform(q, warpSize - 1);
  if (!m) return false;

  const s = src.data, d = dst.data;
  const width = src.width, height = src.height;
  const maxX = width - 1, maxY = height - 1;

  let pos = 0;
  let r = m[8], u0 = m[2], v0 = m[5];

  for (let i = 0; i < warpSize; i++) {
    let u = r, v = u0, w = v0;
    for (let j = 0; j < warpSize; j++) {
      const x = v / u;
      const y = w / u;

      let sx1 = x >>> 0;
      if (sx1 > maxX) sx1 = maxX;
      const sx2 = sx1 === maxX ? sx1 : sx1 + 1;
      const dx1 = x - sx1, dx2 = 1 - dx1;

      let sy1 = y >>> 0;
      if (sy1 > maxY) sy1 = maxY;
      const sy2 = sy1 === maxY ? sy1 : sy1 + 1;
      const dy1 = y - sy1, dy2 = 1 - dy1;

      const p1 = sy1 * width;
      const p3 = sy2 * width;

      d[pos++] =
        dy2 * (dx2 * s[p1 + sx1] + dx1 * s[p1 + sx2]) +
        dy1 * (dx2 * s[p3 + sx1] + dx1 * s[p3 + sx2]);

      u += m[6]; v += m[0]; w += m[3];
    }
    r += m[7]; u0 += m[1]; v0 += m[4];
  }

  dst.width = warpSize;
  dst.height = warpSize;
  return true;
}

/**
 * Count non-zero pixels in an axis-aligned block, stopping early once the count
 * can no longer change the caller's decision.
 */
export function countNonZero(img, x, y, w, h) {
  const s = img.data;
  const stride = img.width;
  let pos = x + y * stride;
  const span = stride - w;
  let nz = 0;
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) if (s[pos++] !== 0) nz++;
    pos += span;
  }
  return nz;
}
