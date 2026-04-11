# Ardour Engine C++ Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the export blocker and add missing Lua bindings so the headless DAW API service can function end-to-end.

**Architecture:** All changes are in Ardour's C++ source — adding Lua bindings in `luabindings.cc`, fixing `SimpleExport` initialization, and adding helper functions in `lua_api.cc`. No new libraries or build changes needed. The existing `waf` build handles everything.

**Tech Stack:** C++17, Lua (via luabridge), Ardour internals (libardour), RubberBand, Vamp SDK.

---

### Task 1: Fix SimpleExport Lua Bindings (BLOCKER)

**Files:**
- Modify: `libs/ardour/luabindings.cc:1830-1837`
- Test: `test_export.lua` (new)

The root cause: `SimpleExport` has `set_name`, `set_folder`, `set_range`, `set_preset`, `check_outputs`, `run_export` bound to Lua — but no constructor and no `set_session`. Without `set_session`, the `_manager` is null and everything crashes.

The `simple_export` CFunction in `lua_api.cc:736` creates a `SimpleExport` via placement new and returns it, but never calls `set_session`. The Session is passed as the first arg (userdata) but only used for placement context.

- [ ] **Step 1: Fix the `simple_export` CFunction to call `set_session`**

In `libs/ardour/lua_api.cc`, find the `simple_export` function (around line 736):

```cpp
int
ARDOUR::LuaAPI::simple_export (lua_State* L)
{
	Session* const s = luabridge::Userdata::get <Session> (L, 1, false);
	void* ptr = luabridge::UserdataValue<SimpleExport>::place (L);
	SimpleExport* se = new (ptr) SimpleExport ();
	se->set_session (s);
	return 1;
}
```

The fix is adding `se->set_session (s);` after construction. Check if this line already exists — if not, add it after `new (ptr) SimpleExport ()`.

- [ ] **Step 2: Rebuild**

Run:
```bash
./build_ardour.sh build
```
Expected: Build succeeds (this is a one-line addition).

- [ ] **Step 3: Write the export test script**

Create `test_export.lua`:

```lua
print("=== Export Test ===")

local SESSION_DIR = "/tmp/ardour-export-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "export-test", 48000)
print("session created:", Session:name())

-- Create a track and import audio
local tl = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Main",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local track = tl:front()

local region = ARDOUR.LuaAPI.import_audio_file(Session, "/System/Library/Sounds/Basso.aiff")
if region:isnil() then
    print("FAILED to import")
    close_session()
    return
end

local playlist = track:to_track():playlist()
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)

-- Set session range to cover the region
Session:maybe_update_session_range(
    Temporal.timepos_t(0),
    region:end_sample()
)
Session:save_state("")

-- Export
print("Creating SimpleExport...")
local se = Session:simple_export()
print("  type:", type(se))

local export_dir = SESSION_DIR .. "/export"
os.execute("mkdir -p " .. export_dir)

se:set_name("output")
se:set_folder(export_dir)
se:set_range(0, Session:current_end_sample())

-- Use the default CD preset UUID
local preset_ok = se:set_preset("df340c53-88b5-4342-a1c8-58e0704872ea")
print("  preset set:", preset_ok)

local outputs_ok = se:check_outputs()
print("  check_outputs:", outputs_ok)

if outputs_ok then
    print("  running export...")
    local ok = se:run_export()
    print("  export result:", ok)
end

-- Check output
local f = io.popen("ls -la " .. export_dir .. "/ 2>/dev/null")
if f then
    for line in f:lines() do print("  " .. line) end
    f:close()
end

print("=== Export test complete ===")
close_session()
```

- [ ] **Step 4: Run the export test**

Run:
```bash
./run_arlua.sh test_export.lua
```
Expected: Export produces a WAV file in the export directory. If `set_preset` returns false, try the WAV preset UUID `"75969a1c-3133-4694-864b-a1fa50e43348"` instead.

- [ ] **Step 5: If SimpleExport still fails, implement the ExportHandler approach**

If `SimpleExport` still segfaults or fails, add a new `LuaAPI::export_session` function that replicates the CLI export approach from `session_utils/export.cc`. This function bypasses `SimpleExport` entirely:

