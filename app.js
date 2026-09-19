'use strict';

/* ============================================================
   中川歯科 口腔内写真 — 規格撮影と経過比較
   写真は端末内(IndexedDB)に保存し、任意で Google Drive へ同期する。
   ============================================================ */

/* ---------- 規格写真 8枚の定義 ---------- */
const VIEWS = [
  { id: 'io_front',   label: '口腔内 正面',     hint: '中切歯の正中を中央線に合わせ、咬合平面を水平に', guide: { t: 28, l: 8,  r: 8,  b: 28 } },
  { id: 'io_right',   label: '口腔内 右側方',   hint: '右側の犬歯から第一大臼歯まで入れる',             guide: { t: 28, l: 8,  r: 8,  b: 28 } },
  { id: 'io_left',    label: '口腔内 左側方',   hint: '左側の犬歯から第一大臼歯まで入れる',             guide: { t: 28, l: 8,  r: 8,  b: 28 } },
  { id: 'io_up',      label: '上顎 咬合面',     hint: 'ミラーを使い、正中を中央線に。左右対称に写す',   guide: { t: 10, l: 18, r: 18, b: 10, round: 50 } },
  { id: 'io_low',     label: '下顎 咬合面',     hint: 'ミラーを使い、正中を中央線に。舌が写らないように', guide: { t: 10, l: 18, r: 18, b: 10, round: 50 } },
  { id: 'fc_rest',    label: '顔貌 正面（安静）', hint: '正面を向き、唇は閉じずに力を抜いた状態',        guide: { t: 6,  l: 26, r: 26, b: 6,  round: 45 } },
  { id: 'fc_smile',   label: '顔貌 正面（スマイル）', hint: '上の前歯が見えるように笑ってもらう',        guide: { t: 6,  l: 26, r: 26, b: 6,  round: 45 } },
  { id: 'fc_profile', label: '顔貌 側貌',       hint: '右向きの側貌。耳と目が同じ高さに来るように',     guide: { t: 6,  l: 26, r: 26, b: 6,  round: 45 }, noline: true }
];
const VIEW_BY_ID = Object.fromEntries(VIEWS.map(v => [v.id, v]));

const DRIVE_ROOT = '中川歯科_口腔内写真';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/* ============================================================
   IndexedDB
   ============================================================ */
const DB_NAME = 'dental-photo';
const DB_VER = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('patients')) {
        const s = db.createObjectStore('patients', { keyPath: 'id' });
        s.createIndex('no', 'no', { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('sessionId', 'sessionId', { unique: false });
        s.createIndex('patientId', 'patientId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const dbGetAll = (store, index, key) => tx(store, 'readonly', s => {
  const src = index ? s.index(index) : s;
  return src.getAll(key === undefined ? undefined : key);
});
const dbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
const dbPut = (store, val) => tx(store, 'readwrite', s => s.put(val));
const dbDel = (store, key) => tx(store, 'readwrite', s => s.delete(key));

async function getMeta(key, dflt) {
  const r = await dbGet('meta', key);
  return r ? r.value : dflt;
}
const setMeta = (key, value) => dbPut('meta', { key, value });

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = iso => iso ? iso.replace(/-/g, '/') : '';

/* ============================================================
   画面遷移
   ============================================================ */
const $ = sel => document.querySelector(sel);
const views = {
  patients: $('#view-patients'),
  patient:  $('#view-patient'),
  capture:  $('#view-capture'),
  session:  $('#view-session'),
  compare:  $('#view-compare'),
  settings: $('#view-settings')
};
const state = { screen: 'patients', patientId: null, sessionId: null, compareView: VIEWS[0].id, stack: [] };

function show(screen, title, push = true) {
  if (state.screen === 'capture' && screen !== 'capture') stopCam();
  if (push && state.screen !== screen) state.stack.push(state.screen);
  state.screen = screen;
  for (const k in views) views[k].hidden = (k !== screen);
  $('#title').textContent = title;
  $('#backBtn').hidden = (screen === 'patients');
  $('#settingsBtn').hidden = (screen === 'capture');
  window.scrollTo(0, 0);
}

function goBack() {
  const prev = state.stack.pop() || 'patients';
  if (prev === 'patients') renderPatients(false);
  else if (prev === 'patient') renderPatient(state.patientId, false);
  else if (prev === 'session') renderSession(state.sessionId, false);
  else renderPatients(false);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const chev = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic chev');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'm9 18 6-6-6-6');
  s.appendChild(p);
  return s;
};

/* ============================================================
   患者一覧
   ============================================================ */
let allPatients = [];

async function renderPatients(push = true) {
  allPatients = (await dbGetAll('patients')).sort((a, b) =>
    a.no.localeCompare(b.no, 'ja', { numeric: true }));
  drawPatientList();
  show('patients', '患者一覧', push);
  state.stack = [];
}

function drawPatientList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#patientList');
  list.textContent = '';
  const hit = allPatients.filter(p =>
    !q || p.no.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));

  $('#patientsEmpty').hidden = allPatients.length > 0;
  for (const p of hit) {
    const li = el('li');
    const b = el('button', 'row');
    b.type = 'button';
    const m = el('div', 'main');
    m.appendChild(el('div', 'name', p.name || '（氏名未登録）'));
    m.appendChild(el('div', 'meta', `患者番号 ${p.no}`));
    b.appendChild(m);
    b.appendChild(chev());
    b.addEventListener('click', () => renderPatient(p.id));
    li.appendChild(b);
    list.appendChild(li);
  }
}

