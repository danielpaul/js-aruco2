/**
 * Marker detector.
 *
 * Pipeline: luma -> adaptive threshold -> contours -> quad candidates ->
 * perspective warp -> Otsu -> bit sampling -> dictionary lookup.
 *
 * Changes from the pre-3.0 pipeline, all of which were hardcoded before:
 *   - every tuning parameter is an option (`adaptiveThresholdOffset` in
 *     particular is what makes half-resolution detection viable);
 *   - `warpSize` is derived from the dictionary's grid rather than fixed at 49,
 *     which for a 8x8 grid put the sampling lattice on the wrong cells entirely;
 *   - candidates are deduplicated *after* decoding rather than before, so the
 *     decodable quad is no longer discarded in favour of its quiet-zone
 *     neighbour (this alone took the practical size floor from ~70px to ~24px);
 *   - a uniform (all-black / all-white) sampled grid is rejected, so a solid
 *     dark rectangle no longer decodes as a real id at distance 0;
 *   - buffers are typed and sized to the current frame.
 */

import {
  GrayImage, ContourSet,
  grayscale, copyLuma, adaptiveThreshold, threshold, otsu,
  findContours, approxPolyDP, warp,
  isQuadConvex, quadPerimeter, quadMinEdge, countNonZero,
  MAX_BLUR_KERNEL,
} from './cv.js';
import { Dictionary, packBits } from './dictionary.js';
import { InvalidImageError, InvalidOptionError } from './errors.js';

/** Defaults for every tunable. */
export const DEFAULT_OPTIONS = {
  /** Box-blur radius for the adaptive threshold. */
  adaptiveThresholdKernel: 2,
  /** How far below the local mean a pixel must sit to count as ink. */
  adaptiveThresholdOffset: 7,
  /** Shortest polygon edge, in pixels, for a candidate to be considered. */
  minEdgeLength: 10,
  /** Douglas-Peucker tolerance, relative to contour point count. */
  polygonTolerance: 0.05,
  /** Warp pixels per marker cell. warpSize = markSize * cellSize. */
  cellSize: 8,
  /** Pixels trimmed from each side of a cell before sampling its bits. */
  cellMargin: 1,
  /** Fraction of border cells allowed to be non-black (OpenCV uses 0.35). */
  borderErrorRate: 0.35,
  /** Acceptance radius override. Defaults to the dictionary's correctable bound. */
  maxHammingDistance: null,
  /** Reject solid grids that collide with a uniform code (e.g. CHILITAGS 682). */
  allowUniformCodes: false,
  /** Hard cap on contours per frame; protects against pathological texture. */
  maxContours: 100000,
  /** Largest frame accepted, as a guard against unvalidated caller dimensions. */
  maxPixels: 1920 * 1080 * 4,
};

let SCRATCH_IDX = new Int32Array(64);

/**
 * Definition objects passed straight to `new Detector` are wrapped once and
 * reused, so importing a dictionary data module and handing it to several
 * detectors does not rebuild the packed tables each time.
 * @type {WeakMap<object, Dictionary>}
 */
const definitionCache = new WeakMap();

/**
 * Accept either a built Dictionary or a plain definition object — passing the
 * imported data module directly is the obvious thing to try, so it works.
 * @param {any} value
 * @returns {Dictionary}
 */
function toDictionary(value) {
  if (value instanceof Dictionary) return value;
  if (value && typeof value === 'object' && Array.isArray(value.codeList)) {
    const cached = definitionCache.get(value);
    if (cached) return cached;
    const built = new Dictionary(value);
    definitionCache.set(value, built);
    return built;
  }
  throw new InvalidOptionError(
    'Detector requires a `dictionary`: either a Dictionary instance, or a definition ' +
    'object such as the default export of aruco3/dictionaries/<name>. ' +
    'Use loadDictionary(name) from aruco3/dictionaries to load one by name.',
    { received: value === undefined ? 'undefined' : typeof value }
  );
}

