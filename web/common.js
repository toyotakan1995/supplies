/* ============================================================
   ตัวช่วยที่ทุกหน้าใช้ร่วมกัน — เรียก token, ยิง API, toast, กล่องซ้อน, กระดิ่งแจ้งเตือน
   โหลดต่อจาก brand.css และก่อน <script> ของหน้านั้น ๆ
   ============================================================ */
/* หลังบ้านอยู่คนละโดเมนกับหน้าเว็บ (หน้าเว็บ = GitHub Pages · หลังบ้าน = Supabase Edge Function)
   ทุกคำขอจึงต้องเติมที่อยู่ฐานจาก config.js · เว้นว่าง = โดเมนเดียวกัน (ตอนทดสอบในเครื่อง) */
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');
const apiUrl = (path) => API_BASE + path;

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

const TOKEN = localStorage.getItem('eq_token');
if (!TOKEN && !/login\.html$/.test(location.pathname)) location.replace('login.html');

const ROLE_LABEL = { employee:'พนักงาน', approver:'หัวหน้างาน', warehouse:'ผู้ดูแลคลัง', admin:'ผู้ดูแลระบบ' };
const KIND_LABEL = { consumable:'ของสิ้นเปลือง', asset:'ครุภัณฑ์' };
const REQ_STATUS = {
  draft:    { t:'ร่าง',            c:'mute' },
  pending:  { t:'รอคลังจ่ายของ',   c:'warn' },
  issued:   { t:'รับของแล้ว',      c:'ok'   },
  partial:  { t:'ได้บางส่วน',      c:'info' },
  rejected: { t:'ถูกปฏิเสธ',       c:'bad'  },
  cancelled:{ t:'ยกเลิกแล้ว',      c:'mute' },
};
const ASSET_STATUS = { available:'พร้อมใช้งาน', in_use:'อยู่กับพนักงาน', maintenance:'ส่งซ่อม', lost:'สูญหาย', retired:'ปลดระวาง' };
const MOVE_LABEL = { receive:'รับเข้า', issue:'จ่ายออก', return:'รับคืน', adjust:'ปรับยอด', write_off:'ตัดสูญ' };