$('#search').addEventListener('input', drawPatientList);

/* ---------- 患者の追加・編集 ---------- */
let editingPatient = null;

function openPatientDialog(p) {
  editingPatient = p || null;
  $('#dlgTitle').textContent = p ? '患者情報を編集' : '患者を追加';
  $('#pNo').value = p ? p.no : '';
  $('#pName').value = p ? (p.name || '') : '';
  $('#pBirth').value = p ? (p.birth || '') : '';
  $('#pMemo').value = p ? (p.memo || '') : '';
  $('#patientDlg').showModal();
}

$('#addPatientBtn').addEventListener('click', () => openPatientDialog(null));
$('#editPatientBtn').addEventListener('click', async () => {
  openPatientDialog(await dbGet('patients', state.patientId));
});

$('#patientForm').addEventListener('submit', async ev => {
  if (ev.submitter && ev.submitter.value === 'cancel') return;
  const no = $('#pNo').value.trim();
  if (!no) return;
  const rec = editingPatient
    ? { ...editingPatient }
    : { id: uid(), createdAt: new Date().toISOString() };
  rec.no = no;
  rec.name = $('#pName').value.trim();
  rec.birth = $('#pBirth').value;
  rec.memo = $('#pMemo').value.trim();
  await dbPut('patients', rec);
  if (editingPatient) { await renderPatient(rec.id, false); }
  else { await renderPatients(false); toast('患者を追加しました'); }
});

/* ============================================================
   患者詳細
   ============================================================ */
