const state = {
  sessionId: null,
  tools: [],
};

// Silent endpoints — called frequently, log full response is noise
const SILENT_GET_PATHS = new Set(['/v1/tools']);
// Always-silent polling endpoints (we still log errors)
function isPollingPath(method, path) {
  return method === 'GET' && path === '/v1/sessions';
}

async function api(method, path, body, { silent = false } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const shouldLog = !silent
    && !(res.ok && isPollingPath(method, path))  // hide successful polling
    && !(res.ok && SILENT_GET_PATHS.has(path)); // hide successful /v1/tools
  if (shouldLog) logEntry(method, path, res.status, json, res.ok);
  return { ok: res.ok, status: res.status, body: json };
}

function isAtBottom(container, tolerance = 40) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < tolerance;
}

function logEntry(method, path, status, data, ok) {
  const log = document.getElementById('log');
  const wasAtBottom = isAtBottom(log);

  const el = document.createElement('details');
  el.className = 'log-entry ' + (ok ? 'success' : 'error');
  const summary = document.createElement('summary');
  const timestamp = new Date().toLocaleTimeString();
  summary.innerHTML =
    `<span class="time">${timestamp}</span> ` +
    `<span class="method">${escapeHtml(method)}</span> ` +
    `<span class="path">${escapeHtml(path)}</span> ` +
    `<span class="status">${status}</span>`;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'entry-copy';
  copyBtn.textContent = 'copy';
  copyBtn.title = 'Copy this entry';
  copyBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = summary.innerText + '\n' + JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'copied';
      setTimeout(() => { copyBtn.textContent = prev; }, 900);
    } catch {
      copyBtn.textContent = 'failed';
    }
  };
  summary.appendChild(copyBtn);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(data, null, 2);
  el.appendChild(summary);
  el.appendChild(pre);
  log.appendChild(el);

  // Only auto-scroll if user was already at the bottom
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

function getAllLogText() {
  const entries = document.querySelectorAll('#log .log-entry');
  const parts = [];
  for (const e of entries) {
    const summary = e.querySelector('summary')?.innerText || '';
    const pre = e.querySelector('pre')?.textContent || '';
    parts.push(summary + '\n' + pre);
  }
  return parts.join('\n\n---\n\n');
}

