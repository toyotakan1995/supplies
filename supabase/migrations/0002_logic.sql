-- ★ จุดเดียวในระบบที่ได้รับอนุญาตให้ขยับยอดสต็อก ★
--
-- ของเดิม (LAN) ใช้ทรานแซกชันของ better-sqlite3 ซึ่งเป็น synchronous ทั้งกระบวนการ
-- บนคลาวด์ Edge Function เป็น async และคุยข้ามเครือข่าย ถ้าปล่อยให้อ่าน-คิด-เขียนจากฝั่งนั้น
-- สองคนกด "จ่ายของ" พร้อมกันจะอ่านยอดเดียวกันแล้วตัดสต็อกซ้อนกันได้
-- จึงย้ายตรรกะทั้งก้อนลงมาเป็นฟังก์ชันใน Postgres — เรียก 1 ครั้ง = 1 ทรานแซกชัน และล็อกแถวด้วย FOR UPDATE
--
-- ข้อความ error เป็นภาษาไทยชุดเดิม และแนบรหัสสถานะ HTTP มากับ ERRCODE:
--   P0400 = ข้อมูลที่ส่งมาไม่ถูก · P0403 = ไม่มีสิทธิ์ · P0404 = ไม่พบ · P0409 = สถานะขัดกัน
-- Edge Function อ่าน ERRCODE แล้วแปลงเป็น HTTP status ตรง ๆ (ดู supabase/functions/api/index.ts)

-- id เป็น hex 24 ตัวเหมือนระบบเดิม (ของเดิมใช้ crypto.randomBytes(12) ใน Node)
-- ⚠️ ห้ามใช้ gen_random_bytes() ของ pgcrypto — บน Supabase extension นี้อยู่ schema `extensions`
--    ไม่ได้อยู่ใน search_path ของฟังก์ชัน จะพังตอน deploy ว่า "function does not exist"
--    gen_random_uuid() เป็นของที่มากับ PostgreSQL 13+ ในตัว ใช้ได้ทั้งเครื่องทดสอบและบนคลาวด์
create or replace function gen_id() returns text language sql volatile as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 24);
$$;

create or replace function now_ms() returns bigint language sql stable as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

create or replace function err(p_msg text, p_status int) returns void language plpgsql as $$
begin
  raise exception '%', p_msg using errcode = 'P0' || p_status::text;
end $$;

/* ---------- อ่านยอด ---------- */
-- ยอดที่ "อยู่บนชั้น" จริง ๆ · ครุภัณฑ์นับจากจำนวนแท็กที่ว่าง ไม่ใช้ qty_on_hand เลย
create or replace function item_on_hand(p_item items) returns numeric language sql stable as $$
  select case when p_item.kind = 'asset'
    then (select count(*) from asset_tags t where t.item_id = p_item.id and t.status = 'available')::numeric
    else p_item.qty_on_hand end;
$$;

-- ยอดที่ "เบิกได้จริง" = บนชั้น − ที่จองไว้ · ทุกหน้าจอต้องใช้ค่านี้ ห้ามอ่าน qty_on_hand ดิบ ๆ ไปแสดง
create or replace function item_available(p_item items) returns numeric language sql stable as $$
  select item_on_hand(p_item) - case when p_item.kind = 'asset' then 0 else p_item.qty_reserved end;
$$;

/* ---------- ออกเลขที่ใบเบิก RQ-YYMM-NNN ---------- */
-- นับแยกชุดต่อเดือน · ต้องเรียกในทรานแซกชันเดียวกับที่สร้างแถวใบเบิก ไม่งั้นสองคนกดพร้อมกันได้เลขซ้ำ
-- เวลาใช้โซนไทยเสมอ ไม่ใช้ UTC ของเซิร์ฟเวอร์ ไม่งั้นใบที่ส่งตอนตี 1 ของวันที่ 1 จะได้เลขเดือนก่อน
create or replace function next_req_no(p_at bigint) returns text language plpgsql as $$
declare
  v_ym text;
  v_key text;
  v_next int;
