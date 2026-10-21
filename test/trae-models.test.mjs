/**
 * TRAE 目录过滤自检：自定义 base_url 变体必须被排除，可选/在线判定不能退化。
 *
 * 跑法：node test/trae-models.test.mjs
 *
 * 这里防的是两类「会静默出错」：
 *   1. 过滤入口写漏 —— 宿主模型列表、模型发现、看板「模型接入」页三处共用
 *      `filterSelectable`，漏掉一处就会把 `deepseek//deepseek-v4-*` 这类
 *      十个 function 全回 4001 的条目透出去（选了调不通，还和官方版撞 display_name）；
 *   2. 判定写太宽 —— 把正常 `config_name` 误杀，等于本机少接几个模型，且没有任何报错。
 *
 * 纯函数测试，不依赖 TRAE 客户端与宿主私有模块。
 */

import { filterSelectable, isUnroutableCustomEndpoint, toPiModel } from '../lib/connect/trae/models.js'

let checks = 0
function ok(cond, label) {
  checks += 1
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exitCode = 1
    return
  }
  console.log(`  ok  ${label}`)
}

// —— 指纹判定 ——
ok(isUnroutableCustomEndpoint('deepseek//deepseek-v4-pro') === true, '含 // 的自定义端点被判为不可路由')
ok(isUnroutableCustomEndpoint('deepseek//deepseek-v4-flash') === true, '同上（flash 变体）')
ok(isUnroutableCustomEndpoint('DeepSeek-V4-Pro') === false, '裸 config_name 不误杀')
ok(isUnroutableCustomEndpoint('DeepSeek-V4-Pro-Official') === false, '-Official 变体不误杀')
ok(isUnroutableCustomEndpoint('kimi-k3') === false, '常规模型不误杀')
ok(isUnroutableCustomEndpoint('') === false, '空串不是自定义端点')
ok(isUnroutableCustomEndpoint(undefined) === false, 'undefined 不炸')
ok(isUnroutableCustomEndpoint(123) === false, '非字符串不炸')

// —— 过滤行为 ——
const catalog = [
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', selectable: true, status: true },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', selectable: true, status: true },
  { id: 'deepseek//deepseek-v4-pro', name: 'DeepSeek-V4-Pro', selectable: true, status: true },
  { id: 'deepseek//deepseek-v4-flash', name: 'DeepSeek-V4-Flash', selectable: true, status: true },
  { id: 'kimi-k3', name: 'Kimi K3', multiplier: 1.83 },
  { id: 'glm-5.3', name: 'GLM-5.3', selectable: false, status: true },
  { id: 'glm-5.2', name: 'GLM-5.2', selectable: true, status: false },
  { id: '', name: '空 id' },
  null,
  undefined,
]
const kept = filterSelectable(catalog)
ok(kept.every((m) => !m.id.includes('//')), '自定义端点变体全部被排除')
ok(kept.map((m) => m.id).join(',') === 'DeepSeek-V4-Pro,DeepSeek-V4-Pro-Official,kimi-k3',
  '保留集合精确匹配：不可选调、status=false、空 id、非对象都滤掉，缺省 selectable/status 视为 true')
ok(kept.length === 3, `保留 3 条（实际 ${kept.length}）`)
ok(filterSelectable([]).length === 0, '空数组返回空')
ok(filterSelectable(undefined).length === 0, '非数组入参返回空，不抛')
ok(filterSelectable(null).length === 0, 'null 入参返回空，不抛')

// —— 三个消费点确实共用这一处 ——
const discover = kept.map((m) => ({ id: m.id, name: m.name, input: m.multimodal === true ? ['text', 'image'] : ['text'] }))
ok(discover.every((r) => !r.id.includes('//')), '模型发现（discover）走同一入口，同样不含 //')
const piModels = kept.map((m) => toPiModel(m, 'http://127.0.0.1:9/v1', 'trae'))
ok(piModels.length === 3 && piModels.every((m) => !m.id.includes('//')), 'toPiModel 路线同样不含 //')
ok(piModels.every((m) => m.provider === 'trae'), 'toPiModel 仍按 provider id 打标')

// —— toPiModel 折倍率 + 消歧（2026-10-21 复盘：聊天选择器读的是这条路线） ——
const rich = [
  { id: 'a', name: 'Moe', multiplier: 0.1, appearedIn: ['solo_coder'] },
  { id: 'b-Official', name: 'Moe', multiplier: 0.1, appearedIn: ['solo_agent', 'solo_coder'] },
  { id: 'c', name: 'Lone', multiplier: 0.36 },
  { id: 'd', name: 'NoMult' },
]
const richPi = rich.map((m) => toPiModel(m, 'http://127.0.0.1:9/v1', 'trae', rich))
ok(richPi[0].name === 'Moe · x0.10 (Coder)', `toPiModel 折倍率+Coder 消歧（实际 ${richPi[0].name}）`)
ok(richPi[1].name === 'Moe · x0.10 (Official)', `toPiModel Official 消歧（实际 ${richPi[1].name}）`)
ok(richPi[2].name === 'Lone · x0.36', '无重名只折倍率不加后缀')
ok(richPi[3].name === 'NoMult', '无倍率条目返回裸名、绝不抛（崩溃守卫在折名之前）')
ok(new Set(richPi.map((m) => m.name)).size === 4, 'toPiModel 路线同目录名全唯一')

console.log(`\ntrae-models: ${checks} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
