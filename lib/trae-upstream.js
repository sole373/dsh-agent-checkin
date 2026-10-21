/**
 * TRAE upstream client：往 Cloud-IDE-JWT 的 agent task 端点发消息。
 *
 * 为什么不是 OpenAI 兼容端点
 * --------------------------
 * TRAE CN 唯一可编程的面是 `/api/cue_agent/v3/create_agent_task`。它不是
 * `/v1/chat/completions`：没有 `model` 字段、不接 OpenAI 形态的 messages
 * 数组、响应是带 `event:` 行的事件流而不是 message。上层 `trae-shim.js`
 * 负责把 OpenAI 兼容面翻译成这里的请求体。
 *
 * 端点与请求体（2026-10-18 本机实测逐字段取证）
 * --------------------------------------------
 *   host: `https://trae-api-cn.mchost.guru`  ← 不是 api.trae.cn
 *   path: `/api/cue_agent/v3/create_agent_task`
 *
 * 这个 host 是本机 `%APPDATA%\TRAE CN\ahanet\server.json`（TTNet 网络层
 * 配置）里的 `trae-api-cn.mchost.guru` 逆向出来的。四组合实测结论：
 *   trae-api-cn.mchost.guru  → 401（路由存在，只差鉴权）
 *   api.trae.cn             → 404 TLB（签到/余额族，不含模型调用）
 *   a0ai-api.byteintlapi.com→ 404 TLB
 *   copilot.byteintl.net    → DNS 不可达
 * 踩过的坑：一开始照 DomainConfig 里的 byteintl 域名猜，那边要的是
 * `Byte-Cloud-JWT`；`trae-api-cn.mchost.guru` 只要本地凭证自带的
 * `Cloud-IDE-JWT`，不需要换 token。
 *
 *   请求体（缺字段时上游 4001 会逐字点名缺哪个，顺序即发现顺序）：
 *     conversation_id     UUID，多轮历史靠它在服务端累积
 *     session_id          与 conversation_id 同值
 *     user_id             凭证 userId
 *     device_id           凭证 deviceId
 *     agent_type          'cue_builder'
 *     model_name          目录里的 config_name（34 个全部实测可直传）
 *     config_name         同 model_name
 *     ide_version          客户端版本，本机 '3.4.3'
 *     plugin_channel      'icube-ai'
 *     available_tool_list []（不发起本地工具调用）
 *     user_input          { id:'test', messages:[{type:'text', text_content}] }
 *                         ← 注意是 struct 不是 string，传 string 会被拒：
 *                         `cannot unmarshal string into Go struct field
 *                          CreateAgentTaskRequest.user_input of type
 *                          cueagent.UserInput`
 *     render_context      { variables: JSON.stringify({ide_language:'zh'}),
 *                           references: {} }
 *     stream              true
 *     request_id          UUID，重试去重
 *     max_tokens           只在显式传时写
 *
 * 构造这些字段的客户端源码位置（只读取证，未改动任何文件）：
 *   `resources\app\extensions\ai-completion\resource\aiserver\cueMain.js`
 *     @3314599 函数 `sXe({renderContext, conversation_id})` —— body 构造器
 *     @3080401 默认值块 `{AGENT_TYPE:'cue_builder', MODEL_NAME:'deepsearch',
 *                          CONFIG_NAME:'deepsearch', ...}`
 *     @3082798 `USER_INPUT:{id:'test',messages:[{type:'text',text_content:''}]}`
 *     @3081641 `AVAILABLE_TOOLS:['get_code_of_class',...,'exit']`
 *
 * 幂等与错误契约
 * -------------
 *   - `request_id` 由调用方传入（本模块兜底生成 UUID），同一轮重试不会
 *     真的重复扣额度——TRAE 侧靠这个去重。
 *   - 401/403/402/429/404/5xx 映射成 auth / credit / rate / not_found /
 *     server，上层据此决定是否 break 或换模型。
 *   - 网络错误不猜根因，抛 `TraeUpstreamError` 并把原文带出去。
 *
 * @module dsh-agent-checkin/trae-upstream
 */

import { randomUUID } from 'node:crypto'

/**
 * 默认上游基址。
 *
 * 写死而不是从凭证 `host` 字段取：凭证里的 host 是 `https://api.trae.cn`，
 * 那是签到/余额的域，模型调用在上面 404。所以这里显式覆盖，
 * `options.baseURL` 仍然留给测试与未来多区域用。
 */
export const DEFAULT_AGENT_HOST = 'https://trae-api-cn.mchost.guru'

