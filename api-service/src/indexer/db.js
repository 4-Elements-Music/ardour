import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Default DB location: ~/.ardour-preset-index/presets.db (personal use, one per machine).
export const DEFAULT_DB_PATH = join(homedir(), '.ardour-preset-index', 'presets.db');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS presets (
  id            INTEGER PRIMARY KEY,
  plugin        TEXT NOT NULL,        -- "Diva", "Kontakt 8", "Serum"
  vendor        TEXT,
  preset_name   TEXT NOT NULL,
  bank          TEXT,
  category      TEXT,
  author        TEXT,
  description   TEXT,
  usage         TEXT,
  source_path   TEXT NOT NULL,        -- absolute path to .h2p / .vstpreset / .nksf
  source_type   TEXT NOT NULL,        -- 'h2p' | 'vstpreset' | 'nksf' | ...
  extras_json   TEXT,                 -- format-specific additional fields
  indexed_at    INTEGER DEFAULT (unixepoch()),
  UNIQUE (source_path)
);

CREATE INDEX IF NOT EXISTS idx_presets_plugin ON presets (plugin);
CREATE INDEX IF NOT EXISTS idx_presets_category ON presets (category);
CREATE INDEX IF NOT EXISTS idx_presets_name ON presets (preset_name);

-- Tag axes: 'type' | 'subtype' | 'mode' | 'character' | 'mood'. Multi-label.
CREATE TABLE IF NOT EXISTS preset_tags (
  preset_id INTEGER NOT NULL,
  axis      TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (preset_id, axis, tag),
  FOREIGN KEY (preset_id) REFERENCES presets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON preset_tags (axis, tag);

-- Captured URIs from Ardour's save_preset (the recall key).
-- Linked to presets by (plugin, preset_name) so a capture enriches harvested rows.
CREATE TABLE IF NOT EXISTS captured_uris (
  id              INTEGER PRIMARY KEY,
  plugin          TEXT NOT NULL,
  preset_name     TEXT NOT NULL,
  ardour_uri      TEXT NOT NULL UNIQUE,
  ardour_label    TEXT,
  plugin_uid      TEXT,               -- info.unique_id (VST3 FUID)
  plugin_type     INTEGER,            -- ARDOUR.PluginType numeric
  captured_at     INTEGER DEFAULT (unixepoch()),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_captured_lookup ON captured_uris (plugin, preset_name);

-- Full-text search over name + bank + tags (materialized view maintained by triggers below).
CREATE VIRTUAL TABLE IF NOT EXISTS presets_fts USING fts5(
  preset_name, plugin, bank, category, author, description, usage, tags_flat,
  content=''
);
`;

export function openDb(path = DEFAULT_DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

// Upsert a preset record. Returns the row id.
export function upsertPreset(db, row) {
  const stmt = db.prepare(`
    INSERT INTO presets (plugin, vendor, preset_name, bank, category, author, description, usage,
                         source_path, source_type, extras_json)
    VALUES (@plugin, @vendor, @preset_name, @bank, @category, @author, @description, @usage,
            @source_path, @source_type, @extras_json)
    ON CONFLICT(source_path) DO UPDATE SET
      plugin      = excluded.plugin,
      vendor      = excluded.vendor,
      preset_name = excluded.preset_name,
      bank        = excluded.bank,
      category    = excluded.category,
      author      = excluded.author,
      description = excluded.description,
      usage       = excluded.usage,
      source_type = excluded.source_type,
      extras_json = excluded.extras_json,
      indexed_at  = unixepoch()
    RETURNING id
  `);
  const ret = stmt.get({
    plugin: row.plugin,
    vendor: row.vendor ?? null,
    preset_name: row.preset_name,
    bank: row.bank ?? null,
    category: row.category ?? null,
    author: row.author ?? null,
    description: row.description ?? null,
    usage: row.usage ?? null,
    source_path: row.source_path,
    source_type: row.source_type,
    extras_json: row.extras ? JSON.stringify(row.extras) : null,
  });
  return ret.id;
}

export function addTag(db, presetId, axis, tag) {
  db.prepare(`INSERT OR IGNORE INTO preset_tags (preset_id, axis, tag) VALUES (?, ?, ?)`)
    .run(presetId, axis, tag);
}

export function refreshFts(db) {
  db.exec(`
    INSERT INTO presets_fts(presets_fts) VALUES('delete-all');
    INSERT INTO presets_fts (rowid, preset_name, plugin, bank, category, author, description, usage, tags_flat)
    SELECT p.id, p.preset_name, p.plugin, COALESCE(p.bank,''), COALESCE(p.category,''),
           COALESCE(p.author,''), COALESCE(p.description,''), COALESCE(p.usage,''),
           COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM preset_tags WHERE preset_id = p.id), '')
    FROM presets p;
  `);
}

// Look up a capture row by ardour_uri.
export function getCaptureByUri(db, ardour_uri) {
  return db.prepare(`SELECT * FROM captured_uris WHERE ardour_uri = ?`).get(ardour_uri) || null;
}

// Record a captured preset URI from Ardour's save_preset.
export function recordCapture(db, { plugin, preset_name, ardour_uri, ardour_label, plugin_uid, plugin_type, notes }) {
  db.prepare(`
    INSERT INTO captured_uris (plugin, preset_name, ardour_uri, ardour_label, plugin_uid, plugin_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ardour_uri) DO UPDATE SET
      plugin = excluded.plugin,
      preset_name = excluded.preset_name,
      ardour_label = excluded.ardour_label,
      plugin_uid = excluded.plugin_uid,
      plugin_type = excluded.plugin_type,
      notes = excluded.notes,
      captured_at = unixepoch()
  `).run(plugin, preset_name, ardour_uri, ardour_label ?? null, plugin_uid ?? null, plugin_type ?? null, notes ?? null);
}

// Priority for deduping duplicate (plugin, preset_name) rows across source_type.
// nksf → richest metadata (NKS tags), prefer first; h2p → bank/author; vstpreset → usually name-only.
// kk_db sits alongside nksf for taxonomy quality.
const SOURCE_PRIORITY = { nksf: 0, kk_db: 0, h2p: 1, vstpreset: 2, nki: 3 };
function dedupeByName(rows) {
  const best = new Map();       // key → chosen row
  const sibIds = new Map();     // key → all row ids collapsed into this key (for tag union)
  for (const r of rows) {
    const key = `${r.plugin}::${r.preset_name}`;
    if (!sibIds.has(key)) sibIds.set(key, []);
    sibIds.get(key).push(r.id);
    const existing = best.get(key);
    if (!existing) { best.set(key, r); continue; }
    const pNew = SOURCE_PRIORITY[r.source_type] ?? 99;
    const pOld = SOURCE_PRIORITY[existing.source_type] ?? 99;
    if (pNew < pOld) best.set(key, r);
  }
  for (const [key, r] of best) r._sibling_ids = sibIds.get(key);
  return [...best.values()];
}

// Search: FTS match + optional filters + captured-URI join.
// When capturedOnly=true, the base row set comes from captured_uris (so captures that have no
// matching harvested preset still appear). Otherwise base comes from harvested presets.
// Results are deduped by (plugin, preset_name) preferring the richest source_type.
export function searchPresets(db, { query, plugin, category, axis, tag, capturedOnly, limit = 20 }) {
  const args = [];
  let fts = null;
  if (query && query.trim()) {
    fts = query.trim().replace(/["*]/g, '').split(/\s+/).map(w => `"${w}"*`).join(' OR ');
  }

  const tagsStmt = db.prepare(`SELECT axis, tag FROM preset_tags WHERE preset_id = ?`);
  const uriStmt = db.prepare(`SELECT ardour_uri, ardour_label FROM captured_uris WHERE plugin = ? AND preset_name = ? ORDER BY captured_at DESC LIMIT 1`);

  if (capturedOnly) {
    // Start from captured_uris, LEFT JOIN to presets for tags/bank/etc.
    const where = [];
    if (plugin)   { where.push('c.plugin = ?');    args.push(plugin); }
    if (category) { where.push('p.category = ?');  args.push(category); }
    if (axis && tag) {
      where.push('EXISTS (SELECT 1 FROM preset_tags t WHERE t.preset_id = p.id AND t.axis = ? AND t.tag = ?)');
      args.push(axis, tag);
    }
    // Simple substring query over captured name when FTS is requested but capture may not be in FTS.
    if (fts && query) {
      where.push('(c.preset_name LIKE ? OR (p.preset_name IS NOT NULL AND p.preset_name LIKE ?))');
      args.push(`%${query}%`, `%${query}%`);
    }
    const sql = `
      SELECT
        p.id              AS id,
        c.plugin          AS plugin,
        c.preset_name     AS preset_name,
        p.vendor          AS vendor,
        p.bank            AS bank,
        p.category        AS category,
        p.author          AS author,
        p.description     AS description,
        p.usage           AS usage,
        p.source_type     AS source_type,
        c.ardour_uri      AS ardour_uri,
        c.ardour_label    AS ardour_label,
        c.captured_at     AS captured_at
      FROM captured_uris c
      LEFT JOIN presets p ON p.plugin = c.plugin AND p.preset_name = c.preset_name
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.captured_at DESC
      LIMIT ?
    `;
    args.push(limit);
    const rows = db.prepare(sql).all(...args);
    for (const r of rows) r.tags = r.id ? tagsStmt.all(r.id) : [];
    return rows;
  }

  // Default path: search harvested presets, enrich with captured URI where available.
  const where = [];
  const base = fts
    ? `SELECT p.*, bm25(presets_fts) AS score FROM presets_fts JOIN presets p ON p.id = presets_fts.rowid WHERE presets_fts MATCH ?`
    : `SELECT p.*, 0 AS score FROM presets p WHERE 1=1`;
  if (fts) args.push(fts);
  if (plugin)   { where.push('p.plugin = ?');   args.push(plugin); }
  if (category) { where.push('p.category = ?'); args.push(category); }
  if (axis && tag) {
    where.push('EXISTS (SELECT 1 FROM preset_tags t WHERE t.preset_id = p.id AND t.axis = ? AND t.tag = ?)');
    args.push(axis, tag);
  }
  // Over-fetch to allow dedup down to `limit` unique presets; 4x headroom covers typical duplication.
  const overFetch = Math.min(limit * 4, 2000);
  const sql = `${base}${where.length ? ' AND ' + where.join(' AND ') : ''} ORDER BY score LIMIT ?`;
  args.push(overFetch);
  const rawRows = db.prepare(sql).all(...args);
  const rows = dedupeByName(rawRows).slice(0, limit);
  const tagsForIdsStmt = db.prepare(`SELECT DISTINCT axis, tag FROM preset_tags WHERE preset_id IN (SELECT value FROM json_each(?))`);
  for (const r of rows) {
    const c = uriStmt.get(r.plugin, r.preset_name);
    r.ardour_uri = c?.ardour_uri || null;
    r.ardour_label = c?.ardour_label || null;
    // Union tags across all sibling rows that share (plugin, preset_name).
    r.tags = tagsForIdsStmt.all(JSON.stringify(r._sibling_ids || [r.id]));
    delete r._sibling_ids;
  }
  return rows;
}
