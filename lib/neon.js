'use strict';
const { Pool } = require('pg');
const crypto = require('node:crypto');

const pool = new Pool({
  connectionString: process.env.V16_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 3,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 8000,
  statement_timeout: 17000,
  query_timeout: 18000,
  application_name: 'layout-xe-v16-preview'
});

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const error = (message, status=400) => { throw new AppError(message,status); };
const txt = value => String(value == null ? '' : value).trim();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const checkString = (value, label, max) => {
  if (typeof value !== 'string' && typeof value !== 'number' && value != null) error(label+' không hợp lệ.');
  const result = txt(value);
  if (result.length > max) error(label+' vượt quá '+max+' ký tự.');
  return result;
};
const assertArgs = (args, count) => {
  if (!Array.isArray(args) || args.length !== count) error('Số tham số API không hợp lệ.');
};
const slotsQuery = `
  SELECT s.slot_id AS id, l.name AS layout, s.row_no AS row, s.col_no AS col,
         s.vehicle_name AS vehicle, s.po
    FROM public.slots s JOIN public.layouts l ON l.id = s.layout_id
   ORDER BY s.layout_id, s.row_no, s.col_no`;
const mapSlot = row => ({ id:row.id, layout:row.layout, row:Number(row.row),
                          col:Number(row.col), vehicle:row.vehicle||'', po:row.po||'' });