begin
  v_ym := to_char(to_timestamp(p_at / 1000.0) at time zone 'Asia/Bangkok', 'YYMM');
  v_key := 'seq:RQ' || v_ym;
  insert into meta(k, v) values (v_key, '1')
    on conflict (k) do update set v = (meta.v::int + 1)::text
    returning v::int into v_next;
  -- เกิน 999 ใบต่อเดือนก็รันต่อเป็น 1000 ไม่วนกลับ กันเลขซ้ำ
  return 'RQ-' || v_ym || '-' || lpad(v_next::text, 3, '0');
end $$;

/* ---------- แจ้งเตือน ---------- */
create or replace function notify_user(p_user text, p_kind text, p_title text, p_body text, p_link text)
returns void language plpgsql as $$
begin
  if p_user is null then return; end if;   -- ไม่มีผู้รับ = ข้ามเงียบ ๆ ไม่ทำให้งานหลักล้ม
  insert into notifications(id, user_id, kind, title, body, link, at)
  values (gen_id(), p_user, p_kind, p_title, coalesce(p_body,''), coalesce(p_link,''), now_ms());
end $$;

-- ส่งถึงทุกคนในบทบาทหนึ่ง · ถ้าบทบาทนั้นยังไม่มีใครเลยให้ตกมาที่แอดมิน
-- ไม่งั้นช่วงที่ยังไม่ได้ตั้งผู้ดูแลคลัง ใบเบิกจะเข้าคิวเงียบ ๆ โดยไม่มีใครรู้
create or replace function notify_role(p_role text, p_kind text, p_title text, p_body text, p_link text)
returns int language plpgsql as $$
declare v_n int := 0; v_role text := p_role;
begin
  if not exists (select 1 from users where role = p_role and active) and p_role <> 'admin' then
    v_role := 'admin';
  end if;
  for v_n in select 1 from users where role = v_role and active loop end loop;
  insert into notifications(id, user_id, kind, title, body, link, at)
  select gen_id(), u.id, p_kind, p_title, coalesce(p_body,''), coalesce(p_link,''), now_ms()
  from users u where u.role = v_role and u.active;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/* ---------- รับของเข้าคลัง ---------- */
-- ของสิ้นเปลือง: ใช้ p_qty · ครุภัณฑ์: ใช้ p_tag_nos (เลขครุภัณฑ์ที่จะติดบนตัวของ) จำนวนชิ้น = ความยาว array
create or replace function api_receive(
  p_item_id text, p_qty numeric, p_unit_cost numeric, p_tag_nos text[],
  p_actor text, p_note text
) returns jsonb language plpgsql as $$
declare
  v_item items;
  v_cost numeric;
  v_at bigint := now_ms();
  v_after numeric;
  v_tag text;
  v_id text;
  v_tags jsonb := '[]'::jsonb;
begin
  select * into v_item from items where id = p_item_id for update;
  if not found then perform err('ไม่พบสินค้ารายการนี้', 404); end if;
  if not v_item.active then perform err('สินค้ารายการนี้ถูกปิดใช้งานแล้ว', 409); end if;

  v_cost := round(coalesce(p_unit_cost, v_item.unit_cost), 2);
  if v_cost < 0 then perform err('ราคาต่อหน่วยติดลบไม่ได้', 400); end if;

  if v_item.kind = 'asset' then
    if p_tag_nos is null or array_length(p_tag_nos, 1) is null then
      perform err('กรุณาระบุเลขครุภัณฑ์อย่างน้อย 1 เลข', 400);
    end if;
    if (select count(distinct x) from unnest(p_tag_nos) x) <> array_length(p_tag_nos, 1) then
      perform err('มีเลขครุภัณฑ์ซ้ำกันในรายการที่กรอก', 400);
    end if;
    foreach v_tag in array p_tag_nos loop
      if exists (select 1 from asset_tags where tag_no = v_tag) then
        perform err(format('เลขครุภัณฑ์ "%s" มีอยู่ในระบบแล้ว', v_tag), 409);
      end if;
    end loop;
    foreach v_tag in array p_tag_nos loop
      v_id := gen_id();
      insert into asset_tags(id, tag_no, item_id, serial_no, status, holder_id, note, created_at, updated_at)
      values (v_id, v_tag, v_item.id, '', 'available', null, coalesce(p_note,''), v_at, v_at);
      -- 1 แถวประวัติต่อ 1 ชิ้น เพื่อให้ตามรอยรายชิ้นได้
      insert into stock_movements(id, at, item_id, asset_tag_id, kind, qty, qty_after, unit_cost, actor_id, note)
      values (gen_id(), v_at, v_item.id, v_id, 'receive', 1,
              (select count(*) from asset_tags t where t.item_id = v_item.id and t.status = 'available'),
              v_cost, p_actor, coalesce(p_note,''));
      v_tags := v_tags || jsonb_build_object('id', v_id, 'tagNo', v_tag);
    end loop;
    if v_cost <> v_item.unit_cost then update items set unit_cost = v_cost, updated_at = v_at where id = v_item.id; end if;
    return jsonb_build_object(
      'qtyAfter', (select count(*) from asset_tags t where t.item_id = v_item.id and t.status = 'available'),
      'tags', v_tags);
  end if;

  if p_qty is null or round(p_qty, 2) <= 0 then perform err('จำนวนที่รับเข้าต้องมากกว่า 0', 400); end if;
  v_after := round(v_item.qty_on_hand + round(p_qty, 2), 2);
  update items set qty_on_hand = v_after, unit_cost = v_cost, updated_at = v_at where id = v_item.id;
  insert into stock_movements(id, at, item_id, kind, qty, qty_after, unit_cost, actor_id, note)
  values (gen_id(), v_at, v_item.id, 'receive', round(p_qty,2), v_after, v_cost, p_actor, coalesce(p_note,''));
  return jsonb_build_object('qtyAfter', v_after, 'tags', '[]'::jsonb);
