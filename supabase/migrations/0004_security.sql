-- ด่านความปลอดภัยเพิ่มเติมสำหรับรุ่นที่อยู่บนอินเทอร์เน็ต
--
-- รุ่น LAN ไม่ต้องมีสองอย่างนี้ เพราะเข้าได้เฉพาะคนที่นั่งอยู่ในออฟฟิศ
-- พอย้ายขึ้นเว็บ ใครก็ยิงหน้าเข้าสู่ระบบได้ตลอด 24 ชม. จึงต้องมี:
--   1. ล็อกชั่วคราวเมื่อกรอกรหัสผ่านผิดซ้ำ ๆ (กันการไล่เดารหัส)
--   2. บังคับเปลี่ยนรหัสผ่านครั้งแรก สำหรับพนักงานที่ย้ายรหัสผ่านมาจากระบบใบสำคัญจ่าย
--      เพราะรหัสชุดนั้นตั้งไว้ใช้ในวง LAN ไม่ได้ตั้งใจให้ใช้กับระบบที่เปิดออกอินเทอร์เน็ต

alter table users add column if not exists must_change_password boolean not null default false;

create table if not exists login_attempts(
  id     text primary key,
  emp_id text not null,
  ip     text not null default '',
  at     bigint not null,
  ok     boolean not null
);
create index if not exists idx_login_emp on login_attempts(emp_id, at);
create index if not exists idx_login_ip  on login_attempts(ip, at);
alter table login_attempts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table login_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table login_attempts from authenticated; end if;
end $$;

/* ---------- ด่านที่ 1: ล็อกเมื่อเดารหัสผิดซ้ำ ----------
 * นับเฉพาะ "ครั้งที่ผิด" ในช่วง 15 นาทีล่าสุด
 *   - รหัสพนักงานเดียวกันผิดครบ 5 ครั้ง → ล็อก 15 นาที (กันเจาะบัญชีใดบัญชีหนึ่ง)
 *   - ไอพีเดียวกันผิดครบ 20 ครั้ง → ล็อก 15 นาที (กันไล่ยิงทีละหลายบัญชีจากเครื่องเดียว)
 * ⚠️ นับใหม่ทุกครั้งที่เข้าสำเร็จ (ล้างประวัติผิดของบัญชีนั้นทิ้ง) พนักงานที่พิมพ์ผิดแล้วเข้าได้จะไม่โดนล็อกทีหลัง
 */
create or replace function api_login_check(p_emp text, p_ip text)
returns jsonb language plpgsql as $$
declare
  v_since bigint := now_ms() - 15 * 60 * 1000;
  v_emp_fail int;
  v_ip_fail int;
  v_oldest bigint;
begin
  select count(*), min(at) into v_emp_fail, v_oldest
    from login_attempts where emp_id = p_emp and not ok and at > v_since;
  select count(*) into v_ip_fail
    from login_attempts where ip = p_ip and p_ip <> '' and not ok and at > v_since;

  if v_emp_fail >= 5 or v_ip_fail >= 20 then
    return jsonb_build_object(
      'locked', true,
      'waitSec', greatest(1, ceil((v_oldest + 15 * 60 * 1000 - now_ms()) / 1000.0))::int);
  end if;
  return jsonb_build_object('locked', false, 'waitSec', 0);
end $$;

create or replace function api_login_record(p_emp text, p_ip text, p_ok boolean)
returns void language plpgsql as $$
begin
  insert into login_attempts(id, emp_id, ip, at, ok)
  values (gen_id(), p_emp, coalesce(p_ip,''), now_ms(), p_ok);
  -- เข้าสำเร็จ = ล้างประวัติที่ผิดของบัญชีนั้นทิ้ง ไม่ให้ค้างไปโดนล็อกทีหลัง
  if p_ok then
    delete from login_attempts where emp_id = p_emp and not ok;
  end if;
  -- เก็บประวัติไว้ 7 วันพอ (ไว้ดูย้อนหลังว่ามีคนพยายามเจาะไหม) เกินกว่านั้นลบทิ้ง
  delete from login_attempts where at < now_ms() - 7 * 24 * 60 * 60 * 1000;
end $$;

/* ---------- ด่านที่ 2: บังคับเปลี่ยนรหัสผ่านครั้งแรก ----------
 * เรียกตอนนำเข้าพนักงานจากระบบเดิม — ติดธงให้ทุกคนที่ยังใช้รหัสผ่านชุดเก่า
 */
create or replace function api_mark_must_change(p_emp_ids text[])
returns int language plpgsql as $$
declare v_n int;
begin
  if p_emp_ids is null then
    update users set must_change_password = true, updated_at = now_ms() where role <> 'admin';
  else
    update users set must_change_password = true, updated_at = now_ms() where emp_id = any(p_emp_ids);
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