async function renderPatient(patientId, push = true) {
  state.patientId = patientId;
  const p = await dbGet('patients', patientId);
  if (!p) { renderPatients(false); return; }

  const head = $('#patientHead');
  head.textContent = '';
  head.appendChild(el('div', 'no', `患者番号 ${p.no}`));
  head.appendChild(el('div', 'nm', p.name || '（氏名未登録）'));
  const sub = [];
  if (p.birth) sub.push(`生年月日 ${fmtDate(p.birth)}`);
  if (p.memo) sub.push(p.memo);
  if (sub.length) head.appendChild(el('div', 'mm', sub.join('\n')));

  const sessions = (await dbGetAll('sessions', 'patientId', patientId))
    .sort((a, b) => b.date.localeCompare(a.date));
  const photos = await dbGetAll('photos', 'patientId', patientId);

  const list = $('#sessionList');
  list.textContent = '';
  $('#sessionsEmpty').hidden = sessions.length > 0;

  for (const s of sessions) {
    const mine = photos.filter(x => x.sessionId === s.id);
    const synced = mine.filter(x => x.driveFileId).length;
    const li = el('li');
    const b = el('button', 'row');
    b.type = 'button';
    const m = el('div', 'main');
    m.appendChild(el('div', 'name', fmtDate(s.date)));
    m.appendChild(el('div', 'meta', `${mine.length} / ${VIEWS.length} 枚${s.label ? '　' + s.label : ''}`));
    b.appendChild(m);
    if (mine.length === 0) {
      b.appendChild(el('span', 'badge', '未撮影'));
    } else if (synced === mine.length) {
      b.appendChild(el('span', 'badge ok', '同期済'));
    } else {
      b.appendChild(el('span', 'badge pend', `未同期 ${mine.length - synced}`));
    }
    b.appendChild(chev());
    b.addEventListener('click', () => renderSession(s.id));
    li.appendChild(b);
    list.appendChild(li);
  }

  show('patient', p.name || p.no, push);
}

$('#newSessionBtn').addEventListener('click', async () => {
  const date = todayISO();
  const existing = (await dbGetAll('sessions', 'patientId', state.patientId))
    .find(s => s.date === date);
  let sid;
  if (existing) {
    sid = existing.id;
  } else {
    sid = uid();
    await dbPut('sessions', { id: sid, patientId: state.patientId, date, label: '', createdAt: new Date().toISOString() });
  }
  startCapture(sid);
});

$('#compareBtn').addEventListener('click', () => renderCompare());

/* ============================================================
   撮影
   ============================================================ */
let camStream = null;
let capQueue = [];
let capIndex = 0;
let capSessionId = null;
let pendingBlob = null;
let facing = 'environment';

async function startCapture(sessionId, only = null) {
  capSessionId = sessionId;
  const shot = await dbGetAll('photos', 'sessionId', sessionId);
  const taken = new Set(shot.map(p => p.view));
  capQueue = only ? [only] : VIEWS.filter(v => !taken.has(v.id)).map(v => v.id);
  if (capQueue.length === 0) capQueue = VIEWS.map(v => v.id);
  capIndex = 0;
  show('capture', '規格撮影');
  await openCam();
  drawCapStep();
}

async function openCam() {
  stopCam();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false
    });
    const v = $('#cam');
    v.srcObject = camStream;
    await v.play().catch(() => {});
  } catch (e) {
    toast('カメラを開けませんでした。ブラウザの権限を確認してください');
  }
}

function stopCam() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  const v = $('#cam');
  if (v) v.srcObject = null;
}

function drawCapStep() {
  if (capIndex >= capQueue.length) { finishCapture(); return; }
  const v = VIEW_BY_ID[capQueue[capIndex]];
  $('#capLabel').textContent = v.label;
  $('#capHint').textContent = v.hint;

  const g = $('#guide');
  g.className = 'guide' + (v.noline ? ' noline' : '');
  g.style.setProperty('--gt', v.guide.t + '%');
  g.style.setProperty('--gl', v.guide.l + '%');
  g.style.setProperty('--gr2', v.guide.r + '%');
  g.style.setProperty('--gb', v.guide.b + '%');
  g.style.setProperty('--gr', (v.guide.round || 8) + '%');

  const prog = $('#progress');
  prog.textContent = '';
  capQueue.forEach((_, i) => {
    const i2 = el('i');
    if (i < capIndex) i2.className = 'done';
    else if (i === capIndex) i2.className = 'cur';
    prog.appendChild(i2);
  });

  setReview(false);
}

function setReview(on) {
  $('#shot').hidden = !on;
  $('#guide').hidden = on;
  $('#shutter').hidden = on;
  $('#skipBtn').hidden = on;
  $('#retakeBtn').hidden = !on;
  $('#keepBtn').hidden = !on;
}

