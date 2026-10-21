/**
 * TRAE 网关协议客户端（OpenAI 形态对话 → `llm_utils_chat`）。
 *
 * 实测取证（2026-10-18，本机 CN 凭据逐项探测）
 * ------------------------------------------------------------
 * **早期用 `/api/ide/v2/llm_raw_chat` 是错的**：该端点对任何合法 JSON
 * 请求体一律回 HTTP 400 空 body（GET、非 JSON、空体反而回 200+`code:4001`），
 * 本机 TRAE CN 客户端产物（18.7MB workbench bundle + ai-completion bundle）
 * 已完全不含 `pass_back_reasoning`/`config_name` 字样 —— 该 DTO 是 ref
 * `buildTraeRawChatDraft` 的「evidence-gated 推断」（ref 原文自述「inferred
 * from Trae's LLMRaw* DTO symbols」，且其能力控制器以 `enabled:false` 接线、
 * 从不上生产）。**故整个路由改为实测可用的 `llm_utils_chat`**：
 *
 *   - 端点：`POST ${REGION_GATEWAYS[region].chat}/api/agent/v3/llm_utils_chat`
 *     （ref `TRAE_SOLO_CHAT_PATH` :2983 + `chatStream` :3199）。
 *   - 请求体（ref `prepareSoloBody` :2996-3037）：
 *     `{ messages, model, config_name: model, function, stream: true,
 *        tools?, reasoning_effort? }`
 *     - `messages[].content` 字符串 → `[{type:'text',text}]`；
 *     - `role:'developer'` → `'system'`；
 *     - `assistant.tool_calls[].function` → 改名 `function_call`；
 *     - `role:'tool'` 必须带 `tool_call_id`；
 *     - `tools[].function.parameters` → `JSON.stringify`。
 *   - **`function` 决定模型可用性**（2026-10-18 本机 34 模型逐一实测，ref
 *     :3366 同结论）：模型只能通过「列出它的那个 SOLO function」调用，
 *     否则 200 流里回 `event:error`。实测分层：
 *       · 只认单一 function：`glm-5.3` / `deepseek-v4.1-flash` /
 *         `step-5-preview` 仅 `solo_work_remote`；`DeepSeek-V4-Flash` /
 *         `DeepSeek-V4-Pro` / `glm-5` / `qwen-3.5` 仅 `solo_coder`；
 *         `Doubao-Seed-Code` 仅 `solo_agent_remote`。
 *       · 多 function 可用：`DeepSeek-V4-Flash-Official` 在
 *         `solo_work_remote`/`solo_work_lite`/`solo_agent_remote` 通，
 *         但 `chat_v3` 回 **1005**（付费计划不覆盖）、`solo_coder` 回 4001
 *         —— 不是「全通」。
 *       · 任意 function 都 4001（上游不服务，插件不隐藏）：
 *         `deepseek//deepseek-v4-flash`、`deepseek//deepseek-v4-pro`
 *         （自定义 base_url 变体）、`kimi-k2.8-preview`、`qwen3.8-flash`
 *         （目录只把它们挂在非 chat 分类 `solo_agent` 上）。
 *     结果：本机 34 个可选模型 **30 个可调用 / 4 个上游拒绝**。
 *   - 响应：`text/event-stream`，命名帧 —— `output`（delta：
 *     `data:{response, reasoning_content, tool_calls}`）、`token_usage`
 *     （`{prompt_tokens,completion_tokens,total_tokens,reasoning_tokens,
 *     cache_read_input_tokens,cache_creation_input_tokens}`）、
 *     `done`（`{finish_reason}`）、`metadata`/`timing_cost`/`progress_notice
 *     `/`extra_info`/`request_wait_in_queue`（忽略）。
 *   - 错误：HTTP 非 200 按状态码归类；**藏在 200 流里的**
 *     `event:error`（码表见 TRAE_ERROR_HINTS）必须抛出。
 *   - region 判定（`regionOfCredential`，ref :1622-1624）：`userRegion` 声明
 *     优先，host 后缀次之（`.trae.ai`→ai，`.trae.cn`→cn），edition 兜底
 *     （`sg`/`solo-sg`→ai，其余 cn）。
 *
 * 大量代码借自 ref/connect-trae（dsh-connect-trae@3.7.0）。
 * Copyright (c) dingminhua. MIT License — 见 ref/connect-trae/package/LICENSE。
 *
 * @module dsh-agent-checkin/connect/trae/upstream-raw
 */