export class Detector {
  /**
   * @param {{ dictionary: Dictionary | import('./dictionary.js').DictionaryDefinition }
   *   & Partial<typeof DEFAULT_OPTIONS>} options
   */
  constructor(options) {
    options = options || /** @type {any} */ ({});
    const { dictionary, ...rest } = options;
    this.dictionary = toDictionary(dictionary);
    this.options = { ...DEFAULT_OPTIONS, ...rest };
    validateOptions(this.options);

    this.maxHammingDistance =
      this.options.maxHammingDistance != null
        ? this.options.maxHammingDistance
        : this.dictionary.maxCorrectionBits;

    this.warpSize = this.dictionary.markSize * this.options.cellSize;

    this._grey = new GrayImage();
    this._thres = new GrayImage();
    this._patch = new GrayImage(this.warpSize, this.warpSize);
    this._binary = new Int32Array(0);
    this._contours = new ContourSet();
    this._obs = new Uint32Array(this.dictionary.lanes);
    this._quads = [];
    this._disposed = false;

    /** Diagnostics from the most recent detect(), for debugging overlays. */
    this.stats = { contours: 0, candidates: 0, decoded: 0 };
  }

  /**
   * Detect markers.
   * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} image
   *        RGBA (4 bytes per pixel) unless `luma` is true.
   * @param {{luma?:boolean}} [opts] pass `luma: true` for a single-channel plane
   * @returns {Array<{id:number, corners:Array<{x:number,y:number}>, hammingDistance:number, rotation:number}>}
   */
  detect(image, opts = {}) {
    if (this._disposed) {
      throw new InvalidOptionError('Detector has been disposed.');
    }
    const { width, height, data } = validateImage(image, opts.luma === true, this.options.maxPixels);

    this._grey.resize(width, height);
    this._thres.resize(width, height);
    if (opts.luma === true) copyLuma(data, this._grey, width, height);
    else grayscale(data, this._grey, width, height);

    adaptiveThreshold(
      this._grey, this._thres, width, height,
      this.options.adaptiveThresholdKernel,
      this.options.adaptiveThresholdOffset
    );

    const need = (width + 2) * (height + 2);
    if (this._binary.length < need) this._binary = new Int32Array(need);

    findContours(this._thres, width, height, this._binary, this._contours);
    this.stats.contours = this._contours.count;

    const quads = this._findCandidates();
    this.stats.candidates = quads.length;

    const markers = this._decode(quads);
    this.stats.decoded = markers.length;
    return markers;
  }

  /** Quad candidates as flat [x0,y0,x1,y1,x2,y2,x3,y3] arrays, wound clockwise. */
  _findCandidates() {
    const { minEdgeLength, polygonTolerance, maxContours } = this.options;
    const c = this._contours;
    const quads = this._quads;
    quads.length = 0;

    // A contour enclosing a quad whose shortest edge is >= minEdgeLength must
    // have at least perimeter/sqrt(2) chain steps. Provably cannot discard a
    // candidate that would have passed the edge-length test.
    const minPoints = Math.max(4, Math.ceil((4 * minEdgeLength) / Math.SQRT2));

    if (SCRATCH_IDX.length < 8) SCRATCH_IDX = new Int32Array(64);
    const limit = Math.min(c.count, maxContours);

    for (let i = 0; i < limit; i++) {
      const len = c.lens[i];
      if (len < minPoints) continue;
      const off = c.starts[i];
      const n = approxPolyDP(c.xs, c.ys, off, len, len * polygonTolerance, SCRATCH_IDX);
      if (n !== 4) continue;

      const q = new Float64Array(8);
      for (let k = 0; k < 4; k++) {
        q[k * 2] = c.xs[off + SCRATCH_IDX[k]];
        q[k * 2 + 1] = c.ys[off + SCRATCH_IDX[k]];
      }
      if (!isQuadConvex(q)) continue;
      if (quadMinEdge(q) < minEdgeLength) continue;
      toClockwise(q);
      quads.push(q);
    }
    return quads;
  }