const num = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const money = (n) => '฿ ' + num(n);
const dt = (ms) => (ms ? new Date(ms).toLocaleString('th-TH', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—');
const dOnly = (ms) => (ms ? new Date(ms).toLocaleDateString('th-TH', { day:'2-digit', month:'short', year:'2-digit' }) : '—');
/** แปลงค่าจาก <input type=date> เป็น epoch ms · ตั้งเป็นสิ้นวันเพื่อไม่ให้ "ครบกำหนดวันนี้" กลายเป็นเลยกำหนดตั้งแต่เช้า */
const dateToMs = (v) => { if (!v) return null; const d = new Date(v + 'T23:59:59'); return isNaN(d) ? null : d.getTime(); };
const msToDate = (ms) => { if (!ms) return ''; const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };

/* ---------- toast ---------- */
function toast(msg, cls = '') {
  let box = $('#toastBox');
  if (!box) { box = document.createElement('div'); box.id = 'toastBox'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + cls; el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4400);
}

/* ---------- API ---------- */
async function api(path, opt = {}) {
  const r = await fetch(apiUrl(path), { ...opt,
    headers: { 'Content-Type':'application/json', Authorization:'Bearer ' + TOKEN, ...(opt.headers || {}) } });
  if (r.status === 401) { localStorage.clear(); location.replace('login.html'); throw new Error('หมดเวลาเข้าสู่ระบบ'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'เกิดข้อผิดพลาด');
  return d;
}
/** ดาวน์โหลดไฟล์ที่ต้องแนบ token ไปด้วย — เปิด URL ตรง ๆ ไม่ได้เพราะเบราว์เซอร์ไม่ส่ง header ให้ */
async function download(path, filename) {
  const r = await fetch(apiUrl(path), { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) throw new Error('ดาวน์โหลดไม่สำเร็จ');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- กล่องซ้อน ---------- */
let _esc = null;
/** กล่องที่ "มีของกรอกค้างอยู่" — กดพื้นหลังหรือ Esc แล้วต้องไม่ปิดทิ้ง
 *  🔑 ผู้ใช้เจอจริง: เลือกของใส่ใบเบิกไว้แล้วเผลอกดนอกกล่อง ของที่เลือกหายหมดโดยไม่มีคำเตือน
 *     ปิดได้ทางเดียวคือกดปุ่ม × หรือปุ่มในกล่อง (เป็นการตั้งใจปิด) */
let _sticky = false;
function ensureOverlay() {
  if ($('#ov')) return;
  const ov = document.createElement('div');
  ov.className = 'ov'; ov.id = 'ov'; ov.hidden = true;
  ov.innerHTML = `<div class="modal" id="modal" role="dialog" aria-modal="true">
      <div class="mhead"><h2 id="mTitle"></h2><button id="mClose" aria-label="ปิด">&times;</button></div>
      <div class="mbody" id="mBody"></div><div class="mfoot" id="mFoot"></div></div>`;
  document.body.appendChild(ov);
  $('#mClose').onclick = closeModal;
  ov.onclick = (e) => { if (e.target === ov && !_sticky) closeModal(); };
}
/** opts: true = กว้าง (แบบเดิม) · หรือ { wide, sticky } — sticky = กดนอกกล่อง/Esc แล้วไม่ปิด */
function openModal(title, bodyEl, buttons, opts) {
  const o = (opts && typeof opts === 'object') ? opts : { wide: !!opts };
  const wide = !!o.wide;
  _sticky = !!o.sticky;
  ensureOverlay();
  $('#mTitle').textContent = title;
  $('#mBody').innerHTML = ''; $('#mBody').appendChild(bodyEl);
  $('#mFoot').innerHTML = '';
  for (const b of buttons || []) {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.primary ? 'btn-primary' : b.danger ? 'btn-danger' : 'btn-ghost');
    el.textContent = b.label;
    el.onclick = lockWhileBusy(el, b.onClick);
    $('#mFoot').appendChild(el);
  }
  $('#modal').classList.toggle('wide', !!wide);
  $('#ov').hidden = false;
  const first = bodyEl.querySelector('input,select,textarea');
  if (first) first.focus();
  _esc = (e) => { if (e.key === 'Escape' && !_sticky) closeModal(); };
  document.addEventListener('keydown', _esc);
}
function closeModal() {
  if ($('#ov')) $('#ov').hidden = true;
  if (_esc) { document.removeEventListener('keydown', _esc); _esc = null; }
  _sticky = false;
}
/** ครอบปุ่มที่ยิงงานไปเซิร์ฟเวอร์ — ระหว่างรอผลจะกดซ้ำไม่ได้
 *  🔑 กันคนกดรัว/เน็ตช้าแล้วกดซ้ำ จนยิงคำขอเดียวกัน 2 ครั้ง
 *     (ฝั่งเซิร์ฟเวอร์กันไว้แล้วด้วยการเช็กสถานะในทรานแซกชัน แต่ผู้ใช้จะเจอ error งง ๆ ว่า "ใบนี้จ่ายไปแล้ว")
 *  ปิดทุกปุ่มในแถวเดียวกันด้วย เพราะกด "ปฏิเสธ" ระหว่างที่ "จ่ายของ" กำลังวิ่งก็เป็นปัญหาเหมือนกัน */
function lockWhileBusy(el, fn) {
  return async (ev) => {
    if (el.dataset.busy === '1') return;
    const row = el.parentElement;
    const sibs = row ? [...row.querySelectorAll('button')] : [el];
    const label = el.textContent;
    el.dataset.busy = '1';
    for (const b of sibs) b.disabled = true;
    el.textContent = 'กำลังบันทึก…';
    try {
      return await fn(ev);
    } finally {
      el.dataset.busy = '';
      el.textContent = label;
      // ปุ่มอาจถูกถอดออกไปแล้วถ้าโมดัลปิด/วาดใหม่ — เช็กก่อนคืนสถานะ
      for (const b of sibs) if (b.isConnected) b.disabled = false;
    }
  };
}

function form(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }
function showErr(box, msg) {
  let e = box.querySelector('.merr');
  if (!e) { e = document.createElement('div'); e.className = 'merr'; box.prepend(e); }
  e.hidden = false; e.textContent = msg; e.scrollIntoView({ block:'nearest' });
}

/* ---------- รูปสินค้า ----------
   รูปไม่ได้มากับรายการสินค้า (payload จะบวมทุกคำขอ) ต้องดึงต่างหากทีละรูป
   และดึงด้วย fetch + token เพราะ <img src> ส่ง header ไม่ได้ → ใช้ objectURL แทน */
const IMG_CACHE = new Map();   // itemId -> objectURL (ต่อการโหลดหน้า 1 ครั้ง)

/** ใส่รูปสินค้าลงใน <img> ที่ให้มา · ไม่มีรูป/โหลดไม่ได้ = ปล่อยว่างไว้เงียบ ๆ */
async function setItemImg(img, itemId) {
  if (!img || !itemId) return;
  try {
    if (!IMG_CACHE.has(itemId)) {
      const r = await fetch(apiUrl('/api/catalog/items/' + itemId + '/image'), {
        headers: { Authorization: 'Bearer ' + TOKEN },
      });
      if (!r.ok) throw new Error('no image');
      IMG_CACHE.set(itemId, URL.createObjectURL(await r.blob()));
    }
    img.src = IMG_CACHE.get(itemId);
    img.hidden = false;
  } catch { /* ไม่มีรูปก็ไม่เป็นไร ใช้กรอบว่างแทน */ }
}

/** ย่อรูปในเบราว์เซอร์ก่อนส่งขึ้นเซิร์ฟเวอร์
 *  🔑 ย่อฝั่งนี้เพราะเซิร์ฟเวอร์ไม่มีไลบรารีจัดการรูป และรูปจากมือถือใบละ 3-8MB
 *  ยาวสุด 800px คุณภาพ .82 → ปกติเหลือ 60-120KB ดูบนจอ/มือถือคมพอ */
async function shrinkImage(file, max = 800, quality = 0.82) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error('เปิดไฟล์รูปนี้ไม่ได้ · ลองใช้ไฟล์ JPG หรือ PNG'); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';              // รูป PNG พื้นโปร่งจะกลายเป็นดำถ้าไม่รองพื้นขาวก่อนแปลงเป็น JPEG
  cx.fillRect(0, 0, w, h);
  cx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('ย่อรูปไม่สำเร็จ');
  return blob;
}

/** ส่งรูปขึ้นเซิร์ฟเวอร์ (ผู้ดูแลคลังเท่านั้น) */
async function uploadItemImg(itemId, blob) {
  const r = await fetch(apiUrl('/api/catalog/items/' + itemId + '/image'), {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || 'อัปโหลดรูปไม่สำเร็จ');
  IMG_CACHE.delete(itemId);
  return true;
}

/* ---------- ชิ้นส่วนเล็ก ๆ ---------- */
function pill(text, cls) {
  const s = document.createElement('span');
  s.className = 'pill ' + (cls || 'mute'); s.textContent = text;
  return s;
}
function rowBtn(label, cls, fn) {
  const b = document.createElement('button');
  b.className = 'rowbtn ' + (cls || ''); b.textContent = label; b.onclick = fn;
  return b;
}
/** เนื้อในของสถานะ "ไม่มีข้อมูล" — ไอคอน + พาดหัว + คำอธิบาย (คำอธิบายจะใส่หรือไม่ก็ได้)
 *  แยก "ยังไม่มีของในระบบ" ออกจาก "หาไม่เจอ" ให้ชัด ไม่งั้นวันแรกที่เปิดใช้
 *  พนักงานจะนึกว่าตัวเองพิมพ์ผิด ทั้งที่คลังยังไม่ได้คีย์ของ */
function emptyBody(icon, title, hint) {
  const f = document.createDocumentFragment();
  if (icon) { const i = document.createElement('span'); i.className = 'ic'; i.textContent = icon; f.appendChild(i); }
  const b = document.createElement('b'); b.textContent = title; f.appendChild(b);
  if (hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = hint; f.appendChild(h); }
  return f;
}
/* ---------- กำลังโหลด / โหลดไม่สำเร็จ ----------
   หน้าที่ยังโหลดไม่เสร็จเคยเป็น "จอว่าง" เฉย ๆ — บนมือถือในออฟฟิศใช้เวลา 0.5-2 วิ
   พนักงานที่ไม่คุ้นคอมพิวเตอร์จะอ่านว่า "ระบบพัง" แล้วกดซ้ำหรือปิดทิ้ง
   จึงต้องมีโครงร่างเทา ๆ ขยับเบา ๆ บอกว่า "กำลังมา" ทุกที่ */

/** แถวโครงร่างในตาราง · cols = จำนวนคอลัมน์ · n = จำนวนแถว */
function skelRows(cols, n = 4) {
  const f = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.className = 'skelrow';
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td');
      const b = document.createElement('span'); b.className = 'skel';
      if (c === 0) b.style.width = '46px';
      td.appendChild(b); tr.appendChild(td);
    }
    f.appendChild(tr);
  }
  return f;
}

/** การ์ดโครงร่างสำหรับรายการที่ไม่ใช่ตาราง */
function skelCards(n = 3, tall = false) {
  const f = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'skelcard' + (tall ? ' tall' : '');
    d.innerHTML = '<span class="skel w40"></span><span class="skel w70"></span>';
    f.appendChild(d);
  }
  return f;
}

/** กล่องแจ้งว่าโหลดไม่สำเร็จ พร้อมปุ่มลองใหม่ — ดีกว่าปล่อยหน้าว่างแล้วเด้ง toast ที่หายไปใน 4 วิ */
function errorBox(msg, onRetry) {
  const d = document.createElement('div');
  d.className = 'empty box';
  d.setAttribute('role', 'alert');
  d.appendChild(emptyBody('📡', 'โหลดข้อมูลไม่สำเร็จ', msg || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
  if (onRetry) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary'; b.textContent = 'ลองใหม่';
    b.onclick = onRetry;
    d.appendChild(b);
  }
  return d;
}

/** กล่อง "ไม่มีข้อมูล" แบบเดี่ยว สำหรับที่ที่ไม่ใช่ตาราง */
function emptyBox(icon, title, hint) {
  const d = document.createElement('div');
  d.className = 'empty box';
  d.appendChild(emptyBody(icon, title, hint));
  return d;
}
function emptyRow(cols, title, hint, icon) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = cols; td.className = 'empty';
  td.appendChild(emptyBody(icon === undefined ? '📭' : icon, title, hint));
  tr.appendChild(td); return tr;
}

/* ============================================================
   ชั้นตัวควบคุมของเราเอง — แทนที่ของเบราว์เซอร์ทุกตัวโดยอัตโนมัติ
   หลักการเดียวกันทุกตัว: ซ่อน element ตัวจริงไว้ (ยังอยู่ในหน้า เป็นแหล่งค่าเดียว)
   แล้ววาดตัวแทนของเราคุมมัน · อ่าน .value / ผูก onchange จากโค้ดหน้าได้เหมือนเดิมทุกอย่าง
   ============================================================ */
const TH_MONTH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const TH_MON_SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const TH_DOW = ['อา','จ','อ','พ','พฤ','ศ','ส'];
const beYear = (y) => y + 543;   // ปีพุทธศักราช — พนักงานอ่านปี ค.ศ. แล้วสะดุดทุกครั้ง

// ปิดตัวที่เปิดอยู่ทั้งหมดก่อนเปิดตัวใหม่ · คลิกที่อื่นหรือกด Esc ก็ปิด
let openPop = null;
function closePop() { if (openPop) { openPop(); openPop = null; } }
document.addEventListener('click', (e) => {
  if (openPop && !e.target.closest('.csel, .dpick')) closePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { closePop(); } }, true);

/**
 * ให้กล่องหุ้มกว้างเท่าที่หน้าเดิมตั้งใจให้ช่องกรอกกว้าง
 * ต้องวัด "ก่อน" ย้าย element เข้ากล่อง ไม่งั้นได้ค่าหลังย้ายซึ่งเปลี่ยนไปแล้ว
 * ถ้าไม่ทำ ช่องค้นหาที่หน้าจำกัดไว้ 300px จะมีปุ่มล้างไปโผล่สุดขอบขวาของแถว
 */
function measureBox(el) {
  const cs = getComputedStyle(el);
  const w = el.getBoundingClientRect().width;
  const pw = el.parentNode ? el.parentNode.getBoundingClientRect().width : w;
  return { maxWidth: cs.maxWidth !== 'none' ? cs.maxWidth : '', narrow: w > 0 && w < pw - 2 };
}
function applyBox(wrap, box) {
  if (box.maxWidth) wrap.style.maxWidth = box.maxWidth;
  if (box.narrow) { wrap.style.display = 'inline-block'; wrap.style.width = 'auto'; }
}

/** วางกล่องลอยไม่ให้ตกขอบล่างจอ */
function placePop(anchor, pop) {
  pop.classList.remove('up', 'right');
  const r = anchor.getBoundingClientRect();
  if (r.bottom + pop.offsetHeight + 12 > innerHeight && r.top > pop.offsetHeight + 12) pop.classList.add('up');
  if (r.left + pop.offsetWidth > innerWidth - 8) pop.classList.add('right');
}

/* ---------- ดรอปดาวน์ ---------- */
function makeSelect(sel) {
  const box = measureBox(sel);
  const wrap = document.createElement('div');
  wrap.className = 'csel';
  sel.parentNode.insertBefore(wrap, sel);
  applyBox(wrap, box);
  wrap.appendChild(sel);
  sel.classList.add('nativehide');

  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'csel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  btn.innerHTML = '<span class="lbl"></span><span class="car" aria-hidden="true"></span>';
  btn.disabled = sel.disabled;
  wrap.appendChild(btn);

  const pop = document.createElement('div');
  pop.className = 'csel-pop'; pop.hidden = true; pop.setAttribute('role', 'listbox');
  wrap.appendChild(pop);

  const paint = () => {
    const o = sel.selectedOptions[0];
    const lbl = $('.lbl', btn);
    lbl.textContent = o ? o.textContent : '';
    // ตัวเลือกแรกที่ค่าว่าง = ข้อความชวนให้เลือก แสดงเป็นสีจาง
    lbl.classList.toggle('ph', !!o && o.value === '');
    btn.disabled = sel.disabled;
  };

  const build = () => {
    pop.innerHTML = '';
    [...sel.options].forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'csel-opt';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === sel.selectedIndex));
      b.disabled = o.disabled;
      b.innerHTML = '<span class="tick" aria-hidden="true">✓</span><span></span>';
      b.lastElementChild.textContent = o.textContent;
      b.onclick = () => {
        if (o.disabled) return;
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        paint(); close();
      };
      pop.appendChild(b);
    });
  };

  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); openPop = null; };
  const open = () => {
    closePop(); build(); pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    placePop(wrap, pop);
    const cur = pop.children[sel.selectedIndex]; if (cur) cur.classList.add('cur');
    openPop = close;
  };
  btn.onclick = (e) => { e.stopPropagation(); pop.hidden ? open() : close(); };
  btn.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (pop.hidden) open(); }
  };
  pop.onkeydown = (e) => {
    const items = [...pop.querySelectorAll('.csel-opt:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
  };
  // โค้ดหน้าอาจเซ็ต .value เองแล้วยิง change — ป้ายต้องตามด้วย
  sel.addEventListener('change', paint);
  paint();
}

/* ---------- ปฏิทิน / ตัวเลือกเดือน ---------- */
function makeDate(inp) {
  const monthOnly = inp.type === 'month';
  const box = measureBox(inp);
  const wrap = document.createElement('div');
  wrap.className = 'dpick';
  inp.parentNode.insertBefore(wrap, inp);
  applyBox(wrap, box);
  wrap.appendChild(inp);
  inp.classList.add('nativehide');

  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'dpick-btn';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="ic" aria-hidden="true">📅</span><span class="lbl"></span>';
  wrap.appendChild(btn);

  const clr = document.createElement('button');
  clr.type = 'button'; clr.className = 'dpick-clear'; clr.textContent = '×';
  clr.setAttribute('aria-label', 'ล้างวันที่');
  clr.onclick = (e) => { e.stopPropagation(); inp.value = ''; fire(); paint(); };
  btn.appendChild(clr);

  const pop = document.createElement('div');
  pop.className = 'cal'; pop.hidden = true;
  wrap.appendChild(pop);

  const fire = () => inp.dispatchEvent(new Event('change', { bubbles: true }));
  const parse = () => {
    const v = inp.value;
    if (monthOnly) { const m = v.match(/^(\d{4})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, 1) : null; }
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return monthOnly ? `${d.getFullYear()}-${p(d.getMonth() + 1)}`
                     : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const paint = () => {
    const d = parse();
    const lbl = $('.lbl', btn);
    lbl.textContent = d
      ? (monthOnly ? `${TH_MONTH[d.getMonth()]} ${beYear(d.getFullYear())}`
                   : `${d.getDate()} ${TH_MON_SHORT[d.getMonth()]} ${beYear(d.getFullYear())}`)
      : (inp.dataset.ph || (monthOnly ? 'เลือกเดือน' : 'เลือกวันที่'));
    lbl.classList.toggle('ph', !d);
    clr.hidden = !inp.value;
  };

  let view = parse() || new Date();
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); openPop = null; };

  function render() {
    pop.innerHTML = '';
    const head = document.createElement('div'); head.className = 'cal-head';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'cal-nav';
    prev.textContent = '‹'; prev.setAttribute('aria-label', monthOnly ? 'ปีก่อนหน้า' : 'เดือนก่อนหน้า');
    const title = document.createElement('div'); title.className = 't';
    const next = document.createElement('button'); next.type = 'button'; next.className = 'cal-nav';
    next.textContent = '›'; next.setAttribute('aria-label', monthOnly ? 'ปีถัดไป' : 'เดือนถัดไป');
    head.append(prev, title, next);
    pop.appendChild(head);

    const sel = parse();
    const today = new Date();

    if (monthOnly) {
      title.textContent = 'พ.ศ. ' + beYear(view.getFullYear());
      prev.onclick = (e) => { e.stopPropagation(); view = new Date(view.getFullYear() - 1, 0, 1); render(); };
      next.onclick = (e) => { e.stopPropagation(); view = new Date(view.getFullYear() + 1, 0, 1); render(); };
      const g = document.createElement('div'); g.className = 'cal-months';
      TH_MON_SHORT.forEach((mn, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = mn;
        if (sel && sel.getFullYear() === view.getFullYear() && sel.getMonth() === i) b.classList.add('sel');
        b.onclick = (e) => { e.stopPropagation(); inp.value = iso(new Date(view.getFullYear(), i, 1)); fire(); paint(); close(); };
        g.appendChild(b);
      });
      pop.appendChild(g);
    } else {
      title.textContent = `${TH_MONTH[view.getMonth()]} ${beYear(view.getFullYear())}`;
      prev.onclick = (e) => { e.stopPropagation(); view = new Date(view.getFullYear(), view.getMonth() - 1, 1); render(); };
      next.onclick = (e) => { e.stopPropagation(); view = new Date(view.getFullYear(), view.getMonth() + 1, 1); render(); };

      const dow = document.createElement('div'); dow.className = 'cal-dow';
      for (const d of TH_DOW) { const s = document.createElement('span'); s.textContent = d; dow.appendChild(s); }
      pop.appendChild(dow);

      const g = document.createElement('div'); g.className = 'cal-grid';
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const start = new Date(first); start.setDate(1 - first.getDay());
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const b = document.createElement('button'); b.type = 'button'; b.textContent = d.getDate();
        if (d.getMonth() !== view.getMonth()) b.classList.add('out');
        if (d.toDateString() === today.toDateString()) b.classList.add('today');
        if (sel && d.toDateString() === sel.toDateString()) b.classList.add('sel');
        b.onclick = (e) => { e.stopPropagation(); inp.value = iso(d); fire(); paint(); close(); };
        g.appendChild(b);
      }
      pop.appendChild(g);

      const foot = document.createElement('div'); foot.className = 'cal-foot';
      const tb = document.createElement('button'); tb.type = 'button'; tb.textContent = 'วันนี้';
      tb.onclick = (e) => { e.stopPropagation(); inp.value = iso(today); fire(); paint(); close(); };
      const cb = document.createElement('button'); cb.type = 'button'; cb.textContent = 'ล้าง';
      cb.onclick = (e) => { e.stopPropagation(); inp.value = ''; fire(); paint(); close(); };
      foot.append(tb, cb); pop.appendChild(foot);
    }
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    if (!pop.hidden) return close();
    closePop(); view = parse() || new Date(); render();
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    placePop(wrap, pop); openPop = close;
  };
  inp.addEventListener('change', paint);
  paint();
}

