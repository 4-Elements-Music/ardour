/**
 * Embed an iXML chunk containing JSON-serialized mashup metadata into a WAV file.
 *
 * iXML format: BWF iXML chunk per EBU Tech 3306. Payload is XML by spec; we wrap
 * the JSON in a single <FOURELEM_MASHUP_METADATA> element so consumers can use
 * either JSON or XML parsers — the Ledger uses JSON.parse on the inner text.
 *
 * Idempotent: if an iXML chunk already exists, it is replaced.
 */
import { readFile, writeFile } from 'node:fs/promises';

export async function embedIxmlInWav(wavPath, metadata) {
  const buf = await readFile(wavPath);
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('not a RIFF file');
  }
  if (buf.slice(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('not a WAVE file');
  }
  const json = JSON.stringify(metadata);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML>\n  <FOURELEM_MASHUP_METADATA>${escapeXml(json)}</FOURELEM_MASHUP_METADATA>\n</BWFXML>\n`;
  const payload = Buffer.from(xml, 'utf8');
  const padded = payload.length % 2 === 0
    ? payload : Buffer.concat([payload, Buffer.from([0])]);
  const ixmlHeader = Buffer.alloc(8);
  ixmlHeader.write('iXML', 0, 'ascii');
  ixmlHeader.writeUInt32LE(payload.length, 4);  // size = unpadded payload size
  const ixmlChunk = Buffer.concat([ixmlHeader, padded]);

  // Walk chunks; if we find an existing iXML, splice it out before appending the new one.
  let pos = 12;  // skip 'RIFF' + size + 'WAVE'
  let existingStart = -1, existingEndPadded = -1;
  while (pos + 8 <= buf.length) {
    const tag = buf.slice(pos, pos + 4).toString('ascii');
    const size = buf.readUInt32LE(pos + 4);
    const padSize = size + (size % 2);
    if (tag === 'iXML') { existingStart = pos; existingEndPadded = pos + 8 + padSize; break; }
    pos += 8 + padSize;
  }
  let newBuf;
  if (existingStart >= 0) {
    newBuf = Buffer.concat([
      buf.slice(0, existingStart),
      ixmlChunk,
      buf.slice(existingEndPadded),
    ]);
  } else {
    newBuf = Buffer.concat([buf, ixmlChunk]);
  }
  // Update RIFF size = total file size minus 8.
  newBuf.writeUInt32LE(newBuf.length - 8, 4);
  await writeFile(wavPath, newBuf);
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