import { randomUUID } from 'node:crypto'

/** 实测可用的对话路径；`v2/llm_raw_chat` 已实测不可用，仅留作记录。 */
export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const TRAE_RAW_CHAT_V2_PATH = '/api/ide/v2/llm_raw_chat'
export const TRAE_RAW_CHAT_V1_PATH = '/api/ide/v1/llm_raw_chat'

/**
 * 目录 function 的兜底顺序（实测 2026-10-18 + ref :2968-2982）。
 * 目录条目带 `appearedIn` 时按其顺序试；两者都没有时按此顺序兜底。
 * 前两位是 ref 的 cn/ai 目录函数表头两项：
 *   `solo_work_remote`（实测 glm-5.3 / deepseek-v4.1-flash 唯一可用的）
 *   `solo_work_lite`（ref TRAE_SOLO_FUNCTION）
 * `solo_agent`/`solo_design_*`/`builder_v3` 只在**远端目录**里出现
 * （ref TRAE_REMOTE_DIRECTORY_FUNCTIONS :3853-3872），`get_detail_param`
 * 与本机 vscdb 目录都不产它们；带上它们只会让回退落在一个不服务的 function 上。
 */
export const TRAE_DEFAULT_FUNCTION_FALLBACK = [
  'solo_work_remote',
  'solo_work_lite',
  'solo_agent_remote',
  'chat_v3',
  'solo_coder',
]

/**
 * 各区域已验证网关基址（ref :1575-1590）。
 * ai.chat：国际版（Trae 桌面 / TRAE SOLO）共享的稳定入口。
 */
export const REGION_GATEWAYS = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
}

/** ref 与客户端共用的 x-app-id（与 lib/trae-upstream.js 的 DEFAULT_APP_ID 同值）。 */
export const DEFAULT_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * 非数字构建号的回退版本码（ref :2809）：上游按数字绑定
 * `x-app-version-code`，存成点分串会被 4001 拒掉。
 */
export const TRAE_VERSION_CODE_FALLBACK = '20260716'

/** 错误归类（语义对齐 ref 的 authentication/hard_credit/soft_rate/...）。 */
export const RAW_ERROR_KIND = {
  auth: 'auth',
  credit: 'credit',
  rate: 'rate',
  notFound: 'not_found',
  server: 'server',
  client: 'client',
}