async function assertDbBranch(db) {
  const marker = await db.query("SELECT value FROM public.app_settings WHERE key = 'V16_DB_TAG'");
  const expected = txt(process.env.V16_EXPECTED_DB_TAG);
  if (!expected || marker.rows[0]?.value !== expected) {
    error('Sai nhánh database Neon hoặc chưa chạy 04_mark_dev_v16.sql. Đã chặn thao tác.',503);
  }
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Tuần tự hóa thao tác ghi để bảo toàn tọa độ và xe khi nhiều admin sửa cùng lúc.
    await client.query('SELECT pg_advisory_xact_lock(162016, 1)');
    await assertDbBranch(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}
async function requireAdmin(db, token) {
  const t = txt(token);
  if (!/^[a-f\d]{64}$/i.test(t)) error('Trang đang bị khóa. Vui lòng mở khóa quản trị.',403);
  const tokenHash = sha256(process.env.V16_SESSION_SECRET+':'+t);
  const { rows } = await db.query(
    'SELECT 1 FROM public.admin_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
    [tokenHash]);
  if (!rows.length) error('Phiên quản trị hết hạn hoặc không hợp lệ. Hãy mở khóa lại.',403);
}
async function addLog(db, action, id, before, after) {
  await db.query('INSERT INTO public.activity_logs (action,slot_id,before_data,after_data) VALUES ($1,$2,$3::jsonb,$4::jsonb)',
    [action,id||null,before == null ? null : JSON.stringify(before),after == null ? null:JSON.stringify(after)]);
}
async function readSlot(db, id) {
  const { rows } = await db.query('SELECT slot_id,layout_id,row_no,col_no,vehicle_name,po FROM public.slots WHERE slot_id=$1 FOR UPDATE',[id]);
  if (!rows.length) error('Không tìm thấy vị trí: '+id,404);
  return rows[0];
}
function compactSlot(row) {return {id:row.slot_id,layout_id:row.layout_id,row:row.row_no,col:row.col_no,vehicle:row.vehicle_name,po:row.po};}
async function getLayoutData(db) {return (await db.query(slotsQuery)).rows.map(mapSlot);}
async function getVehicleList(db) {
  return Array.from(new Set((await getLayoutData(db)).map(item=>txt(item.vehicle)).filter(Boolean)))
    .sort((a,b)=>a.localeCompare(b,'vi'));
}
async function getVehicleNotes(db) {
  const {rows}=await db.query('SELECT vehicle_name,note FROM public.vehicle_notes');
  const result={};for(const row of rows)result[row.vehicle_name]=row.note||'';
  return result;
}
async function getSiteNotice(db) {
  const {rows}=await db.query("SELECT key,value FROM public.app_settings WHERE key IN ('SITE_NOTICE_TITLE','SITE_NOTICE_CONTENT')");
  const props=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  return {title:props.SITE_NOTICE_TITLE||'',content:props.SITE_NOTICE_CONTENT||''};
}
async function getAppBootstrap(db) {
  const {rows}=await db.query(`
    SELECT
      (SELECT COALESCE(json_agg(json_build_object('id',s.slot_id,'layout',l.name,'row',s.row_no,
                'col',s.col_no,'vehicle',s.vehicle_name,'po',s.po) ORDER BY s.layout_id,s.row_no,s.col_no),'[]'::json)
         FROM public.slots s JOIN public.layouts l ON l.id=s.layout_id) AS slots,
      (SELECT COALESCE(json_object_agg(vehicle_name,note),'{}'::json) FROM public.vehicle_notes) AS notes,
      (SELECT COALESCE(json_object_agg(key,value),'{}'::json) FROM public.app_settings
         WHERE key IN ('SITE_NOTICE_TITLE','SITE_NOTICE_CONTENT')) AS settings`);
  const slots = (rows[0].slots || []).map(mapSlot);
  const notes = rows[0].notes || {};
  const settings=rows[0].settings||{};
  return {
    getLayoutData:slots,
    getVehicleList:Array.from(new Set(slots.map(x=>txt(x.vehicle)).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'vi')),
    getVehicleNotes:notes,
    getSiteNotice:{title:settings.SITE_NOTICE_TITLE||'',content:settings.SITE_NOTICE_CONTENT||''}
  };
}

async function verifyAdminPin(db, pin, req) {
  const configured = process.env.V16_ADMIN_PIN;
  if (!configured || configured.length<4) error('Chưa thiết lập V16_ADMIN_PIN ở Vercel Preview.',503);
  const address = txt(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0];
  const actor = crypto.createHmac('sha256',process.env.V16_SESSION_SECRET).update('pin-attempt:'+address).digest('hex');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await assertDbBranch(client);
    await client.query('INSERT INTO public.admin_login_attempts(actor_hash) VALUES ($1) ON CONFLICT DO NOTHING',[actor]);
    const {rows}=await client.query('SELECT * FROM public.admin_login_attempts WHERE actor_hash=$1 FOR UPDATE',[actor]);
    const state=rows[0];
    if(state.blocked_until && new Date(state.blocked_until).getTime()>Date.now()) {
      await client.query('COMMIT');
      error('Đã thử sai PIN quá nhiều lần. Vui lòng thử lại sau 15 phút.',429);
    }
    const received = Buffer.from(sha256(txt(pin)),'hex');
    const correct = Buffer.from(sha256(configured),'hex');
    const valid=crypto.timingSafeEqual(received,correct);
    if(!valid){
      const fresh=Date.now()-new Date(state.first_failed_at).getTime() > 15*60*1000;
      const failures=fresh ? 1 : Number(state.failures)+1;
      const blockedUntil=failures>=5 ? new Date(Date.now()+15*60*1000) : null;
      await client.query('UPDATE public.admin_login_attempts SET failures=$2,first_failed_at=$3,blocked_until=$4 WHERE actor_hash=$1',
        [actor,failures,fresh?new Date():state.first_failed_at,blockedUntil]);
      await client.query('COMMIT');
      return {success:false};
    }
    await client.query('DELETE FROM public.admin_login_attempts WHERE actor_hash=$1',[actor]);
    const token=crypto.randomBytes(32).toString('hex');
    const tokenHash=sha256(process.env.V16_SESSION_SECRET+':'+token);
    await client.query("INSERT INTO public.admin_sessions(token_hash,expires_at) VALUES($1,now()+interval '6 hours')",[tokenHash]);
    await client.query('COMMIT');
    return {success:true,token};
  } catch(e) {
    try{await client.query('ROLLBACK');}catch(_){}
    throw e;
  } finally {client.release();}
}
async function revokeAdminToken(db, token){
  const t=txt(token);
  if(t && /^[a-f\d]{64}$/i.test(t))await db.query('UPDATE public.admin_sessions SET revoked_at=now() WHERE token_hash=$1',
    [sha256(process.env.V16_SESSION_SECRET+':'+t)]);
  return {success:true};
}

