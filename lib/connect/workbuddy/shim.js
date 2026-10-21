/**
 * WorkBuddy 上游协议 + loopback OpenAI 面（五层架构的第③层业务路由）。
 *
 * 上游协议移植自 dsh-connect-workbuddy@4.6.5（MIT，Copyright (c) 2026 LaoDing）
 * 的 upstream.ts / shim.ts：
 *   - 端点与 base 路由（CN `copilot.tencent.com` / 国际按凭据 domain 分家）、
 *     CLI 形态请求头、会话身份三件套（X-Conversation-*，issue #66）、
 *     `prepareChatBody`（强制 stream:true、developer→system、保证 system 头、
 *     tool_choice 压平为字符串）、错误分类（classifyUpstreamError）、
 *     token 刷新端点（X-Refresh-Token 只出现在刷新头里）——逐字对齐；
 *   - 入站安全骨架（随机端口 / bearer / Host / Origin 校验）复用共享骨架
 *     `../httpshim.js`，不在这里重复实现；
 *   - 错误处理策略对齐 ref/connect-qoder shim.js：首块前失败 retryable→503 /
 *     其它→502；流中断 → in-band SSE error 帧 + [DONE]，绝不把半截流当正常结束；
 *   - usage 帧（`choices: []` + 顶层 `usage`）必须转发——pi-ai 靠它记账。
 *
 * 老插件的 DSML 标记恢复、多账号 failover、body 报告不在 M3 范围。
 *
 * @module dsh-agent-checkin/connect/workbuddy/shim
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createLoopbackShim, writeJson, writeOpenAiError, writeSse } from '../httpshim.js'

/** 请求体上限（老插件 shim.ts REQUEST_BODY_LIMIT 原样：64 MiB）。 */
const REQUEST_BODY_LIMIT = 67_108_864

// ---------------------------------------------------------------------------
// 区域与 base 路由（老插件 upstream.ts 原样）
// ---------------------------------------------------------------------------

export const CN_CHAT_BASE = 'https://copilot.tencent.com'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Region for a login domain; an empty domain means CN. Both `workbuddy.ai` and
 * `codebuddy.ai` classify as `global`（同一网关栈、两把钥匙各自签发）。
 */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/** Gateway for a global credential: the base follows the credential's OWN domain. */
