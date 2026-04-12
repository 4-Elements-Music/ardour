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

async function loadTools() {
  const { body } = await api('GET', '/v1/tools', null, { silent: true });
  state.tools = body.tools || [];
  const sel = document.getElementById('tool-select');
  sel.innerHTML = '';
  for (const t of state.tools) {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.category + ' / ' + t.name;
    sel.appendChild(opt);
  }
  sel.onchange = () => renderParamForm(sel.value);
  if (state.tools.length) renderParamForm(state.tools[0].name);
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
  }));
  const formatTrack  = t => ({ value: t.id, label: `${t.name} (${t.type || '?'})` });
  const formatPlugin = p => ({ value: p.pluginId, label: `[${p.type}] ${p.category ? p.category + ' / ' : ''}${p.name} — ${p.creator}` });
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
      const fmt = dynSpec.source === 'tracks' ? formatTrack : formatPlugin;
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

async function sendAction() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const toolName = document.getElementById('tool-select').value;
  const params = {};
  for (const input of document.querySelectorAll('#param-form input, #param-form select')) {
    if (input.disabled) continue;
    const key = input.dataset.key;
    const type = input.dataset.type;
    let val = input.value;
    if (type === 'boolean') { params[key] = input.checked; continue; }
    if (val === '') continue;
    if (type === 'integer') val = parseInt(val, 10);
    else if (type === 'number') val = parseFloat(val);
    params[key] = val;
  }
  await api('POST', `/v1/sessions/${state.sessionId}/actions`, { tool: toolName, params });
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
document.getElementById('btn-clear-log').onclick = () => document.getElementById('log').innerHTML = '';
document.getElementById('btn-copy-log').onclick = copyLogToClipboard;

document.getElementById('log-filter').oninput = (e) => {
  const needle = e.target.value.trim().toLowerCase();
  for (const entry of document.querySelectorAll('#log .log-entry')) {
    const text = entry.innerText.toLowerCase();
    entry.style.display = (needle === '' || text.includes(needle)) ? '' : 'none';
  }
};

loadTools();
refreshSessions();
setInterval(refreshSessions, 5000);
