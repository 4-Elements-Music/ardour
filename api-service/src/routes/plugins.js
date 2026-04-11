export async function pluginRoutes(app) {
  app.get('/plugins', async () => {
    return [
      { name: 'ACE Compressor', uri: 'urn:ardour:a-comp', type: 'LV2', category: 'Dynamics' },
      { name: 'ACE Compressor (stereo)', uri: 'urn:ardour:a-comp#stereo', type: 'LV2', category: 'Dynamics' },
      { name: 'ACE EQ', uri: 'urn:ardour:a-eq', type: 'LV2', category: 'EQ' },
      { name: 'ACE EQ (stereo)', uri: 'urn:ardour:a-eq#stereo', type: 'LV2', category: 'EQ' },
      { name: 'ACE Reverb', uri: 'urn:ardour:a-reverb', type: 'LV2', category: 'Reverb' },
      { name: 'ACE Reverb (stereo)', uri: 'urn:ardour:a-reverb#stereo', type: 'LV2', category: 'Reverb' },
      { name: 'ACE Delay', uri: 'urn:ardour:a-delay', type: 'LV2', category: 'Delay' },
      { name: 'ACE FluidSynth', uri: 'urn:ardour:a-fluidsynth', type: 'LV2', category: 'Instrument' },
      { name: 'Reasonable Synth', uri: 'https://community.ardour.org/node/7596', type: 'LV2', category: 'Instrument' },
    ];
  });
}