/* ---------- ช่องค้นหา: ปุ่มล้างของเราเอง ---------- */
function makeSearch(inp) {
  const box = measureBox(inp);
  const wrap = document.createElement('span');
  wrap.className = 'srch';
  inp.parentNode.insertBefore(wrap, inp);
  applyBox(wrap, box);
  wrap.appendChild(inp);
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'srch-x'; x.textContent = '×';
  x.setAttribute('aria-label', 'ล้างคำค้น');
  x.hidden = !inp.value;
  x.onclick = () => {
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    x.hidden = true; inp.focus();
  };
  inp.addEventListener('input', () => { x.hidden = !inp.value; });
  wrap.appendChild(x);
}

/* ---------- ช่องตัวเลข: ปุ่ม − + ของเราเอง (เฉพาะที่ขอผ่าน data-step) ---------- */
function makeStep(inp) {
  const wrap = document.createElement('span');
  wrap.className = 'nstep';
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);
  const mk = (txt, delta, lab) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', lab);
    b.onclick = () => {
      const min = inp.min === '' ? -Infinity : Number(inp.min);
      const max = inp.max === '' ? Infinity : Number(inp.max);
      const v = Math.min(max, Math.max(min, (Number(inp.value) || 0) + delta));
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return b;
  };
  wrap.prepend(mk('−', -1, 'ลดจำนวน'));
  wrap.appendChild(mk('+', 1, 'เพิ่มจำนวน'));
}

