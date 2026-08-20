/**
 * Streaming frame assembly.
 *
 * Replaces the pre-3.0 `detectStreamInit` / `detectStream` / `detectMJPEGStream`
 * methods, which had three defects:
 *
 *   - the raw path copied one byte at a time through a modulo and two property
 *     lookups (~1.44 ms per quarter-frame vs 0.007 ms for `TypedArray.set`);
 *   - the callback received a live alias of the rolling buffer, which was then
 *     overwritten in place, so any consumer that kept the frame got corrupted
 *     pixels;
 *   - `detectMJPEGStream` threw `TypeError` on its first call — its
 *     `findIndex` callbacks referenced `this.mjpeg` with no `thisArg` — and the
 *     `chunks.flat()` behind it would not have concatenated typed arrays anyway.
 */

import { InvalidOptionError } from './errors.js';

const SOI_0 = 0xff, SOI_1 = 0xd8;
const EOI_0 = 0xff, EOI_1 = 0xd9;

/**
 * Assembles fixed-size RGBA frames from arbitrarily-chunked byte input.
 *
 * The frame handed to `onFrame` is double-buffered: it stays valid until the
 * *next* frame completes. Pass `copy: true` if you need to retain it beyond that.
 */
export class StreamDecoder {
  /**
   * @param {object} opts
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {(frame: {width:number,height:number,data:Uint8ClampedArray}) => void} opts.onFrame
   * @param {boolean} [opts.copy=false]  hand the callback an owned copy
   * @param {number}  [opts.channels=4]  4 for RGBA, 1 for a luma plane
   */
  constructor({ width, height, onFrame, copy = false, channels = 4 }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new InvalidOptionError(
        `StreamDecoder needs positive integer width/height, got ${width}x${height}.`,
        { width, height }
      );
    }
    if (typeof onFrame !== 'function') {
      throw new InvalidOptionError('StreamDecoder needs an onFrame callback.');
    }
    if (channels !== 1 && channels !== 4) {
      throw new InvalidOptionError(`channels must be 1 or 4, got ${channels}.`, { channels });
    }
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.frameSize = width * height * channels;
    this.onFrame = onFrame;
    this.copy = copy;

    this._buffers = [
      new Uint8ClampedArray(this.frameSize),
      new Uint8ClampedArray(this.frameSize),
    ];
    this._active = 0;
    this._filled = 0;
    /** Frames completed since construction. */
    this.frames = 0;
    /** Bytes dropped by resync(). */
    this.dropped = 0;
  }

  /**
   * Feed a chunk of any size. Complete frames are emitted synchronously.
   * @param {Uint8Array|Uint8ClampedArray|ArrayLike<number>} chunk
   */
  push(chunk) {
    const src = ArrayBuffer.isView(chunk) ? chunk : Uint8Array.from(chunk);
    let offset = 0;
    const total = src.length;

    while (offset < total) {
      const buf = this._buffers[this._active];
      const room = this.frameSize - this._filled;
      const take = Math.min(room, total - offset);
      // bulk copy — this is the whole point
      buf.set(src.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;

      if (this._filled === this.frameSize) {
        this._emit(buf);
        this._filled = 0;
        this._active ^= 1;
      }
    }
  }

  _emit(buf) {
    this.frames++;
    const data = this.copy ? new Uint8ClampedArray(buf) : buf;
    this.onFrame({ width: this.width, height: this.height, data });
  }

  /**
   * Discard the partially-filled frame and start the next one at the current
   * byte. A dropped byte otherwise splices two frames together permanently.
   */
  resync() {
    this.dropped += this._filled;
    this._filled = 0;
  }

  /** Bytes still needed to complete the current frame. */
  get pending() {
    return this.frameSize - this._filled;
  }
}

/**
 * Splits an MJPEG byte stream into individual JPEG images.
 *
 * Frames are delimited by SOI (FFD8) and EOI (FFD9). `maxImageBytes` bounds the
 * buffer so a stream that never produces an EOI cannot pin memory indefinitely.
 */
export class MJPEGDemuxer {
  /**
   * @param {object} opts
   * @param {(jpeg: Uint8Array) => void} opts.onImage
   * @param {number} [opts.maxImageBytes=8388608]
   */
  constructor({ onImage, maxImageBytes = 8 * 1024 * 1024 }) {
    if (typeof onImage !== 'function') {
      throw new InvalidOptionError('MJPEGDemuxer needs an onImage callback.');
    }
    this.onImage = onImage;
    this.maxImageBytes = maxImageBytes;
    this._buf = new Uint8Array(0);
    this._len = 0;
    this._inImage = false;
    this._prev = -1;
    /** Images that exceeded maxImageBytes and were discarded. */
    this.overflows = 0;
    this.images = 0;
  }

  /** @param {Uint8Array|Uint8ClampedArray|ArrayLike<number>} chunk */
  push(chunk) {
    const src = ArrayBuffer.isView(chunk) ? chunk : Uint8Array.from(chunk);
    if (src.length === 0) return;
    let i = 0;

    while (i < src.length) {
      if (!this._inImage) {
        // a marker can straddle the chunk boundary, so the previous byte matters
        if (this._prev === SOI_0 && src[i] === SOI_1) {
          this._startImage();
          this._prev = src[i];
          i += 1;
          continue;
        }
        const soi = indexOfPair(src, i, SOI_0, SOI_1);
        if (soi < 0) {
          this._prev = src[src.length - 1];
          return;
        }
        this._startImage();
        i = soi + 2;
        this._prev = SOI_1;
        continue;
      }

      // inside an image: its leading 0xFF is already buffered as payload
      if (this._prev === EOI_0 && src[i] === EOI_1) {
        this._append(src.subarray(i, i + 1));
        this._finishImage();
        this._prev = EOI_1;
        i += 1;
        continue;
      }
      const eoi = indexOfPair(src, i, EOI_0, EOI_1);
      if (eoi < 0) {
        this._append(src.subarray(i));
        this._prev = src[src.length - 1];
        return;
      }
      this._append(src.subarray(i, eoi + 2));
      this._finishImage();
      i = eoi + 2;
      this._prev = EOI_1;
    }
  }

  _startImage() {
    this._inImage = true;
    this._len = 0;
    this._append(SOI_BYTES);
  }

  _finishImage() {
    if (this._inImage && this._len > 0 && this._len <= this.maxImageBytes) {
      this.images++;
      this.onImage(this._buf.subarray(0, this._len));
    }
    this._inImage = false;
    this._len = 0;
  }

  _append(part) {
    if (this._len + part.length > this.maxImageBytes) {
      // give up on this image rather than growing without bound
      this.overflows++;
      this._inImage = false;
      this._len = 0;
      return;
    }
    if (this._len + part.length > this._buf.length) {
      let cap = this._buf.length || 65536;
      while (cap < this._len + part.length) cap *= 2;
      const next = new Uint8Array(Math.min(cap, this.maxImageBytes));
      next.set(this._buf.subarray(0, this._len));
      this._buf = next;
    }
    this._buf.set(part, this._len);
    this._len += part.length;
  }
}

const SOI_BYTES = Uint8Array.of(SOI_0, SOI_1);

/** Index of a two-byte marker at or after `from`, or -1. */
function indexOfPair(buf, from, b0, b1) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1) return i;
  }
  return -1;
}
