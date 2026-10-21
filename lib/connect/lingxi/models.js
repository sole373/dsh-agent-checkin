/**
 * Lingxi（WPS 灵犀）模型转换（五层架构的辅助层）。
 *
 * 把目录条目转成 pi-ai 所需的 profile 模型描述。
 *
 * @module dsh-agent-checkin/connect/lingxi/models
 */

import { NO_COST } from '../baseadapter.js'

/**
 * 将目录条目转为 pi-ai 模型对象。
 *
 * Lingxi 使用私有 run 协议，不是 OpenAI 兼容接口，
 * 所以这里标记为 'custom' API 类型。
 *
 * @param {object} model 目录条目（{ id, name, upstreamId, contextWindow?, maxOutput?, multimodal?, multiplier? }）
 * @param {string} baseUrlV1 loopback shim 的 v1 端点（如 `http://127.0.0.1:PORT/v1`）
 * @param {string} providerId provider 路由 id（固定为 `'lingxi'`）
 * @returns {{ id, name, api, provider, baseUrl, input, cost, contextWindow }}
 */
export function toPiModel(model, baseUrlV1, providerId) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai', // Lingxi 通过 shim 转换为 OpenAI 兼容接口
    provider: providerId,
    baseUrl: baseUrlV1,
    // 输入能力：根据 support_multimodal 字段判断
    input: model.multimodal === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
    // 透传上游真实 model key，供 shim 转发时使用
    _upstreamId: model.upstreamId || model.id,
    // 保留 multiplier 信息（用于显示消耗系数）
    _multiplier: model.multiplier || '',
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

/**
 * 模型展示名（优先用 name，否则回退到 id）。
 *
 * @param {object} model
 * @returns {string}
 */
export function lingxiDisplayName(model) {
  return model.name || model.id
}
