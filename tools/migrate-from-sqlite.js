#!/usr/bin/env node
/**
 * ย้ายข้อมูลจากระบบในวง LAN (SQLite) ขึ้น Supabase (PostgreSQL)
 *
 * วิธีใช้:
 *   node tools/migrate-from-sqlite.js <path ของ equipment.db> [--out migrate.sql] [--keep-demo]
 *   จากนั้น:  supabase db query --linked -f migrate.sql
 *
 * สิ่งที่สคริปต์นี้ทำ:
 *   • อ่านฐาน SQLite แบบอ่านอย่างเดียว — ไม่แตะไฟล์ต้นทางเลย
 *   • แปลงทุกตารางเป็นคำสั่ง INSERT โดยคง id เดิมไว้ทั้งหมด
 *     (ประวัติสต็อก ใบเบิก และรายงานย้อนหลังจึงยังชี้ถึงกันได้เหมือนเดิม)
 *   • แปลงชนิดข้อมูลให้ตรงกับ Postgres: 0/1 → boolean · JSON string → jsonb · REAL → numeric
 *   • ติดธง "ต้องตั้งรหัสผ่านใหม่" ให้พนักงานทุกคนที่ย้ายมา (ยกเว้นแอดมิน ที่ต้องเข้าไปตั้งค่าให้คนอื่นได้ก่อน)
 *   • ตั้งตัวนับเลขที่ใบเบิก (ตาราง meta) ต่อจากของเดิม เลขจะได้ไม่ชนกัน
 *
 * ⚠️ ไฟล์ .sql ที่ได้มีชื่อพนักงานและแฮชรหัสผ่านจริง — ห้าม commit ขึ้น git เด็ดขาด
 *    (โฟลเดอร์ tools/out/ ถูกใส่ไว้ใน .gitignore แล้ว)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const outArg = args.indexOf('--out');
const out = outArg >= 0 ? args[outArg + 1] : path.join(__dirname, 'out', 'migrate.sql');
const keepDemo = args.includes('--keep-demo');

if (!src || !fs.existsSync(src)) {
  console.error('ใช้: node tools/migrate-from-sqlite.js <path ของ equipment.db> [--out migrate.sql] [--keep-demo]');
  process.exit(1);
}

const db = new Database(src, { readonly: true });
const q = (sql) => db.prepare(sql).all();
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

/* ---------- ตัวช่วยแปลงค่า ---------- */
const S = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const N = (v) => (v == null || v === '' ? 'null' : Number(v));
const B = (v) => (v == null ? 'null' : v ? 'true' : 'false');
const J = (v) => {           // audit_log.detail เดิมเก็บเป็นสตริง JSON · Postgres เป็น jsonb
  if (v == null || v === '') return 'null';
  try { JSON.parse(v); return `${S(v)}::jsonb`; } catch { return 'null'; }
};

const lines = [];
const say = (t) => lines.push(t);

say('-- ไฟล์นี้สร้างอัตโนมัติจาก tools/migrate-from-sqlite.js — มีข้อมูลจริง ห้ามขึ้น git');
say(`-- ต้นทาง: ${path.basename(src)} · สร้างเมื่อ ${new Date().toISOString()}`);
say('begin;');

if (!keepDemo) {
  say('');
  say('-- ล้างข้อมูลตัวอย่างทิ้งก่อน (ถ้าอยากเก็บไว้ด้วยให้ใส่ --keep-demo)');
  say(`truncate stock_movements, requisition_approvals, requisition_items, requisitions,
         notifications, audit_log, asset_tags, item_images, items, categories, department_budgets,
         users, departments, meta, login_attempts restart identity cascade;`);
}

/* ---------- แผนก (ใส่ก่อน แต่ยังไม่ผูกหัวหน้า เพราะ users ยังไม่มี) ---------- */
const departments = has('departments') ? q('SELECT * FROM departments') : [];
say('');
say(`-- แผนก ${departments.length} แผนก`);
for (const d of departments) {
  say(`insert into departments(id,name,approver_id,active,created_at,updated_at) values (${S(d.id)},${S(d.name)},null,${B(d.active)},${N(d.created_at)},${N(d.updated_at)}) on conflict (id) do nothing;`);
}

