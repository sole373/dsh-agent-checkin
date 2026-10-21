/**
 * 千问办公 (QwenWorkCN) 凭证解密助手 —— AES-256-GCM
 *
 * 为什么需要这个 JS 助手
 * ----------------------
 * 千问办公用 Electron 的 `safeStorage.encryptString()` 保存登录态，
 * 在 Windows 上的落地格式就是 Chromium OSCrypt 的 **v10** 格式：
 *
 *     "v10" + nonce(12 字节) + ciphertext + authTag(16 字节)
 *
 * 其中密钥来自 userData/Local State 的 `os_crypt.encrypted_key`
 * （一个被 DPAPI 保护住的 32 字节 AES 密钥）。
 *
 * 拆成两步是因为两边各有各的强项，硬凑一边都要付出额外代价：
 *   - DPAPI（CryptUnprotectData）→ Python 的 ctypes 直接调，零依赖；
 *   - AES-256-GCM → Python 标准库**没有** AES，装 pycryptodome/cryptography
 *     会引入 pip 依赖；而 Node 的 `crypto` 模块内置支持，本机必有。
 * 于是：Python 解密钥 → 本脚本解数据。全程不落盘任何明文。
 *
 * 用法
 * ----
 *     node qw_gcm.js <密钥hex文件> <密文hex文件>
 *
 * 成功：stdout 输出明文的 hex；失败：stderr 输出 ERR <原因>，退出码 1。
 */

"use strict";
const fs = require("fs");
const crypto = require("crypto");

const keyPath = process.argv[2];
const inPath = process.argv[3];

if (!keyPath || !inPath) {
  process.stderr.write("ERR 用法: node qw_gcm.js <密钥hex文件> <密文hex文件>");
  process.exit(1);
}

try {
  const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
  const raw = Buffer.from(fs.readFileSync(inPath, "utf8").trim(), "hex");

  if (key.length !== 32) {
    throw new Error(`主密钥长度应为 32 字节，实际 ${key.length}`);
  }
  // 3(v10) + 12(nonce) + 16(tag) 是最小的合法长度
  if (raw.length < 3 + 12 + 16) {
    throw new Error(`密文过短：${raw.length} 字节`);
  }

  const ver = raw.slice(0, 3).toString("latin1");
  if (ver !== "v10") {
    throw new Error(`未知版本前缀 ${JSON.stringify(ver)}（只支持 v10）`);
  }

  const body = raw.slice(3);
  const nonce = body.slice(0, 12);
  const tag = body.slice(-16);
  const ct = body.slice(12, body.length - 16);

  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]);

  process.stdout.write(out.toString("hex"));
} catch (e) {
  process.stderr.write("ERR " + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
