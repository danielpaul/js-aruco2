import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Detector, DEFAULT_OPTIONS } from '../src/detector.js';
import { InvalidImageError, InvalidOptionError } from '../src/errors.js';
import { loadDictionary } from '../src/dictionaries/index.js';
import { renderFrame, textureFrame, blackSquareFrame } from './render.js';

const dict5x5 = await loadDictionary('DICT_5X5_50');
const dictMip = await loadDictionary('ARUCO_MIP_36h12');
const dictChili = await loadDictionary('CHILITAGS');

function frameFor(dict, id, extra = {}) {
  return renderFrame({
    bits: dict.bitsFor(id), gridSize: dict.gridSize,
    width: 640, height: 480, sidePx: 140, ...extra,
  });
}

test('detects a marker and returns four corners', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const markers = det.detect(frameFor(dict5x5, 7));
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, 7);
  assert.equal(markers[0].hammingDistance, 0);
  assert.equal(markers[0].corners.length, 4);
  for (const c of markers[0].corners) {
    assert.equal(typeof c.x, 'number');
    assert.equal(typeof c.y, 'number');
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
  }
});

test('detects every id in DICT_5X5_50', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const missed = [];
  for (let id = 0; id < 50; id++) {
    const found = det.detect(frameFor(dict5x5, id)).map((m) => m.id);
    if (!found.includes(id)) missed.push(id);
  }
  assert.deepEqual(missed, [], 'no id should be undetectable');
});

test('detects all four rotations of a marker', () => {
  const det = new Detector({ dictionary: dict5x5 });
  for (const rollDeg of [0, 90, 180, 270]) {
    const markers = det.detect(frameFor(dict5x5, 11, { rollDeg }));
    assert.equal(markers.length, 1, `roll ${rollDeg}`);
    assert.equal(markers[0].id, 11, `roll ${rollDeg}`);
  }
});

