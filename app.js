'use strict';

/* ============================================================
   中川歯科 口腔内写真 — 規格撮影と経過比較
   写真は端末内(IndexedDB)に保存し、任意で Google Drive へ同期する。
   ============================================================ */

/* ---------- 規格写真 8枚の定義 ---------- */
/* intraoral: 口腔内かどうか（倍率の自動切替に使う）
   shape:    ガイドの線画の種類
   mirror:   ミラー撮影の既定と反転軸。'h'=左右反転 / 'v'=上下反転 / null=ミラーなし */
const VIEWS = [
  { id: 'io_front', label: '口腔内 正面', tip: '奥歯を噛み合わせます',
    hint: '中切歯の正中を中央線に合わせ、咬合平面を水平に',
    intraoral: true, shape: 'front', mirror: null },
  { id: 'io_right', label: '口腔内 右側方', tip: '右の奥歯がもっと見えるようにします',
    hint: '中切歯から第二大臼歯まで入れる。正中の線に前歯を合わせる',
    intraoral: true, shape: 'buccalR', mirror: { axis: 'h', on: false } },
  { id: 'io_left', label: '口腔内 左側方', tip: '左の奥歯がもっと見えるようにします',
    hint: '中切歯から第二大臼歯まで入れる。正中の線に前歯を合わせる',
    intraoral: true, shape: 'buccalL', mirror: { axis: 'h', on: false } },
  { id: 'io_up', label: '上顎 咬合面', tip: 'ミラーで上の歯列全体を写します',
    hint: '正中を中央線に。左右対称に写す',
    intraoral: true, shape: 'archUp', mirror: { axis: 'v', on: true } },
  { id: 'io_low', label: '下顎 咬合面', tip: '舌が写らないようにします',
    hint: '正中を中央線に。左右対称に写す',
    intraoral: true, shape: 'archLow', mirror: { axis: 'v', on: true } },
  { id: 'fc_rest', label: '顔貌 正面（安静）', tip: '力を抜いて、正面を向きます',
    hint: '唇は閉じず、自然に力を抜いた状態',
    zoom: 1, shape: 'faceFront', mirror: null },
  { id: 'fc_smile', label: '顔貌 正面（スマイル）', tip: '上の前歯が見えるように笑います',
    hint: '正面を向いたまま、口角を上げてもらう',
    zoom: 1, shape: 'faceFront', mirror: null },
  { id: 'fc_profile', label: '顔貌 側貌', tip: '右を向いて、耳と目を水平にします',
    hint: '右向きの側貌。耳と目が同じ高さに来るように',
    zoom: 1, shape: 'faceSide', mirror: null }
];
const VIEW_BY_ID = Object.fromEntries(VIEWS.map(v => [v.id, v]));

/* 口腔内で選べる倍率。既定は 4.6x（遠近感の歪みが最も小さい）。 */
const ZOOM_STEPS = [
  { v: 1.6, label: '1.6x', note: '解像度を優先' },
  { v: 3.0, label: '3.0x', note: '解像度と歪みのバランス' },
  { v: 4.6, label: '4.6x', note: '遠近感の歪みを最小に' }
];
const DEFAULT_IO_ZOOM = 4.6;

/* ============================================================
   ガイドの線画（SVG）
   歯列の形に合わせた枠を重ねることで、毎回同じ画角で撮れるようにする。
   viewBox は 400x300。実際の描画領域に合わせて拡大縮小される。
   ============================================================ */

/* 歯種ごとの輪郭。-1〜1 の正方形に正規化してあり、使うときに拡大・回転する。

   咬合面用（OCC）: y が -1 で頬側、+1 で舌側。小臼歯・大臼歯には溝を入れる。
   唇頬側用（FAC）: y が -1 で歯頸部、+1 で切縁・咬合面。 */
