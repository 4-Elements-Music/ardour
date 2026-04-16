#!/usr/bin/env node
// Rule-based bulk tagger for plugins whose purpose is known.
// Much cheaper than LLM for plugins where every preset has the same high-level tags.
// Rules can be applied multiple times safely (INSERT OR IGNORE).

import { openDb, addTag, refreshFts } from '../src/indexer/db.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const dry = !!args.dry;

// Each rule: { plugin: <name or RegExp>, match?: (row) => bool,
//              tags: { type?, subtype?, modes?: [], characters?: [] },
//              bankTags?: (bankString) => { ... } }
// `match` further narrows which rows inside the plugin get the rule.
// `bankTags` derives additional tags from the row's bank/category string.
const RULES = [
  {
    plugin: 'Altiverb 8',
    tags: { type: 'FX', subtype: 'Reverb' },
    bankTags: (bank) => {
      const b = (bank || '').toLowerCase();
      const modes = [];
      if (b.includes('plate')) modes.push('Plate');
      if (b.includes('spring')) modes.push('Spring');
      if (b.includes('hall')) modes.push('Hall');
      if (b.includes('chamber')) modes.push('Chamber');
      if (b.includes('room')) modes.push('Room');
      if (b.includes('church') || b.includes('cathedral')) modes.push('Cathedral');
      if (b.includes('orchestral')) modes.push('Cinematic');
      if (b.includes('vocal')) modes.push('Vocal');
      if (b.includes('drum')) modes.push('Drum');
      if (b.includes('ambient')) modes.push('Ambient');
      return { modes };
    },
  },
  {
    plugin: 'Speakerphone',
    tags: { type: 'FX', subtype: 'Telephone' },
    bankTags: (bank) => {
      const b = (bank || '').toLowerCase();
      const modes = ['Lo-Fi'];
      if (b.includes('phone')) modes.push('Phone');
      if (b.includes('radio')) modes.push('Radio');
      if (b.includes('tv')) modes.push('TV');
      if (b.includes('megaphone') || b.includes('bullhorn')) modes.push('Megaphone');
      if (b.includes('walkie')) modes.push('Walkie-Talkie');
      if (b.includes('intercom')) modes.push('Intercom');
      return { modes };
    },
  },
  {
    plugin: 'Modular',
    tags: { type: 'Synth', subtype: 'Modular' },
  },
  {
    plugin: 'Modular FX',
    tags: { type: 'FX', subtype: 'Modular' },
  },
  {
    plugin: 'Heartbeat',
    tags: { type: 'Drums', subtype: 'Sampled' },
  },
  {
    plugin: 'Mutronics Mutator',
    tags: { type: 'FX', subtype: 'Filter' },
  },
  {
    plugin: 'OTO Biscuit 8-bit Effects',
    tags: { type: 'FX', subtype: 'Bit-crusher' },
  },
  {
    plugin: 'Spring Reverb',
    tags: { type: 'FX', subtype: 'Reverb' },
  },
  {
    plugin: 'TSAR-1 Reverb',
    tags: { type: 'FX', subtype: 'Reverb' },
  },
  {
    plugin: 'TSAR-1R Reverb',
    tags: { type: 'FX', subtype: 'Reverb' },
  },
  {
    plugin: 'Tube Delay',
    tags: { type: 'FX', subtype: 'Delay' },
  },
  {
    plugin: /^Valley People/,
    tags: { type: 'FX', subtype: 'Compressor' },
  },
];

// Keyword → {type, modes} inferred from folder path + preset name.
// Applied only to NKI rows (Kontakt libraries) which are usually descriptively named.
const NKI_KEYWORDS = [
  { re: /\b(string|violin|viola|cello|bass|contrabass|harp|double.bass|pizzicato|arco|spiccato|legato|marcato|sul.tasto|sul.pont|tremolo)\b/i, type: 'Strings' },
  { re: /\b(brass|trumpet|trombone|horn|tuba|flugel|cornet)\b/i, type: 'Brass' },
  { re: /\b(woodwind|flute|clarinet|oboe|bassoon|piccolo|recorder|sax|saxophone)\b/i, type: 'Woodwind' },
  { re: /\b(piano|grand|upright|rhodes|wurli|clav|clavinet|cp.?70|e.piano|electric.piano)\b/i, type: 'Keys' },
  { re: /\b(organ|hammond|b.3|pipe.organ|vox.continental|farfisa)\b/i, type: 'Organ' },
  { re: /\b(guitar|acoustic|electric|bass.guitar|lute|banjo|mandolin|ukulele)\b/i, type: 'Guitar/Plucked' },
  { re: /\b(drum|kick|snare|hat|cymbal|tom|percussion|timpani|bongo|conga)\b/i, type: 'Drums' },
  { re: /\b(mallet|marimba|xylophone|vibraphone|glockenspiel|celesta|tubular)\b/i, type: 'Mallets' },
  { re: /\b(pad|atmos|texture|ambient|drone|layer)\b/i, type: 'Pads' },
  { re: /\b(lead|synth.lead|mono.lead|solo.lead)\b/i, type: 'Leads' },
  { re: /\b(sub|808|bassline|analog.bass|synth.bass)\b/i, type: 'Bass' },
  { re: /\b(choir|voice|vocal|chorale|ooh|aah|whisper)\b/i, type: 'Vocal' },
  { re: /\b(fx|effect|riser|impact|hit|whoosh|swell|sfx|noise)\b/i, type: 'FX' },
  { re: /\b(world|ethnic|taiko|duduk|shakuhachi|sitar|gamelan|kalimba|didgeridoo)\b/i, type: 'World' },
];
const CHARACTER_KEYWORDS = [
  { re: /\b(dark|darkness|shadow|night)\b/i, mode: 'Dark' },
  { re: /\b(bright|shimmer|glisten|sparkle|shine)\b/i, mode: 'Bright' },
  { re: /\b(warm|mellow|soft|smooth)\b/i, mode: 'Warm' },
  { re: /\b(gritty|dirty|distort|fuzz|grunge|grime)\b/i, mode: 'Gritty' },
  { re: /\b(lo.?fi|vintage|tape|cassette|vinyl|crust)\b/i, mode: 'Lo-Fi' },
  { re: /\b(cinematic|epic|trailer|film|orchestral)\b/i, mode: 'Cinematic' },
  { re: /\b(airy|ethereal|angelic|celestial|dreamy)\b/i, mode: 'Airy' },
  { re: /\b(aggressive|harsh|metal|brutal|heavy)\b/i, mode: 'Aggressive' },
  { re: /\b(evolving|morphing|shifting|moving)\b/i, mode: 'Evolving' },
  { re: /\b(plucky|pluck|staccato|pick|pizz)\b/i, mode: 'Plucky' },
  { re: /\b(arp|arpeggio|sequence|seq|rhythmic)\b/i, mode: 'Arpeggiated' },
  { re: /\b(mono|monophonic|solo)\b/i, mode: 'Mono' },
  { re: /\b(ensemble|section|ens|tutti)\b/i, mode: 'Ensemble' },
];

