import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Dictionary } from '../src/dictionary.js';
import { InvalidDictionaryError } from '../src/errors.js';
import {
  loadDictionary, loadDictionaryDefinition, DICTIONARY_NAMES, DICTIONARY_ALIASES,
} from '../src/dictionaries/index.js';

/**
 * OpenCV declares maxCorrectionBits per predefined dictionary. Our derived
 * bound is floor((tau - 1) / 2). If these ever disagree, one of the two
 * implementations would accept a detection the other rejects.
 */
const OPENCV_EXPECTED = {
  DICT_4X4_50: { tau: 4, corr: 1 }, DICT_4X4_100: { tau: 3, corr: 1 },
  DICT_4X4_250: { tau: 3, corr: 1 }, DICT_4X4_1000: { tau: 2, corr: 0 },
  DICT_5X5_50: { tau: 8, corr: 3 }, DICT_5X5_100: { tau: 7, corr: 3 },
  DICT_5X5_250: { tau: 6, corr: 2 }, DICT_5X5_1000: { tau: 5, corr: 2 },
  DICT_6X6_50: { tau: 13, corr: 6 }, DICT_6X6_100: { tau: 12, corr: 5 },
  DICT_6X6_250: { tau: 11, corr: 5 }, DICT_6X6_1000: { tau: 9, corr: 4 },
  DICT_7X7_50: { tau: 19, corr: 9 }, DICT_7X7_100: { tau: 18, corr: 8 },
  DICT_7X7_250: { tau: 17, corr: 8 }, DICT_7X7_1000: { tau: 14, corr: 6 },
};

function rotate90(bits, n) {
  const out = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = bits[(n - 1 - x) * n + y];
  return out;
}
function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }
function bitsToHex(bits) { return parseInt(bits.join(''), 2); }
const SMALL_CODES = [0x1084210, 0x1084217, 0x10842f0, 0x1085e10];

test('OpenCV predefined dictionaries match OpenCV tau and maxCorrectionBits', async () => {
  for (const [name, want] of Object.entries(OPENCV_EXPECTED)) {
    const d = await loadDictionary(name);
    assert.equal(d.tau, want.tau, `${name} tau`);
    assert.equal(d.maxCorrectionBits, want.corr, `${name} maxCorrectionBits`);
    assert.equal(
      Math.floor((d.tau - 1) / 2), want.corr,
      `${name}: floor((tau-1)/2) must equal OpenCV's declared maxCorrectionBits`
    );
  }
});

test('DICT_5X5_50 has the expected shape', async () => {
  const d = await loadDictionary('DICT_5X5_50');
  assert.equal(d.name, 'DICT_5X5_50');
  assert.equal(d.nBits, 25);
  assert.equal(d.gridSize, 5);
  assert.equal(d.markSize, 7);
  assert.equal(d.length, 50);
  assert.equal(d.tau, 8);
  assert.equal(d.maxCorrectionBits, 3);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.uniformCodeCount, 0);
});

test('DICT_5X5_50 is a prefix of DICT_5X5_1000, as in OpenCV', async () => {
  const small = await loadDictionary('DICT_5X5_50');
  const big = await loadDictionary('DICT_5X5_1000');
  for (let id = 0; id < 50; id++) {
    assert.deepEqual(small.bitsFor(id), big.bitsFor(id), `id ${id}`);
  }
});

test('every bundled dictionary constructs and round-trips its bits', async () => {
  for (const name of DICTIONARY_NAMES) {
    const d = await loadDictionary(name);
    assert.ok(d.length > 0, `${name} has codes`);
    assert.equal(Number.isInteger(Math.sqrt(d.nBits)), true, `${name} nBits is square`);
    const id = d.ids[0];
    const bits = d.bitsFor(id);
    assert.equal(bits.length, d.nBits, `${name} bit length`);
    // an exact lookup of a code must return that code, unrotated
    const obs = new Uint32Array(d.lanes);
    for (let i = 0; i < bits.length; i++) if (bits[i]) obs[i >> 5] |= 1 << (i & 31);
    const hit = d.find(obs, d.maxCorrectionBits);
    assert.ok(hit, `${name} finds its own code`);
    assert.equal(hit.id, id);
    assert.equal(hit.distance, 0);
    assert.equal(hit.rotation, 0);
  }
});

