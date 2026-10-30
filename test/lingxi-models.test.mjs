/**
 * 灵犀倍率回归自检：上游的字符串倍率必须被解析成数字，且折名不能崩。
 *
 * 跑法：node test/lingxi-models.test.mjs
 *
 * 这里防的是 2026-10-29 查出来的三处叠加缺陷（任意一处复发，倍率就又全不显示）：
 *   1. catalog 原样存字符串 —— 下游 `selection.js:441` / `models-page.js:101`
 *      两道守卫只收 `typeof === 'number'`，字符串被静默丢弃，页面上什么都不显示；
 *   2. toPiModel 只把倍率塞进 `_multiplier`，不改 `name` —— 宿主的聊天模型
 *      选择器只渲染 `name`，所以聊天框里一直只有裸名（TRAE/Qoder/WorkBuddy
 *      三家都折了名，只有灵犀漏了）；
 *   3. listAll 读 `model._multiplier` —— 那是 toPiModel 的输出字段，目录条目上
 *      根本不存在，永远拿到空串。
 *
 * 另有一道**崩溃**红线（2026-10-21 连续 10 次启动崩溃同型）：折名模板串若跑在
 * 类型守卫之前，对字符串倍率 `.toFixed()` 会抛 TypeError。灵犀 11/11 上游都给
 * 字符串，所以「守卫在模板串之前」必须有测试钉死。
 *
 * 纯函数测试：不依赖灵犀 Cookie、不联网、不依赖宿主私有模块。
 */

import { parseLingxiMultiplier, parseApiModels } from '../lib/connect/lingxi/catalog.js'
import { lingxiDisplayName, toPiModel } from '../lib/connect/lingxi/models.js'

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

// —— 上游实测原文（2026-10-29，GET /api/aioffice/v1/sessions/plans，11/11 全带 multiplier）——
// 三种形态混在一起：全角波浪号 U+FF5E 4 条、半角波浪号 U+007E 3 条、纯数字 4 条。
// 只认其中一种就会漏掉另外几种，所以逐条钉死。
const UPSTREAM = [
  ['deepseek-v4.1-flash', '～0.12x', 0.12], // 全角～
  ['deepseek-v4-pro-0813', '0.40x', 0.40], // 纯数字
  ['qwen3.8_flash', '～0.08x', 0.08], // 全角～
  ['qwen3.8_max', '～0.80x', 0.80], // 全角～
  ['mimo-v2.6-pro', '0.10x', 0.10], // 纯数字
  ['GLM-5.3-Flash', '~0.11x', 0.11], // 半角~
  ['GLM-5.3', '~0.75x', 0.75], // 半角~
  ['minimax_m3', '0.20x', 0.20], // 纯数字
  ['doubao_seed_2_1_pro_260628', '～0.50x', 0.50], // 全角～
  ['kimi-k3', '1.60x', 1.60], // 纯数字，≥1
  ['kimi-k3.1-pro', '~1.10x', 1.10], // 半角~，≥1
]

console.log('上游 11 条倍率原文逐条解析：')
for (const [key, raw, expected] of UPSTREAM) {
  const got = parseLingxiMultiplier(raw)
  ok(got === expected, `${key}  "${raw}" -> ${expected}（实际 ${got}）`)
}
ok(UPSTREAM.every(([, raw]) => parseLingxiMultiplier(raw) !== undefined),
  '11/11 全部解析成功（没有任何一条被静默丢弃）')

// —— 形态边界：全角/半角/大小写 x/无 x ——
console.log('\n形态边界：')
ok(parseLingxiMultiplier('～0.12x') === 0.12, '全角波浪号 U+FF5E 可解析')
ok(parseLingxiMultiplier('~0.12x') === 0.12, '半角波浪号 U+007E 可解析')
ok(parseLingxiMultiplier('0.12x') === 0.12, '无波浪号可解析')
ok(parseLingxiMultiplier('0.12X') === 0.12, '大写 X 后缀可解析')
ok(parseLingxiMultiplier('x0.12') === 0.12, '前缀 x 可解析（只抓数值）')
ok(parseLingxiMultiplier('12') === 12, '纯整数可解析')
ok(parseLingxiMultiplier('0.5') === 0.5, '无后缀小数可解析')

// —— 失败一律 undefined：不猜、不编 1（与 trae-catalog 的 normalizeEntry 同纪律）——
console.log('\n解析失败回 undefined（绝不编造倍率）：')
ok(parseLingxiMultiplier('') === undefined, '空串 -> undefined')
ok(parseLingxiMultiplier(undefined) === undefined, 'undefined -> undefined')
ok(parseLingxiMultiplier(null) === undefined, 'null -> undefined')
ok(parseLingxiMultiplier('abc') === undefined, '非数字串 -> undefined')
ok(parseLingxiMultiplier({}) === undefined, '对象 -> undefined')
ok(parseLingxiMultiplier(NaN) === undefined, 'NaN -> undefined')
ok(parseLingxiMultiplier(-0.5) === undefined, '负数 -> undefined')
ok(parseLingxiMultiplier(Infinity) === undefined, 'Infinity -> undefined')
ok(parseLingxiMultiplier(0.5) === 0.5, '上游若直接给数字则原样用（不预设格式）')
ok(parseLingxiMultiplier(0) === 0, '数字 0 合法（0 是有效倍率，不当缺失）')

