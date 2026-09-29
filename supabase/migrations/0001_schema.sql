-- ระบบเบิกอุปกรณ์ — โครงตารางบน PostgreSQL (Supabase)
--
-- แปลงมาจากฐาน SQLite ของระบบในวง LAN (src/db.js) โดยยึดกติกาเดิมทุกข้อ:
--   • เวลาทุกช่องเป็น epoch millisecond (bigint) เหมือนเดิม — หน้าเว็บใช้ค่าเดียวกันได้โดยไม่ต้องแก้
--   • id เป็น text (hex 24 ตัว) เหมือนเดิม — ย้ายข้อมูลเก่ามาได้ตรง ๆ ไม่ต้อง map id ใหม่
--   • ตารางที่ปิดใช้งานได้ใช้คอลัมน์ active แทนการลบแถว เพราะประวัติเก่ายังอ้างถึงอยู่
--   • จำนวน/ราคาเป็น numeric(14,2) — ของเดิมเป็น REAL แล้วปัด 2 ตำแหน่งด้วย r2() ทุกครั้งที่เขียน
--     numeric ปัดให้ในตัวและไม่มีปัญหาทศนิยมลอย (0.1+0.2 = 0.30000000000000004) ที่เคยหลอกตัวสอบทาน
--
-- 🔒 ทุกตารางเปิด RLS แบบ "ไม่มี policy" = ห้ามเข้าถึงผ่าน PostgREST/anon key โดยสิ้นเชิง
--    ทางเข้าเดียวคือ Edge Function ที่ต่อด้วย service role และตรวจสิทธิ์เองในโค้ด
--    (สถาปัตยกรรมเดียวกับของเดิม: ตรรกะสิทธิ์อยู่ที่ชั้นเดียว ไม่กระจายเป็น policy หลายสิบข้อ)

-- ไม่ต้องใช้ pgcrypto แล้ว — gen_id() ใช้ gen_random_uuid() ที่มากับ PostgreSQL 13+ ในตัว

/* ---------- คนและแผนก ---------- */
create table if not exists departments(
  id          text primary key,
  name        text not null unique,
  approver_id text,
  active      boolean not null default true,
  created_at  bigint not null,
  updated_at  bigint not null
);

