// NKSF (Native Kontrol Standard File) parser.
// RIFF container with 4 known chunks: NISI (summary), NICA (controller assignments),
// PLID (plugin id), PCHK (opaque plugin blob). Each chunk payload begins with a 4-byte
// LE version uint32, followed by MessagePack-encoded data (except PCHK, which is opaque).
//
// Format ref: community reverse-engineering
//   - https://github.com/jhorology/gulp-nks-rewrite-meta/blob/master/nksf-file-format.txt
//   - https://github.com/PresetMagician/PresetMagician (archived, working reference impl)
//
// We only need NISI (tag metadata) and PLID (plugin identity). NICA is ignored, PCHK is
// the opaque plugin state and we never touch it.

import { readFile } from 'fs/promises';
import { decode as msgpackDecode } from '@msgpack/msgpack';
import { basename, extname } from 'path';
import { walkFiles } from './h2p.js';

// Parse an NKSF file. Returns { nisi, plid } with parsed MessagePack maps, or null if not NKSF.
export async function parseNksf(filePath) {
  const buf = await readFile(filePath);
  if (buf.length < 12) return null;
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  const riffSize = buf.readUInt32LE(4);
  const form = buf.slice(8, 12).toString('ascii');
  if (form !== 'NIKS') return null;

  const out = {};
  let pos = 12;
  const end = Math.min(buf.length, 8 + riffSize);
  while (pos + 8 <= end) {
    const chunkId = buf.slice(pos, pos + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(pos + 4);
    const payloadStart = pos + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > buf.length) break;

    if (chunkId === 'NISI' || chunkId === 'NICA' || chunkId === 'PLID') {
      if (chunkSize >= 4) {
        // First 4 bytes = version uint32 LE (we ignore it), rest is MessagePack.
        const mpStart = payloadStart + 4;
        const mp = buf.slice(mpStart, payloadEnd);
        try {
          out[chunkId.toLowerCase()] = msgpackDecode(mp);
        } catch (e) {
          out[chunkId.toLowerCase() + '_error'] = String(e.message || e);
        }
      }
    }
    // PCHK skipped intentionally — plugin-opaque, no metadata there.
    // RIFF spec: chunks are padded to even-byte boundaries. Honor that.
    pos = payloadEnd;
    if (pos % 2 === 1) pos++;
  }
  return out;
}

// Shape a parsed NKSF into our preset row format.
export function nksfToRow(filePath, parsed) {
  const n = parsed?.nisi || {};
  const p = parsed?.plid || {};

  // types is typically [["Bass", "Synth"]] — an array of [type, subtype] pairs. We flatten the first pair.
  let type = null, subtype = null;
  if (Array.isArray(n.types) && n.types.length > 0) {
    const first = n.types[0];
    if (Array.isArray(first)) {
      type = first[0] || null;
      subtype = first[1] || null;
    } else if (typeof first === 'string') {
      type = first;
    }
  }

  // bankchain: ["Product", "Bank Name", ...subbanks]. First element = plugin product name.
  const pluginName = Array.isArray(n.bankchain) && n.bankchain.length > 0 ? n.bankchain[0] : null;
  const bank = Array.isArray(n.bankchain) && n.bankchain.length > 1
    ? n.bankchain.slice(1).join(' / ')
    : null;

  return {
    plugin: pluginName || n.vendor || null,
    vendor: n.vendor || null,
    preset_name: n.name || basename(filePath, extname(filePath)),
    bank,
    category: type,
    author: n.author || null,
    description: n.comment || null,
    usage: null,
    source_path: filePath,
    source_type: 'nksf',
    extras: {
      deviceType: n.deviceType || null,
      bankchain: n.bankchain || null,
      subtype,
      modes: Array.isArray(n.modes) ? n.modes : null,
      plugin_vst_id: p.VST3 || p.vst_id || p['VST'] || null,
      plid: p,
    },
    _tags: {
      type: type ? [type] : [],
      subtype: subtype ? [subtype] : [],
      mode: Array.isArray(n.modes) ? n.modes : [],
    },
  };
}

export async function scanNksfRoot(rootDir) {
  const results = [];
  for await (const file of walkFiles(rootDir, p => p.endsWith('.nksf'))) {
    try {
      const parsed = await parseNksf(file);
      if (!parsed) { results.push({ source_path: file, source_type: 'nksf', error: 'not an NKSF file' }); continue; }
      results.push(nksfToRow(file, parsed));
    } catch (e) {
      results.push({ source_path: file, source_type: 'nksf', error: String(e.message || e) });
    }
  }
  return results;
}
