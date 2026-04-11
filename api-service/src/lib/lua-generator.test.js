import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateLuaScript } from './lua-generator.js';

function minimalSpec(overrides = {}) {
  return {
    session: {
      sample_rate: 48000,
      tempo: [{ bar: 1, bpm: 120 }],
      time_signature: [{ bar: 1, numerator: 4, denominator: 4 }],
      duration_bars: 4,
    },
    tracks: [{ name: 'Test', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] }],
    output: { formats: [{ format: 'wav', bit_depth: 24, sample_rate: 48000 }] },
    ...overrides,
  };
}

describe('generateLuaScript', () => {
  it('generates a script with audio backend setup', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('AudioEngine:set_backend("None (Dummy)"'));
    assert.ok(lua.includes('AudioEngine:set_sample_rate(48000)'));
    assert.ok(lua.includes('AudioEngine:start()'));
  });

  it('creates a session', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('create_session('));
    assert.ok(lua.includes('job-session'));
  });

  it('sets up tempo map', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('Temporal.TempoMap.write_copy()'));
    assert.ok(lua.includes('set_tempo(Temporal.Tempo(120'));
    assert.ok(lua.includes('Temporal.TempoMap.update(tm)'));
  });

  it('handles multiple tempos with ramp', () => {
    const spec = minimalSpec();
    spec.session.tempo = [
      { bar: 1, bpm: 120 },
      { bar: 5, bpm: 140, ramp: true },
    ];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('Tempo(120, 140'));
  });

  it('creates audio tracks', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('new_audio_track(2, 2'));
    assert.ok(lua.includes('"Test"'));
  });

  it('creates MIDI tracks with instrument', () => {
    const spec = minimalSpec();
    spec.tracks = [{
      name: 'Synth', type: 'midi',
      instrument: { uri: 'urn:ardour:a-fluidsynth', files: ['sf2/piano.sf2'] },
      regions: [{ notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }], position_bar: 1, length_bars: 4 }],
    }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('new_midi_track'));
    assert.ok(lua.includes('a-fluidsynth'));
    assert.ok(lua.includes('create_midi_region'));
    assert.ok(lua.includes('new_note_diff_command'));
  });

  it('imports audio files with path resolution', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('import_audio_file(Session'));
    assert.ok(lua.includes('/data/library/stems/kick.wav'));
  });

  it('handles loop_count > 1', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].loop_count = 4;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('for i = 0, 3 do'));
    assert.ok(lua.includes('clone_region'));
  });

  it('handles pitch shift and time stretch', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].pitch_shift_semitones = 2;
    spec.tracks[0].regions[0].time_stretch_ratio = 1.5;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('Rubberband'));
    assert.ok(lua.includes('set_strech_and_pitch(1.5'));
    assert.ok(lua.includes('2 ^ (2 / 12.0)'));
  });

  it('handles region fades', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].fade_in_ms = 10;
    spec.tracks[0].regions[0].fade_out_ms = 50;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('set_fade_in_length'));
    assert.ok(lua.includes('set_fade_out_length'));
  });

  it('emits plugins with params', () => {
    const spec = minimalSpec();
    spec.tracks[0].plugins = [{ uri: 'urn:ardour:a-comp', params: { '0': -18.0, '1': 4.0 } }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('new_plugin(Session'));
    assert.ok(lua.includes('a-comp'));
    assert.ok(lua.includes('set_processor_param'));
  });

  it('emits mixer settings', () => {
    const spec = minimalSpec();
    spec.tracks[0].gain_db = -6;
    spec.tracks[0].pan = 0.3;
    spec.tracks[0].mute = true;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('gain_control():set_value'));
    assert.ok(lua.includes('pan_azimuth_control'));
    assert.ok(lua.includes('mute_control'));
  });

  it('emits gain automation', () => {
    const spec = minimalSpec();
    spec.tracks[0].automation = [{ target: 'gain', points: [{ bar: 1, value_db: -3 }, { bar: 4, value_db: -6 }] }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('gain_control()'));
    assert.ok(lua.includes('alist()'));
    assert.ok(lua.includes('set_automation_state'));
  });

  it('creates buses before tracks', () => {
    const spec = minimalSpec();
    spec.buses = [{ name: 'FX Reverb', type: 'aux', plugins: [{ uri: 'urn:ardour:a-reverb' }] }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    const busIdx = lua.indexOf('Bus: FX Reverb');
    const trackIdx = lua.indexOf('Track: Test');
    assert.ok(busIdx < trackIdx, 'buses should appear before tracks');
  });

  it('emits master bus settings', () => {
    const spec = minimalSpec();
    spec.master = { gain_db: 0, plugins: [{ uri: 'urn:ardour:a-eq#stereo' }] };
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('master_out()'));
    assert.ok(lua.includes('a-eq#stereo'));
  });

  it('emits export with SimpleExport', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.includes('simple_export()'));
    assert.ok(lua.includes('set_name("output")'));
    assert.ok(lua.includes('run_export()'));
  });

  it('uses CD preset for 16-bit 44100', () => {
    const spec = minimalSpec();
    spec.output.formats = [{ format: 'wav', bit_depth: 16, sample_rate: 44100 }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('df340c53-88b5-4342-a1c8-58e0704872ea'));
  });

  it('closes session at the end', () => {
    const lua = generateLuaScript(minimalSpec(), '/tmp/job1', '/data/library');
    assert.ok(lua.trimEnd().endsWith('close_session()'));
  });

  it('throws on path traversal in file reference', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].file = '../../../etc/passwd';
    assert.throws(
      () => generateLuaScript(spec, '/tmp/job1', '/data/library'),
      /Path traversal/
    );
  });

  it('emits sends to buses', () => {
    const spec = minimalSpec();
    spec.buses = [{ name: 'FX Reverb', type: 'aux', plugins: [{ uri: 'urn:ardour:a-reverb' }] }];
    spec.tracks[0].sends = [{ bus: 'FX Reverb', gain_db: -12 }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('add_internal_send'));
    assert.ok(lua.includes('send_level_controllable'));
    assert.ok(lua.includes('FX Reverb'));
  });

  it('emits VCA creation and track assignment', () => {
    const spec = minimalSpec();
    spec.vcas = [{ name: 'All Music', controls: ['Test'], gain_db: -3 }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('vca_manager'));
    assert.ok(lua.includes('create_vca'));
    assert.ok(lua.includes('to_slavable'));
    assert.ok(lua.includes('assign'));
  });

  it('routes source_tracks to group bus', () => {
    const spec = minimalSpec();
    spec.tracks = [
      { name: 'Kick', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] },
      { name: 'Snare', type: 'audio', regions: [{ file: 'stems/snare.wav', position_bar: 1 }] },
    ];
    spec.buses = [{
      name: 'Drum Bus', type: 'group',
      source_tracks: ['Kick', 'Snare'],
      plugins: [{ uri: 'urn:ardour:a-comp#stereo' }],
    }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('add_internal_send'));
    assert.ok(lua.includes('Kick'));
    assert.ok(lua.includes('Drum Bus'));
  });

  it('emits track groups for tracks sharing a group name', () => {
    const spec = minimalSpec();
    spec.tracks = [
      { name: 'Kick', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }], group: 'Drums' },
      { name: 'Snare', type: 'audio', regions: [{ file: 'stems/snare.wav', position_bar: 1 }], group: 'Drums' },
    ];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('new_route_group'));
    assert.ok(lua.includes('Drums'));
  });

  it('emits markers at bar positions', () => {
    const spec = minimalSpec();
    spec.markers = [{ name: 'Intro', bar: 1 }, { name: 'Chorus', bar: 9 }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('locations'));
    assert.ok(lua.includes('add_range'));
    assert.ok(lua.includes('Intro'));
    assert.ok(lua.includes('Chorus'));
  });

  it('emits start_offset_ms for audio regions', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].start_offset_ms = 500;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('set_start'));
    // 500ms at 48000 sample rate = 24000 samples
    assert.ok(lua.includes('24000'));
  });

  it('emits length_bars trim for audio regions', () => {
    const spec = minimalSpec();
    spec.tracks[0].regions[0].length_bars = 2;
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('set_length'));
  });

  it('emits MIDI CC events', () => {
    const spec = minimalSpec();
    spec.tracks = [{
      name: 'Synth', type: 'midi',
      instrument: { uri: 'urn:ardour:a-fluidsynth' },
      regions: [{
        notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }],
        cc: [{ controller: 1, time_beat: 0, value: 64 }, { controller: 1, time_beat: 2, value: 127 }],
        position_bar: 1, length_bars: 4,
      }],
    }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('MidiCCAutomation'));
    assert.ok(lua.includes('automation_control'));
  });

  it('uses render_range for export when specified', () => {
    const spec = minimalSpec();
    spec.session.duration_bars = 16;
    spec.session.render_range = { start_bar: 5, end_bar: 12 };
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('set_range'));
    // When render_range is set, should NOT use current_start_sample
    assert.ok(!lua.includes('current_start_sample'));
  });

  it('emits MIDI pitch bend events', () => {
    const spec = minimalSpec();
    spec.tracks = [{
      name: 'Synth', type: 'midi',
      instrument: { uri: 'urn:ardour:a-fluidsynth' },
      regions: [{
        notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }],
        pitch_bend: [{ time_beat: 0, value: 8192 }, { time_beat: 2, value: 16383 }],
        position_bar: 1, length_bars: 4,
      }],
    }];
    const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
    assert.ok(lua.includes('MidiPitchBenderAutomation'));
  });
});