end $$;

/* ---------- ปรับยอดหลังตรวจนับ ---------- */
-- ส่ง "ยอดจริงที่นับได้" มา ระบบคำนวณผลต่างเอง · บังคับกรอกเหตุผลเพราะเป็นรายการเดียวที่แก้ยอดได้โดยไม่มีของเคลื่อนไหวจริง
create or replace function api_adjust(p_item_id text, p_counted numeric, p_actor text, p_note text)
returns jsonb language plpgsql as $$
declare
  v_item items; v_before numeric; v_diff numeric; v_at bigint := now_ms(); v_note text := btrim(coalesce(p_note,''));
begin
  select * into v_item from items where id = p_item_id for update;
  if not found then perform err('ไม่พบสินค้ารายการนี้', 404); end if;
  if v_item.kind = 'asset' then perform err('ครุภัณฑ์ปรับยอดรวมไม่ได้ ให้แก้สถานะเป็นรายชิ้นแทน', 400); end if;
  if v_note = '' then perform err('กรุณาระบุเหตุผลที่ปรับยอด', 400); end if;
  if p_counted is null or round(p_counted,2) < 0 then perform err('ยอดที่นับได้ต้องไม่ติดลบ', 400); end if;

  v_before := v_item.qty_on_hand;
  v_diff := round(round(p_counted,2) - v_before, 2);
  if v_diff = 0 then perform err('ยอดที่นับได้เท่ากับยอดในระบบอยู่แล้ว ไม่ต้องปรับ', 400); end if;
  -- ปรับยอดลงต่ำกว่าที่จองไว้ไม่ได้ ไม่งั้นใบที่อนุมัติแล้วจะจ่ายไม่ครบ
  if round(p_counted,2) < v_item.qty_reserved then
    perform err(format('ปรับเหลือ %s ไม่ได้ เพราะมีของจองไว้ในใบที่อนุมัติแล้ว %s %s',
                       round(p_counted,2), v_item.qty_reserved, v_item.unit), 409);
  end if;

  update items set qty_on_hand = round(p_counted,2), updated_at = v_at where id = v_item.id;
  insert into stock_movements(id, at, item_id, kind, qty, qty_after, unit_cost, actor_id, note)
  values (gen_id(), v_at, v_item.id, 'adjust', v_diff, round(p_counted,2), v_item.unit_cost, p_actor, v_note);
  return jsonb_build_object('before', v_before, 'after', round(p_counted,2), 'diff', v_diff);
end $$;

