/**
 * Capture or compare the golden baseline.
 *
 *   node test/baseline.js capture        # write test/fixtures/legacy-*.json (2.x)
 *   node test/baseline.js capture-next   # write test/fixtures/next-*.json (3.x)
 *   node test/baseline.js compare        # gate: fail on any drift from next-*.json
 *
 * `compare` is a GATE, not a report. It exits non-zero when the current library
 * differs from the recorded 3.x expectation in recall, false positives, or any
 * per-case id list, and when a fixture is missing entirely — otherwise a
 * regression would sail through CI as a log line nobody reads.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runBattery, diffReports, formatReport } from './harness.js';
import { legacyAdapter, nextAdapter } from './adapters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures');

const SUITES = [
  { dict: 'ARUCO_MIP_36h12', ids: [0, 1, 2, 3] },
  { dict: 'ARUCO', ids: [0, 7, 42, 99] },
  { dict: 'ARUCO_5X5_1000', ids: [0, 1, 2, 3] },
  { dict: 'CHILITAGS', ids: [0, 1, 2, 3] },
  { dict: 'ARUCO_7X7_1000', ids: [0, 1, 2, 3] },
];

const mode = process.argv[2] || 'compare';

if (mode === 'capture') {
  mkdirSync(FIX, { recursive: true });
  const ad = legacyAdapter();
  if (!ad) { console.error('legacy/ not present — nothing to capture'); process.exit(1); }
  for (const s of SUITES) {
    const rep = runBattery(ad, s.dict, s.ids);
    writeFileSync(join(FIX, `legacy-${s.dict}.json`), JSON.stringify(rep, null, 1));
    console.log(formatReport(rep));
    console.log();
  }
  console.log(`captured ${SUITES.length} baselines into test/fixtures/`);
} else if (mode === 'capture-next') {
  mkdirSync(FIX, { recursive: true });
  const ad = await nextAdapter(SUITES.map((s) => s.dict));
  for (const s of SUITES) {
    const rep = runBattery(ad, s.dict, s.ids);
    writeFileSync(join(FIX, `next-${s.dict}.json`), JSON.stringify(rep, null, 1));
    console.log(formatReport(rep));
    console.log();
  }
  console.log(`captured ${SUITES.length} 3.x expectations into test/fixtures/`);
} else {
  const ad = await nextAdapter(SUITES.map((s) => s.dict));
  const failures = [];

  for (const s of SUITES) {
    const rep = runBattery(ad, s.dict, s.ids);
    const legacyPath = join(FIX, `legacy-${s.dict}.json`);
    const nextPath = join(FIX, `next-${s.dict}.json`);

    if (existsSync(legacyPath)) {
      const base = JSON.parse(readFileSync(legacyPath, 'utf8'));
      console.log(
        `${s.dict}: legacy recall ${(base.summary.recall * 100).toFixed(1)}% / FP ${base.summary.falsePositives}` +
        `   ->   next recall ${(rep.summary.recall * 100).toFixed(1)}% / FP ${rep.summary.falsePositives}`
      );
    } else {
      console.log(`${s.dict}: recall ${(rep.summary.recall * 100).toFixed(1)}% / FP ${rep.summary.falsePositives} (no 2.x baseline)`);
    }

    if (!existsSync(nextPath)) {
      failures.push(`${s.dict}: no recorded 3.x expectation (run \`node test/baseline.js capture-next\`)`);
      continue;
    }
    const expected = JSON.parse(readFileSync(nextPath, 'utf8'));

    if (rep.summary.recall < expected.summary.recall) {
      failures.push(
        `${s.dict}: recall regressed ${(expected.summary.recall * 100).toFixed(1)}% -> ` +
        `${(rep.summary.recall * 100).toFixed(1)}%`
      );
    }
    if (rep.summary.falsePositives > expected.summary.falsePositives) {
      failures.push(
        `${s.dict}: false positives rose ${expected.summary.falsePositives} -> ${rep.summary.falsePositives}`
      );
    }
    for (const d of diffReports(expected, rep)) {
      const detail = d.kind === 'ids'
        ? `ids ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`
        : `error ${d.a} -> ${d.b}`;
      failures.push(`${s.dict} ${d.case}: ${detail}`);
    }
  }

  if (failures.length) {
    console.error(`\ngolden gate FAILED — ${failures.length} difference(s) from the recorded 3.x expectation:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('\nIf a change is intended, re-record with: node test/baseline.js capture-next');
    process.exit(1);
  }
  console.log(`\ngolden gate passed — ${SUITES.length} suites match their recorded 3.x expectation`);
}
