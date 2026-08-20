/**
 * Detector adapters for the A/B harness.
 *
 * `legacy` drives the pre-rewrite CommonJS implementation (kept in legacy/ as a
 * reference baseline). `next` drives the current ESM library.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const LEGACY_DIR = join(__dirname, '..', 'legacy');

export function legacyAdapter() {
  if (!existsSync(join(LEGACY_DIR, 'aruco.js'))) return null;
  const { AR } = require(join(LEGACY_DIR, 'aruco.js'));
  // register every legacy dictionary file
  const fs = require('node:fs');
  for (const f of fs.readdirSync(join(LEGACY_DIR, 'dictionaries'))) {
    if (f.endsWith('.js')) require(join(LEGACY_DIR, 'dictionaries', f));
  }
  return {
    name: 'legacy',
    makeDetector(opts) {
      const d = new AR.Detector(opts);
      return { detect: (frame) => d.detect(frame) };
    },
    bitsFor(dictName, id) {
      const dict = new AR.Dictionary(dictName);
      const g = Math.sqrt(dict.nBits);
      const code = dict.codeList[id];
      const bits = new Array(dict.nBits);
      for (let i = 0; i < dict.nBits; i++) bits[i] = code[i] === '1' ? 1 : 0;
      return { bits, gridSize: g };
    },
  };
}

export async function nextAdapter(dictNames = []) {
  const mod = await import('../src/index.js');
  const { loadDictionary } = await import('../src/dictionaries/index.js');
  const { Detector, Dictionary } = mod;

  // preload so the adapter surface can stay synchronous for the harness
  const loaded = new Map();
  for (const n of dictNames) loaded.set(n, await loadDictionary(n));

  const get = (name) => {
    const d = loaded.get(name);
    if (!d) throw new Error(`dictionary "${name}" was not preloaded into the adapter`);
    return d;
  };

  return {
    name: 'next',
    makeDetector(opts) {
      const { dictionaryName, ...rest } = opts;
      const d = new Detector({ dictionary: get(dictionaryName), ...rest });
      return { detect: (frame) => d.detect(frame) };
    },
    bitsFor(dictName, id) {
      const dict = get(dictName);
      return { bits: dict.bitsFor(id), gridSize: dict.gridSize };
    },
    dictionary: get,
    _mod: mod,
    _Dictionary: Dictionary,
  };
}
