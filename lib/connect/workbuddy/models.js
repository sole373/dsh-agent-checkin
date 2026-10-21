/**
 * WorkBuddy 模型目录的纯函数层：目录规范化（上游文档 → WorkBuddyModelInfo）、
 * `toPiModel`（WorkBuddyModelInfo → pi-ai 模型描述符）与 enabled/filter 纯函数。
 *
 * 移植自 dsh-connect-workbuddy@4.6.5（MIT，Copyright (c) 2026 LaoDing）：
 *   - `toPiModel` / `workBuddyModelInput` / `workBuddyDisplayName` /
 *     `workBuddyThinkingLevelMap` 逐字对齐其 adapter.ts（lib/index.js:161-212），
 *     模型 id 形状与字段映射必须与老插件完全一致，否则用户的
 *     `agent-default-model`（如 `workbuddy / deepseek-v4.1-flash`）引用断裂；
 *   - `parseUpstreamModel` / `parseReasoning` / `parseCreditMultiplier` /
 *     `selectCliModels` 逐字对齐其 upstream.ts（host-heartbeat:1556-1676）；
 *   - `deriveCatalog` / `applyContextBudgets` / `withImageSelection` /
 *     `withEffectiveOff` / `imageDefaultFor` / `offDefaultFor` /
 *     `defaultOffModelIds` 逐字对齐其 catalog.ts / native-modality.ts /
 *     off-thinking.ts / index.ts。
 *
 * @module dsh-agent-checkin/connect/workbuddy/models
 */

/** pi-ai 侧声明零成本：订阅配额报不出逐 token 价格。 */
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** DSH 推理档位词表（老插件 adapter.ts 原样）。 */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** pi-ai input modalities: images only when WorkBuddy advertises them. */
export function workBuddyModelInput(info) {
  return info.multimodal === true ? ['text', 'image'] : ['text']
}

/**
 * DSH-facing display name: the model name plus the upstream credit multiplier,
 * spelled the way WorkBuddy's own selector does (`GLM-5.3 · x0.79`).
 * A model without a parsed multiplier keeps its bare name; a zero multiplier
 * shows `x0.00`, matching WorkBuddy's rendering of free models.
 */
export function workBuddyDisplayName(info) {
  return info.creditMultiplier === undefined ? info.name : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
}

/** Map only levels advertised by WorkBuddy; undeclared DSH levels stay unavailable. */
export function workBuddyThinkingLevelMap(info) {
  const supported = info.reasoning?.supportedEfforts?.filter((effort) => THINKING_LEVELS.includes(effort))
  if (supported === undefined || supported.length === 0) return undefined
  const map = Object.fromEntries(THINKING_LEVELS.map((level) => [level, supported.includes(level) ? level : null]))
  if (info.reasoning?.canDisableThinking !== true) map.off = null
  return map
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * **逐字对齐老插件 `toPiModel`（lib/index.js:196-212）**：id 原样透传
 * （`deepseek-v4.1-flash`），不再加任何前缀或改写。
 */
export function toPiModel(info, baseUrl, providerId) {
  const thinkingLevelMap = workBuddyThinkingLevelMap(info)
  return {
    id: info.id,
    name: workBuddyDisplayName(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: workBuddyModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
  }
}

// ---------------------------------------------------------------------------
// 目录规范化：上游 `/v3/config` / `/v2/enterprises/personal/models` 文档解析
// ---------------------------------------------------------------------------

/**
 * Parse the upstream's `credits` string into a multiplier.
 * Observed forms: `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`, and absent.
 * Unparsable values yield undefined rather than a guess.
 */
export function parseCreditMultiplier(value) {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The effort vocabulary the upstream's plural-form payloads declare across both
 * gateways. Both gateways also accept every level in it on singular-form models,
 * so the singular `effort` value is a DEFAULT, never the model's only level.
 */
export const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** The singular spelling of reasoning metadata: `effort` and none of the plural-form fields. */
export function isSingularEffortForm(raw) {
  return typeof raw['effort'] === 'string' && !Array.isArray(raw['supportedEfforts']) && typeof raw['defaultEffort'] !== 'string' && typeof raw['canDisableThinking'] !== 'boolean'
}

/** Fold a singular-form `effort` into the plural shape the rest of the plugin understands. */
export function singularEffortLadder(raw) {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/** Parse the upstream's `reasoning` object; unknown shapes degrade to undefined. */
export function parseReasoning(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts']) ? raw['supportedEfforts'].filter((entry) => typeof entry === 'string') : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? raw['canDisableThinking'] : isSingularEffortForm(raw) ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) return undefined
  return {
    ...(supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(canDisableThinking === undefined ? {} : { canDisableThinking }),
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  const supportsImages = raw['disabledMultimodal'] === true ? false : typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(descriptionZh === undefined ? {} : { descriptionZh }),
    ...(descriptionEn === undefined ? {} : { descriptionEn }),
    ...(supportsToolCall === undefined ? {} : { supportsToolCall }),
  }
}

/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order. Without a
 * usable `cli` roster the whole parsed catalog is exposed rather than nothing.
 */
export function selectCliModels(rawModels, agents) {
  const byId = new Map()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id) => typeof id === 'string')
        break
      }
    }
  }
  const models = (cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]).map((id) => byId.get(id)).filter((model) => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}

