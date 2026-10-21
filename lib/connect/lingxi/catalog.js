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
 * 解析 API 返回的模型列表，转换为内部格式。
 *
 * @param {Array} apiModels
 * @returns {Array<{ id, name, upstreamId, contextWindow, maxOutput, multimodal, multiplier }>}
 */
function parseApiModels(apiModels) {
  if (!Array.isArray(apiModels) || apiModels.length === 0) {
    return [...FALLBACK_MODELS]
  }

  const models = []
  for (const model of apiModels) {
    if (typeof model !== 'object' || model === null || !model.key) continue

    models.push({
      id: model.key,
      name: model.name || model.key,
      upstreamId: model.key,
      contextWindow: typeof model.max_context_tokens === 'number' ? model.max_context_tokens : 1048576,
      maxOutput: typeof model.max_new_tokens === 'number' ? model.max_new_tokens : 131072,
      multimodal: model.support_multimodal === true,
      multiplier: model.multiplier || '',
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