const OCC = {
  incisor: ['M -1 0.08 C -0.95 -0.78, 0.95 -0.78, 1 0.08 C 0.76 0.88, -0.76 0.88, -1 0.08 Z'],
  canine: ['M 0 -1 C 0.56 -0.86, 0.96 -0.3, 0.95 0.16 C 0.8 0.86, -0.8 0.86, -0.95 0.16 C -0.96 -0.3, -0.56 -0.86, 0 -1 Z'],
  premolar: [
    'M -0.9 -0.34 C -0.86 -0.92, 0.86 -0.92, 0.9 -0.34 C 0.96 0.46, 0.6 0.96, 0 0.96 C -0.6 0.96, -0.96 0.46, -0.9 -0.34 Z',
    'M -0.52 0.04 C -0.2 0.22, 0.2 0.22, 0.52 0.04'
  ],
  molar: [
    'M -0.86 -0.68 C -0.8 -0.94, 0.8 -0.94, 0.88 -0.6 C 0.98 -0.2, 0.98 0.46, 0.85 0.76 C 0.6 0.98, -0.6 0.98, -0.86 0.72 C -0.98 0.4, -0.95 -0.3, -0.86 -0.68 Z',
    'M -0.62 -0.06 C -0.2 0.16, 0.2 -0.16, 0.62 0.06',
    'M -0.14 -0.02 L -0.22 -0.84',
    'M 0.12 0.02 L 0.2 0.86'
  ]
};
const FAC = {
  incisor: ['M -0.56 -1 C -0.73 -0.58, -0.9 0.12, -0.92 0.6 C -0.9 0.9, -0.5 1, 0 1 C 0.5 1, 0.9 0.9, 0.92 0.6 C 0.9 0.12, 0.73 -0.58, 0.56 -1 Z'],
  canine: ['M -0.5 -1 C -0.68 -0.58, -0.88 0, -0.9 0.4 C -0.85 0.74, -0.4 0.88, 0 1 C 0.4 0.88, 0.85 0.74, 0.9 0.4 C 0.88 0, 0.68 -0.58, 0.5 -1 Z'],
  premolar: ['M -0.56 -1 C -0.73 -0.58, -0.9 -0.1, -0.9 0.34 C -0.85 0.74, -0.35 1, 0 1 C 0.35 1, 0.85 0.74, 0.9 0.34 C 0.9 -0.1, 0.73 -0.58, 0.56 -1 Z'],
  molar: ['M -0.6 -1 C -0.78 -0.58, -0.95 -0.1, -0.95 0.34 C -0.9 0.7, -0.6 0.95, -0.35 0.84 C -0.12 0.72, 0.12 0.72, 0.35 0.84 C 0.6 0.95, 0.9 0.7, 0.95 0.34 C 0.95 -0.1, 0.78 -0.58, 0.6 -1 Z']
};

/* 正規化した歯を、指定の位置・大きさ・向きで置く。
   線の太さを一定に保つため vector-effect を使う。 */
function tooth(set, type, x, y, w, h, rot, flipY) {
  const sx = w / 2, sy = (flipY ? -1 : 1) * h / 2;
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${sx.toFixed(2)} ${sy.toFixed(2)})">`
       + set[type].map(d => `<path d="${d}" vector-effect="non-scaling-stroke"/>`).join('')
       + `</g>`;
}

/* 中切歯から第二大臼歯まで、1象限ぶんの歯の大きさ。
   rx=近遠心幅の半分、ry=頬舌径の半分。 */
const QUADRANT = [
  { rx: 16, ry: 14, t: 'incisor' },   // 中切歯
  { rx: 14, ry: 13, t: 'incisor' },   // 側切歯
  { rx: 15, ry: 16, t: 'canine' },    // 犬歯
  { rx: 16, ry: 17, t: 'premolar' },  // 第一小臼歯
  { rx: 16, ry: 18, t: 'premolar' },  // 第二小臼歯
  { rx: 23, ry: 23, t: 'molar' },     // 第一大臼歯
  { rx: 22, ry: 22, t: 'molar' }      // 第二大臼歯
];
const FULL_ARCH = [...QUADRANT].slice().reverse().concat(QUADRANT);

/* 咬合面。up=true で前歯が上（上顎）、false で前歯が下（下顎）。
   歯列が枠いっぱいに収まるよう、弧の上下中央を枠の中心に合わせる。 */