async function updateSlotVehicle([slotId,vehicleName,token]) {
  const id=checkString(slotId,'ID vị trí',64), name=checkString(vehicleName,'Tên xe',1000);
  return transaction(async db=>{
    await requireAdmin(db,token);
    const old=await readSlot(db,id);
    const newPo=name ? old.po : '';
    await db.query('UPDATE public.slots SET vehicle_name=$2,po=$3,updated_at=now() WHERE slot_id=$1',[id,name,newPo]);
    await addLog(db,'updateSlotVehicle',id,compactSlot(old),{...compactSlot(old),vehicle:name,po:newPo});
    return {success:true,id,vehicle:name};
  });
}
async function saveVehicleAndNote([slotId,vehicleName,note,po,token]) {
  const id=checkString(slotId,'ID vị trí',64),name=checkString(vehicleName,'Tên xe',1000);
  const content=checkString(note,'Ghi chú',5000), value=checkString(po,'PO',150);
  return transaction(async db=>{
    await requireAdmin(db,token);
    const old=await readSlot(db,id);
    if(name){
      await db.query(`INSERT INTO public.vehicle_notes(vehicle_name,note,updated_at) VALUES($1,$2,now())
                      ON CONFLICT(vehicle_name) DO UPDATE SET note=EXCLUDED.note,updated_at=now()`,[name,content]);
    }
    const actualPo=name ? value:'';
    await db.query('UPDATE public.slots SET vehicle_name=$2,po=$3,updated_at=now() WHERE slot_id=$1',[id,name,actualPo]);
    if(old.vehicle_name && old.vehicle_name!==name){
      const {rows}=await db.query('SELECT 1 FROM public.slots WHERE vehicle_name=$1 LIMIT 1',[old.vehicle_name]);
      if(!rows.length)await db.query('DELETE FROM public.vehicle_notes WHERE vehicle_name=$1',[old.vehicle_name]);
    }
    await addLog(db,'saveVehicleAndNote',id,compactSlot(old),{...compactSlot(old),vehicle:name,po:actualPo,note:content});
    return {success:true,id,vehicle:name};
  });
}
async function swapSlots([idA,idB,token]) {
  const a=checkString(idA,'ID nguồn',64),b=checkString(idB,'ID đích',64);
  if(!a||!b)error('Thiếu ID vị trí.');
  return transaction(async db=>{
    await requireAdmin(db,token);
    if(a===b)return {success:true};
    const first=await readSlot(db,a),second=await readSlot(db,b);
    await db.query('UPDATE public.slots SET vehicle_name=$2,po=$3,updated_at=now() WHERE slot_id=$1',
      [a,second.vehicle_name,second.po]);
    await db.query('UPDATE public.slots SET vehicle_name=$2,po=$3,updated_at=now() WHERE slot_id=$1',
      [b,first.vehicle_name,first.po]);
    await addLog(db,'swapSlots',a,{from:compactSlot(first),to:compactSlot(second)},
      {from:{...compactSlot(first),vehicle:second.vehicle_name,po:second.po},to:{...compactSlot(second),vehicle:first.vehicle_name,po:first.po}});
    return {success:true};
  });
}
async function moveVehicle([sourceId,targetId,token]) {
  const a=checkString(sourceId,'ID nguồn',64),b=checkString(targetId,'ID đích',64);
  if(!a||!b||a===b)error('Vị trí nguồn và đích không hợp lệ.');
  return transaction(async db=>{
    await requireAdmin(db,token);
    const first=await readSlot(db,a),second=await readSlot(db,b);
    if(!first.vehicle_name)error('Vị trí nguồn không có xe.',409);
    if(second.vehicle_name)error('Vị trí đích đã có xe. Hãy sử dụng Đổi chỗ.',409);
    await db.query('UPDATE public.slots SET vehicle_name=$2,po=$3,updated_at=now() WHERE slot_id=$1',
      [b,first.vehicle_name,first.po]);
    await db.query("UPDATE public.slots SET vehicle_name='',po='',updated_at=now() WHERE slot_id=$1",[a]);
    await addLog(db,'moveVehicle',a,{from:compactSlot(first),to:compactSlot(second)},
      {from:{...compactSlot(first),vehicle:'',po:''},to:{...compactSlot(second),vehicle:first.vehicle_name,po:first.po}});
    return {success:true};
  });
}