/** 带上游归类的可读错误。retryable = 限流/服务端，宿主/调用方据此决定重试。 */
export class TraeRawChatError extends Error {
  constructor(message, { kind = RAW_ERROR_KIND.server, status, code, retryable, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TraeRawChatError'
    this.kind = kind
    this.status = status
    this.code = code
    this.retryable = retryable === true
  }
}

/** HTTP 状态码 → 错误归类（ref `errorKind` :4099-4106）。 */
export function errorKindFromStatus(status) {
  if (status === 401 || status === 403) return RAW_ERROR_KIND.auth
  if (status === 402) return RAW_ERROR_KIND.credit
  if (status === 429) return RAW_ERROR_KIND.rate
  if (status === 404) return RAW_ERROR_KIND.notFound
  if (status >= 500) return RAW_ERROR_KIND.server
  return RAW_ERROR_KIND.client
}

// ---------------------------------------------------------------------------
// region 判定（ref src/region.ts :1587-1624，MIT）
// ---------------------------------------------------------------------------

/** edition 标签 → region：国际版安装属于 `ai`。 */
export function regionOfEdition(edition) {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/** `userRegion` 声明 → region；对象与裸字符串两种拼写都认，大小写不敏感。 */
export function regionOfUserRegion(value) {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value.region
    : value
  if (typeof raw !== 'string') return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'cn') return 'cn'
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/** 凭据 host 后缀 → region（`.trae.ai`→ai，`.trae.cn`/`.trae.com.cn`→cn）。 */
export function regionOfHost(host) {
  if (host === undefined || host === null) return undefined
  const trimmed = String(host).trim()
  if (trimmed === '') return undefined
  let hostname
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return undefined
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai'
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')) return 'cn'
  return undefined
}

/**
 * 凭据所属 region：userRegion 声明优先，host 后缀次之，edition 兜底。
 * 每一级都来自凭据自身携带的数据，不需要用户配置（ref :1617-1624）。
 */
export function regionOfCredential(credential) {
  return regionOfUserRegion(credential?.userRegion ?? credential?.region)
    ?? regionOfHost(credential?.host)
    ?? regionOfEdition(credential?.edition)
}

// ---------------------------------------------------------------------------
// 请求头（ref `buildTraeHeaders` :2822-2867，profile 'raw-chat'，MIT）
// ---------------------------------------------------------------------------

/** 只保留纯数字构建号；绑不上时回退（ref `normalizeTraeVersionCode` :2811）。 */
export function normalizeTraeVersionCode(buildVersion) {
  if (buildVersion === undefined || buildVersion === null || String(buildVersion).trim() === '') {
    return TRAE_VERSION_CODE_FALLBACK
  }
  const trimmed = String(buildVersion).trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/**
 * raw-chat 请求头。
 *
 * 设备身份头**有才发、没有绝不编**（假 deviceId 比不发后果严重——服务端按
 * 设备号记账）。`identity` 形状：`{ deviceId?, machineId?, platform?,
 * appVersion?, buildVersion?, appId? }`。
 */
export function buildRawChatHeaders({ credential, identity = {}, requestId } = {}) {
  const rid = requestId ?? randomUUID()
  const traceId = rid.replaceAll('-', '').slice(0, 32)
  const versionCode = normalizeTraeVersionCode(identity.buildVersion)
  const headers = {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': identity.appId ?? DEFAULT_APP_ID,
    'x-app-version-code': versionCode,
    'x-ide-version-code': versionCode,
    'x-ide-version-type': 'stable',
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    // profile 'raw-chat' 与默认 'agent-task' 的差异就是这一行（ref :2853）。
    'Accept': 'text/event-stream',
  }
  if (identity.deviceId !== undefined) headers['x-device-id'] = identity.deviceId
  if (identity.machineId !== undefined) headers['x-machine-id'] = identity.machineId
  if (identity.platform !== undefined) {
    headers['x-device-type'] = identity.platform === 'darwin'
      ? 'mac'
      : identity.platform === 'win32'
        ? 'windows'
        : identity.platform
  }
  if (identity.appVersion !== undefined) {
    headers['x-app-version'] = identity.appVersion
    headers['x-ide-version'] = identity.appVersion
  }
  return headers
}

// ---------------------------------------------------------------------------
// 请求体（ref `prepareSoloBody` :2996-3037，MIT）
// ---------------------------------------------------------------------------

/**
 * 把 OpenAI 形态消息归一化成 TRAE 要的形状。
 * 规则全部来自 ref `prepareSoloBody` :3008-3028（实测等价）：
 *   - `developer` 角色 → `system`；
 *   - 字符串 content → `[{type:'text',text}]`（数组原样透传，图片 part 已在
 *     baseadapter 侧转成 `{type:'image_url',image_url:{url}}`，TRAE 认）；
 *   - `assistant.tool_calls[].function` → 改名 `function_call`；
 *   - `role:'tool'` 必须带 `tool_call_id`（缺了上游 400）。
 *
 * @param {Array} messages OpenAI 形态消息数组
 * @returns {Array} 归一化后的消息数组（深拷贝，不改入参）
 */
export function normalizeSoloMessages(messages) {
  const out = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = { ...raw }
    if (message.role === 'developer') message.role = 'system'
    if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.map((call) => {
        if (typeof call !== 'object' || call === null) return call
        if (typeof call.function !== 'object' || call.function === null) return call
        return { ...call, function_call: call.function, function: undefined }
      }).map((call) => {
        const { function: _drop, ...rest } = call
        return rest
      })
    }
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || message.tool_call_id === '')) {
      throw new Error('Trae tool message requires tool_call_id')
    }
    out.push(message)
  }
  return out
}

/** tools[].function.parameters 对象 → JSON 字符串（ref :3029-3035）。 */
function normalizeSoloTools(tools) {
  return tools.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw
    const fn = raw.function
    if (typeof fn !== 'object' || fn === null) return raw
    if (typeof fn.parameters === 'object' && fn.parameters !== null) {
      return { ...raw, function: { ...fn, parameters: JSON.stringify(fn.parameters) } }
    }
    return raw
  })
}

/**
 * 构造 llm_utils_chat 请求体。
 *
 * @param {object} request
 * @param {string} request.model 上游模型名（= 目录 id = config_name）
 * @param {Array} request.messages OpenAI 形态消息
 * @param {string} request.function SOLO function 名（模型只能经列出它的
 *   function 调用；见 trae-catalog 的 appearedIn）
 * @param {string} [request.configName] 默认取 model
 * @param {number} [request.maxTokens]
 * @param {string} [request.reasoningEffort] 透传 reasoning_effort
 * @param {number} [request.temperature]
 * @param {Array} [request.tools]
 */
