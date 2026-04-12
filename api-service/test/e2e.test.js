import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SKIP_E2E = !process.env.RUN_E2E;

describe('E2E: real luasession with mcp_host.lua', { skip: SKIP_E2E }, () => {
  it('creates session, runs lua_eval, destroys', async () => {
    // Find luasession binary
    const repoRoot = join(import.meta.dirname, '../..');
    const luasession = join(repoRoot, 'build/luasession/luasession');
    const mcpHost = join(repoRoot, 'api-service/lua/mcp_host.lua');
    const sessionDir = join(tmpdir(), `e2e-${Date.now()}`);

    if (!existsSync(luasession)) {
      assert.fail(`luasession not found at ${luasession} — run the Ardour build first`);
    }

    const port = 5995;
    const libs = join(repoRoot, 'build/libs');
    const env = {
      ...process.env,
      MCP_HTTP_PORT: String(port),
      ARDOUR_DLL_PATH: libs,
      ARDOUR_DATA_PATH: `${join(repoRoot, 'share')}:${join(repoRoot, 'build')}:${join(repoRoot, 'gtk2_ardour')}:${join(repoRoot, 'build/gtk2_ardour')}`,
      ARDOUR_CONFIG_PATH: `${repoRoot}:${join(repoRoot, 'gtk2_ardour')}:${join(repoRoot, 'build')}:${join(repoRoot, 'build/gtk2_ardour')}`,
      ARDOUR_EXPORT_FORMATS_PATH: join(repoRoot, 'share/export'),
      ARDOUR_SURFACES_PATH: `${join(libs, 'surfaces/osc')}:${join(libs, 'surfaces/mcp_http')}:${join(libs, 'surfaces/generic_midi')}`,
      ARDOUR_BACKEND_PATH: join(libs, 'backends/dummy'),
      ARDOUR_PANNER_PATH: join(libs, 'panners'),
      DYLD_FALLBACK_LIBRARY_PATH: [
        'tk/ydk-pixbuf','tk/ztk','tk/ydk','tk/ytk','tk/ztkmm','tk/ydkmm','tk/ytkmm','tk/suil',
        'ptformat','qm-dsp','vamp-sdk','surfaces','ctrl-interface/control_protocol',
        'ctrl-interface/midi_surface','ardour','midi++2','pbd','rubberband','soundtouch',
        'aaf','gtkmm2ext','widgets','appleutility','taglib','evoral','evoral/src/libsmf',
        'audiographer','temporal','libltc','canvas','waveview','ardouralsautil',
      ].map(p => join(libs, p)).join(':'),
    };

    const child = spawn(luasession, [mcpHost, sessionDir, 'e2e', '48000', '120', '4', '4'], { env });
    let ready = false;
    child.stdout.on('data', (d) => { if (d.toString().includes('MCP_HTTP_READY')) ready = true; });
    // Also collect stderr for debug
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    try {
      // Wait up to 15s for ready
      for (let i = 0; i < 30; i++) {
        if (ready) break;
        await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(ready, 'MCP_HTTP_READY not received in 15s. stderr:\n' + stderr.slice(-1000));

      // Test hello_world
      const res1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'tools/call',
          params: { name: 'hello_world', arguments: { name: 'e2e' } },
          id: 1,
        }),
      });
      const body1 = await res1.json();
      assert.ok(body1.result.structuredContent || body1.result.content);

      // Test lua_eval
      const res2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'tools/call',
          params: { name: 'session/lua_eval', arguments: { code: 'print("ok:" .. Session:name())' } },
          id: 2,
        }),
      });
      const body2 = await res2.json();
      const text = body2.result.content[0].text;
      assert.ok(text.includes('"success":true'), `expected success, got: ${text}`);
      assert.ok(text.includes('ok:e2e'), `expected ok:e2e in output: ${text}`);
    } finally {
      child.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  });
});
