-- ส่วนที่เหลือของโฟลว์: ร่างใบเบิก (แก้/ส่ง/ลบ) · ลบสินค้าที่คีย์ผิด · รูปสินค้า

/* ---------- แก้ร่าง ---------- */
-- แก้ได้เฉพาะเจ้าของและเฉพาะตอนยังเป็นร่าง · เขียนบรรทัดใหม่ทั้งชุดเหมือนของเดิม
create or replace function api_update_draft(p_req_id text, p_actor text, p_purpose text, p_need_by bigint, p_lines jsonb)
returns jsonb language plpgsql as $$
declare
  v_req requisitions; v_at bigint := now_ms(); v_key text; v_qty numeric; v_item items;
  v_seq int := 0; v_merged jsonb := '{}'::jsonb; v_line jsonb;
begin
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.requester_id <> p_actor then perform err('แก้ใบเบิกของคนอื่นไม่ได้', 403); end if;
  if v_req.status <> 'draft' then perform err('ใบนี้ส่งไปแล้ว แก้ไม่ได้', 409); end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    perform err('กรุณาเพิ่มรายการของที่ต้องการเบิกอย่างน้อย 1 รายการ', 400);
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_key := v_line->>'itemId';
    v_merged := jsonb_set(v_merged, array[v_key],
      to_jsonb(coalesce((v_merged->>v_key)::numeric, 0) + coalesce((v_line->>'qty')::numeric, 0)), true);
  end loop;

  delete from requisition_items where req_id = v_req.id;
  for v_key, v_qty in select k, v::text::numeric from jsonb_each(v_merged) as x(k, v) loop
    select * into v_item from items where id = v_key;
    if not found then perform err('มีสินค้าในใบที่ไม่พบในระบบแล้ว', 400); end if;
    if not v_item.active then perform err(format('สินค้า "%s" ถูกปิดใช้งานแล้ว', v_item.name), 400); end if;
    if round(v_qty,2) <= 0 then perform err(format('จำนวนของ "%s" ต้องมากกว่า 0', v_item.name), 400); end if;
    v_seq := v_seq + 1;
    insert into requisition_items(id, req_id, item_id, qty_requested, qty_approved, qty_issued, note, seq, created_at, updated_at)
    values (gen_id(), v_req.id, v_key, round(v_qty,2), 0, 0, '', v_seq, v_at, v_at);
  end loop;

  update requisitions set purpose = coalesce(p_purpose,''), need_by = p_need_by, updated_at = v_at where id = v_req.id;
  return jsonb_build_object('id', v_req.id);
end $$;

/* ---------- ส่งร่างเข้าคิวคลัง ---------- */
-- ออกเลขที่ตอนนี้เท่านั้น กันเลขวิ่งเสียเปล่าถ้าร่างถูกทิ้ง
-- ร่างอาจถูกเก็บไว้ตั้งแต่ตอนของยังมี — ตรวจสต็อกใหม่ ณ ตอนกดส่ง
create or replace function api_submit_req(p_req_id text, p_actor text)
returns jsonb language plpgsql as $$
declare v_req requisitions; v_at bigint := now_ms(); v_no text; v_line requisition_items; v_item items; v_avail numeric;
begin
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.requester_id <> p_actor then perform err('ส่งใบเบิกของคนอื่นไม่ได้', 403); end if;
  if v_req.status <> 'draft' then perform err('ใบนี้ส่งไปแล้ว', 409); end if;
  if not exists (select 1 from requisition_items where req_id = v_req.id) then
    perform err('ใบนี้ยังไม่มีรายการของ', 400);
  end if;

  for v_line in select * from requisition_items where req_id = v_req.id order by seq loop
    select * into v_item from items where id = v_line.item_id for update;
    if not found then continue; end if;
    v_avail := item_available(v_item);
    if v_avail <= 0 then perform err(format('"%s" หมดแล้ว เบิกไม่ได้ ให้เอาออกจากใบก่อนส่ง', v_item.name), 409); end if;
    if v_line.qty_requested > v_avail then
      perform err(format('"%s" เหลือ %s %s ให้แก้จำนวนในใบก่อนส่ง', v_item.name, v_avail, v_item.unit), 409);
    end if;
  end loop;

  v_no := next_req_no(v_at);
  update requisitions set no = v_no, status = 'pending', submitted_at = v_at, updated_at = v_at where id = v_req.id;
  perform notify_role('warehouse', 'new_request', 'ใบเบิกใหม่ ' || v_no,
                      (select name from users where id = p_actor), 'issue.html');
  return jsonb_build_object('id', v_req.id, 'no', v_no);