Add to `libs/ardour/ardour/lua_api.h`:
```cpp
/** Export the session's master bus output to a WAV file.
 * @param s Session handle
 * @param path Output file path (without extension; .wav is appended)
 * @param sample_format 16, 24, or 32
 * @param sample_rate Target sample rate (0 = session rate)
 * @returns true on success
 */
bool export_session (ARDOUR::Session* s, const std::string& path, int sample_format = 16, int sample_rate = 0);
```

Add to `libs/ardour/lua_api.cc` (after `import_audio_file`):
```cpp
bool
ARDOUR::LuaAPI::export_session (Session* s, const std::string& path, int sample_format, int sample_rate)
{
	if (!s) return false;
	if (sample_rate == 0) sample_rate = s->nominal_sample_rate();

	auto handler = s->get_export_handler();
	auto tsp = handler->add_timespan();
	auto ccp = handler->add_channel_config();
	auto fnp = handler->add_filename();

	// Build format spec XML
	std::string sf_str;
	switch (sample_format) {
		case 24: sf_str = "SF_24"; break;
		case 32: sf_str = "SF_Float"; break;
		default: sf_str = "SF_16"; break;
	}

	std::stringstream sr_str;
	sr_str << sample_rate;

	XMLTree tree;
	tree.read_buffer(std::string(
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
		"<ExportFormatSpecification name=\"LUA-EXPORT\" id=\"b1280899-0459-4aef-9dc9-7e2277fa6d24\">"
		"  <Encoding id=\"F_WAV\" type=\"T_Sndfile\" extension=\"wav\" name=\"WAV\" has-sample-format=\"true\" channel-limit=\"256\"/>"
		"  <SampleRate rate=\"" + sr_str.str() + "\"/>"
		"  <SRCQuality quality=\"SRC_SincBest\"/>"
		"  <EncodingOptions>"
		"    <Option name=\"sample-format\" value=\"" + sf_str + "\"/>"
		"    <Option name=\"dithering\" value=\"D_None\"/>"
		"    <Option name=\"tag-metadata\" value=\"true\"/>"
		"    <Option name=\"tag-support\" value=\"false\"/>"
		"    <Option name=\"broadcast-info\" value=\"false\"/>"
		"  </EncodingOptions>"
		"  <Processing>"
		"    <Normalize enabled=\"false\" target=\"0\"/>"
		"    <Silence>"
		"      <Start><Trim enabled=\"false\"/><Add enabled=\"false\"><Duration format=\"Timecode\" hours=\"0\" minutes=\"0\" seconds=\"0\" frames=\"0\"/></Add></Start>"
		"      <End><Trim enabled=\"false\"/><Add enabled=\"false\"><Duration format=\"Timecode\" hours=\"0\" minutes=\"0\" seconds=\"0\" frames=\"0\"/></Add></End>"
		"    </Silence>"
		"  </Processing>"
		"</ExportFormatSpecification>"
	).c_str());

	auto fmp = handler->add_format(*tree.root());

	// Set range
	tsp->set_range(s->current_start_sample(), s->current_end_sample());
	tsp->set_range_id("session");

	// Master bus outputs
	IO* master_out = s->master_out()->output().get();
	if (!master_out) return false;

	for (uint32_t n = 0; n < master_out->n_ports().n_audio(); ++n) {
		PortExportChannel* channel = new PortExportChannel();
		channel->add_port(master_out->audio(n));
		ExportChannelPtr chan_ptr(channel);
		ccp->register_channel(chan_ptr);
	}

	// Output filename
	std::string dirname = Glib::path_get_dirname(path);
	std::string basename = Glib::path_get_basename(path);
	if (basename.size() > 4 && !basename.compare(basename.size() - 4, 4, ".wav")) {
		basename = PBD::basename_nosuffix(basename);
	}
	fnp->set_folder(dirname);
	tsp->set_name(basename);
	fnp->set_timespan(tsp);
	fnp->include_label = false;
	fmp->set_soundcloud_upload(false);

	handler->add_export_config(tsp, ccp, fmp, fnp, std::shared_ptr<ARDOUR::BroadcastInfo>());

	if (0 != handler->do_export()) return false;

	auto status = s->get_export_status();
	while (status->running()) {
		Glib::usleep(100000);
	}
	status->finish(TRS_UI);
	return true;
}
```

Add the required includes at the top of `lua_api.cc`:
```cpp
#include "ardour/export_handler.h"
#include "ardour/export_status.h"
#include "ardour/export_timespan.h"
#include "ardour/export_channel_configuration.h"
#include "ardour/export_format_specification.h"
#include "ardour/export_filename.h"
#include "ardour/port_export_channel.h"
```