function archShape(up) {
  const cx = 200;
  const R = 115;                                    // 前方の弧の半径（歯列弓の幅の半分）
  const sgn = up ? 1 : -1;
  const curveLen = Math.PI * R;
  const total = FULL_ARCH.reduce((s, t) => s + t.rx * 2, 0);
  const L = Math.max(24, (total - curveLen) / 2);   // 臼歯部の直線部。歯列が過不足なく収まる長さ
  /* 描いたときの上下の張り出しから、枠の中央に来る位置を求める */
  const ryAnt = QUADRANT[0].ry, rxMol = QUADRANT[QUADRANT.length - 1].rx;
  const yC = 150 + sgn * ((R + ryAnt) - (L + rxMol)) / 2;

  let acc = 0, out = '';
  for (const t of FULL_ARCH) {
    const s = acc + t.rx;              // 歯の中心までの道のり
    acc += t.rx * 2;
    let x, y, rot;
    if (s < L) {                       // 左の臼歯部（ほぼ平行）
      x = cx - R;
      y = yC + sgn * (L - s);
      rot = -90;
    } else if (s < L + curveLen) {     // 前方の弧
      const phi = Math.PI + (s - L) / R;
      x = cx + R * Math.cos(phi);
      y = yC + sgn * R * Math.sin(phi);
      rot = Math.atan2(Math.cos(phi), -Math.sin(phi)) * 180 / Math.PI;
    } else {                           // 右の臼歯部
      x = cx + R;
      y = yC + sgn * (s - L - curveLen);
      rot = 90;
    }
    if (!up) rot += 180;               // 下顎は舌側が逆向きになる
    out += tooth(OCC, t.t, x, y, t.rx * 2, t.ry * 2, rot, false);
  }
  out += `<line x1="${cx}" y1="24" x2="${cx}" y2="276" stroke-dasharray="4 9"/>`;
  return out;
}

/* 正面観。上顎前歯が大きく、後方へいくほど小さく、奥へ回り込んで見える。
   切縁は中切歯がいちばん下がり、後方へゆるやかに上がる。 */
function frontShape() {
  const mid = 200, occ = 152;
  /* w=歯の幅、h=歯冠の長さ、dy=切縁の高さのずれ（マイナスで上がる） */
  const upper = [
    { w: 34, h: 54, dy: 0,   t: 'incisor' },   // 中切歯
    { w: 27, h: 44, dy: -5,  t: 'incisor' },   // 側切歯
    { w: 26, h: 50, dy: -1,  t: 'canine' },    // 犬歯
    { w: 24, h: 38, dy: -8,  t: 'premolar' },  // 第一小臼歯
    { w: 21, h: 34, dy: -13, t: 'premolar' },  // 第二小臼歯
    { w: 19, h: 29, dy: -19, t: 'molar' }      // 第一大臼歯
  ];
  const lower = [
    { w: 19, h: 30, dy: 0,  t: 'incisor' }, { w: 21, h: 31, dy: 0,  t: 'incisor' },
    { w: 25, h: 37, dy: 2,  t: 'canine' },  { w: 24, h: 33, dy: 5,  t: 'premolar' },
    { w: 21, h: 29, dy: 9,  t: 'premolar' }, { w: 19, h: 26, dy: 14, t: 'molar' }
  ];
  let out = '';
  for (const side of [-1, 1]) {
    let x = mid;
    for (const t of upper) {                 // 上顎は歯頸部が上、切縁が下
      out += tooth(FAC, t.t, x + side * t.w / 2, occ + t.dy - t.h / 2, t.w, t.h, 0, false);
      x += side * t.w;
    }
    x = mid;
    for (const t of lower) {                 // 下顎は上下を反転
      out += tooth(FAC, t.t, x + side * t.w / 2, occ + t.dy + 3 + t.h / 2, t.w, t.h, 0, true);
      x += side * t.w;
    }
  }
  out += `<line x1="200" y1="26" x2="200" y2="274" stroke-dasharray="4 9"/>`;
  out += `<line x1="46" y1="${occ}" x2="354" y2="${occ}" stroke-dasharray="6 7"/>`;
  return out;
}

/* 側方観。中切歯から第二大臼歯まで入れる。前歯は斜めから見るぶん細く、
   奥へいくほど遠近で低くなる。 */
function buccalShape(toRight) {
  const occ = 150;
  const teeth = [
    { w: 20, hU: 48, hL: 30, t: 'incisor' },   // 中切歯
    { w: 20, hU: 41, hL: 31, t: 'incisor' },   // 側切歯
    { w: 34, hU: 50, hL: 34, t: 'canine' },    // 犬歯
    { w: 36, hU: 41, hL: 35, t: 'premolar' },  // 第一小臼歯
    { w: 34, hU: 37, hL: 34, t: 'premolar' },  // 第二小臼歯
    { w: 40, hU: 34, hL: 33, t: 'molar' },     // 第一大臼歯
    { w: 30, hU: 29, hL: 28, t: 'molar' }      // 第二大臼歯
  ];
  const span = teeth.reduce((s, t) => s + t.w, 0);
  const startX = toRight ? 200 - span / 2 : 200 + span / 2;
  let x = startX;
  const step = toRight ? 1 : -1;
  let out = '';
  for (const t of teeth) {
    const cxT = x + step * t.w / 2;
    out += tooth(FAC, t.t, cxT, occ - t.hU / 2, t.w, t.hU, 0, false);
    out += tooth(FAC, t.t, cxT, occ + 3 + t.hL / 2, t.w, t.hL, 0, true);
    x += step * t.w;
  }
  out += `<line x1="52" y1="${occ}" x2="348" y2="${occ}" stroke-dasharray="6 6"/>`;
  /* 正中の位置。中切歯の内側の端に合わせる。 */
  out += `<line x1="${startX.toFixed(1)}" y1="${occ - 58}" x2="${startX.toFixed(1)}" y2="${occ + 42}" stroke-dasharray="4 7"/>`;
  return out;
}

