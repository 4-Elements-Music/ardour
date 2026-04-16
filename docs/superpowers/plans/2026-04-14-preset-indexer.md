# Preset Indexer + Recall — Plan

**Scope:** personal use (not distributed). Single-user, local machine.
**Goal:** Given a natural-language request ("warm analog pad", "plucky FM bass", "airy cinematic strings"), our headless Ardour + MCP system can (a) find a matching preset across the user's installed virtual instruments, and (b) load it into a track programmatically and deterministically, with no GUI interaction at runtime.

## The problem, restated

Tagging every preset across Kontakt / VSL / Spitfire / Massive / u-he / Arturia / etc. by hand is infeasible. We need to automate both the **metadata harvest** (what exists, with which tags) and the **recall** (how to load preset X into the plugin headlessly).

The two halves are independent and meet only at the index row:

```
(metadata harvester)         (recall path)
 filesystem scan               MCP preset_search("warm pad")
 parse tags                      → SQL lookup
       ↓                         → get ardour_uri
 SQLite index:                   → plugin:load_preset(uri)
   plugin_uid                  Ardour restores the preset
   ardour_uri
   tags[]
```

## Two worlds of plugins

### World A — File-based factory presets
**Examples:** Serum, Diva, Vital, Pigments, Massive X, u-he (all), Arturia V-Collection, Phase Plant.
Presets are `.vstpreset` / `.h2p` / `.aupreset` / `.nksf` files on disk.

- **Discovery:** filesystem scan. Ardour *also* scans these at startup and exposes each as a URI via `plugin:preset_by_label(name)` / `plugin:preset_by_uri(uri)`.
- **Tags:** parsed from the file (NKS `.nksf` chunks, u-he `.h2p` `#cm=`, VST3 `MetaInfo` when populated) or from folder path.
- **Recall:** `plugin:load_preset(plugin:preset_by_uri(uri))` — zero GUI interaction.

Probably 50–70% of the library lives here. Fully automatable.

### World B — Plugin-internal libraries
**Examples:** Kontakt + all libraries (Spitfire in Kontakt, Orchestral Tools, Soundiron, etc.), Omnisphere, Spitfire native players, VSL Synchron Player, EastWest Opus.
Presets live inside the plugin's own browser. Not visible to Ardour. No `.vstpreset` on disk.