/**
 * อัปเกรดทุกตัวควบคุมในขอบเขตที่ให้มา
 * เรียกซ้ำได้ปลอดภัย — ตัวที่ทำแล้วมี data-enh กำกับไว้
 */
function enhance(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('select:not([data-enh])')) { el.dataset.enh = '1'; makeSelect(el); }
  for (const el of scope.querySelectorAll('input[type=date]:not([data-enh]), input[type=month]:not([data-enh])')) { el.dataset.enh = '1'; makeDate(el); }
  for (const el of scope.querySelectorAll('input[type=search]:not([data-enh])')) { el.dataset.enh = '1'; makeSearch(el); }
  for (const el of scope.querySelectorAll('input[data-step]:not([data-enh])')) { el.dataset.enh = '1'; makeStep(el); }
  for (const el of scope.querySelectorAll('input[type=checkbox]:not([data-enh])')) { el.dataset.enh = '1'; el.classList.add('chk'); }
  // title ของเบราว์เซอร์ขึ้นช้าและแต่งไม่ได้ — ย้ายมาเป็นคำอธิบายของเราเอง
  for (const el of scope.querySelectorAll('[title]:not([data-enh])')) {
    el.dataset.enh = '1'; el.dataset.tip = el.title;
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title);
    el.removeAttribute('title');
  }
}