/** agent task 端点（相对片断，与客户端源码逐字一致）。 */
export const AGENT_TASK_PATH = '/api/cue_agent/v3/create_agent_task'

/** 默认超时。agent 一轮会跑工具调用，比一次纯 chat 慢，给 120s。 */
const DEFAULT_TIMEOUT_MS = 120_000

/** 错误大类：上游怎么回的，我们就怎么归因，不猜。 */
export const ERROR_KIND = {
  auth: 'auth',
  credit: 'credit',
  rate: 'rate',
  not_found: 'not_found',
  server: 'server',
  client: 'client',
  network: 'network',
  timeout: 'timeout',
}

/**
 * HTTP 状态码 → 错误大类：
 *   401/403 → auth
 *   402     → credit（余额不足，重试无意义）
 *   429     → rate（限流等一会儿）
 *   404     → not_found
 *   >=500   → server
 *   其余    → client（4xx 里没单列的一律算客户端问题，如 4001 参数错）
 */
export function errorKindFromStatus(status) {
  if (status === 401 || status === 403) return ERROR_KIND.auth
  if (status === 402) return ERROR_KIND.credit
  if (status === 429) return ERROR_KIND.rate
  if (status === 404) return ERROR_KIND.not_found
  if (status >= 500) return ERROR_KIND.server
  return ERROR_KIND.client
}

export class TraeUpstreamError extends Error {
  constructor(message, { kind = ERROR_KIND.client, status, body, cause } = {}) {
    super(message)
    this.name = 'TraeUpstreamError'
    this.kind = kind
    this.status = status
    this.body = body
    if (cause) this.cause = cause
  }
}

/**
 * 客户端默认 agent 类型。
 *
 * 实测 `agent_type` 传任意值都能过（上游不校验），但取客户端默认值最稳：
 * `cue_builder` 会走「检索 → 工具调用 → thought」那条完整路径，响应里
 * 带 token_usage 与 task_completion。
 */
export const DEFAULT_AGENT_TYPE = 'cue_builder'

/** `x-app-id`：与客户端 buildHeaders 同值。 */
export const DEFAULT_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * 从 OpenAI 的 messages 数组里取出「本轮要发的文本」。
 *
 * TRAE 侧不是把整个 messages 数组回传——多轮历史由 `conversation_id`
 * 在服务端累积，客户端每轮只发新的 user 文本。所以这里只取最后一条
 * user/assistant 可见内容；system 与前几轮历史按客户端的行为丢弃。
 *
 * 如实说明这个取舍：本插件因此**不是**无状态的多轮代理，每轮的上下文
 * 依赖同一个 conversation_id 在服务端活着。
 *
 * @param {Array<{role:string, content:string|Array}>} messages
 * @returns {string}
 */
export function extractPromptText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    if (typeof m.content === 'string' && m.content.trim()) return m.content
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
      if (texts.join('').trim()) return texts.join('')
    }
  }
  throw new TraeUpstreamError('messages 里没有可发送的文本内容', {
    kind: ERROR_KIND.client,
  })
}

/**
 * 构造 agent task 请求体。
 *
 * 与 `trae-shim.js` 的分工：这一层只认协议字段，不管 OpenAI 语义；
 * `model` 语义（哪个目录项）由 adapter 决定后传入。
 *
 * @param {object} options
 * @param {string} options.model              目录 config_name，直传
 * @param {Array}  [options.messages]         OpenAI 形态消息，取最后一条文本
 * @param {string} [options.prompt]           直接给文本（优先于 messages）
 * @param {string} [options.conversationId]   多轮会话 id；缺省生成新 UUID
 * @param {string} [options.requestId]        缺省生成新 UUID
 * @param {object} [options.identity]         { userId, deviceId }
 * @param {string} [options.ideVersion]       客户端版本号
 * @param {string} [options.agentType]        默认 DEFAULT_AGENT_TYPE
 * @param {string} [options.pluginChannel]    默认 'icube-ai'
 * @param {number} [options.maxTokens]        只在有限正数时写
 */
