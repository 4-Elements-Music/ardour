#!/usr/bin/env node
// Import from NI's Komplete Kontrol SQLite (komplete.db3) into our preset index.
// KK is authoritative for NKS-tagged NI/3rd-party content (39k rows on this machine).
//
// For each KK row:
//   1. Upsert as a preset row (source_type='kk_db' when no other source exists at that path;
//      otherwise keep the existing source_type and only enrich).
//   2. Write tags: {type, character, bank, subbank}.
//
// KK source paths include .nksf, .nksn, .nki, .nabs, .nmsv, .nfm8, .ngrr, .wav, etc.
//   → so this also captures Kontakt library NKI files on external volumes we didn't scan.
//
// Safe: copies the DB to /tmp before reading to avoid locking NI's file.

import Database from 'better-sqlite3';
import { openDb, upsertPreset, addTag, refreshFts } from '../src/indexer/db.js';
import { copyFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import { homedir } from 'os';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const dry = !!args.dry;

function findKkDb() {
  const candidates = [
    join(homedir(), 'Library/Application Support/Native Instruments/Komplete Kontrol/Browser Data/komplete.db3'),
    join(homedir(), 'Library/Application Support/Native Instruments/Kontakt 8/komplete.db3'),
    join(homedir(), 'Library/Application Support/Native Instruments/Maschine 3/komplete.db3'),
  ];
  return candidates.find(existsSync) || null;
}

const src = args.db || findKkDb();
if (!src) { console.error('No komplete.db3 found. Use --db <path>'); process.exit(1); }
console.error(`source KK DB: ${src}`);

const tmpCopy = `/tmp/kk-komplete-${process.pid}.db3`;
copyFileSync(src, tmpCopy);
const kk = new Database(tmpCopy, { readonly: true });
const kkRows = kk.prepare(`
  SELECT id, name, author, brand AS vendor, product, bank, subbank, type, character, comment, file_name, file_ext
  FROM v_sound_info
`).all();
console.error(`KK rows: ${kkRows.length}`);

const db = openDb();
const pathIndex = new Map();
for (const r of db.prepare(`SELECT id, source_path, source_type FROM presets`).all()) {
  pathIndex.set(r.source_path, { id: r.id, source_type: r.source_type });
}

const insertTag = dry ? null : db.prepare('INSERT OR IGNORE INTO preset_tags (preset_id, axis, tag) VALUES (?, ?, ?)');

let enriched = 0, created = 0, unchanged = 0, totalTags = 0;
const tx = dry ? (fn) => fn() : db.transaction((fn) => fn());
tx(() => {
  for (const k of kkRows) {
    if (!k.file_name) continue;
    let presetId;
    const existing = pathIndex.get(k.file_name);
    if (existing) {
      presetId = existing.id;
      enriched++;
    } else {
      // Upsert as a new kk_db-sourced preset.
      if (!dry) {
        presetId = upsertPreset(db, {
          plugin: k.product || k.vendor || 'Unknown',
          vendor: k.vendor || null,
          preset_name: k.name || basename(k.file_name, extname(k.file_name)),
          bank: k.bank || null,
          category: null,
          author: k.author || null,
          description: k.comment || null,
          usage: null,
          source_path: k.file_name,
          source_type: 'kk_db',
          extras: { kk_id: k.id, kk_file_ext: k.file_ext },
        });
      }
      created++;
    }
    if (!dry && presetId) {
      const tagWrites = [];
      if (k.type)      for (const t of k.type.split(','))      if (t.trim()) tagWrites.push(['type', t.trim()]);
      if (k.character) for (const c of k.character.split(',')) if (c.trim()) tagWrites.push(['character', c.trim()]);
      if (k.bank)     tagWrites.push(['bank', k.bank]);
      if (k.subbank)  tagWrites.push(['subbank', k.subbank]);
      for (const [axis, tag] of tagWrites) insertTag.run(presetId, axis, tag);
      totalTags += tagWrites.length;
    }
  }
});

if (!dry) refreshFts(db);
db.close();
kk.close();

console.log(JSON.stringify({
  src, dry,
  kk_rows: kkRows.length,
  enriched_existing: enriched,
  created_new: created,
  unchanged, tag_rows_written: totalTags,
}, null, 2));