/* 顔貌 正面。輪郭と、目・口の高さの目安線。 */
function faceFrontShape() {
  return `<ellipse cx="200" cy="150" rx="74" ry="102"/>`
       + `<line x1="140" y1="122" x2="176" y2="122"/><line x1="224" y1="122" x2="260" y2="122"/>`
       + `<line x1="168" y1="196" x2="232" y2="196" stroke-dasharray="5 5"/>`
       + `<line x1="200" y1="40" x2="200" y2="260" stroke-dasharray="4 8"/>`;
}

/* 顔貌 側貌。右向きの頭部シルエット。 */
function faceSideShape() {
  return `<path d="M150 60 C110 70 92 110 96 148 C99 182 112 206 128 222 `
       + `L134 250 M240 96 C262 110 272 132 271 152 C270 168 262 178 256 186 `
       + `C252 192 254 200 250 208 C244 218 228 222 214 224 L212 246 `
       + `M150 60 C180 46 218 60 240 96"/>`
       + `<path d="M158 150 C150 140 146 158 152 166 C158 174 168 172 170 164"/>`
       + `<line x1="96" y1="150" x2="272" y2="150" stroke-dasharray="4 8"/>`;
}

const SHAPES = {
  front: frontShape,
  buccalR: () => buccalShape(true),
  buccalL: () => buccalShape(false),
  archUp: () => archShape(true),
  archLow: () => archShape(false),
  faceFront: faceFrontShape,
  faceSide: faceSideShape
};

function guideSVG(shape, withFrame = true) {
  const body = (SHAPES[shape] || frontShape)();
  return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
       + (withFrame ? `<rect class="gframe" x="26" y="20" width="348" height="260" rx="4"/>` : '')
       + `<g class="gart">${body}</g></svg>`;
}

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
    // IDBRequest なら result を返す。レコードが無いときは undefined を返したいので
    // 'result' in out で判定する（result === undefined でもリクエスト自体を返さない）。
    t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
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

/* 生年月日：数字8桁を YYYY-MM-DD に整える。入れ違いや不正な日付は空を返す。 */
function normalizeBirth(text) {
  const d = (text || '').replace(/\D/g, '');
  if (d.length !== 8) return '';
  const y = +d.slice(0, 4), m = +d.slice(4, 6), day = +d.slice(6, 8);
  const dt = new Date(y, m - 1, day);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== day) return '';
  if (y < 1900 || dt > new Date()) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* 年齢（歳・か月）。小児矯正では装置の適応年齢に直結するので月まで出す。 */
function ageOf(iso) {
  if (!iso) return '';
  const b = new Date(iso), n = new Date();
  let mo = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
  if (n.getDate() < b.getDate()) mo--;
  if (mo < 0) return '';
  return `${Math.floor(mo / 12)}歳${mo % 12}か月`;
}

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

