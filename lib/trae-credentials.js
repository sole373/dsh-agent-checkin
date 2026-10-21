/**
 * TRAE 桌面端凭据读取：从客户端自存的 storage.json 里解出登录态。
 *
 * 为什么在 Node 里再实现一遍解密
 * ------------------------------
 * 签到侧已经有一份等价的 Python 实现（`engine/adapters/trae.py`），它跑在
 * 子进程里。但模型接入这条路是**进程内**的：pi-ai 的请求要带着 token 直连
 * TRAE 网关，把凭证先落成中间文件、再由 shim 读回来，等于凭空多造一个
 * 「临时凭据副本」的攻击面。所以这里直接在 Node 里解，明文只存在于内存。
 *
 * 解密契约（与 Python 版逐字节一致，2026-10-17 本机实测交叉验证通过）
 * ------------------------------------------------------------------
 *   buf        = [6 字节头][32 字节随机块 rb][密文 enc]
 *   h          = sha512(rb)
 *   fh         = sha512(h + SALT_AES)
 *   key        = fh[:16]，iv = fh[16:32]
 *   decrypted  = AES-128-CBC-decrypt(key, iv, enc)   ← 长度 1824 的纯噪声
 *   明文       = decrypted[64:]，末尾按 PKCS#7 剥掉填充
 *
 * 凭证只在本进程内存里，不写盘、不进日志、不进命令行参数。
 *
 * @module dsh-agent-checkin/trae-credentials
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** storage.json 里存登录态的键名。 */
export const STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'

/** 设备号可以藏在这些键的后缀里：`iCubeAuthInfo://icube-dc:<deviceId>`。 */
const STORAGE_KEY_DC_PREFIX = 'iCubeAuthInfo://icube-dc:'

/** 未声明 host 时的兜底网关（与 `engine/adapters/trae.py` 的 API_HOST 一致）。 */
export const DEFAULT_HOST = 'https://api.trae.cn'

/**
 * SALT_AES = _SALT_A XOR _SALT_B，两段盐分别来自客户端逆向，各 64 字节。
 *
 * ⚠️ 这两段常量必须**逐字节**对齐：`zip`/`map` 一旦遇到长度不等就会静默截断，
 * 而截断后的盐仍然能跑完 sha512、只在最后一位开始偏差 —— 表现就是解密出来的
 * 明文从某个偏移起全是噪声，且报错信息毫无线索。
 *
 * 2026-10-17 踩过这个坑：`_SALT_B` 手抄漏了最后一个字节（63 个），`zip` 语义的
 * `map` 按较短的一侧截断，导致第 64 字节之后全部错位、解密失败且无法定位。
 * 所以这里改成**直接写死异或结果**，并在模块加载时断言长度必须是 64。
 * 换来的是「抄错一个字节立刻炸」而不是「解密结果静静地错」。
 */
const SALT_AES = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba4'
  + '1cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f'
  + '1f05a51892aef2949732b62a38aadd58',
  'hex',
)
if (SALT_AES.length !== 64) {
  throw new Error('SALT_AES 长度必须为 64 字节：逆向常量被抄错了')
}

/**
 * 客户端安装目录候选。
 *
 * 顺序与 Python 版一致：先 SOLO 后正式版，最后一个命中即用。国际版（`Trae`
 * 不带 CN）也在列里——凭证里自带 host，区域由凭证自身声明而不是由目录名决定。
 */
export function storageJsonCandidates() {
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const names = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae']
  return names.map((n) => join(roaming, n, 'User', 'globalStorage', 'storage.json'))
}

/** state.vscdb（模型目录）与 storage.json 同目录，只是文件名不同。 */
export function stateDbCandidates() {
  return storageJsonCandidates().map((p) => p.replace(/storage\.json$/, 'state.vscdb'))
}

/** 第一个真实存在的路径；全都不存在时返回 null。 */
export function firstExisting(candidates) {
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * 解一段 storage.json 里的加密值。
 *
 * 结构（从客户端逆向所得，2026-10-17 本机实测确认）：
 *
 *   buf        = [6 字节头][32 字节随机块 rb][密文 enc]
 *   h          = sha512(rb)
 *   fh         = sha512(h + SALT_AES)
 *   key        = fh[:16]，iv = fh[16:32]
 *   decrypted  = AES-128-CBC-decrypt(key, iv, enc)
 *   明文       = decrypted[64:]，末尾按 PKCS#7 剥掉填充
 *
 * 与 Python 版（`engine/adapters/trae.py:167-186`）的差异只有一处，如实记录：
 * Python 版剥填充时只看末字节是否落进 1..16，不做「整段是否同一个值」的校验。
 * 本机实测末 6 字节是 `7d 7d 06 06 06 06`（即 `}}` 加 4 个 0x06 填充），末字节
 * 校验足以判对，但多加一道全段校验可以挡住「末字节恰好是合法字段值」的误判，
 * 代价只是多扫几个字节。
 *
 * @param {string} base64Value storage.json 里那个字段的原文
 * @returns {Buffer} 解密、剥掉前 64 字节头部与末尾填充之后的明文
 */
export function decryptStorageValue(base64Value) {
  const buf = Buffer.from(base64Value, 'base64')
  if (buf.length < 38) {
    throw new Error('密文长度不足（少于 38 字节），不是本插件认识的加密格式')
  }
  const randomBlock = buf.subarray(6, 38)
  const encrypted = buf.subarray(38)

  const h = createHash('sha512').update(randomBlock).digest()
  const fh = createHash('sha512').update(Buffer.concat([h, SALT_AES])).digest()
  const key = fh.subarray(0, 16)
  const iv = fh.subarray(16, 32)

  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  // 关掉自动去填充：填充值由客户端自己写，我们只按明文末尾的实际形状判断。
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < 64) {
    throw new Error('解密后长度异常（少于 64 字节头部），不是本插件认识的加密格式')
  }

  // 客户端用标准 PKCS#7 填充。只在末字节落进 1..16 **且** 整段都是同一个值时
  // 才按填充剥掉，否则原样返回 —— 绝不猜，猜错会把尾部 JSON 削成半个字段。
  let payload = decrypted.subarray(64)
  const pad = payload.at(-1)
  if (pad >= 1 && pad <= 16 && payload.length >= pad
      && payload.subarray(payload.length - pad).every((b) => b === pad)) {
    payload = payload.subarray(0, payload.length - pad)
  }
  return payload
}

