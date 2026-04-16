#!/usr/bin/env node
// Harvest presets from known metadata sources and ingest into the SQLite index.
// Usage:
//   node scripts/index-presets.js              # scan all known locations, write DB
//   node scripts/index-presets.js --dry        # scan but don't write
//   node scripts/index-presets.js --db PATH    # override DB path
//   node scripts/index-presets.js --source uhe # only a specific source

import { scanUheRoot } from '../src/indexer/h2p.js';
import { scanVstpresetRoot } from '../src/indexer/vstpreset.js';
import { scanNksfRoot } from '../src/indexer/nksf.js';
import { scanKontaktRoot } from '../src/indexer/nki.js';
import { openDb, upsertPreset, addTag, refreshFts, DEFAULT_DB_PATH } from '../src/indexer/db.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
let dry = false;
let dbPath = DEFAULT_DB_PATH;
let onlySource = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry') dry = true;
  else if (args[i] === '--db') { dbPath = args[++i]; }
  else if (args[i] === '--source') { onlySource = args[++i]; }
}

const UHE_ROOTS = [
  '/Library/Audio/Presets/u-he',
  join(homedir(), 'Library/Audio/Presets/u-he'),
].filter(existsSync);

async function sourceUhe() {
  const all = [];
  for (const root of UHE_ROOTS) {
    process.stderr.write(`[u-he] scanning ${root}\n`);
    const rows = await scanUheRoot(root);
    all.push(...rows);
  }
  return all;
}

const VSTPRESET_ROOTS = [
  '/Library/Audio/Presets',
  join(homedir(), 'Library/Audio/Presets'),
].filter(existsSync);

async function sourceVstpreset() {
  const all = [];
  for (const root of VSTPRESET_ROOTS) {
    process.stderr.write(`[vstpreset] scanning ${root}\n`);
    const rows = await scanVstpresetRoot(root);
    all.push(...rows);
  }
  return all;
}

// NKSF files live under many roots. We use `mdfind` on macOS to discover them (fast, indexed)
// and fall back to a curated list of known roots if Spotlight is unavailable.
const NKSF_FALLBACK_ROOTS = [
  '/Library/Application Support/Native Instruments',
  '/Library/Application Support/u-he',
  '/Library/Arturia',
  '/Applications/Waves',
  join(homedir(), 'Library/Application Support/Native Instruments'),
  join(homedir(), 'Documents/Native Instruments'),
].filter(existsSync);

// External/removable volume roots likely to hold NKSF that Spotlight skips.
// KEEP NARROW — must not include big sample-library trees. The scanner does a full
// recursive walk, which is pathologically slow against /Volumes/KONTAKT2 root.
const EXTRA_NKSF_ROOTS = [
  '/Volumes/MacStudio WorkDrive/VSL NKS',
].filter(existsSync);

async function sourceNksf() {
  // Try mdfind for fast indexed discovery, fall back to directory walking.
  const { execFileSync } = await import('child_process');
  let roots = [];
  try {
    const out = execFileSync('mdfind', ['-onlyin', '/', "kMDItemFSName == '*.nksf'"], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const files = out.split('\n').filter(Boolean);
    // Group by parent dirs to report progress, then fall through to directory walk for each top-level root.
    const rootSet = new Set();
    for (const f of files) {
      // Take the first 4 path segments as a "root" for grouping.
      const segs = f.split('/');
      rootSet.add('/' + segs.slice(1, 5).join('/'));
    }
    roots = [...rootSet].filter(existsSync);
    process.stderr.write(`[nksf] spotlight found ${files.length} .nksf files under ${roots.length} roots\n`);
  } catch (e) {
    process.stderr.write(`[nksf] mdfind failed (${e.message}), using fallback roots\n`);
    roots = NKSF_FALLBACK_ROOTS;
  }
  // Always union the external/removable roots — Spotlight often skips them.
  for (const extra of EXTRA_NKSF_ROOTS) if (!roots.includes(extra)) roots.push(extra);
  const all = [];
  for (const root of roots) {
    process.stderr.write(`[nksf] scanning ${root}\n`);
    const rows = await scanNksfRoot(root);
    process.stderr.write(`  ${rows.length} rows\n`);
    all.push(...rows);
  }
  return all;
}

// Kontakt library roots — user can override with KONTAKT_ROOTS env var (colon-separated)
// or --kontakt-roots A,B,C.  We walk each recursively looking for .nki/.nkm/.nkr/.nkb files.
const KONTAKT_ROOTS = (() => {
  const envVar = process.env.KONTAKT_ROOTS;
  if (envVar) return envVar.split(':').filter(Boolean);
  const idx = process.argv.indexOf('--kontakt-roots');
  if (idx > -1 && process.argv[idx + 1]) return process.argv[idx + 1].split(',');
  return [
    '/Volumes/KONTAKT2/KONTAKT USER LIBRARY',
    '/Volumes/MacStudio WorkDrive/Kontakt',
    join(homedir(), 'Documents/Native Instruments/User Content'),
  ].filter(existsSync);
})();

async function sourceKontakt() {
  const all = [];
  for (const root of KONTAKT_ROOTS) {
    process.stderr.write(`[kontakt] scanning ${root}\n`);
    const rows = await scanKontaktRoot(root);
    process.stderr.write(`  ${rows.length} .nki/.nkm/.nkr/.nkb rows\n`);
    all.push(...rows);
  }
  return all;
}

const sources = {
  uhe: sourceUhe,
  vstpreset: sourceVstpreset,
  nksf: sourceNksf,
  kontakt: sourceKontakt,
};

const runList = onlySource ? [onlySource] : Object.keys(sources);
const db = dry ? null : openDb(dbPath);

let totalScanned = 0;
let totalWritten = 0;
const byPlugin = {};
const errors = [];

for (const name of runList) {
  const fn = sources[name];
  if (!fn) { process.stderr.write(`unknown source: ${name}\n`); continue; }
  const rows = await fn();
  totalScanned += rows.length;
  for (const r of rows) {
    if (r.error) { errors.push(r); continue; }
    byPlugin[r.plugin] = (byPlugin[r.plugin] || 0) + 1;
    if (db) {
      try {
        const presetId = upsertPreset(db, r);
        totalWritten++;
        if (r._tags) {
          for (const axis of Object.keys(r._tags)) {
            for (const tag of r._tags[axis] || []) addTag(db, presetId, axis, tag);
          }
        }
      } catch (e) {
        errors.push({ source_path: r.source_path, error: String(e.message || e) });
      }
    }
  }
}

if (db) {
  process.stderr.write(`[fts] rebuilding...\n`);
  refreshFts(db);
  db.close();
}

console.log(JSON.stringify({
  dry,
  db: dry ? null : dbPath,
  sources_run: runList,
  total_scanned: totalScanned,
  total_written: totalWritten,
  errors: errors.length,
  byPlugin,
  firstErrors: errors.slice(0, 5),
}, null, 2));
