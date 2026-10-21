/**
 * Lingxi（WPS 灵犀）上游协议 + loopback OpenAI 面（五层架构的第③层业务路由）。
 *
 * Lingxi 使用私有 run 协议，**不是** OpenAI 兼容接口，也**不是**单次 SSE 请求：
 *
 *   ① 建会话：`POST https://lingxi.wps.cn/api/aioffice/v1/sessions`
 *      → 返回 **JSON**（不是 SSE）：`{"data":{"session_id":"..."}}`
 *   ② 跑推理：`wss://lingxi.wps.cn/api/aioffice/v1/sessions/<sid>/completions/ws`
 *      连上后发 `{"event":"user.input","data":{"agent_input":{text,files,refs,expect_model}}}`
 *      → 服务端推事件流（实测帧序）：
 *
 *        user.input (回显) → run.start → component.start(c_reasoning)
 *        → component.content(c_reasoning, delta) → component.end(full_content)
 *        → component.start(c_text) → component.content(c_text, delta)   ← 正文增量
 *        → component.end(full_content) → turn.start(t_recommend)
 *        → component.*(c_recommend) → turn.end → run.end(credit_consumed)
 *
 * 关键字段（旧实现曾按 `type` / `data.text` 解析，均错）：
 *   - 事件名在顶层 **`event`**（不是 `type`；`type` 在 `data.type` 里，取值 c_text / c_reasoning / c_recommend）
 *   - 正文增量在 **`data.delta`**，整段在 `data.full_content`
 *
 * 本 shim：
 *   - 复用共享骨架 `../httpshim.js`（随机端口 / bearer / Host / Origin 校验）；
 *   - 暴露 `/v1/models` 和 `/v1/chat/completions` 两个端点；
 *   - 建会话 → 连 WS → 把 `component.content(c_text).delta` 转成 OpenAI SSE；
 *   - 错误处理对齐 workbuddy/trae：首块前失败 retryable→503 / 其它→502；
 *     流中断 → in-band SSE error 帧 + [DONE]。
 *
 * 已知能力边界（灵犀上游决定的，不是 bug）：
 *   - **无会话记忆**：每次请求新建 session，历史消息由 `flattenMessages()` 压成
 *     一段文本随 `agent_input.text` 发出（方案 1，单轮语义）。
 *   - **不支持 function calling**：请求里的 `tools` 忽略；assistant 的 tool_calls
 *     与 tool 结果只在压平历史时以文本形式保留上下文。
 *   - 图片：`image_url` 内容块暂不上传（需 files/refs 上传通道），仅以占位文本提示。
 *
 * @module dsh-agent-checkin/connect/lingxi/shim
 */

import { createLoopbackShim, writeJson, writeOpenAiError } from '../httpshim.js'

/** 请求体上限（64 MiB）。 */
const REQUEST_BODY_LIMIT = 67_108_864

/** Lingxi API 基础 URL（HTTP）。 */
const LINGXI_API_BASE = 'https://lingxi.wps.cn'

/** Lingxi WebSocket 基础 URL。 */
const LINGXI_WS_BASE = 'wss://lingxi.wps.cn'

/** User-Agent 头。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** WS 建连超时。 */
const WS_OPEN_TIMEOUT_MS = 20_000

/** 上游无事件空闲超时（灵犀长任务也会周期性发帧，180s 足够）。 */
const WS_IDLE_TIMEOUT_MS = 180_000

/**
 * 启动 Lingxi 区域的 loopback OpenAI 面。
 *
 * @param {object} options
 * @param {{ current: () => object[] }} options.catalog 该区域模型目录
 * @param {() => Promise<string>} options.resolveCredential
 *   每请求解析一次凭据（Cookie 字符串）；抛错或返回 undefined → 401 not_signed_in
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 测试注入；缺省全局 fetch
 * @returns {{ ready, baseUrl, token, close }}（由共享骨架产出）
 */