/* 打ちながら 2018-04-05 の形に整える */
$('#pBirth').addEventListener('input', ev => {
  const d = ev.target.value.replace(/\D/g, '').slice(0, 8);
  let out = d.slice(0, 4);
  if (d.length > 4) out += '-' + d.slice(4, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  ev.target.value = out;
});

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
  const rawBirth = $('#pBirth').value.trim();
  rec.birth = normalizeBirth(rawBirth);
  if (rawBirth && !rec.birth) toast('生年月日が正しくないため空欄で保存しました');
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
  if (p.birth) sub.push(`生年月日 ${fmtDate(p.birth)}　（${ageOf(p.birth)}）`);
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

$('#deletePatientBtn').addEventListener('click', async () => {
  const p = await dbGet('patients', state.patientId);
  if (!p) return;
  const photos = await dbGetAll('photos', 'patientId', state.patientId);
  const sessions = await dbGetAll('sessions', 'patientId', state.patientId);
  const msg = `${p.name || p.no} の記録を端末から削除します。\n\n`
    + `来院 ${sessions.length} 件、写真 ${photos.length} 枚が消えます。元に戻せません。\n`
    + `Drive へ同期済みの写真は Drive に残ります。\n\nよろしいですか。`;
  if (!confirm(msg)) return;
  for (const x of photos) await dbDel('photos', x.id);
  for (const s of sessions) await dbDel('sessions', s.id);
  await dbDel('patients', p.id);
  toast('削除しました');
  renderPatients(false);
});

/* ============================================================
   撮影
   ============================================================ */
let camStream = null;
let capQueue = [];
let capIndex = 0;
let capSessionId = null;
let pendingBlob = null;
let facing = 'environment';

/* ズーム。端末のカメラが対応していればレンズ側（native）で寄せ、
   足りないぶんは切り出し（digital）で補う。見えている画角＝保存される画角。 */
let camTrack = null;
let zoomCap = null;       // {min,max,step} または null
let digitalZoom = 1;      // 切り出し倍率
let ioZoom = DEFAULT_IO_ZOOM;

/* ミラー撮影。
   プレビューはミラーに映ったままの向きで出す。そのほうが手を動かした向きと
   画面の動きが一致して狙いやすい。代わりに見本の線画を同じ向きへ反転させ、
   画面上で重ねられるようにする。保存するときに像を元へ戻す。 */
let mirrorOn = false;
let mirrorAxis = null;

function applyPreviewTransform() {
  $('#cam').style.transform = digitalZoom > 1 ? `scale(${digitalZoom})` : '';
}

/* 見本の線画を、ミラーに映るのと同じ向きへ反転する */
function applyGuideTransform() {
  const sx = (mirrorOn && mirrorAxis === 'h') ? -1 : 1;
  const sy = (mirrorOn && mirrorAxis === 'v') ? -1 : 1;
  $('#guide').style.transform = (sx === 1 && sy === 1) ? '' : `scale(${sx}, ${sy})`;
}

async function applyZoom(target) {
  digitalZoom = 1;
  if (camTrack && zoomCap) {
    const z = Math.min(Math.max(target, zoomCap.min), zoomCap.max);
    try {
      await camTrack.applyConstraints({ advanced: [{ zoom: z }] });
      if (target > z) digitalZoom = target / z;
    } catch (e) {
      digitalZoom = target;
    }
  } else {
    digitalZoom = target;
  }
  applyPreviewTransform();
}

function drawMirrorBtn() {
  const view = VIEW_BY_ID[capQueue[capIndex]];
  const b = $('#mirrorBtn');
  b.hidden = !(view && view.mirror);
  if (b.hidden) return;
  b.setAttribute('aria-pressed', String(mirrorOn));
  b.querySelector('.mlabel').textContent = mirrorOn
    ? (mirrorAxis === 'v' ? 'ミラー（上下反転）' : 'ミラー（左右反転）')
    : 'ミラーを使わない';
}

function drawZoomBar() {
  const view = VIEW_BY_ID[capQueue[capIndex]];
  const bar = $('#zoombar');
  bar.hidden = !(view && view.intraoral);
  if (bar.hidden) return;
  bar.textContent = '';
  for (const z of ZOOM_STEPS) {
    const b = el('button', null, z.label);
    b.type = 'button';
    b.title = z.note;
    b.setAttribute('aria-pressed', String(Math.abs(z.v - ioZoom) < 0.01));
    b.addEventListener('click', async () => {
      ioZoom = z.v;
      await setMeta('ioZoom', z.v);
      await applyZoom(z.v);
      drawZoomBar();
    });
    bar.appendChild(b);
  }
}

async function startCapture(sessionId, only = null) {
  capSessionId = sessionId;
  const shot = await dbGetAll('photos', 'sessionId', sessionId);
  const taken = new Set(shot.map(p => p.view));
  capQueue = only ? [only] : VIEWS.filter(v => !taken.has(v.id)).map(v => v.id);
  if (capQueue.length === 0) capQueue = VIEWS.map(v => v.id);
  capIndex = 0;
  ioZoom = await getMeta('ioZoom', DEFAULT_IO_ZOOM);
  show('capture', '規格撮影');
  await openCam();
  await drawCapStep();
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
    camTrack = camStream.getVideoTracks()[0];
    const caps = camTrack.getCapabilities ? camTrack.getCapabilities() : {};
    zoomCap = caps.zoom || null;
  } catch (e) {
    toast('カメラを開けませんでした。ブラウザの権限を確認してください');
  }
}