$('#shutter').addEventListener('click', async () => {
  const v = $('#cam');
  if (!v.videoWidth) { toast('カメラの準備中です'); return; }
  const maxW = 1600;
  const scale = Math.min(1, maxW / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  pendingBlob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  $('#shot').src = URL.createObjectURL(pendingBlob);
  setReview(true);
});

$('#retakeBtn').addEventListener('click', () => {
  if ($('#shot').src) URL.revokeObjectURL($('#shot').src);
  pendingBlob = null;
  setReview(false);
});

$('#keepBtn').addEventListener('click', async () => {
  if (!pendingBlob) return;
  const viewId = capQueue[capIndex];
  const old = (await dbGetAll('photos', 'sessionId', capSessionId)).find(p => p.view === viewId);
  if (old) await dbDel('photos', old.id);
  await dbPut('photos', {
    id: uid(),
    patientId: state.patientId,
    sessionId: capSessionId,
    view: viewId,
    blob: pendingBlob,
    createdAt: new Date().toISOString(),
    operator: await getMeta('operator', ''),
    driveFileId: null
  });
  if ($('#shot').src) URL.revokeObjectURL($('#shot').src);
  pendingBlob = null;
  capIndex++;
  drawCapStep();
});

$('#skipBtn').addEventListener('click', () => { capIndex++; drawCapStep(); });

function finishCapture() {
  stopCam();
  toast('撮影を保存しました');
  renderSession(capSessionId, false);
}

/* カメラ切替ボタン（前面／背面） */
(function addFlip() {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', 'カメラを切り替え');
  b.style.cssText = 'position:absolute;top:10px;right:10px;z-index:5;width:40px;height:40px;' +
    'border:0;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;display:grid;place-items:center;';
  b.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>' +
    '<path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/><path d="m15 3-3 2 3 2M9 21l3-2-3-2"/></svg>';
  b.addEventListener('click', async () => {
    facing = (facing === 'environment') ? 'user' : 'environment';
    await openCam();
  });
  document.querySelector('.camwrap').appendChild(b);
})();

/* ============================================================
   来院詳細
   ============================================================ */
const objURLs = [];
function freeURLs() { while (objURLs.length) URL.revokeObjectURL(objURLs.pop()); }
function srcOf(blob) { const u = URL.createObjectURL(blob); objURLs.push(u); return u; }

async function renderSession(sessionId, push = true) {
  state.sessionId = sessionId;
  const s = await dbGet('sessions', sessionId);
  if (!s) { renderPatient(state.patientId, false); return; }
  const p = await dbGet('patients', s.patientId);
  state.patientId = s.patientId;

  const head = $('#sessionHead');
  head.textContent = '';
  head.appendChild(el('div', 'no', `${p ? p.no : ''}　${p && p.name ? p.name : ''}`));
  head.appendChild(el('div', 'nm', fmtDate(s.date)));

  const photos = await dbGetAll('photos', 'sessionId', sessionId);
  const byView = Object.fromEntries(photos.map(x => [x.view, x]));

  freeURLs();
  const grid = $('#sessionGrid');
  grid.textContent = '';
  for (const v of VIEWS) {
    const cell = el('div', 'cell');
    const ph = byView[v.id];
    if (ph) {
      const img = document.createElement('img');
      img.src = srcOf(ph.blob);
      img.alt = v.label;
      img.loading = 'lazy';
      cell.appendChild(img);
    } else {
      const d = el('div', 'ph', '未撮影');
      cell.appendChild(d);
    }
    const cap = el('div', 'cap', v.label);
    if (ph && ph.driveFileId) cap.textContent = v.label + '（同期済）';
    cell.appendChild(cap);
    cell.addEventListener('click', () => startCapture(sessionId, v.id));
    grid.appendChild(cell);
  }

  show('session', `${p ? (p.name || p.no) : ''} ${fmtDate(s.date)}`, push);
}

$('#resumeBtn').addEventListener('click', () => startCapture(state.sessionId));

$('#deleteSessionBtn').addEventListener('click', async () => {
  if (!confirm('この来院の写真と記録を端末から削除します。Drive に同期済みの写真は残ります。よろしいですか。')) return;
  const photos = await dbGetAll('photos', 'sessionId', state.sessionId);
  for (const p of photos) await dbDel('photos', p.id);
  await dbDel('sessions', state.sessionId);
  toast('削除しました');
  renderPatient(state.patientId, false);
});

/* ============================================================
   経過比較
   ============================================================ */
async function renderCompare(push = true) {
  const picker = $('#viewPicker');
  picker.textContent = '';
  for (const v of VIEWS) {
    const b = el('button', null, v.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(v.id === state.compareView));
    b.addEventListener('click', () => { state.compareView = v.id; renderCompare(false); });
    picker.appendChild(b);
  }

  const photos = (await dbGetAll('photos', 'patientId', state.patientId))
    .filter(p => p.view === state.compareView);
  const sessions = await dbGetAll('sessions', 'patientId', state.patientId);
  const dateOf = Object.fromEntries(sessions.map(s => [s.id, s.date]));
  photos.sort((a, b) => (dateOf[a.sessionId] || '').localeCompare(dateOf[b.sessionId] || ''));

  freeURLs();
  const strip = $('#compareStrip');
  strip.textContent = '';
  $('#compareEmpty').hidden = photos.length > 0;

  const first = dateOf[photos[0] && photos[0].sessionId];
  for (const ph of photos) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = srcOf(ph.blob);
    img.alt = '';
    img.loading = 'lazy';
    const cap = document.createElement('figcaption');
    const d = dateOf[ph.sessionId];
    const b = el('b', null, fmtDate(d));
    cap.appendChild(b);
    if (d && first && d !== first) {
      const days = Math.round((new Date(d) - new Date(first)) / 86400000);
      cap.appendChild(document.createTextNode(`初回から ${Math.floor(days / 30)}か月`));
    } else {
      cap.appendChild(document.createTextNode('初回'));
    }
    fig.appendChild(img);
    fig.appendChild(cap);
    strip.appendChild(fig);
  }

  const p = await dbGet('patients', state.patientId);
  show('compare', `経過比較　${p ? (p.name || p.no) : ''}`, push);
}