  /** Warp, threshold, sample and look up each candidate. */
  _decode(quads) {
    const dict = this.dictionary;
    const { cellSize, cellMargin, borderErrorRate, allowUniformCodes } = this.options;
    const markSize = dict.markSize;
    const grid = dict.gridSize;
    const patch = this._patch;
    const obs = this._obs;
    const warpSize = this.warpSize;
    const sample = cellSize - cellMargin * 2;
    const half = (sample * sample) >> 1;
    const borderCells = 4 * markSize - 4;
    const borderBudget = Math.floor(borderCells * borderErrorRate);

    const found = [];

    for (const q of quads) {
      patch.width = warpSize;
      patch.height = warpSize;
      if (!warp(this._grey, patch, q, warpSize)) continue;
      threshold(patch, patch, warpSize * warpSize, otsu(patch, warpSize * warpSize));

      // border ring must be predominantly black
      let borderErrors = 0;
      let rejected = false;
      for (let i = 0; i < markSize && !rejected; i++) {
        const step = i === 0 || i === markSize - 1 ? 1 : markSize - 1;
        for (let j = 0; j < markSize; j += step) {
          const nz = countNonZero(
            patch,
            j * cellSize + cellMargin, i * cellSize + cellMargin,
            sample, sample
          );
          if (nz > half && ++borderErrors > borderBudget) { rejected = true; break; }
        }
      }
      if (rejected) continue;

      // payload
      obs.fill(0);
      let ones = 0;
      for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
          const nz = countNonZero(
            patch,
            (j + 1) * cellSize + cellMargin, (i + 1) * cellSize + cellMargin,
            sample, sample
          );
          if (nz > half) {
            const bit = i * grid + j;
            obs[bit >> 5] |= 1 << (bit & 31);
            ones++;
          }
        }
      }

      // A solid quad samples to a uniform grid. Some dictionaries contain a
      // uniform code (CHILITAGS id 682 is 64 zero bits), so without this every
      // dark rectangle in frame decodes as that id at distance 0.
      if (!allowUniformCodes && (ones === 0 || ones === dict.nBits)) continue;

      const hit = dict.find(obs, this.maxHammingDistance);
      if (!hit) continue;

      found.push({
        id: hit.id,
        corners: rotateCorners(q, hit.rotation),
        hammingDistance: hit.distance,
        rotation: hit.rotation,
        _perimeter: quadPerimeter(q),
      });
    }

    return dedupeById(found);
  }

  /** Release the frame buffers. The detector cannot be used afterwards. */
  dispose() {
    this._disposed = true;
    this._grey = null;
    this._thres = null;
    this._patch = null;
    this._binary = null;
    this._contours = null;
    this._quads = null;
  }
}

/* ------------------------------------------------------------------ */

function toClockwise(q) {
  const dx1 = q[2] - q[0], dy1 = q[3] - q[1];
  const dx2 = q[4] - q[0], dy2 = q[5] - q[1];
  if (dx1 * dy2 - dy1 * dx2 < 0) {
    const x = q[2], y = q[3];
    q[2] = q[6]; q[3] = q[7];
    q[6] = x; q[7] = y;
  }
}

function rotateCorners(q, rotation) {
  const out = new Array(4);
  for (let i = 0; i < 4; i++) {
    const k = (rotation + i) % 4;
    out[i] = { x: q[k * 2], y: q[k * 2 + 1] };
  }
  return out;
}

/**
 * Two contours of the same physical marker (the outer edge of the black border
 * and its inner edge) both decode to the same id. Keep the better read.
 */
function dedupeById(found) {
  if (found.length < 2) return found.map(strip);
  const out = [];
  for (const m of found) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (o.id !== m.id) continue;
      if (!overlaps(o, m)) continue;
      // prefer the cleaner decode, then the larger quad (the outer border edge)
      if (m.hammingDistance < o.hammingDistance ||
        (m.hammingDistance === o.hammingDistance && m._perimeter > o._perimeter)) {
        out[i] = m;
      }
      merged = true;
      break;
    }
    if (!merged) out.push(m);
  }
  return out.map(strip);
}

