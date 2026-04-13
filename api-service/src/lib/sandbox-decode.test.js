import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { decodeToCanonicalWav } from './sandbox-decode.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';

const repoRoot = resolve(import.meta.dirname, '../../..');
const defaultValidator = join(repoRoot, 'build/tools/audio-validator/audio-validator');
const validatorBin = process.env.AUDIO_VALIDATOR_BIN || defaultValidator;
const tmp = '/tmp/sandbox-decode-test';

const skipIfNoValidator = !existsSync(validatorBin);

describe('sandbox-decode', { skip: skipIfNoValidator && 'validator binary not built; run: ./waf build --targets=audio-validator' }, () => {
  before(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    // Build a 2-second mono 44.1 kHz test WAV using stdlib wave.
    const code = `import wave\nw=wave.open('${tmp}/ok.wav','wb')\nw.setnchannels(1)\nw.setsampwidth(2)\nw.setframerate(44100)\nw.writeframes(b'\\x00'*44100*2*2)\nw.close()`;
    const r = spawnSync('python3', ['-c', code]);
    if (r.status !== 0) throw new Error('python3 wav fixture generation failed: ' + r.stderr);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('decodes a valid WAV and returns metadata', async () => {
    const out = `${tmp}/ok-out.wav`;
    const meta = await decodeToCanonicalWav({ input: `${tmp}/ok.wav`, output: out, validatorBin });
    assert.equal(meta.channels, 1);
    assert.equal(meta.sampleRate, 44100);
    assert.ok(meta.frames > 0, `expected frames > 0, got ${meta.frames}`);
    assert.ok(existsSync(out), 'output file should exist after successful decode');
  });

  it('rejects a non-audio file with DECODE_FAILED', async () => {
    writeFileSync(`${tmp}/bad.bin`, 'not an audio file at all');
    await assert.rejects(
      decodeToCanonicalWav({ input: `${tmp}/bad.bin`, output: `${tmp}/bad-out.wav`, validatorBin }),
      (err) => {
        assert.equal(err.code, 'DECODE_FAILED');
        assert.equal(err.exitCode, 1, `expected exitCode 1, got ${err.exitCode}`);
        return true;
      }
    );
  });

  it('rejects with VALIDATOR_MISSING when validatorBin is falsy', async () => {
    await assert.rejects(
      decodeToCanonicalWav({ input: `${tmp}/ok.wav`, output: `${tmp}/x.wav`, validatorBin: '' }),
      (err) => { assert.equal(err.code, 'VALIDATOR_MISSING'); return true; }
    );
  });

  it('rejects with DECODE_FAILED when timeout hits (using /bin/cat as a sleeping fake validator)', async () => {
    // We use /bin/cat /dev/zero instead of the real validator so SIGKILL reaps cleanly.
    // The real validator can wedge in libsndfile I/O when killed mid-stream (UE state on macOS).
    // The wrapper's behavior is identical regardless of what binary we wrap.
    await assert.rejects(
      decodeToCanonicalWav({
        input: '/dev/zero',
        output: '/tmp/sandbox-decode-test/cat-out',
        validatorBin: '/bin/cat',
        timeoutMs: 100,
      }),
      (err) => {
        assert.equal(err.code, 'DECODE_FAILED');
        assert.equal(err.signal, 'SIGKILL', `expected SIGKILL signal, got ${err.signal}`);
        return true;
      }
    );
  });
});