/* ============================================================
   Google Drive
   ============================================================ */
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

async function initDrive() {
  const cid = await getMeta('clientId', '');
  $('#clientId').value = cid;
  if (!cid || !window.google || !google.accounts) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid,
    scope: DRIVE_SCOPE,
    callback: resp => {
      if (resp.error) { toast('サインインできませんでした'); return; }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      drawDriveStatus();
      toast('サインインしました');
      if (pendingSync) { const f = pendingSync; pendingSync = null; f(); }
    }
  });
  drawDriveStatus();
}

let pendingSync = null;

function haveToken() { return accessToken && Date.now() < tokenExpiry; }

function requestToken(after) {
  if (!tokenClient) { toast('先にクライアントIDを保存してください'); return false; }
  pendingSync = after || null;
  tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  return true;
}

function drawDriveStatus() {
  const box = $('#driveStatus');
  box.textContent = '';
  const cid = $('#clientId').value.trim();
  const line = (k, v) => {
    const d = el('div');
    d.appendChild(el('span', 'k', k + '：'));
    d.appendChild(document.createTextNode(v));
    box.appendChild(d);
  };
  line('クライアントID', cid ? '設定済み' : '未設定');
  line('サインイン', haveToken() ? '済み' : 'していません');
  line('保存先フォルダ', DRIVE_ROOT);
}

async function driveFetch(url, opts) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + accessToken, ...(opts && opts.headers) }
  });
  if (!r.ok) throw new Error('Drive API ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function ensureFolder(name, parentId) {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' ` +
    `and trashed=false and '${parentId || 'root'}' in parents`);
  const found = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`);
  if (found.files && found.files.length) return found.files[0].id;
  const made = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId || 'root']
    })
  });
  return made.id;
}

