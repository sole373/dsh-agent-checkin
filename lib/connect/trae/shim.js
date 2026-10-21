/**
 * TRAE 业务路由层（五层架构第③层的业务部分）：在共享 loopback 骨架上说
 * OpenAI，翻译成 llm_utils_chat 打出去。
 *
 * 安全骨架（端口、bearer、Host/Origin 校验、/healthz）由
 * `lib/connect/httpshim.js` 提供；本模块只挂两条业务路由：
 *
 *   - `GET  /v1/models`           —— 目录 → OpenAI list 形状；
 *   - `POST /v1/chat/completions` —— OpenAI body → llm_utils_chat → SSE 回译。
 *
 * 关键纪律（与 ref/connect-qoder shim.js 逐条对齐，MIT）：
 *
 *   - 凭据**每请求现取**（`await resolveCredential()`）：重新登录不用重启；
 *     取不到回 `401 not_signed_in`。
 *   - 首块先拉再定状态码：auth/quota 失败以 HTTP 错误露出（retryable→503
 *     rate_limit，其它→502 upstream_error），而不是一条断掉的 200 流
 *     （qoder :204-221）。
 *   - 流中途断：响应已开始，错误以 **in-band SSE error 帧 + [DONE]** 收尾，
 *     绝不把半截流当正常结束（qoder :305-326）。
 *   - usage 帧必须转发：pi-ai 从顶层 `chunk.usage` 读 token 计数，丢了它
 *     模型就会「不报字数」（qoder :261-280）。
 *
 * @module dsh-agent-checkin/connect/trae/shim
 */

import { randomBytes } from 'node:crypto'
import {
  createLoopbackShim,
  writeJson,
  writeOpenAiError,
  writeSse,
  readBody,
} from '../httpshim.js'
import {
  DEFAULT_APP_ID,
  TraeRawChatError,
  functionOfCatalogEntry,
  regionOfCredential,
  streamRawChat,
} from './upstream-raw.js'

/**
 * @param {object} options
 * @param {() => Promise<object|undefined>} options.resolveCredential 每请求调用。
 * @param {() => object[]} options.resolveModels 当前目录（catalog entry 数组）。
 * @param {() => string[]} [options.resolveEnabledIds] 用户勾选子集；空=不过滤。
 * @param {{ id: string, key: string, displayName?: string }} options.region
 *   `id` 是 provider id（owned_by 用它），`key` 是网关区域（'cn' | 'ai'）。
 * @param {object} [options.logger]
 * @param {Function} [options.fetchImpl] 测试注入的上游 fetch。
 */