- **Discovery:** NKS `.nksf` sidecar files cover 30–50% of these (that's why NKS matters). For the rest: filename conventions, manual curation.
- **Tags:** same sources as A where present; LLM inference on names; audio probing for stragglers.
- **Recall:** **unresolved.** Depends on whether `plugin:save_preset()` captures enough state (e.g., "which NKI is loaded") that `load_preset` later brings back the same patch on a fresh plugin instance. Open question, see Step 0 below.

## NKS as the backbone

We'll adopt NKS's taxonomy as our canonical schema, since:
- It's already the industry de facto standard (NI + u-he + Arturia + Spitfire + Output + Spectrasonics 2.6+ + UVI + Softube + Cherry Audio + Plugin Alliance all tag content with it).
- Its files are on disk and parseable (RIFF + MessagePack per jhorology's format doc).
- Using it as our schema means zero translation between extraction and storage.

NKS taxonomy axes:
- **Types**: Bass, Drums, Guitar/Plucked, Keys, Leads, Mallets, Organ, Pads, Piano/Keys, SFX, Strings, Synth, Vocal, World
- **Sub-Types**: Analog, FM, Plucked, Sub, Synth (under Bass); Evolving, Textures (under Pads); etc.
- **Modes / Characters**: Acoustic, Analog, Arpeggiated, Bright, Dark, Digital, Distorted, Dry, Electric, Ensemble, FM, Glide, Granular, Long Release, Lo-Fi, Mono, Processed, Sequence/Loop, Slow Attack, Wet

Harvest the canonical enum values by scanning our own corpus of `.nksf` files — no schema design needed, it emerges from the library.

## Research findings that reshape the plan

Six research agents (four returned, two bailed without web tools) found:

- **KK SQLite DB is not the foundation we thought.** Path stated in initial memo is wrong (actual: `~/Library/Application Support/Native Instruments/Komplete Kontrol/komplete.db3` + `Browser Data/` in KK 3.x). Schema is not public. NI treats it as a disposable cache (wiped on upgrades). **Demoted from foundation to opportunistic enrichment.**
- **Named NKS parser projects in the original memo (`libfreekontakt`, `nicnk`, `freelssl/nks`, `nks-tools`) don't exist on GitHub.** The real OSS landscape: `jhorology/nks-presets-collection` (inactive 2022), `jhorology/gulp-nks-rewrite-meta` (the canonical format doc), `monomadic/ni-file` (active), `PresetMagician` (archived but useful reference — <https://github.com/PresetMagician/PresetMagician>). Budget 1–2 weeks to reimplement NKSF parser from jhorology's spec.
- **Citations in the original memo for LLM accuracy were fabricated.** Realistic expectations: **75–85% coarse category, 55–65% character tags** (not 85–92% / 75%). Need an "unknown" class, structured outputs, hand-labeled eval set of ~500 presets.
- **DAW metadata claims mostly overstated.** Ableton path was wrong; Cubase MediaBay is schema-rich but populations are frequently empty; Logic `.patch` taxonomy is folder-derived not in-file; Arturia `.pchk` as described doesn't exist (it's a chunk inside NKS files).
- **Legal landscape for personal use: green.** Reading files on your own disk is not a legal issue. Only constraint that remains: **don't try to decrypt Kontakt-encoded libraries** (DMCA §1201 — applies regardless of use). Parse unencrypted metadata headers only.

## Step 0 — Feasibility tests (THE decision point)

We're using Ardour's existing Lua preset API:
```
plugin:preset_by_label(name) / preset_by_uri(uri) → PresetRecord*
plugin:load_preset(record)                        → bool
plugin:save_preset(name)                          → PresetRecord (writes .vstpreset)
plugin:last_preset()                              → PresetRecord
PluginInfo:get_presets(user_only)                 → PresetVector
```

Driven via `session/lua_eval` MCP tool (already built).

### Status so far

- **Tier 1 basic round-trip (Diva VST3): PASS.**
  - `save_preset("ardour_cap_diva_01")` returned valid PresetRecord
    - URI: `VST3-S:D39D5B69D6AF42FA1234567844695661:ardour_cap_diva_01`
    - user=true, writes `.vstpreset` on disk
  - `load_preset(record)` returned true; `last_preset()` confirms applied.

- **Cross-instance recall (Diva VST3): PASS.**
  - Saved preset URI on instance A.
  - Removed plugin entirely (route had 0 plugins).
  - Added fresh Diva via `ARDOUR.LuaAPI.new_plugin(Session, "Diva", ARDOUR.PluginType.VST3, "")`.
  - `preset_by_uri(saved_uri)` on fresh instance → valid=true.
  - `preset_by_label(saved_label)` also worked as fallback.
  - `load_preset(record)` → true; `last_preset()` confirms recovery.
  - **Conclusion:** the Ardour preset URI is the durable key. Store in SQLite; `preset_by_uri()` + `load_preset()` resolve + apply on any future instance. No state-blob carrying, no GUI. World A recall is fully unlocked.

- **Tier 2 — Arturia Analog Lab V (VST3): PASS.**
  - Saved URI: `VST3-S:4172747541564953416C617650726F63:analoglab_cap_39438293`.
  - Removed, fresh instance via `ARDOUR.LuaAPI.new_plugin`, `preset_by_uri` resolved valid=true.
  - `load_preset` returned true, `last_preset` confirms.
  - Significance: Analog Lab V wraps Arturia V-Collection (effectively World-B behavior — the preset selects both sub-engine and patch). Full state round-trip works from Ardour's perspective.
  - Sonic verification (play note before/after) recommended to confirm engine-level recall.

- **Tier 3 — Kontakt 8 (VST3) with Amati Viola library: PASS (sonically confirmed).**
  - Capture → valid URI `VST3-S:5653544E694B386B6F6E74616B742038:kontakt_amati_cap_78309922`.
  - Removed Kontakt entirely from track.
  - Fresh Kontakt 8 instance via `ARDOUR.LuaAPI.new_plugin`.
  - `preset_by_uri` resolved valid=true; `load_preset` returned true.
  - **User sonic verification: Amati Viola library fully loaded with samples intact on the fresh Kontakt instance.**
  - **Conclusion: Kontakt's VST3 state serialization carries the full internal state — which NKI is loaded, which samples to stream. World B recall is the same mechanism as World A.** No host plugin, no GUI automation, no computer-use driver needed.

### All Step 0 tests: PASS

Every plugin class we care about recalls its complete state via the Ardour preset URI. This is the entire recall architecture.

### Step 0 addendum — factory preset enumeration

Probed every loaded plugin (Diva, Analog Lab V, Kontakt 8) with `info:get_presets(false)` and `info:get_presets(true)`. Result: **only user presets we created via `save_preset` are visible**. Zero factory presets enumerated for any VST3 tested — even plugins like Diva that ship thousands of factory patches.

**Implication:** every preset we want headless access to must be captured once via `save_preset` while loaded in the plugin. No pre-existing URIs to tag against. The capture pass is mandatory, not optional.

**Workflow revision:**
1. **Tag harvesting (offline, filesystem):** parse NKS `.nksf`, u-he `.h2p`, NKSF sidecars, folder paths. Produces `(plugin_name, preset_name) → tags[]` rows in a side table — *tags without URIs*.
2. **URI capture (online, plugin GUI walkthrough):** user loads preset in plugin's native browser, clicks a "Capture preset" button in our dev UI → script calls `save_preset(user_supplied_or_derived_name)` → records `(plugin_name, preset_name, ardour_uri)`.
3. **Join at query time:** `preset_search` joins captured URIs with harvested tags on `(plugin_name, preset_name)`. Presets without URIs yet are listed as "uncaptured" with a one-click capture-this-now affordance.

This works with organic usage — you tag as you play. No need to walk 10k presets up front; capture the ones you care about as you encounter them.

### Key primitives confirmed

```lua
-- Create a fresh plugin instance (and optionally apply a preset by URI)
local proc = ARDOUR.LuaAPI.new_plugin(Session, "<plugin_name>", ARDOUR.PluginType.VST3, "<preset_uri_or_empty>")
route:add_processor_by_index(proc, -1, nil, true)

-- Resolve + apply a preset on an existing plugin
local pl = proc:to_insert():plugin(0)
local rec = pl:preset_by_uri("<uri>")         -- or preset_by_label("<name>")
if rec and rec.valid then pl:load_preset(rec) end

-- Capture current state as a user preset (writes .vstpreset)
local cap = pl:save_preset("our_capture_name")
-- → cap.uri is the durable key to store in our index
```

## Execution plan

### Track 1 — Finish Step 0 (today, ~1 hour)
- [x] Tier 1 basic round-trip (Diva)
- [ ] Cross-instance recall (Diva)
- [ ] Tier 2 check (u-he Hive / Arturia)
- [ ] Tier 3 decision (Kontakt with loaded library)

### Track 2 — World A indexer: DONE (initial pass)

Files: `api-service/src/indexer/{h2p,vstpreset,nksf,db}.js`, `api-service/scripts/{scan-uhe,index-presets}.js`.

Run: `cd api-service && node scripts/index-presets.js`. Writes to `~/.ardour-preset-index/presets.db`.

**22,548 presets indexed** with zero errors across three sources:
- **u-he `.h2p`** — 1432 Diva patches (bank/author/usage/folder-category)
- **VST3 `.vstpreset`** — 1793 across 15+ plugins (Altiverb, Speakerphone, Softube, Waves, etc.)
- **NKSF sidecars** — 19,323 NKS-tagged presets across u-he, Arturia, Waves, UAD, Native Instruments (with full NKS Types/Sub-Types/Modes taxonomy)

Coverage: 56 distinct mode tags, 34 types, 250 subtypes. FTS5 search working (BM25 ranking). Reference: PresetMagician (<https://github.com/PresetMagician/PresetMagician>) used as implementation cross-check.

**Known TODOs for this track:**
- Duplicate rows when same preset exists as both `.h2p` and `.nksf` (e.g., Diva). Dedupe at query time or on ingest.
- Category vs. artist-folder confusion in u-he harvest.
- PLID chunk often undefined (e.g., older u-he NKSF sidecars); `plid.VST3` not always populated — track plugin matching via `bankchain[0]` for now.
- Need per-Arturia-plugin deduplication (each Arturia instrument has its own NKSF mirror under `/Library/Arturia/<Product>/Third Party/Native Instruments/presets`).

### Track 2 — World A indexer (~half day) [ORIGINAL SPEC KEPT FOR REFERENCE]
Node.js script that:
- Scans `/Library/Audio/Presets/**/*.vstpreset`, `~/Library/Audio/Presets/**/*.vstpreset`, u-he preset dirs, per-plugin NKSF sidecar locations.
- Parses what it can: VST3 MetaInfo chunk (opportunistic), u-he `.h2p` text, NKSF chunks (NISI for Types/Modes/Bankchain + PLID for plugin id).
- For each preset, calls Ardour MCP `session/lua_eval` with a script that resolves via `plugin:preset_by_label(name)` and records the URI.
- Writes SQLite:
  ```sql
  CREATE TABLE presets (
    id INTEGER PRIMARY KEY,
    plugin_uid TEXT,          -- VST3 FUID or AU subtype
    plugin_name TEXT,
    bank TEXT,
    preset_name TEXT,
    ardour_uri TEXT,          -- what we give to load_preset
    source_path TEXT,         -- original .vstpreset / .h2p / .nksf
    source_type TEXT          -- 'vstpreset'|'h2p'|'nksf'|...
  );
  CREATE TABLE preset_tags (
    preset_id INTEGER,
    axis TEXT,                -- 'type'|'subtype'|'mode'|'character'
    tag TEXT
  );
  CREATE VIRTUAL TABLE presets_fts USING fts5(
    preset_name, bank, plugin_name, tags_flat, content='presets', content_rowid='id'
  );
  ```

### Tracks 1-4 — Current state (2026-04-14 working session)

**All three MCP tools live:** `preset/search`, `preset/capture`, `preset/load`. End-to-end loop confirmed with Diva: capture state → remove plugin → load by URI → fresh instance with same sound.

**Dev UI panel added** (`api-service/public/index.html` + `app.js` + `style.css`): "Presets" section with track input, query box, `captured only` toggle, search button, and per-result Load buttons. "★ Capture current" button that prompts for preset name and calls `preset/capture`. Green left-border on rows indicates captured (loadable) presets.

**Bulk resolve helper** at `api-service/scripts/bulk-resolve.js`: given a loaded plugin on a track, iterates all harvested presets for that plugin, calls `preset_by_label` via `session/lua_eval`, and records any resolved URIs into `captured_uris`. Batched 50 at a time. Intended for Altiverb (366 IRs), Speakerphone (599), etc. — wherever Ardour can resolve `.vstpreset` factory names directly.

**Dedup** added to `searchPresets`: groups by `(plugin, preset_name)`, keeps the row with highest-priority source (`nksf` > `h2p` > `vstpreset`). Over-fetches 4× the limit to compensate.

**LLM gap-filling tagger** at `api-service/scripts/llm-tag.js`: Haiku-classifies untagged presets into NKS-aligned `{type, subtype, modes[]}`, with explicit `unknown` class, prompt caching on the taxonomy system prompt. Cost estimate: ~$0.01 per 100 presets. Usage: `ANTHROPIC_API_KEY=... node scripts/llm-tag.js [--plugin NAME] [--limit N]`.

### BREAKTHROUGH (2026-04-14) — NKSF → .vstpreset automated conversion

The crux of the "index 19k presets" problem: solved without any GUI interaction.

**Insight:** The `PCHK` chunk inside every NKSF file IS the plugin's native VST3 component state — the same bytes `IComponent::getState()` would produce. We don't need to understand the plugin's internal state format; we just need to wrap PCHK in a valid VST3 `.vstpreset` container and drop it where Ardour's VST3 preset scanner looks.

**Working implementation** (`api-service/src/indexer/nksf-to-vstpreset.js` + `scripts/convert-nksf.js`):
1. Parse NKSF → extract PCHK bytes + identify plugin FUID (from PLID chunk, or fallback to `KNOWN_FUIDS` lookup keyed by `(vendor, bankchain[0])`).
2. Build a 48-byte VST3 header + FUID + `listOffset` pointer.
3. Emit Comp + Cont chunk entries in the List (matches Ardour's own `save_preset` layout).
4. Write to `~/Library/Audio/Presets/<Vendor>/<Plugin>/` **directly — no subfolder**, because Ardour's VST3 preset scan is non-recursive (`vst3_plugin.cc:1035`, the last arg to `find_paths_matching_filter` is `false`).

**Verified end-to-end on Diva:**
- 5 Diva NKSFs converted → 5 `.vstpreset` files at `~/Library/Audio/Presets/u-he/Diva/`
- Fresh Diva plugin instance → `preset_by_label("3EE_Brass")` resolves valid=true, URI `VST3-S:D39D5B69D6AF42FA1234567844695661:3EE_Brass`
- `load_preset` returned true; user sonically confirmed the brass preset plays correctly.

**The implication:** our agent can load any one of the 19,323 NKSF-covered presets in the user's library without any prior GUI capture, as soon as `scripts/convert-nksf.js` has been run for each plugin. End of "manual capture" problem.

**Productized (2026-04-14 afternoon pass):**
- FUID map moved to `api-service/data/known-fuids.json` (loaded/saved at runtime). Seeded with Diva, Kontakt 8, Analog Lab V, Komplete Kontrol.
- `api-service/scripts/refresh-nks-index.js` — **the one-command "new plugins installed" script**. Needs a running session id. It:
  1. Lists every distinct plugin in the preset index (source_type=nksf).
  2. For any plugin without a known FUID, creates a scratch audio track, instantiates the plugin (VST3 first, AU fallback), reads `info.unique_id`, writes back to `known-fuids.json`, drops the scratch track.
  3. Runs nksf→.vstpreset conversion for every plugin that has a FUID — writes to `~/Library/Audio/Presets/<vendor>/<plugin>/` directly.
  - Usage: `node scripts/refresh-nks-index.js --sid <SESSION_ID>`.
- `preset/load` extended to resolve by `(plugin, preset_name)` in addition to `ardour_uri`. When called by name, uses `known-fuids.json` to pick the right plugin+type for `ARDOUR.LuaAPI.new_plugin`, then `preset_by_label` resolves against the on-disk `.vstpreset` files. No prior capture required.
- **Bulk result on this machine:** 1351 Diva NKSFs converted in ~8 seconds → all loadable headless via `preset/load {track, plugin: "Diva", preset_name: "..."}`.

**Remaining engineering:**
- For non-NKSF presets (pure `.h2p`, plugins without NKSF at all): vstpreset-based ones should already be auto-discovered — will verify next. `.h2p`-only case would need per-plugin state-format work (still deferred).

### Kontakt + VSL + Spitfire coverage pass (2026-04-14 evening)

**NKI walker** added at `api-service/src/indexer/nki.js` — walks Kontakt library roots for `.nki/.nkm/.nkr/.nkb` files and indexes each as a preset row (no tags, no URI — derived plugin=library-folder, bank=subfolder, preset_name=filename). Enables name-based search across all Kontakt content.

**External-volume roots** added to the NKSF scanner (narrowly scoped — `/Volumes/MacStudio WorkDrive/VSL NKS` only; broader roots caused the scanner to recursively walk million-sample trees).

**Result on this machine:**
- 35,666 `.nki` rows added — Zero G (6k), Sonic Implants (5.5k), Tonehammer (2k), Sonic Couture (2k), Triumph Audio (1.9k), etc. Spitfire libraries: 474 NKI rows under the KONTAKT2 user library + 41 under MacStudio WorkDrive.
- 35 new NKSF rows for VSL Bosendorfer 280VC + VSL Default.
- **Grand total: 58,249 preset rows indexed.**

**Loadability matrix:**
- Harvested `.vstpreset` (~1,793): auto-discovered by Ardour today, direct load.
- Converted NKSF → .vstpreset (14,717): direct load after `convert-nksf.js` run.
- Remaining NKSFs (~2,100, AU-only plugins): would need a `.aupreset` converter (follow-up).
- Kontakt `.nki` (35,666): searchable by name/folder now, URI captured on-demand via the existing `preset/capture` flow while the library is loaded in Kontakt's GUI.

### Final coverage (2026-04-15)

After VST3 directory rescan + multiple refresh-nks-index passes with the crash-safe `new_plugin_info` probe, the machine has **~19,593 directly headless-loadable presets** out of **58,254 indexed** total:

- **Factory `.vstpreset` auto-discovered by Ardour**: 1,793
- **NKSF → .vstpreset converted**: ~17,800 across 100+ plugins (every Arturia V-Collection instrument + every Arturia utility effect + u-he Diva + Waves Element/CODEX/EGP + UADx amps/synths/effects + NI Absynth 6 + NI Massive X + NI Komplete Kontrol + NI Kontakt 8)
- **Kontakt `.nki`**: 35,666 searchable, capture-on-demand via GUI when loaded

Holdouts (AU-only on this machine; stay searchable but not headless-loadable):
- **Spark** (Arturia)
- **Bosendorfer 280VC** (VSL)
- **VSL Default** (placeholder)

These are tracked in `known-fuids.json` with `uid: null` so future refresh runs skip their probes.

### KK DB import (2026-04-16)

Discovered Komplete Kontrol's `~/Library/Application Support/Native Instruments/Komplete Kontrol/Browser Data/komplete.db3` is NI's own tag catalog — `v_sound_info` view holds 38,614 rows with `name, product, bank, subbank, type, character, file_name`. Crucially KK indexes Kontakt library NKI files (e.g. Amati Viola at `/Volumes/KONTAKT2/Amati Viola Library/Instruments/`) that our filesystem walker missed.

`scripts/import-kk-tags.js` does both:
- **Enriches existing preset rows** when KK's `file_name` matches a stored `source_path`.
- **Creates new rows with `source_type='kk_db'`** for files KK knows about but we didn't scan — those come in pre-tagged from KK's taxonomy. No Boost-archive RE required; we index NI's own metadata.

First run on this machine:
- 10,649 existing rows enriched
- 27,965 new kk_db rows created (nearly all Kontakt libraries we missed)
- 254,790 tag rows written

Dedup in `searchPresets` updated to **union tags across all sibling rows** sharing `(plugin, preset_name)` — so a KK-tagged sibling's tags surface even if the displayed row is from a different source.

**Grand total: 86,214 presets indexed, 46,775 tagged (54%).**

### One-command rescan — `scripts/rescan.js`

`node scripts/rescan.js --sid <SESSION_ID>` runs all three steps in order:
1. `index-presets.js` — filesystem scan (h2p, vstpreset, nksf, nki) — idempotent via `UNIQUE(source_path)`
2. `import-kk-tags.js` — KK DB pull
3. `refresh-nks-index.js` — FUID probe + NKSF → .vstpreset conversion for new plugins

Skip flags: `--skip-index`, `--skip-kk-import`, `--skip-nks-convert`. The nks-convert step is the only one that needs a live session; drop `--sid` together with `--skip-nks-convert` to run everything else unattended.

### Usage recap

```bash
cd api-service

# One-command rescan after installing/updating plugins or libraries:
node scripts/rescan.js --sid <SESSION_ID>

# Or individually:
node scripts/index-presets.js                    # filesystem scan only
node scripts/import-kk-tags.js                   # KK DB only
node scripts/refresh-nks-index.js --sid <SID>    # FUIDs + NKSF conversion only

# Search + load (via dev UI or MCP):
POST /v1/sessions/:id/actions
  tool: 'preset/search', params: { query: 'warm bass' }
  tool: 'preset/load',   params: { track: 'Pads', plugin: 'Diva', preset_name: 'XS Warm Bass' }
  tool: 'preset/capture',params: { track: 'Kontakt', presetName: 'Amati Viola — Legato Long' }
```

### Capture UX + global hotkey (2026-04-16)

- `preset/capture` now accepts zero required params. Omit `track` → auto-uses the currently-selected route in Ardour (`Session:route_by_selected_count(0)`). Omit `presetName` → auto-names as `'<Plugin> — <yyyy-mm-dd hh:mm:ss>'`.
- `scripts/capture-selected.sh` — shell helper that finds the first ready session and curls `preset/capture`. Binds to a global hotkey via macOS Shortcuts (recipe in the script header).
- Dev UI capture button asks for an optional name, passes the track only if the field is filled.

**Usage:** the user loads any preset in a plugin's GUI, selects the track in Ardour, hits ⌘⇧C (or clicks ★ Capture), gets a macOS notification confirming the capture. Zero context switches.

### Rule-based + keyword-based tagging (2026-04-16)

`scripts/tag-by-rule.js` runs three passes:
1. **Per-plugin blanket rules** — Altiverb 8 → `type=FX subtype=Reverb` plus bank-inferred modes (Hall/Plate/Spring/Chamber); Speakerphone → `type=FX subtype=Telephone` with Phone/Radio/etc. modes; u-he Modular → `Synth`/`Modular`; Heartbeat → `Drums`; TSAR-1/Spring Reverb/Tube Delay → `FX`/`Reverb|Delay`; Valley People Dyna-Mite → `FX`/`Compressor`. 12 rules → 1,789 rows tagged.
2. **NKI keyword inference** — for every untagged `.nki` row, regex-scan preset name + last 4 path segments for instrument/character keywords. 21,532 nki rows tagged, 28,876 tag rows written.
3. **h2p → NKSF propagation** — Diva `.h2p` rows that share `(plugin, preset_name)` with a tagged NKSF inherit its tags (214 rows / 4,229 tag rows).

Result: **54% → 82% tagged** in a single run.

### One-command rescan — final pipeline (4 steps)

```bash
node scripts/rescan.js --sid <SESSION_ID>
```

1. **index**       filesystem scan (h2p / vstpreset / nksf / nki)
2. **kk-import**   Komplete Kontrol SQLite → enrich + import NKS-tagged rows
3. **nks-convert** FUID probes + NKSF → .vstpreset conversion (needs live session)
4. **tag-rules**   rule-based + keyword + h2p-propagation tagging

Skip flags: `--skip-index`, `--skip-kk-import`, `--skip-nks-convert`, `--skip-tag-rules`. Drop `--sid` when combined with `--skip-nks-convert`.

### Final coverage (2026-04-16 end of day)

| source | count | tagged | % |
|---|---|---|---|
| nksf | 19,358 | 19,356 | 100% |
| vstpreset | 1,793 | 1,789 | 100% |
| kk_db | 27,965 | 27,419 | 98% |
| nki | 35,666 | 21,532 | 60% |
| h2p | 1,432 | 214 | 15% |
| **total** | **86,214** | **70,310** | **82%** |

Capture UX: zero-input hotkey from anywhere. Load → select → ⌘⇧C → done.

### Open TODOs (2026-04-16 parked for later)

#### Loadability — the bigger gap

Of 86,214 indexed rows, only **~19,593 (23%) are loadable headless today** (factory `.vstpreset` + our NKSF→.vstpreset conversions). The remaining 77% are Kontakt libraries (`.nki`/`.nksn` = 47k rows), u-he raw `.h2p` (1.4k), and miscellaneous formats KK knows about.

**TODO #1 — NKSN → .vstpreset conversion** (priority: HIGH, effort: LOW-MEDIUM)
Use the same trick as the NKSF→.vstpreset converter. `.nksn` is NI's Kontakt snapshot format; if it has a PCHK-equivalent chunk carrying Kontakt's state, we can wrap it into a VST3 preset container and Ardour will load it just like the NKSF-converted ones. Potential unlock: **9,592 Kontakt snapshots** headless. First step: dump one `.nksn` hex, compare structure to NKSF (RIFF + MessagePack chunks?). If similar, reuse `nksf-to-vstpreset.js` with minor tweaks.

**TODO #2 — Raw `.nki` loadability** (priority: HIGH, effort: HIGH)
Kontakt's internal `.nki` files (33,914 in our index) have no headless load path today — Ardour has no way to tell Kontakt "load NKI at path X" because Kontakt's preset loading lives inside its proprietary browser. Options:
- **(a) Komplete Kontrol bridge:** script KK via its browser/MIDI CC/NKS protocol to load a specific preset, then Ardour `save_preset` to materialize a `.vstpreset` for future headless recall. Needs RE of KK's host-communication layer OR GUI automation of KK's browser.
- **(b) GUI automation** of Kontakt (AppleScript / accessibility API) to drive its browser — brittle, Kontakt's custom-drawn GUI isn't accessibility-tree friendly.
- **(c) Capture-on-demand:** accept that raw NKIs stay user-triggered. The `capture-selected.sh` hotkey flow is the pragmatic answer. Over time, organic usage builds the recall index.
- **(d) Build a host plugin wrapper** (fork JUCE AudioPluginHost) that loads Kontakt and exposes a "load NKI path" parameter — the architecture we discussed earlier but ultimately didn't need when NKSF conversion worked. Could revisit.

**TODO #3 — Audio probe embedding pipeline** (priority: MEDIUM, effort: MEDIUM-HIGH)
Enables semantic search ("sounds like X") and fills tag gaps for cryptic names. Pipeline:
1. Renderer service — headless Ardour session, for each loadable preset URI: `preset/load` → send fixed MIDI test sequence (C3 sustain + velocity sweep + chord + mod-wheel ramp, 12s) → offline render to short WAV.
2. Embedder — CLAP model (LAION music checkpoint, CPU, 512-dim vectors).
3. Storage — new table `preset_embeddings(preset_id, vec BLOB, rendered_at)`.
4. Query path — user text → CLAP text tower → cosine over stored vectors → rank with FTS results.
Scope: ~19k loadable rows × ~15s render = ~82h offline. Skip presets already well-tagged; focus on the 14k untagged cryptic NKI + 1.2k Diva h2p. Runs overnight in 2-3 batches.
Requires TODO #1 and/or #2 first if we want embeddings for Kontakt content specifically.

#### Format / coverage gaps

**TODO #4 — VST2 `.fxp` / `.fxb` scanner** (priority: LOW, effort: LOW)
Simple binary container with program name only. Adds coverage for older plugins. Rule-based tagging via plugin name after harvest.

**TODO #5 — AU `.aupreset` plist scanner** (priority: LOW, effort: LOW)
Binary plist with manufacturer/subtype/ClassInfo. Trivial to parse. Helps Logic-centric users with factory AU presets. AU is disabled in Ardour here so deprioritized.

**TODO #6 — LLM name classification for cryptic NKI** (priority: LOW, effort: LOW)
14,134 Kontakt `.nki` rows where the keyword tagger found nothing (e.g. "Tonehammer / billboard", "Zero G / Dirty Reece"). Options:
- Claude Haiku pass via Anthropic API (~$2–5 one-time for 14k).
- In-conversation via Max subscription (batches of 50-100).
- Scripts already built: `scripts/llm-tag-dump.js` + `scripts/llm-tag-apply.js`.
Skip until a specific search miss proves we need it.

**TODO #7 — Name-alias map** (priority: LOW, effort: LOW)
For cases where KK uses a different product string than the installed VST3's display name (e.g. "CODEX Stereo" in KK vs. what Ardour's plugin catalog returns). Small JSON file mapping `kk_product → ardour_plugin_name`.

**TODO #8 — Automated capture UX refinement** (priority: LOW, effort: LOW)
Post-capture prompt (inline) for naming/retagging, hotkey that also pre-fills the last-used track, session-sticky defaults. The current ⌘⇧C flow is good enough for a solo user; polish when multiple users involved.

#### Out of scope for this plan (revisit if needed)

- Splice/Loopcloud/Pianobook tag-scraping — licensing concerns, personal-use only doesn't excuse re-distribution.
- Audio content fingerprinting for duplicate detection across similar presets.
- Web-scale vector DB (pgvector, Qdrant) — 100k-row scale doesn't need it; SQLite with BLOB vectors + brute-force cosine is fine.

### Track 3 — MCP tools: IN PROGRESS (code written, requires restart to activate)

Two tools added to `mcp-tools.json` and handled in `api-service/src/routes/sessions.js` (intercepted before the generic `actionProxy.execute` path):

- **`preset/search`** — params `{ query?, plugin?, category?, axis?, tag?, capturedOnly?, limit? }` → calls `app.presetStore.search()` (SQL + FTS5 BM25). Returns `{ results: [{plugin, preset_name, bank, category, author, tags, ardour_uri, score}], count }`.
- **`preset/capture`** — params `{ track, slot?, label?, presetName?, notes? }` → proxies to `session/lua_eval` with a templated script that finds the named route, calls `plugin:save_preset(label)`, returns the URI. Parses the Lua output and writes a row to `captured_uris` via `app.presetStore.recordCapture()`.

New file: `api-service/src/lib/preset-store.js` (opens index DB lazily, one per Fastify process).

Decorated: `app.presetStore` in `server.js`.

**Remaining:** restart api-service (will lose in-memory session state), smoke-test the two tools end-to-end, then write Favorites in the dev UI for fast capture.

### Track 3 — MCP `preset_search` tool (~1 day) [ORIGINAL SPEC KEPT FOR REFERENCE]
- Input: `query` (natural text), optional filters (`type`, `mode`, `plugin`).
- Phase A implementation: SQL FTS over name+tags. No embeddings yet.
- Output: top-N results with `{ardour_uri, plugin_name, preset_name, tags, score}`.
- Companion tool `preset_load`: takes `{trackId, ardour_uri}`, loads plugin if missing + applies preset via `load_preset`.

### Track 4 — LLM gap-filling (~half day)
- For presets with no extracted tags: Claude Haiku batch classification of `{plugin, folder_path, filename, author}` into the NKS schema.
- Structured output with explicit `"unknown"` class — no forced-fit.
- Expected cost: ~$5–10 for full personal library.
- Expected accuracy: 75–85% coarse, 55–65% character. Eyeball 50 samples, manually correct high-use plugins.

### Track 5 — World B ingestion (deferred until Step 0 Tier 3 result is in)
Strategy depends on outcome:
- **If Kontakt `save_preset` round-trips:** same as World A, just ingest via one-time GUI walk-through per library. Human clicks, script calls `save_preset` after each.
- **If it doesn't:** build a host plugin wrapper (JUCE `AudioPluginHost` fork) that captures/restores state around the child. Or use Claude computer-use to drive plugin GUIs. Or accept "only the top 100 presets per library I actually use" for personal scope.

### Track 6 — Audio probe (only if needed)
For presets that name-classification can't handle (encrypted Kontakt libs, generic "Init" names):
- Load preset → send 12s multi-probe (sustained C3 + velocity sweep + chord + arpeggio + mod-wheel ramp) → render offline → embed with LAION-CLAP.
- Store vectors in local SQLite (personal scale; no pgvector needed).
- Extend `preset_search` to union SQL FTS + vector cosine.
- Audio embeddings stay local (legal line: don't redistribute).

## Tag schema (NKS-shaped, personal-use-simplified)

```
type:       single value, required (Bass|Keys|Pads|Strings|Leads|Drums|...)
subtype:    single value, optional (Analog|FM|Plucked|Sub|Evolving|...)
character:  multi-label (Bright|Dark|Warm|Gritty|LoFi|Cinematic|...)
mood:       optional (Ambient|Epic|Intimate|Retro|Modern)
```

Harvested directly from NKS files where available; LLM-inferred elsewhere.

## MCP surface (final)

- `preset_search(query, type?, subtype?, character?, mood?, plugin?, limit?)`
  → `{ results: [{ardour_uri, plugin_name, preset_name, tags, score}] }`
- `preset_load(trackId, ardour_uri, createPluginIfMissing?)`
  → `{ success, plugin_uid, applied_uri }`

## What's explicitly out of scope

- No decryption of encrypted Kontakt libraries (DMCA §1201 line).
- No distribution of metadata, embeddings, or captured state blobs.
- No SaaS / upload of the index.
- No redistribution of factory preset names as a dataset.
- No "universal" indexer — this is my machine, my library, my plugins.

## Open questions for later

- Does Kontakt `save_preset` round-trip? (Step 0 Tier 3 test.)
- Does `preset_by_uri` resolve across Ardour sessions / plugin reinstantiations? (Step 0 cross-instance test.)
- For plugins where `info:get_presets()` returns empty (observed on Diva), can we still resolve factory presets via `preset_by_label`? How does Ardour populate its preset list?
- Do I need embeddings at all, or is tag+name FTS enough at personal scale? Answer after Track 3.
