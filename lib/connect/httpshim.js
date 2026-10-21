/**
 * 通用 loopback HTTP shim（五层架构的第③层）。
 *
 * 三个平台（trae / qoder / workbuddy）的 shim 共享同一套安全骨架，差异只在
 * 业务路由。本模块提供骨架：
 *
 *   - `server.listen(0, "127.0.0.1")`：随机回环端口，进程外不可达；
 *   - 每进程随机 bearer secret：pi-ai 侧经 `resolveApiKey` 拿到，别处拿不到；
 *   - Host / Origin 必须回环：挡住同机其它来源与 DNS rebinding；
 *   - bearer 用 `timingSafeEqual` 比对：不做时序泄露。
 *
 * 安全三件套的形状抄自 ref/connect-trae :2666-2692 与 ref/connect-qoder
 * shim.js（MIT），业务路由（/v1/models、/v1/chat/completions）由各平台自己的
 * shim 模块以 `handler` 形式挂进来。
 *
 * @module dsh-agent-checkin/connect/httpshim
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 拒绝任何不以回环接口为目标的 Host 头。 */
export function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** 拒绝任何声称来自非回环源的请求；缺 Origin（同源 GET）是正常情形。 */
export function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** 写一个 JSON 响应体。 */
export function writeJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** 写一个 OpenAI 形状的错误体。 */
export function writeOpenAiError(res, status, code, message) {
  writeJson(res, status, { error: { message: String(message), type: code, code } })
}

/** 把请求体完整读出。 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 写一帧 SSE。 */
export function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

/**
 * 启动一个 loopback shim。
 *
 * @param {object} options
 * @param {(req, res) => Promise<void>} options.handler 安全检查全部通过之后的业务路由。
 *   `/healthz` 由骨架自己应答，其余路径一律交给 handler；handler 自己决定 404。
 * @param {object} [options.logger]
 * @returns {{ ready: Promise<void>, baseUrl: () => string, token: () => string, close: () => Promise<void> }}
 */
export function createLoopbackShim({ handler, logger } = {}) {
  if (typeof handler !== 'function') throw new TypeError('createLoopbackShim: handler 必填')
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** 常数时间 bearer 比对。 */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    const expected = Buffer.from(SHARED_SECRET)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  const server = createServer((req, res) => {
    guard(req, res).catch((error) => {
      logger?.warn?.('dsh-agent-checkin: shim 请求处理异常', error)
      if (!res.headersSent) writeOpenAiError(res, 500, 'internal', String(error))
      else res.end()
    })
  })

  async function guard(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAiError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAiError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(req)) {
      writeOpenAiError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      writeJson(res, 200, { ok: true })
      return
    }
    await handler(req, res)
  }

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  const baseUrl = () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('dsh-agent-checkin: shim 尚无监听地址')
    }
    return `http://127.0.0.1:${address.port}`
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
        server.once('error', reject)
      }),
  }
}
