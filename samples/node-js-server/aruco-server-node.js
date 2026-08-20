/**
 * Detect markers from an ffmpeg rawvideo stream.
 *
 *   npm install && npm run server
 *   npm run stream_unix     (or stream_win / stream_osx)
 *
 * Differences from the pre-3.0 sample, all from the security review:
 *   - the shared secret is a header/bearer token read from the environment,
 *     not a path segment that lands in access logs and browser history;
 *   - the debug snapshot endpoint requires the same token, and is off unless
 *     ARUCO_DEBUG_SNAPSHOT=1;
 *   - the snapshot is written atomically, so a reader never sees a half-written
 *     file, and it is served from memory rather than a blocking readFileSync;
 *   - one StreamDecoder per connection, so two clients cannot interleave
 *     frames into one buffer.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

import { Detector, Dictionary, StreamDecoder } from '../../src/index.js';
import { loadDictionaryDefinition } from '../../src/dictionaries/index.js';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const cfg = pkg.config ?? {};

const PORT = Number(process.env.PORT ?? cfg.port ?? 8081);
const TOKEN = process.env.ARUCO_TOKEN ?? '';
const WIDTH = Number(process.env.CAMERA_WIDTH ?? cfg.cameraWidth ?? 640);
const HEIGHT = Number(process.env.CAMERA_HEIGHT ?? cfg.cameraHeight ?? 480);
const DICT = process.env.ARUCO_DICTIONARY ?? cfg.dictionaryName ?? 'DICT_5X5_50';
const SNAPSHOTS = process.env.ARUCO_DEBUG_SNAPSHOT === '1';

if (!TOKEN) {
  console.error('Set ARUCO_TOKEN to a random string before starting; refusing to listen without one.');
  process.exit(1);
}

const dictionary = new Dictionary(await loadDictionaryDefinition(DICT));
if (dictionary.warnings.length) console.warn(`${DICT}:`, dictionary.warnings);

/** One detector for the process; requests are serialised by the event loop anyway. */
const detector = new Detector({ dictionary });

/** Most recent frame, kept in memory for the debug endpoint. */
let snapshot = null;

function authorised(req) {
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided.padEnd(TOKEN.length).slice(0, TOKEN.length));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b) && provided.length === TOKEN.length;
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (!authorised(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end('unauthorised\n');
    return;
  }

  if (pathname === '/stream' && req.method === 'POST') {
    req.socket.setTimeout(0);
    console.log('stream connected:', req.socket.remoteAddress);

    // per-connection decoder: a shared one would splice two clients' frames
    const decoder = new StreamDecoder({
      width: WIDTH,
      height: HEIGHT,
      onFrame(frame) {
        const markers = detector.detect(frame);
        if (SNAPSHOTS) snapshot = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
        if (markers.length) {
          console.log(new Date().toISOString(), markers.map((m) => ({ id: m.id, h: m.hammingDistance })));
        }
      },
    });

    req.on('data', (chunk) => {
      try {
        decoder.push(chunk);
      } catch (err) {
        console.error('decode failed:', err.message);
        decoder.resync();
      }
    });
    req.on('end', () => {
      console.log(`stream disconnected after ${decoder.frames} frames (${decoder.dropped} bytes dropped)`);
      res.writeHead(200).end('ok\n');
    });
    req.on('error', (err) => console.error('stream error:', err.message));
    return;
  }

  if (pathname === '/snapshot.json' && SNAPSHOTS) {
    if (!snapshot) { res.writeHead(404).end('no frame yet\n'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ width: snapshot.width, height: snapshot.height }));
    return;
  }

  res.writeHead(404).end('not found\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`Dictionary ${dictionary.name}, ${dictionary.length} ids, ` +
    `corrects up to ${detector.maxHammingDistance} bit error(s)`);
  console.log(`POST raw ${WIDTH}x${HEIGHT} RGBA to /stream with "Authorization: Bearer $ARUCO_TOKEN"`);
});
