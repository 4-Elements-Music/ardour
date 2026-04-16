#!/usr/bin/env node
// Read tag-assignment JSON (from stdin or a file) and write to preset_tags.
// Expected input shape:
//   [{"id": 67040, "type": "Strings", "subtype": "Sampled", "modes": ["Cinematic", "Warm"]}, ...]
// Or:
//   [{"id": 67040, "unknown": true}, ...]
//
// Usage:
//   node scripts/llm-tag-apply.js < tags.json
//   echo '[...]' | node scripts/llm-tag-apply.js

import { openDb, addTag, refreshFts } from '../src/indexer/db.js';
import { readFileSync } from 'fs';

const input = (process.argv[2] && process.argv[2] !== '-')
  ? readFileSync(process.argv[2], 'utf8')
  : readFileSync(0, 'utf8');

let data;
try {
  data = JSON.parse(input);
  if (!Array.isArray(data)) throw new Error('expected JSON array');
} catch (e) {
  console.error(`parse error: ${e.message}`);
  console.error('input head:', input.slice(0, 200));
  process.exit(1);
}

const db = openDb();
let tagged = 0, unknowns = 0, skipped = 0, tagsWritten = 0;
for (const row of data) {
  if (!row || typeof row.id !== 'number') { skipped++; continue; }
  if (row.unknown) { unknowns++; continue; }
  if (row.type)    { addTag(db, row.id, 'type', String(row.type));   tagsWritten++; }
  if (row.subtype) { addTag(db, row.id, 'subtype', String(row.subtype)); tagsWritten++; }
  if (Array.isArray(row.modes)) {
    for (const m of row.modes.slice(0, 6)) { addTag(db, row.id, 'mode', String(m)); tagsWritten++; }
  }
  if (Array.isArray(row.characters)) {
    for (const c of row.characters.slice(0, 6)) { addTag(db, row.id, 'character', String(c)); tagsWritten++; }
  }
  tagged++;
}
refreshFts(db);
db.close();
console.log(JSON.stringify({ tagged, unknowns, skipped, tag_rows_written: tagsWritten }, null, 2));
