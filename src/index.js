/**
 * js-aruco2 — ArUco marker detection for the browser and Node.
 *
 * Public entry point. Deliberately contains no dictionary data: import the one
 * you need from `js-aruco2/dictionaries/<name>` for a static dependency, or use
 * `loadDictionary(name)` from `js-aruco2/dictionaries` to code-split it.
 *
 * @example
 * import { Detector } from 'js-aruco2';
 * import dict from 'js-aruco2/dictionaries/dict-5x5-50';
 *
 * // a definition object is accepted directly, and wrapped once
 * const detector = new Detector({ dictionary: dict });
 * const markers = detector.detect(imageData);
 *
 * @example
 * // or build the Dictionary yourself, to read tau / warnings / toSVG
 * import { Detector, Dictionary } from 'js-aruco2';
 * import def from 'js-aruco2/dictionaries/dict-5x5-50';
 *
 * const dictionary = new Dictionary(def);
 * const detector = new Detector({ dictionary });
 */

export { Detector, DEFAULT_OPTIONS, validateImage } from './detector.js';
export { Dictionary, packBits } from './dictionary.js';
export { GrayImage } from './cv.js';
export { StreamDecoder, MJPEGDemuxer } from './stream.js';
export { Posit, Pose } from './posit.js';
export {
  ArucoError,
  UnknownDictionaryError,
  InvalidDictionaryError,
  InvalidImageError,
  InvalidOptionError,
} from './errors.js';

import { Dictionary } from './dictionary.js';

/**
 * Build a Dictionary from a definition object, with validation.
 * Use this for custom marker sets instead of mutating a global registry.
 *
 * @param {import('./dictionary.js').DictionaryDefinition} definition
 * @returns {Dictionary}
 */
export function defineDictionary(definition) {
  return new Dictionary(definition);
}
