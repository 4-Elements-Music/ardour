// Convert NKSF sidecar files to native .vstpreset containers.
// The PCHK chunk inside NKSF IS the plugin's VST3 component state — exactly what Ardour's
// preset loader hands to IComponent::setState. So we just extract PCHK, compose a minimal
// VST3 preset container around it, and write to disk where Ardour discovers factory presets.
//
// VST3 preset format (per Steinberg SDK):
//   [4B "VST3"] [4B version=1 LE] [32B classID ASCII] [8B listOffset LE]
//   [component state bytes]
//   [List chunk: "List" + u32 count + entries(chunkId + u64 offset + u64 size)]
//
// We emit a List with one entry pointing at the component state.

import { readFile, mkdir, writeFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { parseNksf } from './nksf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUIDS_FILE = join(__dirname, '../../data/known-fuids.json');

// Load known FUIDs from disk. Keyed by plugin name (e.g. "Diva" → { uid, type, vendor }).
export function loadKnownFuids() {
  try {
    const raw = readFileSync(FUIDS_FILE, 'utf8');
    const map = JSON.parse(raw);
    // Strip the leading _comment key if present.
    delete map._comment;
    return map;
  } catch { return {}; }
}

export function saveKnownFuids(map) {
  const out = { _comment: 'Map of plugin display name to VST3 FUID + type (7=VST3). Auto-extended by scripts/refresh-nks-index.js.', ...map };
  writeFileSync(FUIDS_FILE, JSON.stringify(out, null, 2));
}

// Extract the PCHK (plugin state) bytes from an NKSF file.
// Returns { pchk: Buffer, nisi: parsedMeta, plid: parsedPlid } or null.
export async function extractNksfState(filePath) {
  const buf = await readFile(filePath);
  if (buf.length < 12 || buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.slice(8, 12).toString('ascii') !== 'NIKS') return null;
  const riffSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, 8 + riffSize);

  let pchk = null;
  let pos = 12;
  while (pos + 8 <= end) {
    const chunkId = buf.slice(pos, pos + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(pos + 4);
    const payloadStart = pos + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > buf.length) break;
    if (chunkId === 'PCHK') {
      // PCHK payload: 4B version uint32 LE + raw state bytes.
      if (chunkSize >= 4) {
        pchk = buf.slice(payloadStart + 4, payloadEnd);
      }
    }
    pos = payloadEnd;
    if (pos % 2 === 1) pos++; // RIFF even-byte padding
  }

  const meta = await parseNksf(filePath);
  return { pchk, nisi: meta?.nisi || null, plid: meta?.plid || null };
}

// Resolve the VST3 FUID for a preset. Prefer PLID, else lookup by (vendor, plugin).
export function resolveFuid({ plid, nisi }) {
  if (plid) {
    // PLID shapes vary — try common keys.
    const candidates = [plid.VST3, plid.vst3, plid.VST, plid.vst_id, plid['vst_id']];
    for (const c of candidates) {
      if (typeof c === 'string' && /^[0-9A-Fa-f]{32}$/.test(c.trim())) return c.trim().toUpperCase();
      // Some PLID forms pack FUID as bytes — stringify:
      if (Buffer.isBuffer(c) && c.length === 16) return c.toString('hex').toUpperCase();
    }
  }
  if (nisi?.bankchain?.[0]) {
    const fuids = loadKnownFuids();
    const entry = fuids[nisi.bankchain[0]];
    if (entry?.uid) return entry.uid.toUpperCase();
  }
  return null;
}

// Build a .vstpreset Buffer from (fuid, componentState).
// Build a .vstpreset matching Ardour's save_preset() layout:
// [48B header] [stateBuf as Comp] [stateBuf as Cont] [List with 2 entries]
// Ardour writes both Comp (component state) and Cont (controller state) chunks pointing
// at sequential copies of the same bytes. Many VST3 hosts require both to be present.
export function buildVstPreset(fuid, stateBuf) {
  if (!/^[0-9A-Fa-f]{32}$/.test(fuid)) throw new Error(`bad FUID: ${fuid}`);
  const classIdAscii = Buffer.from(fuid.toUpperCase(), 'ascii'); // 32 bytes
  const size = stateBuf.length;
  const compOffset = 48;
  const contOffset = compOffset + size;
  const listOffset = contOffset + size;

  const header = Buffer.alloc(48);
  header.write('VST3', 0, 4, 'ascii');
  header.writeUInt32LE(1, 4);
  classIdAscii.copy(header, 8);
  header.writeUInt32LE(listOffset & 0xffffffff, 40);
  header.writeUInt32LE(Math.floor(listOffset / 0x100000000), 44);

  // List: "List" + count(2) + 2 entries of 20 bytes each
  const list = Buffer.alloc(8 + 2 * 20);
  list.write('List', 0, 4, 'ascii');
  list.writeUInt32LE(2, 4);
  // Comp entry
  list.write('Comp', 8, 4, 'ascii');
  list.writeUInt32LE(compOffset & 0xffffffff, 12);
  list.writeUInt32LE(Math.floor(compOffset / 0x100000000), 16);
  list.writeUInt32LE(size & 0xffffffff, 20);
  list.writeUInt32LE(Math.floor(size / 0x100000000), 24);
  // Cont entry
  list.write('Cont', 28, 4, 'ascii');
  list.writeUInt32LE(contOffset & 0xffffffff, 32);
  list.writeUInt32LE(Math.floor(contOffset / 0x100000000), 36);
  list.writeUInt32LE(size & 0xffffffff, 40);
  list.writeUInt32LE(Math.floor(size / 0x100000000), 44);

  return Buffer.concat([header, stateBuf, stateBuf, list]);
}

// Sanitize a preset name into a safe filename.
export function sanitizeName(name) {
  return name
    .replace(/[/\\:?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// Convert an NKSF file to a .vstpreset and write it into the target dir.
// Returns { ok, outPath, error? }.
export async function convertNksfFile(nksfPath, outDir, { dryRun = false, overwrite = false } = {}) {
  const extracted = await extractNksfState(nksfPath);
  if (!extracted) return { ok: false, error: 'not an NKSF', nksfPath };
  if (!extracted.pchk) return { ok: false, error: 'no PCHK chunk', nksfPath };
  const fuid = resolveFuid(extracted);
  if (!fuid) return { ok: false, error: 'FUID unknown — extend KNOWN_FUIDS', nksfPath };

  const name = extracted.nisi?.name || basename(nksfPath, extname(nksfPath));
  const outName = `${sanitizeName(name)}.vstpreset`;
  const outPath = join(outDir, outName);

  if (!overwrite && existsSync(outPath)) return { ok: true, outPath, skipped: true };

  const preset = buildVstPreset(fuid, extracted.pchk);
  if (dryRun) return { ok: true, outPath, bytes: preset.length, dry: true };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, preset);
  return { ok: true, outPath, bytes: preset.length };
}
