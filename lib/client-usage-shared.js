/**
 * 前端共享小工具：界面语言判据 + provider 人类可读名。
 *
 * 这个文件原本是「用量统计页面 + 输入框余额徽标」共用的片段。Token 用量那部分
 * 已于 0.9.0 迁到独立插件 dsh-token-usage；本插件这边只留下余额徽标还要用的
 * 两样东西：语言判据与 provider 名字表。
 *
 * 保留成独立片段文件（而不是塞进 client.js 主干）是为了让这一段能单独
 * `node --check`、能被人一眼读完——client.js 是生成物，混进去就会被覆盖。
 */

/** 当前界面语言是否为中文。与 client.js 的 `t()` 同一判据，避免两处各猜一次。 */
function isZhUi() {
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
}

/** 把 provider id 翻成一个人类能读的名字；不认识的照原样显示，不猜。 */
const PROVIDER_LABELS = {
  workbuddy: 'WorkBuddy',
  'workbuddy-global': 'WorkBuddy AI',
  trae: 'TRAE',
  'trae-global': 'TRAE AI',
  'qoder-cn': 'Qoder',
  'deepseek-account': 'DeepSeek（账号）',
  'deepseek-official': 'DeepSeek（官方）',
  siliconflow: 'SiliconFlow',
  xiaomi: '小米 MiMo',
  zai: '智谱 GLM',
  openrouter: 'OpenRouter',
  freeroute: 'FreeRoute',
  dumate: '百度搭子',
  lingxi: 'WPS 灵犀',
}

function providerLabel(id) {
  if (id === '') return '未知来源'
  return PROVIDER_LABELS[id] ?? id
}
