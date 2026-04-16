#!/usr/bin/env node
// ONE-COMMAND RESCAN.
// Run this whenever you install new plugins, update libraries, or add content.
// It is idempotent — safe to re-run anytime; unchanged rows skip writes via UNIQUE(source_path).
//
// Pipeline (each step self-contained; add --skip-<step> to skip any):
//   1. index        → filesystem scan (h2p / vstpreset / nksf / nki) → presets rows + tags
//   2. kk-import    → Komplete Kontrol SQLite → enrich + import NKS-tagged rows
//   3. nks-convert  → probe VST3 FUIDs + convert NKSF → .vstpreset files so Ardour can load them
//   4. tag-rules    → apply rule-based tags (reverbs/delays/modular) + NKI keyword inference + h2p→NKSF propagation
//
// Usage:
//   node scripts/rescan.js --sid <SESSION_ID>             # full refresh
//   node scripts/rescan.js --sid <SID> --skip-index       # skip filesystem scan
//   node scripts/rescan.js --sid <SID> --skip-nks-convert # KK/index only, no Ardour needed
//   node scripts/rescan.js --skip-nks-convert             # everything except the step that needs a session
//
// --sid is required for the nks-convert step (that step talks to a running session to probe
// VST3 plugin FUIDs). Omit it only if you --skip-nks-convert.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const sid = args.sid || null;
const skipIndex = !!args['skip-index'];
const skipKk = !!args['skip-kk-import'];
const skipNksConvert = !!args['skip-nks-convert'];
const skipTagRules = !!args['skip-tag-rules'];

if (!skipNksConvert && !sid) {
  console.error('--sid <SESSION_ID> required (or pass --skip-nks-convert).');
  process.exit(1);
}

function run(label, cmd, argv) {
  return new Promise((resolve, reject) => {
    console.error(`\n━━━ ${label} ━━━`);
    const start = Date.now();
    const child = spawn(cmd, argv, { cwd: join(__dirname, '..'), stdio: 'inherit' });
    child.on('close', (code) => {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) { console.error(`✓ ${label} (${secs}s)`); resolve(); }
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

const summary = { started: new Date().toISOString(), steps: [] };
try {
  if (!skipIndex) {
    await run('1/4 filesystem index', 'node', ['scripts/index-presets.js']);
    summary.steps.push('index');
  }
  if (!skipKk) {
    await run('2/4 Komplete Kontrol DB import', 'node', ['scripts/import-kk-tags.js']);
    summary.steps.push('kk-import');
  }
  if (!skipNksConvert) {
    await run('3/4 NKS FUID probe + .vstpreset conversion', 'node', ['scripts/refresh-nks-index.js', '--sid', sid]);
    summary.steps.push('nks-convert');
  }
  if (!skipTagRules) {
    await run('4/4 rule-based tagging + keyword inference + propagation', 'node', ['scripts/tag-by-rule.js']);
    summary.steps.push('tag-rules');
  }
  summary.finished = new Date().toISOString();
  summary.ok = true;
} catch (e) {
  summary.ok = false;
  summary.error = e.message;
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
console.log('\n' + JSON.stringify(summary, null, 2));
