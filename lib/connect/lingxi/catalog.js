/**
 * Lingxi（WPS 灵犀）模型目录（五层架构的第②层）。
 *
 * Lingxi 的模型列表由云端 API 下发：
 *   `GET https://lingxi.wps.cn/api/aioffice/v1/sessions/plans`
 *
 * 返回格式（实测）：
 * ```json
 * {
 *   "result": "ok",
 *   "data": {
 *     "plans": [
 *       { "key": "plan_pro", "name": "Pro 模式", ... },
 *       { "key": "plan_max", "name": "Max 模式", ... }
 *     ],
 *     "models": [
 *       {
 *         "key": "deepseek-v4-flash-0731",
 *         "name": "DeepSeek V4 Flash",
 *         "multiplier": "0.09x",
 *         "support_multimodal": false,
 *         "max_context_tokens": 1048576,
 *         "max_new_tokens": 393216
 *       },
 *       ...
 *     ]
 *   }
 * }
 * ```
 *
 * 本模块通过 HTTP 请求获取模型列表；若失败则返回静态兜底种子。
 *
 * @module dsh-agent-checkin/connect/lingxi/catalog
 */

import { readLingxiCookie } from './credentials.js'

/** 目录刷新周期（30 分钟）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** 灵犀 API 基础 URL。 */
const LINGXI_API_BASE = 'https://lingxi.wps.cn'

/** 静态兜底模型清单（当 API 不可达时使用）。 */
const FALLBACK_MODELS = [
  {
    id: 'deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash',
    upstreamId: 'deepseek-v4-flash-0731',
    contextWindow: 1048576,
    maxOutput: 393216,
    multimodal: false,
  },
  {
    id: 'qwen3.8_flash',
    name: 'Qwen3.8-Flash',
    upstreamId: 'qwen3.8_flash',
    contextWindow: 1048576,
    maxOutput: 131072,
    multimodal: true,
  },
]

/** User-Agent 头。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 从 Cookie 文件读取（与 `./credentials.js` 同一套候选路径）。
 *
 * 不再只认包内 `engine/lx_cookie.txt`：该文件被 `package.json` 的 `files`
 * 白名单排除（`!engine/*_cookie.txt`），重装后会消失。详见 credentials.js。
 *
 * @returns {string | undefined}
 */
function readCookieFile() {
  return readLingxiCookie()
}

/**
 * 从云端 API 获取模型列表。
 *
 * @param {string} cookie - Cookie 字符串
 * @returns {Promise<Array>}
 */
