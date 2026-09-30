/* ============================================================
   ชุดไอคอน SVG ของระบบ — แทนอิโมจิทั้งหมด

   ทำไมต้องเลิกใช้อิโมจิ:
   - หน้าตาต่างกันทุกเครื่อง (Windows / iPhone / Android วาดไม่เหมือนกันเลย)
     ของชิ้นเดียวกันในหน้าเดียวกันจึงดูไม่เป็นชุดเดียวกัน
   - เปลี่ยนสีตามสถานะไม่ได้ · ขนาดจริงไม่ตรงกับที่สั่ง · แต่ละตัวมีขอบในตัวไม่เท่ากัน
     ทำให้ไอคอนในแถวเดียวกันดูลอยสูงต่ำไม่เสมอ
   - โปรแกรมอ่านหน้าจอจะอ่านชื่ออิโมจิออกมาดัง ๆ ("ป้ายกำกับ" "แพ็กเกจ")
     ปนกับข้อความจริงจนฟังไม่รู้เรื่อง

   วิธีใช้:
     icon('search')              → <svg> ที่เอาไป append ได้เลย
     iconHTML('bell', 'big')     → สตริง สำหรับที่ที่ต้องต่อ innerHTML

   ทุกตัววาดบนตาราง 24×24 · เส้นหนา 1.75 · สีตาม currentColor ของตัวแม่
   จึงสั่งสี/ขนาดด้วย CSS ได้เหมือนตัวอักษร

   sprite ฝังในหน้าครั้งเดียว แล้วทุกจุดอ้างด้วย <use> — ไม่มีคำขอเน็ตเพิ่ม
   และไม่ต้องส่ง path ซ้ำทุกที่ที่ใช้
   ============================================================ */
