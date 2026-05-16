/* global state */
const state = {
  recordings: [],   // full list from server
  filtered: [],     // after search
  selected: new Set(),
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const loginScreen     = $('login-screen');
const appScreen       = $('app-screen');
const loginForm       = $('login-form');
const loginBtn        = $('login-btn');
const loginError      = $('login-error');
const logoutBtn       = $('logout-btn');
const userLabel       = $('user-label');
const searchInput     = $('search-input');
const selectAllBtn    = $('select-all-btn');
const deselectAllBtn  = $('deselect-all-btn');
const selectedLabel   = $('selected-label');
const totalBadge      = $('total-badge');
const recordingsList  = $('recordings-list');
const loadingMsg      = $('loading-msg');
const emptyMsg        = $('empty-msg');
const listErrorMsg    = $('list-error-msg');
const exportCount     = $('export-count');
const exportBtn       = $('export-btn');
const exportError     = $('export-error');
const includeTranscript = $('include-transcript');
const includeAudio      = $('include-audio');

/* ── Utilities ───────────────────────────────────────────────────────────── */

function formatDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── Login ───────────────────────────────────────────────────────────────── */

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(loginError);
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<div class="spinner"></div> Signing in…';

  try {
    await api('POST', '/api/login', {
      email: $('email').value.trim(),
      password: $('password').value,
      region: $('region').value,
    });
    await enterApp();
  } catch (err) {
    showError(loginError, err.message);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

async function enterApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;

  // Fetch user info
  try {
    const me = await api('GET', '/api/me');
    const user = me.data_user || {};
    userLabel.textContent = user.nickname || user.email || '';
  } catch {
    userLabel.textContent = '';
  }

  loadRecordings();
}

/* ── Logout ──────────────────────────────────────────────────────────────── */

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  state.recordings = [];
  state.filtered = [];
  state.selected.clear();
  recordingsList.innerHTML = '';
  loginScreen.hidden = false;
  appScreen.hidden = true;
  loginForm.reset();
});

/* ── Recordings ──────────────────────────────────────────────────────────── */

async function loadRecordings() {
  loadingMsg.hidden = false;
  emptyMsg.hidden = true;
  listErrorMsg.hidden = true;
  recordingsList.innerHTML = '';
  totalBadge.hidden = true;

  try {
    const data = await api('GET', '/api/recordings');
    state.recordings = data.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    state.selected.clear();
    applyFilter();
    totalBadge.textContent = state.recordings.length;
    totalBadge.hidden = false;
  } catch (err) {
    showError(listErrorMsg, `Failed to load recordings: ${err.message}`);
    listErrorMsg.hidden = false;
  } finally {
    loadingMsg.hidden = true;
  }
}

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  state.filtered = q
    ? state.recordings.filter((r) => (r.name || '').toLowerCase().includes(q))
    : [...state.recordings];

  // Remove selections that are no longer in the filtered set
  const filteredIds = new Set(state.filtered.map((r) => r.id));
  for (const id of [...state.selected]) {
    if (!filteredIds.has(id)) state.selected.delete(id);
  }

  renderList();
}

function renderList() {
  recordingsList.innerHTML = '';
  emptyMsg.hidden = state.filtered.length > 0;

  for (const rec of state.filtered) {
    const li = document.createElement('li');
    li.className = 'rec-item' + (state.selected.has(rec.id) ? ' selected' : '');
    li.dataset.id = rec.id;

    const pills = [];
    if (rec.is_trans) pills.push('<span class="rec-pill pill-transcript">Transcript</span>');
    if (rec.is_summary) pills.push('<span class="rec-pill pill-summary">Summary</span>');

    const meta = [formatDate(rec.start_time), formatDuration(rec.duration)]
      .filter(Boolean)
      .join(' · ');

    li.innerHTML = `
      <input type="checkbox" ${state.selected.has(rec.id) ? 'checked' : ''}
             aria-label="Select ${rec.name}">
      <div class="rec-info">
        <div class="rec-name">${escapeHtml(rec.name)}</div>
        <div class="rec-meta">
          ${meta ? `<span>${meta}</span>` : ''}
          ${pills.join('')}
        </div>
      </div>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return; // let checkbox handle itself
      toggleSelection(rec.id, li);
    });

    li.querySelector('input').addEventListener('change', () => {
      toggleSelection(rec.id, li);
    });

    recordingsList.appendChild(li);
  }

  updateSelectionUI();
}

function toggleSelection(id, li) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
    li.classList.remove('selected');
    li.querySelector('input').checked = false;
  } else {
    state.selected.add(id);
    li.classList.add('selected');
    li.querySelector('input').checked = true;
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selected.size;
  exportCount.textContent = n;
  exportBtn.disabled = n === 0;
  selectedLabel.textContent = n > 0 ? `${n} selected` : '';
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Search ──────────────────────────────────────────────────────────────── */

searchInput.addEventListener('input', applyFilter);

/* ── Bulk select ─────────────────────────────────────────────────────────── */

selectAllBtn.addEventListener('click', () => {
  for (const rec of state.filtered) state.selected.add(rec.id);
  renderList();
});

deselectAllBtn.addEventListener('click', () => {
  state.selected.clear();
  renderList();
});

/* ── Export ──────────────────────────────────────────────────────────────── */

exportBtn.addEventListener('click', async () => {
  hideError(exportError);

  if (!includeTranscript.checked && !includeAudio.checked) {
    showError(exportError, 'Select at least one export type (transcript or audio).');
    return;
  }

  const ids = [...state.selected];
  if (!ids.length) return;

  exportBtn.disabled = true;
  exportBtn.innerHTML = '<div class="spinner"></div> Preparing…';

  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids,
        includeTranscript: includeTranscript.checked,
        includeAudio: includeAudio.checked,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().split('T')[0];
    a.href = url;
    a.download = `plaud-export-${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(exportError, `Export failed: ${err.message}`);
  } finally {
    exportBtn.disabled = state.selected.size === 0;
    exportBtn.textContent = 'Export Selected';
  }
});
