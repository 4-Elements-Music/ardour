import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('export_audio mashupMetadata embed', () => {
  let app, sessionManager, sessionId, tmp;
  let exportedPath;

  before(async () => {
    tmp = join(tmpdir(), `xexp-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    sessionManager = new SessionManager({
      config: {
        maxConcurrentSessions: 5, allowGui: false,
        sessionsDir: tmp, maxSessionUploadBytes: 10_000_000,
        luasessionBin: '/bin/true', mcpHostLua: '/dev/null',
        createSessionLua: '/dev/null', ardourGuiBin: '/bin/true',
        logRingBufferSize: 100,
      },
      portPool: { allocate: () => 5000, release: () => {} },
      spawner: () => ({ pid: 1, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, kill() {} }),
      httpClient: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    app = Fastify({ logger: false });
    app.decorate('sessionManager', sessionManager);

    // Stub actionProxy: real handler dispatches `session/lua_eval` with the export
    // Lua. We materialize a tiny valid WAV at the exact path the real handler
    // looks for, then return a successful Lua-eval response with the field lines.
    app.decorate('actionProxy', {
      execute: async (session, tool, params, reqId) => {
        if (tool === 'session/lua_eval') {
          // Parse FOLDER + NAME from the lua code so we hit the same path lookup.
          const folderMatch = params.code.match(/local FOLDER = "([^"]+)"/);
          const nameMatch = params.code.match(/local NAME = "([^"]+)"/);
          const folder = folderMatch ? folderMatch[1] : null;
          const name = nameMatch ? nameMatch[1] : null;
          if (folder && name) {
            const { mkdir } = await import('node:fs/promises');
            await mkdir(folder, { recursive: true });
            const outPath = join(folder, `${name}.wav`);
            // 0.1s of silence at 44.1kHz mono 16-bit
            const dataBytes = 4410 * 2;
            const wav = Buffer.alloc(44 + dataBytes);
            wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
            wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
            wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
            wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
            writeFileSync(outPath, wav);
            exportedPath = outPath;
          }
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: true,
              output: 'OK\nstart_samples=0\nend_samples=4410\nduration_samples=4410\nsample_rate=44100\n',
            })}],
          };
        }
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
      executeBatch: async () => ({ results: [] }),
    });
    app.decorate('requestCache', null);
    app.decorate('config', { maxConcurrentSessions: 5, allowGui: false });
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();
    const created = await sessionManager.create({ sessionName: 'xexp-test' });
    sessionId = created.session_id;
    sessionManager.get(sessionId).status = 'ready';
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('embeds iXML chunk with mashupMetadata when present', async () => {
    exportedPath = null;
    const meta = {
      planId: 'plan_xyz', renderId: 'render_abc',
      assetIds: ['asset_1', 'asset_2'],
      transformations: [{ regionRef: 'r1', op: 'time_stretch', ratio: 1.06 }],
    };
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/export`,
      payload: { filename: 'final', format: 'wav', mashupMetadata: meta },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `export failed: ${res.body}`);
    assert.ok(exportedPath);
    const buf = readFileSync(exportedPath);
    // Search for "iXML" chunk header
    const ixmlIdx = buf.indexOf('iXML');
    assert.ok(ixmlIdx > 0, 'iXML chunk not found in exported WAV');
    // Parse chunk size + payload
    const chunkSize = buf.readUInt32LE(ixmlIdx + 4);
    const payload = buf.slice(ixmlIdx + 8, ixmlIdx + 8 + chunkSize).toString('utf8');
    assert.ok(payload.includes('plan_xyz'), 'iXML missing planId');
    assert.ok(payload.includes('time_stretch'), 'iXML missing transformation op');
  });

  it('skips iXML embed when mashupMetadata absent', async () => {
    exportedPath = null;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/export`,
      payload: { filename: 'plain', format: 'wav' },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(exportedPath, 'WAV should still be produced');
    const buf = readFileSync(exportedPath);
    assert.equal(buf.indexOf('iXML'), -1, 'should not embed iXML without metadata');
  });
});
