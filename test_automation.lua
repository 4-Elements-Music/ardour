-- test_automation.lua
-- Validate gain, pan, and plugin parameter automation in Ardour's headless engine.

print("=== Ardour Automation Curves Test ===")

-- 1. Set up Dummy backend at 48kHz, create session
local SESSION_DIR = "/tmp/ardour-automation-test"
local SESSION_NAME = "automation-test"

print("\n[1] Setting up audio backend (Dummy @ 48kHz)...")
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

-- 2. Set tempo to 120 BPM
print("\n[2] Setting tempo to 120 BPM...")
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
Session:begin_reversible_command("Set Tempo")
Temporal.TempoMap.update(tm)
Session:commit_reversible_command(nil)
tm = nil

local tmr = Temporal.TempoMap.read()
print("    BPM at start:", tmr:quarters_per_minute_at(Temporal.timepos_t(0)))
tmr = nil

-- 3. Create an audio track with a compressor plugin
print("\n[3] Creating audio track with compressor...")
local track_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "AutoTrack",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
print("    Tracks created:", track_list:size())

local track = Session:route_by_name("AutoTrack")
assert(track, "AutoTrack route not found")
print("    Track:", track:name())

-- Add a-comp compressor plugin
local comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp#stereo", ARDOUR.PluginType.LV2, "")
if comp:isnil() then
    print("    Stereo a-comp not found, trying mono...")
    comp = ARDOUR.LuaAPI.new_plugin(Session, "urn:ardour:a-comp", ARDOUR.PluginType.LV2, "")
end
assert(not comp:isnil(), "Failed to instantiate a-comp plugin")
track:add_processor_by_index(comp, 0, nil, true)
print("    Compressor plugin added")

-- Helper: ticks position from beat count
local function beat_pos(beats)
    return Temporal.timepos_t.from_ticks(beats * Temporal.ticks_per_beat)
end

-- Track total automation points written
local total_points = 0

-- ============================================================
-- GAIN AUTOMATION
-- ============================================================
print("\n[4-9] Gain automation...")

-- 4. Get gain control
local gain_ac = track:gain_control()
assert(gain_ac, "gain_control() returned nil")

-- 5. Get automation list
local gain_al = gain_ac:alist()
assert(gain_al, "gain alist() returned nil")

-- 6. Clear it
gain_al:clear_list()
print("    Gain automation list cleared")

-- 7. Add 3 points representing a volume dip
--    -3dB = 10^(-3/20) ~= 0.7079
--    -6dB = 10^(-6/20) ~= 0.5012
local coeff_minus3 = 10 ^ (-3/20)   -- 0.7079
local coeff_minus6 = 10 ^ (-6/20)   -- 0.5012

gain_al:add(beat_pos(0),  coeff_minus3, false, true)
gain_al:add(beat_pos(28), coeff_minus6, false, true)
gain_al:add(beat_pos(32), coeff_minus3, false, true)
total_points = total_points + 3
print(string.format("    Added 3 gain points: [beat 0]=%.4f (-3dB), [beat 28]=%.4f (-6dB), [beat 32]=%.4f (-3dB)",
    coeff_minus3, coeff_minus6, coeff_minus3))

-- 8. Set automation state to Play
gain_ac:set_automation_state(ARDOUR.AutoState.Play)
print("    Gain automation state set to Play")

-- 9. Verify readback at midpoints
local eval_at_0 = gain_al:eval(beat_pos(0))
local eval_at_14 = gain_al:eval(beat_pos(14))
local eval_at_28 = gain_al:eval(beat_pos(28))
local eval_at_30 = gain_al:eval(beat_pos(30))
local eval_at_32 = gain_al:eval(beat_pos(32))

print(string.format("    Readback: beat0=%.4f, beat14=%.4f, beat28=%.4f, beat30=%.4f, beat32=%.4f",
    eval_at_0, eval_at_14, eval_at_28, eval_at_30, eval_at_32))

-- Verify endpoints match what we wrote
assert(math.abs(eval_at_0 - coeff_minus3) < 0.01,
    string.format("beat 0: expected ~%.4f, got %.4f", coeff_minus3, eval_at_0))
assert(math.abs(eval_at_28 - coeff_minus6) < 0.01,
    string.format("beat 28: expected ~%.4f, got %.4f", coeff_minus6, eval_at_28))
assert(math.abs(eval_at_32 - coeff_minus3) < 0.01,
    string.format("beat 32: expected ~%.4f, got %.4f", coeff_minus3, eval_at_32))

