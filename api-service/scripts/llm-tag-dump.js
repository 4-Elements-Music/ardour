#!/usr/bin/env node
// Dump a batch of untagged presets to stdout in a compact tagging format.
// The operator (or Claude in-conversation) pastes the output into a prompt, produces a JSON
// array of tags, then runs llm-tag-apply.js to write them back.
//
// Usage:
//   node scripts/llm-tag-dump.js [--source-type vstpreset|h2p|nki|kk_db] [--limit 50] [--plugin NAME]

import { openDb } from '../src/indexer/db.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const sourceType = args['source-type'] || null;
const pluginFilter = args.plugin || null;
const limit = parseInt(args.limit || '50', 10);

const db = openDb();
const where = ['NOT EXISTS (SELECT 1 FROM preset_tags t WHERE t.preset_id = p.id)'];
const sqlArgs = [];
if (sourceType) { where.push('p.source_type = ?'); sqlArgs.push(sourceType); }
if (pluginFilter) { where.push('p.plugin = ?'); sqlArgs.push(pluginFilter); }
const rows = db.prepare(`
  SELECT id, plugin, preset_name, bank, category, author, description
  FROM presets p
  WHERE ${where.join(' AND ')}
  ORDER BY plugin, preset_name
  LIMIT ?
`).all(...sqlArgs, limit);
db.close();

if (!rows.length) { console.error('No untagged presets match filter.'); process.exit(0); }

console.error(`# ${rows.length} presets to tag (${sourceType || 'any type'}, ${pluginFilter || 'any plugin'})`);
console.log(JSON.stringify(rows.map(r => ({
  id: r.id,
  plugin: r.plugin,
  name: r.preset_name,
  bank: r.bank || undefined,
  folder: r.category || undefined,
  author: r.author || undefined,
  desc: r.description ? r.description.slice(0, 120) : undefined,
})), null, 2));