/* ---------- เปลี่ยนสถานะครุภัณฑ์รายชิ้น ---------- */
create or replace function api_asset_status(p_tag_id text, p_status text, p_actor text, p_note text)
returns jsonb language plpgsql as $$
declare v_tag asset_tags; v_at bigint := now_ms(); v_qty numeric;
begin
  select * into v_tag from asset_tags where id = p_tag_id for update;
  if not found then perform err('ไม่พบเลขครุภัณฑ์นี้', 404); end if;
  if p_status not in ('available','maintenance','lost','retired') then perform err('สถานะไม่ถูกต้อง', 400); end if;
  if v_tag.status = 'in_use' then
    perform err('ชิ้นนี้อยู่ในมือพนักงาน ต้องรับคืนก่อนจึงจะเปลี่ยนสถานะได้', 409);
  end if;
  if v_tag.status = p_status then perform err('สถานะเดิมอยู่แล้ว', 400); end if;

  update asset_tags set status = p_status, note = coalesce(nullif(p_note,''), note), updated_at = v_at
   where id = v_tag.id;

  -- ออกจากคลัง (หาย/ปลดระวาง/ส่งซ่อม) = -1 · กลับเข้าคลัง = +1 · ระหว่างสถานะที่ไม่อยู่บนชั้นทั้งคู่ = 0
  v_qty := (case when p_status = 'available' then 1 else 0 end)
         - (case when v_tag.status = 'available' then 1 else 0 end);
  if v_qty <> 0 then
    insert into stock_movements(id, at, item_id, asset_tag_id, kind, qty, qty_after, unit_cost, actor_id, note)
    values (gen_id(), v_at, v_tag.item_id, v_tag.id,
            case when p_status = 'lost' then 'write_off' else 'adjust' end, v_qty,
            (select count(*) from asset_tags t where t.item_id = v_tag.item_id and t.status = 'available'),
            0, p_actor, coalesce(nullif(p_note,''), 'เปลี่ยนสถานะเป็น ' || p_status));
  end if;
  return jsonb_build_object('status', p_status);
end $$;

/* ---------- สร้างใบเบิก ---------- */
-- p_lines = [{itemId, qty, note}] · p_submit = true คือส่งเข้าคิวคลังเลย (ออกเลขที่ตอนนี้) · false = เก็บเป็นร่าง
-- ของที่หมดแล้วเบิกไม่ได้ — ตรวจที่นี่ด้วย ไม่พึ่งหน้าเว็บอย่างเดียว เพราะร่างที่เก็บไว้ตอนของยังมีอาจถูกส่งตอนของหมดแล้ว
create or replace function api_create_req(
  p_requester text, p_dept text, p_purpose text, p_need_by bigint, p_submit boolean, p_lines jsonb
) returns jsonb language plpgsql as $$
declare
  v_at bigint := now_ms();
  v_id text := gen_id();
  v_no text;
  v_line jsonb;
  v_item items;
  v_qty numeric;
  v_avail numeric;
  v_seq int := 0;
  v_merged jsonb := '{}'::jsonb;
  v_key text;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    perform err('กรุณาเพิ่มรายการของที่ต้องการเบิกอย่างน้อย 1 รายการ', 400);
  end if;

  -- รวมรายการซ้ำเป็นบรรทัดเดียว กันคลังเห็นของชิ้นเดียวกันสองบรรทัดแล้วจ่ายซ้ำ
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_key := v_line->>'itemId';
    v_merged := jsonb_set(v_merged, array[v_key],
      to_jsonb(coalesce((v_merged->>v_key)::numeric, 0) + coalesce((v_line->>'qty')::numeric, 0)), true);
  end loop;

  for v_key, v_qty in select k, v::text::numeric from jsonb_each(v_merged) as x(k, v) loop
    select * into v_item from items where id = v_key for update;
    if not found then perform err('มีสินค้าในใบที่ไม่พบในระบบแล้ว', 400); end if;
    if not v_item.active then perform err(format('สินค้า "%s" ถูกปิดใช้งานแล้ว', v_item.name), 400); end if;
    if round(v_qty,2) <= 0 then perform err(format('จำนวนของ "%s" ต้องมากกว่า 0', v_item.name), 400); end if;
    if p_submit then
      v_avail := item_available(v_item);
      if v_avail <= 0 then
        perform err(format('"%s" หมดแล้ว เบิกไม่ได้ ให้ติดต่อผู้ดูแลคลัง', v_item.name), 409);
      end if;
      if round(v_qty,2) > v_avail then
        perform err(format('"%s" เหลือ %s %s เบิกได้ไม่เกินนี้', v_item.name, v_avail, v_item.unit), 409);
      end if;
    end if;
  end loop;

  if p_submit then v_no := next_req_no(v_at); end if;
  insert into requisitions(id, no, requester_id, dept_id, status, purpose, need_by, total_cost,
                           submitted_at, created_at, updated_at)
  values (v_id, v_no, p_requester, p_dept,
          case when p_submit then 'pending' else 'draft' end,
          coalesce(p_purpose,''), p_need_by, 0,
          case when p_submit then v_at else null end, v_at, v_at);

  for v_key, v_qty in select k, v::text::numeric from jsonb_each(v_merged) as x(k, v) loop
    v_seq := v_seq + 1;
    insert into requisition_items(id, req_id, item_id, qty_requested, qty_approved, qty_issued, note, seq, created_at, updated_at)
    values (gen_id(), v_id, v_key, round(v_qty,2), 0, 0, '', v_seq, v_at, v_at);
  end loop;

  if p_submit then
    perform notify_role('warehouse', 'new_request', 'ใบเบิกใหม่ ' || v_no,
                        (select name from users where id = p_requester) || ' · ' ||
                        coalesce(nullif(p_purpose,''), 'ไม่ได้ระบุเหตุผล'), 'issue.html');
  end if;
  return jsonb_build_object('id', v_id, 'no', v_no);
