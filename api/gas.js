'use strict';
/**
 * Cùng endpoint /api/gas để giao diện V15 không cần đổi lệnh gọi.
 * Production giữ backend Apps Script cũ, trừ khi người quản trị CHỦ ĐỘNG bật V16_ENABLE_PRODUCTION=1.
 * Preview kết nối Neon nhánh dev-v16.
 */
const legacy = require('../lib/gas-legacy');
const {handleNeon}=require('../lib/neon');
module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(process.env.VERCEL_ENV==='production' && process.env.V16_ENABLE_PRODUCTION!=='1') {
    return legacy(req,res);
  }
  return handleNeon(req,res);
};
