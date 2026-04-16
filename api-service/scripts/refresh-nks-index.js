#!/usr/bin/env node
// Run this whenever new NKS plugins are installed.
//
// For every plugin that appears in the preset index (source_type=nksf):
//   1. If we don't yet know its VST3 FUID, try to instantiate it in the given session to discover.
//   2. Run nksf→.vstpreset conversion for all of its NKSF presets.
//
// Requires a running api-service and a READY session (pass its id via --sid).
//
// Usage:
//   node scripts/refresh-nks-index.js --sid <SESSION_ID> [--plugin NAME] [--host http://localhost:3000] [--dry]
//
// Add --plugin to scope to a single plugin; default processes every distinct plugin in the DB.

import { openDb } from '../src/indexer/db.js';
import { loadKnownFuids, saveKnownFuids, convertNksfFile } from '../src/indexer/nksf-to-vstpreset.js';
import { homedir } from 'os';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
if (!args.sid) {
  console.error('Usage: refresh-nks-index.js --sid <SESSION_ID> [--plugin NAME] [--host URL] [--dry]');
  process.exit(1);
}
const host = args.host || 'http://localhost:3000';
const onlyPlugin = args.plugin || null;
const dry = !!args.dry;
// Ardour PluginType enum (libs/ardour/ardour/plugin_types.h): AudioUnit=0, …, VST3=7.
const TYPE_VST3 = 7;
const TYPE_AU = 0;

async function lua(code) {
  const res = await fetch(`${host}/v1/sessions/${args.sid}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'session/lua_eval', params: { code } }),
  });
  const body = await res.json();
  const text = body?.content?.[0]?.text;
  if (!text) throw new Error(`lua_eval: no content (status ${res.status})`);
  const fixed = String(text).replace(/[\x00-\x1f]/g, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const inner = JSON.parse(fixed);
  if (!inner.success) throw new Error(inner.error || 'lua error');
  return inner.output || '';
}
const parseKv = (s) => Object.fromEntries(s.split('\n').map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]).filter(([k]) => k));

// ---- discover plugins in the index + current FUID state ----
const db = openDb();
const pluginRows = db.prepare(`
  SELECT plugin, vendor, COUNT(*) AS n
  FROM presets
  WHERE source_type = 'nksf'${onlyPlugin ? ' AND plugin = ?' : ''}
  GROUP BY plugin, vendor
  ORDER BY n DESC
`).all(...(onlyPlugin ? [onlyPlugin] : []));
db.close();
if (!pluginRows.length) { console.error('no NKSF plugins found in index'); process.exit(0); }
console.error(`NKSF plugins in index: ${pluginRows.length}`);
for (const r of pluginRows) console.error(`  ${r.plugin.padEnd(40)} ${r.n} presets  (${r.vendor || '?'})`);

// ---- ensure FUID for each ----
let fuids = loadKnownFuids();
// Skip both plugins with known FUIDs AND plugins we've already probed & marked null (AU-only etc).
const unknown = pluginRows.filter(r => !(r.plugin in fuids));
if (unknown.length) {
  console.error(`\nprobing Ardour for ${unknown.length} unknown FUID(s)...`);
  // Try to instantiate on a scratch track we create + drop.
  for (const { plugin, vendor } of unknown) {
    const nm = JSON.stringify(plugin);
    // Read plugin metadata WITHOUT instantiating — uses ARDOUR.LuaAPI.new_plugin_info.
    // Safer than new_plugin because it doesn't spin up the plugin's audio engine / DSP thread
    // (which is what crashes sessions for some plugins when detached from a track).
    const code = `
local info = ARDOUR.LuaAPI.new_plugin_info(${nm}, ARDOUR.PluginType.VST3)
local ptype = ${TYPE_VST3}
if not info or info:isnil() then
  info = ARDOUR.LuaAPI.new_plugin_info(${nm}, ARDOUR.PluginType.AudioUnit)
  ptype = ${TYPE_AU}
end
if not info or info:isnil() then print("ERR plugin_not_available") return end
print("OK")
print("name="..info.name)
print("unique_id="..info.unique_id)
print("type="..tostring(ptype))
`.trim();
    try {
      const out = await lua(code);
      if (out.startsWith('ERR ')) {
        console.error(`  ${plugin}: ${out.trim()}`);
        continue;
      }
      const kv = parseKv(out);
      if (!kv.unique_id) { console.error(`  ${plugin}: no uid in output`); continue; }
      fuids[plugin] = { uid: kv.unique_id, type: parseInt(kv.type, 10), vendor: vendor || null };
      console.error(`  ${plugin}: ${kv.unique_id} (type ${kv.type})`);
    } catch (e) {
      console.error(`  ${plugin}: probe failed — ${e.message}`);
    }
  }
  saveKnownFuids(fuids);
  fuids = loadKnownFuids();
}

// ---- convert all NKSFs for plugins where we now have FUIDs ----
const db2 = openDb();
const summary = [];
for (const { plugin, vendor, n } of pluginRows) {
  const entry = fuids[plugin];
  if (!entry?.uid) {
    summary.push({ plugin, skipped: true, reason: 'no FUID' });
    continue;
  }
  const rows = db2.prepare(`SELECT source_path FROM presets WHERE source_type='nksf' AND plugin=?`).all(plugin);
  const vendorDir = entry.vendor || vendor || 'Unknown';
  const target = join(homedir(), 'Library/Audio/Presets', vendorDir, plugin);
  let ok = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    try {
      const res = await convertNksfFile(r.source_path, target, { dryRun: dry, overwrite: false });
      if (res.ok) { if (res.skipped) skipped++; else ok++; }
      else errors++;
    } catch { errors++; }
  }
  summary.push({ plugin, vendor: vendorDir, target, candidates: n, written: ok, skipped, errors });
  console.error(`${plugin.padEnd(40)} written=${ok} skipped=${skipped} errors=${errors} → ${target}`);
}
db2.close();
console.log(JSON.stringify({ dry, host, session: args.sid, summary }, null, 2));
