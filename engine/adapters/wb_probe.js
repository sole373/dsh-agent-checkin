// WorkBuddy 客户端运行时能力探测
// 用途：确认 Electron 原生绑定 electron_browser_workbuddy_storage 是否可用，
//      以及 loggerGet() 返回的字段名（不打印密钥内容）。
// 运行：ELECTRON_RUN_AS_NODE=1 "<WorkBuddy.exe>" "<本文件路径>"

try {
  const binding = process._linkedBinding('electron_browser_workbuddy_storage');
  const payload = JSON.parse(binding.loggerGet());
  console.log('BINDING_OK');
  console.log('KEYS=' + Object.keys(payload).join(','));
  const s = payload.atRestSecretKey;
  console.log('HAS_SECRET=' + (typeof s === 'string'));
  console.log('SECRET_LEN=' + ((s || '').length));
} catch (e) {
  console.log('BINDING_FAIL: ' + (e && e.message ? e.message : String(e)));
}
