// Edge Function ตัวเดียวที่ทำหน้าที่แทนเซิร์ฟเวอร์ Express ทั้งตัว
//
// 🔑 หลักการที่ยกมาจากระบบเดิมทั้งดุ้น:
//   1. "ตรรกะที่ต้องอะตอมมิกอยู่ในฐานข้อมูล" — route ชั้นนี้ทำแค่ตรวจสิทธิ์ แปลงข้อมูล แล้วเรียกฟังก์ชัน api_* ใน Postgres
//      (ของเดิมได้ความอะตอมมิกจากทรานแซกชันของ better-sqlite3 ซึ่งบนคลาวด์ใช้ไม่ได้ เพราะคุยข้ามเครือข่าย)
//   2. "token ใช้ยืนยันแค่ว่าใครเป็นใคร" — บทบาท/แผนก/สถานะบัญชี อ่านจากฐานทุกคำขอเสมอ
//      (บทเรียนจากระบบเดิม: เชื่อค่าใน token แล้วปิดบัญชีไม่มีผล 12 ชม. · ตั้งผู้ดูแลคลังแล้วสิทธิ์ไม่มา)
//   3. รูปแบบ token และเส้นทาง API เหมือนเดิมทุกตัวอักษร → หน้าเว็บเดิมใช้ต่อได้โดยแก้แค่ URL ฐาน
//
// ⚠️ ฟังก์ชันนี้ deploy แบบ --no-verify-jwt เพราะตรวจ token เอง (พนักงานเข้าด้วยรหัสพนักงาน ไม่ใช่ Supabase Auth)
import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js';
import { scryptSync, timingSafeEqual } from 'node:crypto';

const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DB_URL')!;
const TOKEN_SECRET = Deno.env.get('APP_TOKEN_SECRET') ?? 'dev-insecure-secret-change-me';
const TOKEN_TTL_HOURS = Number(Deno.env.get('APP_TOKEN_TTL_HOURS') ?? '12');
// รายชื่อ origin ที่เรียกได้ · ว่าง = ปล่อยทุก origin (ใช้ตอนทดสอบในเครื่องเท่านั้น)
const ALLOWED = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// 🔑 ต้องแปลง bigint (int8) เป็น number เอง
//    ค่าเริ่มต้นของไดรเวอร์ส่ง int8 กลับมาเป็น "สตริง" เพราะกลัวเกินช่วง Number
//    แต่เวลาทุกช่องในระบบนี้เป็น epoch ms (~1.79e12) ห่างจากเพดาน 9e15 อยู่มาก
//    ถ้าปล่อยเป็นสตริง หน้าเว็บจะได้ new Date("1790660986625") = Invalid Date ทุกที่ที่โชว์วันเวลา
const sql = postgres(DB_URL, {
  prepare: false,
  types: { bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
});

/* ---------- token: รูปแบบเดียวกับระบบเดิม (base64url(payload).base64url(hmac)) ---------- */
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const key = await crypto.subtle.importKey('raw', enc.encode(TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

async function signToken(payload: Record<string, unknown>) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_HOURS * 3600 * 1000 };
  const b = b64url(enc.encode(JSON.stringify(body)));
  const sig = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  return `${b}.${sig}`;
}
async function verifyToken(token: string | null) {
  if (!token || !token.includes('.')) return null;
  const [b, sig] = token.split('.');
  const expect = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  if (sig.length !== expect.length) return null;
  // เทียบแบบเวลาคงที่ กันการไล่เดาลายเซ็นจากเวลาที่ใช้ตอบ
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const data = JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/')));
    if (data.exp && Date.now() > data.exp) return null;
    return data as { id: string };
  } catch { return null; }
}

/* ---------- รหัสผ่าน: scrypt สูตรเดียวกับระบบใบสำคัญจ่าย ห้ามเปลี่ยน ---------- */
// ถ้าเปลี่ยนสูตรตรงนี้ พนักงานที่ย้ายข้อมูลมาจะเข้าระบบไม่ได้ทั้งหมด
function verifyPassword(pw: string, stored: string) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = scryptSync(String(pw), salt, 64).toString('hex');
  const a = new TextEncoder().encode(h), b = new TextEncoder().encode(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- ตัวช่วยตอบกลับ ---------- */
const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': !ALLOWED.length ? (origin ?? '*') : (origin && ALLOWED.includes(origin) ? origin : ALLOWED[0]),
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const json = (data: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) } });

class HttpErr extends Error { constructor(msg: string, public status = 400) { super(msg); } }

// ฟังก์ชันใน Postgres ส่งรหัสสถานะมากับ ERRCODE (P0400/P0403/P0404/P0409) — แปลงกลับเป็น HTTP ที่นี่
function dbErrStatus(e: unknown) {
  const code = (e as { code?: string })?.code ?? '';
  return /^P0(4\d\d)$/.test(code) ? Number(code.slice(2)) : 0;
}

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/* ---------- ผู้ใช้ปัจจุบัน ---------- */
type User = { id: string; empId: string; name: string; role: string; deptId: string | null; dept: string; position: string };

async function currentUser(req: Request): Promise<User> {
  const h = req.headers.get('authorization') ?? '';
  const data = await verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!data?.id) throw new HttpErr('กรุณาเข้าสู่ระบบ', 401);
  const [u] = await sql`
    select u.id, u.emp_id, u.name, u.role, u.dept_id, u.position, u.active, d.name as dept_name
    from users u left join departments d on d.id = u.dept_id where u.id = ${data.id}`;
  if (!u || !u.active) throw new HttpErr('บัญชีถูกปิดการใช้งาน กรุณาเข้าสู่ระบบใหม่', 401);
  return { id: u.id, empId: u.emp_id, name: u.name, role: u.role, deptId: u.dept_id, dept: u.dept_name ?? '', position: u.position };
}
const isWarehouse = (u: User) => u.role === 'warehouse' || u.role === 'admin';
function needRole(u: User, ...roles: string[]) {
  if (u.role === 'admin' || roles.includes(u.role)) return;
  throw new HttpErr('ไม่มีสิทธิ์ใช้งานส่วนนี้', 403);
}

async function audit(actor: User | null, action: string, entity: string, entityId: string, detail: unknown, req: Request) {
  try {
    await sql`insert into audit_log(id, at, actor_id, action, entity, entity_id, detail, ip)
      values (gen_id(), now_ms(), ${actor?.id ?? null}, ${action}, ${entity}, ${entityId},
              ${detail ? sql.json(detail as any) : null}, ${req.headers.get('x-forwarded-for') ?? ''})`;
  } catch (e) { console.error('[audit]', e); }   // บันทึกไม่ได้ต้องไม่ทำให้งานหลักล้ม
}