export function buildRawChatBody(request) {
  if (typeof request?.model !== 'string' || request.model.trim() === '') {
    throw new Error('Trae raw chat requires a model')
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new Error('Trae raw chat requires messages')
  }
  const functionName = typeof request.function === 'string' && request.function.trim() !== ''
    ? request.function.trim()
    : TRAE_DEFAULT_FUNCTION_FALLBACK[0]
  return {
    messages: normalizeSoloMessages(request.messages),
    model: request.model,
    config_name: request.configName ?? request.model,
    function: functionName,
    stream: true,
    ...request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: normalizeSoloTools(structuredClone([...request.tools])) },
    ...request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens },
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort },
  }
}

/**
 * 目录 function 的派发顺序（实测 2026-10-18 + ref :2968-2982）。
 *
 * 本机 `state.vscdb` 的 `appearedIn` 分类比 ref 的 function 表更细
 * （多出 `assistant`/`agent`/`solo_design_lite`/`solo_design_remote` 这些
 * 不是 chat function 的分类名），所以**不能直接拿 appearedIn[0] 当 function**
 * ——照抄会把 `kimi-k2.8-preview`/`qwen3.8-flash` 派到 `solo_agent` 上。
 *
 * 规则：只按本表（= ref TRAE_DIRECTORY_FUNCTIONS 的 cn 表）的优先级在
 * appearedIn 里挑；挑不到就落到表头 `solo_work_remote`（实测覆盖最广）。
 *
 * @param {{ appearedIn?: string[] }|undefined} entry 目录条目
 * @returns {string} function 名
 */
export function functionOfCatalogEntry(entry) {
  const appeared = Array.isArray(entry?.appearedIn)
    ? entry.appearedIn.filter((x) => typeof x === 'string' && x.trim() !== '')
    : []
  for (const preferred of TRAE_DEFAULT_FUNCTION_FALLBACK) {
    if (appeared.includes(preferred)) return preferred
  }
  return TRAE_DEFAULT_FUNCTION_FALLBACK[0]
}

// ---------------------------------------------------------------------------
// 响应解析（ref `decodeTraeEvent` :3280-3344，MIT）
// ---------------------------------------------------------------------------

/**
 * 把一帧已解析的 JSON（或 '[DONE]'）译成增量事件数组：
 *   { type:'text', text } / { type:'reasoning', text } /
 *   { type:'tool-call', index, id?, name?, arguments? } /
 *   { type:'done', finishReason } /
 *   { type:'usage', usage }   ← usage 保留上游原始字段名（prompt_tokens 等），
 *                               shim 原样转发给 pi-ai 读 token 计数
 *   { type:'unknown', value } ← 不认识的结构原样保留，不丢
 */
export function decodeRawChatChunk(value, eventName) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ type: 'unknown', value }]
  }
  const record = value
  const result = []

  if (eventName === 'token_usage') {
    const details = {
      ...typeof record.cache_read_input_tokens === 'number'
        ? { cached_tokens: record.cache_read_input_tokens }
        : {},
      ...typeof record.cache_creation_input_tokens === 'number'
        ? { cache_write_tokens: record.cache_creation_input_tokens }
        : {},
    }
    return [{
      type: 'usage',
      usage: {
        ...typeof record.prompt_tokens === 'number' ? { prompt_tokens: record.prompt_tokens } : {},
        ...typeof record.completion_tokens === 'number' ? { completion_tokens: record.completion_tokens } : {},
        ...typeof record.total_tokens === 'number' ? { total_tokens: record.total_tokens } : {},
        ...typeof record.reasoning_tokens === 'number' ? { reasoning_tokens: record.reasoning_tokens } : {},
        ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
      },
    }]
  }

  if (eventName === 'done') {
    return [{ type: 'done', finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : 'stop' }]
  }

  if (eventName === 'output') {
    if (typeof record.reasoning_content === 'string' && record.reasoning_content !== '') {
      result.push({ type: 'reasoning', text: record.reasoning_content })
    }
    if (typeof record.response === 'string' && record.response !== '') {
      result.push({ type: 'text', text: record.response })
    }
    const rawCalls = Array.isArray(record.tool_calls) ? record.tool_calls : []
    rawCalls.forEach((rawTool, index) => {
      if (typeof rawTool !== 'object' || rawTool === null) return
      // TRAE 可能用 `function_call` 或 `function` 两种键名（ref :3461）。
      const fn = typeof rawTool.function_call === 'object' && rawTool.function_call !== null
        ? rawTool.function_call
        : typeof rawTool.function === 'object' && rawTool.function !== null
          ? rawTool.function
          : {}
      result.push({
        type: 'tool-call',
        index: typeof rawTool.index === 'number' ? rawTool.index : index,
        ...typeof rawTool.id === 'string' ? { id: rawTool.id } : {},
        ...typeof fn.name === 'string' ? { name: fn.name } : {},
        ...typeof fn.arguments === 'string' ? { arguments: fn.arguments } : '',
      })
    })
    // 没有内容的 output 帧（进度噪声等）返回空数组，不当成 unknown。
    return result
  }

  return result.length === 0 ? [{ type: 'unknown', value }] : result
}

