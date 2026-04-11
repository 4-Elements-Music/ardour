-- test_midi_import.lua
-- Validate MIDI file import via ARDOUR.LuaAPI.import_audio_file
-- The C++ implementation detects .mid extension and uses MIDI DataType.

print("=== MIDI Import Test ===")

-- ── Setup ──
local SESSION_DIR = "/tmp/ardour-midi-import-test"
os.execute("rm -rf " .. SESSION_DIR)

print("[0] Setting up audio backend (Dummy @ 48kHz)...")
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

print("[0] Creating session...")
create_session(SESSION_DIR, "midi-import-test", 48000)
print("    session:", Session:name())

-- ── Create a MIDI track ──
print("\n[1] Creating MIDI track...")
local midi_tracks = Session:new_midi_track(
    ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),
    ARDOUR.ChanCount(ARDOUR.DataType("audio"), 2),
    true,
    ARDOUR.PluginInfo(), nil,
    ARDOUR.RouteGroup(), 1,
    "MIDI", ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true, false
)
print("    created", midi_tracks:size(), "MIDI track(s)")

if midi_tracks:size() == 0 then
    print("    FAILED to create MIDI track")
    close_session()
    return
end

local midi_track = midi_tracks:front()
print("    track name:", midi_track:name())

-- ── Import MIDI file ──
print("\n[2] Importing /tmp/test-note.mid via import_audio_file...")
local midi_file = "/tmp/test-note.mid"

local region = ARDOUR.LuaAPI.import_audio_file(Session, midi_file)

if region:isnil() then
    print("    FAILED: import_audio_file returned nil for MIDI file")
    print("    This means import_audio_file does NOT handle MIDI — a separate binding is needed.")
    close_session()
    return
end

print("    SUCCESS: MIDI region imported")
print("    region name:", region:name())
print("    region length:", region:length())

-- ── Place region on MIDI track playlist ──
print("\n[3] Placing MIDI region on track playlist at position 0...")
local playlist = midi_track:to_track():playlist()
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
print("    region placed")
print("    regions on playlist:", playlist:n_regions())

-- ── Save session ──
print("\n[4] Saving session...")
Session:save_state("")
print("    session saved")

print("\n=== MIDI Import Test Complete ===")
print("Session at:", SESSION_DIR)
print("\nResults:")
print("  MIDI import via import_audio_file: OK")
print("  Region placement on MIDI track:    OK")

close_session()
