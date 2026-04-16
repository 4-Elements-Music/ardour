// Walk a directory tree for Kontakt .nki / .nkm / .nkr / .nkb preset files.
// We can't parse the binary contents (proprietary), but each file IS a preset that's loadable
// via Kontakt's GUI. Indexing by filename + folder path makes them searchable; URI is captured
// later via preset/capture once a user loads one in Kontakt.

import { readdir } from 'fs/promises';
import { join, basename, extname, sep } from 'path';
import { walkFiles } from './h2p.js';

const NKI_EXTS = ['.nki', '.nkm', '.nkr', '.nkb'];

// A Kontakt library sits at a directory typically containing a .nicnt file. We treat the dir
// name as the library name (plugin) and subfolder path as category/bank.
export function isKontaktPreset(p) {
  const ext = extname(p).toLowerCase();
  return NKI_EXTS.includes(ext);
}

// Given a preset file path and a root dir we scanned, derive {library, bank, presetName}.
// If the root has a parent product dir structure like "/<Vendor>/<LibraryName>/...", we try
// to pick the library from the first segment after the root.
export function classifyNkiPath(filePath, rootDir) {
  const relative = filePath.startsWith(rootDir) ? filePath.slice(rootDir.length).replace(/^\/+/, '') : filePath;
  const segs = relative.split(sep);
  // Library = top-level folder name after the root; bank = everything between.
  const library = segs.length > 1 ? segs[0] : null;
  const bank = segs.length > 2 ? segs.slice(1, -1).join(' / ') : null;
  const presetName = basename(filePath, extname(filePath));
  return { library, bank, preset_name: presetName };
}

// Scan a root dir for all Kontakt preset files, returning our canonical row shape.
export async function scanKontaktRoot(rootDir, { vendor = null } = {}) {
  const results = [];
  for await (const file of walkFiles(rootDir, isKontaktPreset)) {
    const { library, bank, preset_name } = classifyNkiPath(file, rootDir);
    results.push({
      plugin: library || 'Kontakt',
      vendor,
      preset_name,
      bank,
      category: null,
      author: null,
      description: null,
      usage: null,
      source_path: file,
      source_type: 'nki',
      extras: { nki_ext: extname(file).toLowerCase() },
    });
  }
  return results;
}