test('detects several markers in one frame', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const markers = [0, 1, 2, 3].map((id, i) => ({
    bits: dict5x5.bitsFor(id), gridSize: dict5x5.gridSize, sidePx: 110,
    cx: 150 + (i % 2) * 320, cy: 130 + ((i / 2) | 0) * 230,
  }));
  const found = det.detect(renderFrame({ markers, width: 640, height: 480 }));
  assert.deepEqual(found.map((m) => m.id).sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('a marker-free textured frame produces no detections', () => {
  // The pre-3.0 acceptance bound emitted ~45 phantom markers per frame here.
  for (const block of [8, 16, 32]) {
    for (const dict of [dict5x5, dictMip]) {
      const det = new Detector({ dictionary: dict });
      const found = det.detect(textureFrame({ block, seed: 7 }));
      assert.deepEqual(found, [], `${dict.name} at ${block}px blocks`);
    }
  }
});

test('a solid dark rectangle is not a marker, even for a dictionary with a uniform code', () => {
  // CHILITAGS id 682 is 64 zero bits. Before, every dark quad decoded as it at
  // hammingDistance 0 — a match no caller-side filter could exclude, since
  // distance 0 is the strongest signal the API offers.
  //
  // The root cause turned out to be the same one that made CHILITAGS
  // undetectable: warpSize was hardcoded to 49 while markSize is 10, so the
  // sampling lattice covered only the inner 40x49 of the warp and never saw the
  // quad's edges. Deriving warpSize from the grid fixes both. The
  // allowUniformCodes guard below is defence in depth for the general case.
  const det = new Detector({ dictionary: dictChili });
  assert.deepEqual(det.detect(blackSquareFrame({})), []);
  // ...and it stays rejected however permissively the rest is configured
  const permissive = new Detector({
    dictionary: dictChili, allowUniformCodes: true, cellMargin: 0, borderErrorRate: 0.9,
  });
  assert.deepEqual(permissive.detect(blackSquareFrame({})).filter((m) => m.id === 682), []);
});

test('a uniform sampled grid never reaches the dictionary', () => {
  // Unit-level check of the guard itself: an all-zero observation is exactly
  // CHILITAGS code 682, so the lookup would return it at distance 0.
  const obs = new Uint32Array(dictChili.lanes);
  const hit = dictChili.find(obs, dictChili.maxCorrectionBits);
  assert.equal(hit?.id, 682, 'the dictionary really does contain the all-zero code');
  assert.equal(hit.distance, 0);
  assert.equal(DEFAULT_OPTIONS.allowUniformCodes, false, 'so the detector must not ask');
});

test('CHILITAGS decodes at all, which it could not before', () => {
  // warpSize was hardcoded to 49 while CHILITAGS needs markSize 10, so the
  // sampling lattice sat on the wrong cells and it never decoded anything.
  const det = new Detector({ dictionary: dictChili });
  const found = det.detect(frameFor(dictChili, 5, { sidePx: 180 }));
  assert.deepEqual(found.map((m) => m.id), [5]);
});

test('warpSize is derived from the dictionary grid', () => {
  assert.equal(new Detector({ dictionary: dict5x5 }).warpSize, 7 * 8);
  assert.equal(new Detector({ dictionary: dictMip }).warpSize, 8 * 8);
  assert.equal(new Detector({ dictionary: dictChili }).warpSize, 10 * 8);
  assert.equal(new Detector({ dictionary: dict5x5, cellSize: 6 }).warpSize, 7 * 6);
});

test('small markers are detected — the dedupe fix', () => {
  // notTooNear used to discard the decodable quad in favour of its quiet-zone
  // neighbour once a marker fell below ~70px.
  const det = new Detector({ dictionary: dict5x5 });
  for (const sidePx of [32, 48, 64]) {
    const found = det.detect(frameFor(dict5x5, 2, { sidePx }));
    assert.deepEqual(found.map((m) => m.id), [2], `sidePx ${sidePx}`);
  }
});

test('one physical marker yields exactly one result', () => {
  const det = new Detector({ dictionary: dict5x5 });
  for (const sidePx of [64, 120, 200]) {
    const found = det.detect(frameFor(dict5x5, 4, { sidePx }));
    assert.equal(found.length, 1, `sidePx ${sidePx} should not report nested duplicates`);
  }
});

test('switching resolution on one detector stays correct', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const big = renderFrame({ bits: dict5x5.bitsFor(9), gridSize: 5, width: 640, height: 480, sidePx: 160 });
  const small = renderFrame({ bits: dict5x5.bitsFor(9), gridSize: 5, width: 320, height: 240, sidePx: 110 });
  assert.deepEqual(det.detect(big).map((m) => m.id), [9]);
  assert.deepEqual(det.detect(small).map((m) => m.id), [9]);
  assert.equal(det._grey.width, 320);
  assert.equal(det._grey.height, 240);
  assert.deepEqual(det.detect(big).map((m) => m.id), [9]);
});

test('markers survive the next detect() call', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const first = det.detect(frameFor(dict5x5, 1));
  const snapshot = JSON.stringify(first);
  det.detect(frameFor(dict5x5, 2));
  assert.equal(JSON.stringify(first), snapshot, 'results must not alias detector state');
});

test('luma input matches RGBA input', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const frame = frameFor(dict5x5, 12);
  const rgba = det.detect(frame);
  const luma = new Uint8Array(frame.width * frame.height);
  for (let i = 0, j = 0; j < luma.length; i += 4, j++) {
    luma[j] = (frame.data[i] * 19595 + frame.data[i + 1] * 38470 + frame.data[i + 2] * 7471 + 32768) >> 16;
  }
  const det2 = new Detector({ dictionary: dict5x5 });
  const fromLuma = det2.detect({ width: frame.width, height: frame.height, data: luma }, { luma: true });
  assert.deepEqual(fromLuma.map((m) => m.id), rgba.map((m) => m.id));
});

/* ------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------ */

test('lying dimensions are rejected instead of allocating gigabytes', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const tiny = new Uint8ClampedArray(16);
  assert.throws(
    () => det.detect({ width: 8000, height: 8000, data: tiny }),
    (e) => e instanceof InvalidImageError && /maxPixels/.test(e.message)
  );
  assert.throws(
    () => det.detect({ width: 1000, height: 1000, data: tiny }),
    (e) => e instanceof InvalidImageError && /needs 4000000/.test(e.message)
  );
});

test('malformed frames throw typed errors', () => {
  const det = new Detector({ dictionary: dict5x5 });
  const cases = [
    undefined,
    { width: -640, height: 480, data: new Uint8ClampedArray(16) },
    { width: 640, height: 0, data: new Uint8ClampedArray(16) },
    { width: 6.5, height: 480, data: new Uint8ClampedArray(16) },
    { width: 4, height: 4, data: null },
  ];
  for (const c of cases) {
    assert.throws(() => det.detect(c), (e) => e instanceof InvalidImageError && e instanceof Error);
  }
});

