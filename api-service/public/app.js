const state = {
  sessionId: null,
  tools: [],
};

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  logEntry(method + ' ' + path, json, res.ok);
  return { ok: res.ok, status: res.status, body: json };
}

function logEntry(label, data, ok) {
  const el = document.createElement('div');
  el.className = 'log-entry ' + (ok ? 'success' : 'error');
  el.innerHTML = '<strong>' + escapeHtml(label) + '</strong><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
  document.getElementById('log').prepend(el);
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
    const del = document.createElement('button');
    del.textContent = 'x';
    del.style.marginLeft = '8px';
    del.onclick = async (e) => {
      e.stopPropagation();
      await api('DELETE', `/v1/sessions/${s.session_id}`);
      if (state.sessionId === s.session_id) state.sessionId = null;
      refreshSessions();
      updateIndicator();
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
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
  const { body } = await api('GET', '/v1/tools');
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

function renderParamForm(toolName) {
  const tool = state.tools.find(t => t.name === toolName);
  const form = document.getElementById('param-form');
  form.innerHTML = '';
  if (!tool || !tool.input_schema || !tool.input_schema.properties) return;
  const props = tool.input_schema.properties;
  for (const [key, spec] of Object.entries(props)) {
    const label = document.createElement('label');
    label.textContent = key + (tool.input_schema.required?.includes(key) ? ' *' : '') + ':';
    const input = document.createElement('input');
    input.dataset.key = key;
    input.dataset.type = spec.type || 'string';
    if (spec.type === 'boolean') input.type = 'checkbox';
    else if (spec.type === 'integer' || spec.type === 'number') input.type = 'number';
    else input.type = 'text';
    if (spec.description) input.placeholder = spec.description;
    label.appendChild(input);
    form.appendChild(label);
  }
}

async function sendAction() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const toolName = document.getElementById('tool-select').value;
  const params = {};
  for (const input of document.querySelectorAll('#param-form input')) {
    const key = input.dataset.key;
    const type = input.dataset.type;
    let val = input.value;
    if (val === '') continue;
    if (type === 'integer') val = parseInt(val, 10);
    else if (type === 'number') val = parseFloat(val);
    else if (type === 'boolean') val = input.checked;
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

document.getElementById('btn-send').onclick = sendAction;
document.getElementById('btn-clear-log').onclick = () => document.getElementById('log').innerHTML = '';

loadTools();
refreshSessions();
setInterval(refreshSessions, 5000);