// ---------------------------------------------------------------------------
// 流内错误识别（ref src/solo-bridge.ts :3384-3459，MIT）
// ---------------------------------------------------------------------------

/**
 * 上游流内错误码含义（ref 实测码表 :3384-3391，2026-10-01/10-12 活凭据测量）。
 * 这些错误以 HTTP 200 的 SSE 帧出现，不抛出来就会被当成「正常但短」的回答。
 */
const TRAE_ERROR_HINTS = {
  1005: 'Trae requires a paid plan for this model; the current account plan does not cover it',
  2001: 'Trae has not published its function config for this route (an upstream condition, not a local credential or config problem)',
  4001: 'Trae does not serve this model under the route the request used (config_name rejected)',
  4008: 'Trae reports the account quota is exhausted for this request',
  4011: 'Trae throttled this account (a rate limit, not the credit balance)',
  4023: 'Trae does not recognise this model name on the route that was asked',
}

/**
 * 识别一帧是否为流内错误。认三种形状：
 *   - `event:error` + `data:{"code":<n>,"message":...}`（SOLO 实测形状）；
 *   - 无名事件但 data 里有 `code` ≥ 4000（ref `traeFailureOf` :3449 的兜底）；
 *   - OpenAI 错误信封 `{"error":{"message","code"|"type"}}`（raw 端点防御）。
 * 是错误时返回 `{ code?, message, extra? }`，否则 undefined。
 */
export function traeFailureOfFrame(eventName, payload) {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload
    : undefined
  if (record?.error !== undefined && typeof record.error === 'object' && record.error !== null) {
    return {
      ...typeof record.error.code === 'number' ? { code: record.error.code } : {},
      message: typeof record.error.message === 'string' ? record.error.message : 'upstream error',
    }
  }
  const code = typeof record?.code === 'number' ? record.code : undefined
  if (eventName !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: typeof record?.message === 'string' ? record.message : '',
    ...record?.extra === undefined ? {} : { extra: record.extra },
  }
}

/** 流内错误 → TraeRawChatError：`1005`→credit，`4011`→rate，其余 client。 */
export function traeFailureToError(failure) {
  const hint = failure.code === undefined
    ? 'Trae refused the request'
    : TRAE_ERROR_HINTS[failure.code] ?? 'Trae refused the request'
  const coded = failure.code === undefined ? hint : `${hint} · Trae code ${failure.code}`
  const detail = typeof failure.message === 'string' ? failure.message.trim() : ''
  const message = detail === '' ? coded : `${coded} · upstream: ${detail}`
  if (failure.code === 1005) {
    return new TraeRawChatError(message, { kind: RAW_ERROR_KIND.credit, status: 402, code: failure.code })
  }
  if (failure.code === 4011) {
    return new TraeRawChatError(message, {
      kind: RAW_ERROR_KIND.rate, status: 429, code: failure.code, retryable: true,
    })
  }
  return new TraeRawChatError(message, { kind: RAW_ERROR_KIND.client, status: 400, code: failure.code })
}

// ---------------------------------------------------------------------------
// SSE 帧切分（`data:` 行 + 空行收尾；CRLF 兼容；注释帧跳过）
// ---------------------------------------------------------------------------

function splitSseFrames(buffer) {
  const frames = []
  let rest = buffer
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest)
    if (match === null) break
    const rawFrame = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)
    let event
    const dataLines = []
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0) continue
    frames.push({ event, data: dataLines.join('\n') })
  }
  return { frames, rest }
}

// ---------------------------------------------------------------------------
// 主入口：流式 + 非流式
// ---------------------------------------------------------------------------

