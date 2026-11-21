// Web version of the app's "window.api" bridge.
// Settings, keys, database links and chat history stay in this browser (localStorage).
// Database work goes through the /api/db server endpoint.
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
  // The password is forgotten after 1 hour without using AskDB (auto-lock).
  const PASS_TIME = 'askdb-password-time';
  const IDLE_LIMIT = 60 * 60 * 1000;
  function forgetPassword() { try { localStorage.removeItem(PASS); localStorage.removeItem(PASS_TIME); } catch {} }
  function touchPassword() { try { localStorage.setItem(PASS_TIME, String(Date.now())); } catch {} }
  function passwordExpired() {
    try { return Date.now() - Number(localStorage.getItem(PASS_TIME) || 0) > IDLE_LIMIT; } catch { return true; }
  }
  function getPassword() {
    try {
      const p = localStorage.getItem(PASS) || '';
      if (p && passwordExpired()) { forgetPassword(); return ''; }
      return p;
    } catch { return ''; }
  }
  // Lock an open page once the hour runs out.
  setInterval(() => {
    let has = false;
    try { has = !!localStorage.getItem(PASS); } catch {}
    if (has && passwordExpired()) { forgetPassword(); location.reload(); }
  }, 60 * 1000);

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
      forgetPassword();
      setTimeout(() => location.reload(), 1500);
      return fail('Your AskDB password is no longer correct. Please enter it again.');
    }
    if (!body || typeof body.ok !== 'boolean') return fail(`The AskDB server had a problem (code ${res.status}). Please try again in a minute.`);
    if (res.ok && password === getPassword()) touchPassword(); // still in use, restart the 1-hour timer
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
          try { localStorage.setItem(PASS, p); localStorage.setItem('askdb-last-active', String(Date.now())); } catch {}
          touchPassword();
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
    // Lock button: forgets the AskDB password on this browser, so it must be typed again.
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
      const lock = document.createElement('button');
      lock.className = 'icon-btn'; lock.id = 'lock-btn';
      lock.title = 'Lock AskDB (forget the password on this browser)';
      lock.textContent = '🔐';
      lock.onclick = () => {
        if (!confirm('Lock AskDB?\n\nThe password will be forgotten on this browser and you will need to type it again.')) return;
        forgetPassword();
        location.reload();
      };
      settingsBtn.before(lock);
    }
  });

  // ---------- PIN lock ----------
  // A 6-digit PIN that is asked for after 5 minutes without using AskDB.
  // Only a salted fingerprint (hash) of the PIN is saved, never the PIN itself.
  const PIN = 'askdb-pin', ACTIVE = 'askdb-last-active';
  const PIN_IDLE = 5 * 60 * 1000, PIN_TRIES = 5;
  let pinLocked = false, pinWait = null;

  const pinData = () => load(PIN, null);
  const hasPin = () => { const d = pinData(); return !!(d && d.hash && d.salt); };
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function hashPin(pin, salt) {
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`)));
  }
  async function pinMatches(pin) {
    const d = pinData();
    return !!d && (await hashPin(pin, d.salt)) === d.hash;
  }
  async function savePin(pin) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    store(PIN, { salt, hash: await hashPin(pin, salt), tries: 0 });
  }
  const validPin = (v) => /^\d{6}$/.test(v);
  function markActive() { if (!pinLocked) try { localStorage.setItem(ACTIVE, String(Date.now())); } catch {} }
  function idleTooLong() {
    try { return Date.now() - Number(localStorage.getItem(ACTIVE) || 0) > PIN_IDLE; } catch { return true; }
  }
  function signOutFully() { forgetPassword(); try { localStorage.removeItem(PIN); } catch {} location.reload(); }

  function pinField(id, placeholder) {
    return `<input id="${id}" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="${placeholder}">`;
  }
  function onlyDigits(input) { input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); }); }

  // Full-screen lock. Resolves once the right PIN is typed.
  function showPinLock() {
    if (pinWait) return pinWait;
    pinLocked = true;
    document.querySelectorAll('.overlay:not(.pin-lock)').forEach(o => o.classList.add('pin-hidden'));
    pinWait = new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'overlay pin-lock';
      wrap.innerHTML = `<div class="modal pin-modal">
          <div class="brand big" style="margin-bottom:4px"><span class="logo">◆</span> AskDB</div>
          <p class="muted" style="text-align:center;margin:0 0 16px">AskDB is locked. Enter your 6-digit PIN.</p>
          ${pinField('pin-unlock', '••••••')}
          <div class="msg" style="text-align:center"></div>
          <button class="btn primary wide" data-a="go">Unlock</button>
          <button class="btn link wide" data-a="forgot">Forgot PIN? Use your password instead</button>
        </div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('input'), msg = wrap.querySelector('.msg'), btn = wrap.querySelector('[data-a=go]');
      onlyDigits(input);
      setTimeout(() => input.focus(), 50);
      let checking = false;
      const go = async () => {
        if (checking) return;
        const v = input.value;
        if (!validPin(v)) { msg.textContent = 'Please enter all 6 digits.'; msg.className = 'msg error'; return; }
        checking = true; btn.disabled = true;
        const right = await pinMatches(v);
        checking = false; btn.disabled = false;
        const d = pinData() || {};
        if (!right) {
          d.tries = (d.tries || 0) + 1; store(PIN, d);
          input.value = '';
          if (d.tries >= PIN_TRIES) {
            msg.textContent = 'Too many wrong PINs. Please sign in with your password.'; msg.className = 'msg error';
            setTimeout(signOutFully, 1500);
            return;
          }
          const left = PIN_TRIES - d.tries;
          msg.textContent = `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`; msg.className = 'msg error';
          return;
        }
        d.tries = 0; store(PIN, d);
        pinLocked = false; pinWait = null;
        markActive();
        wrap.remove();
        document.querySelectorAll('.pin-hidden').forEach(o => o.classList.remove('pin-hidden'));
        resolve();
      };
      btn.onclick = go;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      input.addEventListener('input', () => { if (validPin(input.value)) go(); });
      wrap.querySelector('[data-a=forgot]').onclick = () => {
        if (confirm('Sign in with your password instead?\n\nYour PIN will be removed. You can set a new one in Settings.')) signOutFully();
      };
    });
    return pinWait;
  }

  async function pinGate() { if (hasPin() && idleTooLong()) await showPinLock(); markActive(); }

  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
    document.addEventListener(ev, markActive, { capture: true, passive: true }));
  function checkIdle() { if (hasPin() && !pinLocked && getPassword() && idleTooLong()) showPinLock(); }
  setInterval(checkIdle, 15 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });

  // Settings: set, change or remove the PIN.
  function smallDialog(html) {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.style.zIndex = 60;
    wrap.innerHTML = `<div class="modal" style="max-width:400px">${html}</div>`;
    document.body.appendChild(wrap);
    wrap.querySelectorAll('.pin-input').forEach(onlyDigits);
    wrap.querySelector('input').focus();
    wrap.querySelector('[data-a=no]').onclick = () => wrap.remove();
    const msg = wrap.querySelector('.msg');
    return { wrap, val: (id) => wrap.querySelector('#' + id).value, err: (t) => { msg.textContent = t; msg.className = 'msg error'; } };
  }
  function pinDialog() {
    const had = hasPin();
    const d = smallDialog(`<h2>${had ? 'Change PIN' : 'Set a PIN'}</h2>
        <p class="muted" style="margin:0 0 12px">AskDB will ask for this 6-digit PIN after 5 minutes without use.</p>
        ${had ? `<label>Current PIN</label>${pinField('pin-old', '••••••')}` : ''}
        <label>New PIN</label>${pinField('pin-new', '6 digits')}
        <label>Type it again</label>${pinField('pin-new2', '6 digits')}
        <div class="msg"></div>
        <div class="row"><div class="spacer"></div>
          <button class="btn ghost" data-a="no">Cancel</button>
          <button class="btn primary" data-a="yes">Save PIN</button></div>`);
    d.wrap.querySelector('[data-a=yes]').onclick = async () => {
      if (had && !(await pinMatches(d.val('pin-old')))) return d.err("The current PIN isn't right.");
      if (!validPin(d.val('pin-new'))) return d.err('The new PIN must be exactly 6 digits.');
      if (d.val('pin-new') !== d.val('pin-new2')) return d.err("The two PINs don't match.");
      await savePin(d.val('pin-new'));
      markActive();
      d.wrap.remove();
      refreshPinRow();
    };
  }
  function removePinDialog() {
    const d = smallDialog(`<h2>Remove PIN?</h2>
        <p class="muted" style="margin:0 0 12px">Enter your current PIN to turn the PIN lock off.</p>
        ${pinField('pin-old', '••••••')}
        <div class="msg"></div>
        <div class="row"><div class="spacer"></div>
          <button class="btn ghost" data-a="no">Cancel</button>
          <button class="btn danger" data-a="yes">Remove PIN</button></div>`);
    d.wrap.querySelector('[data-a=yes]').onclick = async () => {
      if (!(await pinMatches(d.val('pin-old')))) return d.err("That PIN isn't right.");
      try { localStorage.removeItem(PIN); } catch {}
      d.wrap.remove();
      refreshPinRow();
    };
  }
  function refreshPinRow() {
    const st = document.getElementById('pin-status');
    if (!st) return;
    const on = hasPin();
    st.textContent = on ? 'On: asks for your PIN after 5 minutes away' : 'Off';
    document.getElementById('pin-set').textContent = on ? 'Change PIN' : 'Set PIN';
    document.getElementById('pin-remove').classList.toggle('hidden', !on);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const set = document.getElementById('pin-set');
    if (!set) return;
    set.onclick = pinDialog;
    document.getElementById('pin-remove').onclick = removePinDialog;
    document.getElementById('settings-btn').addEventListener('click', refreshPinRow);
    refreshPinRow();
  });

  // ---------- The same interface the desktop app uses ----------
  window.api = {
    async getSettings() { await ensurePassword(); await pinGate(); return ok(readSettings()); },
    async saveSettings(patch) { return ok(writeSettings({ ...readSettings(), ...patch })); },

    async testConnection(cs) { return server('test', { cs }); },
    async addConnection({ name, cs }) {
      const r = await server('test', { cs: cs.trim() });
      if (!r.ok) return r;
      const s = readSettings();
      // New databases start read-only: they may be production databases.
      const conn = { id: `db_${Date.now()}`, name: (name || '').trim() || 'My database', cs: cs.trim(), readOnly: true };
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
    // Ask for the AskDB password before allowing changes. Wrong guesses count toward the server lockout.
    confirmUnlock(dbName) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'overlay';
        wrap.innerHTML = `<div class="modal" style="max-width:420px">
            <h2>Allow changes?</h2>
            <p class="muted" style="margin:0 0 14px">Enter your AskDB password to allow changes to <b></b>. AskDB will still ask you to confirm every change, and it can never change table structure.</p>
            <input type="password" placeholder="Password" autocomplete="current-password">
            <div class="msg"></div>
            <div class="row"><div class="spacer"></div>
              <button class="btn ghost" data-a="no">Cancel</button>
              <button class="btn primary" data-a="yes">Allow changes</button></div>
          </div>`;
        wrap.querySelector('b').textContent = dbName;
        document.body.appendChild(wrap);
        const input = wrap.querySelector('input'), msg = wrap.querySelector('.msg'), yes = wrap.querySelector('[data-a=yes]');
        const done = (v) => { wrap.remove(); resolve(v); };
        input.focus();
        const go = async () => {
          if (!input.value) { msg.textContent = 'Please enter the password.'; msg.className = 'msg error'; return; }
          yes.disabled = true; msg.textContent = 'Checking…'; msg.className = 'msg';
          const r = await server('ping', {}, input.value);
          yes.disabled = false;
          if (r.ok) return done(true);
          msg.textContent = r.error === 'Wrong password.' ? "That password isn't right." : r.error; msg.className = 'msg error';
        };
        yes.onclick = go;
        wrap.querySelector('[data-a=no]').onclick = () => done(false);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') done(false); });
      });
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