// ---------------------------------------------------------------------------
// enabled / filter / capability 纯函数
// ---------------------------------------------------------------------------

/**
 * Apply the saved local DSH budget. A budget is an UPPER LIMIT the user sets:
 * it can only ever LOWER a window (`Math.min`), never raise it.
 */
export function applyContextBudgets(catalog, budgets = {}) {
  return catalog.map((model) => ({
    ...model,
    contextWindow: budgets[model.id] === undefined ? model.contextWindow : Math.min(model.contextWindow, budgets[model.id]),
  }))
}

/** Filter the catalog to the enabled ids (an empty set keeps everything), then apply budgets. */
export function deriveCatalog(catalog, enabled, budgets = {}) {
  return applyContextBudgets(enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id)), budgets)
}

/**
 * Reviewed vendor classifications, keyed by EXACT model id (never a prefix).
 * Ids absent from this record are `unknown`.
 */
export const NATIVE_MODALITY_BY_MODEL_ID = {
  'deepseek-v4-pro': 'text',
  'glm-5.1': 'text',
  'glm-5.2': 'text',
  'glm-5.3': 'text',
  'hy3': 'text',
  'hy4-preview': 'text',
  'deepseek-v4.1-flash': 'multimodal',
  'glm-5.3-flash': 'multimodal',
  'glm-5v-turbo': 'multimodal',
  'kimi-k2.6': 'multimodal',
  'kimi-k2.7': 'multimodal',
  'kimi-k3-1': 'multimodal',
  'minimax-m3': 'multimodal',
}

/** The `auto` entry is a router that picks a model, not a model itself. */
export const ROUTER_MODEL_ID = 'auto'

/** Native modality of one model id. Exact match only. */
export function nativeModalityOf(modelId) {
  if (modelId === ROUTER_MODEL_ID) return 'router'
  return NATIVE_MODALITY_BY_MODEL_ID[modelId] ?? 'unknown'
}

/**
 * Whether a model refresh should PRE-CHECK this model's image box. Only a
 * documented `multimodal` is pre-checked; a platform `supportsImages: false`
 * still vetoes.
 */
export function imageDefaultFor(info) {
  if (info.supportsImages === false) return false
  return NATIVE_MODALITY_BY_MODEL_ID[info.id] === 'multimodal'
}

/** Stamp the image selection onto a model list（老插件 index.ts withImageSelection 原样）. */
export function withImageSelection(models, images) {
  return models.map((model) => ({
    ...model,
    ...(images.has(model.id) ? { multimodal: true } : { multimodal: false }),
  }))
}

/**
 * Ids observed to REFUSE `reasoning_effort: "off"` with HTTP 400 despite
 * declaring `canDisableThinking: true`（老插件 off-thinking.ts 原样，issue #34）.
 */
export const REFUSES_OFF_MODEL_IDS = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])

/** Whether `off` should be offered for a model by default. */
export function offDefaultFor(info) {
  return info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id)
}

/** The model ids the `off` level should be offered for by default. */
export function defaultOffModelIds(models) {
  return models.filter(offDefaultFor).map((model) => model.id)
}

/** Stamp the effective `off` selection onto a model list, for the RUNTIME catalog. */
export function withEffectiveOff(models, selection) {
  return models.map((model) => model.reasoning === undefined ? model : {
    ...model,
    reasoning: {
      ...model.reasoning,
      canDisableThinking: selection.has(model.id),
    },
  })
}

/**
 * 老插件 `configuredModels` 在零用户设置下的等价物：完整目录 → 按 native
 * modality 表盖 multimodal → 按 off 默认表盖 canDisableThinking。M3 还没有
 * 模型管理 UI，enabled/budgets 一律取空（即全量目录、原生窗口）。
 */
export function defaultCatalogStamp(models) {
  const declared = withImageSelection(deriveCatalog(models, new Set(), {}), new Set(models.filter(imageDefaultFor).map((model) => model.id)))
  return withEffectiveOff(declared, new Set(defaultOffModelIds(models)))
}
