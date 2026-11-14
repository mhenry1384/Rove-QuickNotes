'use strict';
(() => {
  const CFG = window.APP_CONFIG || {};
  // drive.file: the app can only see and edit files it created itself (the notes file).
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
  const FILE_NAME = CFG.FILE_NAME || 'QuickNotes.json';
  const CONFIGURED = !!CFG.CLIENT_ID && !CFG.CLIENT_ID.startsWith('YOUR_');
  const TOMBSTONE_DAYS = 30;        // deleted notes are remembered this long so other devices see the delete
  const POLL_MS = 15_000;           // check Drive for changes this often while the app is visible
  const PUSH_DELAY_MS = 1500;       // wait this long after the last keystroke before saving to Drive

  const COLORS = [
    ['default', 'Default'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'],
    ['teal', 'Teal'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['gray', 'Gray'],
  ];
  const COLOR_KEYS = new Set(COLORS.map((c) => c[0]));

  // ---------- persistence (localStorage, best effort) ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('qn.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) { try { localStorage.setItem('qn.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem('qn.' + k); } catch { /* ignore */ } },
  };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // A note: {id, type: 'text'|'list', title, text, items: [{id, text, done}], color, pinned,
  //          created, updated, deleted?}. Timestamps are ms since epoch.
  function normNote(n) {
    if (!n || typeof n.id !== 'string' || !n.id) return null;
    const out = {
      id: n.id,
      type: n.type === 'list' ? 'list' : 'text',
      title: String(n.title ?? ''),
      text: String(n.text ?? ''),
      items: Array.isArray(n.items)
        ? n.items.filter((i) => i && typeof i === 'object')
          .map((i) => ({ id: String(i.id || uid()), text: String(i.text ?? ''), done: !!i.done }))
        : [],
      color: COLOR_KEYS.has(n.color) ? n.color : 'default',
      pinned: !!n.pinned,
      created: Number(n.created) || 0,
      updated: Number(n.updated) || 0,
    };
    if (n.deleted) out.deleted = true;
    return out;
  }
  const normList = (arr) => (Array.isArray(arr) ? arr.map(normNote).filter(Boolean) : []);

  const state = {
    notes: normList(store.get('notes', [])),
    fileId: store.get('fileId', null),
    remoteVersion: store.get('remoteVersion', null), // Drive's version number of the file as last seen
    dirty: store.get('dirty', false),                // local changes not yet saved to Drive
    lastSync: 0,
    query: '',
  };
  let editSeq = 0;
  let token = store.get('token', null);              // {value, exp}

  const $ = (s) => document.querySelector(s);
  const els = {
    status: $('#status'), signinBtn: $('#signin-btn'), actions: $('#actions'), search: $('#search'),
    newNote: $('#new-note'), newList: $('#new-list'),
    pinnedSec: $('#pinned-sec'), pinned: $('#pinned'), othersHead: $('#others-head'), others: $('#others'),
    empty: $('#empty'),
    dlg: $('#editor'), title: $('#ed-title'), text: $('#ed-text'), items: $('#ed-items'),
    palette: $('#palette'), colorBtn: $('#ed-color'), pinBtn: $('#ed-pin'), convertBtn: $('#ed-convert'),
    copyBtn: $('#ed-copy'), deleteBtn: $('#ed-delete'), doneBtn: $('#ed-done'), edTime: $('#ed-time'),
    toast: $('#toast'), toastMsg: $('#toast-msg'), toastBtn: $('#toast-btn'),
  };

  const saveLocal = () => store.set('notes', state.notes);
  const byId = (id) => state.notes.find((n) => n.id === id);

  // Record a local change to a note. The timestamp is always newer than the note's
  // previous one, so the edit wins a merge even if another device's clock runs ahead.
  function touch(n) {
    n.updated = Math.max(Date.now(), n.updated + 1);
    if (ed.id === n.id) { ed.knownUpdated = n.updated; els.edTime.textContent = 'Edited just now'; }
    saveLocal();
    editSeq++;
    state.dirty = true;
    store.set('dirty', true);
    renderAuth();
    scheduleSync(PUSH_DELAY_MS);
  }

  // ---------- time ----------
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    const d = new Date(t);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  // ---------- merge ----------
  // Per note, the copy with the newer `updated` wins. Deleted notes stay as
  // tombstones for TOMBSTONE_DAYS so the delete reaches every device.
  function merge(local, remote) {
    const map = new Map(local.map((n) => [n.id, n]));
    for (const r of remote) {
      const l = map.get(r.id);
      if (!l || r.updated > l.updated) map.set(r.id, r);
    }
    const cutoff = Date.now() - TOMBSTONE_DAYS * 86400_000;
    return [...map.values()]
      .filter((n) => !(n.deleted && n.updated < cutoff))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const canonical = (notes) => JSON.stringify(notes);

  function parseFile(text) {
    if (!text.trim()) return [];
    let j;
    try { j = JSON.parse(text); } catch {
      throw new Error(`${FILE_NAME} in Google Drive isn't valid JSON, so it was left alone. Fix or delete it.`);
    }
    return normList(Array.isArray(j) ? j : j?.notes);
  }
  const serializeFile = (notes) => JSON.stringify({ app: 'QuickNotes', format: 1, notes }, null, 1) + '\n';

  // ---------- Google auth ----------
  // Uses Google's redirect sign-in instead of a popup. A token lasts about an hour; to get a
  // new one the app briefly goes to Google, which sends it straight back (no prompt) while
  // you're still signed in to Google. This needs no tap, so syncing never has to ask you.
  class AuthError extends Error {}
  const REDIRECT_URI = new URL('./', location.href).href;
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const tokenValid = () => !!token && token.exp > Date.now() + 60_000;
  const signedInOnce = () => store.get('signedInOnce', false);
  let authNeeded = false;     // Google wants a tap (first sign-in, or it asked to confirm)
  let authMessage = '';

  function authRedirect(interactive) {
    const st = uid();
    store.set('authState', st);
    store.set('authAttempt', Date.now());
    const p = new URLSearchParams({
      client_id: CFG.CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'token',
      scope: SCOPE, include_granted_scopes: 'true', state: st,
    });
    const email = store.get('email', null);
    if (email) p.set('login_hint', email);
    if (!interactive) p.set('prompt', 'none');
    else if (!email) p.set('prompt', 'select_account');
    saveLocal();
    location.assign(`${AUTH_URL}?${p}`);
  }

  // Coming back from Google: the result is in the URL fragment.
  (function readAuthResponse() {
    if (!/[#&]state=/.test(location.hash)) return;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const expected = store.get('authState', null);
    store.del('authState');
    if (!expected || h.get('state') !== expected) return;
    // authAttempt is kept: if this token is rejected, we won't bounce straight back to Google.
    if (h.get('access_token')) {
      if (!(h.get('scope') || '').split(' ').includes(SCOPE)) {
        authNeeded = true;
        authMessage = 'Google Drive access was not allowed. Tap Sign in and tick the box.';
        return;
      }
      token = { value: h.get('access_token'), exp: Date.now() + Number(h.get('expires_in') || 3600) * 1000 };
      store.set('token', token);
      store.set('signedInOnce', true);
    } else {
      // interaction_required / login_required / consent_required etc.: needs a tap.
      authNeeded = true;
      const err = h.get('error');
      if (err === 'access_denied') authMessage = 'Google sign-in was cancelled';
      else if (!/_required$/.test(err || '')) authMessage = 'Google sign-in failed: ' + (err || 'unknown error');
    }
  })();

  // Gets a fresh token without asking, but only at a moment when the quick trip to
  // Google and back can't interrupt anything (no note open, nothing being typed).
  let lastActivity = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchmove']) {
    addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  }
  function refreshAuthIfSafe({ idleMs = 0 } = {}) {
    if (!CONFIGURED || tokenValid() || authNeeded || !signedInOnce() || !navigator.onLine) return false;
    if (els.dlg.open || document.visibilityState !== 'visible') return false;
    if (document.activeElement === els.search && els.search.value) return false;
    if (Date.now() - lastActivity < idleMs) return false;
    // The last trip didn't come back with a token (e.g. Back was pressed on Google's page).
    if (Date.now() - store.get('authAttempt', 0) < 120_000) { authNeeded = true; renderAuth(); return false; }
    setStatus('Connecting to Google Drive…', false, true);
    authRedirect(false);
    return true;
  }

  // ---------- Drive API ----------
  async function api(url, opts = {}) {
    if (!tokenValid()) throw new AuthError('Sign in to sync');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token.value}` } });
    if (res.status === 401) {
      token = null; store.del('token'); renderAuth();
      throw new AuthError('Google sign-in expired');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return res;
  }
  const qstr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function findFile() {
    const p = new URLSearchParams({
      q: `name='${qstr(FILE_NAME)}' and trashed=false`,
      fields: 'files(id,version)', orderBy: 'createdTime', pageSize: '10', spaces: 'drive',
    });
    const j = await (await api(`${API}/files?${p}`)).json();
    return j.files?.[0] || null; // the oldest one, if two devices ever raced to create it
  }

  async function upload(fileId, body) {
    if (fileId) {
      const res = await api(`${UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,version`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body,
      });
      return res.json();
    }
    const boundary = 'qn' + Math.random().toString(36).slice(2);
    const meta = { name: FILE_NAME, mimeType: 'application/json' };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await api(`${UPLOAD_API}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
    });
    return res.json();
  }

  // ---------- sync ----------
  let syncing = null;
  let syncAgain = false;
  let syncTimer = null;

  function scheduleSync(ms) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync(), ms);
  }

  function sync(opts = {}) {
    clearTimeout(syncTimer);
    if (syncing) { syncAgain = true; return syncing; }
    syncing = doSync(opts).finally(() => {
      syncing = null;
      renderAuth();
      if (syncAgain) { syncAgain = false; sync(); }
    });
    renderAuth();
    return syncing;
  }

  async function doSync({ manual = false } = {}) {
    if (!CONFIGURED) return;
    if (!navigator.onLine) {
      setStatus(state.dirty ? 'Offline — changes are kept on this device' : 'Offline', false, true);
      return;
    }
    if (!tokenValid()) {
      if (refreshAuthIfSafe()) return;
      if (authNeeded || !signedInOnce()) setStatus(state.dirty ? 'Saved on this device only' : '', false, true);
      else if (state.dirty) setStatus('Not synced yet', false, true);
      return;
    }
    if (manual || state.dirty) setStatus('Syncing…', false, true);
    const seq = editSeq;
    try {
      let fileId = state.fileId;
      let version = null;
      if (fileId) {
        try {
          const meta = await (await api(`${API}/files/${fileId}?fields=version,trashed`)).json();
          if (meta.trashed) fileId = null; else version = meta.version;
        } catch (e) { if (e.status === 404) fileId = null; else throw e; }
      }
      if (!fileId) {
        const f = await findFile();
        if (f) { fileId = f.id; version = f.version; }
      }

      // Nothing changed on either side: skip the download.
      if (fileId && version === state.remoteVersion && !state.dirty) {
        state.lastSync = Date.now();
        if (manual) setStatus('Up to date');
        else if (/Syncing|Not synced|Offline|Saved on this|Network|expired/.test(els.status.textContent)) setStatus('');
        return;
      }
      if (!store.get('email', null)) {
        // Remembered so silent re-sign-in picks the right Google account.
        try {
          const about = await (await api(`${API}/about?fields=user(emailAddress)`)).json();
          if (about.user?.emailAddress) store.set('email', about.user.emailAddress);
        } catch { /* only a hint */ }
      }

      const remote = fileId ? parseFile(await (await api(`${API}/files/${fileId}?alt=media`)).text()) : [];
      const remoteClean = merge([], remote);
      const merged = merge(state.notes, remote);
      const before = canonical(merge([], state.notes));
      let pushed = false;
      if (!fileId || canonical(merged) !== canonical(remoteClean)) {
        const res = await upload(fileId, serializeFile(merged));
        fileId = res.id;
        version = res.version;
        pushed = true;
      }

      // Edits made while we were talking to Drive are newer, so they survive this merge.
      state.notes = merge(state.notes, merged);
      state.fileId = fileId;
      state.remoteVersion = version;
      if (editSeq === seq) state.dirty = false; else syncAgain = true;
      state.lastSync = Date.now();
      saveLocal();
      store.set('fileId', fileId);
      store.set('remoteVersion', version);
      store.set('dirty', state.dirty);

      const gotRemote = canonical(merge([], state.notes)) !== before;
      if (pushed) setStatus('Saved to Drive');
      else if (gotRemote) setStatus('Updated from Drive');
      else if (manual) setStatus('Up to date');
      else setStatus('');
      if (gotRemote) afterRemoteChange();
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e) {
    console.error(e);
    if (e instanceof AuthError) {
      renderAuth();
      if (!refreshAuthIfSafe()) setStatus(state.dirty ? 'Not synced yet' : '', false, true);
    }
    else if (!navigator.onLine) setStatus('Offline — changes are kept on this device', false, true);
    else if (e instanceof TypeError && /fetch|network/i.test(e.message)) setStatus('Network error — will retry', true);
    else setStatus(e.message, true);
  }

  // ---------- UI: status & auth ----------
  let statusTimer = null;
  function setStatus(msg, isError = false, sticky = false) {
    els.status.textContent = msg || '';
    els.status.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    if (msg && !isError && !sticky) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 3000);
  }

  // The Sign in button only appears when Google needs you to tap something.
  function renderAuth() {
    const need = CONFIGURED && !tokenValid() && (authNeeded || !signedInOnce());
    // Before the first sign-in, the big button in the middle of the page is enough.
    els.signinBtn.hidden = !need || !signedInOnce();
    // Search and the new-note buttons appear once you've signed in on this device.
    els.actions.hidden = CONFIGURED && !signedInOnce() && !tokenValid();
    if (need && authMessage) setStatus(authMessage, true);
  }

  els.signinBtn.addEventListener('click', () => authRedirect(true));

  // ---------- UI: grid of note cards ----------
  function matches(n, terms) {
    if (!terms.length) return true;
    const hay = (n.title + '\n' + (n.type === 'list' ? n.items.map((i) => i.text).join('\n') : n.text)).toLowerCase();
    return terms.every((t) => hay.includes(t));
  }

  function renderGrid() {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = state.notes.filter((n) => !n.deleted);
    const shown = all.filter((n) => matches(n, terms)).sort((a, b) => b.created - a.created);
    const pinned = shown.filter((n) => n.pinned);
    const others = shown.filter((n) => !n.pinned);

    els.pinnedSec.hidden = !pinned.length;
    els.pinned.replaceChildren(...pinned.map(card));
    els.othersHead.hidden = !pinned.length || !others.length;
    els.others.replaceChildren(...others.map(card));

    els.empty.hidden = !!shown.length;
    if (!shown.length) {
      els.empty.replaceChildren();
      if (terms.length) {
        els.empty.textContent = 'No notes match your search.';
      } else if (!CONFIGURED) {
        els.empty.innerHTML = '<p>Setup needed: put your Google OAuth client ID in <code>config.js</code>. See README.md.</p>';
      } else if (!signedInOnce() && !tokenValid()) {
        const p = document.createElement('p');
        p.textContent = 'Sign in with Google to keep your notes in sync across devices.';
        const b = document.createElement('button');
        b.className = 'btn primary';
        b.type = 'button';
        b.textContent = 'Sign in with Google';
        b.addEventListener('click', () => authRedirect(true));
        els.empty.append(p, b);
      } else {
        els.empty.textContent = 'No notes yet. Tap + Note or + List to add one.';
      }
    }
    for (const c of document.querySelectorAll('.card')) c.classList.toggle('clipped', c.scrollHeight > c.clientHeight + 1);
  }

  // Turns URLs into links; everything else stays as plain text nodes.
  function linkify(parent, text) {
    const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener';
      parent.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function card(n) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = n.id;
    el.dataset.color = n.color;
    el.tabIndex = 0;
    el.setAttribute('aria-label', `Open ${n.type === 'list' ? 'list' : 'note'}${n.title ? ': ' + n.title : ''}`);

    if (n.title.trim()) {
      const h = document.createElement('h3');
      h.textContent = n.title;
      el.append(h);
    }
    if (n.type === 'list') {
      const open = n.items.filter((i) => !i.done && i.text.trim());
      const done = n.items.filter((i) => i.done && i.text.trim());
      const ul = document.createElement('ul');
      ul.className = 'card-list';
      for (const i of open.slice(0, 10)) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'check';
        b.dataset.item = i.id;
        b.setAttribute('aria-label', `Mark done: ${i.text}`);
        const span = document.createElement('span');
        linkify(span, i.text);
        li.append(b, span);
        ul.append(li);
      }
      if (open.length) el.append(ul);
      const more = [];
      if (open.length > 10) more.push(`+ ${open.length - 10} more`);
      if (done.length) more.push(`${done.length} checked`);
      if (!open.length && !done.length) more.push('Empty list');
      if (more.length) {
        const p = document.createElement('div');
        p.className = 'card-more';
        p.textContent = more.join(' · ');
        el.append(p);
      }
    } else if (n.text.trim()) {
      const div = document.createElement('div');
      div.className = 'card-text';
      linkify(div, n.text.length > 1200 ? n.text.slice(0, 1200) + '…' : n.text);
      el.append(div);
    } else if (!n.title.trim()) {
      const p = document.createElement('div');
      p.className = 'card-more';
      p.textContent = 'Empty note';
      el.append(p);
    }
    const t = document.createElement('span');
    t.className = 'card-time';
    t.textContent = 'Edited ' + ago(n.updated);
    el.append(t);
    return el;
  }

  function onGridClick(e) {
    if (e.target.closest('a')) return;
    const c = e.target.closest('.card');
    if (!c) return;
    const check = e.target.closest('.check');
    if (check) {
      const n = byId(c.dataset.id);
      const item = n?.items.find((i) => i.id === check.dataset.item);
      if (item) { item.done = true; touch(n); renderGrid(); toast('Checked off', { label: 'Undo', fn: () => { item.done = false; touch(n); renderGrid(); } }); }
      return;
    }
    openEditor(c.dataset.id);
  }
  function onGridKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
      e.preventDefault();
      openEditor(e.target.dataset.id);
    }
  }
  for (const g of [els.pinned, els.others]) {
    g.addEventListener('click', onGridClick);
    g.addEventListener('keydown', onGridKey);
  }

  // ---------- editor ----------
  const ed = { id: null, knownUpdated: 0 };
  const cur = () => (ed.id ? byId(ed.id) : null);

  // Size the editor to the part of the screen the on-screen keyboard leaves visible,
  // so the toolbar sits just above the keyboard instead of hidden behind it.
  const vv = window.visualViewport;
  if (vv) {
    const fitViewport = () => {
      const root = document.documentElement.style;
      root.setProperty('--vv-h', vv.height + 'px');
      root.setProperty('--vv-top', vv.offsetTop + 'px');
    };
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
    fitViewport();
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function newNote(type) {
    const now = Date.now();
    const n = normNote({
      id: uid(), type, created: now, updated: now,
      items: type === 'list' ? [{ id: uid(), text: '', done: false }] : [],
    });
    state.notes.push(n);
    saveLocal();
    openEditor(n.id, 'title');
  }

  function openEditor(id, focus) {
    const n = byId(id);
    if (!n) return;
    ed.id = id;
    els.palette.hidden = true;
    els.colorBtn.setAttribute('aria-expanded', 'false');
    renderEditor();
    if (!els.dlg.open) {
      els.dlg.showModal();
      history.pushState({ qnEditor: true }, '');
    }
    requestAnimationFrame(() => {
      autosize(els.text);
      for (const ta of els.items.querySelectorAll('textarea')) autosize(ta);
      if (focus === 'title') els.title.focus();
      else if (focus === 'text') els.text.focus();
      else if (focus === 'item') els.items.querySelector('textarea')?.focus();
      else els.dlg.focus();
    });
  }

  function renderEditor(focusItem, caret) {
    const n = cur();
    if (!n) return;
    ed.knownUpdated = n.updated;
    els.dlg.dataset.color = n.color;
    if (els.title.value !== n.title) els.title.value = n.title;
    const isList = n.type === 'list';
    els.text.hidden = isList;
    els.items.hidden = !isList;
    if (isList) renderItems(focusItem, caret);
    else if (els.text.value !== n.text) { els.text.value = n.text; autosize(els.text); }
    els.pinBtn.setAttribute('aria-pressed', String(n.pinned));
    const pinLabel = n.pinned ? 'Unpin' : 'Pin';
    els.pinBtn.title = pinLabel;
    els.pinBtn.setAttribute('aria-label', pinLabel);
    const conv = isList ? 'Convert to plain note' : 'Convert to checklist';
    els.convertBtn.title = conv;
    els.convertBtn.setAttribute('aria-label', conv);
    for (const s of els.palette.children) s.setAttribute('aria-pressed', String(s.dataset.color === n.color));
    els.edTime.textContent = n.updated ? 'Edited ' + ago(n.updated) : '';
  }

  // Re-renders the open note after a change arrived from Drive, keeping the cursor where it was.
  function afterRemoteChange() {
    renderGrid();
    if (!ed.id) return;
    const n = cur();
    if (!n || n.deleted) {
      ed.id = null;
      els.dlg.close();
      toast('This note was deleted on another device');
      return;
    }
    if (n.updated === ed.knownUpdated) return;
    const a = document.activeElement;
    let focusItem = null;
    let caret = null;
    if (a?.tagName === 'TEXTAREA' || a?.tagName === 'INPUT') caret = a.selectionStart;
    if (a?.closest?.('.item-row')) focusItem = a.closest('.item-row').dataset.id;
    renderEditor(focusItem, caret);
    if ((a === els.title || a === els.text) && caret != null) { a.focus(); a.setSelectionRange(caret, caret); }
  }

  function closeEditor() { if (els.dlg.open) els.dlg.close(); }

  const isEmpty = (n) => !n.title.trim() &&
    (n.type === 'list' ? n.items.every((i) => !i.text.trim()) : !n.text.trim());

  els.dlg.addEventListener('close', () => {
    const n = cur();
    ed.id = null;
    if (n && !n.deleted && isEmpty(n)) { n.deleted = true; touch(n); }
    if (history.state?.qnEditor) history.back();
    renderGrid();
    if (state.dirty) scheduleSync(200);
  });
  // The phone's back button closes the editor instead of leaving the app.
  window.addEventListener('popstate', () => { if (els.dlg.open) els.dlg.close(); });
  if (history.state?.qnEditor) history.replaceState(null, '');

  // Clicking the dimmed area around the dialog closes it.
  els.dlg.addEventListener('click', (e) => {
    if (e.target !== els.dlg) return;
    const r = els.dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeEditor();
  });

  els.title.addEventListener('input', () => { const n = cur(); if (n) { n.title = els.title.value; touch(n); } });
  els.title.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const n = cur();
    if (n?.type === 'list') els.items.querySelector('textarea')?.focus(); else els.text.focus();
  });
  els.text.addEventListener('input', () => {
    const n = cur();
    if (!n) return;
    n.text = els.text.value;
    autosize(els.text);
    touch(n);
  });

  // ---- checklist editing ----
  // Parses one pasted/converted line, recognising common checkbox markers.
  function parseLine(line) {
    let s = line.trim();
    let done = false;
    const m = s.match(/^(?:[-*•]\s*)?(?:\[( |x|X)\]|☐|☑|✓|✔)\s*/);
    if (m) { done = /[xX☑✓✔]/.test(m[0]); s = s.slice(m[0].length); }
    else s = s.replace(/^[-*•]\s+/, '');
    return { text: s, done };
  }

  function renderItems(focusId, caret) {
    const n = cur();
    const open = n.items.filter((i) => !i.done);
    const done = n.items.filter((i) => i.done);
    const frag = document.createDocumentFragment();
    for (const i of open) frag.append(itemRow(i));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-item';
    add.textContent = '+ List item';
    frag.append(add);
    if (done.length) {
      const det = document.createElement('details');
      det.className = 'done-group';
      det.open = store.get('showChecked', true);
      det.addEventListener('toggle', () => store.set('showChecked', det.open));
      const sum = document.createElement('summary');
      sum.textContent = `${done.length} checked item${done.length === 1 ? '' : 's'}`;
      det.append(sum, ...done.map(itemRow));
      frag.append(det);
    }
    els.items.replaceChildren(frag);
    for (const ta of els.items.querySelectorAll('textarea')) autosize(ta);
    if (focusId) {
      const ta = els.items.querySelector(`.item-row[data-id="${CSS.escape(focusId)}"] textarea`);
      if (ta) {
        ta.focus();
        const p = caret == null ? ta.value.length : Math.min(caret, ta.value.length);
        ta.setSelectionRange(p, p);
      }
    }
  }

  function itemRow(i) {
    const row = document.createElement('div');
    row.className = 'item-row' + (i.done ? ' done' : '');
    row.dataset.id = i.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = i.done;
    cb.setAttribute('aria-label', 'Done');
    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.value = i.text;
    ta.placeholder = 'List item';
    ta.enterKeyHint = 'next';
    ta.setAttribute('aria-label', 'List item');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'item-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove item');
    row.append(cb, ta, del);
    return row;
  }

  function itemCtx(target) {
    const row = target.closest('.item-row');
    const n = cur();
    if (!row || !n) return null;
    const idx = n.items.findIndex((i) => i.id === row.dataset.id);
    return idx < 0 ? null : { n, idx, item: n.items[idx], row };
  }

  // The visible item just above this one (same section), for Backspace navigation.
  function prevVisible(n, item) {
    const group = n.items.filter((i) => i.done === item.done);
    return group[group.indexOf(item) - 1] || null;
  }

  els.items.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const c = itemCtx(e.target);
    if (!c) return;
    c.item.done = e.target.checked;
    touch(c.n);
    renderItems();
  });

  els.items.addEventListener('input', (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    const c = itemCtx(e.target);
    if (!c) return;
    // Some phone keyboards insert a newline instead of sending an Enter keydown.
    if (e.target.value.includes('\n')) {
      const [first, ...rest] = e.target.value.split('\n');
      c.item.text = first;
      const added = rest.map((t) => ({ id: uid(), text: t, done: false }));
      c.n.items.splice(c.idx + 1, 0, ...added);
      touch(c.n);
      renderItems(added[added.length - 1].id, 0);
      return;
    }
    c.item.text = e.target.value;
    autosize(e.target);
    touch(c.n);
  });

  els.items.addEventListener('keydown', (e) => {
    if (e.target.tagName !== 'TEXTAREA' || e.isComposing) return;
    const c = itemCtx(e.target);
    if (!c) return;
    const ta = e.target;
    if (e.key === 'Enter') {
      e.preventDefault();
      const pos = ta.selectionStart;
      const after = ta.value.slice(ta.selectionEnd);
      c.item.text = ta.value.slice(0, pos);
      const ni = { id: uid(), text: after, done: false };
      c.n.items.splice(c.idx + 1, 0, ni);
      touch(c.n);
      renderItems(ni.id, 0);
    } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const prev = prevVisible(c.n, c.item);
      if (!c.item.text) {
        e.preventDefault();
        c.n.items.splice(c.idx, 1);
        touch(c.n);
        renderItems(prev?.id);
      } else if (prev) {
        e.preventDefault();
        const len = prev.text.length;
        prev.text += c.item.text;
        c.n.items.splice(c.idx, 1);
        touch(c.n);
        renderItems(prev.id, len);
      }
    }
  });

  els.items.addEventListener('paste', (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/\r?\n/.test(text.trim())) return;
    const c = itemCtx(e.target);
    if (!c) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/).map(parseLine).filter((l) => l.text);
    const ta = e.target;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const first = lines.shift();
    c.item.text = before + first.text;
    if (!before && !after) c.item.done = first.done;
    const added = lines.map((l) => ({ id: uid(), text: l.text, done: l.done }));
    const last = added.length ? added[added.length - 1] : c.item;
    const caret = last.text.length;
    last.text += after;
    c.n.items.splice(c.idx + 1, 0, ...added);
    touch(c.n);
    renderItems(last.id, caret);
  });

  els.items.addEventListener('click', (e) => {
    if (e.target.closest('.item-del')) {
      const c = itemCtx(e.target);
      if (!c) return;
      c.n.items.splice(c.idx, 1);
      touch(c.n);
      renderItems();
    } else if (e.target.closest('.add-item')) {
      const n = cur();
      const ni = { id: uid(), text: '', done: false };
      // Put it after the last unchecked item so it shows at the end of the open list.
      let at = -1;
      n.items.forEach((i, k) => { if (!i.done) at = k; });
      n.items.splice(at + 1, 0, ni);
      touch(n);
      renderItems(ni.id);
    }
  });

  // ---- editor toolbar ----
  for (const [key, label] of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = key;
    b.title = label;
    b.setAttribute('aria-label', label);
    els.palette.append(b);
  }
  els.colorBtn.addEventListener('click', () => {
    els.palette.hidden = !els.palette.hidden;
    els.colorBtn.setAttribute('aria-expanded', String(!els.palette.hidden));
  });
  els.palette.addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    const n = cur();
    if (!s || !n) return;
    n.color = s.dataset.color;
    touch(n);
    renderEditor();
  });

  els.pinBtn.addEventListener('click', () => {
    const n = cur();
    if (!n) return;
    n.pinned = !n.pinned;
    touch(n);
    renderEditor();
  });

  els.convertBtn.addEventListener('click', () => {
    const n = cur();
    if (!n) return;
    if (n.type === 'text') {
      const items = n.text.split(/\r?\n/).map(parseLine).filter((l) => l.text)
        .map((l) => ({ id: uid(), text: l.text, done: l.done }));
      n.items = items.length ? items : [{ id: uid(), text: '', done: false }];
      n.text = '';
      n.type = 'list';
      touch(n);
      renderEditor(n.items.find((i) => !i.done)?.id);
    } else {
      n.text = n.items.filter((i) => i.text.trim()).map((i) => (i.done ? '☑ ' : '') + i.text).join('\n');
      n.items = [];
      n.type = 'text';
      touch(n);
      renderEditor();
      requestAnimationFrame(() => autosize(els.text));
    }
  });

  els.copyBtn.addEventListener('click', async () => {
    const n = cur();
    if (!n) return;
    const body = n.type === 'list'
      ? n.items.filter((i) => i.text.trim()).map((i) => (i.done ? '☑ ' : '☐ ') + i.text).join('\n')
      : n.text;
    const text = [n.title.trim(), body.trim()].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      toast('Copy failed — your browser blocked clipboard access');
    }
  });

  els.deleteBtn.addEventListener('click', () => {
    const n = cur();
    if (!n) return;
    const wasEmpty = isEmpty(n);
    n.deleted = true;
    touch(n);
    closeEditor();
    if (!wasEmpty) {
      toast('Note deleted', { label: 'Undo', fn: () => { delete n.deleted; touch(n); renderGrid(); } });
    }
  });

  els.doneBtn.addEventListener('click', closeEditor);

  // ---------- toast ----------
  const popoverOK = typeof els.toast.showPopover === 'function';
  if (!popoverOK) els.toast.hidden = true;
  let toastTimer = null;
  let toastAction = null;
  function toast(msg, action) {
    els.toastMsg.textContent = msg;
    toastAction = action?.fn || null;
    els.toastBtn.hidden = !action;
    els.toastBtn.textContent = action?.label || '';
    if (popoverOK) {
      // Re-showing moves it to the top of the stack, above an open dialog.
      if (els.toast.matches(':popover-open')) els.toast.hidePopover();
      els.toast.showPopover();
    } else {
      els.toast.hidden = false;
      els.toast.classList.add('shown');
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 2500);
  }
  function hideToast() {
    if (popoverOK) { if (els.toast.matches(':popover-open')) els.toast.hidePopover(); }
    else { els.toast.hidden = true; els.toast.classList.remove('shown'); }
    toastAction = null;
  }
  els.toastBtn.addEventListener('click', () => {
    const fn = toastAction;
    hideToast();
    fn?.();
  });

  // ---------- wiring ----------
  els.newNote.addEventListener('click', () => newNote('text'));
  els.newList.addEventListener('click', () => newNote('list'));
  els.search.addEventListener('input', () => { state.query = els.search.value; renderGrid(); });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.search.value) {
      els.search.value = '';
      state.query = '';
      renderGrid();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (els.dlg.open || els.actions.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === '/') { e.preventDefault(); els.search.focus(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newNote('text'); }
    else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); newNote('list'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.dirty) sync(); // try to save before the app is put away
    } else if (Date.now() - state.lastSync > 10_000) {
      sync();
      renderGrid();
    }
  });
  window.addEventListener('online', () => sync());
  // Back from Google's page via the Back button (page restored from cache): try again later.
  window.addEventListener('pageshow', (e) => { if (e.persisted) { renderAuth(); sync(); } });
  window.addEventListener('offline', () => setStatus('Offline — changes are kept on this device', false, true));
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (tokenValid()) sync();
    else if (!syncing) refreshAuthIfSafe({ idleMs: 20_000 }); // signed out an hour later: renew while idle
    if (!els.dlg.open) renderGrid(); // refresh "Edited … ago"
    else if (ed.id) els.edTime.textContent = 'Edited ' + ago(cur()?.updated || Date.now());
  }, POLL_MS);

  // Another tab or window of the app on this device saved notes: pick them up.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'qn.notes' || !e.newValue) return;
    try {
      state.notes = merge(state.notes, normList(JSON.parse(e.newValue)));
      afterRemoteChange();
    } catch { /* ignore */ }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.error));
  }

  document.getElementById('version').textContent = 'v' + (window.APP_VERSION ?? '?');

  renderGrid();
  renderAuth();
  sync();
})();
