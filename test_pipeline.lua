-- test_pipeline.lua
-- End-to-end validation of the headless DAW pipeline via Lua.
-- Exercises the 9 requirements (minus time-stretch, which is the known gap).

print("=== Ardour Headless Pipeline Test ===")

-- ──────────────────────────────────────────────────────────
-- 0. Set up audio backend and create a session
-- ──────────────────────────────────────────────────────────
local SESSION_DIR = "/tmp/ardour-test-session"
local SESSION_NAME = "pipeline-test"

print("\n[0] Setting up audio backend (Dummy)...")
local ok = AudioEngine:set_backend("None (Dummy)", "", "")
print("    backend:", ok and "OK" or "FAILED")

print("    starting engine...")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

-- Clean out old session if it exists
os.execute("rm -rf " .. SESSION_DIR)

print("[0] Creating new session at " .. SESSION_DIR)
local s = create_session(SESSION_DIR, SESSION_NAME, 48000)
if not s then
    print("    FAILED to create session")
    return
end
print("    session created:", Session:name())

-- ──────────────────────────────────────────────────────────
-- 6. Set tempo
-- ──────────────────────────────────────────────────────────
print("\n[6] Setting tempo to 120 BPM...")
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
Session:begin_reversible_command("Set Tempo")
Temporal.TempoMap.update(tm)
Session:commit_reversible_command(nil)
local tmr = Temporal.TempoMap.read()
print("    BPM at start:", tmr:quarters_per_minute_at(Temporal.timepos_t(0)))

-- ──────────────────────────────────────────────────────────
-- 9. Create tracks + FX return (bus)
-- ──────────────────────────────────────────────────────────
print("\n[9] Creating 2 audio tracks and 1 FX bus...")
local audio_tracks = Session:new_audio_track(
    2, 2, ARDOUR.RouteGroup(), 2,
    "Audio", ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true
)
print("    created", audio_tracks:size(), "audio tracks")

local midi_tracks = Session:new_midi_track(
    ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1),
    ARDOUR.ChanCount(ARDOUR.DataType("audio"), 2),
    true,
    ARDOUR.PluginInfo(), nil,
    ARDOUR.RouteGroup(), 1,
    "MIDI", ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true, false
)
print("    created", midi_tracks:size(), "MIDI tracks")

-- Create an FX bus
local fx_bus_list = Session:new_audio_route(
    2, 2, ARDOUR.RouteGroup(), 1, "FX Return",
    ARDOUR.PresentationInfo.Flag.AudioBus,
    ARDOUR.PresentationInfo.max_order
)
print("    created FX bus:", fx_bus_list:size() > 0 and "OK" or "FAILED")

-- List all routes
print("\n    Routes in session:")
for r in Session:get_routes():iter() do
    print("      -", r:name())
end

-- ──────────────────────────────────────────────────────────
-- 5. Set mixer settings (gain, mute, pan)
-- ──────────────────────────────────────────────────────────
print("\n[5] Setting mixer parameters...")
local track1 = Session:route_by_name("Audio 1")
if track1 then
    track1:gain_control():set_value(0.7079, PBD.GroupControlDisposition.NoGroup)  -- ~-3dB
    track1:pan_azimuth_control():set_value(0.3, PBD.GroupControlDisposition.NoGroup)  -- left
    print("    Audio 1: gain=-3dB, pan=L")

    local gain = track1:gain_control():get_value()
    print("    Audio 1 gain readback:", gain)
end

-- ──────────────────────────────────────────────────────────
-- 2, 3, 4. Instantiate a plugin, tweak parameters
-- ──────────────────────────────────────────────────────────
print("\n[2/3/4] Instantiating a-comp compressor plugin...")

-- Try Ardour's bundled a-comp stereo compressor
local acomp_uri = "urn:ardour:a-comp#stereo"
local pinfo = ARDOUR.LuaAPI.new_plugin_info(acomp_uri, ARDOUR.PluginType.LV2)

if pinfo:isnil() then
    print("    a-comp#stereo not available, trying mono a-comp")
    acomp_uri = "urn:ardour:a-comp"
    pinfo = ARDOUR.LuaAPI.new_plugin_info(acomp_uri, ARDOUR.PluginType.LV2)
end

if pinfo:isnil() then
    print("    No compressor plugin available. Skipping plugin test.")
else
    print("    Found plugin info:", pinfo.name)
    local proc = ARDOUR.LuaAPI.new_plugin(Session, acomp_uri, ARDOUR.PluginType.LV2, "")

    if proc:isnil() then
        print("    Failed to instantiate plugin")
    elseif track1 then
        track1:add_processor_by_index(proc, 0, nil, true)
        print("    Plugin added to Audio 1")

        local pi = proc:to_insert()
        local plugin = pi:plugin(0)

        print("    Plugin parameter count:", plugin:parameter_count())

        -- Use plugin_automation which returns (AutomationList, ControlList, ParameterDescriptor)
        for i = 0, math.min(4, plugin:parameter_count() - 1) do
            local al, cl, pd = ARDOUR.LuaAPI.plugin_automation(proc, i)
            if pd then
                print(string.format("      param[%d] range=[%g .. %g] current=%g",
                      i, pd.lower, pd.upper, cl:eval(Temporal.timepos_t(0))))
            else
                print(string.format("      param[%d]: no descriptor", i))
            end
        end

        -- Set parameter values
        ARDOUR.LuaAPI.set_processor_param(pi, 0, -18.0)
        ARDOUR.LuaAPI.set_processor_param(pi, 1, 4.0)
        print("    Set param 0 -> -18.0 and param 1 -> 4.0")

        -- List presets from PluginInfo (not from Plugin instance)
        local presets = pinfo:get_presets(true)
        print("    Available presets:")
        local n = 0
        for pset in presets:iter() do
            print("      -", pset.label, "(" .. pset.uri .. ")")
            n = n + 1
            if n >= 5 then break end
        end

        -- Read back parameter value via automation list
        local _, cl0, _ = ARDOUR.LuaAPI.plugin_automation(proc, 0)
        print("    Readback param[0]:", cl0:eval(Temporal.timepos_t(0)))
    end
end

-- ──────────────────────────────────────────────────────────
-- Save and close
-- ──────────────────────────────────────────────────────────
print("\n[X] Saving session...")
Session:save_state("")
print("    saved")

print("\n=== Pipeline test complete ===")
print("Session at:", SESSION_DIR)

close_session()