/** 从可能带前后噪声的文本里取出第一个 JSON 对象。 */
function parseLooseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    // 客户端偶尔会在密文尾部留一段非 JSON 字节；按首尾花括号取子串再试一次，
    // 与 Python 版 `text[start:end+1]` 的回退路径等价。
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* 落到底部统一报错 */
    }
  }
  return null
}

/**
 * 读取并解密本机 TRAE 登录态。
 *
 * 返回 `{ source, accessToken, refreshToken, userId, username, host, region,
 * expiredAt, refreshExpiredAt, deviceId, userRegion }`。
 *
 * 不做 token 刷新：刷新要带 DeviceProof（ECDSA P-256 签名，见
 * `docs/` 里的 TRAE 协议取证），而插件进程里没有客户端那把私钥。登录态过期
 * 时如实报错让用户去客户端重新登录，**绝不自己造一个**。
 *
 * @param {string} [explicitPath] 指定 storage.json；省略则自动探测
 */
export function loadTraeCredentials(explicitPath) {
  const path = explicitPath || firstExisting(storageJsonCandidates())
  if (!path) {
    throw new Error(
      '未找到 TRAE 客户端的 storage.json，请先安装并登录 TRAE CN。'
        + '（探测路径见 storageJsonCandidates()）',
    )
  }

  let store
  try {
    store = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`读取 ${path} 失败：${error.message}`)
  }

  const encrypted = store[STORAGE_KEY]
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error(`${path} 里没有 ${STORAGE_KEY}，请先在 TRAE 客户端登录`)
  }

  const plaintext = decryptStorageValue(encrypted)
  const text = plaintext.toString('utf8')
  const obj = parseLooseJson(text) ?? {}

  // 设备号三处兜底，优先级与 Python 版一致：
  // 遥测里客户端自报的 devDeviceId → 解密体内的 deviceId → 键名后缀。
  let deviceId = typeof store['telemetry.devDeviceId'] === 'string'
    ? store['telemetry.devDeviceId']
    : undefined
  if (!deviceId && typeof obj.deviceId === 'string') deviceId = obj.deviceId
  if (!deviceId) {
    const grab = /"deviceId"\s*:\s*"([^"]+)"/.exec(text)
    if (grab) deviceId = grab[1]
  }
  if (!deviceId) {
    for (const key of Object.keys(store)) {
      if (key.startsWith(STORAGE_KEY_DC_PREFIX)) {
        deviceId = key.slice(STORAGE_KEY_DC_PREFIX.length)
        break
      }
    }
  }

  const accessToken = obj.token || (/"token"\s*:\s*"([^"]+)"/.exec(text) || [])[1]
  if (!accessToken) {
    throw new Error(`${path} 解出的登录态里没有 accessToken，请在 TRAE 客户端重新登录`)
  }

  return {
    source: path,
    accessToken,
    refreshToken: obj.refreshToken,
    userId: obj.userId,
    username: obj.account?.username,
    host: obj.host || DEFAULT_HOST,
    region: obj.userRegion?.region || 'CN',
    userRegion: obj.userRegion,
    edition: obj.edition,
    expiredAt: obj.expiredAt ?? (/"expiredAt"\s*:\s*"([^"]+)"/.exec(text) || [])[1],
    refreshExpiredAt: obj.refreshExpiredAt,
    deviceId,
  }
}

/**
 * 凭证是否已过期。
 *
 * `expiredAt` 在 storage.json 里是 ISO 8601 字符串（本机实测
 * `"2026-10-24T11:54:58.940Z"`），不是秒级时间戳——`Number()` 对它得到 NaN。
 * 这里两种形态都认：能 `Date.parse` 的走日期，纯数字的按时间戳算。
 *
 * 未声明过期时间时按「未过期」处理，把判断交给上游：上游 401 会说清楚，
 * 比本地猜一个过期更诚实。
 *
 * @param {{expiredAt?: string|number}} credential
 * @param {number} [nowMs]
 */
export function isExpired(credential, nowMs = Date.now()) {
  const raw = credential?.expiredAt
  if (raw === undefined || raw === null || raw === '') return false

  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed <= nowMs : false
  }
  const at = Number(raw)
  if (!Number.isFinite(at) || at <= 0) return false
  // 客户端历史版本存过秒级时间戳；量级差 1000 倍以上就按秒换算。
  const ms = at < 1e12 ? at * 1000 : at
  return ms <= nowMs
}