// เนื้อหาส่วนใหญ่ถูกสร้างด้วย JS หลังโหลด (ตาราง กล่องซ้อน ฟอร์ม)
// เฝ้าดู DOM แล้วอัปเกรดให้เอง จะได้ไม่ต้องไล่เรียก enhance() ทุกจุดที่วาดใหม่
const enhObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches && n.matches('select, input[type=date], input[type=month], input[type=search], input[type=checkbox], [title]')) enhance(n.parentNode);
      else enhance(n);
    }
  }
});
document.addEventListener('DOMContentLoaded', () => {
  enhance(document);
  enhObserver.observe(document.body, { childList: true, subtree: true });
});

/* ---------- แถบหัว + กระดิ่ง ---------- */
let ME = null;
async function initTopbar(active) {
  ME = (await api('/api/auth/me')).user;

  const nav = $('#nav');
  if (nav) {
    const links = [
      { href:'app.html',     t:'หน้าหลัก',        show: () => true },
      { href:'request.html', t:'ใบเบิกของฉัน',    show: () => true },
      { href:'issue.html',   t:'อนุมัติและจ่ายของ', show: () => ME.role === 'warehouse' || ME.role === 'admin' },
      { href:'stock.html',   t:'สินค้าและสต็อก',  show: () => ME.role === 'warehouse' || ME.role === 'admin' },
      { href:'assets.html',  t:'ครุภัณฑ์',        show: () => ME.role === 'warehouse' || ME.role === 'admin' },
      { href:'report.html',  t:'รายงาน',          show: () => ME.role === 'warehouse' || ME.role === 'admin' },
      { href:'admin.html',   t:'ผู้ใช้',          show: () => ME.role === 'admin' },
    ];
    nav.innerHTML = '';
    for (const l of links) {
      if (!l.show()) continue;
      const a = document.createElement('a');
      a.href = l.href; a.textContent = l.t;
      if (l.href === active) a.className = 'on';
      nav.appendChild(a);
    }
    // ปุ่มคู่มือ — พนักงาน 309 คนส่วนใหญ่ใช้ระบบนี้เดือนละครั้งสองครั้ง
    // ต้องกดหาวิธีใช้ได้จากทุกหน้า ไม่ใช่ต้องย้อนกลับไปหน้าแรกก่อน
    const help = document.createElement('a');
    // ผู้ดูแลคลังกดแล้วเจอคู่มือของตัวเอง (รับเข้า · จ่ายของ · รับคืน) ไม่ใช่คู่มือสอนพนักงานเบิกของ
    help.href = ME.role === 'warehouse' ? 'guide-warehouse.html' : 'guide.html';
    help.className = 'help keep';
    help.title = 'วิธีใช้ระบบ';
    help.setAttribute('aria-label', 'วิธีใช้ระบบ');
    help.textContent = '❓';
    nav.appendChild(help);

    const sep = document.createElement('span');
    sep.className = 'sep';
    nav.appendChild(sep);

    const bell = document.createElement('button');
    bell.id = 'bell'; bell.className = 'bell'; bell.title = 'การแจ้งเตือน';
    bell.innerHTML = '🔔<span class="dot" id="bellDot" hidden></span>';
    bell.onclick = openBell;
    nav.appendChild(bell);

    const me = document.createElement('span');
    me.className = 'me';
    me.innerHTML = '<b></b><span class="r"></span>';
    const roleTxt = ROLE_LABEL[ME.role] || ME.role;
    $('b', me).textContent = ME.name;
    // บัญชีอย่าง ADMIN001 ตั้งชื่อไว้ว่า "ผู้ดูแลระบบ" ตรงกับชื่อบทบาทพอดี
    // ปล่อยไว้จะได้ "ผู้ดูแลระบบ ผู้ดูแลระบบ" อ่านเหมือนระบบพัง
    $('.r', me).textContent = roleTxt === ME.name ? '' : roleTxt;
    nav.appendChild(me);

    const pw = document.createElement('button');
    pw.className = 'out';
    pw.textContent = 'เปลี่ยนรหัสผ่าน';
    pw.onclick = () => openChangePassword(false);
    nav.appendChild(pw);

    const out = document.createElement('button');
    out.className = 'out';
    out.textContent = 'ออกจากระบบ';
    out.onclick = () => { localStorage.clear(); location.replace('login.html'); };
    nav.appendChild(out);
  }
  buildTabbar(active);
  // พนักงานที่ย้ายรหัสผ่านมาจากระบบเดิมต้องตั้งรหัสใหม่ก่อนใช้งาน
  // (เซิร์ฟเวอร์กั้นไว้อีกชั้นแล้ว กล่องนี้แค่ทำให้ผู้ใช้รู้ว่าต้องทำอะไร)
  if (ME.mustChangePassword) openChangePassword(true);
  refreshBell();
  // เช็คแจ้งเตือนใหม่ทุก 60 วิ — ถี่พอสำหรับงานคลัง แต่ไม่กวนเซิร์ฟเวอร์
  setInterval(refreshBell, 60000);
  return ME;
}