/**
 * 发一轮 llm_raw_chat，逐块 yield 已解析的增量事件
 * （text / reasoning / tool-call / usage / done）。
 *
 * @param {object} options
 * @param {string} options.region 'cn' | 'ai'（决定网关基址）
 * @param {object} options.credential `{ accessToken, ... }`
 * @param {object} [options.identity] 见 buildRawChatHeaders
 * @param {object} options.request 见 buildRawChatBody
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl] 测试注入；缺省全局 fetch
 * @param {string} [options.baseUrl] 覆盖网关基址（测试用）
 * @throws {TraeRawChatError} HTTP 非 200、传输失败、流内错误帧一律抛出
 */
export async function* streamRawChat({ region, credential, identity, request, signal, fetchImpl, baseUrl } = {}) {
  const doFetch = fetchImpl ?? fetch
  const gateway = baseUrl ?? REGION_GATEWAYS[region]?.chat
  if (gateway === undefined) {
    throw new TraeRawChatError(`unknown Trae region: ${String(region)}`, { kind: RAW_ERROR_KIND.client })
  }
  const url = `${gateway.replace(/\/$/, '')}${TRAE_SOLO_CHAT_PATH}`
  const headers = buildRawChatHeaders({ credential, identity })
  const body = buildRawChatBody(request)

  let response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
    })
  } catch (error) {
    // 主动 abort 不是上游错误，原样向上传（调用方安静收尾）。
    if (error?.name === 'AbortError') throw error
    throw new TraeRawChatError(`transport error: ${String(error?.message ?? error)}`, {
      kind: RAW_ERROR_KIND.server, retryable: true,
    })
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 1024)
    const kind = errorKindFromStatus(response.status)
    throw new TraeRawChatError(text || `Trae Raw Chat returned HTTP ${response.status}`, {
      kind,
      status: response.status,
      retryable: kind === RAW_ERROR_KIND.rate || kind === RAW_ERROR_KIND.server,
    })
  }
  if (!response.body) {
    throw new TraeRawChatError('Trae Raw Chat returned 200 without a readable body', {
      kind: RAW_ERROR_KIND.server, status: response.status, retryable: true,
    })
  }

  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const drain = function* (frames) {
    for (const frame of frames) {
      yield* eventsOfFrame(frame)
    }
  }
  for await (const piece of response.body) {
    buffer += decoder.decode(piece, { stream: true })
    const { frames, rest } = splitSseFrames(buffer)
    buffer = rest
    yield* drain(frames)
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    // 对端没发结束空行就关流：把压在 buffer 里的最后一帧也解出来。
    const { frames } = splitSseFrames(`${buffer}\n\n`)
    yield* drain(frames)
  }
}

/** 单帧 → 事件序列；流内错误帧在此抛出（绝不当作正常内容放过）。 */
function* eventsOfFrame(frame) {
  if (frame.data === '[DONE]') {
    yield { type: 'done', finishReason: 'stop' }
    return
  }
  let payload
  try {
    payload = JSON.parse(frame.data)
  } catch {
    // 非 JSON 的 error 帧同样是错误（message 取原文）。
    if (frame.event === 'error') {
      throw traeFailureToError({ message: frame.data })
    }
    yield { type: 'unknown', value: frame.data }
    return
  }
  const failure = traeFailureOfFrame(frame.event, payload)
  if (failure !== undefined) throw traeFailureToError(failure)
  yield* decodeRawChatChunk(payload, frame.event)
}

/**
 * 非流式辅助：把整段流收完，一次性返回。
 *
 * @returns {Promise<{ content, reasoning, usage, finishReason, toolCalls }>}
 */
export async function completeRawChat(options = {}) {
  const content = []
  const reasoning = []
  const toolCalls = new Map()
  let usage
  let finishReason = 'stop'
  for await (const event of streamRawChat(options)) {
    if (event.type === 'text') content.push(event.text)
    else if (event.type === 'reasoning') reasoning.push(event.text)
    else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'done') finishReason = event.finishReason
    else if (event.type === 'tool-call') {
      const current = toolCalls.get(event.index) ?? { id: event.id ?? '', name: '', arguments: '' }
      if (event.id) current.id = event.id
      if (event.name) current.name = event.name
      if (event.arguments) current.arguments += event.arguments
      toolCalls.set(event.index, current)
    }
  }
  return {
    content: content.join(''),
    reasoning: reasoning.join(''),
    usage,
    finishReason,
    toolCalls: [...toolCalls.values()],
  }
}
