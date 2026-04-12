-- MCP HTTP Session Host
--
-- Run via: luasession mcp_host.lua <session_dir> <session_name> [sample_rate] [bpm] [num] [denom]
--
-- Environment:
--   MCP_HTTP_PORT - port to bind MCP HTTP surface (default 4820)
--
-- Creates a new Ardour session with the Dummy backend, activates the MCP HTTP
-- control surface, and stays alive until killed. The Node.js session manager
-- uses this script to spawn persistent session processes.

local session_dir   = arg[1] or error("session_dir required as arg[1]")
local session_name  = arg[2] or error("session_name required as arg[2]")
local sample_rate   = tonumber(arg[3]) or 48000
local bpm           = tonumber(arg[4]) or 120
local numerator     = tonumber(arg[5]) or 4
local denominator   = tonumber(arg[6]) or 4

io.stderr:write(string.format("mcp_host: session_dir=%s session_name=%s sample_rate=%d tempo=%d/%d/%d\n",
    session_dir, session_name, sample_rate, bpm, numerator, denominator))

-- Set up audio engine with Dummy backend
AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(sample_rate)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

-- Create the session
create_session(session_dir, session_name, sample_rate)
io.stderr:write("mcp_host: session created: " .. Session:name() .. "\n")

-- Set tempo and time signature
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(bpm, bpm, 4), Temporal.timepos_t(0))
tm:set_meter(Temporal.Meter(numerator, denominator), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)
io.stderr:write("mcp_host: tempo/time-sig set\n")

-- Activate MCP HTTP control surface
local cpm = ARDOUR.ControlProtocolManager.manager()
local activated = false
for p in cpm:control_protocol_infos():iter() do
    if p.name == "MCP HTTP Server (Experimental)" then
        cpm:activate(p)
        activated = true
        io.stderr:write("mcp_host: MCP HTTP activated\n")
        break
    end
end

if not activated then
    io.stderr:write("mcp_host: ERROR - MCP HTTP surface not found. Check ARDOUR_SURFACES_PATH.\n")
    os.exit(1)
end

-- Print a READY marker on stdout so the parent process knows we're listening
io.stdout:write("MCP_HTTP_READY\n")
io.stdout:flush()

-- Stay alive until killed (SIGTERM from parent process)
while true do
    sleep(1)
end
