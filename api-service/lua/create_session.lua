-- Quick session creator — creates a new Ardour session and exits.
-- Used by the SessionManager in GUI mode, which then launches the Ardour GUI
-- pointed at the created session file.
--
-- Usage: luasession create_session.lua <session_dir> <session_name> <sample_rate> <bpm> <num> <denom>

local session_dir   = arg[1] or error("session_dir required as arg[1]")
local session_name  = arg[2] or error("session_name required as arg[2]")
local sample_rate   = tonumber(arg[3]) or 48000
local bpm           = tonumber(arg[4]) or 120
local numerator     = tonumber(arg[5]) or 4
local denominator   = tonumber(arg[6]) or 4

io.stderr:write(string.format("create_session: %s/%s sr=%d tempo=%d/%d/%d\n",
    session_dir, session_name, sample_rate, bpm, numerator, denominator))

AudioEngine:set_backend("None (Dummy)", "", "")
AudioEngine:set_sample_rate(sample_rate)
AudioEngine:set_buffer_size(1024)
AudioEngine:start()

create_session(session_dir, session_name, sample_rate)
io.stderr:write("create_session: session created: " .. Session:name() .. "\n")

local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(bpm, bpm, 4), Temporal.timepos_t(0))
tm:set_meter(Temporal.Meter(numerator, denominator), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)

Session:save_state("")
close_session()
io.stderr:write("create_session: done\n")
quit()
