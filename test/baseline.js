/**
 * Capture or compare the golden baseline.
 *
 *   node test/baseline.js capture   # write test/fixtures/legacy-*.json
 *   node test/baseline.js compare   # diff the current library against them
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
} else {
  const ad = await nextAdapter(SUITES.map((s) => s.dict));
  let anyDiff = false;
  for (const s of SUITES) {
    const path = join(FIX, `legacy-${s.dict}.json`);
    if (!existsSync(path)) { console.log(`(no baseline for ${s.dict})`); continue; }
    const base = JSON.parse(readFileSync(path, 'utf8'));
    const rep = runBattery(ad, s.dict, s.ids);
    const diffs = diffReports(base, rep);
    console.log(`${s.dict}: legacy recall ${(base.summary.recall * 100).toFixed(1)}% / FP ${base.summary.falsePositives}` +
      `   ->   next recall ${(rep.summary.recall * 100).toFixed(1)}% / FP ${rep.summary.falsePositives}`);
    for (const d of diffs) {
      anyDiff = true;
      if (d.kind === 'ids') console.log(`   ${d.case}: ids ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`);
      else if (d.kind === 'error') console.log(`   ${d.case}: error ${d.a} -> ${d.b}`);
    }
  }
  if (!anyDiff) console.log('\nno id-level differences from baseline');
}
