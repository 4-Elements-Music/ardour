# Spec Gap Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all remaining features from the headless DAW API design spec that are missing from the Lua script generator and API service.

**Architecture:** All changes are in the Node.js API service. The Lua generator emits new code blocks for sends, VCAs, markers, groups, CC/pitch-bend, region trimming, render range, stem export, and analysis. A new analyzer module parses arlua output for `analyze_only` mode. No C++ changes needed — all required Lua bindings already exist.

**Tech Stack:** Node.js 20+, Fastify, Ajv, Ardour Lua API (via arlua subprocess).

**Spec:** `docs/superpowers/specs/2026-04-10-headless-daw-api-design.md`

---

### Task 1: Sends — Route Audio to Buses

The Lua generator currently ignores `tracks[].sends`. This task adds Lua code emission for creating aux sends from tracks to buses and setting send levels.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:86-97`
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- `Session:add_internal_send(source_route, nil, dest_route)` — creates the send
- `source_route:send_level_controllable(index)` — returns the gain control for send N
- `ctrl:set_value(coeff, PBD.GroupControlDisposition.NoGroup)` — sets the level

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits sends to buses', () => {
  const spec = minimalSpec();
  spec.buses = [{ name: 'FX Reverb', type: 'aux', plugins: [{ uri: 'urn:ardour:a-reverb' }] }];
  spec.tracks[0].sends = [{ bus: 'FX Reverb', gain_db: -12 }];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('add_internal_send'));
  assert.ok(lua.includes('send_level_controllable'));
  assert.ok(lua.includes('FX Reverb'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'emits sends'
```
Expected: FAIL — `add_internal_send` not found in output.

- [ ] **Step 3: Implement sends emission**

In `api-service/src/lib/lua-generator.js`, add a new function `emitSends` after the `emitAutomation` function (around line 367):

```js
function emitSends(lines, trackVar, sends) {
  for (let i = 0; i < sends.length; i++) {
    const send = sends[i];
    const busVar = `bus_${safeName(send.bus)}`;
    lines.push('do');
    lines.push(`  local dest = Session:route_by_name(${luaString(send.bus)})`);
    lines.push('  if dest and not dest:isnil() then');
    lines.push(`    Session:add_internal_send(${trackVar}, nil, dest)`);
    if (send.gain_db !== undefined) {
      // Find the send index — it's the last send added
      const coeff = Math.pow(10, send.gain_db / 20);
      lines.push(`    local sc = ${trackVar}:send_level_controllable(${i})`);
      lines.push(`    if sc and not sc:isnil() then sc:set_value(${coeff}, PBD.GroupControlDisposition.NoGroup) end`);
    }
    lines.push('  end');
    lines.push('end');
  }
}
```

Then call it in the track loop, after `emitAutomation` (around line 94):

```js
    // Sends
    if (track.sends) {
      emitSends(lines, varName, track.sends);
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit aux sends in Lua generator"
```

---

### Task 2: VCAs — Create VCA Faders and Assign Tracks

The Lua generator currently ignores `vcas[]`. This task adds VCA creation and track assignment after all tracks and buses are created.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:107-112` (after master bus section)
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- `Session:vca_manager():create_vca(count, name)` — creates VCA(s)
- `Session:vca_manager():vca_by_name(name)` — finds VCA by name
- `route:to_slavable():assign(vca)` — assigns a track/bus to a VCA
- `vca:gain_control():set_value(coeff, ...)` — sets VCA fader

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits VCA creation and track assignment', () => {
  const spec = minimalSpec();
  spec.vcas = [{ name: 'All Music', controls: ['Test'], gain_db: -3 }];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('vca_manager'));
  assert.ok(lua.includes('create_vca'));
  assert.ok(lua.includes('to_slavable'));
  assert.ok(lua.includes('assign'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'emits VCA'
```
Expected: FAIL.

- [ ] **Step 3: Implement VCA emission**