const ICON_PATHS = {
  /* ---- เมนูหลัก ---- */
  home:      '<path d="M3.2 10.6 12 3.4l8.8 7.2"/><path d="M5.4 9.6v10a1.4 1.4 0 0 0 1.4 1.4h10.4a1.4 1.4 0 0 0 1.4-1.4v-10"/><path d="M9.6 21V15h4.8v6"/>',
  clipboard: '<rect x="5.2" y="5" width="13.6" height="16" rx="2.4"/><rect x="9" y="2.9" width="6" height="4.2" rx="1.3"/><path d="M8.8 12h6.4M8.8 15.8h6.4M8.8 19.6h3.6" opacity=".75"/>',
  checkcirc: '<circle cx="12" cy="12" r="8.8"/><path d="m8.1 12.3 2.8 2.8 5.2-5.4"/>',
  tag:       '<path d="M3.6 10.9V4.6a1.1 1.1 0 0 1 1.1-1.1H11a2 2 0 0 1 1.4.6l7.7 7.7a2 2 0 0 1 0 2.8l-5.3 5.3a2 2 0 0 1-2.8 0L4.2 12.3a2 2 0 0 1-.6-1.4Z"/><circle cx="7.8" cy="7.7" r="1.4"/>',
  wrench:    '<path d="M14.9 6.4a1.1 1.1 0 0 0 0 1.5l1.5 1.5a1.1 1.1 0 0 0 1.5 0l3.4-3.4a6 6 0 0 1-7.9 7.9l-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6a6 6 0 0 1 7.9-7.9Z"/>',
  chart:     '<path d="M3.6 20.6h16.8"/><rect x="5.4" y="11.2" width="3.5" height="6.6" rx="1.1"/><rect x="10.2" y="6.8" width="3.5" height="11" rx="1.1"/><rect x="15" y="13.6" width="3.5" height="4.2" rx="1.1"/>',
  users:     '<circle cx="9.6" cy="7.8" r="3.5"/><path d="M3.4 20.4v-1.5a4.2 4.2 0 0 1 4.2-4.2h4a4.2 4.2 0 0 1 4.2 4.2v1.5"/><path d="M16.2 4.6a3.5 3.5 0 0 1 0 6.4"/><path d="M17.6 14.9a4.2 4.2 0 0 1 3 4v1.5"/>',
  more:      '<circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none"/>',

  /* ---- การทำงาน ---- */
  newdoc:    '<path d="M14.2 3.4H7.6a2.2 2.2 0 0 0-2.2 2.2v12.8a2.2 2.2 0 0 0 2.2 2.2h8.8a2.2 2.2 0 0 0 2.2-2.2V7.8Z"/><path d="M14.2 3.4v4.4h4.4"/><path d="M12 11.6v5.2M9.4 14.2h5.2"/>',
  search:    '<circle cx="10.9" cy="10.9" r="6.6"/><path d="m15.8 15.8 4.6 4.6"/>',
  package:   '<path d="M20.6 15.7V8.3a1.9 1.9 0 0 0-1-1.7l-6.7-3.7a1.9 1.9 0 0 0-1.8 0L4.4 6.6a1.9 1.9 0 0 0-1 1.7v7.4a1.9 1.9 0 0 0 1 1.7l6.7 3.7a1.9 1.9 0 0 0 1.8 0l6.7-3.7a1.9 1.9 0 0 0 1-1.7Z"/><path d="m3.7 7.3 8.3 4.7 8.3-4.7M12 21v-9"/>',
  store:     '<path d="M4.2 9.6h15.6v9.8a1.6 1.6 0 0 1-1.6 1.6H5.8a1.6 1.6 0 0 1-1.6-1.6Z"/><path d="M2.9 9.6 5.2 4.4a1.6 1.6 0 0 1 1.5-1h10.6a1.6 1.6 0 0 1 1.5 1l2.3 5.2"/><path d="M9.4 21v-5.6h5.2V21"/>',
  bell:      '<path d="M18 8.9a6 6 0 1 0-12 0c0 5.6-2.3 6.6-2.3 6.6h16.6S18 14.5 18 8.9"/><path d="M13.7 19.4a2 2 0 0 1-3.4 0"/>',
  help:      '<circle cx="12" cy="12" r="8.8"/><path d="M9.6 9.7a2.5 2.5 0 1 1 4.2 1.9c-.9.7-1.8 1.2-1.8 2.5"/><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none"/>',
  calendar:  '<rect x="3.6" y="5.4" width="16.8" height="15.2" rx="2.4"/><path d="M8.4 3v4.4M15.6 3v4.4M3.6 10.6h16.8"/>',
  download:  '<path d="M12 3.6v10.8"/><path d="m7.6 10.4 4.4 4.4 4.4-4.4"/><path d="M4 17.8v1.2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.2"/>',
  trash:     '<path d="M4.4 7.1h15.2"/><path d="M9.4 7.1V5.3a1.3 1.3 0 0 1 1.3-1.3h2.6a1.3 1.3 0 0 1 1.3 1.3v1.8"/><path d="M6.4 7.1l.9 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.9-12"/><path d="M10.4 11v6.2M13.6 11v6.2" opacity=".75"/>',
  megaphone: '<path d="M20.6 5.4v13.2l-12.4-4.1V9.5Z"/><path d="M8.2 9.5H5.4a1.8 1.8 0 0 0-1.8 1.8v1.4a1.8 1.8 0 0 0 1.8 1.8h2.8"/><path d="m8.8 14.6 1.1 6.4"/>',
  warn:      '<path d="M10.3 4.2 3 17a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.4v4.2"/><circle cx="12" cy="16.9" r="1" fill="currentColor" stroke="none"/>',
  xcirc:     '<circle cx="12" cy="12" r="8.8"/><path d="m14.9 9.1-5.8 5.8M9.1 9.1l5.8 5.8"/>',
  down:      '<path d="M3.6 7.6 10 14l3.6-3.6 6.8 6.8"/><path d="M20.4 12.6v4.6h-4.6"/>',
  coffee:    '<path d="M4.4 8.2h11.2v6.6a4.2 4.2 0 0 1-4.2 4.2H8.6a4.2 4.2 0 0 1-4.2-4.2Z"/><path d="M15.6 9.8h1.7a2.8 2.8 0 0 1 0 5.6h-1.7"/><path d="M3.4 21.4h13.2"/>',
  inbox:     '<path d="M20.4 12.6v6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2v-6"/><path d="M3.6 12.6 6.1 5.9a2 2 0 0 1 1.9-1.3h8a2 2 0 0 1 1.9 1.3l2.5 6.7"/><path d="M3.6 12.6h4.2l1.2 2.4h6l1.2-2.4h4.2"/>',
  offline:   '<path d="m2.8 2.8 18.4 18.4"/><path d="M9.3 15.3a4 4 0 0 1 5.4 0"/><path d="M6.2 11.8a8.6 8.6 0 0 1 2.9-1.9"/><path d="M17.8 11.8a8.6 8.6 0 0 0-2.4-1.7"/><path d="M3.2 8.2a13 13 0 0 1 4-2.6"/><path d="M20.8 8.2a13 13 0 0 0-9.3-3.4"/><circle cx="12" cy="18.8" r="1" fill="currentColor" stroke="none"/>',
  clock:     '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.4V12l3.4 2"/>',
  pencil:    '<path d="M16.6 3.9a2.2 2.2 0 0 1 3.1 3.1L8.4 18.3l-4.3 1.2 1.2-4.3Z"/><path d="m14.6 5.9 3.1 3.1" opacity=".75"/>',
  chevron:   '<path d="m9.6 5.6 6.6 6.4-6.6 6.4"/>',
  book:      '<path d="M12 7.4A4.2 4.2 0 0 0 7.8 4.4H3.4v13h4.4a4.2 4.2 0 0 1 4.2 3 4.2 4.2 0 0 1 4.2-3h4.4v-13h-4.4A4.2 4.2 0 0 0 12 7.4Z"/><path d="M12 7.4v13" opacity=".75"/>',
  check:     '<path d="m5.2 12.6 4.6 4.6L18.8 7.4"/>',
  folder:    '<path d="M3.6 8.2v10.2a2 2 0 0 0 2 2h12.8a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-6.2L10.2 5.5H5.6a2 2 0 0 0-2 2Z"/>',
  printer:   '<path d="M7 8.6V4.4h10v4.2"/><path d="M7 17.6H5.6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H17"/><rect x="7" y="14.4" width="10" height="6.2" rx="1.2"/>',
  bulb:      '<path d="M9.2 17.4a6 6 0 1 1 5.6 0v1.8a1.6 1.6 0 0 1-1.6 1.6h-2.4a1.6 1.6 0 0 1-1.6-1.6Z"/><path d="M9.6 14.4h4.8" opacity=".75"/>',
  camera:    '<path d="M3.6 9.8a2 2 0 0 1 2-2h1.8l1.3-2.2h6.6l1.3 2.2h1.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13.4" r="3.4"/>',
  car:       '<path d="M4 15.4h16v3a1.2 1.2 0 0 1-1.2 1.2h-1.4a1.2 1.2 0 0 1-1.2-1.2v-.6H7.8v.6a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 18.4Z"/><path d="m5.6 15.4 1.9-5.6a2 2 0 0 1 1.9-1.4h5.2a2 2 0 0 1 1.9 1.4l1.9 5.6"/><circle cx="7.8" cy="12.6" r="1" fill="currentColor" stroke="none"/><circle cx="16.2" cy="12.6" r="1" fill="currentColor" stroke="none"/>',
  laptop:    '<rect x="4.6" y="5" width="14.8" height="10.2" rx="1.8"/><path d="M2.6 18.4h18.8"/>',
  money:     '<rect x="3.4" y="6.6" width="17.2" height="11.4" rx="2.2"/><circle cx="12" cy="12.3" r="2.8"/><path d="M6.6 12.3h.6M16.8 12.3h.6"/>',
  stop:      '<path d="M8.6 3.4h6.8L20.6 8.6v6.8L15.4 20.6H8.6L3.4 15.4V8.6Z"/><path d="M12 8.4v4.2"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/>',
  ban:       '<circle cx="12" cy="12" r="8.8"/><path d="m5.8 5.8 12.4 12.4"/>',
  history:   '<path d="M3.6 12a8.4 8.4 0 1 0 2.5-6"/><path d="M3.4 3.6v4.6h4.6"/><path d="M12 7.8V12l3.2 1.9"/>',
  menu:      '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus:      '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  minus:     '<path d="M5.2 12h13.6"/>',
};

