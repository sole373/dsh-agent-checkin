/**
 * TRAE SSE 解析 + OpenAI 兼容流式适配（trae-shim.js）。
 *
 * 真实协议（2026-10-18 本机实测，逐帧核对）
 * ----------------------------------------
 * 上游 `/api/cue_agent/v3/create_agent_task` 的响应是 SSE，**每个事件占两行**：
 *
 *     event:task_created
 *     data:{"task_id":"...","agent_run_id":"..."}
 *     <空行>
 *
 * 事件名在 `event:` 行里，**不在 JSON 里**。这个区别是实测出来的：
 * 头一版 shim 假设事件名在 JSON 的 `event` 字段、名也叫
 * `chat_message_chunk`/`chat_finish`/`chat_error`——这三个名字在真实流里
 * 一个都不出现，那份实现从未跑通过。
 *
 * StreamEventType（cueMain.js @3073663 附近，与客户端源码逐字一致）：
 *   task_created / thought / tool_call / chat_done / turn_completion /
 *   error / token_usage / progress_notice
 * 另有两个枚举里没有但真实存在的事件：
 *   history          —— 完整 raw_messages，不是增量，不能当 content 吐
 *   task_completion  —— 收尾帧 `{task_id, agent_run_id}`
 *
 * 各事件 payload 的真实形状（实测摘录）：
 *   task_created    {task_id, agent_run_id}
 *   thought         {reasoning_content:'', thought:'增量字符串'}
 *                   ← 增量文本在 `thought` 字段，逐字符推
 *   tool_call       {tool_name, arguments:'{...JSON...}', toolcall_id,
 *                    require_local_execution:true}
 *   token_usage     {prompt_tokens, completion_tokens, total_tokens,
 *                    cache_creation_input_tokens, cache_read_input_tokens,
 *                    reasoning_tokens}  ← 多次出现，数字累积增长
 *   history         {history_id, conversation_id, session_id, task_id,
 *                    agent_run_id, messages:'{"raw_messages":[...]}',
 *                    token_usage, source:'user_input'|'llm_default', ...}
 *                   ← messages 是**字符串化的 JSON**，而且要再套一层
 *                     JSON.parse 才拿到 raw_messages
 *   turn_completion {agent_type, agent_run_id, parent_agent_run_id,
 *                    recv_timestamp, send_first_token_timestamp,
 *                    send_last_token_timestamp}
 *   task_completion {task_id, agent_run_id}
 *   error           {code, message}（未实测到，按客户端源码与错误码族处理）
 *
 * 为什么要把 thought 当正文
 * ------------------------
 * `cue_builder` agent 的可见输出走 `thought` 增量；`history` 里的 assistant
 * 消息是收完后的一次性全量（且带 `<func_tool>` 包装），不能当流式正文。
 * 如实说明：`reasoning_content` 字段实测始终是空串，所以推理内容与正文
 * 在本协议里是同一个 `thought` 字段，不做区分。
 *
 * @module dsh-agent-checkin/trae-shim
 */

import { ERROR_KIND, TraeUpstreamError } from './trae-upstream.js'

/** 一行 `data:` 之后要剥掉的前缀（含可选的一个空格）。 */
const DATA_PREFIX = /^data:\s?/

/** `event:` 行前缀。 */
const EVENT_PREFIX = /^event:\s?/

/**
 * 把一个解析好的事件（`{event, data}`）转成 OpenAI chunk。
 *
 * 只映射我们真正能确定的字段：
 *   - `delta.content` ← `thought` 的 `thought` 增量串
 *   - `finish_reason` ← `turn_completion`/`task_completion` 给 `stop`
 *   - `usage`         ← `token_usage`（缺失就省略，不编）
 *
 * 不映射的：`tool_call`（本插件不发起本地工具执行，客户端发的这些调用
 * 落在 `path/to/trigger/file` 这类占位路径上，没有执行价值，透出去只会
 * 让上层以为有工具结果）、`history`（全量快照，转发会造成重复内容）。
 *
 * @param {{event?:string, data?:object}} event
 * @param {{usage?:object}} [state] 调用方可传入以累积 usage
 * @returns {object|null} chunk，或 null 表示这个事件不产生输出
 */
export function traeEventToChunk(event, state = {}) {
  if (!event || typeof event !== 'object') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  switch (event.event) {
    case 'thought': {
      const piece = typeof data.thought === 'string' ? data.thought : ''
      if (!piece) return null
      return { delta: { content: piece } }
    }
    case 'token_usage': {
      const usage = extractUsage(data)
      if (usage) state.usage = usage
      return null
    }
    case 'turn_completion':
    case 'task_completion':
      return { finish_reason: 'stop', usage: state.usage }
    case 'error':
      throw new TraeUpstreamError(`上游报错：${data.message || JSON.stringify(data)}`, {
        kind: classifyTraeErrorCode(data.code),
        body: JSON.stringify(data),
      })
    default:
      // task_created / history / tool_call / progress_notice / 未知事件
      return null
  }
}

