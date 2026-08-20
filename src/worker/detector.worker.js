/**
 * Detection worker.
 *
 * Detection is 8-120 ms of synchronous work per frame depending on resolution
 * and scene noise. On the main thread that is enough to stall React rendering
 * and destroy Interaction to Next Paint, so the supported way to run this in an
 * app is here, off the main thread, with the frame buffer transferred rather
 * than copied.
 *
 * Instantiate with the URL form both webpack and Turbopack understand:
 *
 *   const worker = new Worker(
 *     new URL('@danielpaul/js-aruco2/worker', import.meta.url),
 *     { type: 'module' }
 *   );
 *
 * Protocol (main -> worker):
 *   { type: 'init', id, dictionary: string | DictionaryDefinition, options }
 *   { type: 'detect', id, width, height, data: ArrayBuffer, luma?: boolean }   // transfer `data`
 *   { type: 'options', id, options }
 *   { type: 'dispose', id }
 *
 * Protocol (worker -> main):
 *   { type: 'ready', id, dictionary, ids, maxCorrectionBits, warnings }
 *   { type: 'markers', id, markers, stats, data: ArrayBuffer }  // `data` transferred back
 *   { type: 'error', id, name, message, details }
 */

import { Detector } from '../detector.js';
import { Dictionary } from '../dictionary.js';
import { loadDictionary } from '../dictionaries/index.js';

/** @type {Detector | null} */
let detector = null;

async function resolveDictionary(spec) {
  if (typeof spec === 'string') return loadDictionary(spec);
  if (spec instanceof Dictionary) return spec;
  return new Dictionary(spec);
}

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function fail(id, err) {
  const { name, message, ...details } = err || {};
  post({
    type: 'error',
    id,
    name: name || 'Error',
    message: message || String(err),
    details,
  });
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const { type, id } = msg;

  try {
    if (type === 'init') {
      const dictionary = await resolveDictionary(msg.dictionary);
      if (detector) detector.dispose();
      detector = new Detector({ dictionary, ...(msg.options || {}) });
      post({
        type: 'ready',
        id,
        dictionary: dictionary.name,
        ids: dictionary.ids.length,
        maxCorrectionBits: detector.maxHammingDistance,
        warnings: dictionary.warnings,
      });
      return;
    }

    if (type === 'options') {
      if (!detector) throw new Error('worker received "options" before "init"');
      const dictionary = detector.dictionary;
      detector.dispose();
      detector = new Detector({ dictionary, ...(msg.options || {}) });
      post({ type: 'ready', id, dictionary: dictionary.name, ids: dictionary.ids.length,
        maxCorrectionBits: detector.maxHammingDistance, warnings: dictionary.warnings });
      return;
    }

    if (type === 'detect') {
      if (!detector) throw new Error('worker received "detect" before "init"');
      const data = msg.luma
        ? new Uint8Array(msg.data)
        : new Uint8ClampedArray(msg.data);
      const markers = detector.detect(
        { width: msg.width, height: msg.height, data },
        { luma: msg.luma === true }
      );
      // hand the buffer straight back so the caller can pool it
      post(
        { type: 'markers', id, markers, stats: { ...detector.stats }, data: data.buffer },
        [data.buffer]
      );
      return;
    }

    if (type === 'dispose') {
      if (detector) detector.dispose();
      detector = null;
      post({ type: 'disposed', id });
      return;
    }
  } catch (err) {
    fail(id, err);
  }
});