/* สีและเส้นของไอคอน — ใส่ที่ <svg> ตัวที่เรียกใช้ทุกครั้ง (ดูเหตุผลใน icon()) */
const ICON_PAINT = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.75',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};
const ICON_PAINT_ATTR = Object.keys(ICON_PAINT)
  .map((k) => k + '="' + ICON_PAINT[k] + '"').join(' ');

/** ฝัง sprite ลงหน้าครั้งเดียว — เรียกซ้ำได้ ไม่มีผลข้างเคียง */
function ensureIconSprite() {
  if (document.getElementById('iconsprite')) return;
  let syms = '';
  for (const k of Object.keys(ICON_PATHS)) {
    syms += '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICON_PATHS[k] + '</symbol>';
  }
  const host = document.createElement('div');
  host.id = 'iconsprite';
  host.setAttribute('aria-hidden', 'true');
  // ซ่อนแบบไม่ใช้ display:none — Safari บางรุ่นไม่วาด <use> ที่ชี้ไป sprite ซึ่ง display:none
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  host.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + syms + '</svg>';
  (document.body || document.documentElement).appendChild(host);
}

/**
 * ไอคอนหนึ่งตัวเป็น element
 * @param {string} name  ชื่อจาก ICON_PATHS · ชื่อที่ไม่มีจะตกไปเป็น package
 * @param {string} [cls] คลาสเพิ่ม เช่น 'big'
 *
 * ไอคอนเป็นของตกแต่งเสมอ จึง aria-hidden ทุกตัว
 * ความหมายต้องมาจากข้อความข้าง ๆ หรือ aria-label ของปุ่มที่ครอบอยู่
 * (ไอคอนลอยเดี่ยวที่สื่อความหมายเอง = โปรแกรมอ่านหน้าจอไม่ได้อะไรเลย)
 */
function icon(name, cls) {
  ensureIconSprite();
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  // ต้องใส่ตรงนี้ ไม่ใช่ที่ sprite — <use> รับค่าสีจาก <svg> ตัวที่เรียก ไม่ใช่ตัวที่เก็บ symbol
  // ถ้าไม่ใส่ จะได้ค่าเริ่มต้นของ SVG คือ fill ดำ stroke ไม่มี → ไอคอนกลายเป็นก้อนทึบ
  for (const [k, v] of Object.entries(ICON_PAINT)) s.setAttribute(k, v);
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#i-' + (ICON_PATHS[name] ? name : 'package'));
  s.appendChild(u);
  return s;
}

/** แบบสตริง สำหรับจุดที่ต่อ innerHTML อยู่แล้ว */
function iconHTML(name, cls) {
  ensureIconSprite();
  const n = ICON_PATHS[name] ? name : 'package';
  return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false" ' +
         ICON_PAINT_ATTR + '><use href="#i-' + n + '"/></svg>';
}

if (document.body) ensureIconSprite();
else document.addEventListener('DOMContentLoaded', ensureIconSprite);