async function copyLogToClipboard() {
  try {
    await navigator.clipboard.writeText(getAllLogText());
    const btn = document.getElementById('btn-copy-log');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = orig, 1500);
    }
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshSessions() {
  const { body } = await api('GET', '/v1/sessions');
  const ul = document.getElementById('session-list');
  ul.innerHTML = '';
  for (const s of body.sessions || []) {
    const li = document.createElement('li');
    li.textContent = `${s.session_name} [${s.status}]`;
    if (s.session_id === state.sessionId) li.classList.add('active');
    li.onclick = () => { state.sessionId = s.session_id; updateIndicator(); refreshSessions(); };
    const logBtn = document.createElement('button');
    logBtn.textContent = 'log';
    logBtn.style.marginLeft = '4px';
    logBtn.onclick = async (e) => {
      e.stopPropagation();
      await viewSessionLog(s.session_id);
    };
    const del = document.createElement('button');
    del.textContent = 'x';
    del.style.marginLeft = '4px';
    del.onclick = async (e) => {
      e.stopPropagation();
      await api('DELETE', `/v1/sessions/${s.session_id}`);
      if (state.sessionId === s.session_id) state.sessionId = null;
      refreshSessions();
      updateIndicator();
    };
    li.appendChild(logBtn);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

async function viewSessionLog(sessionId) {
  // Fetch session details (for stderr_tail on dead sessions) and ring buffer logs
  const [detailRes, logRes] = await Promise.all([
    fetch(`/v1/sessions/${sessionId}`).then(r => r.json()).catch(() => null),
    fetch(`/v1/sessions/${sessionId}/logs`).then(r => r.json()).catch(() => null),
  ]);

  const parts = [];
  parts.push(`=== SESSION ${sessionId} ===`);
  if (detailRes) {
    parts.push(`status: ${detailRes.status}`);
    if (detailRes.exit_code != null) parts.push(`exit_code: ${detailRes.exit_code}`);
    if (detailRes.stderr_tail?.length) {
      parts.push('\n=== STDERR TAIL ===');
      parts.push(...detailRes.stderr_tail);
    }
  }
  if (logRes && logRes.lines?.length) {
    parts.push('\n=== LOG BUFFER ===');
    for (const line of logRes.lines) parts.push(`[${line.seq}] ${line.text}`);
  } else {
    parts.push('\n=== LOG BUFFER ===');
    parts.push('(empty)');
  }

  const text = parts.join('\n');
  logEntry('LOG', `session ${sessionId.slice(0, 8)}`, 200, { log: text }, true);
}

function updateIndicator() {
  const el = document.getElementById('session-indicator');
  if (state.sessionId) {
    el.textContent = '● ' + state.sessionId.slice(0, 8);
    el.classList.add('connected');
  } else {
    el.textContent = '● No session';
    el.classList.remove('connected');
  }
}

// Map a tool name to a display group. Order here controls section order in the dropdown.
const GROUP_ORDER = [
  ['Session',   t => t.startsWith('session') || t === 'session/lua_eval'],
  ['Transport', t => t.startsWith('transport_')],
  ['Markers',   t => t.startsWith('markers_')],
  ['Tracks',    t => t.startsWith('tracks_') || t === 'buses_add'],
  ['Track',     t => t.startsWith('track_')],
  ['Regions',   t => t.startsWith('region_') || t === 'audio_region_add' || t === 'midi_region_add'],
  ['MIDI',      t => t.startsWith('midi_')],
  ['Plugins',   t => t.startsWith('plugin_')],
];
function groupFor(toolName) {
  for (const [label, match] of GROUP_ORDER) if (match(toolName)) return label;
  return 'Other';
}

async function loadTools() {
  const { body } = await api('GET', '/v1/tools', null, { silent: true });
  state.tools = body.tools || [];
  const sel = document.getElementById('tool-select');
  sel.innerHTML = '';

  const groups = new Map();
  for (const [label] of GROUP_ORDER) groups.set(label, []);
  groups.set('Other', []);
  for (const t of state.tools) groups.get(groupFor(t.name)).push(t);

  for (const [label, tools] of groups) {
    if (!tools.length) continue;
    tools.sort((a, b) => a.name.localeCompare(b.name));
    const og = document.createElement('optgroup');
    og.label = label;
    for (const t of tools) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.onchange = () => renderParamForm(sel.value);
  if (state.tools.length) renderParamForm(sel.value || state.tools[0].name);
}

// Per-tool field overrides: hide fields, or replace them with dynamic dropdowns.
const TOOL_OVERRIDES = {
  plugin_add: {
    hide: ['uniqueId', 'type'],
    dynamic: {
      id:       { source: 'tracks',  label: 'Target track' },
      pluginId: { source: 'plugins', label: 'Plugin (VST3 preferred, AU fallback)' },
    },
  },
  plugin_set_parameter: {
    hide: ['controlId', 'interface'],
    dynamic: {
      id: { source: 'tracks', label: 'Target track' },
    },
    selects: ['pluginIndex', 'parameterIndex'],
  },
  audio_region_add: {
    hide: ['decodedPath'],
    dynamic: {
      trackId:  { source: 'tracks',  label: 'Track' },
      uploadId: { source: 'uploads', label: 'Audio file' },
    },
  },
};

async function fetchTracksRaw() {
  if (!state.sessionId) return [];
  const res = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
    { tool: 'tracks_list', params: {} }, { silent: true });
  const sc = res.body?.structuredContent || res.body?.result?.structuredContent || {};
  return sc.tracks || sc.routes || [];
}

async function fetchPluginsRaw() {
  if (!state.sessionId) return [];
  const res = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
    { tool: 'plugin_list_available', params: { includeHidden: true, includeInternal: true } }, { silent: true });
  const sc = res.body?.structuredContent || res.body?.result?.structuredContent || {};
  const all = sc.plugins || [];
  const RANK = { vst3: 0, audiounit: 1, lv2: 2, lua: 3 };
  const best = new Map();
  for (const p of all) {
    if (!(p.type in RANK)) continue;
    const key = `${p.creator}::${p.name}`;
    const prev = best.get(key);
    if (!prev || RANK[p.type] < RANK[prev.type]) best.set(key, p);
  }
  return [...best.values()].sort((a, b) =>
    (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
}

async function fetchUploads() {
  if (!state.sessionId) return [];
  const res = await api('GET', `/v1/sessions/${state.sessionId}`, null, { silent: true });
  const uploads = res.body?.uploads || [];
  return uploads.map(u => ({
    upload_id: u.upload_id,
    filename: u.filename,
    bytes: u.bytes,
  }));
}

async function trackHasInstrument(trackId) {
  const res = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
    { tool: 'track_get_info', params: { id: trackId } }, { silent: true });
  const sc = res.body?.structuredContent || res.body?.result?.structuredContent || {};
  const plugs = sc.plugins || [];
  return plugs.some(p => p.isInstrument || p.kind === 'instrument');
}

async function renderParamForm(toolName) {
  const tool = state.tools.find(t => t.name === toolName);
  const form = document.getElementById('param-form');
  form.innerHTML = '';
  if (!tool || !tool.input_schema || !tool.input_schema.properties) return;
  const props = tool.input_schema.properties;
  const override = TOOL_OVERRIDES[toolName] || {};
  const hide = new Set(override.hide || []);
  const dyn = override.dynamic || {};
  const asSelect = new Set(override.selects || []);

  // Prefetch raw data for dynamic sources.
  const sourceNeeded = new Set(Object.values(dyn).map(d => d.source));
  const sourceData = {};
  await Promise.all([...sourceNeeded].map(async (src) => {
    if (src === 'tracks')  sourceData.tracks  = await fetchTracksRaw();
    if (src === 'plugins') sourceData.plugins = await fetchPluginsRaw();
    if (src === 'uploads') sourceData.uploads = await fetchUploads();
  }));
  const formatTrack  = t => ({ value: t.id, label: `${t.name} (${t.type || '?'})` });
  const formatPlugin = p => ({ value: p.pluginId, label: `[${p.type}] ${p.category ? p.category + ' / ' : ''}${p.name} — ${p.creator}` });
  const formatUpload = u => ({ value: u.upload_id, label: `${u.filename} (${(u.bytes / 1024).toFixed(1)} KB)` });
  const HINTS = {
    strictIo: 'If true, lock the track\'s channel count to inputChannels/outputChannels (no auto-resize on connect).',
    insert: 'Where to place the new track: end of list, or before/after the anchor track.',
    relativeToId: 'Route ID anchor for insert=before|after. Leave blank to use the currently-selected track.',
  };
  for (const [key, spec] of Object.entries(props)) {
    if (hide.has(key)) continue;
    const label = document.createElement('label');
    const dynSpec = dyn[key];
    label.textContent = (dynSpec?.label || key) + (tool.input_schema.required?.includes(key) ? ' *' : '') + ':';
    const hint = HINTS[key] || spec.description;
    if (hint) {
      const h = document.createElement('div');
      h.className = 'param-hint';
      h.textContent = hint;
      label.appendChild(h);
    }
    let input;
    if (dynSpec) {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '(select…)';
      input.appendChild(blank);
      const raw = sourceData[dynSpec.source] || [];
      const fmt = dynSpec.source === 'tracks' ? formatTrack
                : dynSpec.source === 'uploads' ? formatUpload
                : formatPlugin;
      for (const o of raw.map(fmt)) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        input.appendChild(opt);
      }
    } else if (asSelect.has(key)) {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '(select track first)';
      input.appendChild(blank);
    } else if (Array.isArray(spec.enum)) {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '(unset)';
      input.appendChild(blank);
      for (const v of spec.enum) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        input.appendChild(opt);
      }
    } else if (spec.type === 'object' && (key === 'position' || key === 'timelineLength')) {
      // Render tagged-union {unit, value} as a composite widget.
      input = document.createElement('div');
      input.className = 'composite-input';
      input.style.display = 'flex';
      input.style.gap = '6px';

      const unitSel = document.createElement('select');
      unitSel.style.flex = '0 0 130px';
      unitSel.style.width = '130px';
      unitSel.dataset.subkey = 'unit';
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '(unit)';
      unitSel.appendChild(blank);
      for (const u of ['samples', 'seconds', 'beats', 'bars+beats']) {
        const o = document.createElement('option');
        o.value = u; o.textContent = u;
        unitSel.appendChild(o);
      }
      input.appendChild(unitSel);

      // Value area — swaps shape based on unit selection.
      const valueWrap = document.createElement('span');
      valueWrap.style.flex = '1 1 auto';
      valueWrap.style.minWidth = '0';
      valueWrap.style.display = 'flex';
      valueWrap.style.gap = '4px';
      input.appendChild(valueWrap);

      const renderValueFor = (unit) => {
        valueWrap.innerHTML = '';
        if (unit === 'bars+beats') {
          const bar = document.createElement('input');
          bar.type = 'number'; bar.min = '1'; bar.placeholder = 'bar';
          bar.dataset.subkey = 'bar';
          bar.style.flex = '1'; bar.style.minWidth = '0';
          const beat = document.createElement('input');
          beat.type = 'number'; beat.step = '0.001'; beat.min = '1'; beat.placeholder = 'beat';
          beat.dataset.subkey = 'beat';
          beat.style.flex = '1'; beat.style.minWidth = '0';
          valueWrap.appendChild(bar);
          valueWrap.appendChild(beat);
        } else {
          const v = document.createElement('input');
          v.type = 'number';
          v.step = (unit === 'seconds' || unit === 'beats') ? 'any' : '1';
          v.placeholder = unit ? `value (${unit})` : 'value';
          v.dataset.subkey = 'value';
          v.style.flex = '1'; v.style.minWidth = '0';
          valueWrap.appendChild(v);
        }
      };
      renderValueFor('');
      unitSel.addEventListener('change', () => renderValueFor(unitSel.value));
    } else if (spec.type === 'object' && key === 'repeat') {
      // {count, strideBeats} composite.
      input = document.createElement('div');
      input.className = 'composite-input';
      input.style.display = 'flex';
      input.style.gap = '6px';

      const count = document.createElement('input');
      count.type = 'number'; count.min = '1'; count.max = '100'; count.placeholder = 'count (1-100)';
      count.dataset.subkey = 'count';
      const stride = document.createElement('input');
      stride.type = 'number'; stride.step = 'any'; stride.min = '0'; stride.placeholder = 'strideBeats';
      stride.dataset.subkey = 'strideBeats';
      input.appendChild(count);
      input.appendChild(stride);
    } else if (spec.type === 'object') {
      // Fallback for any other object-typed field: raw JSON textarea.
      input = document.createElement('textarea');
      input.rows = 2;
      input.style.fontFamily = 'monospace';
      input.style.fontSize = '11px';
      input.placeholder = spec.description || 'JSON object';
    } else {
      input = document.createElement('input');
      if (spec.type === 'boolean') input.type = 'checkbox';
      else if (spec.type === 'integer' || spec.type === 'number') input.type = 'number';
      else input.type = 'text';
      if (spec.description) input.placeholder = spec.description;
    }
    input.dataset.key = key;
    input.dataset.type = spec.type || 'string';
    label.appendChild(input);
    form.appendChild(label);
  }

  // Disable audio-only channel fields when type=midi (tracks_add / buses_add)
  const typeSel = form.querySelector('[data-key="type"]');
  const inCh    = form.querySelector('[data-key="inputChannels"]');
  const outCh   = form.querySelector('[data-key="outputChannels"]');
  if (typeSel && (inCh || outCh)) {
    const applyTypeLock = () => {
      const midi = typeSel.value === 'midi';
      for (const el of [inCh, outCh]) {
        if (!el) continue;
        el.disabled = midi;
        el.parentElement.style.opacity = midi ? '0.4' : '';
      }
    };
    typeSel.addEventListener('change', applyTypeLock);
    applyTypeLock();
  }

  // plugin_add: searchable plugin dropdown + filter by selected track type/state.
  if (toolName === 'plugin_add') {
    const trackSel  = form.querySelector('[data-key="id"]');
    const pluginSel = form.querySelector('[data-key="pluginId"]');
    if (trackSel && pluginSel) {
      const searchWrap = document.createElement('div');
      searchWrap.className = 'param-hint';
      searchWrap.textContent = 'Search:';
      const searchBox = document.createElement('input');
      searchBox.type = 'search';
      searchBox.placeholder = 'Filter by name / category / creator';
      searchBox.style.marginTop = '2px';
      pluginSel.parentElement.insertBefore(searchBox, pluginSel);
      pluginSel.parentElement.insertBefore(searchWrap, searchBox);

      const rebuild = async () => {
        const all = sourceData.plugins || [];
        const tid = trackSel.value;
        const track = (sourceData.tracks || []).find(t => t.id === tid);
        const q = searchBox.value.trim().toLowerCase();

        let pool = all;
        if (track) {
          const isMidi  = (track.type || '').toLowerCase().includes('midi');
          const isAudio = (track.type || '').toLowerCase().includes('audio');
          if (isAudio) {
            pool = pool.filter(p => !p.isInstrument);
          } else if (isMidi) {
            const hasInstr = await trackHasInstrument(tid);
            pool = hasInstr ? pool.filter(p => !p.isInstrument) : pool.filter(p => p.isInstrument);
          }
        }
        if (q) {
          pool = pool.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.category || '').toLowerCase().includes(q) ||
            (p.creator || '').toLowerCase().includes(q));
        }

        const prev = pluginSel.value;
        pluginSel.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = `(select… ${pool.length} shown)`;
        pluginSel.appendChild(blank);
        for (const o of pool.map(formatPlugin)) {
          const opt = document.createElement('option');
          opt.value = o.value; opt.textContent = o.label;
          pluginSel.appendChild(opt);
        }
        if ([...pluginSel.options].some(o => o.value === prev)) pluginSel.value = prev;
      };

      trackSel.addEventListener('change', rebuild);
      searchBox.addEventListener('input', rebuild);
      rebuild();
    }
  }

  // plugin_set_parameter: cascade track → plugin → parameter.
  if (toolName === 'plugin_set_parameter') {
    const trackSel  = form.querySelector('[data-key="id"]');
    const pluginSel = form.querySelector('[data-key="pluginIndex"]');
    const paramSel  = form.querySelector('[data-key="parameterIndex"]');
    const valueEl   = form.querySelector('[data-key="value"]');

    const setBlank = (sel, text) => { sel.innerHTML = ''; const o = document.createElement('option'); o.value = ''; o.textContent = text; sel.appendChild(o); };
    const fillPlugins = async () => {
      setBlank(paramSel, '(select plugin first)');
      if (!trackSel.value) { setBlank(pluginSel, '(select track first)'); return; }
      const res = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
        { tool: 'track_get_info', params: { id: trackSel.value } }, { silent: true });
      const plugs = res.body?.structuredContent?.plugins || [];
      setBlank(pluginSel, plugs.length ? `(select plugin — ${plugs.length})` : '(no plugins on track)');
      for (const p of plugs) {
        const o = document.createElement('option');
        o.value = String(p.index);
        o.textContent = `${p.index}: ${p.displayName || p.name}${p.enabled ? '' : ' (disabled)'}`;
        pluginSel.appendChild(o);
      }
    };
    const fillParams = async () => {
      if (!trackSel.value || pluginSel.value === '') { setBlank(paramSel, '(select plugin first)'); return; }
      const res = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
        { tool: 'plugin_get_description', params: { id: trackSel.value, pluginIndex: parseInt(pluginSel.value, 10) } }, { silent: true });
      const params = (res.body?.structuredContent?.parameters || []).filter(p => p.isInput && !p.isHidden);
      setBlank(paramSel, params.length ? `(select parameter — ${params.length})` : '(no writable params)');
      paramSel._paramMeta = {};
      for (const p of params) {
        const o = document.createElement('option');
        o.value = String(p.index);
        const range = (p.lower !== undefined && p.upper !== undefined) ? ` [${p.lower}..${p.upper}]` : '';
        o.textContent = `${p.label}${range}  (cur ${p.currentValue})`;
        paramSel.appendChild(o);
        paramSel._paramMeta[p.index] = p;
      }
    };
    const updateValueHint = () => {
      if (!valueEl) return;
      const meta = paramSel._paramMeta?.[paramSel.value];
      if (meta) {
        valueEl.min = meta.lower;
        valueEl.max = meta.upper;
        valueEl.placeholder = `${meta.lower} … ${meta.upper} (current ${meta.currentValue})`;
      } else {
        valueEl.removeAttribute('min'); valueEl.removeAttribute('max');
        valueEl.placeholder = '';
      }
    };

    trackSel.addEventListener('change', async () => { await fillPlugins(); await fillParams(); updateValueHint(); });
    pluginSel.addEventListener('change', async () => { await fillParams(); updateValueHint(); });
    paramSel.addEventListener('change', updateValueHint);
  }
}

