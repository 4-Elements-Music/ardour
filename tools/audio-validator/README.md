# audio-validator

Sandboxed audio decoder sidecar for the `audio_region_add` MCP tool.

Reads an audio file via libsndfile, validates geometry (1–64 channels, 8–384 kHz),
and transcodes to a canonical 32-bit-float WAV at the source sample rate. The
Node.js api-service runs this binary under OS sandbox (sandbox-exec on macOS)
before an upload reaches the Ardour process — isolating Ardour from malformed-file
crashes.

## Build

Built as part of the main Ardour waf build:

    ./waf build --targets=audio-validator

## Usage

    ./build/tools/audio-validator/audio-validator <input-file> <output.wav>

Exit codes: 0 success, 1 unreadable, 2 unsupported geometry, 3 decode error,
64 usage error. On success prints `{"channels":N,"sampleRate":N,"frames":N}`
to stdout.
