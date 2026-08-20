/**
 * Error types.
 *
 * The pre-3.0 library threw bare strings, which have no stack, fail
 * `instanceof Error`, and render as an unhelpful blank in the Next.js error
 * overlay. Everything here subclasses Error and carries structured fields.
 */

export class ArucoError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArucoError';
    Object.assign(this, details);
  }
}

export class UnknownDictionaryError extends ArucoError {
  constructor(name, available) {
    super(
      `Unknown dictionary "${name}". Available: ${available.join(', ')}.`,
      { dictionaryName: name, available }
    );
    this.name = 'UnknownDictionaryError';
  }
}

export class InvalidDictionaryError extends ArucoError {
  constructor(message, details) {
    super(message, details);
    this.name = 'InvalidDictionaryError';
  }
}

export class InvalidImageError extends ArucoError {
  constructor(message, details) {
    super(message, details);
    this.name = 'InvalidImageError';
  }
}

export class InvalidOptionError extends ArucoError {
  constructor(message, details) {
    super(message, details);
    this.name = 'InvalidOptionError';
  }
}
