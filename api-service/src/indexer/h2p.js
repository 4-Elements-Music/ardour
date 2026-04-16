import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, extname, sep } from 'path';

// Parse a u-he .h2p "@Meta" header. Returns { bank, author, description, usage } (any may be undefined).
// Format: /*@Meta\n\nField:\n'value'\n\n... */
export function parseH2pMeta(text) {
  const out = {};
  const headerMatch = text.match(/\/\*@Meta\s*([\s\S]*?)\*\//);
  if (!headerMatch) return out;
  const body = headerMatch[1];
  const fieldRe = /^(\w[\w ]*):\s*\n'((?:[^'\\]|\\.)*)'/gm;
  let m;
  while ((m = fieldRe.exec(body))) {
    const key = m[1].trim().toLowerCase();
    const val = m[2].replace(/\\r\\n/g, '\n').replace(/\\'/g, "'");
    out[key] = val;
  }
  return out;
}

// Derive a human preset name from filename: strip extension + common 2-letter author prefix ("HS ", "BS ", etc.).
export function presetNameFromFile(file) {
  const base = basename(file, extname(file));
  return base.replace(/^[A-Z]{2,3}\s+/, '');
}

// Category = parent folder name, normalized: "1 BASS" -> "Bass".
export function categoryFromPath(absPath, rootDir) {
  const rel = absPath.startsWith(rootDir) ? absPath.slice(rootDir.length + 1) : absPath;
  const segs = rel.split(sep);
  if (segs.length < 2) return null;
  const folder = segs[segs.length - 2];
  return folder.replace(/^\d+\s+/, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Walk a directory recursively, yielding absolute file paths that match predicate.
export async function* walkFiles(dir, predicate) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(p, predicate);
    } else if (e.isFile() && predicate(p)) {
      yield p;
    }
  }
}

// Scan a u-he product directory (e.g., /Library/Audio/Presets/u-he/Diva) and return an array of preset records.
export async function scanUhePresetDir(rootDir) {
  const results = [];
  const pluginName = basename(rootDir); // "Diva", "Hive", "Zebra2"...
  for await (const file of walkFiles(rootDir, p => p.endsWith('.h2p'))) {
    try {
      const buf = await readFile(file);
      const text = buf.toString('latin1'); // u-he writes 8-bit; binary tail is ignored by header regex
      const meta = parseH2pMeta(text);
      results.push({
        plugin: pluginName,
        vendor: 'u-he',
        preset_name: presetNameFromFile(file),
        category: categoryFromPath(file, rootDir),
        bank: meta.bank || null,
        author: meta.author || null,
        description: meta.description || null,
        usage: meta.usage || null,
        source_path: file,
        source_type: 'h2p',
      });
    } catch (e) {
      results.push({ source_path: file, source_type: 'h2p', error: String(e.message || e) });
    }
  }
  return results;
}

// Convenience: scan all product dirs under the u-he root (e.g., /Library/Audio/Presets/u-he).
export async function scanUheRoot(uheRootDir) {
  let entries;
  try { entries = await readdir(uheRootDir, { withFileTypes: true }); }
  catch { return []; }
  const all = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const productDir = join(uheRootDir, e.name);
      const s = await stat(productDir).catch(() => null);
      if (s && s.isDirectory()) {
        const r = await scanUhePresetDir(productDir);
        all.push(...r);
      }
    }
  }
  return all;
}