function strip(m) {
  return { id: m.id, corners: m.corners, hammingDistance: m.hammingDistance, rotation: m.rotation };
}

function overlaps(a, b) {
  const ca = centroid(a.corners), cb = centroid(b.corners);
  const dx = ca.x - cb.x, dy = ca.y - cb.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const scale = Math.min(a._perimeter, b._perimeter) / 4;
  return dist < scale * 0.7;
}

function centroid(c) {
  let x = 0, y = 0;
  for (const p of c) { x += p.x; y += p.y; }
  return { x: x / c.length, y: y / c.length };
}

/* ------------------------------------------------------------------ */

function validateOptions(o) {
  const k = o.adaptiveThresholdKernel;
  if (!Number.isInteger(k) || k < 0 || k > MAX_BLUR_KERNEL) {
    throw new InvalidOptionError(
      `adaptiveThresholdKernel must be an integer in 0..${MAX_BLUR_KERNEL}, got ${k}.`,
      { option: 'adaptiveThresholdKernel', value: k }
    );
  }
  if (!Number.isInteger(o.cellSize) || o.cellSize < 2) {
    throw new InvalidOptionError(`cellSize must be an integer >= 2, got ${o.cellSize}.`,
      { option: 'cellSize', value: o.cellSize });
  }
  if (!Number.isInteger(o.cellMargin) || o.cellMargin < 0 || o.cellMargin * 2 >= o.cellSize) {
    throw new InvalidOptionError(
      `cellMargin must be an integer in 0..${Math.floor((o.cellSize - 1) / 2)} for cellSize ${o.cellSize}, got ${o.cellMargin}.`,
      { option: 'cellMargin', value: o.cellMargin });
  }
  if (!(o.borderErrorRate >= 0 && o.borderErrorRate < 1)) {
    throw new InvalidOptionError(`borderErrorRate must be in [0, 1), got ${o.borderErrorRate}.`,
      { option: 'borderErrorRate', value: o.borderErrorRate });
  }
  if (!(o.minEdgeLength > 0)) {
    throw new InvalidOptionError(`minEdgeLength must be > 0, got ${o.minEdgeLength}.`,
      { option: 'minEdgeLength', value: o.minEdgeLength });
  }
  if (o.maxHammingDistance != null &&
    (!Number.isInteger(o.maxHammingDistance) || o.maxHammingDistance < 0)) {
    throw new InvalidOptionError(
      `maxHammingDistance must be a non-negative integer, got ${o.maxHammingDistance}.`,
      { option: 'maxHammingDistance', value: o.maxHammingDistance });
  }
}

/**
 * Reject malformed frames before allocating anything. The previous version
 * trusted caller-declared dimensions: a 16-byte buffer claiming to be 8000x8000
 * allocated ~2 GB and blocked for ten seconds.
 */
export function validateImage(image, luma, maxPixels) {
  if (!image || typeof image !== 'object') {
    throw new InvalidImageError('detect() expects an object with { width, height, data }.',
      { received: typeof image });
  }
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new InvalidImageError(
      `Image dimensions must be positive integers, got ${width}x${height}.`,
      { width, height });
  }
  const pixels = width * height;
  if (pixels > maxPixels) {
    throw new InvalidImageError(
      `Image is ${width}x${height} (${pixels} px), above the maxPixels limit of ${maxPixels}. ` +
      `Raise the limit deliberately if you really mean to process frames this large.`,
      { width, height, pixels, maxPixels });
  }
  if (!data || typeof data.length !== 'number') {
    throw new InvalidImageError('image.data must be a typed array or array-like.',
      { received: data === undefined ? 'undefined' : typeof data });
  }
  const expected = luma ? pixels : pixels * 4;
  if (data.length < expected) {
    throw new InvalidImageError(
      `image.data has ${data.length} bytes but ${width}x${height} ${luma ? 'luma' : 'RGBA'} needs ${expected}.`,
      { width, height, actual: data.length, expected });
  }
  return { width, height, data };
}
