/**
 * TRAE 目录条目 → pi-ai 模型描述（纯函数）。
 *
 * 两个刻意的决定（理由与 ref/connect-qoder adapter.js:219-233 相同，MIT）：
 *
 *   - **不声明 `maxTokens`**：`dsh-llm-pi-ai` 会把声明值当成模型的输出上限
 *     并以 `max_tokens` 发出；推理模型的思考与回答共享该预算，声明了会把
 *     长推理截成半截（宿主报 `finish: max-tokens`）。不声明则宿主用自己的
 *     默认值，上游（llm_raw_chat）按模型自身上限出完。
 *   - **`contextWindow` 回退 200000**：目录条目大多带真实窗口，缺省值只是
 *     兜底，防止一条没标窗口的记录拖垮整个 provider（INVALID_MODEL_CONTEXT）。
 *
 * `compat.supportsDeveloperRole: false` 是承重的（同 qoder：pi-ai 对
 * reasoning 模型会自动改用 `developer` 角色发系统提示，而这条路由的
 * loopback 地址不在它的已知名单里，自动检测会误判为 true）。
 *
 * @module dsh-agent-checkin/connect/trae/models
 */

import { NO_COST } from '../baseadapter.js'

/** 目录条目没标窗口时的兜底容量。 */
export const FALLBACK_CONTEXT_WINDOW = 200_000

/**
 * 展示名走 `modelDisplayName`（折倍率 + 同名消歧），与原版
 * `ref/connect-trae index.js:555` 的 `toPiModel` 一致，也与我们 qoder 的
 * `toPiModel`（models.js:215 `displayNameFor`）一致。2026-10-21 复盘：聊天
 * 模型选择器读的是**本路线**（宿主 `buildModelCatalog` → `llm.listModels` →
 * adapter 的 `buildModels`），不是 discover——discover 只喂设置页的目录继承。
 * 这里漏折名正是「重启后选择器仍裸名重名」的真根因。
 *
 * @param {object} entry trae-catalog 的目录条目
 *   `{ id, name, contextWindow, multimodal, reasoning, ... }`
 * @param {string} baseUrlV1 该 provider shim 的 `http://127.0.0.1:<port>/v1`
 * @param {string} providerId 'trae' | 'trae-global'
 * @param {Array} [all] 同名条目全集（可选，消歧用；与 discover 传同一数组）
 */
export function toPiModel(entry, baseUrlV1, providerId, all) {
  const contextWindow = Number(entry.contextWindow)
  return {
    id: entry.id,
    name: modelDisplayName(entry, all),
    api: 'openai-completions',
    provider: providerId,
    baseUrl: baseUrlV1,
    input: entry.multimodal === true ? ['text', 'image'] : ['text'],
    reasoning: entry.reasoning === true,
    cost: NO_COST,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : FALLBACK_CONTEXT_WINDOW,
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
  }
}

/**
 * 把额度倍率折进展示名，供 `registerModelDiscovery` 的 `discover` 使用。
 *
 * 宿主的模型选择器渲染的是 `discover` 返回条的 `name`，不看 `multiplier`
 * 字段（倍率只在看板里单独展示）。原版 `dsh-connect-trae` 正是这样做的：
 * `ref/connect-trae/package/lib/index.js:134` 的 `traeModelDisplayName`
 * 返回 `` `${model.name} · x${model.creditMultiplier.toFixed(2)}` ``，
 * 在 `:555` 与 `:6740` 两处调用。不折名的结果是选择器里只有裸名，
 * 用户根本看不出这个模型烧多少额度。
 *
 * 没有倍率的条目保持裸名（与 trae-catalog 的 `normalizeEntry`
 * 「没有就整字段省略，不编 1」一致，不伪造 x1.00）。
 *
 * 若同显示名下存在多个 id（如 -Official 与基础版），追加来源后缀消歧：
 *   - 含 "Official" 的 id → ` (Official)`
 *   - 仅出现在 solo_coder 的 id → ` (Coder)`
 *   - 其余按 id 简写兜底。
 *
 * @param {{ name?: string, id?: string, multiplier?: number, appearedIn?: string[] }} entry 目录条目
 * @param {Array<{name:string,id:string,appearedIn?:string[]}>} [all] 同名条目全集（可选，用于消歧）
 * @returns {string}
 */
export function modelDisplayName(entry, all) {
  const base = entry.name ?? entry.id ?? ''
  const multiplier = entry.multiplier
  // 守卫必须在模板串之前：2026-10-21 事故复盘——折名模板先于守卫执行，
  // 目录里任何无倍率条目（活数据，实测出现过 code-review-judge）都会让
  // undefined.toFixed() 抛 TypeError，宿主启动期拉模型清单时被炸成
  // 「desktop welcome: Web authentication failed」，连续 10 次启动崩溃。
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return base
  // 两位小数与原版一致，保证同精度下的条目可比大小。
  let name = `${base} · x${multiplier.toFixed(2)}`

  // 消歧：同显示名有多条时，追加来源后缀
  if (Array.isArray(all) && all.length > 0) {
    const sameName = all.filter((e) => (e.name ?? e.id) === base)
    if (sameName.length > 1) {
      const id = typeof entry.id === 'string' ? entry.id : ''
      const hasOfficial = id.includes('Official')
      const soloCoderOnly = Array.isArray(entry.appearedIn) && entry.appearedIn.length === 1 && entry.appearedIn[0] === 'solo_coder'
      if (hasOfficial) name += ' (Official)'
      else if (soloCoderOnly) name += ' (Coder)'
      else name += ` (${id.slice(-8)})`
    }
  }
  return name
}

/**
 * TRAE 目录里的「自定义 base_url 端点变体」指纹：`config_name` 含 `//`
 * （本机实测为 `deepseek//deepseek-v4-pro`、`deepseek//deepseek-v4-flash`）。
 *
 * 排除它们的依据（2026-10-18 本机逐模型实测，详见 trae-catalog.js
 * `formatCatalogLine` 头注 L219-233）：
 *   - 十个 function 全回 4001 —— 目录里有、但根本调不动，选上只会报错；
 *   - `features` 里没有 consumption_rate / activity_discount —— 看板倍率
 *     永远空白（normalizeEntry「没有就整字段省略，不编 1」）；
 *   - `display_name` 与官方版撞名（「DeepSeek-V4-Pro」三行同名的来源之一），
 *     宿主模型选择器渲染的正是 display_name，留着只制造「看着重复、
 *     选了又调不通」的噪声。
 */
export function isUnroutableCustomEndpoint(id) {
  return typeof id === 'string' && id.includes('//')
}

/**
 * 目录里「可选、在线、且真的调得动」的条目。
 *
 * `selectable !== false && status !== false` 两者缺省视为 true（客户端字段
 * 缺省时按可选处理）；再排除自定义 base_url 变体（理由见
 * `isUnroutableCustomEndpoint`）。这是宿主模型列表（toPiModel 路线）、模型
 * 发现（discover）与看板「模型接入」页（listAll）共用的唯一过滤入口——
 * 在这里排除一处，三处同时生效。
 */
export function filterSelectable(models) {
  return (Array.isArray(models) ? models : []).filter((m) => m
    && typeof m.id === 'string' && m.id.length > 0
    && !isUnroutableCustomEndpoint(m.id)
    && m.selectable !== false
    && m.status !== false)
}