end $$;

/* ---------- คลังอนุมัติและจ่ายของในจังหวะเดียว ---------- */
-- p_lines = [{reqItemId, qty}] สำหรับของสิ้นเปลือง · [{reqItemId, tagIds:[], dueAt}] สำหรับครุภัณฑ์
-- บรรทัดที่ไม่ส่งมา หรือส่ง qty = 0 = ไม่จ่ายบรรทัดนั้น · จ่ายไม่ครบ = ปิดใบเป็น partial
create or replace function api_issue(p_req_id text, p_actor text, p_comment text, p_lines jsonb)
returns jsonb language plpgsql as $$
declare
  v_req requisitions;
  v_line requisition_items;
  v_want jsonb;
  v_item items;
  v_give numeric;
  v_tag_ids text[];
  v_tag_id text;
  v_tag asset_tags;
  v_at bigint := now_ms();
  v_total numeric := 0;
  v_any boolean := false;
  v_full boolean := true;
  v_avail numeric;
  v_after numeric;
  v_issued jsonb := '[]'::jsonb;
  v_status text;
begin
  -- ล็อกใบไว้ก่อน: สองคนกด "จ่ายของ" ใบเดียวกันพร้อมกัน คนที่สองจะรอแล้วเจอสถานะที่เปลี่ยนไปแล้ว → 409
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.status <> 'pending' then perform err('ใบนี้ไม่ได้อยู่ในสถานะรอคลัง', 409); end if;

  -- รายการที่ส่งมาต้องอยู่ในใบนี้จริง
  for v_want in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if not exists (select 1 from requisition_items where id = v_want->>'reqItemId' and req_id = v_req.id) then
      perform err('มีรายการที่ไม่ได้อยู่ในใบนี้', 400);
    end if;
  end loop;

  for v_line in select * from requisition_items where req_id = v_req.id order by seq loop
    select * into v_item from items where id = v_line.item_id for update;
    select x into v_want from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
      where x->>'reqItemId' = v_line.id;

    if v_item.kind = 'asset' then
      v_tag_ids := coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(v_want->'tagIds','[]'::jsonb)) value),
        array[]::text[]);
      v_give := coalesce(array_length(v_tag_ids, 1), 0);
    else
      v_tag_ids := array[]::text[];
      v_give := greatest(round(coalesce((v_want->>'qty')::numeric, 0), 2), 0);
    end if;

    if v_give > v_line.qty_requested then
      perform err(format('จ่าย "%s" เกินจำนวนที่ขอมา (ขอ %s %s)', v_item.name, v_line.qty_requested, v_item.unit), 400);
    end if;
    if v_give = 0 then v_full := false; continue; end if;
    if v_give < v_line.qty_requested then v_full := false; end if;

    if v_item.kind = 'asset' then
      foreach v_tag_id in array v_tag_ids loop
        select * into v_tag from asset_tags where id = v_tag_id for update;
        if not found then perform err('ไม่พบเลขครุภัณฑ์ที่เลือก', 400); end if;
        if v_tag.item_id <> v_item.id then
          perform err(format('เลขครุภัณฑ์ %s ไม่ใช่ของ "%s"', v_tag.tag_no, v_item.name), 400);
        end if;
        if v_tag.status <> 'available' then
          perform err(format('เลขครุภัณฑ์ %s ไม่พร้อมจ่าย (%s)', v_tag.tag_no, v_tag.status), 409);
        end if;
        update asset_tags set status = 'in_use', holder_id = v_req.requester_id, issued_at = v_at,
               due_at = nullif(v_want->>'dueAt','')::bigint, updated_at = v_at
         where id = v_tag.id;
        insert into stock_movements(id, at, item_id, asset_tag_id, kind, qty, qty_after, unit_cost, req_item_id, actor_id, note)
        values (gen_id(), v_at, v_item.id, v_tag.id, 'issue', -1,
                (select count(*) from asset_tags t where t.item_id = v_item.id and t.status = 'available'),
                v_item.unit_cost, v_line.id, p_actor, coalesce(p_comment,''));
        v_issued := v_issued || jsonb_build_object('item', v_item.name, 'tagNo', v_tag.tag_no);
      end loop;
    else
      v_avail := item_available(v_item);
      if v_give > v_avail then
        perform err(format('"%s" เบิกได้แค่ %s %s (ขอจ่าย %s)', v_item.name, v_avail, v_item.unit, v_give), 409);
      end if;
      v_after := round(v_item.qty_on_hand - v_give, 2);
      update items set qty_on_hand = v_after, updated_at = v_at where id = v_item.id;
      insert into stock_movements(id, at, item_id, kind, qty, qty_after, unit_cost, req_item_id, actor_id, note)
      values (gen_id(), v_at, v_item.id, 'issue', -v_give, v_after, v_item.unit_cost, v_line.id, p_actor, coalesce(p_comment,''));
      v_issued := v_issued || jsonb_build_object('item', v_item.name, 'qty', v_give, 'unit', v_item.unit);
    end if;

    update requisition_items set qty_approved = v_give, qty_issued = v_give, updated_at = v_at where id = v_line.id;
    v_total := round(v_total + round(v_give * v_item.unit_cost, 2), 2);
    v_any := true;
  end loop;

  if not v_any then
    perform err('ยังไม่ได้เลือกจ่ายของสักรายการ ถ้าไม่จ่ายเลยให้กด "ปฏิเสธ" แทน', 400);
  end if;

  v_status := case when v_full then 'issued' else 'partial' end;
  update requisitions set status = v_status, total_cost = v_total, closed_at = v_at, updated_at = v_at
   where id = v_req.id;
  insert into requisition_approvals(id, req_id, step_no, role_label, approver_id, decision, comment, decided_at, created_at, updated_at)
  values (gen_id(), v_req.id, 1, 'ผู้ดูแลคลัง', p_actor, 'approve', coalesce(p_comment,''), v_at, v_at, v_at);

  perform notify_user(v_req.requester_id, 'decided', 'จ่ายของแล้ว ' || v_req.no,
    case when v_status = 'partial' then 'จ่ายได้บางส่วน ดูรายละเอียดในใบเบิก' else 'รับของครบตามที่ขอแล้ว' end,
    'request.html');

  return jsonb_build_object('status', v_status, 'totalCost', v_total, 'issued', v_issued);