/** กล่องเปลี่ยนรหัสผ่าน · force = เปิดแบบบังคับ (ปิดไม่ได้จนกว่าจะตั้งรหัสใหม่สำเร็จ) */
function openChangePassword(force) {
  const box = form(
    (force
      ? '<p class="hint" style="margin:0 0 14px">ระบบนี้เปิดให้เข้าใช้จากนอกออฟฟิศได้ ' +
        'รหัสผ่านชุดเดิมที่ย้ายมาจากระบบใบสำคัญจ่ายจึงต้องเปลี่ยนก่อนเริ่มใช้งาน</p>'
      : '') +
    '<label class="fld"><span>รหัสผ่านเดิม</span><input type="password" id="pwCur" autocomplete="current-password"></label>' +
    '<label class="fld"><span>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</span><input type="password" id="pwNew" autocomplete="new-password"></label>' +
    '<label class="fld"><span>พิมพ์รหัสผ่านใหม่อีกครั้ง</span><input type="password" id="pwNew2" autocomplete="new-password"></label>');

  const save = async () => {
    const cur = $('#pwCur', box).value, a = $('#pwNew', box).value, b = $('#pwNew2', box).value;
    if (a.length < 8) return showErr(box, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (a !== b) return showErr(box, 'รหัสผ่านใหม่สองช่องไม่ตรงกัน');
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current: cur, next: a }) });
      closeModal();
      toast('เปลี่ยนรหัสผ่านแล้ว', 'ok');
      // โหลดหน้าใหม่เพื่อให้ข้อมูลที่ถูกกั้นไว้ตอนยังไม่เปลี่ยนรหัสถูกดึงมาครบ
      if (force) setTimeout(() => location.reload(), 600);
    } catch (e) { showErr(box, e.message); }
  };

  const buttons = force ? [{ label: 'ตั้งรหัสผ่านใหม่', primary: true, onClick: save }]
                        : [{ label: 'ยกเลิก', onClick: closeModal }, { label: 'บันทึก', primary: true, onClick: save }];
  openModal(force ? 'ตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งาน' : 'เปลี่ยนรหัสผ่าน', box, buttons, { sticky: true });
  // แบบบังคับ: ซ่อนปุ่มกากบาท ไม่ให้ปิดหนีไปใช้งานต่อโดยไม่เปลี่ยนรหัส
  if (force) { const x = $('#mClose'); if (x) x.hidden = true; }
}

