-- test_vca_groups.lua
-- Validate VCA creation and track group assignment in Ardour's headless engine.

print("=== Ardour VCA and Route Groups Test ===")

-- 1. Set up Dummy backend at 48kHz, create session
local SESSION_DIR = "/tmp/ardour-vca-test"
local SESSION_NAME = "vca-test"

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

-- 2. Create 3 audio tracks: Drums, Bass, Guitar
print("\n[2] Creating audio tracks...")
local drums_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Drums",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
print("    Drums created:", drums_list:size(), "track(s)")

local bass_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Bass",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
print("    Bass created:", bass_list:size(), "track(s)")

local guitar_list = Session:new_audio_track(2, 2, ARDOUR.RouteGroup(), 1, "Guitar",
    ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true)
print("    Guitar created:", guitar_list:size(), "track(s)")

local drums = Session:route_by_name("Drums")
local bass = Session:route_by_name("Bass")
local guitar = Session:route_by_name("Guitar")
assert(drums, "Drums route not found")
assert(bass, "Bass route not found")
assert(guitar, "Guitar route not found")
print("    All tracks verified:", drums:name(), bass:name(), guitar:name())

-- 3. VCA Test: Create VCA via VCAManager
print("\n[3] VCA Creation Test...")
local vca_mgr = Session:vca_manager()
assert(vca_mgr, "VCA manager not found")
print("    VCA manager obtained, current VCA count:", vca_mgr:n_vcas())

-- create_vca(count, name)
local vca_list = vca_mgr:create_vca(1, "Rhythm Section")
print("    create_vca returned, VCA count now:", vca_mgr:n_vcas())

-- Retrieve the VCA
local vca = vca_mgr:vca_by_name("Rhythm Section")
if vca and not vca:isnil() then
    print("    VCA found by name:", vca:full_name())
    print("    VCA number:", vca:number())
else
    print("    WARNING: VCA not found by name, trying by number...")
    vca = vca_mgr:vca_by_number(1)
    if vca and not vca:isnil() then
        print("    VCA found by number:", vca:full_name())
    else
        print("    FAILED: Could not retrieve VCA")
    end
end

-- 4. VCA Assignment: Assign tracks to VCA via Slavable interface
print("\n[4] VCA Assignment Test...")
if vca and not vca:isnil() then
    -- Route derives from Stripable, which has to_slavable() cast
    local drums_slavable = drums:to_slavable()
    if drums_slavable and not drums_slavable:isnil() then
        print("    Drums to_slavable() cast: OK")
        drums_slavable:assign(vca)
        print("    Drums assigned to VCA")
        print("    Drums assigned_to VCA?", drums_slavable:assigned_to(vca_mgr, vca))
    else
        print("    WARNING: to_slavable() cast returned nil")
        -- Try alternative: assign via gain control
        print("    Trying gain control slave approach...")
        local gc = drums:to_route():gain_control()
        if gc then
            local sgc = gc:to_slavable()
            if sgc then
                print("    GainControl to_slavable: OK")
            else
                print("    GainControl to_slavable: nil")
            end
        end
    end

    -- Try Bass and Guitar
    local bass_slavable = bass:to_slavable()
    if bass_slavable and not bass_slavable:isnil() then
        bass_slavable:assign(vca)
        print("    Bass assigned to VCA")
    end

    local guitar_slavable = guitar:to_slavable()
    if guitar_slavable and not guitar_slavable:isnil() then
        guitar_slavable:assign(vca)
        print("    Guitar assigned to VCA")
    end
else
    print("    SKIPPED: No valid VCA to assign to")
end

-- 5. Route Group Test: Create a group and add tracks
print("\n[5] Route Group Test...")
local rg = Session:new_route_group("Rhythm Group")
if rg and not rg:isnil() then
    print("    Route group created:", rg:name())
    print("    Group empty?", rg:empty())
    print("    Group size:", rg:size())

    -- Add tracks to the group
    rg:add(drums:to_route())
    print("    Added Drums to group, size:", rg:size())

    rg:add(bass:to_route())
    print("    Added Bass to group, size:", rg:size())

    rg:add(guitar:to_route())
    print("    Added Guitar to group, size:", rg:size())

    -- Configure group properties
    rg:set_active(true, nil)
    rg:set_gain(true)
    rg:set_mute(true)
    rg:set_solo(true)
    print("    Group configured: active=true, gain=true, mute=true, solo=true")
    print("    is_active:", rg:is_active())
    print("    is_gain:", rg:is_gain())
    print("    is_mute:", rg:is_mute())
    print("    is_solo:", rg:is_solo())

    -- Verify group is in session (new_route_group should auto-add)
    local groups = Session:route_groups()
    print("    Session route groups count:", groups:size())
    -- If not auto-added, try add_route_group
    if groups:size() == 0 then
        print("    Trying Session:add_route_group()...")
        Session:add_route_group(rg)
        groups = Session:route_groups()
        print("    Session route groups count after add:", groups:size())
    end
else
    print("    FAILED: Could not create route group")
end

-- 6. VCA gain control test
print("\n[6] VCA Gain Control Test...")
if vca and not vca:isnil() then
    local vca_gain = vca:gain_control()
    if vca_gain and not vca_gain:isnil() then
        print("    VCA gain control: OK")
        print("    VCA gain value:", vca_gain:get_value())
        -- Try setting VCA gain to -6dB (approx 0.501)
        vca_gain:set_value(0.501, PBD.GroupControlDisposition.NoGroup)
        print("    VCA gain set to 0.501, readback:", vca_gain:get_value())
    else
        print("    VCA gain control: nil")
    end

    local vca_mute = vca:mute_control()
    if vca_mute and not vca_mute:isnil() then
        print("    VCA mute control: OK, muted?", vca_mute:muted())
    else
        print("    VCA mute control: nil")
    end
else
    print("    SKIPPED: No valid VCA")
end

-- 7. Summary
print("\n[7] Summary")
print("    Total routes in session:", Session:nroutes())
print("    Total VCAs:", vca_mgr:n_vcas())
local groups = Session:route_groups()
print("    Total route groups:", groups:size())

-- Save session
Session:save_state("")
print("\n    Session saved.")
print("\n=== VCA and Route Groups Test Complete ===")
