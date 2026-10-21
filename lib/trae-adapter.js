/**
 * TRAE provider：把「已登录的 TRAE 客户端」挂成 DSH 里的一个 pi-ai provider。
 *
 * 新架构（五层同构，2026-10-17 重构）
 * ----------------------------------
 * 本模块不再自己造 adapter，而是走 `lib/connect/trae/` 的新栈：
 *
 *   1. `loadTraeCredentials()`        —— 读 %APPDATA%\...\storage.json 并解密（①凭据层）
 *   2. `loadModelCatalog()`           —— 读同目录 state.vscdb 的模型目录（②目录层）
 *   3. `createTraeShim()`             —— 起真端口的 loopback shim（③shim 层，
 *      协议是 llm_raw_chat，不再是 create_agent_task）
 *   4. 返回 `{ profile, shim, buildModels, ... }`；PiAiAdapter（④）与注册（⑤）
 *      由 `lib/connect/trae/index.js` 的 `activateTrae` 完成——PiAiAdapter 只在
 *      宿主内存在，本函数必须能在宿主外单测。
 *
 * 安全边界（与签到插件同纪律）
 * ---------------------------
 *   - 凭证只读：`storage.json` 打开后只 JSON.parse，绝不回写；secret 只在进程
 *     内存与 loopback 之间流动。
 *   - 不伪造身份：所有请求头都从客户端实际登录态里取（deviceId / region /
 *     userId / accessToken），本插件不编造任何一项。
 *   - 失败即停：拿不到凭证或目录 → ok:false + 可读 reason，绝不注册半残 provider。
 *   - 不发往第三方：请求只打到 TRAE 自己的网关（cn: trae-api-cn.mchost.guru，
 *     ai: coresg-normal.trae.ai），凭证不出本机、不进日志。
 *
 * 兼容说明：`sendAgentTaskFull`（create_agent_task / SOLO 桥协议）继续从
 * 本模块转出口，老调用方不受影响；普通对话不再使用它。
 *
 * @module dsh-agent-checkin/trae-adapter
 */

import { loadTraeCredentials, isExpired } from './trae-credentials.js'
import { loadModelCatalog } from './trae-catalog.js'
import { createTraeShim } from './connect/trae/shim.js'
import { regionOfCredential } from './connect/trae/upstream-raw.js'
import { toPiModel, filterSelectable } from './connect/trae/models.js'
import {
  DEFAULT_AGENT_HOST,
  sendAgentTask,
} from './trae-upstream.js'

/**
 * 装配一个 TRAE provider（新栈：真端口 loopback shim）。
 *
 * @param {object} ctx  cordis Context（只用 ctx.logger，可为空）
 * @param {object} [options]
 * @param {string} [options.storagePath]  显式指定 storage.json（测试用）
 * @param {string} [options.dbPath]       显式指定 state.vscdb（测试用）
 * @param {Function} [options.fetchImpl]  上游 fetch 注入（测试用）
 * @returns {Promise<{ok:boolean, reason?:string, credential?:object,
 *   catalog?:object, profile?:object, shim?:object, buildModels?:Function}>}
 */
export async function createTraeProvider(ctx, options = {}) {
  let credential
  try {
    credential = loadTraeCredentials(options.storagePath)
  } catch (error) {
    return { ok: false, reason: `凭证不可用：${error.message}` }
  }
  if (isExpired(credential)) {
    return { ok: false, reason: '凭证不可用：TRAE 登录态已过期，请在 TRAE 客户端重新登录' }
  }

  let catalog
  try {
    catalog = loadModelCatalog({ credential, dbPath: options.dbPath })
  } catch (error) {
    return { ok: false, reason: `模型目录不可用：${error.message}` }
  }

  const selectable = filterSelectable(catalog.models)
  if (selectable.length === 0) {
    return { ok: false, reason: '模型目录里没有可调用的模型' }
  }

  // profile.models 保持老的简单形状（老消费方只读这些字段）。
  const models = selectable.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow ?? undefined,
    maxTokens: m.maxTokens ?? undefined,
    multimodal: m.multimodal || undefined,
    reasoning: m.reasoning || undefined,
  }))

  const regionKey = regionOfCredential(credential)
  const shim = createTraeShim({
    // 凭据每请求现取：客户端里重新登录后下一个请求就用上新 token。
    resolveCredential: async () => {
      const live = loadTraeCredentials(options.storagePath)
      if (isExpired(live)) throw new Error('TRAE 登录态已过期，请在 TRAE 客户端重新登录')
      return live
    },
    resolveModels: () => filterSelectable(catalog.models),
    region: { id: 'trae', key: regionKey, displayName: 'TRAE（本机客户端）' },
    logger: ctx?.logger?.('dsh-agent-checkin/trae'),
    fetchImpl: options.fetchImpl,
  })
  try {
    await shim.ready
  } catch (error) {
    return { ok: false, reason: `loopback shim 启动失败：${error.message}` }
  }

  const profile = {
    id: 'trae',
    displayName: 'TRAE（本机客户端）',
    api: 'openai-completions',
    baseURL: `${shim.baseUrl()}/v1`,
    apiKeyEnv: undefined,
    models,
  }

  /** 供 createShimAdapter 使用的模型描述构造器（④层入宿主后使用）。 */
  const buildModels = (baseUrlV1) => filterSelectable(catalog.models)
    .map((m) => toPiModel(m, baseUrlV1, 'trae'))

  return { ok: true, credential, catalog, profile, shim, buildModels }
}

/**
 * 发一轮 agent task 并把整个 body 读完（SOLO 桥协议，仅保留作兼容）。
 *
 * 与 `trae-upstream.sendAgentTask` 的分工：upstream 那条走真流式；这条一次
 * 性读完，只给「想直接拿到整段 SSE 文本」的调用方（探针、测试）。普通对话
 * 不走这条路——新栈在 `lib/connect/trae/`（llm_raw_chat）。
 *
 * @returns {Promise<{status:number, body:string, headers:Headers}>}
 */
export async function sendAgentTaskFull({
  baseURL = DEFAULT_AGENT_HOST,
  accessToken,
  identity = {},
  body,
  signal,
  timeoutMs = 120_000,
}) {
  const response = await sendAgentTask({
    baseURL,
    accessToken,
    identity,
    body,
    signal,
    timeoutMs,
  })
  const text = await response.text()
  return { status: response.status, body: text, headers: response.headers }
}