test('all four rotations of a code resolve to the same id', async () => {
  const d = await loadDictionary('DICT_5X5_50');
  const n = d.gridSize;
  for (const id of [0, 7, 23, 49]) {
    let bits = d.bitsFor(id);
    for (let r = 0; r < 4; r++) {
      const obs = new Uint32Array(d.lanes);
      for (let i = 0; i < bits.length; i++) if (bits[i]) obs[i >> 5] |= 1 << (i & 31);
      const hit = d.find(obs, d.maxCorrectionBits);
      assert.ok(hit, `id ${id} rotation ${r}`);
      assert.equal(hit.id, id, `id ${id} rotation ${r}`);
      assert.equal(hit.distance, 0);
      // rotate for the next iteration
      const out = new Array(n * n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = bits[(n - 1 - j) * n + i];
      bits = out;
    }
  }
});

test('error correction accepts up to maxCorrectionBits and no further', async () => {
  const d = await loadDictionary('DICT_5X5_50');
  const bits = d.bitsFor(0).slice();
  for (let flips = 0; flips <= d.maxCorrectionBits + 2; flips++) {
    const b = bits.slice();
    for (let i = 0; i < flips; i++) b[i] ^= 1;
    const obs = new Uint32Array(d.lanes);
    for (let i = 0; i < b.length; i++) if (b[i]) obs[i >> 5] |= 1 << (i & 31);
    const hit = d.find(obs, d.maxCorrectionBits);
    if (flips <= d.maxCorrectionBits) {
      assert.ok(hit, `${flips} flips should still decode`);
      assert.equal(hit.id, 0);
      assert.equal(hit.distance, flips);
    }
  }
});

test('duplicate codes are dropped with a warning rather than silently shadowing', async () => {
  // ARTAG ships ids 57 and 1023 bit-identical, which made tau collapse to 0 and
  // disabled error correction entirely.
  const d = await loadDictionary('ARTAG');
  assert.ok(d.warnings.some((w) => /duplicates code 57/.test(w)), 'warns about the duplicate');
  assert.equal(d.length, 1023, 'the duplicate is removed');
  assert.ok(d.tau >= 1, 'tau is usable after dedupe');
});

test('uniform codes are reported', async () => {
  // CHILITAGS id 682 is 64 zero bits: any solid dark quad matches it exactly.
  const d = await loadDictionary('CHILITAGS');
  assert.equal(d.uniformCodeCount, 1);
  assert.ok(d.warnings.some((w) => /uniform all-black/.test(w)));
});

test('nBits must be a perfect square', () => {
  assert.throws(
    () => new Dictionary({ name: 'bad', nBits: 30, codeList: [1, 2] }),
    (e) => e instanceof InvalidDictionaryError && /perfect square/.test(e.message)
  );
});

test('malformed codes throw a typed error, not a string', () => {
  assert.throws(
    () => new Dictionary({ name: 'bad', nBits: 16, codeList: [0xffffff] }),
    (e) => e instanceof InvalidDictionaryError && e instanceof Error && /more than 16 bits/.test(e.message)
  );
  assert.throws(
    () => new Dictionary({ name: 'bad', nBits: 16, codeList: ['nothex'] }),
    (e) => e instanceof InvalidDictionaryError && /hexadecimal/.test(e.message)
  );
  assert.throws(
    () => new Dictionary({ name: 'bad', nBits: 16, codeList: [] }),
    (e) => e instanceof InvalidDictionaryError && /empty/.test(e.message)
  );
});

test('wide dictionaries survive as hex strings', async () => {
  // CHILITAGS is 64 bits — beyond exact Number representation, so its data
  // module stores hex strings.
  const def = await loadDictionaryDefinition('CHILITAGS');
  assert.equal(typeof def.codeList[0], 'string');
  const d = new Dictionary(def);
  assert.equal(d.nBits, 64);
  assert.equal(d.lanes, 2);
  assert.equal(d.bitsFor(0).length, 64);
});

test('unknown dictionary names produce a helpful typed error', async () => {
  await assert.rejects(
    () => loadDictionary('NOPE'),
    (e) => e instanceof Error && e.name === 'UnknownDictionaryError' && Array.isArray(e.available)
  );
});

test('pre-3.0 dictionary aliases still resolve', async () => {
  for (const [alias, target] of Object.entries(DICTIONARY_ALIASES)) {
    const d = await loadDictionary(alias);
    assert.equal(d.name, target, `${alias} -> ${target}`);
  }
});

test('dictionaries are cached, so a second load is the same instance', async () => {
  const a = await loadDictionary('DICT_5X5_50');
  const b = await loadDictionary('DICT_5X5_50');
  assert.equal(a, b);
});

test('toSVG emits a marker whose payload matches the code', async () => {
  const d = await loadDictionary('DICT_5X5_50');
  const svg = d.toSVG(3);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 9 9"/); // 5 payload + 2 border + 2 quiet
  const white = (svg.match(/fill="#fff"/g) || []).length;
  const ones = d.bitsFor(3).reduce((a, b) => a + b, 0);
  assert.equal(white, ones + 1, 'one background rect plus one rect per set bit');
  assert.throws(() => d.toSVG(999), (e) => e instanceof InvalidDictionaryError);
});

/* ------------------------------------------------------------------ *
 * Review follow-ups, round 2 (PR #1)
 * ------------------------------------------------------------------ */

test('tau is the minimum over all four relative rotations', async () => {
  // ARUCO ids 255 and 1022 are 7 apart as stored but ONE bit apart when 1022 is
  // rotated 180 degrees. find() matches every rotation, so the pair is
  // confusable and tau must see it — comparing canonical orientations only
  // reported 3 and licensed a correction radius that could decode the wrong id.
  const def = await loadDictionaryDefinition('ARUCO');
  const d = new Dictionary({ ...def, tau: null, maxCorrectionBits: null });
  assert.equal(d.tau, 1);
  assert.equal(d.maxCorrectionBits, 0);

  const a = d.bitsFor(255);
  let b = d.bitsFor(1022);
  for (let r = 0; r < 2; r++) b = rotate90(b, d.gridSize);
  assert.equal(hamming(a, b), 1);
});

test('a code that is a rotation of an earlier code is dropped', () => {
  const base = [1,1,0,1,0, 0,1,1,0,1, 1,0,0,1,1, 0,1,1,1,0, 1,0,1,0,0];
  const d = new Dictionary({
    name: 'ROT', nBits: 25, tau: null, maxCorrectionBits: null,
    codeList: [bitsToHex(base), bitsToHex(rotate90(base, 5))],
  });
  assert.equal(d.ids.length, 1, 'the rotated copy is unreachable');
  assert.match(d.warnings.join('\n'), /rotation \d of code 0/);
});

test('a declared correction radius is never wider than tau supports', () => {
  const def = { name: 'X', nBits: 25, tau: null, maxCorrectionBits: 9, codeList: SMALL_CODES };
  const d = new Dictionary(def);
  assert.equal(d.maxCorrectionBits, Math.max(0, Math.floor((d.tau - 1) / 2)));
  assert.match(d.warnings.join('\n'), /exceeds the \d+ that a tau of \d+ supports/);
});

test('ARTAG ships a usable correction radius, not -1', async () => {
  // The duplicate at id 1023 made the pre-dedup tau 0, so the generated module
  // declared a radius of -1 and Detector rejected every non-exact observation —
  // reintroducing the very bug this dictionary is the poster child for.
  const def = await loadDictionaryDefinition('ARTAG');
  assert.ok(def.maxCorrectionBits >= 0, `declared radius ${def.maxCorrectionBits} must be >= 0`);
  const d = new Dictionary(def);
  assert.ok(d.maxCorrectionBits >= 1, 'ARTAG supports at least one bit of correction');
  assert.equal(d.ids.length, 1023, 'the duplicate is dropped');
});

test('every bundled dictionary declares a non-negative radius within its tau', async () => {
  for (const name of DICTIONARY_NAMES) {
    const def = await loadDictionaryDefinition(name);
    const d = new Dictionary(def);
    const safe = Math.max(0, Math.floor((d.tau - 1) / 2));
    assert.ok(def.maxCorrectionBits >= 0, `${name} declares ${def.maxCorrectionBits}`);
    assert.ok(def.maxCorrectionBits <= safe, `${name} declares ${def.maxCorrectionBits} > safe ${safe}`);
    assert.equal(d.maxCorrectionBits, def.maxCorrectionBits, `${name} radius survives the build`);
  }
});

test('loadDictionary returns one instance under concurrency', async () => {
  const [a, b, c] = await Promise.all([
    loadDictionary('DICT_5X5_50'), loadDictionary('DICT_5X5_50'), loadDictionary('DICT_5X5_50'),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a failed load does not poison the instance cache', async () => {
  await assert.rejects(() => loadDictionary('NOT_A_DICTIONARY'));
  const ok = await loadDictionary('DICT_5X5_50');
  assert.equal(ok.name, 'DICT_5X5_50');
});
