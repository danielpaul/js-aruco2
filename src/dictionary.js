/**
 * Marker dictionary.
 *
 * Codes are packed into 32-bit lanes and all four rotations are precomputed at
 * construction, so decoding a candidate is one popcount scan instead of four
 * passes of per-character string comparison. Measured 48-143x faster depending
 * on dictionary size; the large dictionaries (APRILTAG_36h9, ARTOOLKITPLUSBCH)
 * were effectively unusable before.
 *
 * The acceptance bound is the important correctness change. `tau` is the
 * dictionary's *minimum inter-code Hamming distance* — a property of the code
 * set, not an error budget. A code set with minimum distance `tau` can only
 * unambiguously correct `floor((tau - 1) / 2)` bit errors. The previous
 * implementation accepted anything strictly closer than `tau` itself, which for
 * 14 of the 20 bundled dictionaries meant *every* random bit pattern matched
 * some id. This defaults to the correctable radius and compares inclusively.
 */

import { InvalidDictionaryError } from './errors.js';

/**
 * A dictionary definition, as shipped in `aruco3/dictionaries/*` or supplied
 * for a custom marker set.
 *
 * @typedef {object} DictionaryDefinition
 * @property {string} [name]              human-readable name, used in errors
 * @property {number} nBits               payload bits; must be a perfect square
 * @property {Array<number|string|number[]>} codeList
 *   one entry per marker id: a number, a hex string, or an OpenCV-style byte
 *   array. Hex strings are lossless above 53 bits; prefer them for wide sets.
 * @property {number} [tau]
 *   minimum inter-code Hamming distance. Computed if absent, which is O(n^2) —
 *   the bundled definitions all bake it in at build time.
 * @property {number} [maxCorrectionBits]
 *   correctable radius. Defaults to `floor((tau - 1) / 2)`, which matches
 *   OpenCV's declared value for every predefined dictionary.
 */

/**
 * @typedef {object} MarkerMatch
 * @property {number} id
 * @property {number} rotation  quarter turns between the observed grid and the code
 * @property {number} distance  Hamming distance, 0 for an exact match
 */

/** Hamming weight of a 32-bit word. */
function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** Rotate a row-major n x n bit array 90 degrees, matching the legacy convention. */
function rotate90(bits, n) {
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      out[i * n + j] = bits[(n - 1 - j) * n + i];
  return out;
}

/** Normalise one code-list entry into a bit array of length nBits. */
function toBits(entry, nBits, index, dictName) {
  const bits = new Uint8Array(nBits);
  if (typeof entry === 'number' || typeof entry === 'bigint') {
    if (typeof entry === 'number' && (!Number.isInteger(entry) || entry < 0)) {
      throw new InvalidDictionaryError(
        `Code ${index} in dictionary "${dictName}" is not a non-negative integer.`,
        { dictionaryName: dictName, index, entry }
      );
    }
    // Above 2^53 a numeric literal may already have lost precision at parse
    // time; BigInt reads whatever the double actually holds, exactly. Prefer a
    // hex string in the source data for dictionaries wider than 53 bits.
    let v = BigInt(entry);
    if (v < 0n) {
      throw new InvalidDictionaryError(
        `Code ${index} in dictionary "${dictName}" is negative.`,
        { dictionaryName: dictName, index });
    }
    for (let i = nBits - 1; i >= 0; i--) { bits[i] = Number(v & 1n); v >>= 1n; }
    if (v !== 0n) {
      throw new InvalidDictionaryError(
        `Code ${index} in dictionary "${dictName}" needs more than ${nBits} bits.`,
        { dictionaryName: dictName, index }
      );
    }
    return bits;
  }
  if (typeof entry === 'string') {
    const hex = entry.trim().replace(/^0x/i, '').replace(/UL$/i, '');
    if (!/^[0-9a-f]+$/i.test(hex)) {
      throw new InvalidDictionaryError(
        `Code ${index} in dictionary "${dictName}" is not valid hexadecimal: ${JSON.stringify(entry)}.`,
        { dictionaryName: dictName, index, entry });
    }
    return toBits(BigInt('0x' + hex), nBits, index, dictName);
  }
  if (Array.isArray(entry) || ArrayBuffer.isView(entry)) {
    // OpenCV bytesList layout: bits packed MSB-first, the final partial byte
    // right-aligned (this matches Dictionary::getBitsFromByteList).
    const bytes = /** @type {number[]} */ (
      Array.isArray(entry) ? entry : Array.from(/** @type {Uint8Array} */ (entry))
    );
    let b = 0;
    for (const byte of bytes) {
      const remaining = nBits - b;
      if (remaining <= 0) break;
      const take = remaining > 8 ? 8 : remaining;
      for (let k = take - 1; k >= 0; k--) bits[b++] = (byte >> k) & 1;
    }
    if (b !== nBits) {
      throw new InvalidDictionaryError(
        `Code ${index} in dictionary "${dictName}" decoded to ${b} bits, expected ${nBits}.`,
        { dictionaryName: dictName, index, decoded: b, expected: nBits }
      );
    }
    return bits;
  }
  throw new InvalidDictionaryError(
    `Code ${index} in dictionary "${dictName}" has unsupported type ${typeof entry}.`,
    { dictionaryName: dictName, index }
  );
}

