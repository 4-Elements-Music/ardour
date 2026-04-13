import { spawn } from 'child_process';

/**
 * Launches the audio-validator sidecar in a separate process and validates its
 * stdout JSON. The process boundary alone provides the safety guarantee we need:
 * a libsndfile crash inside the sidecar cannot affect the Ardour session.
 *
 * Filesystem sandboxing via macOS sandbox-exec was tried and rejected — it hangs
 * the child in uninterruptible state on Darwin 24+ (Apple deprecated sandbox-exec
 * in 10.7). Proper App Sandbox / XPC isolation is tracked in docs/superpowers/TODO.md.
 *
 * Returns a Promise resolving to { channels, sampleRate, frames } from the
 * validator's stdout JSON.
 *
 * Rejects with Error whose `.code` is:
 *   - 'VALIDATOR_MISSING' if validatorBin is missing or falsy
 *   - 'DECODE_FAILED' if the child exits non-zero, times out, or prints unparseable stdout
 *
 * Additional Error fields when rejecting with DECODE_FAILED:
 *   .stderr      : child's stderr (truncated to 4KB)
 *   .exitCode    : child's exit code, or null on timeout/signal
 *   .signal      : signal name if killed, else null
 */
const OUTPUT_CAP = 65536;

export function decodeToCanonicalWav ({ input, output, validatorBin, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (!validatorBin) {
      return reject(Object.assign(new Error('audio validator binary not configured'),
        { code: 'VALIDATOR_MISSING' }));
    }

    const child = spawn(validatorBin, [input, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overCap = false;
    let killed = false;
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const killForOverCap = () => {
      if (killed) return;
      killed = true;
      overCap = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    };

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > OUTPUT_CAP) killForOverCap();
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > OUTPUT_CAP) killForOverCap();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      settle(reject, Object.assign(err, { code: 'DECODE_FAILED', stderr: stderr.slice(-4096) }));
    });

    child.on('close', (exitCode, signal) => {
      const trimmedStderr = stderr.slice(-4096);
      if (overCap) {
        return settle(reject, Object.assign(new Error('validator output exceeded 64KB cap'),
          { code: 'DECODE_FAILED', stderr: trimmedStderr, exitCode, signal }));
      }
      if (exitCode === 0 && !timedOut) {
        try {
          const parsed = JSON.parse(stdout);
          if (typeof parsed.channels !== 'number' ||
              typeof parsed.sampleRate !== 'number' ||
              typeof parsed.frames !== 'number') {
            throw new Error('validator stdout missing numeric fields');
          }
          return settle(resolve, {
            channels: parsed.channels,
            sampleRate: parsed.sampleRate,
            frames: parsed.frames,
          });
        } catch (e) {
          return settle(reject, Object.assign(new Error(`validator stdout unparseable: ${e.message}`),
            { code: 'DECODE_FAILED', stderr: trimmedStderr, exitCode, signal }));
        }
      }
      const msg = timedOut
        ? `validator timed out after ${timeoutMs}ms`
        : `validator exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`;
      settle(reject, Object.assign(new Error(msg),
        { code: 'DECODE_FAILED', stderr: trimmedStderr, exitCode, signal }));
    });
  });
}