async function uploadPhoto(blob, name, folderId) {
  const boundary = 'bnd' + uid();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, blob, tail]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body
  });
  if (!r.ok) throw new Error('upload ' + r.status);
  return (await r.json()).id;
}

async function syncSession() {
  if (!haveToken()) { requestToken(syncSession); return; }
  const btn = $('#syncBtn');
  btn.disabled = true;
  try {
    const s = await dbGet('sessions', state.sessionId);
    const p = await dbGet('patients', s.patientId);
    const photos = (await dbGetAll('photos', 'sessionId', state.sessionId))
      .filter(x => !x.driveFileId);
    if (photos.length === 0) { toast('同期する写真はありません'); return; }

    const root = await ensureFolder(DRIVE_ROOT, null);
    const pf = await ensureFolder(p.no, root);
    const sf = await ensureFolder(s.date, pf);

    let n = 0;
    for (const ph of photos) {
      const name = `${s.date}_${ph.view}.jpg`;
      ph.driveFileId = await uploadPhoto(ph.blob, name, sf);
      await dbPut('photos', ph);
      n++;
      toast(`同期中 ${n} / ${photos.length}`);
    }
    toast(`${n} 枚を Drive へ同期しました`);
    renderSession(state.sessionId, false);
  } catch (e) {
    console.error(e);
    toast('同期に失敗しました：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

$('#syncBtn').addEventListener('click', syncSession);

/* ============================================================
   設定
   ============================================================ */
$('#settingsBtn').addEventListener('click', async () => {
  $('#operator').value = await getMeta('operator', '');
  await initDrive();
  await drawStorage();
  show('settings', '設定');
});

$('#saveClientId').addEventListener('click', async () => {
  await setMeta('clientId', $('#clientId').value.trim());
  accessToken = null; tokenExpiry = 0;
  await initDrive();
  toast('保存しました');
});

$('#signInBtn').addEventListener('click', () => requestToken(null));
$('#signOutBtn').addEventListener('click', () => {
  if (accessToken && window.google) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null; tokenExpiry = 0;
  drawDriveStatus();
  toast('サインアウトしました');
});

$('#saveOperator').addEventListener('click', async () => {
  await setMeta('operator', $('#operator').value.trim());
  toast('保存しました');
});

async function drawStorage() {
  const box = $('#storageStat');
  box.textContent = '';
  const [pt, ss, ph] = await Promise.all([dbGetAll('patients'), dbGetAll('sessions'), dbGetAll('photos')]);
  const bytes = ph.reduce((a, x) => a + (x.blob ? x.blob.size : 0), 0);
  const unsynced = ph.filter(x => !x.driveFileId).length;
  const line = (k, v) => {
    const d = el('div');
    d.appendChild(el('span', 'k', k + '：'));
    d.appendChild(document.createTextNode(v));
    box.appendChild(d);
  };
  line('患者', `${pt.length} 人`);
  line('来院', `${ss.length} 件`);
  line('写真', `${ph.length} 枚（未同期 ${unsynced} 枚）`);
  line('端末内の容量', (bytes / 1048576).toFixed(1) + ' MB');
}

$('#exportBtn').addEventListener('click', async () => {
  const [pt, ss, ph] = await Promise.all([dbGetAll('patients'), dbGetAll('sessions'), dbGetAll('photos')]);
  const data = {
    exportedAt: new Date().toISOString(),
    note: '写真の画像データは含まれません。画像は Drive への同期で保全してください。',
    patients: pt,
    sessions: ss,
    photos: ph.map(({ blob, ...rest }) => rest)
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dental-photo-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

/* ============================================================
   起動
   ============================================================ */
$('#backBtn').addEventListener('click', goBack);

window.addEventListener('beforeunload', ev => {
  if (state.screen === 'capture') { ev.preventDefault(); ev.returnValue = ''; }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderPatients(false);