export function globalBase(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

export function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

export function originReferer(credential) {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

// ---------------------------------------------------------------------------
// 请求头（老插件 upstream.ts 原样）
// ---------------------------------------------------------------------------

/** CLI user agent：chat 与 CN 目录走 CLI 渠道。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** WorkBuddy 桌面端 UA：`/v3/config` 按此分身产品配置（国际区目录必须用它）。 */
export const DESKTOP_UA = 'WorkBuddy/5.5.2'

/** Headers every upstream request shares. */
export function commonHeaders(credential) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * The conversation-identity triple the chat endpoint requires（issue #66）：
 * 任意 well-formed UUID 即可，每请求重新生成，两区域都带。
 */
function conversationHeaders() {
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
export function chatHeaders(credential) {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === '' ? { 'X-No-Enterprise-Id': '1' } : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-Product': 'SaaS',
    ...conversationHeaders(),
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') headers['X-Enterprise-Id'] = credential.enterpriseId
  return headers
}

// ---------------------------------------------------------------------------
// 错误分类（老插件 upstream.ts 原样）
// ---------------------------------------------------------------------------

const HARD_CREDIT_MARKERS = [
  'insufficient credit',
  'no credit',
  'credit exhausted',
  'credits exhausted',
  'out of credit',
  'quota exceeded',
  'quota exhaust',
  'payment required',
  'credit not enough',
  'not enough credit',
  'credits not enough',
  '积分不足',
  '额度不足',
  '余额不足',
  '积分用完',
  '额度用尽',
  '没有积分',
]
const CREDITS_EXHAUSTED_CODE = '"code":14018'
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']
const POLICY_REJECT_MARKERS = ['request illegal', '"code":11140']
const MODEL_BUSY_CODE = '"code":14003'

/** Whether a failure body is the MODEL-scoped throttle rather than an account limit. */
export function isModelBusyBody(body) {
  return body.includes(MODEL_BUSY_CODE)
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  if (body.includes(CREDITS_EXHAUSTED_CODE)) return 'hard_credit'
  for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return 'session_dead'
  for (const marker of POLICY_REJECT_MARKERS) if (body.includes(marker)) return 'policy_reject'
  if (isModelBusyBody(body)) return 'model_busy'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/** Parse the known-good fields out of an upstream failure body. */
export function parseUpstreamErrorDetail(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed
  let displayMsg
  const display = raw.displayMsg
  if (typeof display === 'string') displayMsg = display
  else if (typeof display === 'object' && display !== null) {
    const pick = display.zh ?? display.en
    if (typeof pick === 'string') displayMsg = pick
  }
  if (displayMsg === undefined && typeof raw.msg === 'string') displayMsg = raw.msg
  const detail = {}
  if (typeof raw.code === 'number') detail.upstreamCode = raw.code
  if (typeof raw.requestId === 'string') detail.requestId = raw.requestId
  if (displayMsg !== undefined) detail.displayMsg = displayMsg
  return detail
}

/**
 * Gateway (openresty/APISIX) rejection of a token it no longer accepts: an
 * edge 401/403 answers an HTML error page instead of business JSON.
 */
export function isGatewayAuthRejection(status, text) {
  if (status !== 401 && status !== 403) return false
  const lower = text.toLowerCase()
  return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required')
}

/** Marker carried by {@link WorkBuddyCredentialRejectedError}; survives bundling. */
export const CREDENTIAL_REJECTED_CODE = 'WORKBUDDY_CREDENTIAL_REJECTED'

/** The upstream refused the CREDENTIAL itself rather than failing the request. */
export class WorkBuddyCredentialRejectedError extends Error {
  code = CREDENTIAL_REJECTED_CODE
  constructor(status) {
    super(`workbuddy: the signed-in credential was rejected by the upstream gateway (http ${status}). The stored token is no longer accepted — re-sign in to the WorkBuddy desktop app.`)
    this.name = 'WorkBuddyCredentialRejectedError'
    this.status = status
  }
}

/** Whether an error reports that the upstream refused the credential itself. */
export function isCredentialRejectedError(value) {
  return typeof value === 'object' && value !== null && value.code === CREDENTIAL_REJECTED_CODE
}

// ---------------------------------------------------------------------------
// 信封读取（老插件 upstream.ts 原样）
// ---------------------------------------------------------------------------

export async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    if (isGatewayAuthRejection(response.status, text)) throw new WorkBuddyCredentialRejectedError(response.status)
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  const document = parsed
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
export function envelopeError(status, envelope) {
  if (status === 401 || status === 403) return new WorkBuddyCredentialRejectedError(status)
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

// ---------------------------------------------------------------------------
// token 刷新（老插件 upstream.ts refreshToken 原样；凭据只在进程内存流转）
// ---------------------------------------------------------------------------

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/**
 * POST the token-refresh endpoint. 返回
 * `{ accessToken, refreshToken?, expiresInSec?, domain? }`；调用方负责合并。
 */
export async function refreshWorkBuddyToken(credential, fetchImpl) {
  const doFetch = fetchImpl ?? fetch
  const response = await doFetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: refreshHeaders(credential),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
  if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
  const outcome = { accessToken }
  if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
  if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
  if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
  return outcome
}

// ---------------------------------------------------------------------------
// 请求体重写（老插件 upstream.ts prepareChatBody 原样）
// ---------------------------------------------------------------------------

/**
 * Stand-in system message for a request that reached the wire carrying none.
 * Both WorkBuddy gateways want the conversation to OPEN with a system message,
 * and the international one enforces it（400 / 11128）。
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/** Make the conversation open with a system message. */
function ensureSystemHead(obj) {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const head = messages[0]
  if (typeof head !== 'object' || head === null || Array.isArray(head)) return
  const role = head['role']
  if (typeof role === 'string' && role.trim().toLowerCase() === 'system') return
  messages.unshift({ role: 'system', content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT })
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj['tools']
    delete obj['functions']
  }
  if (!('tool_choice' in obj)) return
  const choice = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') obj['tool_choice'] = type
    else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null ? wrapped['function'] : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else delete obj['tool_choice']
    return
  }
  delete obj['tool_choice']
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true`（上游拒绝非流式）, flatten `tool_choice`, and
 * guarantee a leading system message.
 */
export function prepareChatBody(source) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body
  obj['stream'] = true
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  ensureSystemHead(obj)
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** The model id a prepared body asks for, when it carries one. Never throws. */
export function modelIdOfBody(bodyJson) {
  try {
    const parsed = JSON.parse(bodyJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const model = parsed['model']
    return typeof model === 'string' && model !== '' ? model : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 上游 chat 流（老插件 WorkBuddyUpstreamClient.chatStream 的生成器形态）
// ---------------------------------------------------------------------------

/** 造一个带分类的上游失败；`server` 类是唯一 retryable 的（瞬时传输/5xx）。 */
function upstreamFailure(status, kind, message, detail) {
  const error = new Error(`workbuddy 上游失败（${kind}${status > 0 ? `, http ${status}` : ''}）：${String(message).slice(0, 400)}`)
  error.status = status
  error.kind = kind
  error.retryable = kind === 'server'
  if (detail !== undefined) error.detail = detail
  return error
}

/**
 * 发一条 chat 请求并逐帧产出解析后的 SSE chunk。
 *
 * 首帧之前的失败一律 throw（携带 `.kind` / `.status` / `.retryable`），
 * 由 shim 决定 HTTP 状态码；开始产出之后的失败同样 throw，由 shim 写
 * in-band SSE error 帧。
 */
export async function* streamChat(credential, bodyJson, { signal, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? fetch
  let response
  try {
    response = await doFetch(`${chatBase(credential)}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        ...chatHeaders(credential),
        'Authorization': `Bearer ${credential.accessToken}`,
      },
      body: bodyJson,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw upstreamFailure(0, 'server', `transport error: ${String(error)}`)
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    if (isGatewayAuthRejection(response.status, text)) {
      throw upstreamFailure(response.status, 'session_dead', text, parseUpstreamErrorDetail(text))
    }
    const kind = classifyUpstreamError(response.status, text)
    throw upstreamFailure(response.status, kind, text, parseUpstreamErrorDetail(text))
  }
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
      if (payload === '[DONE]') return
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      yield parsed
    }
  }
  buffer += decoder.decode()
  const tail = buffer.trimEnd()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload !== '' && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload)
      } catch {
        // 半截尾帧：丢给正常结束路径，反正客户端以 [DONE] 为准。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI 面 shim
// ---------------------------------------------------------------------------

/** Chat-completion POSTs must carry a JSON body type. */
function isJsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBodyCapped(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 启动 WorkBuddy 区域的 loopback OpenAI 面。
 *
 * @param {object} options
 * @param {{ current: () => object[] }} options.catalog 该区域模型目录
 * @param {() => Promise<object>} options.resolveCredential 每请求解析一次凭据
 *   （重登不重启即生效）；抛错或返回 undefined → 401 not_signed_in
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 测试注入；缺省全局 fetch
 * @returns {{ ready, baseUrl, token, close }}（由共享骨架产出）
 */
export function createWorkBuddyShim(options) {
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
          owned_by: 'workbuddy',
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
    if (!isJsonContentType(req)) {
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
    if (credential === undefined || credential === null) {
      writeOpenAiError(res, 401, 'not_signed_in', 'workbuddy: no signed-in WorkBuddy account found on this machine')
      return
    }

    let raw
    try {
      raw = (await readBodyCapped(req)).toString('utf8')
    } catch (error) {
      writeOpenAiError(res, 413, 'request_too_large', String(error))
      return
    }
    let clientBody
    try {
      clientBody = JSON.parse(raw)
    } catch (error) {
      writeOpenAiError(res, 400, 'invalid_request', `body is not JSON: ${String(error)}`)
      return
    }
    const wantStream = clientBody?.stream !== false
    const displayModel = typeof clientBody?.model === 'string' ? clientBody.model : undefined
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const iterator = streamChat(credential, prepared, { signal: controller.signal, fetchImpl })
    let first
    try {
      // 首块先落地再提交状态码：鉴权/配额失败以 HTTP 错误呈现，而不是半截流。
      first = await iterator.next()
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: workbuddy 上游首块前失败', error)
      if (error?.retryable === true) {
        writeOpenAiError(res, 503, 'rate_limit', String(error?.message ?? error))
        return
      }
      writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }

    if (!wantStream) {
      const content = []
      const toolCalls = new Map()
      let finish = 'stop'
      let usage
      try {
        for (let step = first; !step.done; step = await iterator.next()) {
          if (step.value?.usage !== undefined && step.value.usage !== null) usage = step.value.usage
          absorb(step.value, content, toolCalls, (f) => { finish = f })
        }
      } catch (error) {
        logger?.warn?.('dsh-agent-checkin: workbuddy 非流式聚合中途失败', error)
        writeOpenAiError(res, 502, 'upstream_error', String(error?.message ?? error))
        return
      }
      const message = { role: 'assistant', content: content.join('') }
      if (toolCalls.size > 0) message.tool_calls = [...toolCalls.values()]
      writeJson(res, 200, {
        id: `chatcmpl-${randomBytes(8).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: displayModel,
        choices: [{ index: 0, message, finish_reason: finish }],
        // 上游报了才带；缺席好过一个读作「这轮零成本」的捏造零值。
        ...(usage !== undefined ? { usage } : {}),
      })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        const chunk = step.value
        // 上游已是 OpenAI 形状的 SSE：choice 帧、usage 帧（choices: [] + 顶层
        // usage）一律原样转发。usage 帧是 pi-ai 记账的唯一来源，绝不能丢。
        writeSse(res, chunk)
      }
    } catch (error) {
      // 绝不用 [DONE] 结束一条断流：那等于告诉客户端「正常完赛」，把半截
      // 答案渲染成完整一轮。失败以 in-band SSE error 帧随流送达。
      logger?.warn?.('dsh-agent-checkin: workbuddy 流中断', error)
      const retryable = error?.retryable === true
      const kind = retryable ? 'rate_limit' : 'upstream_error'
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

/** Accumulate one non-streaming chunk into the final message. */
function absorb(chunk, content, toolCalls, setFinish) {
  const choice = chunk?.choices?.[0]
  if (choice === undefined) return
  const delta = choice.delta ?? choice.message ?? {}
  if (typeof delta.content === 'string') content.push(delta.content)
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      const index = call.index ?? 0
      const current = toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (call.id) current.id = call.id
      if (call.function?.name) current.function.name = call.function.name
      if (call.function?.arguments) current.function.arguments += call.function.arguments
      toolCalls.set(index, current)
    }
  }
  if (choice.finish_reason) setFinish(choice.finish_reason)
}
