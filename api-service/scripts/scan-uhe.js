#!/usr/bin/env node
// Scan u-he preset directories and print a JSON report + per-category counts.
// Usage: node scripts/scan-uhe.js [root1] [root2] ...
// Default roots:
//   /Library/Audio/Presets/u-he   (system-installed factory content)
//   ~/Library/Audio/Presets/u-he  (per-user content)

import { scanUheRoot } from '../src/indexer/h2p.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const defaultRoots = [
  '/Library/Audio/Presets/u-he',
  join(homedir(), 'Library/Audio/Presets/u-he'),
];
const args = process.argv.slice(2);
const roots = (args.length ? args : defaultRoots).filter(r => existsSync(r));

if (!roots.length) {
  console.error('No u-he root dirs found. Tried:', defaultRoots.join(', '));
  process.exit(1);
}

const all = [];
for (const root of roots) {
  process.stderr.write(`scanning ${root} ...\n`);
  const rows = await scanUheRoot(root);
  process.stderr.write(`  ${rows.length} presets\n`);
  all.push(...rows);
}

const byPlugin = {};
const byCategory = {};
const errors = [];
for (const r of all) {
  if (r.error) { errors.push(r); continue; }
  byPlugin[r.plugin] = (byPlugin[r.plugin] || 0) + 1;
  const key = `${r.plugin}::${r.category || '(none)'}`;
  byCategory[key] = (byCategory[key] || 0) + 1;
}

console.log(JSON.stringify({
  total: all.length,
  errors: errors.length,
  byPlugin,
  byCategory,
  sample: all.filter(r => !r.error).slice(0, 3),
  firstErrors: errors.slice(0, 3),
}, null, 2));
