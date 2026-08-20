import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Posit } from '../src/posit.js';
import { svdcmp } from '../src/svd.js';

/** Project a marker of `size` mm at distance Z, tilted about X, onto a focal-length-f camera. */
function project({ size = 35, Z = 500, focal = 640, tiltDeg = 0, rollDeg = 0 }) {
  const half = size / 2;
  const t = (tiltDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
  const ct = Math.cos(t), st = Math.sin(t), cr = Math.cos(r), sr = Math.sin(r);
  const model = [[-half, half, 0], [half, half, 0], [half, -half, 0], [-half, -half, 0]];
  return model.map(([X, Y, Zc]) => {
    const x1 = cr * X - sr * Y, y1 = sr * X + cr * Y;
    const y2 = ct * y1 - st * Zc, z2 = st * y1 + ct * Zc + Z;
    return { x: (focal * x1) / z2, y: (focal * y2) / z2 };
  });
}

test('recovers depth from exact corners', () => {
  const posit = new Posit(35, 640);
  for (const Z of [300, 500, 900]) {
    const pose = posit.pose(project({ Z }));
    assert.ok(Math.abs(pose.bestTranslation[2] - Z) / Z < 0.02,
      `Z=${Z} recovered as ${pose.bestTranslation[2].toFixed(1)}`);
  }
});

test('bestError is a sub-pixel float, not a rounded integer', () => {
  // The pre-3.0 convergence test compared ROUNDED pixel coordinates and halted
  // as soon as the reprojection rounded to the same pixel, so bestError was an
  // integer that read 0 for poses up to 35 degrees wrong.
  const posit = new Posit(35, 640);
  let sawFractional = false;
  let zeroWithBadPose = 0;
  let checked = 0;

  for (const tiltDeg of [0, 5, 10, 18, 25, 35, 45]) {
    for (const Z of [300, 450, 700]) {
      const pose = posit.pose(project({ Z, tiltDeg }));
      checked++;
      assert.equal(typeof pose.bestError, 'number');
      assert.ok(Number.isFinite(pose.bestError), 'bestError must be finite');
      assert.ok(pose.bestError >= 0);
      if (!Number.isInteger(pose.bestError)) sawFractional = true;
      // a reported error of 0 must actually mean a good pose
      if (pose.bestError === 0) {
        const zErr = Math.abs(pose.bestTranslation[2] - Z) / Z;
        if (zErr > 0.05) zeroWithBadPose++;
      }
    }
  }
  assert.ok(checked > 0);
  assert.ok(sawFractional, 'at least one pose should report a fractional residual');
  assert.equal(zeroWithBadPose, 0, 'bestError === 0 must not accompany a badly wrong pose');
});

test('pose exposes both branches and the legacy integer residual', () => {
  const posit = new Posit(35, 640);
  const pose = posit.pose(project({ tiltDeg: 20 }));
  for (const k of ['bestError', 'bestRotation', 'bestTranslation',
    'alternativeError', 'alternativeRotation', 'alternativeTranslation',
    'bestMaxError', 'bestPixelError']) {
    assert.ok(k in pose, `pose.${k}`);
  }
  assert.equal(pose.bestRotation.length, 3);
  assert.equal(pose.bestTranslation.length, 3);
  assert.ok(pose.bestError <= pose.alternativeError,
    'the reported best branch must be the lower-error one');
});

test('a larger corner perturbation produces a larger reported error', () => {
  const posit = new Posit(35, 640);
  const exact = project({ tiltDeg: 25, Z: 400 });
  const jitter = (px) => exact.map((p, i) => ({
    x: p.x + (i % 2 ? px : -px),
    y: p.y + (i < 2 ? px : -px),
  }));
  const clean = posit.pose(exact).bestError;
  const noisy = posit.pose(jitter(2)).bestError;
  assert.ok(noisy > clean, `error should grow with corner noise (${clean} -> ${noisy})`);
});

test('svdcmp survives the inputs that used to throw', () => {
  // svd.js:184 carried an unconverted 1-based loop that indexed a[m] and threw
  // TypeError on ~9.7% of realistic inputs.
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  let worst = 0;
  for (let t = 0; t < 5000; t++) {
    const m = 3 + (t % 6), n = 3;
    const a = [];
    for (let i = 0; i < m; i++) { a.push([]); for (let j = 0; j < n; j++) a[i].push(rnd()); }
    // drive the QR-cancellation branch with near-singular and duplicated columns
    if (t % 3 === 0) for (let i = 0; i < m; i++) a[i][2] = a[i][0] * 1e-9;
    if (t % 5 === 0) for (let i = 0; i < m; i++) a[i][1] = a[i][0];
    const orig = a.map((r) => r.slice());
    const w = [], v = [[], [], []];
    const ok = svdcmp(a, m, n, w, v);
    if (ok === false) continue;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += a[i][k] * w[k] * v[j][k];
        worst = Math.max(worst, Math.abs(acc - orig[i][j]));
      }
    }
  }
  assert.ok(worst < 1e-12, `reconstruction error ${worst.toExponential(2)} should stay at machine precision`);
});
