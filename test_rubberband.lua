-- test_rubberband.lua
-- Task 3: Validate RubberBand time-stretch and pitch-shift via Lua API in headless mode.

print("=== RubberBand Time-Stretch & Pitch-Shift Test ===")

-- ── Setup ──
local SESSION_DIR = "/tmp/ardour-rubberband-test"
os.execute("rm -rf " .. SESSION_DIR)

print("[0] Setting up audio backend...")
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(48000)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

print("[0] Creating session...")
create_session(SESSION_DIR, "rubberband-test", 48000)
print("    session:", Session:name())

-- ── Create a stereo audio track ──
print("\n[1] Creating stereo audio track...")
local tl = Session:new_audio_track(
    2, 2, ARDOUR.RouteGroup(), 1, "RBTest",
    ARDOUR.PresentationInfo.max_order,
    ARDOUR.TrackMode.Normal, true
)
local track = tl:front()
print("    track:", track:name())

-- ── Import audio file ──
print("\n[2] Importing audio file...")
local test_file = "/System/Library/Sounds/Basso.aiff"
print("    source:", test_file)

local region = ARDOUR.LuaAPI.import_audio_file(Session, test_file)
if region:isnil() then
    print("    FAILED to import audio file")
    close_session()
    return
end
print("    imported region:", region:name())

-- ── Convert to AudioRegion ──
print("\n[3] Converting to AudioRegion...")
local audio_region = region:to_audioregion()
if audio_region:isnil() then
    print("    FAILED: region:to_audioregion() returned nil")
    close_session()
    return
end
print("    audio region:", audio_region:name())

local orig_length = audio_region:length():samples()
print("    original length (samples):", orig_length)
print("    original length (seconds):", orig_length / 48000.0)

-- ── Get playlist for placing regions ──
local playlist = track:to_track():playlist()
local place_pos = 0

-- Place original region at the start
playlist:add_region(region, Temporal.timepos_t(0), 1, false, 0, 0, false)
place_pos = orig_length + 4800  -- small gap after original

-- ══════════════════════════════════════════════
-- TEST 1: Time Stretch (1.5x longer, same pitch)
-- ══════════════════════════════════════════════
print("\n=== TEST 1: Time Stretch (1.5x) ===")
local stretch_ok = false
local stretch_region = nil

local ok1, err1 = pcall(function()
    print("    Creating Rubberband instance...")
    local rb = ARDOUR.LuaAPI.Rubberband(audio_region, false)
    print("    Setting stretch=1.5, pitch=1.0...")
    rb:set_strech_and_pitch(1.5, 1.0)
    print("    Processing...")
    local result = rb:process(function(p)
        return false  -- false = continue, true = cancel
    end)
    if result:isnil() then
        print("    FAILED: process() returned nil region")
    else
        stretch_region = result
        local new_length = result:length():samples()
        local ratio = new_length / orig_length
        print("    new length (samples):", new_length)
        print("    new length (seconds):", new_length / 48000.0)
        print("    actual ratio:", ratio)
        print("    expected ratio: 1.5")
        if ratio > 1.3 and ratio < 1.7 then
            print("    PASS: ratio is within tolerance (~1.5x)")
            stretch_ok = true
        else
            print("    FAIL: ratio out of expected range [1.3, 1.7]")
        end
    end
end)

if not ok1 then
    print("    ERROR in time stretch test:", err1)
end

-- Place stretched region on the track
if stretch_region and not stretch_region:isnil() then
    playlist:add_region(stretch_region, Temporal.timepos_t(place_pos), 1, false, 0, 0, false)
    place_pos = place_pos + stretch_region:length():samples() + 4800
    print("    Placed stretched region on track")
end

-- ══════════════════════════════════════════════
-- TEST 2: Pitch Shift (+2 semitones, same length)
-- ══════════════════════════════════════════════
print("\n=== TEST 2: Pitch Shift (+2 semitones) ===")
local pitch_ok = false
local pitch_region = nil