export function createTraeShim({ resolveCredential, resolveModels, resolveEnabledIds, region, logger, fetchImpl } = {}) {
  if (typeof resolveCredential !== 'function') throw new TypeError('createTraeShim: resolveCredential 必填')
  if (typeof resolveModels !== 'function') throw new TypeError('createTraeShim: resolveModels 必填')
  if (typeof region?.id !== 'string' || typeof region?.key !== 'string') {
    throw new TypeError('createTraeShim: region.id 与 region.key 必填')
  }

  function enabledFilter(models) {
    if (typeof resolveEnabledIds !== 'function') return models
    const enabled = (resolveEnabledIds() ?? []).filter((id) => typeof id === 'string' && id.length > 0)
    if (enabled.length === 0) return models
    const allowed = new Set(enabled)
    return models.filter((m) => allowed.has(m.id))
  }

  async function handler(req, res) {
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      const data = enabledFilter(resolveModels()).map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: region.id,
      }))
      writeJson(res, 200, { object: 'list', data })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAiError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res) {
    let credential
    try {
      credential = await resolveCredential()
    } catch (error) {
      writeOpenAiError(res, 401, 'not_signed_in', String(error?.message ?? error))
      return
    }
    if (credential === undefined || credential === null) {
      writeOpenAiError(res, 401, 'not_signed_in', `${region.displayName ?? region.id} 未在本机登录`)
      return
    }

    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'))
    } catch (error) {
      writeOpenAiError(res, 400, 'invalid_request', `body is not JSON: ${String(error?.message ?? error)}`)
      return
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      writeOpenAiError(res, 400, 'invalid_request', 'messages are required')
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    req.socket.once('close', abort)

    const displayModel = body.model
    // 模型只能经「列出它的那个 SOLO function」调用（实测 2026-10-18：
    // glm-5.3 仅 solo_work_remote，DeepSeek-V4-Flash 仅 solo_coder，用错
    // function 上游回 200 流里 `event:error {"code":4001}`）。
    // 目录条目带 appearedIn 时按它挑；没有就按 TRAE_DEFAULT_FUNCTION_FALLBACK。
    const catalogEntry = resolveModels().find((m) => m?.id === displayModel)
    const functionName = functionOfCatalogEntry(catalogEntry)
    const request = {
      model: displayModel,
      function: functionName,
      messages: body.messages,
      ...typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {},
      ...typeof body.temperature === 'number' ? { temperature: body.temperature } : {},
      ...typeof body.reasoning_effort === 'string' && body.reasoning_effort !== ''
        ? { reasoningEffort: body.reasoning_effort }
        : {},
      ...Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {},
    }
    // 身份全部来自凭据自身；没有的字段绝不编（假 deviceId 比不发后果严重）。
    const identity = {
      ...credential.deviceId === undefined ? {} : { deviceId: credential.deviceId },
      platform: process.platform,
    }

    const wantStream = body.stream !== false
    let iterator
    let first
    try {
      iterator = streamRawChat({
        region: region.key ?? regionOfCredential(credential),
        credential,
        identity,
        request,
        signal: controller.signal,
        fetchImpl,
      })
      // 首块先拉：auth/quota 失败在这里以 HTTP 错误露出，而不是一条断流。
      first = await iterator.next()
    } catch (error) {
      logger?.warn?.(`dsh-agent-checkin: ${region.id} 上游首块失败`, error)
      if (error instanceof TraeRawChatError && error.retryable === true) {
        writeOpenAiError(res, 503, 'rate_limit', String(error.message))
        return
      }
      writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }

    if (!wantStream) {
      await answerNonStreaming(res, iterator, first, displayModel)
      return
    }
    answerStreaming(res, iterator, first, displayModel)
  }

  /** 非流式：收完一次性回 JSON；中途断在 headers 未发前，仍可回 HTTP 错误。 */
  async function answerNonStreaming(res, iterator, first, displayModel) {
    const content = []
    const reasoning = []
    const toolCalls = new Map()
    let finish = 'stop'
    let usage
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        absorbEvent(step.value, content, reasoning, toolCalls, (f) => { finish = f }, (u) => { usage = u })
      }
    } catch (error) {
      logger?.warn?.(`dsh-agent-checkin: ${region.id} 非流式收集中断`, error)
      if (error instanceof TraeRawChatError && error.retryable === true) {
        writeOpenAiError(res, 503, 'rate_limit', String(error.message))
        return
      }
      writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }
    const message = { role: 'assistant', content: content.join('') }
    if (reasoning.length > 0) message.reasoning_content = reasoning.join('')
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.values()].map((call) => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
      }))
    }
    writeJson(res, 200, {
      id: `chatcmpl-${randomBytes(8).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: displayModel,
      choices: [{ index: 0, message, finish_reason: finish }],
      // 上游没报就如实缺省：编一个 0 会被读成「这轮免费」。
      ...usage === undefined ? {} : { usage },
    })
  }

  /** 流式：逐事件回译成 OpenAI chunk；中断以 in-band error 帧收尾。 */
  async function answerStreaming(res, iterator, first, displayModel) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const id = `chatcmpl-${randomBytes(8).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    let sentRole = false
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        const event = step.value
        if (event === undefined) continue

        // usage 帧独立成 chunk：`choices: []` + 顶层 usage（OpenAI
        // stream_options.include_usage 形状），pi-ai 从这里读 token 计数。
        if (event.type === 'usage' && event.usage !== undefined && event.usage !== null) {
          writeSse(res, { id, object: 'chat.completion.chunk', created, model: displayModel, choices: [], usage: event.usage })
          continue
        }

        if (event.type === 'done') {
          writeSse(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model: displayModel,
            choices: [{ index: 0, delta: sentRole ? {} : { role: 'assistant' }, finish_reason: event.finishReason ?? 'stop' }],
          })
          sentRole = true
          continue
        }

        const delta = {}
        if (event.type === 'text') delta.content = event.text
        else if (event.type === 'reasoning') delta.reasoning_content = event.text
        else if (event.type === 'tool-call') {
          delta.tool_calls = [{
            index: event.index,
            ...event.id === undefined ? {} : { id: event.id },
            type: 'function',
            function: {
              ...event.name === undefined ? {} : { name: event.name },
              ...event.arguments === undefined ? {} : { arguments: event.arguments },
            },
          }]
        } else {
          continue // unknown：不认识的结构不转发，也不当错误
        }
        if (!sentRole) {
          delta.role = 'assistant'
          sentRole = true
        }
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: displayModel,
          choices: [{ index: 0, delta, finish_reason: null }],
        })
      }
    } catch (error) {
      // 绝不把半截流当正常结束：错误以 in-band SSE error 帧 + [DONE] 收尾，
      // 让宿主有机会重试或如实报告。
      logger?.warn?.(`dsh-agent-checkin: ${region.id} 流中断`, error)
      const kind = error instanceof TraeRawChatError && error.retryable === true ? 'rate_limit' : 'upstream_error'
      const message = String(error?.message ?? error)
      res.write('event: error\n')
      res.write(`data: ${JSON.stringify({ error: { message, type: kind, code: kind } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  return createLoopbackShim({ handler, logger })
}

/** 非流式收集用的单事件吸收器。 */
function absorbEvent(event, content, reasoning, toolCalls, setFinish, setUsage) {
  if (event === undefined) return
  if (event.type === 'text') content.push(event.text)
  else if (event.type === 'reasoning') reasoning.push(event.text)
  else if (event.type === 'usage' && event.usage != null) setUsage(event.usage)
  else if (event.type === 'done') setFinish(event.finishReason ?? 'stop')
  else if (event.type === 'tool-call') {
    const current = toolCalls.get(event.index) ?? { id: '', name: '', arguments: '' }
    if (event.id) current.id = event.id
    if (event.name) current.name = event.name
    if (event.arguments) current.arguments += event.arguments
    toolCalls.set(event.index, current)
  }
}
