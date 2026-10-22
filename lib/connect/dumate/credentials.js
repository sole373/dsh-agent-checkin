/**
 * DuMate 凭据解析（五层架构的第①层）。
 *
 * DuMate（百度搭子）的模型网关是 OpenAI 兼容的本地 loopback：
 *   `http://127.0.0.1:<port>/api/qianfanproxy/v1`
 *
 * 端口和鉴权头 `X-Dumate-Inapp-Key` 每次启动随机，但会落在日志里：
 *   - `%APPDATA%\qianfan-desktop-app\log\electron.log`
 *     `DUMATE_QIANFAN_PROXY: 'http://127.0.0.1:52068/api/qianfanproxy/'`
 *     `DUMATE_INAPP_KEY: '<64 hex>'`
 *   - `%APPDATA%\qianfan-desktop-app\log\desktop-main\Main.log`
 *     `API service is now running at 127.0.0.1:52068`
 *     `headers: map[... X-Dumate-Inapp-Key:[<64 hex>]]`
 *
 * 本模块从最新日志提取这两项；客户端未运行时返回 undefined。
 *
 * @module dsh-agent-checkin/connect/dumate/credentials
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'

/** DuMate userData 目录（百度搭子客户端）。 */
export function dumateUserDataDir() {
  const env = process.env.DUMATE_USER_DATA
  if (env) return env
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appdata, 'qianfan-desktop-app')
}

/** 候选日志文件列表（按优先级排序）。 */
function candidateLogFiles() {
  const base = dumateUserDataDir()
  if (!existsSync(base)) return []
  return [
    join(base, 'log', 'electron.log'),
    join(base, 'log', 'desktop-main', 'Main.log'),
  ].filter((p) => existsSync(p))
}

/** 从单行提取端口（匹配 `127.0.0.1:NNNNN` 或 `DUMATE_QIANFAN_PROXY` 格式）。 */
function extractPortFromLine(line) {
  // DUMATE_QIANFAN_PROXY: 'http://127.0.0.1:52068/api/qianfanproxy/'
  const proxyMatch = /DUMATE_QIANFAN_PROXY:\s*['"]?http:\/\/127\.0\.0\.1:(\d+)/i.exec(line)
  if (proxyMatch) return parseInt(proxyMatch[1], 10)

  // API service is now running at 127.0.0.1:52068
  const apiMatch = /API service is now running at\s+127\.0\.0\.1:(\d+)/i.exec(line)
  if (apiMatch) return parseInt(apiMatch[1], 10)

  // doInitServices completed, result: {"backendPort":52068,...}
  const initMatch = /doInitServices completed.*?"backendPort":(\d+)/i.exec(line)
  if (initMatch) return parseInt(initMatch[1], 10)

  return null
}

/** 从单行提取 inapp key。 */
function extractInappKeyFromLine(line) {
  // DUMATE_INAPP_KEY: '<64 hex>'
  const keyMatch = /DUMATE_INAPP_KEY:\s*['"]([0-9a-f]{64})['"]/i.exec(line)
  if (keyMatch) return keyMatch[1]

  // headers: map[... X-Dumate-Inapp-Key:[<64 hex>]]
  const headerMatch = /X-Dumate-Inapp-Key:\[(\w{64})\]/i.exec(line)
  if (headerMatch) return headerMatch[1]

  return null
}

/**
 * 解析所有候选日志，取最后一次出现的 port 和 key（最新值）。
 *
 * @returns {{ port: number, inappKey: string } | undefined}
 */
export function loadDumateCredentials() {
  const files = candidateLogFiles()
  if (files.length === 0) return undefined

  let latestPort = null
  let latestKey = null

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf8')
      const lines = content.split('\n')

      for (const line of lines) {
        const port = extractPortFromLine(line)
        if (port !== null) latestPort = port

        const key = extractInappKeyFromLine(line)
        if (key !== null) latestKey = key
      }
    } catch {
      // 文件读取失败：跳过，继续尝试下一个。
    }
  }

  if (latestPort === null || latestKey === null) return undefined
  return { port: latestPort, inappKey: latestKey }
}

/** 检查凭据是否有效（非空且格式正确）。 */
export function isValidCredential(cred) {
  if (!cred) return false
  return typeof cred.port === 'number' && cred.port > 0 && typeof cred.inappKey === 'string' && cred.inappKey.length === 64
}