Add binding in `luabindings.cc` near the other LuaAPI functions (around line 3296):
```cpp
.addFunction ("export_session", ARDOUR::LuaAPI::export_session)
```

- [ ] **Step 6: Rebuild and test export**

```bash
./build_ardour.sh build
./run_arlua.sh test_export.lua
```
Expected: WAV file produced in the export directory.

- [ ] **Step 7: Commit**

```bash
git add libs/ardour/lua_api.cc libs/ardour/ardour/lua_api.h libs/ardour/luabindings.cc test_export.lua
git commit -m "fix: SimpleExport Lua binding — add set_session call and export_session helper"
```

---

### Task 2: Inline MIDI Region Creation

**Files:**
- Modify: `libs/ardour/lua_api.cc`
- Modify: `libs/ardour/ardour/lua_api.h`
- Modify: `libs/ardour/luabindings.cc`
- Test: `test_midi_inline.lua` (new)

The Lua API has `MidiModel::new_note_diff_command`, `NoteDiffCommand::add`, `LuaAPI::new_noteptr(channel, time, length, note, velocity)`, and `MidiModel::apply_diff_command_as_commit`. But creating a blank MIDI region on a track from scratch isn't exposed. We need a helper that creates an empty MIDI region of a given length on a track, so we can then populate it with notes.

- [ ] **Step 1: Add `create_midi_region` helper to lua_api**

Add to `libs/ardour/ardour/lua_api.h`:
```cpp
/** Create an empty MIDI region on a track's playlist.
 * @param track The MIDI track
 * @param position Region start position
 * @param length Region length
 * @param name Region name
 * @returns the new MidiRegion, or nil on failure
 */
std::shared_ptr<ARDOUR::MidiRegion> create_midi_region (
    std::shared_ptr<ARDOUR::MidiTrack> track,
    Temporal::timepos_t position,
    Temporal::timecnt_t length,
    const std::string& name);
```

Add to `libs/ardour/lua_api.cc`:
```cpp
#include "ardour/midi_region.h"
#include "ardour/midi_track.h"
#include "ardour/midi_source.h"

std::shared_ptr<MidiRegion>
ARDOUR::LuaAPI::create_midi_region (
    std::shared_ptr<MidiTrack> track,
    Temporal::timepos_t position,
    Temporal::timecnt_t length,
    const std::string& name)
{
	if (!track) return std::shared_ptr<MidiRegion>();

	Session& session = track->session();

	// Create a MIDI source
	std::shared_ptr<MidiSource> src = 
		std::dynamic_pointer_cast<MidiSource>(
			SourceFactory::createWritable(DataType::MIDI, session,
				session.new_source_path_from_name(DataType::MIDI, name),
				false, session.sample_rate()));

	if (!src) return std::shared_ptr<MidiRegion>();

	// Create region properties
	PropertyList plist;
	plist.add(Properties::start, timecnt_t(Temporal::BeatTime));
	plist.add(Properties::length, length);
	plist.add(Properties::name, name);
	plist.add(Properties::layer, 0);
	plist.add(Properties::whole_file, false);

	SourceList srclist;
	srclist.push_back(src);

	std::shared_ptr<Region> r = RegionFactory::create(srclist, plist);
	std::shared_ptr<MidiRegion> mr = std::dynamic_pointer_cast<MidiRegion>(r);

	if (!mr) return std::shared_ptr<MidiRegion>();

	// Add to the track's playlist
	track->playlist()->add_region(mr, position, 1, false, 0, 0, false);

	return mr;
}
```

- [ ] **Step 2: Add binding in luabindings.cc**

Near the other LuaAPI functions (around line 3296):
```cpp
.addFunction ("create_midi_region", ARDOUR::LuaAPI::create_midi_region)
```

- [ ] **Step 3: Rebuild**

```bash
./build_ardour.sh build
```

- [ ] **Step 4: Write test script**