export class Dictionary {
  /** @param {DictionaryDefinition} def */
  constructor(def) {
    const name = def.name || '(anonymous)';
    this.name = name;
    this.warnings = [];

    const nBits = def.nBits;
    const grid = Math.sqrt(nBits);
    if (!Number.isInteger(grid)) {
      throw new InvalidDictionaryError(
        `Dictionary "${name}" has nBits ${nBits}, which is not a perfect square. ` +
        `Square markers need an n x n payload grid.`,
        { dictionaryName: name, nBits }
      );
    }
    if (nBits > 1024) {
      throw new InvalidDictionaryError(
        `Dictionary "${name}" has nBits ${nBits}; the maximum supported is 1024.`,
        { dictionaryName: name, nBits }
      );
    }

    this.nBits = nBits;
    /** Payload grid side, e.g. 5 for a 5x5 dictionary. */
    this.gridSize = grid;
    /** Grid side including the black border ring. */
    this.markSize = grid + 2;

    const lanes = (this.lanes = Math.ceil(nBits / 32));
    const source = def.codeList;
    if (!source || !source.length) {
      throw new InvalidDictionaryError(`Dictionary "${name}" has an empty codeList.`, { dictionaryName: name });
    }

    // Decode, dedupe, pack all four rotations.
    const packed = new Uint32Array(source.length * 4 * lanes);
    const bitRows = new Array(source.length);
    const exact = new Map();
    const ids = [];
    let count = 0;
    let uniform = 0;

    for (let i = 0; i < source.length; i++) {
      const bits = toBits(source[i], nBits, i, name);
      const key = laneKey(packBits(bits, lanes), lanes);
      const seen = exact.get(key);
      if (seen !== undefined) {
        // `exact` already holds all four rotations of every earlier code, so a hit
        // at any rotation means find() would return that earlier id instead of this
        // one. Rotational duplicates are exactly as unreachable as byte-identical
        // ones, so both are dropped.
        this.warnings.push(
          seen.rotation === 0
            ? `code ${i} duplicates code ${seen.id}; id ${i} is unreachable and has been dropped`
            : `code ${i} is rotation ${seen.rotation} of code ${seen.id}; ` +
              `id ${i} is unreachable and has been dropped`
        );
        continue;
      }
      let sum = 0;
      for (let k = 0; k < nBits; k++) sum += bits[k];
      if (sum === 0 || sum === nBits) {
        uniform++;
        this.warnings.push(
          `code ${i} is a uniform ${sum === 0 ? 'all-black' : 'all-white'} grid; ` +
          `any solid quadrilateral decodes as this id at distance 0`
        );
      }

      const slot = count;
      let rot = bits;
      for (let r = 0; r < 4; r++) {
        const lane = packBits(rot, lanes);
        const base = (slot * 4 + r) * lanes;
        for (let l = 0; l < lanes; l++) packed[base + l] = lane[l];
        const k = laneKey(lane, lanes);
        if (!exact.has(k)) exact.set(k, { id: i, slot, rotation: r });
        rot = rotate90(rot, grid);
      }
      bitRows[slot] = bits;
      ids.push(i);
      count++;
    }

    this.packed = packed.subarray(0, count * 4 * lanes);
    this.size = count;
    this.ids = ids;
    this._bits = bitRows;
    this._exact = exact;
    this.uniformCodeCount = uniform;

    this.tau = def.tau != null ? def.tau : this._computeTau();
    if (!Number.isFinite(this.tau) || this.tau < 1) {
      this.warnings.push(
        `computed tau is ${this.tau}; error correction is disabled for this dictionary`
      );
      this.tau = Math.max(1, this.tau || 1);
    }

    /**
     * Bit errors the dictionary can correct without ambiguity. Matches OpenCV's
     * per-dictionary maxCorrectionBits for every bundled set we cross-checked.
     *
     * A declared value is honoured only when it is within the bound the EFFECTIVE
     * tau supports — the tau after unreachable codes were dropped. A definition
     * generated before dedup can carry a radius that no longer describes the
     * dictionary being built (ARTAG shipped -1, from a pre-dedup tau of 0), and
     * silently keeping it would disable correction the code set actually supports.
     */
    const safeRadius = Math.max(0, Math.floor((this.tau - 1) / 2));
    const declared = def.maxCorrectionBits;
    if (declared == null) {
      this.maxCorrectionBits = safeRadius;
    } else if (!Number.isInteger(declared) || declared < 0) {
      this.warnings.push(
        `declared maxCorrectionBits ${declared} is not a non-negative integer; ` +
        `using ${safeRadius} from the computed tau of ${this.tau}`
      );
      this.maxCorrectionBits = safeRadius;
    } else if (declared > safeRadius) {
      this.warnings.push(
        `declared maxCorrectionBits ${declared} exceeds the ${safeRadius} that a tau ` +
        `of ${this.tau} supports; clamped to ${safeRadius}`
      );
      this.maxCorrectionBits = safeRadius;
    } else {
      this.maxCorrectionBits = declared;
    }
  }

