-- ข้อมูลตัวอย่างสำหรับ "ตัวทดลอง" — ไม่มีข้อมูลพนักงานจริงแม้แต่คนเดียว
--
-- ⚠️ ห้ามรันไฟล์นี้บนฐานที่มีข้อมูลจริง — บรรทัดแรกล้างข้อมูลทุกตารางทิ้ง
-- รหัสผ่านของทุกบัญชีคือ demo1234 (แฮชด้วย scrypt สูตรเดียวกับระบบจริง)
-- ตอนขึ้นใช้จริงให้ลบบัญชีชุดนี้ทิ้งแล้วนำเข้าพนักงานจริงแทน

truncate stock_movements, requisition_approvals, requisition_items, requisitions,
         notifications, audit_log, asset_tags, items, categories, department_budgets,
         users, departments, meta restart identity cascade;

do $$
declare
  v_at bigint := now_ms();
  d_sale text := gen_id(); d_acct text := gen_id(); d_it text := gen_id();
  u_admin text := gen_id(); u_wh text := gen_id(); u_emp1 text := gen_id(); u_emp2 text := gen_id();
  c_sta text := gen_id(); c_it text := gen_id();
  i_pen text := gen_id(); i_paper text := gen_id(); i_ink text := gen_id();
  i_note text := gen_id(); i_drill text := gen_id();
  v_req jsonb; v_line text;
