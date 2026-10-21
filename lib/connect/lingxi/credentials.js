/**
 * Lingxi（WPS 灵犀）凭据解析（五层架构的第①层）。
 *
 * Lingxi 的模型网关是云端 API，需要 Cookie 鉴权：
 *   - 任务面板：`GET https://lingxi.wps.cn/api/public/v1/tasks?date=YYYY-MM-DD`
 *   - 模型列表：`GET https://lingxi.wps.cn/api/aioffice/v1/sessions/plans`
 *   - 聊天接口：私有 run 协议（SSE 事件流）
 *
 * 凭据来源：
 *   1. 首选：`%APPDATA%\WPS 灵犀\app-server-data\auth.json` 中的 `wps_sid.value`
 *      （但当前本机为空，表示未登录）
 *   2. 备选：用户通过 CDP 采集或手工录入的 Cookie 文件 `lx_cookie.txt`
 *
 * 本模块尝试从 auth.json 读取 wps_sid；若为空则返回 undefined，
 * 提示用户需要先登录或通过外部方式提供 Cookie。
 *
 * @module dsh-agent-checkin/connect/lingxi/credentials
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Lingxi userData 目录。 */
export function lingxiUserDataDir() {
  const env = process.env.LINGXI_USER_DATA
  if (env) return env
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appdata, 'WPS 灵犀')
}

/**
 * 从 auth.json 提取 wps_sid。
 *
 * auth.json 格式：
 *   {"auth_mode":"wps_sid","wps_sid":{"value":""}}
 *
 * @returns {{ wpsSid: string } | undefined}
 */
export function loadLingxiCredentials() {
  const base = lingxiUserDataDir()
  if (!existsSync(base)) return undefined

  const authPath = join(base, 'app-server-data', 'auth.json')
  if (!existsSync(authPath)) return undefined

  try {
    const content = readFileSync(authPath, 'utf8')
    const auth = JSON.parse(content)
    const wpsSid = auth?.wps_sid?.value
    if (typeof wpsSid === 'string' && wpsSid.length > 0) {
      return { wpsSid }
    }
  } catch {
    // 文件读取或解析失败：返回 undefined。
  }

  return undefined
}

/** 检查凭据是否有效（非空）。 */
export function isValidCredential(cred) {
  if (!cred) return false
  return typeof cred.wpsSid === 'string' && cred.wpsSid.length > 0
}

/**
 * 获取用于 HTTP 请求的 Cookie 头字符串。
 *
 * Lingxi 的 Cookie 是多字段的完整会话 Cookie，不能简化为单个 token。
 * 如果 auth.json 中有 wps_sid，构造最小可用的 Cookie；
 * 否则返回 undefined，提示需要从外部提供完整 Cookie。
 *
 * @param {object} cred - 凭据对象
 * @returns {string | undefined}
 */
export function buildCookieHeader(cred) {
  if (!isValidCredential(cred)) return undefined
  // 注意：真实的 Cookie 包含多个字段（如 wps_sid、csrf_token 等），
  // 这里只返回 wps_sid，实际使用时可能需要从 CDP 采集的完整 Cookie。
  return `wps_sid=${cred.wpsSid}`
}

// ---------------------------------------------------------------------------
// Cookie 文件位置解析
//
// 为什么不能只认「包内 engine/lx_cookie.txt」：
//   package.json 的 `files` 白名单里有 `!engine/*_cookie.txt` 与
//   `!engine/**/.*_profile`，即凭据文件**刻意不进发布包**。一旦从 tgz 重装
//   （市场安装 / 升级 / 重打包），包内 Cookie 会被整目录替换掉，灵犀 provider
//   随之静默消失（activateLingxi 只返回 ok:false，调用方仅 logger.warn）。
//
// 因此按「用户可写、重装不丢」优先的顺序找：
//   ① 显式传入路径（测试 / 特殊部署）
//   ② 环境变量 LINGXI_COOKIE_FILE
//   ③ <dshHome>/dsh-agent-checkin/engine/lx_cookie.txt   ← 主位置
//   ④ <package root>/engine/lx_cookie.txt                ← 老行为兼容
// ---------------------------------------------------------------------------

/** 本模块所属包的 `engine/` 目录（插件自带引擎目录）。 */
const BUNDLED_ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'engine')

/**
 * 宿主 dshHome（通常 `~/.dsh`）。
 *
 * 与 lib/index.js#dshHome 保持同一口径：ctx 里的 homePaths 拿不到时（本模块
 * 不持有 ctx），退到 DSH_HOME 环境变量，再退到 `~/.dsh`。
 *
 * @returns {string}
 */
export function lingxiDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 灵犀 Cookie 文件候选路径，按优先级从高到低。
 *
 * @param {string} [explicit] 显式指定的文件路径
 * @returns {string[]}
 */
export function lingxiCookieFileCandidates(explicit) {
  const candidates = []
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit)
  const env = process.env.LINGXI_COOKIE_FILE
  if (typeof env === 'string' && env.length > 0) candidates.push(env)
  candidates.push(join(lingxiDshHome(), 'dsh-agent-checkin', 'engine', 'lx_cookie.txt'))
  candidates.push(join(BUNDLED_ENGINE_DIR, 'lx_cookie.txt'))
  return candidates
}

/**
 * 读灵犀 Cookie 文本（首个非空命中即返回）。
 *
 * @param {string} [explicit] 显式指定的文件路径
 * @returns {string | undefined}
 */
export function readLingxiCookie(explicit) {
  for (const candidate of lingxiCookieFileCandidates(explicit)) {
    try {
      if (!existsSync(candidate)) continue
      const content = readFileSync(candidate, 'utf8').trim()
      if (content.length > 0) return content
    } catch {
      // 读失败：尝试下一个候选。
    }
  }
  return undefined
}
