'use strict';
const { Pool } = require('pg');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(process.env.VERCEL_ENV==='production')return res.status(404).json({ok:false,error:'Chỉ có trong Preview.'});
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'Chỉ hỗ trợ GET.'});
  if(!process.env.V16_DATABASE_URL || !process.env.V16_EXPECTED_DB_TAG)
    return res.status(503).json({ok:false,error:'Chưa cấu hình Neon Preview.'});
  const pool=new Pool({connectionString:process.env.V16_DATABASE_URL,ssl:{rejectUnauthorized:true},max:1,
    connectionTimeoutMillis:8000,idleTimeoutMillis:5000});
  try{
    const {rows}=await pool.query(`SELECT
      (SELECT value FROM public.app_settings WHERE key='V16_DB_TAG') AS db_tag,
      (SELECT count(*)::int FROM public.slots) AS total,
      (SELECT count(*)::int FROM public.slots WHERE btrim(vehicle_name)<>'') AS filled,
      (SELECT count(*)::int FROM public.slots WHERE btrim(vehicle_name)='') AS empty,
      (SELECT count(*)::int FROM public.vehicle_notes) AS notes`);
    const row=rows[0];
    if(row.db_tag!==process.env.V16_EXPECTED_DB_TAG)
      return res.status(503).json({ok:false,error:'Sai nhánh Neon hoặc chưa đánh dấu branch.'});
    return res.status(200).json({ok:true,source:'neon-postgresql',counts:{total:row.total,filled:row.filled,empty:row.empty,notes:row.notes}});
  }catch(e){
    console.error('V16 health check',e.message);
    return res.status(503).json({ok:false,error:'Chưa đọc được database. Kiểm tra kết nối và Logs.'});
  }finally{await pool.end().catch(()=>{});}
};