create table if not exists users(
  id         text primary key,
  emp_id     text not null unique,            -- รหัสพนักงาน = ตัวที่ใช้เข้าสู่ระบบ
  password   text not null,                   -- scrypt hash รูปแบบ salt:hash (สูตรเดียวกับระบบใบสำคัญจ่าย)
  name       text not null,
  dept_id    text references departments(id),
  position   text not null default '',
  role       text not null default 'employee' check (role in ('employee','approver','warehouse','admin')),
  active     boolean not null default true,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists idx_users_role on users(role, active);
create index if not exists idx_users_dept on users(dept_id, active);

alter table departments
  add constraint departments_approver_fk foreign key (approver_id) references users(id);

create table if not exists department_budgets(
  id         text primary key,
  dept_id    text not null references departments(id),
  period     text not null,                   -- '2026-08' รายเดือน หรือ '2026' รายปี
  amount     numeric(14,2) not null default 0,
  note       text not null default '',
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists idx_budget_key on department_budgets(dept_id, period);

/* ---------- ของในคลัง ---------- */
create table if not exists categories(
  id         text primary key,
  name       text not null unique,
  sort       integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists items(
  id            text primary key,
  code          text not null unique,
  name          text not null,
  category_id   text references categories(id),
  unit          text not null default 'ชิ้น',
  kind          text not null default 'consumable' check (kind in ('consumable','asset')),
  qty_on_hand   numeric(14,2) not null default 0,   -- ⚠️ ใช้เฉพาะ consumable · asset นับจาก asset_tags
  qty_reserved  numeric(14,2) not null default 0,
  reorder_point numeric(14,2) not null default 0,   -- 0 = ไม่เตือน
  unit_cost     numeric(14,2) not null default 0,
  image         text,                               -- path ใน Supabase Storage (bucket item-images)
  active        boolean not null default true,
  created_at    bigint not null,
  updated_at    bigint not null
);
create index if not exists idx_items_name on items(name);
create index if not exists idx_items_kind on items(kind, active);
create index if not exists idx_items_cat  on items(category_id, active);

create table if not exists asset_tags(
  id         text primary key,
  tag_no     text not null unique,            -- เลขครุภัณฑ์ที่ติดบนตัวของ
  item_id    text not null references items(id),
  serial_no  text not null default '',
  status     text not null default 'available'
             check (status in ('available','in_use','maintenance','lost','retired')),
  holder_id  text references users(id),
  issued_at  bigint,
  due_at     bigint,
  note       text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  -- ของอยู่ในมือใครต้องมีชื่อคนถือเสมอ และของที่ไม่ได้ถูกยืมต้องไม่มีชื่อค้าง
  constraint asset_tag_holder_ck check ((status = 'in_use') = (holder_id is not null))
);
create index if not exists idx_tag_item   on asset_tags(item_id, status);
create index if not exists idx_tag_holder on asset_tags(holder_id, status);

/* ---------- ใบเบิกและการอนุมัติ ---------- */
create table if not exists requisitions(
  id           text primary key,
  no           text unique,                   -- ออกเลขตอนกดส่งเท่านั้น · ร่างเป็น null
  requester_id text not null references users(id),
  dept_id      text references departments(id),
  status       text not null default 'draft'
               check (status in ('draft','pending','issued','partial','rejected','cancelled')),
  purpose      text not null default '',
  need_by      bigint,
  total_cost   numeric(14,2) not null default 0,
  submitted_at bigint,
  closed_at    bigint,
  created_at   bigint not null,
  updated_at   bigint not null
);
create index if not exists idx_req_status    on requisitions(status, created_at);
create index if not exists idx_req_requester on requisitions(requester_id, created_at);
create index if not exists idx_req_dept      on requisitions(dept_id, submitted_at);

create table if not exists requisition_items(
  id            text primary key,
  req_id        text not null references requisitions(id) on delete cascade,
  item_id       text not null references items(id),
  qty_requested numeric(14,2) not null default 0,
  qty_approved  numeric(14,2) not null default 0,
  qty_issued    numeric(14,2) not null default 0,
  note          text not null default '',
  seq           integer not null default 0,   -- ลำดับบรรทัดในใบ (แทน rowid ของ SQLite)
  created_at    bigint not null,
  updated_at    bigint not null
);
create index if not exists idx_reqitem_req  on requisition_items(req_id, seq);
create index if not exists idx_reqitem_item on requisition_items(item_id);

create table if not exists requisition_approvals(
  id          text primary key,
  req_id      text not null references requisitions(id) on delete cascade,
  step_no     integer not null,
  role_label  text not null default '',
  approver_id text references users(id),
  decision    text check (decision in ('approve','reject')),
  comment     text not null default '',
  decided_at  bigint,
  created_at  bigint not null,
  updated_at  bigint not null
);
create unique index if not exists idx_appr_step  on requisition_approvals(req_id, step_no);
create index if not exists idx_appr_queue on requisition_approvals(approver_id, decision);

/* ---------- ประวัติและระบบ ---------- */
create table if not exists stock_movements(
  id           text primary key,
  at           bigint not null,
  item_id      text not null references items(id),
  asset_tag_id text references asset_tags(id),
  kind         text not null check (kind in ('receive','issue','return','adjust','write_off')),
  qty          numeric(14,2) not null,        -- บวก = เข้าคลัง · ลบ = ออกจากคลัง เสมอ
  qty_after    numeric(14,2) not null,        -- ยอดคงเหลือหลังรายการนี้ ใช้สอบทานย้อนหลัง
  unit_cost    numeric(14,2) not null default 0,  -- ราคา ณ วันนั้น ถ่ายรูปเก็บ ไม่ดึงย้อนหลัง
  req_item_id  text references requisition_items(id),
  actor_id     text references users(id),
  note         text not null default ''
);
create index if not exists idx_mv_item on stock_movements(item_id, at);
create index if not exists idx_mv_kind on stock_movements(kind, at);
create index if not exists idx_mv_req  on stock_movements(req_item_id);

create table if not exists notifications(
  id      text primary key,
  user_id text not null references users(id),
  kind    text not null,
  title   text not null,
  body    text not null default '',
  link    text not null default '',
  read_at bigint,
  at      bigint not null
);
create index if not exists idx_noti_user on notifications(user_id, read_at, at);

create table if not exists audit_log(
  id        text primary key,
  at        bigint not null,
  actor_id  text,
  action    text not null,
  entity    text not null default '',
  entity_id text not null default '',
  detail    jsonb,                            -- ของเดิมเก็บเป็นสตริง JSON · Postgres มี jsonb ให้ค้นได้เลย
  ip        text not null default ''
);
create index if not exists idx_audit_at     on audit_log(at);
create index if not exists idx_audit_entity on audit_log(entity, entity_id, at);

create table if not exists meta(k text primary key, v text not null);

/* ---------- ปิดประตูทุกบานที่ไม่ใช่ Edge Function ---------- */
do $$
declare t text;
begin
  foreach t in array array['departments','users','department_budgets','categories','items','asset_tags',
                           'requisitions','requisition_items','requisition_approvals','stock_movements',
                           'notifications','audit_log','meta']
  loop
    execute format('alter table %I enable row level security', t);
    -- role anon/authenticated มีเฉพาะบน Supabase · เครื่องทดสอบในเครื่องไม่มี จึงเช็กก่อนสั่ง
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;