function collectFormParams() {
  const params = {};
  for (const div of document.querySelectorAll('#param-form .composite-input')) {
    const key = div.dataset.key;
    const subs = div.querySelectorAll('[data-subkey]');
    const obj = {};
    for (const s of subs) {
      const sk = s.dataset.subkey;
      if (s.value === '') continue;
      const n = parseFloat(s.value);
      obj[sk] = Number.isNaN(n) ? s.value : n;
    }
    // Reshape for tagged-union unit/value where value may be nested {bar, beat}.
    if ('unit' in obj && (key === 'position' || key === 'timelineLength')) {
      if (obj.unit === 'bars+beats') {
        params[key] = { unit: 'bars+beats', value: { bar: obj.bar, beat: obj.beat } };
      } else if ('value' in obj) {
        params[key] = { unit: obj.unit, value: obj.value };
      }
    } else if (key === 'repeat') {
      // Only include if at least one field was filled
      if (Object.keys(obj).length) params[key] = obj;
    } else if (Object.keys(obj).length) {
      params[key] = obj;
    }
  }

  // Then: handle flat inputs, skipping any that live inside a composite-input container.
  for (const input of document.querySelectorAll('#param-form input, #param-form select, #param-form textarea')) {
    if (input.disabled) continue;
    if (input.closest('.composite-input')) continue;  // already handled above
    const key = input.dataset.key;
    const type = input.dataset.type;
    let val = input.value;
    if (type === 'boolean') { params[key] = input.checked; continue; }
    if (val === '') continue;
    if (type === 'integer') val = parseInt(val, 10);
    else if (type === 'number') val = parseFloat(val);
    else if (type === 'object') {
      try { val = JSON.parse(val); }
      catch (e) { alert(`${key}: invalid JSON — ${e.message}`); return null; }
    }
    params[key] = val;
  }
  return params;
}