end $$;

/* ---------- ปฏิเสธใบเบิก ---------- */
create or replace function api_reject(p_req_id text, p_actor text, p_comment text)
returns jsonb language plpgsql as $$
declare v_req requisitions; v_at bigint := now_ms(); v_c text := btrim(coalesce(p_comment,''));
begin
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.status <> 'pending' then perform err('ใบนี้ไม่ได้อยู่ในสถานะรอคลัง', 409); end if;
  if v_c = '' then perform err('กรุณาระบุเหตุผลที่ปฏิเสธ', 400); end if;

  update requisitions set status = 'rejected', closed_at = v_at, updated_at = v_at where id = v_req.id;
  insert into requisition_approvals(id, req_id, step_no, role_label, approver_id, decision, comment, decided_at, created_at, updated_at)
  values (gen_id(), v_req.id, 1, 'ผู้ดูแลคลัง', p_actor, 'reject', v_c, v_at, v_at, v_at);
  perform notify_user(v_req.requester_id, 'decided', 'ใบเบิก ' || v_req.no || ' ถูกปฏิเสธ', v_c, 'request.html');
  return jsonb_build_object('ok', true);
end $$;

/* ---------- ผู้ขอยกเลิกใบของตัวเองที่ยังไม่ได้จ่าย ---------- */
create or replace function api_cancel(p_req_id text, p_actor text)
returns jsonb language plpgsql as $$
declare v_req requisitions; v_at bigint := now_ms();
begin
  select * into v_req from requisitions where id = p_req_id for update;
  if not found then perform err('ไม่พบใบเบิกนี้', 404); end if;
  if v_req.requester_id <> p_actor then perform err('ยกเลิกใบเบิกของคนอื่นไม่ได้', 403); end if;
  if v_req.status <> 'pending' then perform err('ยกเลิกได้เฉพาะใบที่ยังรอคลังอยู่', 409); end if;
  update requisitions set status = 'cancelled', closed_at = v_at, updated_at = v_at where id = v_req.id;
  return jsonb_build_object('ok', true);