/* ---------- ผู้ใช้ ---------- */
const users = has('users') ? q('SELECT * FROM users') : [];
say('');
say(`-- ผู้ใช้ ${users.length} คน (คัดลอกแฮชรหัสผ่านมาด้วย เข้าระบบด้วยรหัสเดิมได้)`);
for (const u of users) {
  say(`insert into users(id,emp_id,password,name,dept_id,position,role,active,created_at,updated_at) values (${S(u.id)},${S(u.emp_id)},${S(u.password)},${S(u.name)},${S(u.dept_id)},${S(u.position || '')},${S(u.role)},${B(u.active)},${N(u.created_at)},${N(u.updated_at)}) on conflict (id) do nothing;`);
}
say('-- ผูกหัวหน้าแผนกหลังจากมีผู้ใช้ครบแล้ว');
for (const d of departments) {
  if (d.approver_id) say(`update departments set approver_id=${S(d.approver_id)} where id=${S(d.id)};`);
}

/* ---------- หมวดหมู่ · สินค้า · ครุภัณฑ์ ---------- */
const categories = has('categories') ? q('SELECT * FROM categories') : [];
say('');
say(`-- หมวดหมู่ ${categories.length} · สินค้า`);
for (const c of categories) {
  say(`insert into categories(id,name,sort,created_at,updated_at) values (${S(c.id)},${S(c.name)},${N(c.sort) || 0},${N(c.created_at)},${N(c.updated_at)}) on conflict (id) do nothing;`);
}
const items = has('items') ? q('SELECT * FROM items') : [];
for (const i of items) {
  // คอลัมน์ image ของเดิมเก็บ "ชื่อไฟล์บนดิสก์" ซึ่งบนคลาวด์ไม่มี — ตัวรูปต้องอัปโหลดใหม่ผ่านหน้าเว็บ
  say(`insert into items(id,code,name,category_id,unit,kind,qty_on_hand,qty_reserved,reorder_point,unit_cost,image,active,created_at,updated_at) values (${S(i.id)},${S(i.code)},${S(i.name)},${S(i.category_id)},${S(i.unit)},${S(i.kind)},${N(i.qty_on_hand)},${N(i.qty_reserved)},${N(i.reorder_point)},${N(i.unit_cost)},null,${B(i.active)},${N(i.created_at)},${N(i.updated_at)}) on conflict (id) do nothing;`);
}
const tags = has('asset_tags') ? q('SELECT * FROM asset_tags') : [];
say(`-- เลขครุภัณฑ์ ${tags.length} ชิ้น`);
for (const t of tags) {
  say(`insert into asset_tags(id,tag_no,item_id,serial_no,status,holder_id,issued_at,due_at,note,created_at,updated_at) values (${S(t.id)},${S(t.tag_no)},${S(t.item_id)},${S(t.serial_no || '')},${S(t.status)},${S(t.holder_id)},${N(t.issued_at)},${N(t.due_at)},${S(t.note || '')},${N(t.created_at)},${N(t.updated_at)}) on conflict (id) do nothing;`);
}

/* ---------- ใบเบิก ---------- */
const reqs = has('requisitions') ? q('SELECT * FROM requisitions') : [];
say('');
say(`-- ใบเบิก ${reqs.length} ใบ`);
for (const r of reqs) {
  say(`insert into requisitions(id,no,requester_id,dept_id,status,purpose,need_by,total_cost,submitted_at,closed_at,created_at,updated_at) values (${S(r.id)},${S(r.no)},${S(r.requester_id)},${S(r.dept_id)},${S(r.status)},${S(r.purpose || '')},${N(r.need_by)},${N(r.total_cost)},${N(r.submitted_at)},${N(r.closed_at)},${N(r.created_at)},${N(r.updated_at)}) on conflict (id) do nothing;`);
}
// seq มาแทน rowid ของ SQLite — เรียงตาม rowid เดิมเพื่อให้ลำดับบรรทัดในใบเหมือนเดิม
const reqItems = has('requisition_items') ? q('SELECT *, rowid AS _rid FROM requisition_items ORDER BY req_id, rowid') : [];
const seqOf = new Map();
for (const l of reqItems) {
  const n = (seqOf.get(l.req_id) || 0) + 1;
  seqOf.set(l.req_id, n);
  say(`insert into requisition_items(id,req_id,item_id,qty_requested,qty_approved,qty_issued,note,seq,created_at,updated_at) values (${S(l.id)},${S(l.req_id)},${S(l.item_id)},${N(l.qty_requested)},${N(l.qty_approved)},${N(l.qty_issued)},${S(l.note || '')},${n},${N(l.created_at)},${N(l.updated_at)}) on conflict (id) do nothing;`);
}
const appr = has('requisition_approvals') ? q('SELECT * FROM requisition_approvals') : [];
for (const a of appr) {
  say(`insert into requisition_approvals(id,req_id,step_no,role_label,approver_id,decision,comment,decided_at,created_at,updated_at) values (${S(a.id)},${S(a.req_id)},${N(a.step_no)},${S(a.role_label || '')},${S(a.approver_id)},${S(a.decision)},${S(a.comment || '')},${N(a.decided_at)},${N(a.created_at)},${N(a.updated_at)}) on conflict (id) do nothing;`);
}

