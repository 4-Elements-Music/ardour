import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisOutput } from './analyzer.js';

describe('parseAnalysisOutput', () => {
  it('parses ANALYSIS_JSON lines from stdout', () => {
    const stdout = [
      'some random output',
      'ANALYSIS_JSON:{"track":"Bass","peak_db":-3.1,"rms_db":-18.4}',
      'ANALYSIS_JSON:{"track":"__master__","peak_db":-0.3,"rms_db":-14.2}',
      'more random output',
    ].join('\n');

    const result = parseAnalysisOutput(stdout);
    assert.ok(result.master);
    assert.equal(result.master.peak_db, -0.3);
    assert.ok(result.tracks.length === 1);
    assert.equal(result.tracks[0].name, 'Bass');
    assert.equal(result.tracks[0].peak_db, -3.1);
  });

  it('returns empty analysis for no ANALYSIS_JSON lines', () => {
    const result = parseAnalysisOutput('no analysis here');
    assert.equal(result.master, null);
    assert.deepEqual(result.tracks, []);
  });
});