async function sendAction() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const toolName = document.getElementById('tool-select').value;
  const params = collectFormParams();
  if (params === null) return;
  await api('POST', `/v1/sessions/${state.sessionId}/actions`, { tool: toolName, params });
}

// ---- Favorites (localStorage) ----
const FAV_KEY = 'ardour_dev_favorites_v1';
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
  catch { return []; }
}
function saveFavorites(list) { localStorage.setItem(FAV_KEY, JSON.stringify(list)); }

function renderFavorites() {
  const list = document.getElementById('favorites-list');
  list.innerHTML = '';
  const favs = loadFavorites();
  for (let i = 0; i < favs.length; i++) {
    const fav = favs[i];
    const wrap = document.createElement('span');
    wrap.className = 'favorite-item';
    const run = document.createElement('button');
    run.className = 'fav-run';
    run.textContent = fav.name;
    run.title = `${fav.tool}\n${JSON.stringify(fav.params, null, 2)}`;
    run.onclick = () => runFavorite(fav);
    const del = document.createElement('button');
    del.className = 'fav-del';
    del.textContent = '×';
    del.title = 'Remove favorite';
    del.onclick = (e) => {
      e.stopPropagation();
      const cur = loadFavorites();
      cur.splice(i, 1);
      saveFavorites(cur);
      renderFavorites();
    };
    wrap.appendChild(run);
    wrap.appendChild(del);
    list.appendChild(wrap);
  }
}