async function getLayoutConfig(db, name) {
  const {rows}=await db.query('SELECT * FROM public.layouts WHERE name=$1 FOR UPDATE',[name]);
  if(!rows.length)error('Layout không hợp lệ: '+name);
  return rows[0];
}
async function layoutShape(db, layoutId){
  const {rows}=await db.query(`SELECT coalesce(max(row_no),0)::int AS rows, coalesce(max(col_no),0)::int AS cols,
                                 array_agg(slot_id) AS ids FROM public.slots WHERE layout_id=$1`,[layoutId]);
  return rows[0];
}
function getNextNumber(ids){
  let max=0;
  for(const id of ids||[]){const match=String(id).match(/-(\d+)$/);if(match)max=Math.max(max,Number(match[1]));}
  return max+1;
}
function newSlotId(prefix,index){return prefix+'-'+String(index).padStart(2,'0');}
async function addLayoutRow([nameValue,token]){
  const name=checkString(nameValue,'Layout',40);
  await transaction(async db=>{
    await requireAdmin(db,token);
    const layout=await getLayoutConfig(db,name);
    const shape=await layoutShape(db,layout.id);
    const nextRow=shape.rows+1, count=shape.cols||layout.default_cols;
    let index=getNextNumber(shape.ids);
    for(let col=1;col<=count;col++){
      await db.query('INSERT INTO public.slots(slot_id,layout_id,row_no,col_no) VALUES($1,$2,$3,$4)',
        [newSlotId(layout.prefix,index++),layout.id,nextRow,col]);
    }
    await addLog(db,'addLayoutRow',null,null,{layout:name,row:nextRow,cols:count});
  });
  const db=await pool.connect();try{return getLayoutData(db);}finally{db.release();}
}
async function addLayoutColumn([nameValue,token]){
  const name=checkString(nameValue,'Layout',40);
  await transaction(async db=>{
    await requireAdmin(db,token);
    const layout=await getLayoutConfig(db,name);
    const shape=await layoutShape(db,layout.id);
    const nextCol=shape.cols+1,count=shape.rows||layout.default_rows;
    let index=getNextNumber(shape.ids);
    for(let row=1;row<=count;row++){
      await db.query('INSERT INTO public.slots(slot_id,layout_id,row_no,col_no) VALUES($1,$2,$3,$4)',
        [newSlotId(layout.prefix,index++),layout.id,row,nextCol]);
    }
    await addLog(db,'addLayoutColumn',null,null,{layout:name,col:nextCol,rows:count});
  });
  const db=await pool.connect();try{return getLayoutData(db);}finally{db.release();}
}
async function deleteLayoutRow([nameValue,token]){
  const name=checkString(nameValue,'Layout',40);
  return transaction(async db=>{
    await requireAdmin(db,token);
    const layout=await getLayoutConfig(db,name);
    const shape=await layoutShape(db,layout.id);
    if(shape.rows<=1)error(name+' phải còn ít nhất 1 hàng.');
    const {rows}=await db.query('SELECT * FROM public.slots WHERE layout_id=$1 AND row_no=$2 ORDER BY col_no',[layout.id,shape.rows]);
    const occupied=rows.filter(r=>r.vehicle_name||r.po);
    if(occupied.length)error('Không thể xóa hàng '+shape.rows+' vì đang có xe: '+occupied.map(r=>r.vehicle_name).join(', '),409);
    await db.query('DELETE FROM public.slots WHERE layout_id=$1 AND row_no=$2',[layout.id,shape.rows]);
    await addLog(db,'deleteLayoutRow',null,{removedSlots:rows},null);
    return {success:true,layout:name,deletedRow:shape.rows};
  });
}
async function deleteLayoutColumn([nameValue,token]){
  const name=checkString(nameValue,'Layout',40);
  return transaction(async db=>{
    await requireAdmin(db,token);
    const layout=await getLayoutConfig(db,name);
    const shape=await layoutShape(db,layout.id);
    if(shape.cols<=1)error(name+' phải còn ít nhất 1 cột.');
    const {rows}=await db.query('SELECT * FROM public.slots WHERE layout_id=$1 AND col_no=$2 ORDER BY row_no',[layout.id,shape.cols]);
    const occupied=rows.filter(r=>r.vehicle_name||r.po);
    if(occupied.length)error('Không thể xóa cột '+shape.cols+' vì đang có xe: '+occupied.map(r=>r.vehicle_name).join(', '),409);
    await db.query('DELETE FROM public.slots WHERE layout_id=$1 AND col_no=$2',[layout.id,shape.cols]);
    await addLog(db,'deleteLayoutColumn',null,{removedSlots:rows},null);
    return {success:true,layout:name,deletedColumn:shape.cols};
  });
}
async function saveSiteNotice([titleValue,contentValue,token]) {
  const title=checkString(titleValue,'Tiêu đề',200),content=checkString(contentValue,'Nội dung',20000);
  if(!title)error('Vui lòng nhập tiêu đề thông báo.');
  return transaction(async db=>{
    await requireAdmin(db,token);
    const prior=await getSiteNotice(db);
    await db.query("INSERT INTO public.app_settings(key,value,updated_at) VALUES ('SITE_NOTICE_TITLE',$1,now()),('SITE_NOTICE_CONTENT',$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
      [title,content]);
    await addLog(db,'saveSiteNotice',null,prior,{title,content});
    return {title,content};
  });
}

