// Web version of the app's "window.api" bridge.
// Settings, keys, database links and chat history stay in this browser (localStorage).
// Database work goes through the /api/db Netlify Function.
(function () {
  const SETTINGS = 'askdb-settings';
  const PASS = 'askdb-password';
  const DEFAULTS = { apiKey: '', model: 'anthropic/claude-sonnet-5.5', connections: [], activeId: null };
  const proposals = new Map(); // id -> sql (the server is stateless)
  let currentCs = null;

  const ok = (data) => ({ ok: true, data });
  const fail = (error) => ({ ok: false, error });

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  const readSettings = () => ({ ...DEFAULTS, ...load(SETTINGS, {}) });
  const writeSettings = (s) => { store(SETTINGS, s); return s; };
  const activeConn = () => { const s = readSettings(); return s.connections.find(c => c.id === s.activeId); };

  // ---------- Password gate ----------
  function getPassword() { try { return localStorage.getItem(PASS) || ''; } catch { return ''; } }

  async function server(action, payload = {}, password = getPassword()) {
    let res;
    try {
      res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch {
      return fail("Couldn't reach the AskDB server. Check your internet connection.");
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 401) {
      if (action === 'ping') return fail('Wrong password.');
      try { localStorage.removeItem(PASS); } catch {}
      setTimeout(() => location.reload(), 1500);
      return fail('Your AskDB password is no longer correct. Please enter it again.');
    }
    if (!body || typeof body.ok !== 'boolean') return fail(`The AskDB server had a problem (code ${res.status}). Please try again in a minute.`);
    return body;
  }

  let gate = null;
  function ensurePassword() {
    if (gate) return gate;
    gate = (async () => {
      if (getPassword() && (await server('ping')).ok) return;
      await new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'overlay';
        wrap.innerHTML = `<div class="modal" style="max-width:420px">
            <div class="brand big" style="margin-bottom:6px"><span class="logo">◆</span> AskDB</div>
            <p class="muted" style="text-align:center;margin:0 0 16px">Enter your AskDB password to continue.</p>
            <input id="gate-pass" type="password" placeholder="Password" autocomplete="current-password">
            <div id="gate-msg" class="msg"></div>
            <button id="gate-go" class="btn primary wide">Unlock</button>
          </div>`;
        document.body.appendChild(wrap);
        const input = wrap.querySelector('#gate-pass'), msg = wrap.querySelector('#gate-msg'), btn = wrap.querySelector('#gate-go');
        input.focus();
        const go = async () => {
          const p = input.value;
          if (!p) { msg.textContent = 'Please enter the password.'; msg.className = 'msg error'; return; }
          btn.disabled = true; msg.textContent = 'Checking…'; msg.className = 'msg';
          const r = await server('ping', {}, p);
          btn.disabled = false;
          if (!r.ok) { msg.textContent = r.error === 'Wrong password.' ? "That password isn't right. Try again." : r.error; msg.className = 'msg error'; return; }
          try { localStorage.setItem(PASS, p); } catch {}
          wrap.remove();
          resolve();
        };
        btn.onclick = go;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      });
    })();
    return gate;
  }

  // On phones, start with the tables list hidden (☰ shows it).
  document.addEventListener('DOMContentLoaded', () => {
    if (window.innerWidth < 820) document.getElementById('side')?.classList.add('collapsed');
  });

  // ---------- The same interface the desktop app uses ----------
  window.api = {
    async getSettings() { await ensurePassword(); return ok(readSettings()); },
    async saveSettings(patch) { return ok(writeSettings({ ...readSettings(), ...patch })); },

    async testConnection(cs) { return server('test', { cs }); },
    async addConnection({ name, cs }) {
      const r = await server('test', { cs: cs.trim() });
      if (!r.ok) return r;
      const s = readSettings();
      const conn = { id: `db_${Date.now()}`, name: (name || '').trim() || 'My database', cs: cs.trim() };
      s.connections.push(conn); s.activeId = conn.id; writeSettings(s);
      return ok({ conn, info: r.data });
    },
    async removeConnection(id) {
      const s = readSettings();
      s.connections = s.connections.filter(c => c.id !== id);
      if (s.activeId === id) { s.activeId = s.connections[0]?.id || null; currentCs = null; }
      try { localStorage.removeItem(`askdb-history-${id}`); } catch {}
      return ok(writeSettings(s));
    },
    async setReadOnly(id, readOnly) {
      const s = readSettings();
      const c = s.connections.find(x => x.id === id);
      if (c) c.readOnly = !!readOnly;
      return ok(writeSettings(s));
    },

    async connect(id) {
      const s = readSettings();
      const conn = s.connections.find(c => c.id === id);
      if (!conn) return fail('That database is no longer saved.');
      const r = await server('schema', { cs: conn.cs });
      if (r.ok) { currentCs = conn.cs; s.activeId = id; writeSettings(s); }
      return r;
    },
    async describe(table) { return server('describe', { cs: currentCs, table }); },
    async query(sql) { return server('query', { cs: currentCs, sql }); },
    async propose(sql) {
      const c = activeConn();
      const r = await server('propose', { cs: currentCs, sql, readOnly: !!(c && c.readOnly) });
      if (r.ok) proposals.set(r.data.id, r.data.sql);
      return r;
    },
    async apply(id) {
      const sql = proposals.get(id);
      if (!sql) return fail('This change has expired. Please ask again.');
      const c = activeConn();
      const r = await server('apply', { cs: currentCs, sql, readOnly: !!(c && c.readOnly) });
      if (r.ok) proposals.delete(id);
      return r;
    },
    async cancel(id) { proposals.delete(id); return ok(true); },

    async getHistory(id) { return ok(load(`askdb-history-${id}`, [])); },
    async saveHistory(id, items) {
      // Browsers limit storage; keep fewer items if it gets full.
      for (const n of [200, 60, 20]) if (store(`askdb-history-${id}`, items.slice(-n))) return ok(true);
      return ok(false);
    },
    async openExternal(url) { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); return ok(true); },
  };
})();