async function fetchModelsFromApi(cookie) {
  const url = `${LINGXI_API_BASE}/api/aioffice/v1/sessions/plans`
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${LINGXI_API_BASE}/`,
    'Cookie': cookie,
  }

  try {
    const response = await fetch(url, { method: 'GET', headers })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const payload = await response.json()
    if (payload.result !== 'ok' || !payload.data?.models) {
      throw new Error(`API returned non-ok result: ${payload.result}`)
    }

    return payload.data.models
  } catch (error) {
    throw new Error(`Failed to fetch models: ${error.message}`)
  }
}

/**
 * 把上游的倍率字符串解析成数字。
 *
 * 灵犀是**唯一**以字符串下发倍率的平台（实测 2026-10-29，11 个模型全量）：
 *
 *   `"～0.12x"` 全角波浪号 U+FF5E（4 条）
 *   `"~0.11x"`  半角波浪号 U+007E（3 条）
 *   `"0.40x"`   纯数字（4 条）
 *   `"1.60x"`   ≥1 的整数倍率
 *
 * 三种形态必须同时吃下：只认半角会漏掉 4 条，只认纯数字会漏掉 7 条。
 * 上游的波浪号表示「约」，保守版在这里丢掉该语义（显示为精确 `x0.12`），
 * 属于已知取舍——要显示「约」需改共用渲染层，不在本次范围。
 *
 * 解析失败一律回 `undefined`（不猜、不编 1），与 `trae-catalog.js`
 * 的 `normalizeEntry`「没有就整字段省略」同一纪律。
 *
 * @param {unknown} raw 上游 `multiplier` 字段（字符串或数字）
 * @returns {number | undefined}
 */
export function parseLingxiMultiplier(raw) {
  // 上游若直接给数字，校验后原样用（未来可能改格式，不预设）。
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : undefined
  }
  if (typeof raw !== 'string') return undefined
  // 只抓第一个数值（含小数）：波浪号、`x` 后缀、全角字符都不参与匹配。
  const match = /[0-9]+(?:\.[0-9]+)?/.exec(raw)
  if (match === null) return undefined
  const parsed = Number(match[0])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * 解析 API 返回的模型列表，转换为内部格式。
 *
 * `multiplier` 存**解析后的数字**（不是上游原串）：下游
 * `selection.js:441` 与 `models-page.js:101` 两道守卫只收真数字，
 * 原串送进去会被静默丢弃——这正是「灵犀有倍率却全不显示」的成因。
 *
 * @param {Array} apiModels
 * @returns {Array<{ id, name, upstreamId, contextWindow, maxOutput, multimodal, multiplier? }>}
 */
export function parseApiModels(apiModels) {
  if (!Array.isArray(apiModels) || apiModels.length === 0) {
    return [...FALLBACK_MODELS]
  }

  const models = []
  for (const model of apiModels) {
    if (typeof model !== 'object' || model === null || !model.key) continue

    const multiplier = parseLingxiMultiplier(model.multiplier)
    models.push({
      id: model.key,
      name: model.name || model.key,
      upstreamId: model.key,
      contextWindow: typeof model.max_context_tokens === 'number' ? model.max_context_tokens : 1048576,
      maxOutput: typeof model.max_new_tokens === 'number' ? model.max_new_tokens : 131072,
      multimodal: model.support_multimodal === true,
      // 解析成数字；解析不出来就整字段省略（不编 1、不留空串）。
      ...(multiplier !== undefined ? { multiplier } : {}),
    })
  }

  return models.length > 0 ? models : FALLBACK_MODELS
}

/**
 * 加载 Lingxi 模型目录。
 *
 * @param {string} [cookie] - Cookie 字符串（可选，不提供则从文件读取）
 * @returns {Promise<{ models: Array, source: string }>}
 */
export async function loadLingxiCatalog(cookie) {
  const actualCookie = cookie || await readCookieFile()
  if (!actualCookie || typeof actualCookie !== 'string') {
    return { models: [...FALLBACK_MODELS], source: 'fallback' }
  }

  try {
    const apiModels = await fetchModelsFromApi(actualCookie)
    const models = parseApiModels(apiModels)
    return { models, source: 'api' }
  } catch (error) {
    return { models: [...FALLBACK_MODELS], source: 'fallback' }
  }
}

/**
 * 创建可刷新的目录对象（带缓存和后台刷新能力）。
 *
 * @param {object} options
 * @param {string} [options.cookie] - Cookie 字符串
 * @param {object} [options.logger]
 * @returns {{ current: () => Array, refresh: () => Promise<boolean> }}
 */
export function createLingxiCatalog(options = {}) {
  const logger = options.logger
  const cookie = options.cookie
  let cache = { models: [...FALLBACK_MODELS], source: 'fallback' }

  // 初始化时尝试加载
  if (cookie) {
    loadLingxiCatalog(cookie).then((result) => {
      cache = result
    }).catch(() => {
      // 静默失败，使用兜底
    })
  }

  return {
    current: () => cache.models,
    refresh: async () => {
      try {
        const fresh = await loadLingxiCatalog(cookie)
        const changed = JSON.stringify(fresh.models) !== JSON.stringify(cache.models)
        if (changed) {
          cache = fresh
          logger?.info?.('dsh-agent-checkin: lingxi 模型目录已更新（来源：%s）', fresh.source)
        }
        return changed
      } catch (error) {
        logger?.warn?.('dsh-agent-checkin: lingxi 模型目录刷新失败', error)
        return false
      }
    },
  }
}
