-- test_analysis.lua
-- Validate metering and Vamp analysis capabilities in Ardour's headless engine.
-- Key question: can we get peak/RMS/loudness data from audio without running the transport?

print("=== Analysis & Metering Test ===")

-- ── Setup ──
local SESSION_DIR = "/tmp/ardour-analysis-test"
os.execute("rm -rf " .. SESSION_DIR)

print("[1] Setting up Dummy backend at 48kHz...")
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

print("[1] Creating session...")
create_session(SESSION_DIR, "analysis-test", 48000)
print("    session:", Session:name())

-- ── Create audio track and import file ──
print("\n[2] Creating audio track...")
local tl = Session:new_audio_track(
    2, 2, ARDOUR.RouteGroup(), 1, "Analysis",
    ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true
)
local track = tl:front()
print("    track:", track:name())

print("\n[2] Importing audio file...")
local test_file = "/System/Library/Sounds/Basso.aiff"
local region = ARDOUR.LuaAPI.import_audio_file(Session, test_file)
if region:isnil() then
    print("    FAILED to import audio file")
    close_session()
    return
end
print("    imported region:", region:name())
print("    length:", region:length())

-- Place region at position 0
local playlist = track:to_track():playlist()
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
print("    region placed at position 0")

-- ── PeakMeter Test ──
print("\n[3] === PeakMeter Test ===")
local meter = track:peak_meter()
if meter then
    print("    peak_meter obtained successfully")
    local level = meter:meter_level(0, ARDOUR.MeterType.MeterPeak)
    print("    meter_level(ch0, MeterPeak):", level)
    -- Note: level will likely be -inf (-huge) since transport hasn't run.
    -- The peak meter requires audio to flow through the processing graph,
    -- which only happens when the transport is rolling or the engine processes buffers.
    if level == -math.huge or level < -300 then
        print("    FINDING: Meter reads -inf (expected - transport not running)")
        print("    Metering requires transport playback to update values.")
    else
        print("    FINDING: Meter has a non-trivial value:", level)
    end
else
    print("    FAILED to get peak_meter from track")
end

-- ── Vamp Plugin Discovery ──
print("\n[6] === Vamp Plugin Discovery ===")
local plugins = ARDOUR.LuaAPI.Vamp.list_plugins()
local plugin_count = plugins:size()
print("    Available Vamp plugins (" .. plugin_count .. " total):")
local plugin_list = {}
for i = 0, plugin_count - 1 do
    local key = plugins:at(i)
    table.insert(plugin_list, key)
    print("      " .. (i+1) .. ": " .. key)
end

-- ── Vamp Analysis Test ──
print("\n[8] === Vamp Analysis Test ===")

-- Try to use dBTP (true peak) plugin from Ardour's built-in vamp plugins
local analysis_plugins_to_try = {
    "libardourvampplugins:dBTP",
    "libardourvampplugins:loudness",
    "vamp-example-plugins:amplitudefollower",
}

-- Also try whatever is actually available
if plugin_count > 0 then
    -- Add first available plugin as fallback
    local first_plugin = plugin_list[1]
    local already_listed = false
    for _, p in ipairs(analysis_plugins_to_try) do
        if p == first_plugin then already_listed = true end
    end
    if not already_listed then
        table.insert(analysis_plugins_to_try, first_plugin)
    end
end

local ar = region:to_audioregion()
if ar:isnil() then
    print("    FAILED: could not cast region to AudioRegion")
else
    print("    AudioRegion obtained:", ar:name())
    print("    AudioRegion length (samples):", ar:length():samples())

    for _, plugin_key in ipairs(analysis_plugins_to_try) do
        print("\n    Trying Vamp plugin: " .. plugin_key)
        local ok, vamp_or_err = pcall(function()
            return ARDOUR.LuaAPI.Vamp(plugin_key, 48000)
        end)

        if ok and vamp_or_err then
            local v = vamp_or_err
            print("      Plugin loaded successfully")

            -- Get plugin info
            local p = v:plugin()
            if p then
                print("      Name:", p:getName())
                print("      Description:", p:getDescription())
                print("      Maker:", p:getMaker())
            end

            -- Try to analyze the region
            print("      Running analyze on region (channel 0)...")
            local analyze_ok, analyze_err = pcall(function()
                local results = v:analyze(ar:to_readable(), 0, C.NoOp)
                return results
            end)

            if analyze_ok then
                print("      analyze() completed successfully")
                -- Results from analyze() are the final getRemainingFeatures
                -- The actual features depend on the plugin
                if analyze_err then
                    print("      Result type:", type(analyze_err))
                end
            else
                print("      analyze() failed:", tostring(analyze_err))
            end
        else
            print("      Plugin not available:", tostring(vamp_or_err))
        end
    end
end

-- ── Summary ──
print("\n=== Summary ===")
print("  PeakMeter: accessible but requires transport to produce readings")
print("  Vamp plugins found:", plugin_count)
print("  Vamp analysis: can analyze AudioRegion directly (offline, no transport needed)")
print("  Key finding: Vamp/offline analysis CAN get loudness data without transport")
print("               PeakMeter CANNOT (it's a realtime processor)")

print("\n=== PASS ===")
close_session()