end $$;

/* ---------- รับคืนครุภัณฑ์ ---------- */
create or replace function api_return_asset(p_tag_id text, p_condition text, p_actor text, p_note text)
returns jsonb language plpgsql as $$
declare v_tag asset_tags; v_back text; v_at bigint := now_ms(); v_item text;
begin
  select * into v_tag from asset_tags where id = p_tag_id for update;
  if not found then perform err('ไม่พบเลขครุภัณฑ์นี้', 404); end if;
  if v_tag.status <> 'in_use' then perform err('ชิ้นนี้ไม่ได้อยู่ในมือใคร', 409); end if;
  v_back := case when p_condition in ('available','maintenance') then p_condition else 'available' end;

  update asset_tags set status = v_back, holder_id = null, issued_at = null, due_at = null,
         note = coalesce(nullif(p_note,''), note), updated_at = v_at
   where id = v_tag.id;

  -- คืนเข้าคลังนับเป็น +1 เฉพาะตอนกลับมาพร้อมใช้ · ถ้ารับคืนแล้วส่งซ่อมต่อ ของยังไม่อยู่บนชั้น
  insert into stock_movements(id, at, item_id, asset_tag_id, kind, qty, qty_after, unit_cost, actor_id, note)
  values (gen_id(), v_at, v_tag.item_id, v_tag.id, 'return',
          case when v_back = 'available' then 1 else 0 end,
          (select count(*) from asset_tags t where t.item_id = v_tag.item_id and t.status = 'available'),
          0, p_actor, coalesce(p_note,''));

  select name into v_item from items where id = v_tag.item_id;
  perform notify_user(v_tag.holder_id, 'decided', 'รับคืนครุภัณฑ์แล้ว', v_item || ' · ' || v_tag.tag_no, 'request.html');
  return jsonb_build_object('status', v_back, 'holderId', v_tag.holder_id);
end $$;

/* ---------- สอบทานว่ายอดคงเหลือยังตรงกับผลรวมประวัติ — ต้องได้ 0 แถวเสมอ ---------- */
-- เทียบด้วย "ผลต่างเกิน 0.005" ไม่ใช่ != ตรง ๆ (บทเรียนจากระบบเดิม: 0.1+0.2 ทำให้ตัวสอบทานโกหก)
create or replace function api_reconcile()
returns table(code text, name text, qty_on_hand numeric, from_ledger numeric) language sql stable as $$
  select i.code, i.name, i.qty_on_hand, coalesce(sum(m.qty), 0) as from_ledger
  from items i left join stock_movements m on m.item_id = i.id
  where i.kind = 'consumable'
  group by i.id, i.code, i.name, i.qty_on_hand
  having abs(i.qty_on_hand - coalesce(sum(m.qty), 0)) > 0.005;
$$;