export function createLingxiShim(options) {
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
          owned_by: 'lingxi',
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

    let cookie
    try {
      cookie = await resolveCredential()
    } catch (error) {
      writeOpenAiError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (!cookie || typeof cookie !== 'string' || cookie.length === 0) {
      writeOpenAiError(res, 401, 'not_signed_in', 'Lingxi: no valid credentials found (client may not be logged in)')
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

    // 确定要调用的上游模型 key。
    // 注意：catalog 条目里的字段名是 `upstreamId`（无下划线）；`_upstreamId` 是
    // models.js#toPiModel 给 pi-ai 用的透传字段。两者都要认，避免解析错。
    const requestedModelId = clientBody.model
    const catalogModels = catalog.current()
    const matchedModel = catalogModels.find((m) => m.id === requestedModelId)
    const upstreamModelKey = matchedModel?.upstreamId
      || matchedModel?._upstreamId
      || requestedModelId

    const userText = flattenMessages(clientBody)
    if (userText.length === 0) {
      writeOpenAiError(res, 400, 'invalid_request', 'No text content in messages')
      return
    }

    const wantStream = clientBody.stream !== false

    // 客户端断开 → 中止上游。
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    // ① 建会话（JSON 响应，不是 SSE）。
    let sessionId
    try {
      sessionId = await createSession({
        cookie,
        text: userText,
        expectModel: upstreamModelKey,
        signal: controller.signal,
        fetchImpl,
      })
    } catch (error) {
      const status = error?.lingxiStatus
      if (status === 401 || status === 403) {
        writeOpenAiError(res, 401, 'not_signed_in', 'Lingxi 会话创建被拒绝（Cookie 已失效，需重新采集）')
        return
      }
      logger?.warn?.('dsh-agent-checkin: lingxi 建会话失败', error)
      writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }

    // ② 连 WS 跑推理。
    const wsUrl = `${LINGXI_WS_BASE}/api/aioffice/v1/sessions/${sessionId}/completions/ws`
    let socket
    try {
      socket = new WebSocket(wsUrl, {
        headers: {
          'Cookie': cookie,
          'User-Agent': UA,
          'Origin': LINGXI_API_BASE,
        },
      })
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: lingxi WS 建连失败', error)
      writeOpenAiError(res, 502, 'upstream_error', `WebSocket unavailable: ${String(error?.message ?? error)}`)
      return
    }

    const state = {
      started: false,
      finished: false,
      accumulated: '',
      emittedAny: false,
      idleTimer: undefined,
      openTimer: undefined,
    }

    /** 写一帧 OpenAI SSE chunk。 */
    const writeChunk = (delta, finishReason = null, extra = {}) => {
      const chunk = {
        id: `lingxi-${sessionId.slice(0, 8)}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: requestedModelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    /** 收尾：非流式走 JSON，流式走 SSE。 */
    const finish = (reason) => {
      if (state.finished) return
      state.finished = true
      clearTimeout(state.idleTimer)
      clearTimeout(state.openTimer)
      try { socket.close() } catch { /* 已关闭 */ }

      if (!wantStream) {
        writeJson(res, 200, {
          id: `lingxi-${sessionId.slice(0, 8)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: state.accumulated },
            finish_reason: reason,
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
        return
      }
      writeChunk({}, reason)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    /** 失败收尾：首块前用 HTTP 错误码，之后用 in-band error 帧。 */
    const fail = (message, { retryable = false } = {}) => {
      if (state.finished) return
      clearTimeout(state.idleTimer)
      clearTimeout(state.openTimer)
      try { socket.close() } catch { /* 已关闭 */ }

      if (!state.emittedAny) {
        state.finished = true
        writeOpenAiError(res, retryable ? 503 : 502, 'upstream_error', message)
        return
      }
      state.finished = true
      res.write('event: error\n')
      res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: 'upstream_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    /** 管一次事件；返回 true 表示已终结。 */
    const handleEvent = (frame) => {
      const name = frame?.event
      const data = frame?.data ?? {}

      if (name === 'component.content') {
        const delta = data.delta
        if (typeof delta !== 'string' || delta.length === 0) return false
        // 正文组件才转发；推理组件（c_reasoning）与推荐（c_recommend）丢弃——
        // 灵犀前端把 reasoning 单独渲染，混进 content 会污染正文。
        if (data.type !== 'c_text') return false
        state.accumulated += delta
        if (wantStream) {
          if (!state.started) {
            state.started = true
            writeChunk({ role: 'assistant', content: '' })
          }
          state.emittedAny = true
          writeChunk({ content: delta })
        }
        return false
      }

      if (name === 'run.end') {
        finish('stop')
        return true
      }

      // 上游显式报错帧（若出现）。
      if (name === 'run.error' || name === 'error') {
        fail(String(data.message ?? data.error ?? 'Lingxi run failed'))
        return true
      }

      return false
    }

    socket.onopen = () => {
      clearTimeout(state.openTimer)
      armIdle()
      try {
        socket.send(JSON.stringify({
          event: 'user.input',
          data: {
            agent_input: {
              text: userText,
              files: [],
              refs: [],
              expect_model: upstreamModelKey,
            },
          },
        }))
      } catch (error) {
        fail(`发送 user.input 失败：${String(error?.message ?? error)}`)
      }
    }

    function armIdle() {
      clearTimeout(state.idleTimer)
      state.idleTimer = setTimeout(() => {
        fail('Lingxi 上游空闲超时（长时间无事件）', { retryable: true })
      }, WS_IDLE_TIMEOUT_MS)
      state.idleTimer.unref?.()
    }

    // 流式时先开 SSE 头，避免上游首帧延迟被当成 HTTP 错误。
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()
    }

    socket.onmessage = (event) => {
      armIdle()
      let frame
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      handleEvent(frame)
    }

    socket.onerror = (event) => {
      const message = event?.message ?? event?.error?.message ?? 'WebSocket error'
      fail(`Lingxi WS 错误：${message}`, { retryable: true })
    }

    socket.onclose = (event) => {
      if (state.finished) return
      // 正常关闭（1000）但没收到 run.end：把已累积的当作完整回答。
      if (event?.code === 1000 && state.accumulated.length > 0) {
        finish('stop')
        return
      }
      fail(`Lingxi WS 意外关闭（code=${event?.code ?? 'n/a'}）`, { retryable: true })
    }

    // 建连超时兜底。
    state.openTimer = setTimeout(() => {
      fail('Lingxi WS 建连超时', { retryable: true })
    }, WS_OPEN_TIMEOUT_MS)
    state.openTimer.unref?.()

    controller.signal.addEventListener('abort', () => {
      if (state.finished) return
      state.finished = true
      clearTimeout(state.idleTimer)
      clearTimeout(state.openTimer)
      try { socket.close() } catch { /* 已关闭 */ }
    }, { once: true })
  }

  return createLoopbackShim({ handler, logger })
}

/**
 * 建一个 Lingxi 会话。
 *
 * 端点是「建会话」而不是「聊天」：返回 JSON `{data:{session_id}}`，真正的推理
 * 在随后连上的 WS 里跑。旧实现把这个 POST 当 SSE 直读，因此永远拿不到正文。
 *
 * @param {object} params
 * @returns {Promise<string>} session_id
 */
async function createSession({ cookie, text, expectModel, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch
  const response = await doFetch(`${LINGXI_API_BASE}/api/aioffice/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': UA,
      'Referer': `${LINGXI_API_BASE}/`,
      'Origin': LINGXI_API_BASE,
      'Cookie': cookie,
    },
    body: JSON.stringify({ text, files: [], refs: [], expect_model: expectModel }),
    signal,
  })

  const bodyText = await response.text()
  if (!response.ok) {
    const error = new Error(`create session HTTP ${response.status}: ${bodyText.slice(0, 200)}`)
    error.lingxiStatus = response.status
    throw error
  }

  let payload
  try {
    payload = JSON.parse(bodyText)
  } catch {
    const error = new Error(`create session 返回非 JSON：${bodyText.slice(0, 200)}`)
    error.lingxiStatus = response.status
    throw error
  }

  const sessionId = payload?.data?.session_id ?? payload?.data?.sessionId ?? payload?.session_id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`create session 未返回 session_id：${bodyText.slice(0, 200)}`)
  }
  return sessionId
}

/**
 * 把 OpenAI `messages` 压成一段文本（方案 1：单轮语义）。
 *
 * 灵犀每次请求新建会话，没有跨请求记忆，因此历史必须自己拼进 `text`。
 * 只有「单独一条 user 消息」时原样发送，避免给上游加无谓的角色前缀。
 *
 * @param {object} body OpenAI 兼容请求体
 * @returns {string}
 */
function flattenMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.length === 0) return ''

  if (messages.length === 1 && (messages[0]?.role ?? 'user') === 'user') {
    return contentToText(messages[0]?.content)
  }

  const blocks = []
  for (const message of messages) {
    const role = message?.role ?? 'user'
    const text = contentToText(message?.content)
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    if (text.length === 0 && toolCalls.length === 0) continue

    if (role === 'system' || role === 'developer') {
      if (text) blocks.push(`[系统指令]\n${text}`)
    } else if (role === 'assistant') {
      const lines = []
      if (text) lines.push(text)
      for (const call of toolCalls) {
        const name = call?.function?.name ?? call?.name ?? 'tool'
        const args = call?.function?.arguments ?? call?.arguments ?? ''
        lines.push(`(调用工具 ${name}: ${typeof args === 'string' ? args : JSON.stringify(args)})`)
      }
      if (lines.length > 0) blocks.push(`[助手]\n${lines.join('\n')}`)
    } else if (role === 'tool') {
      if (text) blocks.push(`[工具结果]\n${text}`)
    } else {
      if (text) blocks.push(`[用户]\n${text}`)
    }
  }
  return blocks.join('\n\n')
}

/**
 * 把 OpenAI 内容（字符串或内容块数组）转成纯文本。
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const type = block.type
    if (type === 'text' || type === 'input_text') {
      if (typeof block.text === 'string') parts.push(block.text)
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      parts.push('[图片内容已省略：灵犀 shim 暂不支持图片上传]')
    }
  }
  return parts.join('\n')
}
