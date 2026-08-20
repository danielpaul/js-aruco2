/**
 * Golden-frame A/B harness.
 *
 * Runs a fixed, deterministic battery of frames through a detector adapter and
 * returns a structured report: per-case detected ids, true/false positive
 * counts, and corner geometry. Two adapters can be diffed field by field.
 *
 * An adapter is `{ name, makeDetector(opts) -> { detect(frame) -> Marker[] }, bitsFor(dictName, id) -> {bits, gridSize} }`.
 */

import { renderFrame, textureFrame, blackSquareFrame } from './render.js';

export const SIZES = [24, 32, 48, 64, 90, 120, 180, 240];
export const TILTS = [0, 20, 40, 55];
export const ROLLS = [0, 15, 45, 75];
export const BLURS = [0, 1, 2];
export const NOISES = [0, 40, 90];

/** Every case the battery runs. Deterministic and stable across runs. */
export function buildCases(dictName, ids) {
  const cases = [];
  const id = ids[0];
  for (const sidePx of SIZES) cases.push({ kind: 'size', dictName, id, sidePx });
  for (const tiltDeg of TILTS) cases.push({ kind: 'tilt', dictName, id, sidePx: 140, tiltDeg });
  for (const rollDeg of ROLLS) cases.push({ kind: 'roll', dictName, id, sidePx: 140, rollDeg });
  for (const blur of BLURS) cases.push({ kind: 'blur', dictName, id, sidePx: 140, blur });
  for (const noise of NOISES) cases.push({ kind: 'noise', dictName, id, sidePx: 140, noise });
  // multi-marker frame
  cases.push({ kind: 'multi', dictName, ids: ids.slice(0, 4), sidePx: 110 });
  // adversarial, marker-free
  for (const block of [8, 16, 32]) cases.push({ kind: 'texture', dictName, block });
  cases.push({ kind: 'blacksquare', dictName });
  return cases;
}

function frameForCase(c, adapter) {
  if (c.kind === 'texture') return textureFrame({ block: c.block, seed: 7 });
  if (c.kind === 'blacksquare') return blackSquareFrame({});
  if (c.kind === 'multi') {
    const markers = c.ids.map((id, i) => {
      const { bits, gridSize } = adapter.bitsFor(c.dictName, id);
      return {
        bits, gridSize, sidePx: c.sidePx,
        cx: 150 + (i % 2) * 320, cy: 130 + ((i / 2) | 0) * 230,
      };
    });
    return renderFrame({ markers, width: 640, height: 480 });
  }
  const { bits, gridSize } = adapter.bitsFor(c.dictName, c.id);
  return renderFrame({
    bits, gridSize,
    width: 640, height: 480,
    sidePx: c.sidePx,
    tiltDeg: c.tiltDeg || 0,
    rollDeg: c.rollDeg || 0,
    blur: c.blur || 0,
    noise: c.noise || 0,
    seed: 11,
  });
}

function expectedIds(c) {
  if (c.kind === 'texture' || c.kind === 'blacksquare') return [];
  if (c.kind === 'multi') return c.ids.slice().sort((a, b) => a - b);
  return [c.id];
}

function caseLabel(c) {
  switch (c.kind) {
    case 'size': return `size:${c.sidePx}`;
    case 'tilt': return `tilt:${c.tiltDeg}`;
    case 'roll': return `roll:${c.rollDeg}`;
    case 'blur': return `blur:${c.blur}`;
    case 'noise': return `noise:${c.noise}`;
    case 'multi': return `multi:${c.ids.join('+')}`;
    case 'texture': return `texture:${c.block}px`;
    case 'blacksquare': return 'blacksquare';
    default: return c.kind;
  }
}

/** Run the full battery. Returns a plain object safe to JSON-diff. */
export function runBattery(adapter, dictName, ids, detectorOpts = {}) {
  const cases = buildCases(dictName, ids);
  const det = adapter.makeDetector({ dictionaryName: dictName, ...detectorOpts });
  const rows = [];
  let truePos = 0, falsePos = 0, expectedTotal = 0;

  for (const c of cases) {
    const frame = frameForCase(c, adapter);
    let markers, error = null;
    try {
      markers = det.detect(frame);
    } catch (e) {
      markers = [];
      error = String((e && e.message) || e);
    }
    const got = markers.map((m) => m.id).sort((a, b) => a - b);
    const want = expectedIds(c);
    const wantSet = new Set(want);
    const hit = want.filter((id) => got.includes(id)).length;
    const extra = got.filter((id) => !wantSet.has(id)).length;
    truePos += hit;
    falsePos += extra;
    expectedTotal += want.length;

    rows.push({
      case: caseLabel(c),
      want,
      got,
      hit,
      extra,
      error,
      // corner geometry of the first correctly-identified marker, rounded to
      // 1e-3 so it is stable to compare but sensitive to real geometry changes
      corners: cornerSig(markers.find((m) => wantSet.has(m.id))),
    });
  }

  return {
    adapter: adapter.name,
    dictionary: dictName,
    detectorOpts,
    summary: {
      cases: rows.length,
      expected: expectedTotal,
      truePositives: truePos,
      falsePositives: falsePos,
      recall: expectedTotal ? +(truePos / expectedTotal).toFixed(4) : null,
    },
    rows,
  };
}

function cornerSig(marker) {
  if (!marker || !marker.corners) return null;
  return marker.corners.map((p) => [round3(p.x), round3(p.y)]);
}
function round3(v) { return Math.round(v * 1000) / 1000; }

/** Diff two battery reports. Returns a list of human-readable differences. */
export function diffReports(a, b) {
  const diffs = [];
  const byCase = new Map(b.rows.map((r) => [r.case, r]));
  for (const ra of a.rows) {
    const rb = byCase.get(ra.case);
    if (!rb) { diffs.push({ case: ra.case, kind: 'missing-in-b' }); continue; }
    if (JSON.stringify(ra.got) !== JSON.stringify(rb.got)) {
      diffs.push({ case: ra.case, kind: 'ids', a: ra.got, b: rb.got });
    }
    if (JSON.stringify(ra.corners) !== JSON.stringify(rb.corners)) {
      diffs.push({ case: ra.case, kind: 'corners', a: ra.corners, b: rb.corners });
    }
    if (ra.error !== rb.error) {
      diffs.push({ case: ra.case, kind: 'error', a: ra.error, b: rb.error });
    }
  }
  return diffs;
}

/** Pretty-print a report as a fixed-width table. */
export function formatReport(rep) {
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  const lines = [];
  lines.push(`${rep.adapter} — ${rep.dictionary} ${JSON.stringify(rep.detectorOpts)}`);
  lines.push(
    pad('case', 18) + pad('want', 16) + pad('got', 22) + pad('hit', 5) + 'extra'
  );
  for (const r of rep.rows) {
    lines.push(
      pad(r.case, 18) +
      pad(JSON.stringify(r.want), 16) +
      pad(JSON.stringify(r.got).slice(0, 20), 22) +
      pad(r.hit, 5) +
      (r.extra ? `${r.extra}  <-- FALSE POSITIVE` : '0') +
      (r.error ? `  ERROR: ${r.error}` : '')
    );
  }
  const s = rep.summary;
  lines.push(
    `-- recall ${s.truePositives}/${s.expected} (${((s.recall || 0) * 100).toFixed(1)}%)` +
    `  falsePositives ${s.falsePositives}`
  );
  return lines.join('\n');
}
