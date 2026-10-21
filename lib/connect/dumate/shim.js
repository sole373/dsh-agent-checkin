/**
 * DuMate 上游协议 + loopback OpenAI 面（五层架构的第③层业务路由）。
 *
 * DuMate 的模型网关是 OpenAI 兼容的：
 *   `http://127.0.0.1:<port>/api/qianfanproxy/v1`
 *
 * 鉴权需要请求头 `X-Dumate-Inapp-Key`（64 hex，每次启动随机，从日志读取）。
 *
 * 本 shim：
 *   - 复用共享骨架 `../httpshim.js`（随机端口 / bearer / Host / Origin 校验）；
 *   - 暴露 `/v1/models` 和 `/v1/chat/completions` 两个端点；
 *   - 转发到上游时注入 `X-Dumate-Inapp-Key`；
 *   - 错误处理对齐 workbuddy/trae：首块前失败 retryable→503 / 其它→502；
 *     流中断 → in-band SSE error 帧 + [DONE]。
 *
 * @module dsh-agent-checkin/connect/dumate/shim
 */

import { randomBytes } from 'node:crypto'
import { createLoopbackShim, writeJson, writeOpenAiError, writeSse, readBody } from '../httpshim.js'

/** 请求体上限（64 MiB，与 workbuddy 一致）。 */
const REQUEST_BODY_LIMIT = 67_108_864

/**
 * 启动 DuMate 区域的 loopback OpenAI 面。
 *
 * @param {object} options
 * @param {{ current: () => object[] }} options.catalog 该区域模型目录
 * @param {() => Promise<{ port: number, inappKey: string }>} options.resolveCredential
 *   每请求解析一次凭据（port + inapp key）；抛错或返回 undefined → 401 not_signed_in
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 测试注入；缺省全局 fetch
 * @returns {{ ready, baseUrl, token, close }}（由共享骨架产出）
 */
export function createDumateShim(options) {
  const { catalog, resolveCredential, logger, fetchImpl } = options

  async function handler(req, res) {
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      writeJson(res, 200, {
        object: 'list',
        data: catalog.current().map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'dumate',
        })),
      })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAiError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res) {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
      writeOpenAiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    let credential
    try {
      credential = await resolveCredential()
    } catch (error) {
      writeOpenAiError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (!credential || typeof credential.port !== 'number' || typeof credential.inappKey !== 'string') {
      writeOpenAiError(res, 401, 'not_signed_in', 'DuMate: no valid credentials found (client may not be running)')
      return
    }

    let raw
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > REQUEST_BODY_LIMIT) {
          writeOpenAiError(res, 413, 'request_too_large', 'Request body too large')
          return
        }
        chunks.push(chunk)
      }
      raw = Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      writeOpenAiError(res, 400, 'invalid_request', `Failed to read request body: ${String(error)}`)
      return
    }

    let clientBody
    try {
      clientBody = JSON.parse(raw)
    } catch (error) {
      writeOpenAiError(res, 400, 'invalid_request', `Body is not valid JSON: ${String(error)}`)
      return
    }

    // 确定要调用的上游模型 id（优先用 _upstreamId，否则用 id）
    const requestedModelId = clientBody.model
    const catalogModels = catalog.current()
    const matchedModel = catalogModels.find((m) => m.id === requestedModelId)
    const upstreamModelId = matchedModel?._upstreamId || requestedModelId

    // 构造上游请求体（替换 model 为上游真实 id）
    const upstreamBody = { ...clientBody, model: upstreamModelId }
    const upstreamJson = JSON.stringify(upstreamBody)

    const upstreamUrl = `http://127.0.0.1:${credential.port}/api/qianfanproxy/v1/chat/completions`
    const doFetch = fetchImpl ?? fetch

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    let response
    try {
      response = await doFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer nokey',
          'X-Dumate-Inapp-Key': credential.inappKey,
        },
        body: upstreamJson,
        signal: controller.signal,
      })
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: dumate 上游连接失败', error)
      writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }

    const wantStream = clientBody.stream !== false

    if (!wantStream) {
      // 非流式：完整读取后返回
      try {
        const text = await response.text()
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          writeOpenAiError(res, response.status, 'upstream_error', `Upstream returned non-JSON: ${text.slice(0, 200)}`)
          return
        }
        if (!response.ok) {
          const errorMsg = parsed.error?.message || parsed.msg || text.slice(0, 200)
          writeOpenAiError(res, response.status, 'upstream_error', errorMsg)
          return
        }
        writeJson(res, 200, parsed)
      } catch (error) {
        logger?.warn?.('dsh-agent-checkin: dumate 非流式响应读取失败', error)
        writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      }
      return
    }

    // 流式：逐帧转发 SSE
    if (!response.ok) {
      try {
        const text = await response.text()
        const errorMsg = text.slice(0, 200)
        writeOpenAiError(res, response.status, 'upstream_error', errorMsg)
      } catch {
        writeOpenAiError(res, response.status, 'upstream_error', `Upstream error (HTTP ${response.status})`)
      }
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    try {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          const trimmed = line.trimEnd()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '') continue
          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write(`data: ${payload}\n\n`)
        }
      }
      // 处理尾部残留
      buffer += decoder.decode()
      const tail = buffer.trimEnd()
      if (tail.startsWith('data:')) {
        const payload = tail.slice(5).trim()
        if (payload !== '' && payload !== '[DONE]') {
          res.write(`data: ${payload}\n\n`)
        }
      }
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: dumate 流中断', error)
      const message = String(error?.message ?? error)
      res.write('event: error\n')
      res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: 'upstream_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  return createLoopbackShim({ handler, logger })
}