local ok2, err2 = pcall(function()
    print("    Creating Rubberband instance...")
    local rb = ARDOUR.LuaAPI.Rubberband(audio_region, false)
    local pitch_ratio = 2 ^ (2 / 12)
    print("    Setting stretch=1.0, pitch=" .. pitch_ratio .. " (+2 semitones)...")
    rb:set_strech_and_pitch(1.0, pitch_ratio)
    print("    Processing...")
    local result = rb:process(function(p)
        return false
    end)
    if result:isnil() then
        print("    FAILED: process() returned nil region")
    else
        pitch_region = result
        local new_length = result:length():samples()
        local ratio = new_length / orig_length
        print("    new length (samples):", new_length)
        print("    length ratio:", ratio)
        -- With pitch shift only, length should stay ~1.0
        if ratio > 0.85 and ratio < 1.15 then
            print("    PASS: length preserved (~1.0x) with pitch shift")
            pitch_ok = true
        else
            print("    FAIL: length ratio out of expected range [0.85, 1.15]")
        end
    end
end)

if not ok2 then
    print("    ERROR in pitch shift test:", err2)
end

-- Place pitch-shifted region on the track
if pitch_region and not pitch_region:isnil() then
    playlist:add_region(pitch_region, Temporal.timepos_t(place_pos), 1, false, 0, 0, false)
    place_pos = place_pos + pitch_region:length():samples() + 4800
    print("    Placed pitch-shifted region on track")
end

-- ══════════════════════════════════════════════
-- TEST 3: Combined (0.8x stretch + -3 semitones)
-- ══════════════════════════════════════════════
print("\n=== TEST 3: Combined (0.8x stretch, -3 semitones) ===")
local combined_ok = false
local combined_region = nil

local ok3, err3 = pcall(function()
    print("    Creating Rubberband instance...")
    local rb = ARDOUR.LuaAPI.Rubberband(audio_region, false)
    local pitch_ratio = 2 ^ (-3 / 12)
    print("    Setting stretch=0.8, pitch=" .. pitch_ratio .. " (-3 semitones)...")
    rb:set_strech_and_pitch(0.8, pitch_ratio)
    print("    Processing...")
    local result = rb:process(function(p)
        return false
    end)
    if result:isnil() then
        print("    FAILED: process() returned nil region")
    else
        combined_region = result
        local new_length = result:length():samples()
        local ratio = new_length / orig_length
        print("    new length (samples):", new_length)
        print("    new length (seconds):", new_length / 48000.0)
        print("    length ratio:", ratio)
        -- With 0.8x stretch, length should be ~0.8x
        if ratio > 0.65 and ratio < 0.95 then
            print("    PASS: length ~0.8x as expected")
            combined_ok = true
        else
            print("    FAIL: length ratio out of expected range [0.65, 0.95]")
        end
    end
end)

if not ok3 then
    print("    ERROR in combined test:", err3)
end

-- Place combined region on the track
if combined_region and not combined_region:isnil() then
    playlist:add_region(combined_region, Temporal.timepos_t(place_pos), 1, false, 0, 0, false)
    print("    Placed combined region on track")
end

-- ── Save session ──
print("\n[4] Saving session...")
Session:save_state("")
print("    session saved")

-- ── Summary ──
print("\n=== RESULTS ===")
print("  Test 1 (Time Stretch 1.5x):              " .. (stretch_ok and "PASS" or "FAIL"))
print("  Test 2 (Pitch Shift +2 semitones):        " .. (pitch_ok and "PASS" or "FAIL"))
print("  Test 3 (Combined 0.8x stretch, -3 semi):  " .. (combined_ok and "PASS" or "FAIL"))
print("  Session at: " .. SESSION_DIR)

local total = 0
if stretch_ok then total = total + 1 end
if pitch_ok then total = total + 1 end
if combined_ok then total = total + 1 end
print("\n  " .. total .. "/3 tests passed")

print("\n=== RubberBand test complete ===")

close_session()