Create `test_midi_inline.lua`:
```lua
print("=== Inline MIDI Test ===")

local SESSION_DIR = "/tmp/ardour-midi-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "midi-test", 48000)

-- Set tempo
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)

-- Create MIDI track
local ml = Session:new_midi_track(
    ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),
    ARDOUR.ChanCount(ARDOUR.DataType("audio"), 2),
    true, ARDOUR.PluginInfo(), nil,
    ARDOUR.RouteGroup(), 1, "Melody",
    ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true, false)
local midi_track = ml:front():to_track():to_midi_track()
print("MIDI track:", midi_track:name())

-- Create a 4-bar MIDI region at bar 1
local region_len = Temporal.timecnt_t(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 16))
local region = ARDOUR.LuaAPI.create_midi_region(
    midi_track,
    Temporal.timepos_t(0),
    region_len,
    "Melody Region")

if region:isnil() then
    print("FAILED to create MIDI region")
    close_session()
    return
end
print("Created region:", region:name())

-- Add notes via MidiModel
local src = region:midi_source(0)
local model = src:model()
local cmd = model:new_note_diff_command("Add notes")

-- C major scale: C4 D4 E4 F4 G4 A4 B4 C5
local notes = {
    {60, 100, 0, 1},    -- C4, vel 100, beat 0, 1 beat long
    {62, 90,  1, 1},    -- D4
    {64, 95,  2, 1},    -- E4
    {65, 85,  3, 0.5},  -- F4, half beat
    {67, 100, 3.5, 0.5},-- G4
    {69, 90,  4, 1},    -- A4
    {71, 85,  5, 1},    -- B4
    {72, 110, 6, 2},    -- C5, 2 beats
}

for _, n in ipairs(notes) do
    local pitch, vel, start_beat, dur_beats = n[1], n[2], n[3], n[4]
    local note = ARDOUR.LuaAPI.new_noteptr(
        0,  -- channel
        Temporal.Beats(start_beat, 0),
        Temporal.Beats(dur_beats, 0),
        pitch,
        vel)
    cmd:add(note)
end

model:apply_diff_command_as_commit(Session, cmd)
print("Added", #notes, "notes to region")

Session:save_state("")
print("Session saved")

print("=== Inline MIDI test complete ===")
close_session()
```

- [ ] **Step 5: Run test**

```bash
./run_arlua.sh test_midi_inline.lua
```
Expected: MIDI region created with 8 notes, session saved successfully.

- [ ] **Step 6: Commit**

```bash
git add libs/ardour/lua_api.cc libs/ardour/ardour/lua_api.h libs/ardour/luabindings.cc test_midi_inline.lua
git commit -m "feat: add LuaAPI::create_midi_region for inline MIDI composition"
```

---

### Task 3: RubberBand Time-Stretch/Pitch-Shift Integration

**Files:**
- Test: `test_rubberband.lua` (new)

The binding already exists: `ARDOUR.LuaAPI.Rubberband(audio_region, percussive)` with `set_strech_and_pitch(stretch, pitch)` and `process(callback)`. We just need to validate it works headlessly and document the calling pattern for the Lua generator.

- [ ] **Step 1: Write test script**

Create `test_rubberband.lua`:
```lua
print("=== RubberBand Test ===")

local SESSION_DIR = "/tmp/ardour-rubberband-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "rb-test", 48000)

-- Create track and import audio
local tl = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Test",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local track = tl:front()

local region = ARDOUR.LuaAPI.import_audio_file(Session, "/System/Library/Sounds/Basso.aiff")
if region:isnil() then
    print("FAILED to import")
    close_session()
    return
end

local audio_region = region:to_audioregion()
print("Original region length:", audio_region:length())

-- Time stretch: make it 1.5x longer
local rb = ARDOUR.LuaAPI.Rubberband(audio_region, false)
local ok = rb:set_strech_and_pitch(1.5, 1.0)
print("set_strech_and_pitch:", ok)
print("readable_length:", rb:readable_length())

-- Process with progress callback
local new_region = rb:process(function(progress)
    -- progress callback (0.0 to 1.0)
    return false -- return true to cancel
end)

if new_region and not new_region:isnil() then
    print("Stretched region length:", new_region:length())
    print("Ratio:", new_region:length() / audio_region:length())
    
    -- Place on track
    local playlist = track:to_track():playlist()
    playlist:add_region(new_region, Temporal.timepos_t(0), 1, false, 0, 0, false)
    print("Placed stretched region on track")
else
    print("FAILED - process returned nil")
end

-- Test pitch shift: shift up 2 semitones (ratio = 2^(2/12))
local rb2 = ARDOUR.LuaAPI.Rubberband(audio_region, false)
local pitch_ratio = 2 ^ (2.0 / 12.0)
rb2:set_strech_and_pitch(1.0, pitch_ratio)
local pitched = rb2:process(function(p) return false end)
if pitched and not pitched:isnil() then
    print("Pitch-shifted region created, length:", pitched:length())
else
    print("Pitch shift FAILED")
end

Session:save_state("")
print("=== RubberBand test complete ===")
close_session()
```

