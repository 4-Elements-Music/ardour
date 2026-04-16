#!/usr/bin/env node
// Gap-fill tags for harvested presets using Claude Haiku with structured output + prompt caching.
// Targets presets that have NO tags yet (typically vstpreset / h2p rows where source metadata was thin).
// Writes {type, subtype, mode[]} tags into preset_tags.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node scripts/llm-tag.js [--plugin NAME] [--limit 500] [--dry]
//
// Cost check: ~400 input tokens (cached) + ~40 output / preset. At Haiku 3.5 pricing:
//   - $0.80 / 1M input, $4 / 1M output; with caching ~$0.08 / 1M cached.
//   - 100k presets ≈ $5–15 total. For personal libraries (<10k untagged) expect well under $1.

import Anthropic from '@anthropic-ai/sdk';
import { openDb, addTag } from '../src/indexer/db.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const pluginFilter = args.plugin || null;
const limit = args.limit ? parseInt(args.limit, 10) : 500;
const dry = !!args.dry;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required.');
  process.exit(1);
}

// NKS-aligned taxonomy (harvested from the user's own NKSF corpus — matches tag axes we already have).
const TYPES = ['Bass', 'Brass', 'Drums', 'FX', 'Guitar/Plucked', 'Keys', 'Leads', 'Mallets', 'Organ', 'Pads', 'Piano', 'Reeds', 'Strings', 'Synth', 'Vocal', 'World'];
const SUBTYPES = ['Analog', 'Digital', 'FM', 'Wavetable', 'Granular', 'Sampled', 'Physical', 'Plucked', 'Sub', 'Evolving', 'Cinematic', 'Acoustic', 'Electric'];
const MODES = ['Acoustic', 'Analog', 'Arpeggiated', 'Bright', 'Dark', 'Deep', 'Digital', 'Dirty', 'Distorted', 'Dry', 'Electric', 'Ensemble', 'Evolving', 'FM', 'Glide', 'Granular', 'Huge', 'Long Release', 'Mono', 'Percussive', 'Processed', 'Sampled', 'Sequenced', 'Slow Attack', 'Synthetic', 'Warm', 'Wet'];

const SYSTEM_PROMPT = `You classify virtual instrument presets into tags.

TAXONOMY (choose only from these exact values):
- type (exactly one, or null): ${TYPES.join(' | ')}
- subtype (exactly one or null): ${SUBTYPES.join(' | ')}
- modes (0-4 character tags from): ${MODES.join(' | ')}

Rules:
- Return ONLY a JSON array matching the input array 1:1 by index.
- Each element: {"type": "...", "subtype": "...", "modes": ["..."]} OR {"unknown": true} if the name/context is uninformative.
- Prefer "unknown":true over guessing on ambiguous names ("Init", "Default", "Untitled", artist initials, numeric codes).
- Be conservative with modes — max 4, only if clearly implied by the name or description.
- No prose, no wrapping object, just the JSON array.`;

const db = openDb();
const where = ['NOT EXISTS (SELECT 1 FROM preset_tags t WHERE t.preset_id = p.id)'];
const sqlArgs = [];
if (pluginFilter) { where.push('p.plugin = ?'); sqlArgs.push(pluginFilter); }
const candidates = db.prepare(`
  SELECT id, plugin, preset_name, bank, category, author, description
  FROM presets p
  WHERE ${where.join(' AND ')}
  LIMIT ?
`).all(...sqlArgs, limit);
console.error(`untagged candidates: ${candidates.length}${pluginFilter ? ` (filter: ${pluginFilter})` : ''}`);
if (!candidates.length) { db.close(); process.exit(0); }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function formatItem(c) {
  const bits = [];
  bits.push(`name: ${c.preset_name}`);
  if (c.plugin) bits.push(`plugin: ${c.plugin}`);
  if (c.bank) bits.push(`bank: ${c.bank}`);
  if (c.category) bits.push(`folder_category: ${c.category}`);
  if (c.author) bits.push(`author: ${c.author}`);
  if (c.description) bits.push(`desc: ${c.description.slice(0, 200)}`);
  return bits.join('\n');
}

const BATCH = 25;
let tagged = 0, unknowns = 0, errors = 0, totalIn = 0, totalOut = 0, totalCached = 0;

for (let i = 0; i < candidates.length; i += BATCH) {
  const batch = candidates.slice(i, i + BATCH);
  const userContent = batch.map((c, idx) => `[${idx}]\n${formatItem(c)}`).join('\n\n---\n\n');
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userContent }],
    });
    const textBlock = resp.content.find(b => b.type === 'text');
    if (!textBlock) { errors += batch.length; continue; }
    let arr;
    try { arr = JSON.parse(textBlock.text); }
    catch {
      const m = textBlock.text.match(/\[[\s\S]*\]/);
      arr = m ? JSON.parse(m[0]) : null;
    }
    if (!Array.isArray(arr) || arr.length !== batch.length) {
      errors += batch.length;
      console.error(`batch ${i}: parse failed or length mismatch (got ${arr?.length} expected ${batch.length})`);
      continue;
    }
    for (let k = 0; k < batch.length; k++) {
      const pres = batch[k];
      const pred = arr[k];
      if (!pred || pred.unknown) { unknowns++; continue; }
      if (dry) { tagged++; continue; }
      if (pred.type && TYPES.includes(pred.type)) addTag(db, pres.id, 'type', pred.type);
      if (pred.subtype && SUBTYPES.includes(pred.subtype)) addTag(db, pres.id, 'subtype', pred.subtype);
      if (Array.isArray(pred.modes)) {
        for (const m of pred.modes.slice(0, 4)) {
          if (MODES.includes(m)) addTag(db, pres.id, 'mode', m);
        }
      }
      tagged++;
    }
    totalIn += resp.usage?.input_tokens || 0;
    totalOut += resp.usage?.output_tokens || 0;
    totalCached += resp.usage?.cache_read_input_tokens || 0;
    const done = Math.min(i + BATCH, candidates.length);
    if (done % 100 === 0 || done === candidates.length) {
      const inCost = (totalIn - totalCached) * 0.80 / 1e6;
      const cacheCost = totalCached * 0.08 / 1e6;
      const outCost = totalOut * 4.00 / 1e6;
      console.error(`  ${done}/${candidates.length} tagged=${tagged} unk=${unknowns} err=${errors} tokens(in/cached/out)=${totalIn}/${totalCached}/${totalOut} cost≈$${(inCost + cacheCost + outCost).toFixed(4)}`);
    }
  } catch (e) {
    errors += batch.length;
    console.error(`batch ${i} error: ${e.message}`);
  }
}
db.close();
console.log(JSON.stringify({
  plugin_filter: pluginFilter,
  candidates: candidates.length,
  tagged, unknowns, errors, dry,
  tokens: { input: totalIn, cached: totalCached, output: totalOut },
}, null, 2));
