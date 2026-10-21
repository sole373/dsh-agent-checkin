/**
 * DuMate 模型转换（五层架构的辅助层）。
 *
 * 把目录条目转成 pi-ai 所需的 profile 模型描述。
 *
 * @module dsh-agent-checkin/connect/dumate/models
 */

import { NO_COST } from '../baseadapter.js'

/**
 * 将目录条目转为 pi-ai 模型对象。
 *
 * @param {object} model 目录条目（{ id, name, upstreamId, contextWindow?, maxOutput?, multimodal? }）
 * @param {string} baseUrlV1 loopback shim 的 v1 端点（如 `http://127.0.0.1:PORT/v1`）
 * @param {string} providerId provider 路由 id（固定为 `'dumate'`）
 * @returns {{ id, name, api, provider, baseUrl, input, cost, contextWindow }}
 */
export function toPiModel(model, baseUrlV1, providerId) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai',
    provider: providerId,
    baseUrl: baseUrlV1,
    // 输入能力：DuMate 当前模型均为纯文本（multimodal 字段在 opencode.json 中通常为 false）
    input: model.multimodal === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
    // 透传上游真实 model id，供 shim 转发时使用
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
    // 排除明显是内部验证用的模型
    if (m.id.includes('artifact-validate') || m.id.includes('test-')) return false
    return true
  })
}

/**
 * 模型展示名（优先用 name，否则回退到 id）。
 *
 * @param {object} model
 * @returns {string}
 */
export function dumateDisplayName(model) {
  return model.name || model.id
}
