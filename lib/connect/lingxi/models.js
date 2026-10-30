/**
 * Lingxi（WPS 灵犀）模型转换（五层架构的辅助层）。
 *
 * 把目录条目转成 pi-ai 所需的 profile 模型描述。
 *
 * @module dsh-agent-checkin/connect/lingxi/models
 */

import { NO_COST } from '../baseadapter.js'

/**
 * 把额度倍率折进展示名。
 *
 * 宿主的**聊天模型选择器**渲染的是 `buildModels`（`toPiModel`）返回的 `name`，
 * 不看 `multiplier` 字段——与 TRAE / Qoder / WorkBuddy 同一路线，那三家都已
 * 折名，只有灵犀漏了，于是选择器里一直只有裸名。
 *
 * 倍率必须是**数字**（`catalog.js#parseLingxiMultiplier` 已解析）：
 * 上游给的是 `"～0.12x"` 这样的字符串，直接 `.toFixed()` 会抛 TypeError。
 * 2026-10-21 那次连续 10 次启动崩溃正是「折名模板串先于类型守卫执行」造成的，
 * 所以这里的守卫**必须在模板串之前**，且对无倍率条目返回裸名。
 *
 * 灵犀的倍率没有「0 = 免费」语义（上游最低 0.08，不存在 0），
 * 因此不做 `x0.00` 特判，与 TRAE 的处理一致。
 *
 * @param {{ name?: string, id?: string, multiplier?: number }} model 目录条目
 * @returns {string}
 */
export function lingxiDisplayName(model) {
  const base = model.name || model.id || ''
  const multiplier = model.multiplier
  // 守卫前置：无倍率 / 非数字 → 裸名，绝不进模板串。
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0) return base
  return `${base} · x${multiplier.toFixed(2)}`
}

/**
 * 将目录条目转为 pi-ai 模型对象。
 *
 * Lingxi 使用私有 run 协议，不是 OpenAI 兼容接口，
 * 但经 loopback shim 转成 OpenAI 兼容后按 `api: 'openai'` 注册。
 *
 * @param {object} model 目录条目（{ id, name, upstreamId, contextWindow?, maxOutput?, multimodal?, multiplier? }）
 * @param {string} baseUrlV1 loopback shim 的 v1 端点（如 `http://127.0.0.1:PORT/v1`）
 * @param {string} providerId provider 路由 id（固定为 `'lingxi'`）
 * @returns {{ id, name, api, provider, baseUrl, input, cost, contextWindow }}
 */
export function toPiModel(model, baseUrlV1, providerId) {
  return {
    id: model.id,
    // 倍率折进名字：选择器只渲染 name（理由见 lingxiDisplayName）。
    name: lingxiDisplayName(model),
    api: 'openai', // Lingxi 通过 shim 转换为 OpenAI 兼容接口
    provider: providerId,
    baseUrl: baseUrlV1,
    // 输入能力：根据 support_multimodal 字段判断
    input: model.multimodal === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
    // 透传上游真实 model key，供 shim 转发时使用
    _upstreamId: model.upstreamId || model.id,
  }
}

/**
 * 过滤出可选模型（排除内部测试/验证用模型）。
 *
 * @param {Array} models 原始目录列表
 * @returns {Array} 可展示给用户的模型子集
 */
export function filterSelectable(models) {
  return models.filter((m) => {
    // 不排除任何模型，Lingxi 的所有模型都是可用的
    return true
  })
}