/* ---------- แปลงแถวสินค้าเป็นรูปที่หน้าเว็บใช้ (เหมือน toItem เดิม) ---------- */
async function itemRows(where = sql``, all = false) {
  return await sql`
    select i.*, c.name as category_name, c.sort as cat_sort,
           item_on_hand(i.*) as on_hand, item_available(i.*) as available,
           exists(select 1 from item_images x where x.item_id = i.id) as has_image,
           case when i.kind = 'asset' then
             (select jsonb_object_agg(status, c) from (
                select status, count(*) c from asset_tags where item_id = i.id group by status) x)
           else null end as tag_counts
    from items i left join categories c on c.id = i.category_id
    where (${all} or i.active) ${where}
    order by i.active desc, c.sort nulls last, i.name`;
}
const toItem = (row: Record<string, any>) => ({
  id: row.id, code: row.code, name: row.name, unit: row.unit, kind: row.kind,
  categoryId: row.category_id, category: row.category_name ?? '',
  onHand: r2(row.on_hand), reserved: row.kind === 'asset' ? 0 : r2(row.qty_reserved), available: r2(row.available),
  reorderPoint: r2(row.reorder_point), unitCost: r2(row.unit_cost), active: !!row.active,
  hasImage: !!row.has_image,
  tags: row.kind === 'asset' ? (row.tag_counts ?? {}) : null,
  low: Number(row.reorder_point) > 0 && r2(row.available) <= r2(row.reorder_point),
});

const reqHead = (r: Record<string, any>) => ({
  id: r.id, no: r.no, status: r.status, purpose: r.purpose, needBy: r.need_by,
  totalCost: r2(r.total_cost), submittedAt: r.submitted_at, closedAt: r.closed_at, createdAt: r.created_at,
  requester: r.requester_name, requesterEmp: r.requester_emp, dept: r.dept_name ?? '',
});

/* ============================================================
   เส้นทาง API — ชื่อเหมือนระบบเดิมทุกเส้น หน้าเว็บจึงแก้แค่ URL ฐาน
   ============================================================ */
