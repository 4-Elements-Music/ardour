-- test_sidechain.lua
-- Validate sidechain routing in Ardour's headless engine.

print("=== Ardour Sidechain Routing Test ===")

-- 1. Set up Dummy backend at 48kHz, create session
local SESSION_DIR = "/tmp/ardour-sidechain-test"
local SESSION_NAME = "sidechain-test"

print("\n[1] Setting up audio backend (Dummy)...")
local ok = AudioEngine:set_backend("None (Dummy)", "", "")
print("    backend:", ok and "OK" or "FAILED")

AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

os.execute("rm -rf " .. SESSION_DIR)

print("    Creating session at " .. SESSION_DIR)
local s = create_session(SESSION_DIR, SESSION_NAME, 48000)
if not s then
    print("    FAILED to create session")
    return
end
print("    Session created:", Session:name())

-- 2. Create two audio tracks: Kick and Bass
print("\n[2] Creating Kick and Bass audio tracks...")
local kick_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Kick",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
local bass_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Bass",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)

print("    Kick tracks created:", kick_list:size())
print("    Bass tracks created:", bass_list:size())

local kick = Session:route_by_name("Kick")
local bass = Session:route_by_name("Bass")
assert(kick, "Kick route not found")
assert(bass, "Bass route not found")
print("    Kick route:", kick:name())
print("    Bass route:", bass:name())

-- 3. Add a-comp plugin to Bass
print("\n[3] Adding a-comp compressor plugin to Bass...")
local comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp#stereo", ARDOUR.PluginType.LV2, "")
if comp:isnil() then
    print("    Stereo a-comp not found, trying mono...")
    comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp", ARDOUR.PluginType.LV2, "")
end
assert(not comp:isnil(), "Failed to instantiate a-comp plugin")
print("    Plugin instantiated OK")

-- 4. Add plugin to Bass route
print("\n[4] Adding plugin to Bass route...")
bass:add_processor_by_index(comp, 0, nil, true)
print("    Plugin added to Bass at index 0")

-- 5. Get the PluginInsert
print("\n[5] Getting PluginInsert...")
local pi = comp:to_insert()
assert(pi, "Failed to get PluginInsert")
print("    PluginInsert obtained OK")

-- 6. Check has_sidechain (should be false)
print("\n[6] Checking has_sidechain (expect false)...")
local has_sc_before = pi:has_sidechain()
print("    has_sidechain:", has_sc_before)
assert(not has_sc_before, "Expected has_sidechain to be false before adding sidechain")
print("    PASS: no sidechain yet")

-- 7. Add sidechain via Route::add_sidechain
print("\n[7] Adding sidechain to Bass compressor...")
local sc_ok = bass:add_sidechain(comp)
print("    add_sidechain returned:", sc_ok)

-- 8. Check has_sidechain again (should be true)
print("\n[8] Checking has_sidechain (expect true)...")
local has_sc_after = pi:has_sidechain()
print("    has_sidechain:", has_sc_after)
assert(has_sc_after, "Expected has_sidechain to be true after adding sidechain")
print("    PASS: sidechain present")

-- 9. Get sidechain input IO object
print("\n[9] Getting sidechain input...")
local sc_input = pi:sidechain_input()
assert(sc_input, "sidechain_input() returned nil")
print("    Sidechain IO object obtained OK")

-- 10. Print number of sidechain input ports
print("\n[10] Sidechain input port count...")
local n_ports = sc_input:n_ports()
print("    Total ports:", n_ports:n_total())
print("    Audio ports:", n_ports:n_audio())
print("    MIDI ports:", n_ports:n_midi())

-- 11. Save session
print("\n[11] Saving session...")
Session:save_state("")
print("    Session saved")

print("\n=== All sidechain tests PASSED ===")
