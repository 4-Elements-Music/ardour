#!/usr/bin/env node
// Convert NKSF sidecar files to native .vstpreset files in Ardour-discoverable locations.
// Usage:
//   node scripts/convert-nksf.js --plugin Diva [--vendor u-he] [--limit 10] [--dry]
//   node scripts/convert-nksf.js --plugin Diva --target /tmp/test-out   # custom output dir
//
// Default output dir: ~/Library/Audio/Presets/<vendor>/<plugin>/NKS_Harvested/
// This isolation dir keeps our converted presets separate from factory files.

import { convertNksfFile } from '../src/indexer/nksf-to-vstpreset.js';
import { openDb } from '../src/indexer/db.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
if (!args.plugin) {
  console.error('Usage: convert-nksf.js --plugin <Plugin> [--vendor <V>] [--limit N] [--dry] [--target DIR] [--overwrite]');
  process.exit(1);
}
const pluginFilter = args.plugin;
const vendor = args.vendor || null;
const limit = args.limit ? parseInt(args.limit, 10) : 999999;
const dry = !!args.dry;
const overwrite = !!args.overwrite;

const db = openDb();
const where = ['source_type = ?', 'plugin = ?'];
const sqlArgs = ['nksf', pluginFilter];
if (vendor) { where.push('vendor = ?'); sqlArgs.push(vendor); }
const rows = db.prepare(`SELECT source_path, plugin, vendor FROM presets WHERE ${where.join(' AND ')} LIMIT ?`).all(...sqlArgs, limit);
console.error(`NKSF rows to convert: ${rows.length} (plugin=${pluginFilter}${vendor ? ` vendor=${vendor}` : ''})`);
if (!rows.length) { db.close(); process.exit(0); }

// Target dir defaults to user VST3 presets location under the plugin's vendor/name.
const vendorDir = rows[0].vendor || 'Unknown';
// Write directly into the plugin's user preset dir — Ardour's VST3 scan is NON-recursive,
// so subfolders are invisible (ref: libs/ardour/vst3_plugin.cc find_presets).
const defaultTarget = join(homedir(), 'Library/Audio/Presets', vendorDir, pluginFilter);
const targetDir = args.target || defaultTarget;
console.error(`target dir: ${targetDir}`);

let ok = 0, skipped = 0, errors = 0;
const firstErrors = [];
for (const r of rows) {
  try {
    const res = await convertNksfFile(r.source_path, targetDir, { dryRun: dry, overwrite });
    if (res.ok) { if (res.skipped) skipped++; else ok++; }
    else { errors++; if (firstErrors.length < 10) firstErrors.push({ path: r.source_path, err: res.error }); }
  } catch (e) {
    errors++;
    if (firstErrors.length < 10) firstErrors.push({ path: r.source_path, err: e.message });
  }
  if ((ok + skipped + errors) % 500 === 0) {
    console.error(`  progress: ${ok + skipped + errors}/${rows.length} (ok=${ok} skipped=${skipped} err=${errors})`);
  }
}
db.close();
console.log(JSON.stringify({ plugin: pluginFilter, total: rows.length, written: ok, skipped, errors, target: targetDir, dry, firstErrors }, null, 2));
