/**
 * DuMate 模型目录（五层架构的第②层）。
 *
 * DuMate 的模型配置在：
 *   `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<uid>\config\opencode\opencode.json`
 *
 * 示例内容：
 * ```json
 * {
 *   "model": "QianfanPersonalQuota/glm-5",
 *   "provider": {
 *     "QianfanPersonalQuota": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "options": {
 *         "baseURL": "http://127.0.0.1:{{desk-main-port}}/api/qianfanproxy/v1",
 *         "apiKey": "nokey"
 *       },
 *       "models": {
 *         "glm-5": {
 *           "name": "Qianfan GLM-5",
 *           "id": "model-text",
 *           "limit": { "context": 192000, "output": 128000 }
 *         },
 *         "model-artifact-validate": { ... }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * 本模块解析该文件，提取模型清单；若文件不存在或格式错误，返回静态兜底种子。
 *
 * @module dsh-agent-checkin/connect/dumate/catalog
 */

import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dumateUserDataDir } from './credentials.js'

/** 目录刷新周期（30 分钟，与 trae/workbuddy 一致）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** 静态兜底模型清单（当 opencode.json 不可读时使用）。 */
const FALLBACK_MODELS = [
  {
    id: 'glm-5',
    name: 'Qianfan GLM-5',
    upstreamId: 'model-text',
    contextWindow: 192000,
    maxOutput: 128000,
    multimodal: false,
  },
]

/**
 * 查找 opencode.json 的路径。
 *
 * @returns {string | undefined}
 */
function findOpencodeJsonPath() {
  const base = dumateUserDataDir()
  const xdgBase = join(base, 'qianfan_desk_xdg')
  if (!existsSync(xdgBase)) return undefined

  try {
    const entries = readdirSync(xdgBase, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(xdgBase, entry.name, 'config', 'opencode', 'opencode.json')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 读取失败，跳过
  }

  return undefined
}

/**
 * 解析 opencode.json，提取模型清单。
 *
 * @returns {{ models: Array<{ id, name, upstreamId, contextWindow, maxOutput, multimodal }> }}
 */
export function loadDumateCatalog() {
  const configPath = findOpencodeJsonPath()
  if (!configPath || !existsSync(configPath)) {
    return { models: [...FALLBACK_MODELS], source: 'fallback' }
  }

  try {
    const content = readFileSync(configPath, 'utf8')
    const config = JSON.parse(content)

    const provider = config.provider?.QianfanPersonalQuota
    if (!provider || !provider.models) {
      return { models: [...FALLBACK_MODELS], source: 'fallback' }
    }

    const models = []
    for (const [modelKey, modelDef] of Object.entries(provider.models)) {
      if (typeof modelDef !== 'object' || modelDef === null) continue

      const limit = modelDef.limit || {}
      models.push({
        id: modelKey,
        name: modelDef.name || modelKey,
        upstreamId: modelDef.id || modelKey,
        contextWindow: typeof limit.context === 'number' ? limit.context : undefined,
        maxOutput: typeof limit.output === 'number' ? limit.output : undefined,
        multimodal: modelDef.multimodal === true || false,
      })
    }

    return { models: models.length > 0 ? models : FALLBACK_MODELS, source: 'opencode.json' }
  } catch {
    return { models: [...FALLBACK_MODELS], source: 'fallback' }
  }
}

/**
 * 创建可刷新的目录对象（带缓存和后台刷新能力）。
 *
 * @param {object} options
 * @param {object} [options.logger]
 * @returns {{ current: () => Array, refresh: () => Promise<boolean> }}
 */
export function createDumateCatalog(options = {}) {
  const logger = options.logger
  let cache = loadDumateCatalog()

  return {
    current: () => cache.models,
    refresh: async () => {
      try {
        const fresh = loadDumateCatalog()
        const changed = JSON.stringify(fresh.models) !== JSON.stringify(cache.models)
        if (changed) {
          cache = fresh
          logger?.info?.('dsh-agent-checkin: dumate 模型目录已更新（来源：%s）', fresh.source)
        }
        return changed
      } catch (error) {
        logger?.warn?.('dsh-agent-checkin: dumate 模型目录刷新失败', error)
        return false
      }
    },
  }
}