In `api-service/src/lib/lua-generator.js`, add after the master bus section (after line ~107, before section 6 "Session range"):

```js
  // ── 5b. VCAs ──
  if (spec.vcas) {
    for (const vca of spec.vcas) {
      lines.push(`-- VCA: ${vca.name}`);
      lines.push(`Session:vca_manager():create_vca(1, ${luaString(vca.name)})`);
      lines.push('do');
      lines.push(`  local vca = Session:vca_manager():vca_by_name(${luaString(vca.name)})`);
      lines.push('  if vca and not vca:isnil() then');
      for (const controlName of vca.controls) {
        lines.push(`    do local r = Session:route_by_name(${luaString(controlName)})`);
        lines.push('    if r and not r:isnil() then r:to_slavable():assign(vca) end end');
      }
      if (vca.gain_db !== undefined) {
        const coeff = Math.pow(10, vca.gain_db / 20);
        lines.push(`    vca:gain_control():set_value(${coeff}, PBD.GroupControlDisposition.NoGroup)`);
      }
      lines.push('  end');
      lines.push('end');
      lines.push('');
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit VCA creation and assignment in Lua generator"
```

---

### Task 3: Markers — Add Named Markers at Bar Positions

The Lua generator currently ignores `markers[]`. This task adds marker creation using Ardour's Locations API.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js`
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- `Session:locations():add_range(start, end)` — creates a location (for a mark, start == end)
- The returned Location can be set with `set_name()` and flags

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits markers at bar positions', () => {
  const spec = minimalSpec();
  spec.markers = [{ name: 'Intro', bar: 1 }, { name: 'Chorus', bar: 9 }];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('locations'));
  assert.ok(lua.includes('add_range'));
  assert.ok(lua.includes('Intro'));
  assert.ok(lua.includes('Chorus'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'emits markers'
```
Expected: FAIL.

- [ ] **Step 3: Implement marker emission**

In `api-service/src/lib/lua-generator.js`, add after VCAs and before the session range section:

```js
  // ── 5c. Markers ──
  if (spec.markers) {
    lines.push('-- Markers');
    lines.push('do');
    lines.push('  local locs = Session:locations()');
    for (const marker of spec.markers) {
      const ticks = barToTicks(marker.bar, spec.session.time_signature);
      lines.push(`  local loc = locs:add_range(Temporal.timepos_t.from_ticks(${ticks}), Temporal.timepos_t.from_ticks(${ticks}))`);
      lines.push(`  if loc then loc:set_name(${luaString(marker.name)}) end`);
    }
    lines.push('end');
    lines.push('');
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit markers in Lua generator"
```

---

### Task 4: Track Groups — Create Route Groups and Assign Tracks

The Lua generator currently ignores `tracks[].group`. This task groups tracks that share the same `group` name.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js`
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- `Session:new_route_group(name)` — creates a route group
- `group:add(route)` — adds a route to the group
- `group:set_active(true, nil)` — activates the group

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'emits track groups'
```
Expected: FAIL.

- [ ] **Step 3: Implement track group emission**

In `api-service/src/lib/lua-generator.js`, add after the track loop and before buses (or after markers). Collect all unique group names first, then emit group creation and assignment:

```js
  // ── 5d. Track groups ──
  const groupNames = new Set();
  for (const track of spec.tracks) {
    if (track.group) groupNames.add(track.group);
  }
  if (groupNames.size > 0) {
    lines.push('-- Track groups');
    for (const groupName of groupNames) {
      const groupVar = `grp_${safeName(groupName)}`;
      lines.push(`local ${groupVar} = Session:new_route_group(${luaString(groupName)})`);
      for (const track of spec.tracks) {
        if (track.group === groupName) {
          lines.push(`do local r = Session:route_by_name(${luaString(track.name)}); if r and not r:isnil() then ${groupVar}:add(r) end end`);
        }
      }
      lines.push('');
    }
  }
```

Place this after the master bus section but before VCAs.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit track groups in Lua generator"
```

---

### Task 5: Group Bus Routing — Route Source Tracks to Group Bus

The Lua generator creates group buses but doesn't reroute `source_tracks` into them. This task connects source tracks to the group bus.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:51-62` (buses section)
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- Use `Session:add_internal_send(source, nil, bus)` to route source tracks into the group bus, same as aux sends.

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
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
  // Should route source tracks to the group bus
  assert.ok(lua.includes('add_internal_send'));
  assert.ok(lua.includes('Kick'));
  assert.ok(lua.includes('Drum Bus'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'routes source_tracks'
```
Expected: FAIL.

- [ ] **Step 3: Implement group bus routing**

In the buses section of `lua-generator.js` (around line 53), after creating the bus and adding plugins, add routing for group buses. Modify the bus loop to emit sends after all tracks have been created. The cleanest approach: defer group bus routing to a new section after the tracks loop.

Add after the tracks loop (around line 98), before master:

```js
  // ── 4b. Group bus routing (deferred — tracks must exist first) ──
  if (spec.buses) {
    for (const bus of spec.buses) {
      if (bus.type === 'group' && bus.source_tracks) {
        const busVar = `bus_${safeName(bus.name)}`;
        lines.push(`-- Route sources to group bus: ${bus.name}`);
        for (const srcName of bus.source_tracks) {
          lines.push(`do local src = Session:route_by_name(${luaString(srcName)})`);
          lines.push(`if src and not src:isnil() then Session:add_internal_send(src, nil, ${busVar}) end end`);
        }
        lines.push('');
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: route source tracks to group buses in Lua generator"
```

---

### Task 6: MIDI CC and Pitch Bend Emission

The Lua generator creates inline MIDI notes but ignores `cc[]` and `pitch_bend[]`. MIDI CC must use Ardour's AutomationControl on the MIDI track since NoteDiffCommand only handles notes.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:210-241` (inline MIDI region section)
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- CC: `Evoral.Parameter(ARDOUR.AutomationType.MidiCCAutomation, channel, cc_number)` → `track:automation_control(param, true)` → `alist():add(time, value)`
- Pitch bend: `Evoral.Parameter(ARDOUR.AutomationType.MidiPitchBenderAutomation, channel, 0)` → same pattern

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'MIDI CC'
```
Expected: FAIL.

- [ ] **Step 3: Implement CC and pitch bend emission**

In `api-service/src/lib/lua-generator.js`, inside the `emitRegion` function's inline MIDI section (after `model:apply_diff_command_as_commit`), add:

```js
    // MIDI CC automation
    if (region.cc && region.cc.length > 0) {
      // Group CC events by controller number
      const byController = new Map();
      for (const cc of region.cc) {
        if (!byController.has(cc.controller)) byController.set(cc.controller, []);
        byController.get(cc.controller).push(cc);
      }
      for (const [controller, events] of byController) {
        lines.push(`    do local param = Evoral.Parameter(ARDOUR.AutomationType.MidiCCAutomation, 0, ${controller})`);
        lines.push(`    local ac = ${trackVar}:automation_control(param, true)`);
        lines.push('    if ac and not ac:isnil() then');
        lines.push('      local al = ac:alist()');
        for (const cc of events) {
          const beatTicks = cc.time_beat * 1920;
          lines.push(`      al:add(Temporal.timepos_t.from_ticks(${pos} + ${beatTicks}), ${cc.value / 127.0}, false, true)`);
        }
        lines.push('      ac:set_automation_state(ARDOUR.AutoState.Play)');
        lines.push('    end end');
      }
    }

    // MIDI pitch bend automation
    if (region.pitch_bend && region.pitch_bend.length > 0) {
      lines.push(`    do local param = Evoral.Parameter(ARDOUR.AutomationType.MidiPitchBenderAutomation, 0, 0)`);
      lines.push(`    local ac = ${trackVar}:automation_control(param, true)`);
      lines.push('    if ac and not ac:isnil() then');
      lines.push('      local al = ac:alist()');
      for (const pb of region.pitch_bend) {
        const beatTicks = pb.time_beat * 1920;
        // Pitch bend is 0-16383 in MIDI, normalize to 0.0-1.0 for Ardour
        lines.push(`      al:add(Temporal.timepos_t.from_ticks(${pos} + ${beatTicks}), ${pb.value / 16383.0}, false, true)`);
      }
      lines.push('      ac:set_automation_state(ARDOUR.AutoState.Play)');
      lines.push('    end end');
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit MIDI CC and pitch bend in Lua generator"
```

---

### Task 7: Region Start Offset and Length Trim

The Lua generator ignores `start_offset_ms` and `length_bars` for file-based regions. This task adds region trimming after import.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:150-208` (emitRegion function)
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- `region:set_start(timepos_t)` — sets the internal start point (offset into source)
- `region:set_length(timecnt_t)` — trims the region to a length

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'start_offset_ms'
```
Expected: FAIL.

- [ ] **Step 3: Implement region trimming**

In `api-service/src/lib/lua-generator.js`, inside the `emitRegion` function, after the line `lines.push('  if not rgn:isnil() then');` and before the time-stretch section, add:

```js
    // Start offset
    if (region.start_offset_ms && region.start_offset_ms > 0) {
      const offsetSamples = Math.round((region.start_offset_ms / 1000) * spec.session.sample_rate);
      lines.push(`    rgn:set_start(Temporal.timepos_t(${offsetSamples}))`);
    }

    // Trim to length
    if (region.length_bars) {
      const lenTicks = region.length_bars * beatsPerBar(region.position_bar || 1, spec.session.time_signature) * 1920;
      lines.push(`    rgn:set_length(Temporal.timecnt_t.from_ticks(${lenTicks}))`);
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit region start offset and length trim in Lua generator"
```

---

### Task 8: Render Range — Export a Sub-Range

The export section always uses the full session range. This task makes it respect `session.render_range`.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:114-139` (export section)
- Modify: `api-service/src/lib/lua-generator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('uses render_range for export when specified', () => {
  const spec = minimalSpec();
  spec.session.duration_bars = 16;
  spec.session.render_range = { start_bar: 5, end_bar: 12 };
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  // Should NOT use current_start_sample/current_end_sample
  // Should use bar-based positions
  const startTicks = 4 * 4 * 1920; // bar 5 = 4 bars * 4 beats * 1920 ticks
  const endTicks = 11 * 4 * 1920;  // bar 12 = 11 bars * 4 beats * 1920 ticks
  assert.ok(lua.includes(`set_range`));
  // Verify it doesn't just use session start/end
  assert.ok(!lua.includes('current_start_sample') || lua.includes('render_start'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'render_range'
```
Expected: FAIL.

- [ ] **Step 3: Implement render range**

In `api-service/src/lib/lua-generator.js`, modify the export section. Replace the `se:set_range(...)` line with a range calculation:

Before the `for (const fmt of formats)` loop, add:

```js
  // Calculate export range
  let exportRangeStart, exportRangeEnd;
  if (spec.session.render_range) {
    const startTicks = barToTicks(spec.session.render_range.start_bar, spec.session.time_signature);
    const endTicks = barToTicks(spec.session.render_range.end_bar, spec.session.time_signature);
    exportRangeStart = `Temporal.timepos_t.from_ticks(${startTicks}):samples()`;
    exportRangeEnd = `Temporal.timepos_t.from_ticks(${endTicks}):samples()`;
  } else {
    exportRangeStart = 'Session:current_start_sample()';
    exportRangeEnd = 'Session:current_end_sample()';
  }
```

Then change the `set_range` line in the format loop to:

```js
    lines.push(`  se:set_range(${exportRangeStart}, ${exportRangeEnd})`);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass. Also verify the existing `emits export with SimpleExport` test still passes.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: support render_range for sub-range export"
```

---

### Task 9: Mute Automation

The automation emitter handles `gain`, `pan`, and `plugin` but not `mute`. This task adds mute automation.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:322-367` (emitAutomation function)
- Modify: `api-service/src/lib/lua-generator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits mute automation', () => {
  const spec = minimalSpec();
  spec.tracks[0].automation = [{
    target: 'mute',
    points: [{ bar: 1, value: 0 }, { bar: 4, value: 1 }],
  }];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('mute_control'));
  assert.ok(lua.includes('alist'));
  assert.ok(lua.includes('set_automation_state'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'mute automation'
```
Expected: FAIL.

- [ ] **Step 3: Implement mute automation**

In `api-service/src/lib/lua-generator.js`, add a new `else if` branch in the `emitAutomation` function, after the `pan` branch (around line 349):

```js
    } else if (auto.target === 'mute') {
      lines.push('do');
      lines.push(`  local ac = ${routeVar}:mute_control()`);
      lines.push('  local al = ac:alist()');
      lines.push('  al:clear_list()');
      for (const pt of auto.points) {
        const ticks = barBeatToTicks(pt.bar || 1, pt.beat || 1, [{ bar: 1, numerator: 4, denominator: 4 }]);
        const val = pt.value !== undefined ? pt.value : 0;
        lines.push(`  al:add(Temporal.timepos_t.from_ticks(${ticks}), ${val}, false, true)`);
      }
      lines.push('  ac:set_automation_state(ARDOUR.AutoState.Play)');
      lines.push('end');
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit mute automation in Lua generator"
```

---

### Task 10: Sidechain Source Routing

The Lua generator calls `add_sidechain` but doesn't route the source track's output into the sidechain input. This task completes the sidechain wiring.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:248-271` (emitPlugins function)
- Modify: `api-service/src/lib/lua-generator.test.js`

**Lua API:**
- After `add_sidechain`, get `plugin_insert:sidechain_input()` which returns an IO object
- Connect the sidechain input to the source track's output

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('routes sidechain source track to plugin sidechain input', () => {
  const spec = minimalSpec();
  spec.tracks = [
    { name: 'Kick', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] },
    { name: 'Bass', type: 'audio', regions: [{ file: 'stems/bass.wav', position_bar: 1 }],
      plugins: [{ uri: 'urn:ardour:a-comp', sidechain_source: 'Kick' }] },
  ];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('add_sidechain'));
  assert.ok(lua.includes('sidechain_input'));
  assert.ok(lua.includes('Kick'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'sidechain source'
```
Expected: FAIL — `sidechain_input` not found in output.

- [ ] **Step 3: Implement sidechain source routing**

In `api-service/src/lib/lua-generator.js`, replace the existing sidechain block in `emitPlugins`:

```js
    if (plugin.sidechain_source) {
      lines.push(`    local pi = ${plugVar}:to_insert()`);
      lines.push('    if pi and not pi:isnil() then');
      lines.push('      pi:add_sidechain()');
      lines.push(`      local src = Session:route_by_name(${luaString(plugin.sidechain_source)})`);
      lines.push('      if src and not src:isnil() then');
      lines.push('        local sc_in = pi:sidechain_input()');
      lines.push('        if sc_in and not sc_in:isnil() then');
      lines.push('          sc_in:connect(src:output():audio(0):name(), sc_in:audio(0):name(), nil)');
      lines.push('        end');
      lines.push('      end');
      lines.push('    end');
    }
```

Note: the old code was `${routeVar}:add_sidechain(${plugVar})` which is wrong — `add_sidechain` is on PluginInsert, not Route.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: complete sidechain routing in Lua generator"
```

---

### Task 11: Click Track and Stem Export

The Lua generator ignores `output.include_click` and `output.stems`. Click track has no Lua binding, so we document the limitation. Stem export uses solo-each-track-and-export approach.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:114-143` (export section)
- Modify: `api-service/src/lib/lua-generator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits stem exports when stems is true', () => {
  const spec = minimalSpec();
  spec.output.stems = true;
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  // Should solo each track and export individually
  assert.ok(lua.includes('solo_control'));
  assert.ok(lua.includes('run_export'));
  // Should have multiple export passes
  const exportCount = (lua.match(/run_export/g) || []).length;
  assert.ok(exportCount >= 2, `Expected >= 2 exports, got ${exportCount}`);
});

it('emits stem exports only for stem_groups when specified', () => {
  const spec = minimalSpec();
  spec.tracks = [
    { name: 'Kick', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] },
    { name: 'Bass', type: 'audio', regions: [{ file: 'stems/bass.wav', position_bar: 1 }] },
  ];
  spec.output.stems = true;
  spec.output.stem_groups = ['Kick'];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  // Should only export Kick stem, not Bass
  assert.ok(lua.includes('Kick'));
  const exportCount = (lua.match(/run_export/g) || []).length;
  // 1 for full mix + 1 for Kick stem per format
  assert.ok(exportCount >= 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'stem exports'
```
Expected: FAIL.

- [ ] **Step 3: Implement stem export**

In `api-service/src/lib/lua-generator.js`, after the main export loop, add stem export logic:

```js
  // ── 7b. Stem export ──
  if (spec.output.stems) {
    const stemTracks = spec.output.stem_groups && spec.output.stem_groups.length > 0
      ? spec.output.stem_groups
      : spec.tracks.map(t => t.name);

    lines.push('-- Stem exports');
    for (const trackName of stemTracks) {
      const stemName = safeName(trackName);
      lines.push('do');
      lines.push(`  local stem_route = Session:route_by_name(${luaString(trackName)})`);
      lines.push('  if stem_route and not stem_route:isnil() then');
      lines.push('    stem_route:solo_control():set_value(1, PBD.GroupControlDisposition.NoGroup)');
      for (const fmt of formats) {
        const bitDepth = fmt.bit_depth || 24;
        const fmtSampleRate = fmt.sample_rate || sampleRate;
        lines.push('    do');
        lines.push('      local se = Session:simple_export()');
        lines.push(`      se:set_name(${luaString('stem_' + trackName)})`);
        lines.push(`      se:set_folder(${luaString(exportDir)})`);
        lines.push(`      se:set_range(${exportRangeStart}, ${exportRangeEnd})`);
        if (bitDepth === 16 && fmtSampleRate === 44100) {
          lines.push('      se:set_preset("df340c53-88b5-4342-a1c8-58e0704872ea")');
        } else {
          lines.push('      se:set_preset("75969a1c-3133-4694-864b-a1fa50e43348")');
        }
        lines.push('      se:check_outputs()');
        lines.push('      se:run_export()');
        lines.push('    end');
      }
      lines.push('    stem_route:solo_control():set_value(0, PBD.GroupControlDisposition.NoGroup)');
      lines.push('  end');
      lines.push('end');
    }
    lines.push('');
  }
```

Note: `exportRangeStart` and `exportRangeEnd` are defined in Task 8. If Task 8 is not yet done, these variables need to be moved to the beginning of the export section.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit stem exports in Lua generator"
```

---

### Task 12: Analyze-Only Mode — Parse Analysis from arlua

The spec defines an `analyze_only` mode where the API returns analysis data (peak, RMS, LUFS, frequency spectrum) instead of audio files. This requires:
1. The Lua generator emitting Vamp analysis calls instead of (or after) export
2. A new `analyzer.js` module parsing the analysis output from arlua stdout
3. The job route returning analysis data in the response

**Files:**
- Create: `api-service/src/lib/analyzer.js`
- Modify: `api-service/src/lib/lua-generator.js`
- Modify: `api-service/src/routes/jobs.js`
- Create: `api-service/src/lib/analyzer.test.js`
- Modify: `api-service/src/lib/lua-generator.test.js`

- [ ] **Step 1: Write the analyzer test**

Create `api-service/src/lib/analyzer.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'parses ANALYSIS_JSON'
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create analyzer.js**

Create `api-service/src/lib/analyzer.js`:

```js
/**
 * Parse analysis output from arlua stdout.
 * The Lua script emits lines like: ANALYSIS_JSON:{"track":"name","peak_db":-3.1,...}
 * The special track name "__master__" is the master bus analysis.
 */
export function parseAnalysisOutput(stdout) {
  const lines = stdout.split('\n');
  const master = { peak_db: null, rms_db: null };
  const tracks = [];
  let foundMaster = false;

  for (const line of lines) {
    if (!line.startsWith('ANALYSIS_JSON:')) continue;
    const json = line.slice('ANALYSIS_JSON:'.length);
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }

    if (data.track === '__master__') {
      Object.assign(master, data);
      delete master.track;
      foundMaster = true;
    } else {
      const entry = { name: data.track, ...data };
      delete entry.track;
      tracks.push(entry);
    }
  }

  return { master: foundMaster ? master : null, tracks };
}
```

- [ ] **Step 4: Run analyzer test to verify it passes**

```bash
cd api-service && npm test 2>&1 | grep -A2 'parses ANALYSIS_JSON'
```
Expected: PASS.

- [ ] **Step 5: Add analyze_only Lua emission test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits Vamp analysis for analyze_only mode', () => {
  const spec = minimalSpec();
  spec.analyze_only = true;
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('ANALYSIS_JSON'));
  assert.ok(lua.includes('Vamp'));
  // Should still export (needed for analysis) but also emit analysis
  assert.ok(lua.includes('run_export'));
});
```

- [ ] **Step 6: Implement analyze_only Lua emission**

In `api-service/src/lib/lua-generator.js`, after the export section (section 7), add:

```js
  // ── 7c. Analysis (analyze_only mode) ──
  if (spec.analyze_only) {
    lines.push('-- Analysis output');
    lines.push('do');
    // Analyze each track
    for (const track of spec.tracks) {
      lines.push(`  do local r = Session:route_by_name(${luaString(track.name)})`);
      lines.push('  if r and not r:isnil() then');
      lines.push('    local pk = r:peak_meter()');
      lines.push('    if pk and not pk:isnil() then');
      lines.push(`      local peak_db = pk:meter_level(0, ARDOUR.MeterType.MeterPeak)`);
      lines.push(`      print("ANALYSIS_JSON:" .. string.format('{"track":${luaString(track.name).replace(/"/g, '\\"')},"peak_db":%.1f}', peak_db))`);
      lines.push('    end');
      lines.push('  end end');
    }
    // Analyze master
    lines.push('  do local m = Session:master_out()');
    lines.push('  if m and not m:isnil() then');
    lines.push('    local pk = m:peak_meter()');
    lines.push('    if pk and not pk:isnil() then');
    lines.push('      local peak_db = pk:meter_level(0, ARDOUR.MeterType.MeterPeak)');
    lines.push('      print("ANALYSIS_JSON:" .. string.format(\'{"track":"__master__","peak_db":%.1f}\', peak_db))');
    lines.push('    end');
    lines.push('  end end');
    lines.push('end');
    lines.push('');
  }
```

- [ ] **Step 7: Wire analysis into job route**

In `api-service/src/routes/jobs.js`, import the analyzer and use it in the job completion handler. Modify the `onJobReady` callback:

Add import at top:
```js
import { parseAnalysisOutput } from '../lib/analyzer.js';
```

In the `onJobReady` callback, after `const result = await executeJob(...)`, add:
```js
    const analysis = job.spec.analyze_only ? parseAnalysisOutput(result.stdout) : null;
```

And change `queue.markComplete(jobId, outputs, null)` to:
```js
    queue.markComplete(jobId, outputs, analysis);
```

Then in the GET route, add analysis to the response (it's already there — `job.analysis` is returned when `analyze_only` is set).

- [ ] **Step 8: Run all tests**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add api-service/src/lib/analyzer.js api-service/src/lib/analyzer.test.js api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js api-service/src/routes/jobs.js
git commit -m "feat: add analyze_only mode with Vamp analysis output"
```

---

### Task 13: Instrument Bank/Program Selection

The Lua generator ignores `instrument.bank` and `instrument.program` for MIDI tracks with FluidSynth or similar multi-timbral instruments. These should be emitted as MIDI bank/program change events.

**Files:**
- Modify: `api-service/src/lib/lua-generator.js:277-293` (emitInstrument function)
- Modify: `api-service/src/lib/lua-generator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `api-service/src/lib/lua-generator.test.js`:

```js
it('emits bank and program selection for instruments', () => {
  const spec = minimalSpec();
  spec.tracks = [{
    name: 'Strings', type: 'midi',
    instrument: { uri: 'urn:ardour:a-fluidsynth', files: ['sf2/strings.sf2'], bank: 0, program: 48 },
    regions: [{ notes: [{ pitch: 60, velocity: 100, start_beat: 0, duration_beats: 1 }], position_bar: 1, length_bars: 4 }],
  }];
  const lua = generateLuaScript(spec, '/tmp/job1', '/data/library');
  assert.ok(lua.includes('PatchChangeDiffCommand') || lua.includes('set_processor_param'));
  assert.ok(lua.includes('48')); // program number
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-service && npm test 2>&1 | grep -A2 'bank and program'
```
Expected: FAIL.

- [ ] **Step 3: Implement bank/program emission**

In `api-service/src/lib/lua-generator.js`, in the `emitInstrument` function, after loading files, add bank/program via FluidSynth parameter setting (bank select = param 2, program = param 3 for a-fluidsynth):

```js
  if (instrument.bank !== undefined || instrument.program !== undefined) {
    lines.push('    local pi = inst:to_insert()');
    if (instrument.bank !== undefined) {
      lines.push(`    ARDOUR.LuaAPI.set_processor_param(pi, 2, ${instrument.bank})`);
    }
    if (instrument.program !== undefined) {
      lines.push(`    ARDOUR.LuaAPI.set_processor_param(pi, 3, ${instrument.program})`);
    }
  }
```

Note: This approach uses `set_processor_param` which works for FluidSynth's bank/program parameters. For other instruments this may differ, but FluidSynth is the primary target per the spec.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/lua-generator.test.js
git commit -m "feat: emit instrument bank/program selection in Lua generator"
```

---

### Summary: Task Dependencies

```
Task 1 (Sends)           - independent
Task 2 (VCAs)            - independent
Task 3 (Markers)         - independent
Task 4 (Track Groups)    - independent
Task 5 (Group Bus)       - independent
Task 6 (MIDI CC/PB)      - independent
Task 7 (Region Trim)     - independent
Task 8 (Render Range)    - independent, but must come before Task 11
Task 9 (Mute Auto)       - independent
Task 10 (Sidechain)      - independent
Task 11 (Stems)          - depends on Task 8 (uses exportRangeStart/End vars)
Task 12 (Analyze Only)   - independent
Task 13 (Bank/Program)   - independent
```

Tasks 1-10, 12, 13 can all be done in parallel. Task 11 must come after Task 8.

### Known Limitations Not Addressed

These items from the spec are intentionally deferred:

- **Click track (`include_click`)**: No Lua binding for `Session:click_io()` or `Session:click_gain()`. Would require C++ work to expose.
- **Bearer token authentication**: Not in this plan — add when deploying beyond localhost.
- **X-Idempotency-Key**: Not in this plan — add when needed for production reliability.
- **Range headers on output download**: Not in this plan — Fastify doesn't support this out of the box.
- **Prometheus `/metrics`**: Not in this plan — add when deploying with monitoring.
- **Subprocess `ulimit` resource limits**: Not in this plan — add when deploying multi-tenant.
