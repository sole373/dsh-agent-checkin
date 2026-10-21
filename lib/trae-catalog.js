/**
 * TRAE 模型目录：从客户端自带的 state.vscdb 里读出「这个账号能用哪些模型」。
 *
 * 为什么读这个而不是硬编码
 * ------------------------
 * 模型清单随 TRAE 客户端版本和账号订阅变化（本机实测 10 个 agent 分类、
 * 去重后 27 个模型），硬编码成一张表的插件每次 TRAE 更新都要发版。
 * 客户端把它存在 SQLite 里，读一遍就是实时答案。
 *
 * 存储形态（2026-10-17 本机实测确认）
 * ----------------------------------
 *   文件：%APPDATA%\<TRAE CN|TRAE SOLO CN>\User\globalStorage\state.vscdb
 *   表：  ItemTable(key TEXT, value BLOB)
 *   key： `${userId}_AI.agent.model.model_list_map`   ← 冒号版，140~283 KB
 *         `${userId}:AI.agent.model.model_list_map`  ← 下划线版，另一份快照
 *   value：JSON，顶层是 agent 分类名 → 模型数组
 *
 * 两种分隔符是客户端自己演进的产物，不是我们该选的，所以两个都读、取内容
 * 更多的那个（冒号版通常更新更全）。
 *
 * 只读打开（`readOnly: true`）：客户端正在运行时该文件可能被锁，只读连接
 * 至少不会加剧写冲突；连不上就如实抛错，不猜目录。
 *
 * @module dsh-agent-checkin/trae-catalog
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** state.vscdb 相对 storage.json 的文件名。 */
const STATE_DB_FILENAME = 'state.vscdb'

/** ItemTable 里存模型目录的键模板：`${userId}_AI.agent.model.model_list_map`。 */
const MODEL_MAP_SUFFIX = 'AI.agent.model.model_list_map'

/**
 * 客户端自己的安装目录名。
 *
 * 与 `trae-credentials.js` 的 `storageJsonCandidates()` 保持同一份顺序：
 * SOLO 版在前（本机就是 SOLO CN，两个 key 都在），正式版在后。
 */
function roamingRoot() {
  return process.env.APPDATA
    || (process.env.HOME && `${process.env.HOME}/AppData/Roaming`)
    || ''
}

/** 所有可能的 state.vscdb 路径，按优先级排列。 */
export function stateDbCandidates() {
  const root = roamingRoot()
  const names = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae']
  return names.map((n) => join(root, n, 'User', 'globalStorage', STATE_DB_FILENAME))
}

/** 由 storage.json 路径推出同目录的 state.vscdb（凭证找到了就用它的邻居）。 */
export function stateDbFromStorage(storagePath) {
  return storagePath.replace(/[^\\/]+$/, STATE_DB_FILENAME)
}

/** 第一个存在的 state.vscdb；都不存在返回 null。 */
export function firstStateDb({ credential } = {}) {
  if (credential?.source) {
    const neighbour = stateDbFromStorage(credential.source)
    if (existsSync(neighbour)) return neighbour
  }
  return stateDbCandidates().find(existsSync) ?? null
}

/**
 * 读出一个模型数组的规范化视图。
 *
 * 只挑 pi-ai 需要的字段，其余 40 多个标量原样不碰——它们描述的是客户端内部
 * 行为（widget、TODO 抽取阈值之类），透出去只会造成「这些字段有语义」的误解。
 *
 * 取名 `config_name` 而不是 `name`：`name` 在目录里有重复（如
 * `DeepSeek-V4-Pro` 出现在 solo_agent 与 solo_coder 两条），`config_name`
 * 才是请求体里真正要发的那个值。
 */