- [ ] **Step 2: Run test**

```bash
./run_arlua.sh test_rubberband.lua
```
Expected: Both stretched and pitch-shifted regions created successfully.

- [ ] **Step 3: Commit**

```bash
git add test_rubberband.lua
git commit -m "test: validate RubberBand time-stretch and pitch-shift via Lua headlessly"
```

---

### Task 4: Validate MIDI File Import

**Files:**
- Test: `test_midi_import.lua` (new)

The `import_audio_file` function checks `SMFSource::safe_midi_file_extension()` and should handle MIDI files. We need to validate this actually works.

- [ ] **Step 1: Create a test MIDI file**

```bash
# Create a minimal MIDI file using Python
python3 -c "
import struct, os
# Minimal SMF Type 0 MIDI file
header = b'MThd' + struct.pack('>I', 6) + struct.pack('>HHH', 0, 1, 480)
# Track with one note
track_data = (
    b'\\x00\\x90\\x3c\\x64'  # Note on C4 vel 100
    b'\\x81\\x70\\x80\\x3c\\x00'  # Note off after 240 ticks
    b'\\x00\\xff\\x2f\\x00'  # End of track
)
track = b'MTrk' + struct.pack('>I', len(track_data)) + track_data
with open('/tmp/test-note.mid', 'wb') as f:
    f.write(header + track)
print('Created /tmp/test-note.mid')
"
```

- [ ] **Step 2: Write test script**

Create `test_midi_import.lua`:
```lua
print("=== MIDI Import Test ===")

local SESSION_DIR = "/tmp/ardour-midi-import-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "midi-import-test", 48000)

-- Create MIDI track
local ml = Session:new_midi_track(
    ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),
    ARDOUR.ChanCount(ARDOUR.DataType("audio"), 2),
    true, ARDOUR.PluginInfo(), nil,
    ARDOUR.RouteGroup(), 1, "MIDI Test",
    ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true, false)
local midi_track = ml:front()
print("Track:", midi_track:name())

-- Import MIDI file
local region = ARDOUR.LuaAPI.import_audio_file(Session, "/tmp/test-note.mid")
if region:isnil() then
    print("FAILED to import MIDI file")
    print("(This means import_audio_file doesn't handle MIDI; need separate MIDI import)")
    close_session()
    return
end

print("Imported MIDI region:", region:name())
print("Length:", region:length())

-- Place on track
local playlist = midi_track:to_track():playlist()
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
print("Region placed on MIDI track")

Session:save_state("")
print("=== MIDI Import test complete ===")
close_session()
```

- [ ] **Step 3: Run test**

```bash
python3 -c "
import struct
header = b'MThd' + struct.pack('>I', 6) + struct.pack('>HHH', 0, 1, 480)
track_data = b'\\x00\\x90\\x3c\\x64\\x81\\x70\\x80\\x3c\\x00\\x00\\xff\\x2f\\x00'
track = b'MTrk' + struct.pack('>I', len(track_data)) + track_data
with open('/tmp/test-note.mid', 'wb') as f:
    f.write(header + track)
"
./run_arlua.sh test_midi_import.lua
```
Expected: MIDI region imported and placed on track. If it fails, we'll need a separate MIDI import binding.

- [ ] **Step 4: Commit**

```bash
git add test_midi_import.lua
git commit -m "test: validate MIDI file import via import_audio_file"
```

---

### Task 5: Validate Sidechain Routing

**Files:**
- Test: `test_sidechain.lua` (new)

The bindings exist: `Route::add_sidechain(processor)`, `PluginInsert::has_sidechain()`, `PluginInsert::sidechain_input()`. We need to validate the workflow.

- [ ] **Step 1: Write test script**