async function runFavorite(fav) {
  if (!state.sessionId) { alert('Select a session first'); return; }
  await api('POST', `/v1/sessions/${state.sessionId}/actions`, { tool: fav.tool, params: fav.params });
}

function saveCurrentAsFavorite() {
  const toolName = document.getElementById('tool-select').value;
  if (!toolName) { alert('Pick a tool first'); return; }
  const params = collectFormParams();
  if (params === null) return;
  const defaultName = toolName.split('/').pop();
  const name = prompt(`Favorite name for "${toolName}":`, defaultName);
  if (!name) return;
  const favs = loadFavorites();
  favs.push({ name, tool: toolName, params });
  saveFavorites(favs);
  renderFavorites();
}

document.getElementById('btn-new-session').onclick = async () => {
  const name = document.getElementById('new-name').value;
  const sample_rate = parseInt(document.getElementById('new-sr').value, 10);
  const tempo = parseInt(document.getElementById('new-bpm').value, 10);
  const gui = document.getElementById('gui-mode').checked;
  const { body } = await api('POST', '/v1/sessions', {
    session_name: name, sample_rate, tempo, gui,
  });
  if (body.session_id) { state.sessionId = body.session_id; updateIndicator(); }
  setTimeout(refreshSessions, 500);
};

async function quickAction(tool) {
  if (!state.sessionId) { alert('Select a session first'); return; }
  await api('POST', `/v1/sessions/${state.sessionId}/actions`, { tool, params: {} });
}
document.getElementById('btn-play').onclick = () => quickAction('transport_play');
document.getElementById('btn-stop').onclick = () => quickAction('transport_stop');
document.getElementById('btn-save').onclick = () => quickAction('session_save');
document.getElementById('btn-send').onclick = sendAction;
document.getElementById('btn-save-favorite').onclick = saveCurrentAsFavorite;
renderFavorites();

