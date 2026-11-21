// AskDB user interface.
(function () {
  const $ = (id) => document.getElementById(id);
  const { esc, format } = window.fmt;

  const state = {
    settings: null,
    conn: null,          // active saved connection
    schema: null,        // { tables, schemaText, fullSchema }
    history: [],
    busy: false,
    addMode: false,      // adding another database from the chat screen
  };

  // ---------- Helpers ----------
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');
  function setMsg(el, text, kind) { el.textContent = text || ''; el.className = `msg ${kind || ''}`; }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-link]');
    if (a) { e.preventDefault(); window.api.openExternal(a.dataset.link); }
  });

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      return (v.getHours() || v.getMinutes() || v.getSeconds()) ? v.toLocaleString() : v.toLocaleDateString();
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  const isNum = (v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()));

  // ---------- Startup ----------
  async function init() {
    const r = await window.api.getSettings();
    state.settings = r.data;
    const s = state.settings;
    if (!s.apiKey) return openWelcome(1);
    if (!s.connections.length) return openWelcome(2);
    openChat();
    switchDb(s.activeId && s.connections.some(c => c.id === s.activeId) ? s.activeId : s.connections[0].id);
  }

  // ---------- Welcome ----------
  function openWelcome(step) {
    hide($('chat')); show($('welcome'));
    goStep(step);
  }
  function goStep(n) {
    $('step1').classList.toggle('hidden', n !== 1);
    $('step2').classList.toggle('hidden', n !== 2);
    $('dot1').classList.toggle('active', true);
    $('dot2').classList.toggle('active', n === 2);
    $('step2-title').textContent = state.addMode ? 'Add another database' : 'Connect your database';
    $('w-back').textContent = state.addMode ? 'Cancel' : 'Back';
    setMsg($('w-key-msg')); setMsg($('w-cs-msg'));
    if (n === 1) { $('w-key').value = state.settings.apiKey || ''; $('w-key').focus(); }
    else { $('w-cs').value = ''; $('w-name').value = ''; $('w-cs').focus(); }
  }

  $('w-key-next').onclick = async () => {
    const key = $('w-key').value.trim();
    if (!key) return setMsg($('w-key-msg'), 'Please paste your OpenRouter key first.', 'error');
    setMsg($('w-key-msg'), 'Checking your key…');
    $('w-key-next').disabled = true;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 401 || res.status === 403) throw new Error('bad');
    } catch (e) {
      $('w-key-next').disabled = false;
      return setMsg($('w-key-msg'), e.message === 'bad'
        ? "That key wasn't accepted. Copy it again from OpenRouter and paste it here."
        : "Couldn't reach OpenRouter. Check your internet connection and try again.", 'error');
    }
    $('w-key-next').disabled = false;
    state.settings = (await window.api.saveSettings({ apiKey: key, privacyAck: true })).data;
    if (state.settings.connections.length) { openChat(); switchDb(state.settings.activeId || state.settings.connections[0].id); }
    else goStep(2);
  };
  $('w-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-key-next').click(); });

  $('w-back').onclick = () => {
    if (state.addMode) { state.addMode = false; hide($('welcome')); show($('chat')); }
    else goStep(1);
  };

  $('w-connect').onclick = async () => {
    const cs = $('w-cs').value.trim();
    if (!cs) return setMsg($('w-cs-msg'), 'Please paste your database link first.', 'error');
    if (!/^postgres(ql)?:\/\//i.test(cs)) return setMsg($('w-cs-msg'), 'A database link starts with postgresql:// or postgres://. Check that you copied the whole thing.', 'error');
    setMsg($('w-cs-msg'), 'Connecting…');
    $('w-connect').disabled = true;
    const r = await window.api.addConnection({ name: $('w-name').value, cs });
    $('w-connect').disabled = false;
    if (!r.ok) return setMsg($('w-cs-msg'), r.error, 'error');
    setMsg($('w-cs-msg'), `Connected! Found ${r.data.info.tables} table${r.data.info.tables === 1 ? '' : 's'}.`, 'success');
    state.settings = (await window.api.getSettings()).data;
    state.addMode = false;
    setTimeout(() => { openChat(); switchDb(r.data.conn.id); }, 700);
  };
  $('w-cs').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-connect').click(); });
  $('w-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-connect').click(); });

  // ---------- AI model picker ----------
  const MODELS = [
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', desc: 'Recommended. Smart and reliable', cost: '$$' },
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', desc: 'Smartest, for hard questions', cost: '$$$' },
    { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', desc: 'Fastest and cheapest Claude', cost: '$' },
    { id: 'openai/gpt-5.5', name: 'GPT-5.5', desc: "OpenAI's most capable", cost: '$$$' },
    { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', desc: 'OpenAI, fast and low cost', cost: '$' },
    { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', desc: 'Google, fast', cost: '$$' },
    { id: 'x-ai/grok-4.7', name: 'Grok 4.7', desc: 'xAI', cost: '$$' },
    { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Very low cost', cost: '$' },
  ];

  function renderModelMenu() {
    const cur = state.settings.model;
    const known = MODELS.find(m => m.id === cur);
    $('model-name').textContent = known ? known.name : cur.split('/').pop();
    $('model-menu').innerHTML =
      `<div class="menu-label">Choose the AI that answers you</div>` +
      MODELS.map(m => `<button class="menu-item model-item ${m.id === cur ? 'active' : ''}" data-model="${esc(m.id)}">
         <span class="check">${m.id === cur ? '✓' : ''}</span>
         <span class="m-text"><span>${esc(m.name)}</span><small class="muted">${esc(m.desc)}</small></span>
         <span class="cost" title="Relative cost">${m.cost}</span></button>`).join('') +
      (known ? '' : `<button class="menu-item active"><span class="check">✓</span><span class="m-text"><span>${esc(cur)}</span><small class="muted">Your custom model</small></span></button>`) +
      `<div class="menu-sep"></div><button class="menu-item add" data-other="1"><span class="check">+</span>Other model…</button>`;
  }

  $('model-btn').onclick = (e) => { e.stopPropagation(); hide($('db-menu')); $('model-menu').classList.toggle('hidden'); };
  $('model-menu').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    hide($('model-menu'));
    if (b.dataset.other) { openSettings(); $('s-model').focus(); $('s-model').select(); return; }
    if (!b.dataset.model || b.dataset.model === state.settings.model) return;
    state.settings = (await window.api.saveSettings({ model: b.dataset.model })).data;
    renderModelMenu();
  };

  // ---------- Chat screen ----------
  function openChat() { hide($('welcome')); show($('chat')); renderDbMenu(); renderModelMenu(); }

  function renderDbMenu() {
    const s = state.settings;
    const active = s.connections.find(c => c.id === s.activeId);
    $('db-name').textContent = active ? active.name : 'Choose a database';
    const ro = !!(active && active.readOnly);
    $('ro-btn').classList.toggle('hidden', !active);
    $('ro-btn').classList.toggle('on', ro);
    $('ro-btn').innerHTML = ro ? '🔒 Read only' : '✎ Changes allowed';
    $('foot').textContent = ro
      ? 'Read-only mode: AskDB can look at this database but can never change it.'
      : 'AskDB only reads your data. Any change needs your confirmation first.';
    $('db-menu').innerHTML =
      `<div class="menu-label">Your databases</div>` +
      s.connections.map(c => `<button class="menu-item ${c.id === s.activeId ? 'active' : ''}" data-id="${esc(c.id)}">
         <span class="check">${c.id === s.activeId ? '✓' : ''}</span>${esc(c.name)}</button>`).join('') +
      `<div class="menu-sep"></div><button class="menu-item add" data-add="1"><span class="check">+</span>Add database</button>`;
  }

  $('db-btn').onclick = (e) => { e.stopPropagation(); hide($('model-menu')); $('db-menu').classList.toggle('hidden'); };
  document.addEventListener('click', () => { hide($('db-menu')); hide($('model-menu')); });
  $('db-menu').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    hide($('db-menu'));
    if (b.dataset.add) { state.addMode = true; openWelcome(2); return; }
    if (b.dataset.id !== state.settings.activeId || !state.schema) switchDb(b.dataset.id);
  };

  $('ro-btn').onclick = async () => {
    const c = state.settings.connections.find(x => x.id === state.settings.activeId);
    if (!c || state.busy) return;
    if (c.readOnly && !confirm(`Allow changes to "${c.name}"?\n\nAskDB will still ask you to confirm every change before it happens.`)) return;
    const r = await window.api.setReadOnly(c.id, !c.readOnly);
    if (r.ok) { state.settings = r.data; state.conn = state.settings.connections.find(x => x.id === c.id); renderDbMenu(); }
  };

  async function switchDb(id) {
    if (state.busy) return;
    const conn = state.settings.connections.find(c => c.id === id);
    if (!conn) return;
    state.conn = conn; state.schema = null;
    state.settings.activeId = id;
    renderDbMenu();
    $('table-list').innerHTML = '';
    $('messages').innerHTML = `<div class="center-note"><div class="spinner"></div>Connecting to <b>${esc(conn.name)}</b>…</div>`;
    setInputEnabled(false);

    const r = await window.api.connect(id);
    if (state.conn !== conn) return; // user switched again meanwhile
    if (!r.ok) {
      $('messages').innerHTML = `<div class="center-note error-box">
        <div class="big-emoji">⚠️</div><b>Couldn't connect to ${esc(conn.name)}</b><p>${esc(r.error)}</p>
        <div class="row center"><button class="btn primary" id="retry">Try again</button>
        <button class="btn danger-ghost" id="remove-bad">Remove this database</button></div></div>`;
      $('retry').onclick = () => switchDb(id);
      $('remove-bad').onclick = () => removeDb(id);
      return;
    }
    state.schema = r.data;
    renderTables();
    state.history = (await window.api.getHistory(id)).data || [];
    // Changes waiting for confirmation can't survive a restart.
    state.history.forEach(h => { if (h.change && h.change.status === 'pending') h.change.status = 'expired'; });
    renderMessages();
    setInputEnabled(true);
    $('input').focus();
  }

  async function removeDb(id) {
    const c = state.settings.connections.find(x => x.id === id);
    if (!confirm(`Remove "${c ? c.name : 'this database'}" from AskDB?\n\nThis only removes it from this app. Your actual database is not touched.`)) return;
    state.settings = (await window.api.removeConnection(id)).data;
    state.conn = null; state.schema = null;
    if (!state.settings.connections.length) return openWelcome(2);
    renderDbMenu();
    switchDb(state.settings.activeId || state.settings.connections[0].id);
  }

  // ---------- Tables sidebar ----------
  function renderTables() {
    const q = $('table-filter').value.trim().toLowerCase();
    const tables = state.schema.tables.filter(t => !q || t.name.toLowerCase().includes(q));
    $('table-list').innerHTML = tables.length
      ? tables.map(t => `<button class="table-item" data-name="${esc(t.name)}" title="Show the ${esc(t.name)} table">
          <span class="t-name">${esc(t.name)}</span><span class="t-rows">${t.rows > 0 ? t.rows.toLocaleString() : ''}</span></button>`).join('')
      : `<div class="muted small pad">No tables found.</div>`;
  }
  $('table-filter').oninput = () => state.schema && renderTables();
  $('table-list').onclick = (e) => {
    const b = e.target.closest('.table-item');
    if (b && !state.busy) send(`Show me the ${b.dataset.name} table`);
  };
  $('toggle-side').onclick = () => $('side').classList.toggle('collapsed');

  // ---------- Messages ----------
  function suggestions() {
    const t = [...state.schema.tables].filter(x => !x.isView).sort((a, b) => b.rows - a.rows);
    const out = ["What's in this database?"];
    if (t[0]) out.push(`Show me the latest 10 ${t[0].name}`);
    if (t[1]) out.push(`How many ${t[1].name} are there?`);
    if (t[0]) out.push(`Give me a quick summary of ${t[0].name}`);
    return out;
  }

  function renderMessages() {
    const box = $('messages');
    if (!state.history.length) {
      box.innerHTML = `<div class="empty">
        <div class="logo-big">◆</div>
        <h1>Hi! Ask me anything about <span class="accent">${esc(state.conn.name)}</span></h1>
        <p class="muted">I can find records, count things, spot trends and help you update data. Just type a question in plain English.</p>
        <div class="chips">${suggestions().map(s => `<button class="chip">${esc(s)}</button>`).join('')}</div>
      </div>`;
      box.querySelectorAll('.chip').forEach(c => c.onclick = () => send(c.textContent));
      return;
    }
    box.innerHTML = '';
    state.history.forEach((h, i) => box.appendChild(renderItem(h, i)));
    box.scrollTop = box.scrollHeight;
  }

  function renderItem(h, index) {
    const el = document.createElement('div');
    if (h.role === 'user') {
      el.className = 'msg-row user';
      el.innerHTML = `<div class="bubble user">${esc(h.text)}</div>`;
      return el;
    }
    if (h.role === 'error') {
      el.className = 'msg-row';
      el.innerHTML = `<div class="bubble error-bubble">⚠️ ${esc(h.text)}</div>`;
      return el;
    }
    el.className = 'msg-row bot';
    const body = document.createElement('div');
    body.className = 'bot-body';
    body.innerHTML = `<div class="answer">${format(h.text)}</div>`;
    if (h.result && h.result.columns && h.result.columns.length) body.appendChild(renderResult(h.result));
    if (h.change) body.appendChild(renderChange(h, index));
    if (h.sql && h.sql.length) {
      const d = document.createElement('details');
      d.className = 'how';
      d.innerHTML = `<summary>How I got this</summary>${h.sql.map(s => `<pre>${esc(s)}</pre>`).join('')}`;
      body.appendChild(d);
    }
    el.innerHTML = `<div class="avatar">◆</div>`;
    el.appendChild(body);
    return el;
  }

  // ---------- Results: table + chart ----------
  function chartPlan(result) {
    const { columns, rows } = result;
    if (columns.length < 2 || rows.length < 2 || rows.length > 200) return null;
    const numericCols = columns.filter(c => rows.every(r => r[c] === null || isNum(r[c])));
    let label = columns.find(c => !numericCols.includes(c));
    if (!label) label = columns[0];
    const values = numericCols.filter(c => c !== label).slice(0, 4);
    if (!values.length) return null;
    return { label, values };
  }

  function renderResult(result) {
    const wrap = document.createElement('div');
    wrap.className = 'result';
    const plan = chartPlan(result);
    let view = plan && result.chart && result.chart !== 'none' ? 'chart' : 'table';
    let sort = { col: null, dir: 1 };
    let chart = null;

    const count = `${result.rows.length.toLocaleString()}${result.truncated ? '+' : ''} row${result.rows.length === 1 ? '' : 's'}`;
    wrap.innerHTML = `<div class="result-bar">
        <span class="muted small">${count}${result.truncated ? ' (showing the first 500)' : ''}</span>
        <div class="spacer"></div>
        ${plan ? `<div class="seg"><button data-v="table">Table</button><button data-v="chart">Chart</button></div>` : ''}
        <button class="btn ghost small" data-csv="1">⤓ Download</button>
      </div><div class="result-view"></div>`;
    const viewEl = wrap.querySelector('.result-view');

    function drawTable() {
      const rows = [...result.rows];
      if (sort.col) {
        rows.sort((a, b) => {
          const x = a[sort.col], y = b[sort.col];
          if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
          if (isNum(x) && isNum(y)) return (Number(x) - Number(y)) * sort.dir;
          return cellText(x).localeCompare(cellText(y)) * sort.dir;
        });
      }
      viewEl.innerHTML = `<div class="table-scroll"><table><thead><tr>${result.columns.map(c =>
        `<th data-c="${esc(c)}">${esc(c)}${sort.col === c ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${result.columns.map(c => {
          const v = r[c];
          return v === null || v === undefined ? '<td class="null">—</td>' : `<td class="${isNum(v) ? 'num' : ''}">${esc(cellText(v))}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`;
      viewEl.querySelectorAll('th').forEach(th => th.onclick = () => {
        sort = { col: th.dataset.c, dir: sort.col === th.dataset.c ? -sort.dir : 1 };
        drawTable();
      });
    }

    function drawChart() {
      viewEl.innerHTML = '<div class="chart-box"><canvas></canvas></div>';
      const css = getComputedStyle(document.documentElement);
      const palette = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(v => css.getPropertyValue(v).trim());
      const text = css.getPropertyValue('--muted').trim();
      const grid = css.getPropertyValue('--border').trim();
      let type = result.chart && result.chart !== 'none' ? result.chart : 'bar';
      if (type === 'pie' && (plan.values.length > 1 || result.rows.length > 8)) type = 'bar';
      const labels = result.rows.map(r => cellText(r[plan.label]));
      const datasets = plan.values.map((c, i) => ({
        label: c,
        data: result.rows.map(r => (r[c] === null ? null : Number(r[c]))),
        backgroundColor: type === 'pie' ? palette : palette[i % palette.length],
        borderColor: type === 'pie' ? 'transparent' : palette[i % palette.length],
        borderWidth: 2, borderRadius: type === 'bar' ? 4 : 0, tension: 0.3, pointRadius: 2,
      }));
      chart = new Chart(viewEl.querySelector('canvas'), {
        type, data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: type === 'pie' || datasets.length > 1, labels: { color: text } } },
          scales: type === 'pie' ? {} : {
            x: { ticks: { color: text, maxRotation: 45 }, grid: { display: false } },
            y: { ticks: { color: text }, grid: { color: grid }, beginAtZero: true },
          },
        },
      });
    }

    function draw() {
      if (chart) { chart.destroy(); chart = null; }
      wrap.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
      view === 'chart' ? drawChart() : drawTable();
    }
    wrap.querySelectorAll('.seg button').forEach(b => b.onclick = () => { view = b.dataset.v; draw(); });
    wrap.querySelector('[data-csv]').onclick = () => downloadCsv(result);
    draw();
    return wrap;
  }

  function downloadCsv(result) {
    const q = (v) => { const s = cellText(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [result.columns.map(q).join(','), ...result.rows.map(r => result.columns.map(c => q(r[c])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `${(state.conn ? state.conn.name : 'data').replace(/[^\w-]+/g, '_')}_results.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Change confirmation card ----------
  function renderChange(h, index) {
    const c = h.change;
    const card = document.createElement('div');
    card.className = `change-card ${c.status}`;
    const verb = { insert: 'add', update: 'change', delete: 'remove' }[c.kind] || 'change';
    const previewLabel = { insert: 'Rows that will be added', update: 'How the rows will look after the change', delete: 'Rows that will be removed' }[c.kind];
    const n = c.affected;
    let footer = '';
    if (c.status === 'pending') footer = `<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn ${c.kind === 'delete' ? 'danger' : 'primary'}" data-act="ok">Confirm</button></div>`;
    else if (c.status === 'applied') footer = `<div class="status ok">✓ Done. ${c.applied} row${c.applied === 1 ? '' : 's'} ${verb === 'add' ? 'added' : verb === 'remove' ? 'removed' : 'changed'}.</div>`;
    else if (c.status === 'cancelled') footer = `<div class="status">Cancelled. Nothing was changed.</div>`;
    else if (c.status === 'expired') footer = `<div class="status">This suggestion expired. Nothing was changed. Ask again if you still want it.</div>`;
    else if (c.status === 'failed') footer = `<div class="status bad">⚠️ ${esc(c.error || 'The change failed. Nothing was changed.')}</div>`;

    card.innerHTML = `
      <div class="change-head"><span class="badge ${c.kind}">${verb.toUpperCase()}</span> Please review this change</div>
      <div class="change-summary">${esc(c.summary)}</div>
      <div class="change-count ${n === 0 ? 'zero' : ''}">${n === 0 ? 'This would not affect any rows.' : `This will ${verb} <b>${n}</b> row${n === 1 ? '' : 's'}.`}</div>
      ${c.preview && c.preview.length && c.status === 'pending' ? `<div class="muted small">${previewLabel}${n > c.preview.length ? ` (first ${c.preview.length})` : ''}:</div>` : ''}
      <div class="change-preview"></div>
      ${footer}`;
    if (c.preview && c.preview.length && c.status === 'pending') {
      card.querySelector('.change-preview').appendChild(renderResult({ columns: c.columns, rows: c.preview, chart: 'none' }));
      card.querySelector('.change-preview .result-bar').remove();
    }
    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      card.querySelectorAll('button').forEach(x => x.disabled = true);
      if (b.dataset.act === 'cancel') {
        await window.api.cancel(c.id);
        c.status = 'cancelled';
      } else {
        const r = await window.api.apply(c.id);
        if (r.ok) { c.status = 'applied'; c.applied = r.data.affected; }
        else { c.status = 'failed'; c.error = r.error; }
      }
      await saveHistory();
      card.replaceWith(renderChange(h, index));
    });
    return card;
  }

  // ---------- Sending ----------
  function setInputEnabled(on) {
    $('input').disabled = !on; $('send').disabled = !on; $('mic').disabled = !on;
  }

  async function saveHistory() {
    if (!state.conn) return;
    // Keep stored results small.
    const slim = state.history.map(h => h.result ? { ...h, result: { ...h.result, rows: h.result.rows.slice(0, 200), truncated: h.result.truncated || h.result.rows.length > 200 } } : h);
    await window.api.saveHistory(state.conn.id, slim);
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || state.busy || !state.schema) return;
    if (!state.settings.apiKey) return openSettings();
    state.busy = true; setInputEnabled(false);
    const conn = state.conn;
    const priorHistory = state.history.slice();
    state.history.push({ role: 'user', text });
    renderMessages();

    const status = document.createElement('div');
    status.className = 'msg-row bot';
    status.innerHTML = `<div class="avatar">◆</div><div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span class="st">Thinking…</span></div>`;
    $('messages').appendChild(status);
    $('messages').scrollTop = $('messages').scrollHeight;

    try {
      const out = await window.agent.ask(text, {
        settings: state.settings,
        dbName: conn.name,
        schemaText: state.schema.schemaText,
        fullSchema: state.schema.fullSchema,
        readOnly: !!state.conn.readOnly,
        history: priorHistory,
        onStatus: (s) => { status.querySelector('.st').textContent = s; },
      });
      if (state.conn !== conn) return;
      state.history.push({ role: 'assistant', text: out.text, sql: out.sql, result: out.result, change: out.change });
    } catch (e) {
      if (state.conn !== conn) return;
      state.history.push({ role: 'error', text: e.message === 'Failed to fetch' ? "Couldn't reach the AI. Check your internet connection and try again." : e.message });
    } finally {
      state.busy = false;
    }
    await saveHistory();
    renderMessages();
    setInputEnabled(true);
    $('input').focus();
  }

  const input = $('input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = input.value; input.value = ''; input.style.height = 'auto'; send(v); }
  });
  $('send').onclick = () => { const v = input.value; input.value = ''; input.style.height = 'auto'; send(v); };

  // ---------- Voice typing ----------
  let micState = 'idle'; // idle | recording | working
  const PLACEHOLDER = 'Ask anything about your data…';
  function setMic(s) {
    micState = s;
    $('mic').className = `mic ${s}`;
    $('mic').title = s === 'recording' ? 'Click when you finish speaking' : s === 'working' ? 'Turning your voice into text…' : 'Speak your question';
    input.placeholder = s === 'recording' ? 'Listening… click the red button when you finish speaking'
      : s === 'working' ? 'Turning your voice into text…' : PLACEHOLDER;
    $('send').disabled = s !== 'idle' || state.busy;
  }
  function flashNote(text) {
    const foot = $('foot'), old = foot.textContent;
    foot.textContent = text; foot.classList.add('error');
    setTimeout(() => { foot.classList.remove('error'); if (foot.textContent === text) renderDbMenu(); }, 7000);
  }
  async function finishVoice() {
    if (micState !== 'recording') return;
    setMic('working');
    try {
      const text = await window.voice.stopAndTranscribe(state.settings.apiKey);
      if (text) {
        input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
        input.dispatchEvent(new Event('input'));
      } else flashNote("I didn't hear anything. Click the microphone and try again.");
    } catch (e) { flashNote(e.message); }
    setMic('idle');
    input.focus();
  }
  $('mic').onclick = async () => {
    if (micState === 'recording') return finishVoice();
    if (micState !== 'idle' || state.busy || input.disabled) return;
    if (!state.settings.apiKey) return openSettings();
    try { setMic('recording'); await window.voice.start(finishVoice); }
    catch (e) { setMic('idle'); flashNote(e.message); }
  };

  $('new-chat').onclick = async () => {
    if (state.busy || !state.history.length) return;
    if (!confirm('Start a new chat? This clears the conversation for this database.')) return;
    state.history = []; await saveHistory(); renderMessages();
  };

  // ---------- Settings ----------
  function openSettings() {
    $('s-key').value = state.settings.apiKey || '';
    $('s-model').value = state.settings.model || '';
    $('s-remove').classList.toggle('hidden', !state.conn);
    setMsg($('s-msg'));
    show($('settings'));
  }
  $('settings-btn').onclick = openSettings;
  $('s-cancel').onclick = () => hide($('settings'));
  $('settings').onclick = (e) => { if (e.target === $('settings')) hide($('settings')); };
  $('s-save').onclick = async () => {
    const apiKey = $('s-key').value.trim(), model = $('s-model').value.trim();
    if (!apiKey) return setMsg($('s-msg'), 'The OpenRouter key cannot be empty.', 'error');
    if (!model) return setMsg($('s-msg'), 'Please enter a model name.', 'error');
    state.settings = (await window.api.saveSettings({ apiKey, model })).data;
    renderModelMenu();
    hide($('settings'));
  };
  $('s-remove').onclick = () => { hide($('settings')); if (state.conn) removeDb(state.conn.id); };

  init();
})();
