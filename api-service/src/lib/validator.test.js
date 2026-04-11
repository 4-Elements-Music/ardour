import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJobSpec } from './validator.js';

function minimalSpec(overrides = {}) {
  return {
    session: {
      sample_rate: 48000,
      tempo: [{ bar: 1, bpm: 120 }],
      time_signature: [{ bar: 1, numerator: 4, denominator: 4 }],
      duration_bars: 4,
    },
    tracks: [{ name: 'Test', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] }],
    output: { formats: [{ format: 'wav' }] },
    ...overrides,
  };
}

describe('validateJobSpec', () => {
  it('accepts a minimal valid spec', () => {
    const { valid, errors } = validateJobSpec(minimalSpec());
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it('accepts a full-featured spec', () => {
    const { valid } = validateJobSpec({
      session: {
        sample_rate: 48000,
        tempo: [{ bar: 1, bpm: 120 }, { bar: 9, bpm: 140, ramp: true }],
        time_signature: [{ bar: 1, numerator: 4, denominator: 4 }, { bar: 9, numerator: 6, denominator: 8 }],
        duration_bars: 32,
        render_range: { start_bar: 1, end_bar: 16 },
      },
      tracks: [
        {
          name: 'Bass', type: 'audio', channels: 1,
          regions: [{ file: 'stems/bass.wav', position_bar: 1, loop_count: 4, gain_db: -3, fade_in_ms: 10, fade_out_ms: 50 }],
          plugins: [{ uri: 'urn:ardour:a-comp', params: { '0': -18.0 }, sidechain_source: 'Kick' }],
          sends: [{ bus: 'FX Reverb', gain_db: -12 }],
          automation: [{ target: 'gain', points: [{ bar: 1, value_db: -3 }, { bar: 16, value_db: -6 }] }],
          gain_db: -3, pan: 0.3,
        },
        {
          name: 'Lead', type: 'midi',
          regions: [{ notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }], position_bar: 1, length_bars: 4 }],
          instrument: { uri: 'urn:ardour:a-fluidsynth', files: ['sf2/piano.sf2'], bank: 0, program: 0 },
        },
      ],
      buses: [{ name: 'FX Reverb', type: 'aux', plugins: [{ uri: 'urn:ardour:a-reverb' }] }],
      vcas: [{ name: 'All Music', controls: ['Bass', 'Lead'], gain_db: 0 }],
      markers: [{ name: 'Intro', bar: 1 }],
      master: { gain_db: 0, plugins: [{ uri: 'urn:ardour:a-eq#stereo' }] },
      output: { formats: [{ format: 'wav', bit_depth: 24 }, { format: 'flac', bit_depth: 16, sample_rate: 44100 }], stems: false },
    });
    assert.equal(valid, true);
  });

  it('rejects missing session', () => {
    const { valid, errors } = validateJobSpec({ tracks: [{ name: 'X', type: 'audio' }], output: { formats: [{ format: 'wav' }] } });
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('session')));
  });

  it('rejects missing tracks', () => {
    const { valid } = validateJobSpec({
      session: { sample_rate: 48000, tempo: [{ bar: 1, bpm: 120 }], time_signature: [{ bar: 1, numerator: 4, denominator: 4 }], duration_bars: 4 },
      output: { formats: [{ format: 'wav' }] },
    });
    assert.equal(valid, false);
  });

  it('rejects empty tracks array', () => {
    const { valid } = validateJobSpec(minimalSpec({ tracks: [] }));
    assert.equal(valid, false);
  });

  it('rejects missing output', () => {
    const spec = minimalSpec();
    delete spec.output;
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('rejects invalid sample rate', () => {
    const spec = minimalSpec();
    spec.session.sample_rate = 12345;
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('rejects invalid track type', () => {
    const spec = minimalSpec();
    spec.tracks[0].type = 'video';
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('rejects invalid output format', () => {
    const spec = minimalSpec();
    spec.output.formats = [{ format: 'aac' }];
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('rejects tempo not starting at bar 1', () => {
    const spec = minimalSpec();
    spec.session.tempo = [{ bar: 5, bpm: 120 }];
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('bar 1')));
  });

  it('rejects time_signature not starting at bar 1', () => {
    const spec = minimalSpec();
    spec.session.time_signature = [{ bar: 2, numerator: 4, denominator: 4 }];
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('bar 1')));
  });

  it('rejects render_range exceeding duration', () => {
    const spec = minimalSpec();
    spec.session.render_range = { start_bar: 1, end_bar: 100 };
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('duration')));
  });

  it('rejects render_range start >= end', () => {
    const spec = minimalSpec();
    spec.session.render_range = { start_bar: 3, end_bar: 3 };
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('less than')));
  });

  it('rejects plugin automation without plugin_index', () => {
    const spec = minimalSpec();
    spec.tracks[0].automation = [{ target: 'plugin', param_index: 0, points: [{ bar: 1, value: 0.5 }] }];
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('plugin_index')));
  });

  it('rejects audio track with instrument', () => {
    const spec = minimalSpec();
    spec.tracks[0].instrument = { uri: 'urn:ardour:a-fluidsynth' };
    const { valid, errors } = validateJobSpec(spec);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes('instrument')));
  });

  it('rejects region with neither file nor notes', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions = [{ position_bar: 1 }];
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('rejects unknown top-level properties', () => {
    const spec = minimalSpec();
    spec.foo = 'bar';
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, false);
  });

  it('accepts MIDI notes with cc and pitch_bend', () => {
    const spec = minimalSpec();
    spec.tracks = [{
      name: 'Synth', type: 'midi',
      instrument: { uri: 'urn:ardour:a-fluidsynth' },
      regions: [{
        notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }],
        cc: [{ controller: 1, time_beat: 0, value: 64 }],
        pitch_bend: [{ time_beat: 0, value: 8192 }],
        position_bar: 1, length_bars: 4,
      }],
    }];
    const { valid } = validateJobSpec(spec);
    assert.equal(valid, true);
  });
});
