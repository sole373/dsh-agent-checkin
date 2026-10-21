/**
 * 百度搭子 DuMate 凭证解密助手 —— AES-256-GCM（非标准字段布局）
 *
 * 为什么需要这个 JS 助手
 * ----------------------
 * DuMate（Electron 应用）把登录 Cookie 加密后存在
 * `%APPDATA%\qianfan-desktop-app\auth.json` 的
 * `accountProfiles[activeProfileId].encryptedCookies`（base64）。
 * 密钥是同目录下的 `.cookie-key`（32 字节原始二进制，AES-256）。
 *
 * ⚠️ 与 Chromium OSCrypt v10 的差异（本助手存在的理由）
 * ----------------------------------------------------
 * v10 布局是：  "v10" + nonce(12) + ciphertext + authTag(16)   ← tag 在末尾
 * DuMate 布局是：        nonce(12) + authTag(16) + ciphertext   ← tag 在中间
 * 且**没有** "v10" 前缀。首轮按 v10 布局解会报
 * "Unsupported state or unable to authenticate data"（tag 校验失败），
 * 逐字段枚举后才定位到真实布局（见 2026-10-12 实测）。
 *
 * 拆成 Node 助手的原因与 qw_gcm.js 一致：Python 标准库没有 AES，
 * 装 pycryptodome/cryptography 会引入 pip 依赖；Node 的 crypto 内置支持。
 * 全程只经内存与临时文件，不落盘明文副本。
 *
 * 用法
 * ----
 *     node dumate_gcm.js <密钥hex文件> <密文hex文件>
 *
 * 成功：stdout 输出明文的 hex；失败：stderr 输出 ERR <原因>，退出码 1。
 */

"use strict";
const fs = require("fs");
const crypto = require("crypto");

const keyPath = process.argv[2];
const inPath = process.argv[3];

if (!keyPath || !inPath) {
  process.stderr.write("ERR 用法: node dumate_gcm.js <密钥hex文件> <密文hex文件>");
  process.exit(1);
}

try {
  const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
  const raw = Buffer.from(fs.readFileSync(inPath, "utf8").trim(), "hex");

  if (key.length !== 32) {
    throw new Error(`主密钥长度应为 32 字节，实际 ${key.length}`);
  }
  // 12(nonce) + 16(tag) 是最小的合法长度
  if (raw.length < 12 + 16) {
    throw new Error(`密文过短：${raw.length} 字节`);
  }

  // DuMate 布局：nonce(12) | tag(16) | ciphertext
  const nonce = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const ct = raw.slice(28);

  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]);

  process.stdout.write(out.toString("hex"));
} catch (e) {
  process.stderr.write("ERR " + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