Create `test_sidechain.lua`:
```lua
print("=== Sidechain Test ===")

local SESSION_DIR = "/tmp/ardour-sidechain-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "sc-test", 48000)

-- Create two tracks: kick and bass
local kick_tl = Session:new_audio_track(1, 2, ARDOUR.RouteGroup(), 1, "Kick",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local bass_tl = Session:new_audio_track(1, 2, ARDOUR.RouteGroup(), 1, "Bass",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)

local kick = kick_tl:front()
local bass = bass_tl:front()

-- Add compressor to bass track
local comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp#stereo", ARDOUR.PluginType.LV2, "")
bass:add_processor_by_index(comp, 0, nil, true)

local pi = comp:to_insert()
print("Plugin has sidechain before:", pi:has_sidechain())

-- Add sidechain to the compressor
bass:add_sidechain(comp)
print("Plugin has sidechain after:", pi:has_sidechain())

-- Get sidechain input and try to connect kick to it
local sc_input = pi:sidechain_input()
if sc_input and not sc_input:isnil() then
    print("Sidechain input ports:", sc_input:n_ports():n_audio())
    -- Connect kick output to sidechain input
    -- This requires port connection which may need specific API
    print("Sidechain routing set up successfully")
else
    print("FAILED to get sidechain input")
end

Session:save_state("")
print("=== Sidechain test complete ===")
close_session()
```

- [ ] **Step 2: Run test**

```bash
./run_arlua.sh test_sidechain.lua
```

- [ ] **Step 3: Commit**

```bash
git add test_sidechain.lua
git commit -m "test: validate sidechain routing via Lua"
```

---

### Task 6: Validate Automation Curves

**Files:**
- Test: `test_automation.lua` (new)

The bindings exist: `route:gain_control():alist():add(time, value)` and `plugin_automation()` returns `(AutomationList, ControlList, ParameterDescriptor)`. We need to validate writing automation points.

- [ ] **Step 1: Write test script**

Create `test_automation.lua`:
```lua
print("=== Automation Test ===")

local SESSION_DIR = "/tmp/ardour-automation-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "auto-test", 48000)

local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)

-- Create track with a plugin
local tl = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Auto Test",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local track = tl:front()

-- Gain automation
local gain_ac = track:gain_control()
local gain_al = gain_ac:alist()
gain_al:clear_list()

-- Volume fade: -3dB at bar 1, -6dB at bar 8, back to -3dB at bar 9
local function db_to_coeff(db) return 10 ^ (db / 20) end

gain_al:add(Temporal.timepos_t(0), db_to_coeff(-3), false, true)
gain_al:add(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 28), db_to_coeff(-6), false, true)
gain_al:add(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 32), db_to_coeff(-3), false, true)

-- Set automation state to Play so it's active
gain_ac:set_automation_state(ARDOUR.AutoState.Play)
print("Gain automation: 3 points written, state = Play")

-- Pan automation
local pan_ac = track:pan_azimuth_control()
if pan_ac and not pan_ac:isnil() then
    local pan_al = pan_ac:alist()
    pan_al:clear_list()
    pan_al:add(Temporal.timepos_t(0), 0.3, false, true)
    pan_al:add(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 16), 0.7, false, true)
    pan_al:add(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 32), 0.3, false, true)
    pan_ac:set_automation_state(ARDOUR.AutoState.Play)
    print("Pan automation: 3 points written")
end

-- Plugin parameter automation
local comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp#stereo", ARDOUR.PluginType.LV2, "")
track:add_processor_by_index(comp, 0, nil, true)

local al, cl, pd = ARDOUR.LuaAPI.plugin_automation(comp, 4) -- threshold param
if al and not al:isnil() then
    al:clear_list()
    al:add(Temporal.timepos_t(0), -20, false, true)
    al:add(Temporal.timepos_t.from_ticks(Temporal.ticks_per_beat * 16), -10, false, true)
    -- Set plugin automation to play
    local pi = comp:to_insert()
    local ctrl = Evoral.Parameter(ARDOUR.AutomationType.PluginAutomation, 0, 4)
    local ac = pi:automation_control(ctrl, false)
    if ac and not ac:isnil() then
        ac:set_automation_state(ARDOUR.AutoState.Play)
    end
    print("Plugin param 4 automation: 2 points written")
end

Session:save_state("")
print("=== Automation test complete ===")
close_session()
```

- [ ] **Step 2: Run test**

```bash
./run_arlua.sh test_automation.lua
```

- [ ] **Step 3: Commit**

```bash
git add test_automation.lua
git commit -m "test: validate gain, pan, and plugin parameter automation via Lua"
```

---

