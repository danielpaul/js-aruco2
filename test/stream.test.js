import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamDecoder, MJPEGDemuxer } from '../src/stream.js';
import { InvalidOptionError } from '../src/errors.js';

test('assembles frames from arbitrarily-sized chunks', () => {
  const frames = [];
  const sd = new StreamDecoder({ width: 4, height: 3, onFrame: (f) => frames.push(f.data.slice()) });
  const frameSize = 4 * 3 * 4;
  const src = new Uint8Array(frameSize * 3);
  for (let i = 0; i < src.length; i++) src[i] = i & 0xff;

  // feed in awkward chunk sizes, including ones that straddle frame boundaries
  let o = 0;
  for (const n of [1, 7, 13, 2, 40, 5, 60, 20, 100]) {
    if (o >= src.length) break;
    sd.push(src.subarray(o, Math.min(src.length, o + n)));
    o += n;
  }
  sd.push(src.subarray(o));

  assert.equal(frames.length, 3);
  assert.equal(sd.frames, 3);
  for (let f = 0; f < 3; f++) {
    assert.deepEqual(
      Array.from(frames[f]),
      Array.from(src.subarray(f * frameSize, (f + 1) * frameSize)),
      `frame ${f}`
    );
  }
});

test('a chunk exactly one frame long emits exactly one frame', () => {
  let n = 0;
  const sd = new StreamDecoder({ width: 2, height: 2, onFrame: () => n++ });
  sd.push(new Uint8Array(2 * 2 * 4));
  assert.equal(n, 1);
  assert.equal(sd.pending, sd.frameSize);
});

test('the frame handed to the callback is not overwritten by the next frame', () => {
  // The pre-3.0 implementation passed a live alias of its rolling buffer and
  // then wrote the next frame straight into it.
  const seen = [];
  const sd = new StreamDecoder({ width: 2, height: 2, onFrame: (f) => seen.push(f.data) });
  const size = 2 * 2 * 4;
  sd.push(new Uint8Array(size).fill(1));
  const firstAtCallback = seen[0][0];
  sd.push(new Uint8Array(size).fill(2));
  assert.equal(firstAtCallback, 1);
  assert.equal(seen[0][0], 1, 'frame 1 must still read as frame 1 after frame 2 arrives');
  assert.equal(seen[1][0], 2);
});

test('copy:true hands over an owned buffer', () => {
  const seen = [];
  const sd = new StreamDecoder({ width: 2, height: 2, copy: true, onFrame: (f) => seen.push(f.data) });
  const size = 2 * 2 * 4;
  sd.push(new Uint8Array(size).fill(1));
  sd.push(new Uint8Array(size).fill(2));
  sd.push(new Uint8Array(size).fill(3));
  assert.equal(seen[0][0], 1);
  assert.equal(seen[1][0], 2);
  assert.equal(seen[2][0], 3);
  assert.notEqual(seen[0].buffer, seen[2].buffer);
});

test('resync() drops a partial frame instead of splicing two together', () => {
  const frames = [];
  const sd = new StreamDecoder({ width: 2, height: 2, onFrame: (f) => frames.push(f.data[0]) });
  const size = 2 * 2 * 4;
  sd.push(new Uint8Array(5).fill(9));   // partial, then the sender drops a byte
  assert.equal(sd.pending, size - 5);
  sd.resync();
  assert.equal(sd.dropped, 5);
  assert.equal(sd.pending, size);
  sd.push(new Uint8Array(size).fill(4));
  assert.deepEqual(frames, [4], 'the next frame is clean, not spliced');
});

test('luma streams are supported', () => {
  let got = null;
  const sd = new StreamDecoder({ width: 3, height: 2, channels: 1, onFrame: (f) => { got = f; } });
  sd.push(new Uint8Array(6).fill(7));
  assert.ok(got);
  assert.equal(got.data.length, 6);
});

test('bad stream options throw typed errors', () => {
  assert.throws(() => new StreamDecoder({ width: 0, height: 1, onFrame() {} }),
    (e) => e instanceof InvalidOptionError);
  assert.throws(() => new StreamDecoder({ width: 2, height: 2 }),
    (e) => e instanceof InvalidOptionError && /onFrame/.test(e.message));
  assert.throws(() => new StreamDecoder({ width: 2, height: 2, channels: 3, onFrame() {} }),
    (e) => e instanceof InvalidOptionError && /channels/.test(e.message));
});

/* ------------------------------------------------------------------ */

function jpegLike(payload) {
  return Uint8Array.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}

test('MJPEG demuxer splits images — the path that used to throw on first call', () => {
  // detectMJPEGStream referenced `this.mjpeg` inside a findIndex callback with
  // no thisArg, so it threw TypeError immediately; and the chunks.flat() behind
  // it would not have concatenated typed arrays anyway.
  const images = [];
  const dm = new MJPEGDemuxer({ onImage: (img) => images.push(Array.from(img)) });
  const a = jpegLike([1, 2, 3]);
  const b = jpegLike([4, 5]);
  dm.push(Uint8Array.from([...a, ...b]));
  assert.equal(images.length, 2);
  assert.deepEqual(images[0], Array.from(a));
  assert.deepEqual(images[1], Array.from(b));
});

test('MJPEG demuxer reassembles an image split across chunks', () => {
  const images = [];
  const dm = new MJPEGDemuxer({ onImage: (img) => images.push(Array.from(img)) });
  const img = jpegLike([10, 20, 30, 40, 50]);
  for (let i = 0; i < img.length; i += 2) dm.push(img.subarray(i, i + 2));
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], Array.from(img));
});

test('MJPEG demuxer bounds its buffer instead of pinning memory', () => {
  // A body that never contains an EOI marker used to grow 1:1 with bytes received.
  let called = 0;
  const dm = new MJPEGDemuxer({ onImage: () => called++, maxImageBytes: 1024 });
  dm.push(Uint8Array.from([0xff, 0xd8]));
  for (let i = 0; i < 20; i++) dm.push(new Uint8Array(200));
  assert.equal(called, 0);
  assert.ok(dm.overflows > 0, 'oversized image was abandoned');
  assert.ok(dm._buf.length <= 1024);
});

test('MJPEG demuxer ignores leading garbage before the first SOI', () => {
  const images = [];
  const dm = new MJPEGDemuxer({ onImage: (img) => images.push(img.length) });
  dm.push(Uint8Array.from([0, 1, 2, 3]));
  dm.push(jpegLike([7, 7, 7]));
  assert.deepEqual(images, [7]);
});
