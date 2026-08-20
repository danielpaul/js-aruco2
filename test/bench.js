/**
 * Performance comparison against the pre-3.0 implementation.
 *
 *   node test/bench.js
 *
 * Each variant runs in this process; where JIT contamination would distort a
 * comparison (typed vs plain-array buffers) the audit's isolated-process
 * methodology applies and those numbers live in the report, not here.
 */

import { renderFrame, rng } from './render.js';
import { legacyAdapter, nextAdapter } from './adapters.js';
import { loadDictionary } from '../src/dictionaries/index.js';
import { Dictionary } from '../src/dictionary.js';
import { StreamDecoder } from '../src/stream.js';

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function time(fn, iters, warm = 20) {
  for (let i = 0; i < warm; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
}

function noisy(frame, amount, seed = 3) {
  const rand = rng(seed);
  const d = new Uint8ClampedArray(frame.data);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 2 * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  return { width: frame.width, height: frame.height, data: d };
}

const DICT = 'ARUCO_MIP_36h12';
const legacy = legacyAdapter();
const next = await nextAdapter([DICT, 'APRILTAG_36h9', 'DICT_5X5_50', 'ARTOOLKITPLUSBCH']);
const dict = next.dictionary(DICT);

function frameAt(w, h) {
  const markers = [0, 1, 2, 3].map((id, i) => ({
    bits: dict.bitsFor(id), gridSize: dict.gridSize,
    sidePx: Math.round(w * 0.17),
    cx: w * (0.25 + (i % 2) * 0.5), cy: h * (0.28 + ((i / 2) | 0) * 0.45),
  }));
  return renderFrame({ markers, width: w, height: h });
}

console.log('=== detect() end to end ===');
console.log(pad('frame', 24) + pad('pre-3.0', 12) + pad('3.0', 12) + pad('speedup', 10) + 'markers');
for (const [w, h, label] of [[640, 480, '640x480'], [1280, 720, '1280x720'], [1920, 1080, '1920x1080']]) {
  const clean = frameAt(w, h);
  for (const [frame, tag] of [[clean, 'clean'], [noisy(clean, 90), 'noisy']]) {
    const dl = legacy && legacy.makeDetector({ dictionaryName: DICT });
    const dn = next.makeDetector({ dictionaryName: DICT });
    const tl = dl ? time(() => dl.detect(frame), 25) : NaN;
    const tn = time(() => dn.detect(frame), 25);
    console.log(
      pad(`${label} ${tag}`, 24) +
      pad(dl ? tl.toFixed(2) + ' ms' : '—', 12) +
      pad(tn.toFixed(2) + ' ms', 12) +
      pad(dl ? (tl / tn).toFixed(2) + 'x' : '—', 10) +
      `${dn.detect(frame).length}`
    );
  }
}

console.log('\n=== half resolution (same ids, per the audit\'s biggest single lever) ===');
{
  const full = frameAt(1920, 1080);
  const half = frameAt(960, 540);
  const dFull = next.makeDetector({ dictionaryName: DICT });
  const dHalf = next.makeDetector({ dictionaryName: DICT, adaptiveThresholdOffset: 12 });
  for (const [frame, det, label] of [[full, dFull, '1920x1080 offset 7'], [half, dHalf, ' 960x540  offset 12']]) {
    const t = time(() => det.detect(frame), 25);
    console.log(`  ${pad(label, 22)} ${pad(t.toFixed(2) + ' ms', 10)} ids ${JSON.stringify(det.detect(frame).map((m) => m.id).sort())}`);
  }
}

console.log('\n=== Dictionary construction (was O(n^2) over strings for tau: null) ===');
console.log(pad('dictionary', 22) + pad('pre-3.0', 12) + pad('3.0', 12) + 'speedup');
for (const name of ['ARTOOLKITPLUSBCH', 'ARUCO_7X7_1000', 'ARUCO_6X6_1000', 'ARTAG']) {
  const def = await (await import('../src/dictionaries/index.js')).loadDictionaryDefinition(name);
  let tl = NaN;
  if (legacy) {
    const { AR } = await import('node:module').then((m) => m.createRequire(import.meta.url)('../legacy/aruco.js'));
    const t0 = process.hrtime.bigint();
    new AR.Dictionary(name);
    tl = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const t1 = process.hrtime.bigint();
  new Dictionary(def);
  const tn = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(pad(name, 22) + pad(tl.toFixed(0) + ' ms', 12) + pad(tn.toFixed(0) + ' ms', 12) +
    (tl / tn).toFixed(0) + 'x');
}

console.log('\n=== Dictionary.find(), one candidate ===');
console.log(pad('dictionary', 22) + pad('codes', 8) + pad('pre-3.0', 12) + pad('3.0', 12) + 'speedup');
{
  const require_ = (await import('node:module')).createRequire(import.meta.url);
  const { AR } = require_('../legacy/aruco.js');
  for (const f of (await import('node:fs')).readdirSync(new URL('../legacy/dictionaries', import.meta.url))) {
    if (f.endsWith('.js')) require_('../legacy/dictionaries/' + f);
  }
  function rotateM(s) {
    const d = [];
    for (let i = 0; i < s.length; ++i) { d[i] = []; for (let j = 0; j < s[i].length; ++j) d[i][j] = s[s[i].length - j - 1][i]; }
    return d;
  }
  for (const [nextName, legacyName] of [['ARUCO_MIP_36h12', 'ARUCO_MIP_36h12'], ['DICT_5X5_50', null], ['APRILTAG_36h9', 'APRILTAG_36h9']]) {
    const nd = next.dictionary(nextName);
    const n = nd.gridSize;
    const grid = []; let flat = [];
    for (let i = 0; i < n; i++) { grid[i] = []; for (let j = 0; j < n; j++) { const v = (i * n + j) % 2; grid[i][j] = v; flat.push(v); } }
    const obs = new Uint32Array(nd.lanes);
    for (let i = 0; i < flat.length; i++) if (flat[i]) obs[i >> 5] |= 1 << (i & 31);
    const tn = time(() => nd.find(obs, nd.maxCorrectionBits), 500, 200);
    let tl = NaN;
    if (legacyName && AR.DICTIONARIES[legacyName]) {
      const od = new AR.Dictionary(legacyName);
      tl = time(() => { let r = grid; for (let i = 0; i < 4; i++) { od.find(r); if (i < 3) r = rotateM(r); } }, 200, 50);
    }
    console.log(pad(nextName, 22) + pad(nd.size, 8) + pad(isNaN(tl) ? '—' : tl.toFixed(3) + ' ms', 12) +
      pad(tn.toFixed(4) + ' ms', 12) + (isNaN(tl) ? '—' : (tl / tn).toFixed(0) + 'x'));
  }
}

console.log('\n=== stream ingestion (quarter-frame chunk, 640x480 RGBA) ===');
{
  const chunk = new Uint8Array(640 * 480);
  const sd = new StreamDecoder({ width: 640, height: 480, onFrame() {} });
  const tn = time(() => sd.push(chunk), 200, 50);
  // pre-3.0 byte-at-a-time equivalent
  const buf = new Uint8ClampedArray(640 * 480 * 4);
  let idx = 0;
  const tl = time(() => {
    for (let i = 0; i < chunk.length; i++) { buf[idx] = chunk[i]; idx = (idx + 1) % buf.length; }
  }, 200, 50);
  console.log(`  pre-3.0 byte loop  ${tl.toFixed(3)} ms`);
  console.log(`  3.0 TypedArray.set ${tn.toFixed(4)} ms   ${(tl / tn).toFixed(0)}x`);
}