// ---- Presets panel ----
async function doPresetSearch() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const query = document.getElementById('preset-query').value.trim();
  const capturedOnly = document.getElementById('preset-captured-only').checked;
  const params = { limit: 25 };
  if (query) params.query = query;
  if (capturedOnly) params.capturedOnly = true;
  const { body } = await api('POST', `/v1/sessions/${state.sessionId}/actions`,
    { tool: 'preset/search', params }, { silent: true });
  renderPresetResults(body?.results || []);
}

function renderPresetResults(results) {
  const list = document.getElementById('preset-results');
  list.innerHTML = '';
  const track = document.getElementById('preset-track').value.trim();
  if (!results.length) {
    list.innerHTML = '<div style="color:#888;font-size:11px;padding:4px;">no matches</div>';
    return;
  }
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'preset-row' + (r.ardour_uri ? ' has-uri' : '');
    const main = document.createElement('div');
    main.className = 'pr-main';
    const name = document.createElement('div');
    name.className = 'pr-name';
    name.textContent = `${r.plugin} — ${r.preset_name}`;
    const meta = document.createElement('div');
    meta.className = 'pr-meta';
    const tags = (r.tags || []).slice(0, 5).map(t => `${t.axis}:${t.tag}`).join(' ');
    const bits = [r.category, r.bank, tags].filter(Boolean);
    meta.textContent = bits.join(' · ') || (r.ardour_uri ? 'captured' : 'not captured yet');
    main.appendChild(name);
    main.appendChild(meta);
    const loadBtn = document.createElement('button');
    loadBtn.className = 'pr-load';
    loadBtn.textContent = 'Load';
    if (!r.ardour_uri) { loadBtn.disabled = true; loadBtn.title = 'No captured URI — capture this preset first from the plugin GUI.'; }
    else if (!track) { loadBtn.disabled = true; loadBtn.title = 'Enter a target track name above.'; }
    loadBtn.onclick = async () => {
      const tgt = document.getElementById('preset-track').value.trim();
      if (!tgt) { alert('Enter a target track name'); return; }
      await api('POST', `/v1/sessions/${state.sessionId}/actions`,
        { tool: 'preset/load', params: { track: tgt, ardour_uri: r.ardour_uri } });
    };
    row.appendChild(main);
    row.appendChild(loadBtn);
    list.appendChild(row);
  }
}

