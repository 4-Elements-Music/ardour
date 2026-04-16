#!/usr/bin/env node
// Bulk-resolve factory preset URIs for a plugin that's already loaded on a track.
// For each harvested preset in our index that belongs to the given plugin AND has no
// captured URI yet, asks Ardour to resolve it via Plugin:preset_by_label. Writes any
// successful resolutions to the captured_uris table so preset/load can recall them.
//
// Usage:
//   node scripts/bulk-resolve.js --sid <SESSION_ID> --track <TRACK> [--plugin <NAME>] [--limit N] [--dry]
//
// If --plugin is omitted, the plugin currently loaded on the track is used.

import { openDb, recordCapture } from '../src/indexer/db.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
if (!args.sid || !args.track) {
  console.error('Usage: bulk-resolve.js --sid <id> --track <name> [--plugin <name>] [--limit N] [--dry] [--host http://localhost:3000]');
  process.exit(1);
}
const host = args.host || 'http://localhost:3000';
const limit = args.limit ? parseInt(args.limit, 10) : 500;
const dry = !!args.dry;

async function lua(code) {
  const res = await fetch(`${host}/v1/sessions/${args.sid}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'session/lua_eval', params: { code } }),
  });
  const body = await res.json();
  const text = body?.content?.[0]?.text;
  if (!text) throw new Error(`lua_eval: no content (status ${res.status})`);
  // Tolerant parse for C++ inner-JSON bug.
  const fixed = String(text).replace(/[\x00-\x1f]/g, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const inner = JSON.parse(fixed);
  if (!inner.success) throw new Error(inner.error || 'lua error');
  return inner.output || '';
}
const kv = (out) => Object.fromEntries(out.split('\n').map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]).filter(([k]) => k));

// 1. Identify plugin on track + its unique_id + type.
const ident = await lua(`
local r=nil
for x in Session:get_routes():iter() do if x:name()==${JSON.stringify(args.track)} then r=x; break end end
if not r then print("ERR no_route") return end
local p=r:nth_plugin(0); if not p or p:isnil() then print("ERR no_plugin") return end
local pl=p:to_insert():plugin(0); local info=pl:get_info()
print("plugin="..pl:name())
print("unique_id="..info.unique_id)
print("type="..tostring(info.type))
`);
if (ident.startsWith('ERR ')) { console.error('plugin-ident failed:', ident); process.exit(1); }
const meta = kv(ident);
const pluginName = args.plugin || meta.plugin;
const pluginUid = meta.unique_id;
const pluginType = parseInt(meta.type, 10);
console.error(`plugin on track "${args.track}": ${pluginName} uid=${pluginUid} type=${pluginType}`);

// 2. Query DB for harvested presets of this plugin with no captured URI.
const db = openDb();
const rows = db.prepare(`
  SELECT p.id, p.plugin, p.preset_name, p.source_type
  FROM presets p
  LEFT JOIN captured_uris c ON c.plugin = p.plugin AND c.preset_name = p.preset_name
  WHERE p.plugin = ? AND c.id IS NULL
  LIMIT ?
`).all(pluginName, limit);
console.error(`candidates: ${rows.length} harvested presets for ${pluginName} with no URI yet`);
if (!rows.length) { db.close(); process.exit(0); }

// 3. For each candidate, ask Ardour to resolve via preset_by_label.
const BATCH = 50;
let resolved = 0, skipped = 0, errors = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const script = `
local r=nil
for x in Session:get_routes():iter() do if x:name()==${JSON.stringify(args.track)} then r=x; break end end
local pl=r:nth_plugin(0):to_insert():plugin(0)
local names = {${batch.map(b => JSON.stringify(b.preset_name)).join(',')}}
for _,nm in ipairs(names) do
  local rec = pl:preset_by_label(nm)
  if rec and rec.valid then print("OK\\t"..nm.."\\t"..rec.uri)
  else print("NO\\t"..nm) end
end
`.trim();
  let out;
  try { out = await lua(script); }
  catch (e) { errors += batch.length; console.error(`batch error ${i}/${rows.length}: ${e.message}`); continue; }
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts[0] === 'OK') {
      resolved++;
      if (!dry) recordCapture(db, {
        plugin: pluginName,
        preset_name: parts[1],
        ardour_uri: parts[2],
        ardour_label: parts[1],
        plugin_uid: pluginUid,
        plugin_type: pluginType,
        notes: 'bulk-resolve',
      });
    } else if (parts[0] === 'NO') {
      skipped++;
    }
  }
  if ((i + batch.length) % 200 === 0 || i + batch.length === rows.length) {
    console.error(`  progress: ${i + batch.length}/${rows.length} (resolved=${resolved} skipped=${skipped} err=${errors})`);
  }
}
db.close();
console.log(JSON.stringify({ plugin: pluginName, candidates: rows.length, resolved, skipped, errors, dry }, null, 2));