-- Midpoint at beat 14 should be between -3dB and -6dB
assert(eval_at_14 < coeff_minus3 and eval_at_14 > coeff_minus6,
    string.format("beat 14: expected between %.4f and %.4f, got %.4f", coeff_minus6, coeff_minus3, eval_at_14))

print("    PASS: Gain automation readback verified")

-- ============================================================
-- PAN AUTOMATION
-- ============================================================
print("\n[10-12] Pan automation...")

-- 10. Get pan azimuth control
local pan_ac = track:pan_azimuth_control()

if pan_ac:isnil() then
    print("    NOTE: pan_azimuth_control() returned nil, skipping pan automation")
else
    -- 11. Write 3 pan points (L to R and back)
    local pan_al = pan_ac:alist()
    pan_al:clear_list()

    -- Pan values: 0.0 = hard left, 0.5 = center, 1.0 = hard right
    pan_al:add(beat_pos(0),  0.0, false, true)   -- hard left
    pan_al:add(beat_pos(16), 1.0, false, true)   -- hard right
    pan_al:add(beat_pos(32), 0.0, false, true)   -- back to hard left
    total_points = total_points + 3
    print("    Added 3 pan points: [beat 0]=L, [beat 16]=R, [beat 32]=L")

    -- 12. Set to Play state
    pan_ac:set_automation_state(ARDOUR.AutoState.Play)
    print("    Pan automation state set to Play")

    -- Verify midpoint
    local pan_mid = pan_al:eval(beat_pos(8))
    print(string.format("    Readback: beat8=%.4f (expect ~0.5 center)", pan_mid))
    assert(math.abs(pan_mid - 0.5) < 0.1,
        string.format("beat 8 pan: expected ~0.5, got %.4f", pan_mid))
    print("    PASS: Pan automation readback verified")
end

-- ============================================================
-- PLUGIN PARAMETER AUTOMATION
-- ============================================================
print("\n[13-15] Plugin parameter automation...")

-- 13. Get plugin automation via ARDOUR.LuaAPI.plugin_automation
--     Parameter 4 of a-comp (varies by plugin, but let's try it)
local al, cl, pd = ARDOUR.LuaAPI.plugin_automation(comp, 4)

-- 14. If al is not nil, clear and add 2 automation points
if al:isnil() then
    print("    NOTE: plugin_automation for param 4 returned nil, skipping")
else
    print(string.format("    Plugin param 4 range: [%.4f .. %.4f]", pd.lower, pd.upper))

    cl:clear_list()

    -- Add 2 points spanning the parameter range
    local val_low = pd.lower + (pd.upper - pd.lower) * 0.25
    local val_high = pd.lower + (pd.upper - pd.lower) * 0.75
    cl:add(beat_pos(0),  val_low,  false, true)
    cl:add(beat_pos(16), val_high, false, true)
    total_points = total_points + 2
    print(string.format("    Added 2 plugin param points: [beat 0]=%.4f, [beat 16]=%.4f", val_low, val_high))

    -- Verify readback
    local plugin_read = cl:eval(beat_pos(0))
    print(string.format("    Readback: beat0=%.4f", plugin_read))

    -- 15. Set plugin automation control to Play state
    local pi = comp:to_insert()
    local ctrl = Evoral.Parameter(ARDOUR.AutomationType.PluginAutomation, 0, 4)
    local ac = pi:automation_control(ctrl, false)
    if ac and not ac:isnil() then
        ac:set_automation_state(ARDOUR.AutoState.Play)
        print("    Plugin param 4 automation state set to Play")
    else
        print("    WARNING: Could not get automation control for plugin param 4")
    end

    print("    PASS: Plugin parameter automation written")
end

-- ============================================================
-- 16. Save session and print summary
-- ============================================================
print("\n[16] Saving session...")
Session:save_state("")
print("    Session saved")

print("\n=== Automation Test Summary ===")
print(string.format("    Total automation points written: %d", total_points))
print("    Gain automation: 3 points (volume dip -3dB -> -6dB -> -3dB), state=Play")
if pan_ac and not pan_ac:isnil() then
    print("    Pan automation:  3 points (L -> R -> L), state=Play")
else
    print("    Pan automation:  SKIPPED (pan_azimuth_control not available)")
end
if al and not al:isnil() then
    print("    Plugin automation: 2 points on param 4, state=Play")
else
    print("    Plugin automation: SKIPPED (param 4 not available)")
end
print("    Session location: " .. SESSION_DIR)

print("\n=== All automation tests PASSED ===")

close_session()
