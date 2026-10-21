// WorkBuddy 凭据解密助手
// ─────────────────────────────────────────────────────────────
// 由 workbuddy.py 通过 ELECTRON_RUN_AS_NODE=1 调用 WorkBuddy.exe 运行本文件。
// 为什么必须走客户端运行时：atRestSecretKey 只能通过 Electron 原生绑定
// `electron_browser_workbuddy_storage` 拿到，独立 Node 环境无法取得。
//
// 通信协议：
//   stdin  ← JSON {"operation":"decrypt"|"probe", "value": <$wbEncrypted 对象>}
//   stdout → JSON {"ok":true, ...} 或 {"ok":false, "error":"<代码>"}
// 明文只经 stdout 返回，不出现在命令行参数里。

const crypto = require('crypto');
const fs = require('fs');

const AAD_PREFIX = 'WB-AAD\0';
const FIELD = 'WBEV1';
const SUITE_NAME = 'sym-v1';

function lengthPrefixed(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function buildAad(keyId) {
  return Buffer.concat([
    Buffer.from(AAD_PREFIX, 'ascii'),
    Buffer.from([1]),
    lengthPrefixed(FIELD),
    lengthPrefixed(SUITE_NAME),
    Buffer.from([0, 0, 0, 1]),
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let n;
  try {
    while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, n)));
      if (chunks.reduce((a, c) => a + c.length, 0) > 65536) break;
    }
  } catch (e) {
    // EOF
  }
  return Buffer.concat(chunks).toString('utf8');
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function fail(code) {
  out({ ok: false, error: code });
  process.exit(0);
}

function main() {
  let req;
  try {
    req = JSON.parse(readStdin());
  } catch (e) {
    return fail('BAD_INPUT');
  }
  const operation = req.operation || 'decrypt';

  let payload;
  try {
    const binding = process._linkedBinding('electron_browser_workbuddy_storage');
    payload = JSON.parse(binding.loggerGet());
  } catch (e) {
    return fail('RUNTIME_UNAVAILABLE');
  }

  const secretStr = payload.atRestSecretKey;
  if (typeof secretStr !== 'string' || !secretStr) {
    return fail('RUNTIME_UNAVAILABLE');
  }

  if (operation === 'probe') {
    return out({ ok: true, probe: true, hasSecret: true, secretLength: secretStr.length });
  }

  const value = req.value;
  if (!value || typeof value !== 'object' ||
      value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') {
    return fail('UNSUPPORTED_ENVELOPE');
  }

  let env;
  try {
    env = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  } catch (e) {
    return fail('BAD_ENVELOPE');
  }

  const keys = Object.keys(env).sort().join(',');
  if (keys !== 'authTag,ciphertext,keyId,nonce,suite') {
    return fail('BAD_ENVELOPE');
  }
  if (env.suite !== 1 && env.suite !== SUITE_NAME) {
    return fail('UNSUPPORTED_SUITE');
  }
  if (typeof env.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(env.keyId)) {
    return fail('BAD_KEYID');
  }

  let nonce, tag, ct;
  try {
    nonce = Buffer.from(env.nonce, 'base64');
    tag = Buffer.from(env.authTag, 'base64');
    ct = Buffer.from(env.ciphertext, 'base64');
  } catch (e) {
    return fail('BAD_ENVELOPE');
  }
  if (nonce.length !== 12 || tag.length !== 16 || ct.length === 0) {
    return fail('BAD_ENVELOPE');
  }

  // 密钥派生：sha256( atRestSecretKey 字符串 )，再用 sha256(key) 的前 16 位十六进制校验 keyId
  const key = crypto.createHash('sha256').update(secretStr, 'utf8').digest();
  const derivedKeyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (derivedKeyId !== env.keyId) {
    return fail('KEY_MISMATCH');
  }

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(buildAad(env.keyId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    return fail('DECRYPT_FAILED');
  }

  if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(plaintext)) {
    return fail('INVALID_FORMAT');
  }

  out({ ok: true, accessToken: plaintext });
}

main();