function stopCam() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  camTrack = null;
  zoomCap = null;
  digitalZoom = 1;
  const v = $('#cam');
  if (v) { v.srcObject = null; v.style.transform = ''; }
}

async function drawCapStep() {
  if (capIndex >= capQueue.length) { finishCapture(); return; }
  const v = VIEW_BY_ID[capQueue[capIndex]];

  /* アングルごとに、ミラーの既定と倍率を自動で合わせる */
  if (v.mirror) {
    mirrorAxis = v.mirror.axis;
    const saved = await getMeta('mirror_' + v.id, null);
    mirrorOn = (saved === null || saved === undefined) ? v.mirror.on : saved;
  } else {
    mirrorAxis = null;
    mirrorOn = false;
  }
  await applyZoom(v.intraoral ? ioZoom : (v.zoom || 1));
  drawZoomBar();
  drawMirrorBtn();

  $('#hintbar').textContent = v.tip || '';
  $('#capLabel').textContent = v.label;
  $('#capHint').textContent = v.hint;

  $('#guide').innerHTML = guideSVG(v.shape);
  applyGuideTransform();

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
  /* プレビューで見えている範囲（中央を digitalZoom 倍に切り出した領域）をそのまま保存する */
  const sw = v.videoWidth / digitalZoom;
  const sh = v.videoHeight / digitalZoom;
  const sx = (v.videoWidth - sw) / 2;
  const sy = (v.videoHeight - sh) / 2;
  const maxW = 1600;
  const scale = Math.min(1, maxW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  /* ミラー像を元に戻してから保存する */
  if (mirrorOn && mirrorAxis === 'h') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  if (mirrorOn && mirrorAxis === 'v') { ctx.translate(0, c.height); ctx.scale(1, -1); }
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
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
  await drawCapStep();
});

$('#skipBtn').addEventListener('click', async () => { capIndex++; await drawCapStep(); });

$('#mirrorBtn').addEventListener('click', async () => {
  const v = VIEW_BY_ID[capQueue[capIndex]];
  if (!v || !v.mirror) return;
  mirrorOn = !mirrorOn;
  await setMeta('mirror_' + v.id, mirrorOn);
  applyGuideTransform();
  drawMirrorBtn();
});

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

  /* 患者番号の確認。症例を取り違えないよう、撮り始める前に目に入る位置に置く。 */
  const warn = $('#warnBar');
  warn.hidden = !!warnDismissed[sessionId];
  $('#warnNo').textContent = p ? `患者番号 ${p.no}${p.name ? '　' + p.name : ''}` : '';

  freeURLs();
  const grid = $('#sessionGrid');
  grid.textContent = '';
  VIEWS.forEach((v, i) => {
    const ph = byView[v.id];
    const cell = el('button', 'slot' + (ph ? ' taken' : ''));
    cell.type = 'button';

    if (ph) {
      const img = document.createElement('img');
      img.className = 'shot-img';
      img.src = srcOf(ph.blob);
      img.alt = v.label;
      img.loading = 'lazy';
      cell.appendChild(img);
    } else {
      const box = el('div', 'ph');
      const g = el('div', 'guide');
      g.innerHTML = guideSVG(v.shape, false);
      box.appendChild(g);
      cell.appendChild(box);
    }

    const add = el('span', 'add');
    add.innerHTML = ph
      ? '<svg viewBox="0 0 24 24" class="ic"><path d="M20 6 9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>';
    cell.appendChild(add);

    const cap = el('span', 'cap');
    cap.appendChild(el('span', 'num', String(i + 1)));
    cap.appendChild(document.createTextNode(v.label + (ph && ph.driveFileId ? '（同期済）' : '')));
    cell.appendChild(cap);

    cell.addEventListener('click', () => startCapture(sessionId, v.id));
    grid.appendChild(cell);
  });

  const remain = VIEWS.filter(v => !byView[v.id]).length;
  const btn = $('#captureBtn');
  btn.textContent = remain === 0 ? 'すべて撮影済み（撮り直す）' : `撮影する（残り ${remain} 枚）`;

  show('session', `${p ? (p.name || p.no) : ''} ${fmtDate(s.date)}`, push);
}

/* 患者番号の確認バナーを閉じたかどうか。来院ごとに覚える。 */
const warnDismissed = {};
$('#warnClose').addEventListener('click', () => {
  warnDismissed[state.sessionId] = true;
  $('#warnBar').hidden = true;
});

$('#captureBtn').addEventListener('click', () => startCapture(state.sessionId));

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