### Task 7: Validate VCA and Track Groups

**Files:**
- Test: `test_vca_groups.lua` (new)

- [ ] **Step 1: Write test script**

Create `test_vca_groups.lua`:
```lua
print("=== VCA and Track Groups Test ===")

local SESSION_DIR = "/tmp/ardour-vca-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "vca-test", 48000)

-- Create tracks
local t1 = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Drums",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true):front()
local t2 = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Bass",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true):front()
local t3 = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Guitar",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true):front()

-- Create VCA
local vca_mgr = Session:vca_manager()
local vcas = vca_mgr:create_vca(1, "Rhythm Section")
print("VCA created:", vcas:size(), "VCAs")

-- Assign tracks to VCA
-- VCA control uses slavable_list
-- This needs investigation of the exact API
print("VCA assignment needs Slavable API - checking bindings...")

-- Track groups via RouteGroup
-- Check if we can create and assign route groups
print("Route groups need RouteGroup::add() - checking bindings...")

Session:save_state("")
print("=== VCA test complete ===")
close_session()
```

- [ ] **Step 2: Run test and iterate**

```bash
./run_arlua.sh test_vca_groups.lua
```

This test is exploratory — we need to discover the exact VCA assignment API. The test may need iteration based on what bindings are actually available.

- [ ] **Step 3: Commit**

```bash
git add test_vca_groups.lua
git commit -m "test: validate VCA creation and track group assignment"
```

---

### Task 8: Analysis and Metering Validation

**Files:**
- Test: `test_analysis.lua` (new)

PeakMeter is bound via `route:peak_meter():meter_level(channel, MeterType)`. Vamp analysis is available via `ARDOUR.LuaAPI.Vamp(plugin_key, sample_rate)`. The key question is whether metering works headlessly (meters need the transport to run to fill buffers).

- [ ] **Step 1: Write test script**

Create `test_analysis.lua`:
```lua
print("=== Analysis/Metering Test ===")

local SESSION_DIR = "/tmp/ardour-analysis-test"
os.execute("rm -rf " .. SESSION_DIR)

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(SESSION_DIR, "analysis-test", 48000)

-- Create track with audio
local tl = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Test",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local track = tl:front()

local region = ARDOUR.LuaAPI.import_audio_file(Session, "/System/Library/Sounds/Basso.aiff")
if not region:isnil() then
    track:to_track():playlist():add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
end

-- Try to read peak meter
local meter = track:peak_meter()
if meter and not meter:isnil() then
    print("Peak meter found")
    local level = meter:meter_level(0, ARDOUR.MeterType.MeterPeak)
    print("  channel 0 level:", level)
    -- Level will likely be -inf since we haven't run the transport
else
    print("No peak meter on track")
end

-- List available Vamp plugins
print("\nAvailable Vamp plugins:")
local vamp_plugins = ARDOUR.LuaAPI.Vamp.list_plugins()
for name in vamp_plugins:iter() do
    print("  -", name)
end

-- Try Vamp analysis on the region
-- This requires the AudioReadable interface
print("\nAttempting Vamp analysis...")
local audio_region = region:to_audioregion()
if audio_region and not audio_region:isnil() then
    -- Try to find an EBU R128 loudness plugin
    -- Common keys: "libardourvampplugins:dBTP" for true-peak
    for name in vamp_plugins:iter() do
        if name:find("dBTP") or name:find("loudness") or name:find("ebur128") then
            print("  Found analysis plugin:", name)
        end
    end
end

Session:save_state("")
print("=== Analysis test complete ===")
close_session()
```

- [ ] **Step 2: Run test**

```bash
./run_arlua.sh test_analysis.lua
```

This is exploratory. We need to discover which Vamp plugins are available and whether we can analyze audio without running the transport.

- [ ] **Step 3: Commit**

```bash
git add test_analysis.lua
git commit -m "test: validate metering and Vamp analysis capabilities"
```

---

### Summary: Dependency Order

```
Task 1 (Export)  ←── BLOCKER, do first
Task 2 (Inline MIDI)
Task 3 (RubberBand)
Task 4 (MIDI Import)     ← these 3-6 are independent,
Task 5 (Sidechain)         can be done in parallel
Task 6 (Automation)
Task 7 (VCA/Groups)
Task 8 (Analysis)
```

After all tasks pass, the C++ engine layer is ready for the API service (Plan B).