async function doPresetCapture() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const track = document.getElementById('preset-track').value.trim();
  // When track is empty, the server auto-detects the currently-selected route in Ardour.
  // Name prompt is optional — user can hit Cancel or leave it blank for an auto-name.
  const presetName = prompt(
    track
      ? `Preset name for track "${track}" (leave blank for auto-name):`
      : `Preset name (leave blank for auto-name; track auto-detected from Ardour):`,
    '');
  if (presetName === null) return;
  const params = {};
  if (track) params.track = track;
  if (presetName.trim()) params.presetName = presetName.trim();
  await api('POST', `/v1/sessions/${state.sessionId}/actions`,
    { tool: 'preset/capture', params });
  await doPresetSearch();
}

document.getElementById('btn-preset-search').onclick = doPresetSearch;
document.getElementById('btn-preset-capture').onclick = doPresetCapture;
document.getElementById('preset-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPresetSearch(); });
document.getElementById('preset-track').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPresetSearch(); });
document.getElementById('btn-clear-log').onclick = () => document.getElementById('log').innerHTML = '';
document.getElementById('btn-copy-log').onclick = copyLogToClipboard;

document.getElementById('log-filter').oninput = (e) => {
  const needle = e.target.value.trim().toLowerCase();
  for (const entry of document.querySelectorAll('#log .log-entry')) {
    const text = entry.innerText.toLowerCase();
    entry.style.display = (needle === '' || text.includes(needle)) ? '' : 'none';
  }
};

document.getElementById('upload-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!state.sessionId) {
    alert('Pick a session first (left panel).');
    e.target.value = '';
    return;
  }
  const status = document.getElementById('upload-status');
  status.textContent = `Uploading ${file.name} (${(file.size / 1024).toFixed(1)} KB)…`;

  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const res = await fetch(`/v1/sessions/${state.sessionId}/upload`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = `Upload failed: ${body.error_code || res.status} — ${body.message || body.error || ''}`;
      status.style.color = '#c00';
      return;
    }
    status.textContent = `Uploaded → upload_id: ${body.upload_id} (${body.bytes} bytes)`;
    status.style.color = '#060';
    // If the current tool is audio_region_add, refresh the form so the new upload appears in the dropdown.
    const sel = document.getElementById('tool-select');
    if (sel && sel.value === 'audio_region_add') {
      await renderParamForm(sel.value);
    }
  } catch (err) {
    status.textContent = `Upload error: ${err.message}`;
    status.style.color = '#c00';
  } finally {
    e.target.value = ''; // allow re-upload of same filename
  }
};

loadTools();
refreshSessions();
setInterval(refreshSessions, 5000);