const actions = {
  getAppBootstrap:{count:0,run:(db)=>getAppBootstrap(db)},
  getLayoutData:{count:0,run:(db)=>getLayoutData(db)},
  getVehicleList:{count:0,run:(db)=>getVehicleList(db)},
  getVehicleNotes:{count:0,run:(db)=>getVehicleNotes(db)},
  getSiteNotice:{count:0,run:(db)=>getSiteNotice(db)},
  verifyAdminPin:{count:1,ownsConnection:true,run:(_db,args,req)=>verifyAdminPin(null,args[0],req)},
  revokeAdminToken:{count:1,run:(db,args)=>revokeAdminToken(db,args[0])},
  saveSiteNotice:{ownsConnection:true,count:3,run:(_db,args)=>saveSiteNotice(args)},
  updateSlotVehicle:{ownsConnection:true,count:3,run:(_db,args)=>updateSlotVehicle(args)},
  saveVehicleAndNote:{ownsConnection:true,count:5,run:(_db,args)=>saveVehicleAndNote(args)},
  swapSlots:{ownsConnection:true,count:3,run:(_db,args)=>swapSlots(args)},
  moveVehicle:{ownsConnection:true,count:3,run:(_db,args)=>moveVehicle(args)},
  addLayoutRow:{ownsConnection:true,count:2,run:(_db,args)=>addLayoutRow(args)},
  addLayoutColumn:{ownsConnection:true,count:2,run:(_db,args)=>addLayoutColumn(args)},
  deleteLayoutRow:{ownsConnection:true,count:2,run:(_db,args)=>deleteLayoutRow(args)},
  deleteLayoutColumn:{ownsConnection:true,count:2,run:(_db,args)=>deleteLayoutColumn(args)}
};

async function handleNeon(req,res) {
  if(req.method!=='POST')return res.status(405).json({success:false,error:'Chỉ hỗ trợ POST.'});
  if(!process.env.V16_DATABASE_URL || !process.env.V16_SESSION_SECRET || process.env.V16_SESSION_SECRET.length<32 || !process.env.V16_EXPECTED_DB_TAG)
    return res.status(503).json({success:false,error:'Chưa thiết lập biến môi trường Neon V16 Preview.'});
  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if(!data || typeof data.action!=='string' || !Array.isArray(data.args))error('API yêu cầu action và args.',400);
    const action=actions[data.action];
    if(!action)error('API chưa hỗ trợ: '+data.action,400);
    assertArgs(data.args,action.count);
    if(Buffer.byteLength(JSON.stringify(data),'utf8')>120000)error('Yêu cầu quá lớn.',413);
    let result;
    if(action.ownsConnection) {
      // Ghi hoặc xác thực tự quản lý transaction riêng, không chiếm thêm một pool client.
      result = await action.run(null,data.args,req);
    } else {
      const db=await pool.connect();
      try {
        await assertDbBranch(db);
        result = await action.run(db,data.args,req);
      } finally {db.release();}
    }
    res.setHeader('Cache-Control','no-store, private');
    return res.status(200).json({success:true,data:result});
  } catch(e) {
    // Không tiết lộ chuỗi kết nối hoặc câu SQL qua phản hồi công khai.
    if(!(e instanceof AppError)) {
      console.error('V16 database error', {name:e.name,code:e.code,message:e.message});
    }
    return res.status(e instanceof AppError ? e.status:500).json({
      success:false,
      error:e instanceof AppError ? e.message : 'Lỗi dữ liệu PostgreSQL. Kiểm tra Vercel Function Logs.'
    });
  }
}
module.exports={handleNeon,AppError};