async function route(req: Request, path: string[], body: any): Promise<unknown> {
  const m = req.method;
  const [head, ...rest] = path;

  /* ---------- auth ---------- */
  if (head === 'auth') {
    if (rest[0] === 'login' && m === 'POST') {
      const empId = String(body?.empId ?? '').trim();
      const password = String(body?.password ?? '');
      if (!empId || !password) throw new HttpErr('กรุณากรอกรหัสพนักงานและรหัสผ่าน', 400);
      const [u] = await sql`
        select u.*, d.name as dept_name from users u left join departments d on d.id = u.dept_id
        where u.emp_id = ${empId}`;
      // ตอบข้อความเดียวกันทั้งกรณีไม่มีรหัสนี้และรหัสผ่านผิด กันการไล่เดารหัสพนักงานที่มีจริง
      if (!u || !verifyPassword(password, u.password)) throw new HttpErr('รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง', 401);
      if (!u.active) throw new HttpErr('บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ', 403);
      const user = { id: u.id, empId: u.emp_id, name: u.name, role: u.role, deptId: u.dept_id, dept: u.dept_name ?? '', position: u.position };
      await audit(user as User, 'auth.login', 'users', u.id, null, req);
      return { token: await signToken({ id: u.id }), user };
    }
    const me = await currentUser(req);
    if (rest[0] === 'me' && m === 'GET') return { user: me };
    if (rest[0] === 'change-password' && m === 'POST') {
      const next = String(body?.next ?? '');
      if (next.length < 4) throw new HttpErr('รหัสผ่านใหม่ต้องยาวอย่างน้อย 4 ตัวอักษร', 400);
      const [u] = await sql`select password from users where id = ${me.id}`;
      if (!u || !verifyPassword(String(body?.current ?? ''), u.password)) throw new HttpErr('รหัสผ่านเดิมไม่ถูกต้อง', 400);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltHex = [...salt].map((x) => x.toString(16).padStart(2, '0')).join('');
      const hash = scryptSync(next, saltHex, 64).toString('hex');
      await sql`update users set password = ${saltHex + ':' + hash}, updated_at = now_ms() where id = ${me.id}`;
      await audit(me, 'auth.change_password', 'users', me.id, null, req);
      return { ok: true };
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  const me = await currentUser(req);

  /* ---------- catalog ---------- */
  if (head === 'catalog') {
    if (rest[0] === 'categories' && m === 'GET') {
      return { categories: await sql`
        select c.id, c.name, c.sort, (select count(*) from items i where i.category_id = c.id and i.active) as items
        from categories c order by c.sort, c.name` };
    }
    if (rest[0] === 'categories' && m === 'POST') {
      needRole(me, 'warehouse');
      const name = String(body?.name ?? '').trim();
      if (!name) throw new HttpErr('กรุณากรอกชื่อหมวดหมู่', 400);
      const [dup] = await sql`select 1 from categories where name = ${name}`;
      if (dup) throw new HttpErr('มีหมวดหมู่ชื่อนี้อยู่แล้ว', 409);
      const [row] = await sql`
        insert into categories(id, name, sort, created_at, updated_at)
        values (gen_id(), ${name}, (select coalesce(max(sort),0) + 10 from categories), now_ms(), now_ms())
        returning id, name`;
      await audit(me, 'category.create', 'categories', row.id, { name }, req);
      return row;
    }
    if (rest[0] === 'low-stock' && m === 'GET') {
      const rows = await itemRows(sql`and i.reorder_point > 0`);
      return { items: rows.map(toItem).filter((i: any) => i.low) };
    }
    if (rest[0] === 'items' && !rest[1] && m === 'GET') {
      const url = new URL(req.url);
      const q = (url.searchParams.get('q') ?? '').trim();
      const kind = (url.searchParams.get('kind') ?? '').trim();
      const all = url.searchParams.get('all') === '1';
      const rows = await itemRows(sql`
        ${q ? sql`and (i.code ilike ${'%' + q + '%'} or i.name ilike ${'%' + q + '%'} or coalesce(c.name,'') ilike ${'%' + q + '%'})` : sql``}
        ${kind ? sql`and i.kind = ${kind}` : sql``}`, all);
      const items = rows.map(toItem);
      return { items, lowCount: items.filter((i: any) => i.low && i.active).length };
    }
    if (rest[0] === 'items' && !rest[1] && m === 'POST') {
      needRole(me, 'warehouse');
      const code = String(body?.code ?? '').trim(), name = String(body?.name ?? '').trim();
      const kind = String(body?.kind ?? 'consumable');
      if (!code || !name) throw new HttpErr('กรุณากรอกรหัสสินค้าและชื่อสินค้า', 400);
      if (!['consumable', 'asset'].includes(kind)) throw new HttpErr('ประเภทสินค้าไม่ถูกต้อง', 400);
      const [dup] = await sql`select 1 from items where code = ${code}`;
      if (dup) throw new HttpErr(`รหัสสินค้า "${code}" ถูกใช้ไปแล้ว`, 409);
      const [row] = await sql`
        insert into items(id, code, name, category_id, unit, kind, reorder_point, unit_cost, created_at, updated_at)
        values (gen_id(), ${code}, ${name}, ${body?.categoryId || null}, ${String(body?.unit ?? 'ชิ้น').trim() || 'ชิ้น'},
                ${kind}, ${r2(body?.reorderPoint)}, ${r2(body?.unitCost)}, now_ms(), now_ms())
        returning id`;
      // ยอดเริ่มต้นเป็น 0 เสมอ · ของที่มีอยู่ต้องบันทึกผ่าน "รับของเข้า" เพื่อให้มีประวัติ
      await audit(me, 'item.create', 'items', row.id, { code, name, kind }, req);
      return { id: row.id };
    }
    if (rest[0] === 'items' && rest[1] && !rest[2] && m === 'GET') {
      const [row] = await itemRows(sql`and i.id = ${rest[1]}`, true);
      if (!row) throw new HttpErr('ไม่พบสินค้ารายการนี้', 404);
      const [{ block }] = await sql`select item_delete_block(${rest[1]}) as block`;
      return {
        item: toItem(row),
        deleteBlock: block,
        tags: await sql`select t.id, t.tag_no, t.serial_no, t.status, t.note, t.due_at, u.name as holder
                        from asset_tags t left join users u on u.id = t.holder_id
                        where t.item_id = ${rest[1]} order by t.tag_no`,
        movements: await sql`select m.at, m.kind, m.qty, m.qty_after, m.unit_cost, m.note, u.name as actor, t.tag_no
                             from stock_movements m left join users u on u.id = m.actor_id
                             left join asset_tags t on t.id = m.asset_tag_id
                             where m.item_id = ${rest[1]} order by m.at desc limit 60`,
      };
    }
    if (rest[0] === 'items' && rest[1] && !rest[2] && m === 'PUT') {
      needRole(me, 'warehouse');
      const [item] = await sql`select * from items where id = ${rest[1]}`;
      if (!item) throw new HttpErr('ไม่พบสินค้ารายการนี้', 404);
      // ปิดสินค้าที่ยังมีของค้างอยู่ไม่ได้ ไม่งั้นของหายไปจากสายตาแต่ยังอยู่บนชั้นจริง
      if (body?.active === false && item.active) {
        const [{ left }] = await sql`select item_on_hand(i.*) as left from items i where i.id = ${item.id}`;
        if (Number(left) > 0) throw new HttpErr(`ปิดใช้งานไม่ได้ ยังมีของเหลือในคลัง ${r2(left)} ${item.unit}`, 409);
      }
      const next = {
        code: body?.code === undefined ? item.code : String(body.code).trim(),
        name: body?.name === undefined ? item.name : String(body.name).trim(),
        categoryId: body?.categoryId === undefined ? item.category_id : (body.categoryId || null),
        unit: body?.unit === undefined ? item.unit : (String(body.unit).trim() || 'ชิ้น'),
        reorderPoint: body?.reorderPoint === undefined ? item.reorder_point : r2(body.reorderPoint),
        unitCost: body?.unitCost === undefined ? item.unit_cost : r2(body.unitCost),
        active: body?.active === undefined ? !!item.active : !!body.active,
      };
      if (!next.code || !next.name) throw new HttpErr('รหัสสินค้าและชื่อสินค้าห้ามว่าง', 400);
      if (Number(next.reorderPoint) < 0 || Number(next.unitCost) < 0) throw new HttpErr('ค่าติดลบไม่ได้', 400);
      if (next.code !== item.code) {
        const [dup] = await sql`select 1 from items where code = ${next.code} and id <> ${item.id}`;
        if (dup) throw new HttpErr(`รหัสสินค้า "${next.code}" ถูกใช้ไปแล้ว`, 409);
      }
      await sql`update items set code = ${next.code}, name = ${next.name}, category_id = ${next.categoryId},
                unit = ${next.unit}, reorder_point = ${next.reorderPoint}, unit_cost = ${next.unitCost},
                active = ${next.active}, updated_at = now_ms() where id = ${item.id}`;
      await audit(me, 'item.update', 'items', item.id, { after: next }, req);
      return { ok: true };
    }
    if (rest[0] === 'items' && rest[1] && rest[2] === 'image') {
      if (m === 'GET') {
        const [img] = await sql`select mime, bytes from item_images where item_id = ${rest[1]}`;
        if (!img) throw new HttpErr('ไม่มีรูปของสินค้ารายการนี้', 404);
        return new Response(img.bytes, { headers: {
          'content-type': img.mime,
          // ชื่อไฟล์เปลี่ยนทุกครั้งที่อัปโหลดใหม่ไม่ได้ จึงให้แคชสั้น ๆ พอ
          'cache-control': 'private, max-age=300',
          ...cors(req.headers.get('origin')),
        } });
      }
      needRole(me, 'warehouse');
      if (m === 'DELETE') {
        await sql`delete from item_images where item_id = ${rest[1]}`;
        await audit(me, 'item.image.delete', 'items', rest[1], null, req);
        return { ok: true, hasImage: false };
      }
      if (m === 'PUT') {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (buf.length < 12) throw new HttpErr('ไฟล์รูปไม่ถูกต้อง', 400);
        // ดูจากเนื้อไฟล์จริง ไม่เชื่อนามสกุล/Content-Type ที่ส่งมา
        const ascii = (i: number, n: number) => String.fromCharCode(...buf.slice(i, i + n));
        const mime = (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ? 'image/jpeg'
          : (buf[0] === 0x89 && ascii(1, 3) === 'PNG') ? 'image/png'
          : (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') ? 'image/webp' : '';
        if (!mime) throw new HttpErr('รองรับเฉพาะไฟล์ภาพ JPG · PNG · WEBP', 400);
        if (buf.length > 2 * 1024 * 1024) throw new HttpErr('ไฟล์รูปใหญ่เกิน 2 MB', 400);
        await sql`insert into item_images(item_id, mime, bytes, updated_at)
                  values (${rest[1]}, ${mime}, ${buf}, now_ms())
                  on conflict (item_id) do update set mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at`;
        await audit(me, 'item.image', 'items', rest[1], { bytes: buf.length }, req);
        return { ok: true, hasImage: true };
      }
    }
    if (rest[0] === 'items' && rest[1] && !rest[2] && m === 'DELETE') {
      needRole(me, 'warehouse');
      const [row] = await sql`select api_delete_item(${rest[1]}, ${me.id}) as out`;
      await audit(me, 'item.delete', 'items', rest[1], row.out, req);
      return { ok: true };
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- stock ---------- */
  if (head === 'stock') {
    needRole(me, 'warehouse');
    if (rest[0] === 'receive' && m === 'POST') {
      const [row] = await sql`select api_receive(${body?.itemId}, ${body?.qty ?? null}, ${body?.unitCost ?? null},
        ${body?.tagNos ?? null}, ${me.id}, ${String(body?.note ?? '')}) as out`;
      await audit(me, 'stock.receive', 'items', body?.itemId, { qty: body?.qty, tags: (body?.tagNos ?? []).length }, req);
      return row.out;
    }
    if (rest[0] === 'adjust' && m === 'POST') {
      const [row] = await sql`select api_adjust(${body?.itemId}, ${body?.counted ?? null}, ${me.id}, ${String(body?.note ?? '')}) as out`;
      await audit(me, 'stock.adjust', 'items', body?.itemId, row.out, req);
      return row.out;
    }
    if (rest[0] === 'asset-status' && m === 'POST') {
      const [row] = await sql`select api_asset_status(${body?.tagId}, ${body?.status}, ${me.id}, ${String(body?.note ?? '')}) as out`;
      await audit(me, 'asset.status', 'asset_tags', body?.tagId, { status: body?.status }, req);
      return row.out;
    }
    if (rest[0] === 'movements' && m === 'GET') {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
      const kind = (url.searchParams.get('kind') ?? '').trim();
      return { rows: await sql`
        select m.at, m.kind, m.qty, m.qty_after, m.unit_cost, m.note, i.code, i.name, i.unit, t.tag_no, u.name as actor
        from stock_movements m join items i on i.id = m.item_id
        left join asset_tags t on t.id = m.asset_tag_id left join users u on u.id = m.actor_id
        ${kind ? sql`where m.kind = ${kind}` : sql``}
        order by m.at desc limit ${limit}` };
    }
    if (rest[0] === 'reconcile' && m === 'GET') {
      const bad = await sql`select * from api_reconcile()`;
      return { ok: bad.length === 0, mismatched: bad };
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- requisitions ---------- */
  if (head === 'requisitions') {
    const HEAD = sql`
      select r.*, u.name as requester_name, u.emp_id as requester_emp, d.name as dept_name
      from requisitions r join users u on u.id = r.requester_id
      left join departments d on d.id = r.dept_id`;

    if (!rest[0] && m === 'GET') {
      const url = new URL(req.url);
      const box = url.searchParams.get('box') ?? 'mine';
      const status = (url.searchParams.get('status') ?? '').trim();
      let rows;
      if (box === 'queue') {
        if (!isWarehouse(me)) throw new HttpErr('เฉพาะผู้ดูแลคลัง', 403);
        rows = await sql`${HEAD} where r.status = 'pending' order by r.submitted_at`;
      } else if (box === 'all') {
        if (!isWarehouse(me)) throw new HttpErr('เฉพาะผู้ดูแลคลัง', 403);
        rows = await sql`${HEAD} where r.status <> 'draft' ${status ? sql`and r.status = ${status}` : sql``}
                         order by r.submitted_at desc limit 300`;
      } else {
        // ร่างเป็นของส่วนตัวของผู้สร้าง ไม่มีใครเห็นแม้แต่คลัง
        rows = await sql`${HEAD} where r.requester_id = ${me.id} order by r.created_at desc limit 300`;
      }
      const [{ c }] = await sql`select count(*)::int as c from requisitions where status = 'pending'`;
      return { requisitions: rows.map(reqHead), queueCount: c };
    }

    if (!rest[0] && m === 'POST') {
      const [row] = await sql`select api_create_req(${me.id}, ${me.deptId}, ${String(body?.purpose ?? '')},
        ${body?.needBy ?? null}, ${!!body?.submit}, ${sql.json(body?.lines ?? [])}) as out`;
      await audit(me, body?.submit ? 'req.submit' : 'req.draft', 'requisitions', row.out.id, { no: row.out.no }, req);
      return row.out;
    }

    if (rest[0] && !rest[1] && m === 'GET') {
      const [r] = await sql`${HEAD} where r.id = ${rest[0]}`;
      if (!r) throw new HttpErr('ไม่พบใบเบิกนี้', 404);
      const mine = r.requester_id === me.id;
      if (r.status === 'draft' && !mine) throw new HttpErr('ไม่พบใบเบิกนี้', 404);
      if (!mine && !isWarehouse(me)) throw new HttpErr('ดูใบเบิกของคนอื่นไม่ได้', 403);
      const lines = await sql`
        select ri.*, i.code, i.name, i.unit, i.kind, i.unit_cost, item_available(i.*) as available
        from requisition_items ri join items i on i.id = ri.item_id
        where ri.req_id = ${r.id} order by ri.seq`;
      const out = [];
      for (const l of lines) {
        out.push({
          id: l.id, itemId: l.item_id, code: l.code, name: l.name, unit: l.unit, kind: l.kind,
          qtyRequested: r2(l.qty_requested), qtyIssued: r2(l.qty_issued), unitCost: r2(l.unit_cost), note: l.note,
          available: r2(l.available),
          tags: l.kind === 'asset'
            ? await sql`select id, tag_no from asset_tags where item_id = ${l.item_id} and status = 'available' order by tag_no`
            : [],
          issuedTags: (await sql`select t.tag_no from stock_movements m join asset_tags t on t.id = m.asset_tag_id
                                 where m.req_item_id = ${l.id} and m.kind = 'issue'`).map((x: any) => x.tag_no),
        });
      }
      const approvals = (await sql`
        select a.*, u.name as approver_name from requisition_approvals a
        left join users u on u.id = a.approver_id where a.req_id = ${r.id} order by a.step_no`)
        .map((a: any) => ({ step: a.step_no, role: a.role_label, approver: a.approver_name ?? '',
                            decision: a.decision, comment: a.comment, decidedAt: a.decided_at }));
      return { requisition: { ...reqHead(r), lines: out, approvals } };
    }

    if (rest[0] && !rest[1] && m === 'PUT') {
      const [row] = await sql`select api_update_draft(${rest[0]}, ${me.id}, ${String(body?.purpose ?? '')},
        ${body?.needBy ?? null}, ${sql.json(body?.lines ?? [])}) as out`;
      await audit(me, 'req.draft_update', 'requisitions', rest[0], null, req);
      return row.out;
    }
    if (rest[0] && !rest[1] && m === 'DELETE') {
      const [row] = await sql`select api_delete_draft(${rest[0]}, ${me.id}) as out`;
      await audit(me, 'req.draft_delete', 'requisitions', rest[0], null, req);
      return row.out;
    }
    if (rest[0] && rest[1] === 'submit' && m === 'POST') {
      const [row] = await sql`select api_submit_req(${rest[0]}, ${me.id}) as out`;
      await audit(me, 'req.submit', 'requisitions', rest[0], row.out, req);
      return row.out;
    }
    if (rest[0] && rest[1] === 'cancel' && m === 'POST') {
      const [row] = await sql`select api_cancel(${rest[0]}, ${me.id}) as out`;
      await audit(me, 'req.cancel', 'requisitions', rest[0], null, req);
      return row.out;
    }
    if (rest[0] && rest[1] === 'issue' && m === 'POST') {
      needRole(me, 'warehouse');
      const [row] = await sql`select api_issue(${rest[0]}, ${me.id}, ${String(body?.comment ?? '')},
        ${sql.json(body?.lines ?? [])}) as out`;
      await audit(me, 'req.issue', 'requisitions', rest[0], row.out, req);
      return row.out;
    }
    if (rest[0] && rest[1] === 'reject' && m === 'POST') {
      needRole(me, 'warehouse');
      const [row] = await sql`select api_reject(${rest[0]}, ${me.id}, ${String(body?.comment ?? '')}) as out`;
      await audit(me, 'req.reject', 'requisitions', rest[0], { comment: body?.comment }, req);
      return row.out;
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- assets ---------- */
  if (head === 'assets') {
    const mapTag = (t: any) => ({
      id: t.id, tagNo: t.tag_no, item: t.name, code: t.code, issuedAt: t.issued_at, dueAt: t.due_at, note: t.note,
      holder: t.holder_name ?? '', holderEmp: t.holder_emp ?? '', dept: t.dept_name ?? '',
      overdue: !!(t.due_at && Number(t.due_at) < Date.now()),
    });
    if (rest[0] === 'mine' && m === 'GET') {
      const rows = await sql`
        select t.id, t.tag_no, t.issued_at, t.due_at, t.note, i.name, i.code, i.unit
        from asset_tags t join items i on i.id = t.item_id
        where t.holder_id = ${me.id} and t.status = 'in_use' order by t.issued_at desc`;
      return { tags: rows.map(mapTag) };
    }
    if (rest[0] === 'held' && m === 'GET') {
      needRole(me, 'warehouse');
      const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
      const like = '%' + q + '%';
      const rows = await sql`
        select t.id, t.tag_no, t.issued_at, t.due_at, t.note, i.name, i.code, i.unit,
               u.name as holder_name, u.emp_id as holder_emp, d.name as dept_name
        from asset_tags t join items i on i.id = t.item_id join users u on u.id = t.holder_id
        left join departments d on d.id = u.dept_id
        where t.status = 'in_use'
          ${q ? sql`and (t.tag_no ilike ${like} or i.name ilike ${like} or u.name ilike ${like}
                         or u.emp_id ilike ${like} or coalesce(d.name,'') ilike ${like})` : sql``}
        order by (t.due_at is not null and t.due_at < ${Date.now()}) desc, t.due_at, t.issued_at`;
      const tags = rows.map(mapTag);
      return { tags, overdue: tags.filter((t: any) => t.overdue).length };
    }
    if (rest[0] === 'remind-overdue' && m === 'POST') {
      needRole(me, 'warehouse');
      const rows = await sql`
        select t.holder_id, t.tag_no, i.name from asset_tags t join items i on i.id = t.item_id
        where t.status = 'in_use' and t.due_at is not null and t.due_at < ${Date.now()}`;
      for (const r of rows) {
        await sql`select notify_user(${r.holder_id}, 'overdue_asset', 'ครุภัณฑ์เลยกำหนดคืนแล้ว',
          ${r.name + ' · ' + r.tag_no + ' — กรุณานำมาคืนที่คลัง'}, 'request.html')`;
      }
      await audit(me, 'asset.remind_overdue', 'asset_tags', '', { count: rows.length }, req);
      return { sent: rows.length };
    }
    if (rest[0] && rest[1] === 'return' && m === 'POST') {
      needRole(me, 'warehouse');
      const [row] = await sql`select api_return_asset(${rest[0]}, ${String(body?.condition ?? '')}, ${me.id},
        ${String(body?.note ?? '')}) as out`;
      await audit(me, 'asset.return', 'asset_tags', rest[0], row.out, req);
      return row.out;
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- notifications ---------- */
  if (head === 'notifications') {
    if (!rest[0] && m === 'GET') {
      const rows = await sql`select id, kind, title, body, link, read_at, at from notifications
                             where user_id = ${me.id} order by at desc limit 40`;
      const [{ c }] = await sql`select count(*)::int as c from notifications where user_id = ${me.id} and read_at is null`;
      return { notifications: rows.map((n: any) => ({ ...n, read: !!n.read_at })), unread: c };
    }
    if (rest[0] === 'read' && m === 'POST') {
      await sql`update notifications set read_at = now_ms() where user_id = ${me.id} and read_at is null`;
      return { ok: true };
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- reports ---------- */
  if (head === 'reports') {
    needRole(me, 'warehouse');
    const url = new URL(req.url);
    const from = parseInt(url.searchParams.get('from') ?? '0', 10) || 0;
    const to = parseInt(url.searchParams.get('to') ?? '0', 10) || Date.now();

    if (rest[0] === 'summary' && m === 'GET') {
      const [{ v: consumable }] = await sql`select coalesce(sum(qty_on_hand * unit_cost),0) as v from items where kind='consumable' and active`;
      const [{ v: asset }] = await sql`select coalesce(sum(i.unit_cost),0) as v from asset_tags t join items i on i.id=t.item_id
                                       where t.status in ('available','in_use','maintenance')`;
      const [issued] = await sql`select coalesce(sum(-m.qty * m.unit_cost),0) as v, count(distinct m.req_item_id)::int as lines
                                 from stock_movements m where m.kind='issue' and m.at between ${from} and ${to}`;
      const reqs = (await sql`select status, count(*)::int as c from requisitions
                              where status <> 'draft' and coalesce(submitted_at, created_at) between ${from} and ${to}
                              group by status`).reduce((acc: any, r: any) => (acc[r.status] = r.c, acc), {});
      const one = async (q: any) => Number((await q)[0].c);
      return {
        stockValue: { consumable: r2(consumable), asset: r2(asset), total: r2(Number(consumable) + Number(asset)) },
        issuedValue: r2(issued.v), issuedLines: issued.lines, requisitions: reqs,
        pending: await one(sql`select count(*)::int as c from requisitions where status='pending'`),
        lowStock: await one(sql`select count(*)::int as c from items where active and reorder_point > 0
                                and kind='consumable' and (qty_on_hand - qty_reserved) <= reorder_point`),
        heldAssets: await one(sql`select count(*)::int as c from asset_tags where status='in_use'`),
        overdueAssets: await one(sql`select count(*)::int as c from asset_tags where status='in_use'
                                     and due_at is not null and due_at < ${Date.now()}`),
      };
    }
    if (rest[0] === 'by-dept' && m === 'GET') {
      return { rows: (await sql`
        select coalesce(d.name,'ไม่ระบุแผนก') as dept, d.id as dept_id, count(distinct r.id)::int as reqs,
               coalesce(sum(-m.qty * m.unit_cost),0) as value
        from stock_movements m join requisition_items ri on ri.id = m.req_item_id
        join requisitions r on r.id = ri.req_id left join departments d on d.id = r.dept_id
        where m.kind='issue' and m.at between ${from} and ${to}
        group by d.name, d.id, r.dept_id order by value desc`).map((x: any) => ({ ...x, value: r2(x.value) })) };
    }
    if (rest[0] === 'by-person' && m === 'GET') {
      return { rows: (await sql`
        select u.name, u.emp_id, coalesce(d.name,'') as dept, count(distinct r.id)::int as reqs,
               coalesce(sum(-m.qty * m.unit_cost),0) as value
        from stock_movements m join requisition_items ri on ri.id = m.req_item_id
        join requisitions r on r.id = ri.req_id join users u on u.id = r.requester_id
        left join departments d on d.id = r.dept_id
        where m.kind='issue' and m.at between ${from} and ${to}
        group by u.id, u.name, u.emp_id, d.name order by value desc limit 100`).map((x: any) => ({ ...x, value: r2(x.value) })) };
    }
    if (rest[0] === 'top-items' && m === 'GET') {
      return { rows: (await sql`
        select i.code, i.name, i.unit, sum(-m.qty) as qty, coalesce(sum(-m.qty * m.unit_cost),0) as value
        from stock_movements m join items i on i.id = m.item_id
        where m.kind='issue' and m.at between ${from} and ${to}
        group by i.id, i.code, i.name, i.unit order by value desc limit 50`)
        .map((x: any) => ({ ...x, qty: r2(x.qty), value: r2(x.value) })) };
    }
    if (rest[0] === 'held-assets' && m === 'GET') {
      return { rows: (await sql`
        select t.tag_no, i.name, i.unit_cost, u.name as holder, u.emp_id, coalesce(d.name,'') as dept, t.issued_at, t.due_at
        from asset_tags t join items i on i.id=t.item_id join users u on u.id=t.holder_id
        left join departments d on d.id=u.dept_id
        where t.status='in_use' order by t.due_at is null, t.due_at, t.issued_at`)
        .map((x: any) => ({ ...x, unit_cost: r2(x.unit_cost), overdue: !!(x.due_at && Number(x.due_at) < Date.now()) })) };
    }
    if (rest[0] === 'export') {
      // เติม BOM ให้ Excel อ่านภาษาไทยถูก · ⚠️ เขียนเป็น escape sequence ไม่ใช่อักขระ BOM ดิบ ๆ
      const csv = (filename: string, headers: string[], rows: unknown[][]) => {
        const esc = (v: unknown) => {
          const t = v == null ? '' : String(v);
          return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
        };
        const bodyText = [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
        // BOM ต้องเขียนเป็น \uFEFF ไม่ใช่อักขระดิบ — ตัวดิบมองไม่เห็นในเอดิเตอร์ หายง่ายตอนคัดลอกโค้ด
        return new Response('\uFEFF' + bodyText, { headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          ...cors(req.headers.get('origin')),
        } });
      };
      const thDate = (ms: unknown) => (ms ? new Date(Number(ms)).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '');

      if (rest[1] === 'movements') {
        const rows = await sql`
          select m.at, m.kind, i.code, i.name, i.unit, m.qty, m.qty_after, m.unit_cost, t.tag_no,
                 u.name as actor, m.note, r.no as req_no, ru.name as requester, coalesce(d.name,'') as dept
          from stock_movements m join items i on i.id = m.item_id
          left join asset_tags t on t.id = m.asset_tag_id
          left join users u on u.id = m.actor_id
          left join requisition_items ri on ri.id = m.req_item_id
          left join requisitions r on r.id = ri.req_id
          left join users ru on ru.id = r.requester_id
          left join departments d on d.id = r.dept_id
          where m.at between ${from} and ${to} order by m.at desc`;
        return csv('stock-movements.csv',
          ['วันเวลา','รายการ','รหัสสินค้า','ชื่อสินค้า','หน่วย','จำนวน','คงเหลือ','ราคา/หน่วย','มูลค่า','เลขครุภัณฑ์','เลขที่ใบเบิก','ผู้ขอ','แผนก','ผู้ทำรายการ','หมายเหตุ'],
          rows.map((m: any) => [thDate(m.at), m.kind, m.code, m.name, m.unit, r2(m.qty), r2(m.qty_after),
            r2(m.unit_cost), r2(Math.abs(Number(m.qty)) * Number(m.unit_cost)), m.tag_no ?? '', m.req_no ?? '',
            m.requester ?? '', m.dept, m.actor ?? '', m.note]));
      }
      if (rest[1] === 'requisitions') {
        // 🔑 ราคา/มูลค่าดึงจากประวัติของบรรทัดนั้น ไม่ใช่ items.unit_cost
        //    (บทเรียนจากระบบเดิม: แก้ราคาสินค้าวันหลังแล้วไฟล์นี้เปลี่ยนตัวเลขย้อนหลังเอง)
        const rows = await sql`
          select r.no, r.status, r.purpose, r.submitted_at, r.closed_at,
                 u.name as requester, u.emp_id, coalesce(d.name,'') as dept,
                 i.code, i.name as item, i.unit, ri.qty_requested, ri.qty_issued, i.unit_cost,
                 (select coalesce(sum(-m.qty * m.unit_cost),0) from stock_movements m
                   where m.req_item_id = ri.id and m.kind='issue') as issued_value,
                 (select m2.unit_cost from stock_movements m2
                   where m2.req_item_id = ri.id and m2.kind='issue' order by m2.at limit 1) as issued_cost
          from requisitions r join users u on u.id = r.requester_id
          left join departments d on d.id = r.dept_id
          join requisition_items ri on ri.req_id = r.id
          join items i on i.id = ri.item_id
          where r.status <> 'draft' and coalesce(r.submitted_at, r.created_at) between ${from} and ${to}
          order by r.submitted_at desc, ri.seq`;
        return csv('requisitions.csv',
          ['เลขที่','สถานะ','ผู้ขอ','รหัสพนักงาน','แผนก','วันที่ส่ง','วันที่ปิด','เหตุผล','รหัสสินค้า','ชื่อสินค้า','หน่วย','ขอ','จ่ายจริง','ราคา/หน่วย','มูลค่าที่จ่าย'],
          rows.map((x: any) => [x.no, x.status, x.requester, x.emp_id, x.dept, thDate(x.submitted_at), thDate(x.closed_at),
            x.purpose, x.code, x.item, x.unit, r2(x.qty_requested), r2(x.qty_issued),
            r2(x.issued_cost == null ? x.unit_cost : x.issued_cost), r2(x.issued_value)]));
      }
      if (rest[1] === 'held-assets') {
        const rows = await sql`
          select t.tag_no, i.code, i.name, u.name as holder, u.emp_id, coalesce(d.name,'') as dept,
                 t.issued_at, t.due_at, i.unit_cost
          from asset_tags t join items i on i.id = t.item_id join users u on u.id = t.holder_id
          left join departments d on d.id = u.dept_id
          where t.status = 'in_use' order by u.name, t.tag_no`;
        return csv('held-assets.csv',
          ['เลขครุภัณฑ์','รหัสสินค้า','ชื่อสินค้า','ผู้ถือครอง','รหัสพนักงาน','แผนก','วันที่เบิก','กำหนดคืน','เลยกำหนด','มูลค่า'],
          rows.map((t: any) => [t.tag_no, t.code, t.name, t.holder, t.emp_id, t.dept, thDate(t.issued_at),
            thDate(t.due_at), t.due_at && Number(t.due_at) < Date.now() ? 'เลยกำหนด' : '', r2(t.unit_cost)]));
      }
      throw new HttpErr('ไม่พบเส้นทางนี้', 404);
    }
    if (rest[0] === 'budget') {
      const periodRange = (p: string): [number, number] | null => {
        if (/^\d{4}$/.test(p)) return [new Date(+p, 0, 1).getTime(), new Date(+p + 1, 0, 1).getTime() - 1];
        const mm = p.match(/^(\d{4})-(\d{2})$/);
        if (!mm) return null;
        return [new Date(+mm[1], +mm[2] - 1, 1).getTime(), new Date(+mm[1], +mm[2], 1).getTime() - 1];
      };
      if (m === 'GET') {
        const period = url.searchParams.get('period') ?? '';
        const rng = periodRange(period);
        if (!rng) throw new HttpErr('รูปแบบงวดไม่ถูกต้อง ใช้ 2026-08 หรือ 2026', 400);
        const used = (await sql`
          select r.dept_id, coalesce(sum(-m.qty * m.unit_cost),0) as v
          from stock_movements m join requisition_items ri on ri.id = m.req_item_id
          join requisitions r on r.id = ri.req_id
          where m.kind='issue' and m.at between ${rng[0]} and ${rng[1]} group by r.dept_id`)
          .reduce((acc: any, x: any) => (acc[x.dept_id ?? ''] = Number(x.v), acc), {});
        const rows = (await sql`
          select d.id, d.name, b.id as budget_id, coalesce(b.amount,0) as amount, coalesce(b.note,'') as note
          from departments d left join department_budgets b on b.dept_id = d.id and b.period = ${period}
          where d.active order by d.name`).map((d: any) => {
            const u = r2(used[d.id] ?? 0), amount = r2(d.amount);
            return { deptId: d.id, dept: d.name, amount, used: u, note: d.note,
                     pct: amount > 0 ? Math.round((u / amount) * 100) : null, over: amount > 0 && u > amount };
          });
        return { period, rows };
      }
      if (m === 'PUT') {
        needRole(me, 'admin');
        const period = String(body?.period ?? '');
        if (!periodRange(period)) throw new HttpErr('รูปแบบงวดไม่ถูกต้อง ใช้ 2026-08 หรือ 2026', 400);
        const [d] = await sql`select 1 from departments where id = ${body?.deptId}`;
        if (!d) throw new HttpErr('ไม่พบแผนกที่เลือก', 400);
        const amount = r2(body?.amount);
        if (amount < 0) throw new HttpErr('วงเงินติดลบไม่ได้', 400);
        await sql`
          insert into department_budgets(id, dept_id, period, amount, note, created_at, updated_at)
          values (gen_id(), ${body.deptId}, ${period}, ${amount}, ${String(body?.note ?? '')}, now_ms(), now_ms())
          on conflict (dept_id, period) do update set amount = excluded.amount, note = excluded.note, updated_at = now_ms()`;
        await audit(me, 'budget.set', 'department_budgets', body.deptId, { period, amount }, req);
        return { ok: true };
      }
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  /* ---------- admin ---------- */
  if (head === 'admin') {
    needRole(me, 'admin');
    if (rest[0] === 'users' && !rest[1] && m === 'GET') {
      const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
      const like = '%' + q + '%';
      const rows = await sql`
        select u.id, u.emp_id, u.name, u.position, u.role, u.active, u.dept_id, d.name as dept_name
        from users u left join departments d on d.id = u.dept_id
        ${q ? sql`where u.emp_id ilike ${like} or u.name ilike ${like} or coalesce(d.name,'') ilike ${like}` : sql``}
        order by (u.role = 'admin') desc, u.emp_id`;
      const counts = (await sql`select role, count(*)::int as c from users where active group by role`)
        .reduce((acc: any, r: any) => (acc[r.role] = r.c, acc), {});
      return {
        users: rows.map((u: any) => ({ id: u.id, empId: u.emp_id, name: u.name, position: u.position,
          role: u.role, active: !!u.active, deptId: u.dept_id, dept: u.dept_name ?? '' })),
        counts,
      };
    }
    if (rest[0] === 'users' && rest[1] && m === 'PUT') {
      const [target] = await sql`select * from users where id = ${rest[1]}`;
      if (!target) throw new HttpErr('ไม่พบผู้ใช้รายนี้', 404);
      const role = body?.role === undefined ? target.role : String(body.role);
      const active = body?.active === undefined ? !!target.active : !!body.active;
      const deptId = body?.deptId === undefined ? target.dept_id : (body.deptId || null);
      if (!['employee', 'approver', 'warehouse', 'admin'].includes(role)) throw new HttpErr('บทบาทไม่ถูกต้อง', 400);
      // กันล็อกตัวเองออกจากระบบ — ถ้าถอดสิทธิ์แอดมินคนสุดท้ายแล้วจะไม่มีใครแก้กลับได้อีก
      if (target.id === me.id && (role !== 'admin' || !active)) {
        throw new HttpErr('ถอดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้ ให้แอดมินอีกคนเป็นผู้ทำ', 400);
      }
      if (target.role === 'admin' && role !== 'admin') {
        const [{ c }] = await sql`select count(*)::int as c from users where role='admin' and active and id <> ${target.id}`;
        if (c === 0) throw new HttpErr('ต้องเหลือผู้ดูแลระบบอย่างน้อย 1 คน', 400);
      }
      // ปิดบัญชีไม่ได้ถ้ายังถือครุภัณฑ์ค้างอยู่ — ของต้องกลับเข้าคลังก่อน
      if (target.active && !active) {
        const [{ c }] = await sql`select count(*)::int as c from asset_tags where holder_id = ${target.id} and status='in_use'`;
        if (c > 0) throw new HttpErr(`ปิดบัญชีไม่ได้ ยังถือครุภัณฑ์ค้างอยู่ ${c} ชิ้น กรุณารับคืนให้ครบก่อน`, 409);
      }
      await sql.begin(async (tx: any) => {
        await tx`update users set role = ${role}, active = ${active}, dept_id = ${deptId}, updated_at = now_ms()
                 where id = ${target.id}`;
        if ((role !== 'approver' && role !== 'admin') || !active) {
          await tx`update departments set approver_id = null, updated_at = now_ms() where approver_id = ${target.id}`;
        }
      });
      await audit(me, 'user.update', 'users', target.id, { after: { role, active, deptId } }, req);
      return { ok: true };
    }
    if (rest[0] === 'departments' && !rest[1] && m === 'GET') {
      const rows = await sql`
        select d.id, d.name, d.active, d.approver_id, u.name as approver_name, u.emp_id as approver_emp,
               (select count(*)::int from users x where x.dept_id = d.id and x.active) as staff
        from departments d left join users u on u.id = d.approver_id order by d.name`;
      return { departments: rows.map((d: any) => ({ id: d.id, name: d.name, active: !!d.active, staff: d.staff,
        approverId: d.approver_id, approver: d.approver_name ? `${d.approver_name} (${d.approver_emp})` : '' })) };
    }
    if (rest[0] === 'departments' && rest[1] && m === 'PUT') {
      const [dept] = await sql`select * from departments where id = ${rest[1]}`;
      if (!dept) throw new HttpErr('ไม่พบแผนกนี้', 404);
      const approverId = body?.approverId || null;
      if (approverId) {
        const [u] = await sql`select role, active from users where id = ${approverId}`;
        if (!u) throw new HttpErr('ไม่พบผู้ใช้ที่เลือก', 400);
        if (!u.active) throw new HttpErr('ตั้งคนที่ถูกปิดบัญชีเป็นหัวหน้าแผนกไม่ได้', 400);
        if (u.role !== 'approver' && u.role !== 'admin') {
          throw new HttpErr('ต้องเปลี่ยนบทบาทคนนี้เป็น "หัวหน้างาน" ก่อน จึงจะตั้งเป็นหัวหน้าแผนกได้', 400);
        }
      }
      await sql`update departments set approver_id = ${approverId}, updated_at = now_ms() where id = ${dept.id}`;
      await audit(me, 'dept.set_approver', 'departments', dept.id, { after: approverId }, req);
      return { ok: true };
    }
    if (rest[0] === 'audit' && m === 'GET') {
      const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit') ?? '100', 10) || 100, 500);
      const rows = await sql`
        select a.*, u.name as actor_name, u.emp_id as actor_emp from audit_log a
        left join users u on u.id = a.actor_id order by a.at desc limit ${limit}`;
      return { rows: rows.map((r: any) => ({ at: r.at, action: r.action, entity: r.entity, entityId: r.entity_id,
        actor: r.actor_name ? `${r.actor_name} (${r.actor_emp})` : '(ระบบ)', detail: r.detail ? JSON.stringify(r.detail) : '', ip: r.ip })) };
    }
    throw new HttpErr('ไม่พบเส้นทางนี้', 404);
  }

  throw new HttpErr('ไม่พบเส้นทางนี้', 404);
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

  // เส้นทางมาได้ 2 แบบ: /functions/v1/api/<path> (คลาวด์) และ /<path> (รันในเครื่อง)
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('api');
  const path = i >= 0 ? parts.slice(i + 1) : parts;

  // อ่าน body เฉพาะคำขอที่เป็น JSON — คำขออัปโหลดรูปส่งไบต์ดิบมา ต้องปล่อยให้ route อ่านเอง
  let body: unknown = null;
  if (req.method !== 'GET' && req.method !== 'OPTIONS' &&
      (req.headers.get('content-type') ?? '').includes('application/json')) {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    if (path[0] === 'health') {
      const [{ c }] = await sql`select count(*)::int as c from users`;
      return json({ ok: true, users: c, at: Date.now() }, 200, origin);
    }
    const out = await route(req, path, body);
    // route คืน Response มาเองได้ (รูปภาพ · ไฟล์ CSV)
    return out instanceof Response ? out : json(out, 200, origin);
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.message }, e.status, origin);
    const st = dbErrStatus(e);
    if (st) return json({ error: (e as Error).message }, st, origin);
    console.error('[api]', e);
    return json({ error: 'เกิดข้อผิดพลาดภายในระบบ' }, 500, origin);
  }
});
