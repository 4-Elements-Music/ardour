/* audio-validator: sandboxed audio decoder sidecar.
 * Reads <input>, validates, transcodes to canonical 32-bit-float WAV at <output>,
 * prints JSON summary to stdout on success.
 *
 * Exit codes:
 *   0  success
 *   1  cannot open input (unreadable / not found)
 *   2  unsupported geometry (channels, sample rate out of range)
 *   3  decode error (mid-stream failure, or cannot open output)
 *  64  usage error
 */
#include <sndfile.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

int main (int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: %s <input> <output.wav>\n", argv[0]);
        return 64;
    }
    SF_INFO info;
    std::memset(&info, 0, sizeof info);
    SNDFILE* in = sf_open(argv[1], SFM_READ, &info);
    if (!in) {
        std::fprintf(stderr, "open failed: %s\n", sf_strerror(nullptr));
        return 1;
    }
    if (info.channels < 1 || info.channels > 64 || info.samplerate < 8000 || info.samplerate > 384000) {
        sf_close(in);
        std::fprintf(stderr, "unsupported geometry ch=%d sr=%d\n", info.channels, info.samplerate);
        return 2;
    }
    SF_INFO out_info = info;
    out_info.format = SF_FORMAT_WAV | SF_FORMAT_FLOAT;
    SNDFILE* out = sf_open(argv[2], SFM_WRITE, &out_info);
    if (!out) {
        sf_close(in);
        std::fprintf(stderr, "output open failed: %s\n", sf_strerror(nullptr));
        return 3;
    }
    std::vector<float> buf(4096 * info.channels);
    sf_count_t total = 0;
    sf_count_t r;
    while ((r = sf_readf_float(in, buf.data(), 4096)) > 0) {
        if (sf_writef_float(out, buf.data(), r) != r) {
            sf_close(in);
            sf_close(out);
            std::fprintf(stderr, "write failed\n");
            return 3;
        }
        total += r;
    }
    sf_close(in);
    sf_close(out);
    std::fprintf(stdout, "{\"channels\":%d,\"sampleRate\":%d,\"frames\":%lld}\n",
                 info.channels, info.samplerate, (long long)total);
    return 0;
}