export function buildAgentTaskBody({
  model,
  messages,
  prompt,
  conversationId,
  requestId,
  identity = {},
  ideVersion = '3.4.3',
  agentType = DEFAULT_AGENT_TYPE,
  pluginChannel = 'icube-ai',
  maxTokens,
}) {
  if (!model) {
    throw new TraeUpstreamError('缺少 model（目录 config_name）', { kind: ERROR_KIND.client })
  }
  const text = prompt ?? extractPromptText(messages)

  const conversation_id = conversationId || randomUUID()
  const body = {
    conversation_id,
    session_id: conversation_id,
    user_id: identity.userId ?? '',
    device_id: identity.deviceId ?? '',
    agent_type: agentType,
    model_name: model,
    config_name: model,
    ide_version: ideVersion,
    plugin_channel: pluginChannel,
    available_tool_list: [],
    user_input: { id: 'test', messages: [{ type: 'text', text_content: text }] },
    render_context: {
      variables: JSON.stringify({ ide_language: 'zh' }),
      references: {},
    },
    stream: true,
    request_id: requestId || randomUUID(),
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.trunc(maxTokens)
  return body
}

/**
 * 发一轮 agent task，返回原始 Response（调用方负责读流）。
 *
 * 刻意不在这里 `await response.text()`：上层要做流式转发，一次读完就
 * 把 SSE 降级成批式。
 *
 * @param {object} options
 * @param {string} [options.baseURL]    默认 DEFAULT_AGENT_HOST
 * @param {string} options.accessToken  Cloud-IDE-JWT
 * @param {object} [options.identity]   身份头
 * @param {object} options.body         buildAgentTaskBody 的产物
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Response>}
 */
export async function sendAgentTask({
  baseURL = DEFAULT_AGENT_HOST,
  accessToken,
  identity = {},
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!accessToken) {
    throw new TraeUpstreamError('缺少 accessToken（凭证已过期？）', { kind: ERROR_KIND.auth })
  }
  if (!body || typeof body !== 'object') {
    throw new TraeUpstreamError('缺少请求体', { kind: ERROR_KIND.client })
  }

  const url = `${baseURL.replace(/\/+$/, '')}${AGENT_TASK_PATH}`
  const started = Date.now()
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders({ accessToken, identity }),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    throw new TraeUpstreamError(`上游请求失败：${error?.message || error}`, {
      kind: aborted ? ERROR_KIND.timeout : ERROR_KIND.network,
      cause: error,
    })
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    // 上游 4001 的 message 会逐字点名缺哪个字段，原样带出去，别吞。
    throw new TraeUpstreamError(
      `上游返回 HTTP ${response.status}（${Date.now() - started}ms）：${raw.slice(0, 300)}`,
      { kind: errorKindFromStatus(response.status), status: response.status, body: raw },
    )
  }
  return response
}

/**
 * 发一轮 agent task 并把整个 body 读完（测试与非流式路径用）。
 * @returns {Promise<{status:number, body:string, headers:Headers}>}
 */
export async function sendAgentTaskFull(options) {
  const response = await sendAgentTask(options)
  const text = await response.text()
  return { status: response.status, body: text, headers: response.headers }
}

/**
 * 组装上游鉴权头。
 *
 * 头部清单来自 cueMain.js @2980443 的 `getJwtTokenHeaderObj` 与
 * ApiManager 的 `headers = {"X-App-Id": ..., ...e.headers, ...h}`：
 *   Authorization = `${jwtTokenType} ${jwtToken}`，jwtTokenType 本机是
 *   `Cloud-IDE-JWT`（`authInfo.jwtTokenType`，默认 `DEFAULT_IDE_TOKEN_TYPE`）。
 *
 * 设备类头只在有值时 set：编一个假 deviceId 比不发的后果严重得多
 * （服务端会按设备号记账），所以缺项一律省略而不是编默认值。
 */
export function buildHeaders({ accessToken, identity = {} }) {
  const headers = new Headers({
    Authorization: `Cloud-IDE-JWT ${accessToken}`,
    'x-plugin-channel': identity.pluginChannel || 'icube-ai',
    'x-app-id': identity.appId || DEFAULT_APP_ID,
    'x-custom-trace-id': identity.traceId || randomUUID().replace(/-/g, ''),
    'x-flow-traceparent': identity.traceparent
      || `04-${randomUUID().replace(/-/g, '')}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  })
  if (identity.deviceId) headers.set('x-device-id', identity.deviceId)
  if (identity.machineId) headers.set('x-machine-id', identity.machineId)
  if (identity.region) headers.set('X-User-Region', identity.region)
  if (identity.uid) headers.set('x-uid', identity.uid)
  if (identity.requestId) {
    headers.set('x-request-id', identity.requestId)
    headers.set('x-trae-request-id', identity.requestId)
  }
  return headers
}

/** 上游 `x-*-version-code` 只认纯数字；带点号的构建串一律回退到 fallback。 */
function normalizeVersionCode(value) {
  if (value == null) return null
  const digits = String(value).replace(/\D+/g, '')
  return digits || null
}