end $$;

/* ---------- ลบร่าง ---------- */
create or replace function api_delete_draft(p_req_id text, p_actor text)
returns jsonb language plpgsql as $$
declare v_req requisitions;
begin
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.requester_id <> p_actor then perform err('ลบใบเบิกของคนอื่นไม่ได้', 403); end if;
  if v_req.status <> 'draft' then perform err('ใบที่ส่งไปแล้วลบไม่ได้ ให้กดยกเลิกแทน', 409); end if;
  delete from requisitions where id = v_req.id;   -- requisition_items ตามไปด้วย (on delete cascade)
  return jsonb_build_object('ok', true);
end $$;

/* ---------- ลบสินค้าที่คีย์ผิด ----------
 * 🔑 ลบได้เฉพาะรายการที่ "ยังไม่มีอะไรผูกอยู่เลย" — คีย์ผิดแล้วลบทิ้งได้ในนาทีนั้น
 *    พอมีประวัติแล้วต้องใช้ "ปิดใช้งาน" แทน ไม่งั้นบรรทัดในประวัติสต็อก ใบเบิกเก่า และรายงาน
 *    จะชี้ไปที่สินค้าที่ไม่มีอยู่
 */
create or replace function item_delete_block(p_item_id text) returns text language plpgsql stable as $$
declare v_item items; v_c int;
begin
  select * into v_item from items where id = p_item_id;
  if not found then return 'ไม่พบสินค้ารายการนี้'; end if;
  select count(*) into v_c from stock_movements where item_id = p_item_id;
  if v_c > 0 then return format('ลบไม่ได้ เพราะมีประวัติการเคลื่อนไหวแล้ว %s รายการ', v_c); end if;
  select count(*) into v_c from requisition_items where item_id = p_item_id;
  if v_c > 0 then return format('ลบไม่ได้ เพราะเคยถูกใส่ในใบเบิกแล้ว %s รายการ', v_c); end if;
  select count(*) into v_c from asset_tags where item_id = p_item_id;
  if v_c > 0 then return format('ลบไม่ได้ เพราะมีเลขครุภัณฑ์ผูกอยู่ %s ชิ้น', v_c); end if;
  if item_on_hand(v_item) > 0 or v_item.qty_reserved > 0 then
    return 'ลบไม่ได้ เพราะยังมียอดของค้างอยู่ในระบบ';
  end if;
  return '';
end $$;

create or replace function api_delete_item(p_item_id text, p_actor text)
returns jsonb language plpgsql as $$
declare v_item items; v_block text;
begin
  select * into v_item from items where id = p_item_id for update;
  if not found then perform err('ไม่พบสินค้ารายการนี้', 404); end if;
  v_block := item_delete_block(p_item_id);
  if v_block <> '' then
    perform err(v_block || ' — ให้ใช้ “ปิดใช้งาน” แทน รายการเดิมจะยังตามประวัติกลับได้', 409);
  end if;
  delete from item_images where item_id = v_item.id;
  delete from items where id = v_item.id;
  return jsonb_build_object('ok', true, 'code', v_item.code, 'name', v_item.name);
end $$;

/* ---------- รูปสินค้า ----------
 * ของเดิมเก็บเป็นไฟล์บนดิสก์ของเซิร์ฟเวอร์ ซึ่งบนคลาวด์ไม่มีดิสก์ถาวรให้เขียน
 * จึงเก็บลงตารางแยกต่างหาก (ไม่ใช่ในตาราง items) — เหตุผลเดิมยังอยู่ครบ:
 * หน้าเลือกของโหลดสินค้าทั้งคลังทุกครั้ง ถ้ารูปติดมากับแถวสินค้า payload จะบวมทุกคำขอ
 * หน้าเว็บย่อรูปเหลือ ~60-120KB ก่อนส่งอยู่แล้ว (shrinkImage ใน common.js)
 */
create table if not exists item_images(
  item_id    text primary key references items(id) on delete cascade,
  mime       text not null,
  bytes      bytea not null,
  updated_at bigint not null
);
alter table item_images enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table item_images from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table item_images from authenticated; end if;
end $$;