/** token_usage 的字段名固定，但逐字读出来，没有就 undefined。 */
function extractUsage(data) {
  if (!data) return undefined
  const usage = {
    prompt_tokens: num(data.prompt_tokens ?? data.promptTokens ?? data.input_tokens),
    completion_tokens: num(data.completion_tokens ?? data.completionTokens ?? data.output_tokens),
    total_tokens: num(data.total_tokens ?? data.totalTokens),
  }
  for (const k of Object.keys(usage)) if (!Number.isFinite(usage[k])) delete usage[k]
  return Object.keys(usage).length ? usage : undefined
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 事件里的 code 大多是数字，先按数字判，再退化为字符串匹配。 */
function classifyTraeErrorCode(code) {
  if (code == null) return ERROR_KIND.client
  const n = typeof code === 'string' ? Number(code) : code
  if (Number.isFinite(n)) {
    if (n === 401 || n === 403) return ERROR_KIND.auth
    if (n === 402) return ERROR_KIND.credit
    if (n === 429 || n === 4011) return ERROR_KIND.rate
    if (n === 404) return ERROR_KIND.not_found
    if (n >= 500) return ERROR_KIND.server
    return ERROR_KIND.client
  }
  const s = String(code).toLowerCase()
  if (/auth|token|permission/.test(s)) return ERROR_KIND.auth
  if (/rate|limit/.test(s)) return ERROR_KIND.rate
  return ERROR_KIND.client
}

/**
 * 把一段 SSE 文本切成「完整事件数组 + 剩余不完整尾部」。
 *
 * TRAE 的帧是 `event:<name>\ndata:<json>\n\n`：两行加一个空行。
 * 所以每帧先取 `event:` 行拿名字，剩下的 `data:` 行按 SSE 规范用 `\n`
 * join 后 JSON.parse。实测踩过的坑：只按 `data:` 正则扫会让 `event:` 行
 * 破坏锚定，导致一个事件都解不出来——必须先分行、再分类。
 *
 * @returns {{events: Array<{event:string, data:object}>, rest: string}}
 */
export function parseSseText(text) {
  const events = []
  const frames = String(text).split(/\r?\n\r?\n/)
  const rest = frames.pop() ?? ''
  for (const frame of frames) {
    const lines = frame.split('\n')
    let name
    const dataLines = []
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (line === '') continue
      if (EVENT_PREFIX.test(line)) {
        name = line.replace(EVENT_PREFIX, '')
        continue
      }
      if (DATA_PREFIX.test(line)) {
        const value = line.replace(DATA_PREFIX, '')
        if (value !== '[DONE]') dataLines.push(value)
      }
      // 既不是 event: 也不是 data: 的行（注释/心跳）直接忽略。
    }
    if (!dataLines.length) continue
    const joined = dataLines.join('\n')
    let data
    try {
      data = JSON.parse(joined)
    } catch {
      // 心跳/半帧，跳过；不当作错误，否则 SSE 一有噪声就崩。
      continue
    }
    events.push({ event: name ?? data?.event ?? '', data })
  }
  return { events, rest }
}

/**
 * 流式转发：把上游 SSE 逐事件转成 OpenAI chunk，交给 onChunk 回调。
 *
 * @param {AsyncIterable<string>} upstream 上游 SSE 文本流（已解码）
 * @param {(chunk:object)=>void} onChunk
 * @returns {Promise<{finish_reason:string|null, usage?:object}>}
 */
export async function streamTraeToOpenAI(upstream, onChunk) {
  let buffer = ''
  let finishReason = null
  const state = {}

  const drain = (text) => {
    const { events, rest } = parseSseText(text)
    buffer = rest
    for (const event of events) {
      const chunk = traeEventToChunk(event, state)
      if (!chunk) continue
      if (chunk.finish_reason) finishReason = chunk.finish_reason
      onChunk(chunk)
    }
  }

  for await (const piece of upstream) {
    buffer += piece
    drain(buffer)
  }
  // 尾部可能还压着一个不带空行的事件（对端没发结束空行就关流）。
  if (buffer.trim()) drain(`${buffer}\n\n`)

  // 上游没发 turn_completion 就断流时，如实给一个 stop，别让上层干等。
  if (!finishReason) {
    finishReason = 'stop'
    onChunk({ finish_reason: 'stop', usage: state.usage })
  }
  return { finish_reason: finishReason, usage: state.usage }
}