function normalizeEntry(raw) {
  const contextWindow = raw.context_window_size?.default
    ?? raw.features?.context_windows?.data?.max_context
    ?? null
  const maxTokens = raw.max_tokens ?? null
  // 倍率：不在顶层，藏在 features 里（2026-10-18 本机实测 34 个模型 32 个有值，
  // 区间 0.06~1.83，kimi-k3 1.83 / glm-5.3 0.78 / qwen3.8-flash 0.08）——
  //   features.consumption_rate.data.rate                        基础消耗倍率
  //   features.activity_discount.data.current.consumption_rate   活动期间的当前生效价
  // 活动字段存在时优先（它才是「现在真实扣多少」；本机两者当前恒等，
  // discount=100 / discount_type='none'）。没有就整字段省略，不编 1。
  const features = raw.features ?? {}
  const activityRate = features.activity_discount?.data?.current?.consumption_rate
  const baseRate = features.consumption_rate?.data?.rate
  const multiplier = [activityRate, baseRate]
    .find((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) ?? null
  return {
    id: raw.config_name ?? raw.name,
    name: raw.display_name ?? raw.name ?? raw.config_name,
    contextWindow: Number.isFinite(contextWindow) ? Number(contextWindow) : null,
    maxTokens: Number.isFinite(maxTokens) ? Number(maxTokens) : null,
    multimodal: raw.multimodal === true,
    reasoning: raw.model_type === 'reasoning_model',
    thinkingEnabled: raw.thinking_enable === 1,
    provider: raw.provider ?? null,
    selectable: raw.selectable !== false,
    status: raw.status !== false,
    remoteService: raw.use_remote_service !== false,
    feeModelLevel: raw.fee_model_level ?? null,
    ...(multiplier !== null ? { multiplier } : {}),
  }
}

/**
 * 读模型目录。
 *
 * 同一模型名会出现在多个 agent 分类里（`glm-5.3` 在 solo_agent /
 * solo_agent_lite / solo_agent_remote / solo_work_lite / solo_work_remote
 * 各出现一次，标量还不完全一致）。这里按 `config_name` 去重，保留
 * **标量最完整的那一条**（contextWindow/maxTokens 非空的优先，其次 multimodal），
 * 并记录它出现在哪些分类里——调用方需要知道"这个模型在 solo_coder 里能用"
 * 这类信息时不用再翻原始 JSON。
 *
 * @param {{ credential?: object, dbPath?: string }} [options]
 * @returns {{ source, categories: Record<string, string[]>, models: object[], duplicates: number }}
 */
export function loadModelCatalog(options = {}) {
  const dbPath = options.dbPath || firstStateDb(options)
  if (!dbPath) {
    throw new Error(
      '未找到 TRAE 的 state.vscdb（模型目录）。请先安装并登录 TRAE 客户端。',
    )
  }

  let raw
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    raw = readModelMap(db)
  } catch (error) {
    throw new Error(`读取 ${dbPath} 失败：${error.message}`)
  } finally {
    db?.close?.()
  }

  const categories = {}
  const byId = new Map()
  let duplicates = 0

  for (const [category, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    categories[category] = []
    for (const entry of list) {
      const model = normalizeEntry(entry)
      if (!model.id) continue
      categories[category].push(model.id)

      const prev = byId.get(model.id)
      if (!prev) {
        byId.set(model.id, { ...model, appearedIn: [category] })
        continue
      }
      duplicates += 1
      prev.appearedIn.push(category)
      // 取标量更全的那份：contextWindow 非空优先，其次 maxTokens，其次多模态。
      if (score(model) > score(prev)) {
        Object.assign(prev, model, { appearedIn: prev.appearedIn })
      }
    }
  }

  return {
    source: dbPath,
    categories,
    models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    duplicates,
  }
}

/** 标量完整度打分，用于同 id 多条目去重时挑一份。 */
function score(m) {
  return (m.contextWindow ? 2 : 0)
    + (m.maxTokens ? 1 : 0)
    + (m.multimodal ? 1 : 0)
    + (m.selectable ? 1 : 0)
}

/**
 * 从 ItemTable 里把模型目录 JSON 取出来。
 *
 * 两种分隔符都试：UserId 之后可能是下划线也可能是冒号。取 value 更长的那个
 * （本机冒号版 282 KB / 下划线版 140 KB，前者分更多、标更全）。
 */
function readModelMap(db) {
  const rows = db.prepare(
    "select key, value from ItemTable where key like ?",
  ).all(`%${MODEL_MAP_SUFFIX}`)

  let best = null
  for (const row of rows) {
    const text = typeof row.value === 'string'
      ? row.value
      : Buffer.from(row.value).toString('utf8')
    // 客户端偶尔在 value 里带一个 BOM 或前后噪声，按首尾花括号兜一次。
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    const slice = start > 0 && end > start ? text.slice(start, end + 1) : text
    const parsed = JSON.parse(slice)
    if (!best || slice.length > best.size) best = { size: slice.length, parsed }
  }
  if (!best) {
    throw new Error('ItemTable 里没有模型目录键（*_AI.agent.model.model_list_map）')
  }
  return best.parsed
}

/**
 * 供 `checkin-models` 命令展示的一行摘要。
 *
 * 关于「目录里有 ≠ 一定能调」这条口径的更正（2026-10-18 本机实测）：
 * 早期结论「34/34 全部 HTTP 200」是**错的**——那批探测打的是
 * `/api/ide/v2/llm_raw_chat`，该端点对任何合法 JSON 一律回 HTTP 400 空 body，
 * 200 只出现在 GET / 非 JSON 载荷上，且回的是 `{"code":4001}` 错误帧。
 *
 * 改用实测可用的 `/api/agent/v3/llm_utils_chat` + 目录 function 后，
 * 逐模型实测的结论是**按 function 归属分层**：
 *   - 五个 SOLO function 全通的：`DeepSeek-V4-Flash-Official` 等 Official 后缀；
 *   - 仅 `solo_work_remote`：`glm-5.3`、`deepseek-v4.1-flash`、`glm-5.2`…；
 *   - 仅 `solo_coder`：`DeepSeek-V4-Flash`、`DeepSeek-V4-Pro`、`glm-5`、`qwen-3.5`…；
 *   - 十个 function 全回 4001（目录里有、但调不动）：`deepseek//deepseek-v4-*`
 *     这类自定义 base_url 变体。
 * 所以「不可用」有两种完全不同的成因：function 用错（本地可修）与账号/
 * 权益不覆盖（上游决定）。插件按目录 `appearedIn` 选 function（见
 * `functionOfCatalogEntry`），剩下的如实让上游报错，不静默隐藏。
 */
export function formatCatalogLine(model) {
  const ctx = model.contextWindow ? `${model.contextWindow}` : '—'
  const max = model.maxTokens ? `${model.maxTokens}` : '—'
  const rate = typeof model.multiplier === 'number' ? `  x${model.multiplier}` : ''
  return `${model.id}  ctx=${ctx}  max_tokens=${max}  `
    + `${model.multimodal ? 'vision' : 'text'}  ${model.reasoning ? 'reasoning' : 'chat'}${rate}`
}
