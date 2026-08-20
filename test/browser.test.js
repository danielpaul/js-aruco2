/**
 * Browser integration test.
 *
 * Verifies the parts that cannot be exercised in Node: the module Worker loads,
 * the transferable-buffer protocol round-trips, and detection inside the worker
 * produces the same ids as detection on the main thread.
 *
 * Skipped automatically when Playwright or a Chromium build is unavailable.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  /* playwright not installed — tests below skip */
}
const HAVE_BROWSER = !!chromium;

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.html': 'text/html', '.json': 'application/json', '.map': 'application/json',
};


/** Draw a marker onto a 2D context from its bit grid — no SVG decode needed. */
const DRAW_MARKER = `
function drawMarker(ctx, bits, grid, x, y, size) {
  const ring = grid + 2;
  const cell = size / ring;
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#fff';
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      if (bits[r * grid + c]) {
        ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, cell, cell);
      }
    }
  }
}
`;

let server, browser, origin;

before(async () => {
  if (!HAVE_BROWSER) return;
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        // COOP/COEP so SharedArrayBuffer would be available if we wanted it
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  // The preinstalled Chromium may not match the playwright build this project
  // resolves, so prefer an explicit executable when one is present.
  const { globSync } = await import('node:fs');
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...(existsSync('/opt/pw-browsers')
      ? globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome')
      : []),
  ].filter(Boolean);
  const launchOpts = { args: ['--no-sandbox'] };
  browser = candidates.length
    ? await chromium.launch({ ...launchOpts, executablePath: candidates[0] })
    : await chromium.launch(launchOpts);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

test('the library loads and detects in a real browser', { skip: !HAVE_BROWSER }, async () => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${origin}/test/fixtures/blank.html`);

  const result = await page.evaluate(async ({ base, draw }) => {
    const { Detector, Dictionary } = await import(`${base}/src/index.js`);
    const def = (await import(`${base}/src/dictionaries/dict-5x5-50.js`)).default;
    const dict = new Dictionary(def);
    const det = new Detector({ dictionary: dict });

    eval(draw);
    const canvas = new OffscreenCanvas(480, 360);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#bbb';
    ctx.fillRect(0, 0, 480, 360);
    ctx.fillStyle = '#fff';
    ctx.fillRect(130, 70, 200, 200);           // quiet zone
    drawMarker(ctx, dict.bitsFor(7), dict.gridSize, 150, 90, 160);
    const imageData = ctx.getImageData(0, 0, 480, 360);

    const markers = det.detect(imageData);
    return { ids: markers.map((m) => m.id), name: dict.name, corners: markers[0]?.corners?.length };
  }, { base: origin, draw: DRAW_MARKER });

  assert.equal(result.name, 'DICT_5X5_50');
  assert.deepEqual(result.ids, [7]);
  assert.equal(result.corners, 4);
  await page.close();
});

test('the module worker round-trips a transferred frame', { skip: !HAVE_BROWSER }, async () => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${origin}/test/fixtures/blank.html`);

  const result = await page.evaluate(async ({ base, draw }) => {
    const { Dictionary } = await import(`${base}/src/index.js`);
    const def = (await import(`${base}/src/dictionaries/dict-5x5-50.js`)).default;
    const dict = new Dictionary(def);

    eval(draw);
    const canvas = new OffscreenCanvas(480, 360);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#bbb';
    ctx.fillRect(0, 0, 480, 360);
    ctx.fillStyle = '#fff';
    ctx.fillRect(130, 70, 200, 200);
    drawMarker(ctx, dict.bitsFor(12), dict.gridSize, 150, 90, 160);
    const imageData = ctx.getImageData(0, 0, 480, 360);

    const worker = new Worker(`${base}/src/worker/detector.worker.js`, { type: 'module' });
    const waitFor = (type) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 15000);
      worker.addEventListener('message', function onMsg(e) {
        if (e.data.type === 'error') {
          clearTimeout(t); worker.removeEventListener('message', onMsg);
          reject(new Error(e.data.name + ': ' + e.data.message));
        } else if (e.data.type === type) {
          clearTimeout(t); worker.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      });
      worker.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message)); });
    });

    worker.postMessage({ type: 'init', id: 1, dictionary: 'DICT_5X5_50' });
    const ready = await waitFor('ready');

    const buf = imageData.data.buffer;
    const byteLengthBefore = buf.byteLength;
    worker.postMessage(
      { type: 'detect', id: 2, width: 480, height: 360, data: buf },
      [buf]
    );
    const detached = buf.byteLength === 0;
    const res = await waitFor('markers');
    worker.terminate();

    return {
      dictionary: ready.dictionary,
      maxCorrectionBits: ready.maxCorrectionBits,
      maxHammingDistance: ready.maxHammingDistance,
      ids: res.markers.map((m) => m.id),
      stats: res.stats,
      detached,
      byteLengthBefore,
      returnedBytes: res.data.byteLength,
    };
  }, { base: origin, draw: DRAW_MARKER });

  assert.equal(result.dictionary, 'DICT_5X5_50');
  // the dictionary's intrinsic bound and the bound this detector applies are
  // reported under distinct names, so an option override is visible to callers
  assert.equal(result.maxCorrectionBits, 3);
  assert.equal(result.maxHammingDistance, 3);
  assert.deepEqual(result.ids, [12]);
  assert.equal(result.detached, true, 'the frame buffer should be transferred, not copied');
  assert.equal(result.returnedBytes, result.byteLengthBefore, 'the buffer comes back for reuse');
  assert.ok(result.stats.contours > 0);
  await page.close();
});

test('worker errors surface as structured messages, not silent failures', { skip: !HAVE_BROWSER }, async () => {
  const page = await browser.newPage();
  await page.goto(`${origin}/test/fixtures/blank.html`);
  const result = await page.evaluate(async (base) => {
    const worker = new Worker(`${base}/src/worker/detector.worker.js`, { type: 'module' });
    const err = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 15000);
      worker.addEventListener('message', (e) => {
        if (e.data.type === 'error') { clearTimeout(t); resolve(e.data); }
      });
      worker.postMessage({ type: 'init', id: 1, dictionary: 'NOT_A_DICTIONARY' });
    });
    worker.terminate();
    return err;
  }, origin).catch((e) => ({ type: 'error', name: 'TestHarness', message: String(e) }));

  assert.equal(result.type, 'error');
  assert.match(result.message, /NOT_A_DICTIONARY|Unknown dictionary/);
  await page.close();
});
