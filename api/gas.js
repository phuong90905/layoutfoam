const ALLOWED = new Set(["getLayoutData", "getVehicleList", "getVehicleNotes", "getSiteNotice", "verifyAdminPin", "revokeAdminToken", "saveSiteNotice", "swapSlots", "moveVehicle", "saveVehicleAndNote", "updateSlotVehicle", "addLayoutRow", "addLayoutColumn", "deleteLayoutRow", "deleteLayoutColumn"]);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({success:false,error:'Method not allowed'});
  const url = process.env.GAS_WEB_APP_URL;
  const secret = process.env.GAS_API_SECRET;
  if (!url || !secret || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url))
    return res.status(500).json({success:false,error:'Thiếu hoặc sai cấu hình GAS_WEB_APP_URL / GAS_API_SECRET'});
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || !ALLOWED.has(body.action) || !Array.isArray(body.args) || body.args.length > 20)
      return res.status(400).json({success:false,error:'Yêu cầu không hợp lệ'});
    if (Buffer.byteLength(JSON.stringify(body),'utf8') > 120000)
      return res.status(413).json({success:false,error:'Yêu cầu quá lớn'});
    const response = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action:body.action,args:body.args,secret}),
      redirect:'follow',
      signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) return res.status(502).json({success:false,error:'Apps Script HTTP '+response.status});
    const result = await response.json();
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(502).json({success:false,error:'Lỗi kết nối Apps Script: '+err.message});
  }
};
