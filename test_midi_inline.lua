-- test_midi_inline.lua
-- Test inline MIDI region creation and note population
-- Run with: ./run_arlua.sh test_midi_inline.lua

-- 1. Set up Dummy backend and create session
backend = AudioEngine:set_backend("None (Dummy)", "", "")
assert(backend, "Failed to set Dummy backend")
backend:set_device_name("Uniform White Noise")

os.execute("rm -rf /tmp/ardour-midi-test")
s = create_session("/tmp/ardour-midi-test", "midi-test", 48000)
assert(s, "Failed to create session")

-- 2. Set tempo to 120 BPM
local tmap = Temporal.TempoMap.write_copy()
assert(tmap, "Failed to get writable TempoMap")
tmap:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
Temporal.TempoMap.update(tmap)
tmap = nil

print("Session created, tempo set to 120 BPM")

-- 3. Create a MIDI track
-- Create a route group to satisfy the shared_ptr<RouteGroup> argument
local group = s:new_route_group("midi-test-group")

local track_list = s:new_midi_track(
   ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),  -- input
   ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),  -- output
   true,              -- strict_io
   ARDOUR.PluginInfo(),  -- no instrument
   nil,               -- preset
   group,             -- route_group
   1,                 -- how_many
   "",                -- name_template
   ARDOUR.PresentationInfo.max_order,
   ARDOUR.TrackMode.Normal,
   true               -- input_auto_connect
)

assert(track_list and not track_list:empty(), "Failed to create MIDI track")

local midi_track = track_list:front():to_midi_track()
assert(midi_track, "Failed to cast to MidiTrack")
print("MIDI track created: " .. midi_track:name())

-- 4. Create a 4-bar MIDI region
-- At 120 BPM, 4/4 time: 4 bars = 16 quarter notes = 16 beats
local ticks_per_beat = 1920
local region_length_ticks = 16 * ticks_per_beat  -- 4 bars

local position = Temporal.timepos_t.from_ticks(0)
local length = Temporal.timecnt_t.from_ticks(region_length_ticks)

local region = ARDOUR.LuaAPI.create_midi_region(midi_track, position, length, "Melody")
assert(region, "Failed to create MIDI region")
print("MIDI region created: " .. region:name())

-- 5. Get the MidiModel
local midi_src = region:midi_source(0)
assert(midi_src, "Failed to get MIDI source")
local model = midi_src:model()
assert(model, "Failed to get MidiModel")

-- 6. Add notes - a simple melody (C major scale, quarter notes)
local cmd = model:new_note_diff_command("Add notes")
assert(cmd, "Failed to create note diff command")

-- Define a simple melody: C D E F G A B C (quarter notes)
local notes = {
   { pitch = 60, start_beat = 0,  dur = 1 },  -- C4
   { pitch = 62, start_beat = 1,  dur = 1 },  -- D4
   { pitch = 64, start_beat = 2,  dur = 1 },  -- E4
   { pitch = 65, start_beat = 3,  dur = 1 },  -- F4
   { pitch = 67, start_beat = 4,  dur = 1 },  -- G4
   { pitch = 69, start_beat = 5,  dur = 1 },  -- A4
   { pitch = 71, start_beat = 6,  dur = 1 },  -- B4
   { pitch = 72, start_beat = 7,  dur = 1 },  -- C5
   -- Second half: descending with half notes
   { pitch = 71, start_beat = 8,  dur = 2 },  -- B4
   { pitch = 67, start_beat = 10, dur = 2 },  -- G4
   { pitch = 64, start_beat = 12, dur = 2 },  -- E4
   { pitch = 60, start_beat = 14, dur = 2 },  -- C4
}

local channel = 0
local velocity = 100

for _, n in ipairs(notes) do
   local note_ptr = ARDOUR.LuaAPI.new_noteptr(
      channel,
      Temporal.Beats(n.start_beat, 0),
      Temporal.Beats(n.dur, 0),
      n.pitch,
      velocity
   )
   cmd:add(note_ptr)
end

-- 7. Apply the note changes
model:apply_diff_command_as_commit(Session, cmd)
print("Added " .. #notes .. " notes to region")

-- 8. Save session
s:save_state("")
print("Session saved to /tmp/ardour-midi-test")

-- Verify by reading back
local note_count = 0
for note in ARDOUR.LuaAPI.note_list(model):iter() do
   note_count = note_count + 1
end
print("Verified " .. note_count .. " notes in model")

assert(note_count == #notes, "Note count mismatch: expected " .. #notes .. " got " .. note_count)

print("SUCCESS: MIDI inline composition test passed")
close_session()
quit()