begin
  insert into departments(id, name, active, created_at, updated_at) values
    (d_sale, 'ฝ่ายขาย', true, v_at, v_at),
    (d_acct, 'ฝ่ายบัญชี', true, v_at, v_at),
    (d_it,   'ฝ่ายไอที', true, v_at, v_at);

  insert into users(id, emp_id, password, name, dept_id, position, role, active, created_at, updated_at) values
    (u_admin,'1001','c5729c0139292d1920fb983231d5b058:3a50429967bfb9bd1ef9e839661fe47f18ff1e83ddd570eb8622c2b354e8fdc8b97b6345c88f558701a53418948ad0ee7bb04e2ff2c571f7ce5162266924d22a',
     'สมชาย ผู้ดูแลระบบ', d_it, 'ผู้จัดการแผนกไอที', 'admin', true, v_at, v_at),
    (u_wh,'1002','5b05d915854e7756f44b35832556ad14:70b51e0288c9b01844cd45c131229fce5b7f76984653bd79afababe0cbcedfdc16f380b19df97c373e7c104fe9a5944cce1ad970ae0caed48f8885adfa4da812',
     'สมหญิง ผู้ดูแลคลัง', d_it, 'เจ้าหน้าที่คลัง', 'warehouse', true, v_at, v_at),
    (u_emp1,'1003','fc2ce920fdf57671ed275d590aab2511:33c7c2975359c3683b26950f6182514d15d01e259b6fb76ff13eed559b5bc2c952cc0bcb06129d236c44c7257954f018e3a6ecb7c2afe3a8741d53a342154bfd',
     'มานะ พนักงานขาย', d_sale, 'พนักงานขาย', 'employee', true, v_at, v_at),
    (u_emp2,'1004','fc2ce920fdf57671ed275d590aab2511:33c7c2975359c3683b26950f6182514d15d01e259b6fb76ff13eed559b5bc2c952cc0bcb06129d236c44c7257954f018e3a6ecb7c2afe3a8741d53a342154bfd',
     'ปิติ พนักงานบัญชี', d_acct, 'พนักงานบัญชี', 'employee', true, v_at, v_at);

  insert into categories(id, name, sort, created_at, updated_at) values
    (c_sta, 'เครื่องเขียน', 10, v_at, v_at),
    (c_it,  'อุปกรณ์ไอที', 20, v_at, v_at);

  insert into items(id, code, name, category_id, unit, kind, reorder_point, unit_cost, created_at, updated_at) values
    (i_pen,   'ST-001', 'ปากกาลูกลื่นสีน้ำเงิน', c_sta, 'ด้าม',  'consumable', 20, 8,    v_at, v_at),
    (i_paper, 'ST-002', 'กระดาษ A4 80 แกรม',    c_sta, 'รีม',   'consumable', 10, 125,  v_at, v_at),
    (i_ink,   'IT-001', 'หมึกพิมพ์ HP 26A',      c_it,  'กล่อง', 'consumable', 3,  2890, v_at, v_at),
    (i_note,  'IT-100', 'โน้ตบุ๊ก Dell Latitude', c_it,  'เครื่อง','asset',      0,  27500, v_at, v_at),
    (i_drill, 'IT-101', 'เครื่องฉายโปรเจกเตอร์',  c_it,  'เครื่อง','asset',      0,  18900, v_at, v_at);

  -- รับของเข้าคลังผ่านฟังก์ชันจริง เพื่อให้มีประวัติครบเหมือนใช้งานจริง
  perform api_receive(i_pen,   200, 8,    null, u_wh, 'ล็อตเปิดระบบ');
  perform api_receive(i_paper, 40,  125,  null, u_wh, 'ล็อตเปิดระบบ');
  perform api_receive(i_ink,   6,   2890, null, u_wh, 'ล็อตเปิดระบบ');
  perform api_receive(i_note,  null, 27500, array['NB-2569-001','NB-2569-002','NB-2569-003'], u_wh, '');
  perform api_receive(i_drill, null, 18900, array['PJ-2569-001'], u_wh, '');

  -- ใบเบิกตัวอย่าง 1: จ่ายครบแล้ว
  v_req := api_create_req(u_emp1, d_sale, 'ใช้ในงานออกบูธ', null, true,
    jsonb_build_array(jsonb_build_object('itemId', i_pen, 'qty', 10),
                      jsonb_build_object('itemId', i_paper, 'qty', 2)));
  perform api_issue(v_req->>'id', u_wh, 'จ่ายครบ',
    (select jsonb_agg(jsonb_build_object('reqItemId', id, 'qty', qty_requested))
       from requisition_items where req_id = v_req->>'id'));

  -- ใบเบิกตัวอย่าง 2: ยืมโน้ตบุ๊ก มีกำหนดคืน
  v_req := api_create_req(u_emp2, d_acct, 'ใช้ทำงานนอกสถานที่', null, true,
    jsonb_build_array(jsonb_build_object('itemId', i_note, 'qty', 1)));
  select id into v_line from requisition_items where req_id = v_req->>'id';
  perform api_issue(v_req->>'id', u_wh, '', jsonb_build_array(jsonb_build_object(
    'reqItemId', v_line,
    'tagIds', jsonb_build_array((select id from asset_tags where tag_no = 'NB-2569-001')),
    'dueAt', v_at + 30::bigint * 86400000)));   -- 30*86400000 ล้น int4 ต้องบอกให้เป็น bigint ก่อน

  -- ใบเบิกตัวอย่าง 3: ยังรอคลังจ่ายของ (ไว้ให้กดทดลองในหน้าคลัง)
  perform api_create_req(u_emp1, d_sale, 'หมึกพิมพ์หมด', null, true,
    jsonb_build_array(jsonb_build_object('itemId', i_ink, 'qty', 1)));

  -- งบประมาณตัวอย่างของเดือนนี้
  insert into department_budgets(id, dept_id, period, amount, note, created_at, updated_at)
  select gen_id(), d.id,
         to_char(to_timestamp(v_at/1000.0) at time zone 'Asia/Bangkok', 'YYYY-MM'),
         50000, 'งบตัวอย่าง', v_at, v_at
  from departments d;

  raise notice 'ข้อมูลตัวอย่างพร้อมแล้ว — เข้าระบบด้วยรหัส 1001 (แอดมิน) · 1002 (คลัง) · 1003/1004 (พนักงาน) รหัสผ่าน demo1234';
end $$;