  /** Payload bits for an id, row-major, 1 === white. Used by tests and SVG output. */
  bitsFor(id) {
    const slot = this.ids.indexOf(id);
    if (slot < 0) return null;
    return Array.from(this._bits[slot]);
  }

  /** Number of ids actually reachable (duplicates removed). */
  get length() {
    return this.size;
  }

  /**
   * Match a packed observed grid.
   * @param {Uint32Array} obs  lanes of the observed grid
   * @param {number} maxBits   acceptance radius, inclusive
   * @returns {{id:number, rotation:number, distance:number}|null}
   */
  find(obs, maxBits) {
    const key = laneKey(obs, this.lanes);
    const hit = this._exact.get(key);
    if (hit !== undefined) return { id: hit.id, rotation: hit.rotation, distance: 0 };
    if (maxBits <= 0) return null;

    const lanes = this.lanes;
    const packed = this.packed;
    const total = this.size * 4;
    let bestId = -1, bestRot = 0, bestDist = maxBits + 1;

    for (let k = 0; k < total; k++) {
      const base = k * lanes;
      let d = 0;
      for (let l = 0; l < lanes; l++) {
        d += popcount((packed[base + l] ^ obs[l]) >>> 0);
        if (d >= bestDist) break;
      }
      if (d < bestDist) {
        bestDist = d;
        bestId = this.ids[k >> 2];
        bestRot = k & 3;
        if (d === 1) break;
      }
    }
    return bestId < 0 ? null : { id: bestId, rotation: bestRot, distance: bestDist };
  }

  /**
   * Minimum inter-code Hamming distance, over packed lanes.
   *
   * `find()` matches an observation against all four rotations of every code, so
   * two codes are confusable when ANY rotation of one is close to ANY rotation of
   * the other. Rotating both by the same amount preserves distance, so comparing
   * rotation 0 of `i` against all four rotations of `j` covers every relative
   * rotation. Comparing only the canonical orientations — as this did before —
   * reports an inflated tau, and therefore an unsafe correction radius, for any
   * dictionary whose codes come closer under rotation.
   */
  _computeTau() {
    const lanes = this.lanes;
    const packed = this.packed;
    let tau = Infinity;
    for (let i = 0; i < this.size; i++) {
      const a = i * 4 * lanes;
      for (let j = i + 1; j < this.size; j++) {
        for (let r = 0; r < 4; r++) {
          const b = (j * 4 + r) * lanes;
          let d = 0;
          for (let l = 0; l < lanes; l++) d += popcount((packed[a + l] ^ packed[b + l]) >>> 0);
          if (d < tau) { tau = d; if (tau === 0) return 0; }
        }
      }
    }
    return tau === Infinity ? 0 : tau;
  }

  /**
   * Marker artwork as an SVG string: white quiet zone, black border ring, then
   * the payload grid.
   */
  toSVG(id, { quietZone = 1, moduleSize = 1 } = {}) {
    const bits = this.bitsFor(id);
    if (!bits) {
      throw new InvalidDictionaryError(
        `id ${id} is not valid for dictionary "${this.name}" (valid ids: ${this.ids[0]}..${this.ids[this.ids.length - 1]}).`,
        { dictionaryName: this.name, id }
      );
    }
    const n = this.gridSize;
    const ring = n + 2;
    const total = (ring + quietZone * 2) * moduleSize;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
      `<rect x="0" y="0" width="${total}" height="${total}" fill="#fff"/>`,
      `<rect x="${quietZone * moduleSize}" y="${quietZone * moduleSize}" width="${ring * moduleSize}" height="${ring * moduleSize}" fill="#000"/>`,
    ];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!bits[y * n + x]) continue;
        parts.push(
          `<rect x="${(x + 1 + quietZone) * moduleSize}" y="${(y + 1 + quietZone) * moduleSize}" ` +
          `width="${moduleSize}" height="${moduleSize}" fill="#fff"/>`
        );
      }
    }
    parts.push('</svg>');
    return parts.join('');
  }
}

/** Pack a bit array into 32-bit lanes, bit i -> lane i>>5, position i&31. */
export function packBits(bits, lanes) {
  const out = new Uint32Array(lanes);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 5] |= 1 << (i & 31);
  }
  return out;
}

function laneKey(lane, lanes) {
  if (lanes === 1) return String(lane[0]);
  if (lanes === 2) return lane[0] + ':' + lane[1];
  let s = '';
  for (let i = 0; i < lanes; i++) s += lane[i] + ':';
  return s;
}