// —— parseApiModels：目录条目上必须是 number，且没倍率就整字段省略 ——
console.log('\nparseApiModels 产出：')
const apiModels = [
  { key: 'kimi-k3', name: 'Kimi K3', multiplier: '1.60x', support_multimodal: true, max_context_tokens: 1048576, max_new_tokens: 131072 },
  { key: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', multiplier: '~0.11x' },
  { key: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', multiplier: '～0.12x' },
  { key: 'no-multiplier', name: 'No Multiplier' },
  { key: 'empty-multiplier', name: 'Empty', multiplier: '' },
  { key: 'garbage', name: 'Garbage', multiplier: 'not-a-number' },
]
const parsed = parseApiModels(apiModels)
ok(parsed.length === 6, `6 条全部保留（实际 ${parsed.length}）`)
ok(parsed.every((m) => m.multiplier === undefined || typeof m.multiplier === 'number'),
  '倍率字段要么是 number、要么不存在（绝不留字符串/空串）')
ok(parsed[0].multiplier === 1.6, `kimi-k3 倍率 1.6（实际 ${parsed[0].multiplier}）`)
ok(parsed[1].multiplier === 0.11, `GLM-5.3-Flash 倍率 0.11（实际 ${parsed[1].multiplier}）`)
ok(parsed[2].multiplier === 0.12, `deepseek-v4.1-flash 倍率 0.12（实际 ${parsed[2].multiplier}）`)
ok('multiplier' in parsed[3] === false, '无倍率条目：字段整段省略，不留 undefined 键')
ok('multiplier' in parsed[4] === false, '空串倍率：字段整段省略')
ok('multiplier' in parsed[5] === false, '无法解析的倍率：字段整段省略（不编 1）')

// —— 下游闸门：模拟 selection.js:441 与 models-page.js:101 的同一口径 ——
// 这是「为什么必须存数字」的实证：把上游原串喂进闸门，一定被丢掉。
console.log('\n下游数字闸门（selection.js:441 / models-page.js:101 同口径）：')
const gate = (m) => typeof m.multiplier === 'number' && Number.isFinite(m.multiplier) && m.multiplier >= 0
ok(parsed.slice(0, 3).every(gate), '解析后的 3 条都过闸门（页面会显示倍率）')
ok(gate({ multiplier: '～0.12x' }) === false, '上游原串过不了闸门 —— 这就是原缺陷的成因')
ok(gate({ multiplier: '' }) === false, '空串过不了闸门 —— 这就是 _multiplier 路线的成因')
ok(gate({ multiplier: NaN }) === false, 'NaN 过不了闸门')
ok(gate({ multiplier: -1 }) === false, '负数过不了闸门')

// —— 折名：聊天选择器只读 name（2026-10-21 崩溃同型，守卫必须在模板串之前）——
console.log('\n折名（lingxiDisplayName / toPiModel）：')
const folded = parsed.map((m) => lingxiDisplayName(m))
ok(folded[0] === 'Kimi K3 · x1.60', `kimi-k3 折名（实际 "${folded[0]}"）`)
ok(folded[1] === 'GLM-5.3-Flash · x0.11', `GLM-5.3-Flash 折名（实际 "${folded[1]}"）`)
ok(folded[2] === 'DeepSeek V4.1 Flash · x0.12', `deepseek-v4.1-flash 折名（实际 "${folded[2]}"）`)
ok(folded[3] === 'No Multiplier', '无倍率 -> 裸名')
ok(folded[4] === 'Empty', '空串倍率 -> 裸名（不显示 x0.00）')
ok(folded[5] === 'Garbage', '无法解析 -> 裸名')

// 崩溃红线：字符串倍率直接进折名。若守卫写在模板串之后，这里会抛 TypeError。
// 灵犀上游 11/11 都是字符串，这条不过就等于「一接入就崩」。
let crashGuardOk = true
let crashError
try {
  for (const [, raw] of UPSTREAM) {
    lingxiDisplayName({ name: 'X', multiplier: raw })
  }
} catch (error) {
  crashGuardOk = false
  crashError = error
}
ok(crashGuardOk, `字符串倍率折名不抛（${crashError ? `实际抛出 ${crashError.message}` : '守卫在模板串之前'})`)
ok(lingxiDisplayName({ name: 'X', multiplier: '～0.12x' }) === 'X',
  '字符串倍率被守卫挡掉，返回裸名而不是崩或显示 NaN')
ok(lingxiDisplayName({ name: undefined, id: 'fallback-id', multiplier: 0.5 }) === 'fallback-id · x0.50',
  'name 缺失时回退 id 再折名')
ok(lingxiDisplayName({}) === '', '空对象返回空串，不抛')

// toPiModel 是宿主聊天选择器读的那条路线
const piModels = parsed.map((m) => toPiModel(m, 'http://127.0.0.1:9/v1', 'lingxi'))
ok(piModels[0].name === 'Kimi K3 · x1.60', `toPiModel 折名（实际 "${piModels[0].name}"）`)
ok(piModels[3].name === 'No Multiplier', 'toPiModel 无倍率返回裸名')
ok(piModels.every((m) => m.provider === 'lingxi'), 'toPiModel 仍按 provider id 打标')
ok(piModels.every((m) => !('_multiplier' in m)), '不再产出失效的 _multiplier 字段（listAll 曾误读它）')
ok(piModels.every((m) => m._upstreamId === m.id), '_upstreamId 透传保持不变')
ok(piModels[0].input.join(',') === 'text,image', 'multimodal 模型仍声明 image 输入')
ok(piModels[1].input.join(',') === 'text', '非 multimodal 模型只有 text')

console.log(`\nlingxi-models: ${checks} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
