import { readFile, readdir } from 'fs/promises';
import { basename, extname, dirname, relative, sep } from 'path';
import { walkFiles } from './h2p.js';

// Minimal VST3 .vstpreset header parser.
// Format: "VST3" magic (4B) + version (4B LE) + classID (32 ASCII FUID) + listOffset (8B LE) + data + list.
// We only extract: classID (FUID) and optionally MetaInfo XML if present.
// Spec: https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Locations+Format/Preset+Format.html
export async function parseVstpresetHeader(filePath) {
  const buf = await readFile(filePath);
  if (buf.length < 48) return null;
  if (buf.slice(0, 4).toString('ascii') !== 'VST3') return null;
  const version = buf.readUInt32LE(4);
  const classId = buf.slice(8, 40).toString('ascii');
  const listOffsetLow = buf.readUInt32LE(40);
  const listOffsetHigh = buf.readUInt32LE(44);
  const listOffset = listOffsetHigh * 0x100000000 + listOffsetLow;
  const out = { version, classId, listOffset };

  // Walk the list at listOffset for optional Meta chunk.
  if (listOffset > 0 && listOffset + 4 <= buf.length) {
    if (buf.slice(listOffset, listOffset + 4).toString('ascii') === 'List') {
      const count = buf.readUInt32LE(listOffset + 4);
      let pos = listOffset + 8;
      for (let i = 0; i < count && pos + 20 <= buf.length; i++) {
        const chunkId = buf.slice(pos, pos + 4).toString('ascii');
        const offLow = buf.readUInt32LE(pos + 4);
        const offHigh = buf.readUInt32LE(pos + 8);
        const sizeLow = buf.readUInt32LE(pos + 12);
        const sizeHigh = buf.readUInt32LE(pos + 16);
        const off = offHigh * 0x100000000 + offLow;
        const size = sizeHigh * 0x100000000 + sizeLow;
        if (chunkId === 'Info' && size > 0 && off + size <= buf.length) {
          out.metaInfoXml = buf.slice(off, off + size).toString('utf8');
        }
        pos += 20;
      }
    }
  }
  return out;
}

// Parse the MetaInfo XML (when populated). Pulls out MusicalCharacter / MusicalStyle / Category, etc.
export function parseMetaInfoXml(xml) {
  if (!xml) return {};
  const fields = {};
  const re = /<Attribute\s+id="([^"]+)"\s+value="([^"]*)"\s+type="[^"]+"\s*\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    fields[m[1]] = m[2];
  }
  return fields;
}

// Scan a vendor/product directory tree and yield preset records.
// Expected layout: <root>/<Vendor>/<Product>/[<Bank>/]*.vstpreset
export async function scanVstpresetRoot(rootDir, { includeHeader = true } = {}) {
  const results = [];
  for await (const file of walkFiles(rootDir, p => p.endsWith('.vstpreset'))) {
    const rel = relative(rootDir, file);
    const segs = rel.split(sep);
    // segs: [Vendor, Product, ...optional bank folders..., preset.vstpreset]
    const vendor = segs[0] || null;
    const product = segs[1] || null;
    const bank = segs.length > 3 ? segs.slice(2, -1).join(' / ') : null;
    const presetName = basename(file, extname(file));

    const row = {
      plugin: product,
      vendor,
      preset_name: presetName,
      bank,
      category: null,
      author: null,
      description: null,
      usage: null,
      source_path: file,
      source_type: 'vstpreset',
      extras: {},
    };

    if (includeHeader) {
      try {
        const hdr = await parseVstpresetHeader(file);
        if (hdr) {
          row.extras.classId = hdr.classId;
          if (hdr.metaInfoXml) {
            const meta = parseMetaInfoXml(hdr.metaInfoXml);
            row.extras.meta = meta;
            if (meta['MusicalCategory']) row.category = meta['MusicalCategory'];
            else if (meta['Category']) row.category = meta['Category'];
            if (meta['MusicalStyle']) row.extras.style = meta['MusicalStyle'];
            if (meta['MusicalCharacter']) row.extras.character = meta['MusicalCharacter'];
            if (meta['MusicalInstrument']) row.extras.instrument = meta['MusicalInstrument'];
            if (meta['Author']) row.author = meta['Author'];
            if (meta['Comment']) row.description = meta['Comment'];
          }
        }
      } catch (e) {
        row.error = `vstpreset parse: ${e.message}`;
      }
    }
    results.push(row);
  }
  return results;
}