async function refreshBell() {
  try {
    const d = await api('/api/notifications');
    window.__noti = d.notifications;
    const dot = $('#bellDot');
    if (dot) { dot.hidden = d.unread === 0; dot.textContent = d.unread > 9 ? '9+' : String(d.unread); }
  } catch { /* กระดิ่งล้มเหลวต้องไม่ทำให้หน้าพัง */ }
}

function openBell() {
  const list = window.__noti || [];
  const box = document.createElement('div');
  if (!list.length) {
    box.appendChild(emptyBox('🔔', 'ยังไม่มีการแจ้งเตือน',
      'ระบบจะเตือนที่นี่เมื่อมีใบเบิกถึงคิวคุณ หรือของที่ยืมใกล้ครบกำหนดคืน'));
  }
  for (const n of list) {
    const a = document.createElement(n.link ? 'a' : 'div');
    a.className = 'noti' + (n.read ? '' : ' new');
    if (n.link) { a.href = n.link; }
    const t = document.createElement('b'); t.textContent = n.title;
    const b = document.createElement('span'); b.className = 'body'; b.textContent = n.body || '';
    const w = document.createElement('time'); w.textContent = dt(n.at);
    a.append(t, b, w);
    box.appendChild(a);
  }
  openModal('การแจ้งเตือน', box, [{ label:'ปิด', onClick: closeModal }]);
  api('/api/notifications/read', { method:'POST' }).then(refreshBell).catch(() => {});
}