test('bad options throw typed errors', () => {
  assert.throws(() => new Detector({}), (e) => e instanceof InvalidOptionError);
  assert.throws(
    () => new Detector({ dictionary: dict5x5, adaptiveThresholdKernel: 20 }),
    (e) => e instanceof InvalidOptionError && /0\.\.15/.test(e.message)
  );
  assert.throws(
    () => new Detector({ dictionary: dict5x5, cellMargin: 4, cellSize: 8 }),
    (e) => e instanceof InvalidOptionError && /cellMargin/.test(e.message)
  );
  assert.throws(
    () => new Detector({ dictionary: dict5x5, maxHammingDistance: -1 }),
    (e) => e instanceof InvalidOptionError
  );
});

test('every thrown error is a real Error with a stack', () => {
  const det = new Detector({ dictionary: dict5x5 });
  try {
    det.detect(null);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.equal(typeof e.stack, 'string');
    assert.ok(e.stack.length > 0);
    assert.notEqual(typeof e, 'string');
  }
});

test('dispose releases buffers and blocks further use', () => {
  const det = new Detector({ dictionary: dict5x5 });
  det.detect(frameFor(dict5x5, 0));
  det.dispose();
  assert.throws(() => det.detect(frameFor(dict5x5, 0)), (e) => e instanceof InvalidOptionError);
});

test('maxHammingDistance defaults to the dictionary bound and is overridable', () => {
  assert.equal(new Detector({ dictionary: dict5x5 }).maxHammingDistance, 3);
  assert.equal(new Detector({ dictionary: dict5x5, maxHammingDistance: 0 }).maxHammingDistance, 0);
});

test('adaptiveThresholdOffset is configurable, which is what enables half-res input', () => {
  const det = new Detector({ dictionary: dict5x5, adaptiveThresholdOffset: 12 });
  assert.equal(det.options.adaptiveThresholdOffset, 12);
  const half = renderFrame({ bits: dict5x5.bitsFor(6), gridSize: 5, width: 320, height: 240, sidePx: 90 });
  assert.deepEqual(det.detect(half).map((m) => m.id), [6]);
});

test('stats describe the last frame', () => {
  const det = new Detector({ dictionary: dict5x5 });
  det.detect(frameFor(dict5x5, 0));
  assert.ok(det.stats.contours > 0);
  assert.ok(det.stats.candidates > 0);
  assert.equal(det.stats.decoded, 1);
});

/* ------------------------------------------------------------------ *
 * Review follow-ups (PR #1)
 * ------------------------------------------------------------------ */

test('a dictionary definition object is accepted directly', async () => {
  // The documented example passed the imported data module straight in, which
  // used to throw because only a built Dictionary was accepted.
  const { loadDictionaryDefinition } = await import('../src/dictionaries/index.js');
  const def = await loadDictionaryDefinition('DICT_5X5_50');
  const det = new Detector({ dictionary: def });
  assert.equal(det.dictionary.name, 'DICT_5X5_50');
  assert.equal(det.maxHammingDistance, 3);
  assert.deepEqual(det.detect(frameFor(det.dictionary, 5)).map((m) => m.id), [5]);
});

test('the same definition object is only wrapped once', async () => {
  const { loadDictionaryDefinition } = await import('../src/dictionaries/index.js');
  const def = await loadDictionaryDefinition('DICT_5X5_50');
  const a = new Detector({ dictionary: def });
  const b = new Detector({ dictionary: def });
  assert.equal(a.dictionary, b.dictionary, 'definitions are cached by identity');
});

test('a non-dictionary value produces a helpful error naming the real API', () => {
  for (const bad of [undefined, null, 'DICT_5X5_50', 42, {}]) {
    assert.throws(
      () => new Detector({ dictionary: bad }),
      (e) => e instanceof InvalidOptionError && /loadDictionary/.test(e.message),
      `value ${JSON.stringify(bad)}`
    );
  }
});

test('maxCorrectionBits is intrinsic; maxHammingDistance is the applied bound', () => {
  const plain = new Detector({ dictionary: dict5x5 });
  assert.equal(dict5x5.maxCorrectionBits, 3);
  assert.equal(plain.maxHammingDistance, 3);

  const strict = new Detector({ dictionary: dict5x5, maxHammingDistance: 0 });
  assert.equal(dict5x5.maxCorrectionBits, 3, 'the dictionary value must not move');
  assert.equal(strict.maxHammingDistance, 0);
});