/* ---------- ประวัติสต็อก (ตารางที่ใหญ่ที่สุด) ---------- */
const moves = has('stock_movements') ? q('SELECT * FROM stock_movements ORDER BY at') : [];
say('');
say(`-- ประวัติการเคลื่อนไหวสต็อก ${moves.length} รายการ`);
for (const m of moves) {
  say(`insert into stock_movements(id,at,item_id,asset_tag_id,kind,qty,qty_after,unit_cost,req_item_id,actor_id,note) values (${S(m.id)},${N(m.at)},${S(m.item_id)},${S(m.asset_tag_id)},${S(m.kind)},${N(m.qty)},${N(m.qty_after)},${N(m.unit_cost)},${S(m.req_item_id)},${S(m.actor_id)},${S(m.note || '')}) on conflict (id) do nothing;`);
}

/* ---------- งบ · แจ้งเตือน · ประวัติการใช้งาน · meta ---------- */
const budgets = has('department_budgets') ? q('SELECT * FROM department_budgets') : [];
for (const b of budgets) {
  say(`insert into department_budgets(id,dept_id,period,amount,note,created_at,updated_at) values (${S(b.id)},${S(b.dept_id)},${S(b.period)},${N(b.amount)},${S(b.note || '')},${N(b.created_at)},${N(b.updated_at)}) on conflict (id) do nothing;`);
}
const notis = has('notifications') ? q('SELECT * FROM notifications') : [];
for (const n of notis) {
  say(`insert into notifications(id,user_id,kind,title,body,link,read_at,at) values (${S(n.id)},${S(n.user_id)},${S(n.kind)},${S(n.title)},${S(n.body || '')},${S(n.link || '')},${N(n.read_at)},${N(n.at)}) on conflict (id) do nothing;`);
}
const audits = has('audit_log') ? q('SELECT * FROM audit_log') : [];
say(`-- ประวัติการใช้งาน ${audits.length} รายการ`);
for (const a of audits) {
  say(`insert into audit_log(id,at,actor_id,action,entity,entity_id,detail,ip) values (${S(a.id)},${N(a.at)},${S(a.actor_id)},${S(a.action)},${S(a.entity || '')},${S(a.entity_id || '')},${J(a.detail)},${S(a.ip || '')}) on conflict (id) do nothing;`);
}
const metas = has('meta') ? q('SELECT * FROM meta') : [];
say('-- ตัวนับเลขที่ใบเบิก — ต้องยกมาด้วย ไม่งั้นเลขใบจะเริ่มนับ 1 ใหม่แล้วชนกับของเดิม');
for (const m of metas) {
  say(`insert into meta(k,v) values (${S(m.k)},${S(m.v)}) on conflict (k) do update set v=excluded.v;`);
}

/* ---------- ธงบังคับเปลี่ยนรหัสผ่าน ---------- */
say('');
say('-- ทุกคนที่ย้ายรหัสผ่านมาจากระบบเดิมต้องตั้งรหัสใหม่ก่อนใช้งาน (ยกเว้นแอดมิน)');
say("select api_mark_must_change(null);");

say('');
say('commit;');
say('');
say('-- ตรวจหลังย้าย: ยอดคงเหลือต้องตรงกับผลรวมประวัติ (ต้องได้ 0 แถว)');
say('select * from api_reconcile();');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'), 'utf8');

console.log('สร้างไฟล์แล้ว:', out);
console.log(`  แผนก ${departments.length} · ผู้ใช้ ${users.length} · หมวดหมู่ ${categories.length} · สินค้า ${items.length} · ครุภัณฑ์ ${tags.length}`);
console.log(`  ใบเบิก ${reqs.length} (${reqItems.length} บรรทัด) · ประวัติสต็อก ${moves.length} · ประวัติการใช้งาน ${audits.length}`);
console.log('\nขั้นต่อไป:  supabase db query --linked -f ' + out);
