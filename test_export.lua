-- test_export.lua
-- Test headless audio export via SimpleExport Lua API

print("=== Export Test ===")

-- ── Setup ──
local SESSION_DIR = "/tmp/ardour-export-test"
local EXPORT_DIR  = SESSION_DIR .. "/export"
os.execute("rm -rf " .. SESSION_DIR)

print("[0] Setting up audio backend...")
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

print("[0] Creating session...")
create_session(SESSION_DIR, "export-test", 48000)
print("    session:", Session:name())

-- ── Create audio track ──
print("\n[1] Creating stereo audio track...")
local tl = Session:new_audio_track(
    2, 2, ARDOUR.RouteGroup(), 1, "Main",
    ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true
)
local track = tl:front()
print("    track:", track:name())

-- ── Import audio file ──
print("\n[2] Importing audio file...")
local test_file = "/System/Library/Sounds/Basso.aiff"
local region = ARDOUR.LuaAPI.import_audio_file(Session, test_file)
if region:isnil() then
    print("    FAILED to import audio file")
    close_session()
    return
end
print("    imported region:", region:name())
print("    length (samples):", region:length():samples())

-- ── Place region at position 0 ──
print("\n[3] Placing region at position 0...")
local playlist = track:to_track():playlist()
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
print("    region placed, count:", playlist:n_regions())

-- ── Set session range ──
print("\n[4] Setting session range...")
local end_sample = region:length():samples()
print("    end_sample:", end_sample)
Session:maybe_update_session_range(
    Temporal.timepos_t(0),
    Temporal.timepos_t(end_sample)
)

-- ── Save session ──
print("\n[5] Saving session...")
Session:save_state("")
print("    saved")

-- ── Export via SimpleExport ──
print("\n[6] Attempting SimpleExport...")
os.execute("mkdir -p " .. EXPORT_DIR)

local se = Session:simple_export()
print("    SimpleExport object:", se)
se:set_name("output")
se:set_folder(EXPORT_DIR)
se:set_range(0, end_sample)

-- CD (Red Book) preset UUID from share/export/CD only.preset
local preset_ok = se:set_preset("df340c53-88b5-4342-a1c8-58e0704872ea")
print("    set_preset returned:", preset_ok)

local outputs_ok = se:check_outputs()
print("    check_outputs:", outputs_ok)

if preset_ok and outputs_ok then
    print("    running export...")
    local export_ok = se:run_export()
    print("    run_export returned:", export_ok)
else
    print("    WARN: preset or outputs check failed, trying WAV preset...")
    -- Try WAV preset
    preset_ok = se:set_preset("75969a1c-3133-4694-864b-a1fa50e43348")
    print("    WAV set_preset returned:", preset_ok)
    outputs_ok = se:check_outputs()
    print("    WAV check_outputs:", outputs_ok)
    if preset_ok and outputs_ok then
        print("    running export with WAV preset...")
        local export_ok = se:run_export()
        print("    run_export returned:", export_ok)
    else
        print("    FAILED: Neither preset worked")
    end
end

-- ── Check output ──
print("\n[7] Checking for output file...")
local handle = io.popen("ls -la " .. EXPORT_DIR .. "/ 2>&1")
local result = handle:read("*a")
handle:close()
print(result)

-- Check if any wav file was created
handle = io.popen("find " .. EXPORT_DIR .. " -name '*.wav' -o -name '*.aiff' -o -name '*.flac' 2>/dev/null")
local files = handle:read("*a")
handle:close()

if files and #files > 0 then
    print("=== EXPORT SUCCESS ===")
    print("Output files:")
    print(files)
else
    print("=== EXPORT FAILED - no output files found ===")
end

close_session()
