# audio-validator

Sandboxed audio decoder sidecar for the `audio_region_add` MCP tool.

Reads an audio file via libsndfile, validates geometry (1–64 channels, 8–384 kHz), and transcodes to a canonical 32-bit-float WAV at the source sample rate. Runs under OS sandbox (sandbox-exec on macOS, landlock planned for Linux) when invoked by the Node.js API service.

## Build

```
cd tools/audio-validator
make
```

Requires libsndfile headers + library (Homebrew `libsndfile` on macOS; `libsndfile-dev` on Debian/Ubuntu).

## Usage

```
./audio-validator <input-file> <output.wav>
```

Exit codes: 0 success, 1 unreadable, 2 unsupported geometry, 3 decode error, 64 usage error.
On success prints `{"channels":N,"sampleRate":N,"frames":N}` to stdout.