const db = openDb();
const allRows = db.prepare(`SELECT id, plugin, preset_name, bank, category, source_path, source_type FROM presets`).all();

let totalTouched = 0, totalTagsWritten = 0;
const byRuleMatches = new Map();

for (const rule of RULES) {
  const matches = allRows.filter(r => {
    if (typeof rule.plugin === 'string') { if (r.plugin !== rule.plugin) return false; }
    else if (rule.plugin instanceof RegExp) { if (!rule.plugin.test(r.plugin)) return false; }
    if (rule.match && !rule.match(r)) return false;
    return true;
  });
  byRuleMatches.set(String(rule.plugin), matches.length);

  for (const row of matches) {
    const writes = [];
    if (rule.tags?.type) writes.push(['type', rule.tags.type]);
    if (rule.tags?.subtype) writes.push(['subtype', rule.tags.subtype]);
    for (const m of (rule.tags?.modes || [])) writes.push(['mode', m]);
    for (const c of (rule.tags?.characters || [])) writes.push(['character', c]);
    if (rule.bankTags) {
      const extra = rule.bankTags(row.bank || row.category || '');
      for (const m of (extra.modes || [])) writes.push(['mode', m]);
      for (const c of (extra.characters || [])) writes.push(['character', c]);
    }
    if (!dry) for (const [axis, tag] of writes) addTag(db, row.id, axis, tag);
    totalTagsWritten += writes.length;
    totalTouched++;
  }
}

// ---- NKI keyword pass ----
// For every nki row that doesn't already have tags, derive type + character from
// the preset_name + source_path tail (library + subfolder names).
let nkiKeywordTouched = 0, nkiKeywordTagsWritten = 0;
const nkiRows = allRows.filter(r => r.source_type === 'nki');
const hasAnyTag = new Set(
  db.prepare(`SELECT DISTINCT preset_id FROM preset_tags WHERE preset_id IN (SELECT id FROM presets WHERE source_type='nki')`).all().map(r => r.preset_id)
);
for (const row of nkiRows) {
  if (hasAnyTag.has(row.id)) continue;
  const blob = `${row.preset_name} ${row.source_path.split('/').slice(-4).join(' ')}`;
  const writes = [];
  const typesFound = new Set();
  for (const rule of NKI_KEYWORDS) if (rule.re.test(blob) && !typesFound.has(rule.type)) { writes.push(['type', rule.type]); typesFound.add(rule.type); }
  for (const rule of CHARACTER_KEYWORDS) if (rule.re.test(blob)) writes.push(['mode', rule.mode]);
  if (writes.length) {
    if (!dry) for (const [axis, tag] of writes) addTag(db, row.id, axis, tag);
    nkiKeywordTagsWritten += writes.length;
    nkiKeywordTouched++;
  }
}

// ---- h2p → NKSF tag propagation (same plugin + preset_name) ----
let propagatedRows = 0, propagatedTags = 0;
const h2pPropStmt = db.prepare(`
  SELECT DISTINCT h.id AS h_id, t.axis, t.tag
  FROM presets h
  JOIN presets n ON n.plugin = h.plugin AND n.preset_name = h.preset_name AND n.source_type = 'nksf'
  JOIN preset_tags t ON t.preset_id = n.id
  WHERE h.source_type = 'h2p'
    AND NOT EXISTS (SELECT 1 FROM preset_tags ht WHERE ht.preset_id = h.id)
`);
const propagations = h2pPropStmt.all();
const seenPropIds = new Set();
for (const row of propagations) {
  if (!dry) addTag(db, row.h_id, row.axis, row.tag);
  propagatedTags++;
  seenPropIds.add(row.h_id);
}
propagatedRows = seenPropIds.size;

if (!dry) refreshFts(db);
db.close();

console.log(JSON.stringify({
  dry,
  rules_applied: RULES.length,
  rows_touched: totalTouched,
  tag_rows_written: totalTagsWritten,
  per_rule: Object.fromEntries(byRuleMatches),
  nki_keyword_touched: nkiKeywordTouched,
  nki_keyword_tags: nkiKeywordTagsWritten,
  h2p_propagated_rows: propagatedRows,
  h2p_propagated_tags: propagatedTags,
}, null, 2));