/** โครงแถบหัวมาตรฐาน — เรียกก่อน initTopbar */
function topbarHTML(subtitle) {
  return `<a class="brand" href="app.html">
      <span class="brandmark"><img src="logo.svg" alt=""></span>
      <span class="brand-text"><span class="co">โตโยต้า กาญจนบุรี</span><br>
      <span class="sys">${subtitle || 'ระบบเบิกอุปกรณ์'}</span></span></a>
    <nav class="nav" id="nav"></nav>`;
}

/* ============================================================
   แถบนำทางล่างจอสำหรับมือถือ
   จำกัดไม่เกิน 5 ช่อง — เกินกว่านั้นนิ้วกดพลาดง่าย ที่เหลือยุบเป็น "เพิ่มเติม"
   ============================================================ */
function buildTabbar(active) {
  const all = [
    { href:'app.html',     ic:'🏠', lb:'หน้าหลัก',  all:true },
    { href:'request.html', ic:'📋', lb:'ใบเบิกของฉัน', all:true },
    { href:'issue.html',   ic:'✅', lb:'จ่ายของ',   wh:true, badge:'queue' },
    { href:'stock.html',   ic:'🏷️', lb:'สต็อก',     wh:true },
    { href:'assets.html',  ic:'🔧', lb:'ครุภัณฑ์',  wh:true },
    { href:'report.html',  ic:'📊', lb:'รายงาน',    wh:true },
    { href:'admin.html',   ic:'👥', lb:'ผู้ใช้',     admin:true },
  ];
  const wh = ME.role === 'warehouse' || ME.role === 'admin';
  let items = all.filter((t) => t.all || (t.wh && wh) || (t.admin && ME.role === 'admin'));

  const bar = document.createElement('nav');
  bar.className = 'tabbar';
  bar.setAttribute('aria-label', 'เมนูหลัก');

  // จอแท็บเล็ตกว้างพอจะวางครบ 7 ช่องโดยยังกดไม่พลาด (ช่องละ ~110px ขึ้นไป)
  // มือถือ 360px วางได้จริงแค่ 4 + "เพิ่มเติม" ไม่งั้นช่องละ 72px นิ้วโป้งกดพลาดข้ามช่อง
  const SLOTS = window.innerWidth >= 700 ? 7 : 5;
  let overflow = [];
  if (items.length > SLOTS) { overflow = items.slice(SLOTS - 1); items = items.slice(0, SLOTS - 1); }

  for (const t of items) {
    const a = document.createElement('a');
    a.href = t.href;
    if (t.href === active) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
    a.innerHTML = '<span class="ic"></span><span class="lb"></span>';
    $('.ic', a).textContent = t.ic;
    $('.lb', a).textContent = t.lb;
    if (t.badge === 'queue') {
      const n = document.createElement('span');
      n.className = 'n'; n.id = 'tabQueue'; n.hidden = true;
      a.appendChild(n);
    }
    bar.appendChild(a);
  }
  if (overflow.length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="ic">⋯</span><span class="lb">เพิ่มเติม</span>';
    b.onclick = () => {
      const box = document.createElement('div');
      box.className = 'morelist';
      for (const t of overflow) {
        const a = document.createElement('a');
        a.className = 'moreitem'; a.href = t.href;
        a.innerHTML = '<span class="ic"></span><span></span>';
        $('.ic', a).textContent = t.ic;
        a.lastElementChild.textContent = t.lb;
        box.appendChild(a);
      }
      openModal('เมนูเพิ่มเติม', box, [{ label:'ปิด', onClick: closeModal }]);
    };
    bar.appendChild(b);
  }
  document.body.appendChild(bar);

  // ตัวนับใบรอจ่ายบนแถบล่าง — ผู้ดูแลคลังต้องเห็นว่ามีคนรออยู่โดยไม่ต้องเปิดหน้า
  if (wh) {
    const paint = () => api('/api/requisitions?box=queue')
      .then((d) => { const n = $('#tabQueue'); if (n) { n.hidden = !d.queueCount; n.textContent = d.queueCount; } })
      .catch(() => {});
    paint(); setInterval(paint, 60000);
  }
}
