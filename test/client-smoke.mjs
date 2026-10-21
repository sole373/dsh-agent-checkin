/**
 * 端到端冒烟：用假的宿主环境把 client.js 真跑一遍。
 *
 * 目的不是覆盖 UI 细节，而是抓三类「只会在真机才炸」的错误：
 *   1. 片段注入后出现未定义符号（例如 h / useMemo 没接上）；
 *   2. slot 注册参数形状不对（名字/key/locale）；
 *   3. 面板渲染时读不到数据就抛异常（React 里表现为白屏，日志里什么都没有）。
 *
 * 它渲染成静态字符串，所以不需要 DOM，也不需要 React 的 DOM renderer。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// 插件不装 react：宿主在运行时把 `react` / `react/jsx-runtime` 塞进模块加载器。
// 所以这里也不 require 它——下面的 shim 就是「宿主那种极简 React」的替身。

const source = readFileSync('E:/DSH/agent积分聚合插件/dsh-agent-checkin/lib/client.js', 'utf8')

// ---- 极简 React：只实现渲染成 HTML 字符串所需的那部分 ----
class FakeNode {
  constructor(type, props, children) {
    this.type = type
    this.props = props ?? {}
    // children 可能是单个节点、数组或 undefined（props.children 的三种形态）。
    const list = children === undefined || children === null ? [] : [children]
    this.children = list.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  }
}

function createElement(type, props, ...children) {
  // jsx-runtime 的调用形态是 createElement(type, { children })，children 藏在
  // props 里；只有 createElement 形态才在第三个参数之后。两种都要接住。
  const own = props?.children
  const supplied = children.length > 0 ? children : (own === undefined ? [] : own)
  return new FakeNode(type, props, supplied)
}

// ---- 极简 hooks：**按组件分别存槽位** ----
//
// 曾经的桩把所有组件共用一个槽位数组 + 一个全局游标。0.8.0 让用量面板里嵌进了
// 另一个带 hooks 的子组件（模型排名区），那个桩立刻失效：子组件的 useState 会
// 覆盖父组件的槽位，父组件于是读到 undefined 的 state。真实 React 是按组件实例
// 分配槽位的，桩必须照做——否则测出来的失败是桩的失败，不是面板的失败。
const hookStore = new Map() // 组件函数 → { slots: [], index: 0 }
let currentComponent

function hooksFor(fn) {
  let entry = hookStore.get(fn)
  if (entry === undefined) {
    entry = { slots: [], index: 0 }
    hookStore.set(fn, entry)
  }
  return entry
}

/** 按组件名取槽位：组件函数是 factory 闭包里的，测试只能按名字找。 */
function hooksByName(name) {
  for (const [fn, entry] of hookStore) {
    if (fn.name === name) return entry
  }
  return undefined
}

const effects = []

// 极简 React.Component：错误边界要用 class 实现，桩必须能承受 extends。
class FakeComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}

const ReactShim = {
  Component: FakeComponent,
  createElement,
  useState(initial) {
    const entry = hooksFor(currentComponent)
    const slot = entry.index++
    if (!(slot in entry.slots)) entry.slots[slot] = typeof initial === 'function' ? initial() : initial
    return [
      entry.slots[slot],
      (next) => { entry.slots[slot] = typeof next === 'function' ? next(entry.slots[slot]) : next },
    ]
  },
  useMemo(factory) {
    hooksFor(currentComponent).index++
    return factory()
  },
  useCallback(fn) {
    hooksFor(currentComponent).index++
    return fn
  },
  useEffect(fn) {
    hooksFor(currentComponent).index++
    effects.push(fn)
  },
  useRef(value) {
    hooksFor(currentComponent).index++
    return { current: value }
  },
}

// ---- 假的 fetch：返回 /usage 与 /settings 端点 ----
const settingsDoc = {
  ok: true,
  platforms: [
    { id: 'workbuddy', name: 'WorkBuddy 国内版', unit: '积分', balance: { balance: 128, source: 'measured' } },
    { id: 'qoder', name: 'Qoder', unit: 'credits', balance: { balance: 169, source: 'measured' } },
  ],
}

const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const text = String(url)
  const body = text.includes('/model-rank') ? rankDoc : (text.includes('/usage') ? usageDoc : settingsDoc)
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}
// Node 自带只读的 navigator（getter），只能用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 把 client.js 的 factory 取出来单独跑 ----
//
// client.js 是固定开头那句 `window.__ModuleLoader__.load({...})`；把它的实参
// 换成桩，factory 就落进 captured —— 不需要 DOM，也不需要真宿主。
let captured
const loaderWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}
globalThis.window = loaderWindow
// 把 h（= jsxRuntime.jsx）换成直通包装，能直接看到面板每次建了什么节点。
// 严格复刻 `react/jsx-runtime` 的真实签名：`jsx(type, props, key?)`——**只有两参**，
// children 必须在 `props.children` 里，第三个参数是 key。
// 之前这个桩把第三参数当 children 收下了，于是「h(type, props, [children])」
// 这种在真机上是空壳的写法，在测试里却全绿——桩太宽容，掩盖了真机 bug。
const RealShim = {
  jsx: (type, props) => createElement(type, props),
  jsxs: (type, props) => createElement(type, props),
  Fragment: 'fragment',
}
const TracedShim = {
  ...RealShim,
  jsx: (type, props) => {
    const node = createElement(type, props)
    if (globalThis.__trace) globalThis.__trace.push([typeof type === 'function' ? type.name : String(type), node.children.length])
    return node
  },
}
globalThis.__trace = []
try {
  new Function('window', 'navigator', 'document', 'fetch', 'setInterval', 'clearInterval', source)(
    loaderWindow, globalThis.navigator, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval,
  )
} catch (error) {
  console.log('EVAL FAILED:', error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : String(error))
  throw error
}
if (captured === undefined) throw new Error('client.js did not register a module')

const moduleRequire = (name) => {
  if (name === 'react') return ReactShim
  if (name === 'react/jsx-runtime') return TracedShim
  throw new Error('unexpected require: ' + name)
}

const exportsObject = captured.factory(moduleRequire)
console.log('[1] module id =', captured.id)
console.log('[2] exports =', Object.keys(exportsObject).join(','))
if (typeof exportsObject.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(exportsObject.inject)) throw new Error('inject must be a static array')
console.log('[3] inject =', JSON.stringify(exportsObject.inject))

// ---- 假 ctx：记录全部 slot 注册 ----
const registrations = []
const injectedKeys = []
const ctx = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key)
      callback()
      return () => {}
    },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)
console.log('[4] injected slots =', JSON.stringify(injectedKeys))
for (const { meta } of registrations) {
  console.log('    register', JSON.stringify(meta))
}
// 0.9.0 起 Token 用量面板已迁到独立插件 dsh-token-usage；本插件只留两个槽：
// 设置分区（签到与凭证）与输入框余额徽标。
if (injectedKeys.length !== 2) throw new Error('expected 2 slot injections, got ' + injectedKeys.length)

const byName = (name) => registrations.filter((r) => r.meta.name === name)
// 设置分区：签到与凭证的配置页。Token 用量面板在 dsh-token-usage 那边。
const sectionMeta = byName('settings.section')[0]
if (sectionMeta === undefined) throw new Error('settings.section not registered')
if (typeof sectionMeta.component !== 'function') throw new Error('settings.section must have a component function')
if (sectionMeta.component.name !== 'CheckinHubSection') {
  throw new Error('settings.section must register CheckinHubSection, got ' + sectionMeta.component.name)
}
console.log('[5] settings.section component =', sectionMeta.component.name)

// ---- 渲染成字符串 ----
/** 逐层摊平子节点数组（React 也这么干）。 */
function flatten(nodes) {
  const out = []
  const walk = (item) => {
    if (item === null || item === undefined || item === false || item === true) return
    if (Array.isArray(item)) {
      item.forEach(walk)
      return
    }
    out.push(item)
  }
  walk(nodes)
  return out
}

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  if (Array.isArray(node)) return node.map(render).join('')
  if (node instanceof FakeNode) {
    if (typeof node.type === 'function') {
      // class 组件（错误边界）：必须 new 后调 render，不能当函数调用。
      if (node.type.prototype !== undefined && typeof node.type.prototype.render === 'function') {
        const instance = new node.type({ ...node.props, children: node.children })
        return render(instance.render())
      }
      // React 的 hook 游标是「每渲染一个组件实例从 0 开始，像调用栈一样进出」。
      // 这里按组件函数切换 currentComponent，子组件渲染完把游标还回去。
      const outer = currentComponent
      currentComponent = node.type
      hooksFor(node.type).index = 0
      const produced = node.type({ ...node.props, children: node.children })
      currentComponent = outer
      return render(produced)
    }
    const attrs = Object.entries(node.props)
      .filter(([key]) => key !== 'children' && key.startsWith('aria-') || key === 'className' || key === 'title' || key === 'width' || key === 'height' || key === 'viewBox')
      .map(([key, value]) => ' ' + key + '="' + String(value) + '"')
      .join('')
    return '<' + node.type + attrs + '>' + render(flatten(node.children)) + '\n</' + node.type + '>'
  }
  throw new Error('unknown node: ' + String(node))
}

// 设置分区首帧：loading 中（state 为 null）—— 这条路径最容易抛。
// 每次从干净状态起渲：槽位按组件实例分配，所以清空 store 就等于「首次挂载」。
hookStore.clear()
effects.length = 0
const firstFrame = render(createElement(sectionMeta.component, {}))
console.log('    TRACE =', JSON.stringify(globalThis.__trace.slice(0, 30)))
console.log('[7] first frame length =', firstFrame.length)
const pendingEffects = effects.splice(0)

// 跑一遍 effect 拿数据，再渲第二帧。setState 之后要重渲，所以这里直接把
// hook 槽里的 state 摆成「已加载」，比模拟 setState 的批处理更直白。
await Promise.all(pendingEffects.map((fn) => fn()))
const sectionHooks = hooksByName('CheckinHubSection')
if (sectionHooks === undefined) throw new Error('CheckinHubSection was never rendered')
// CheckinHubSection 的第一个 useState 就是页面状态（state / loadError / busy…），
// 第二个是错误信息。把状态摆成「已加载」再渲第二帧，验证的是**有数据时**能
// 渲染出内容——只测 loading 态的 67 字符空壳，证明不了什么。
sectionHooks.slots[0] = {
  ok: true,
  at: new Date().toISOString(),
  allowClaim: false,
  platforms: settingsDoc.platforms,
  credentials: [],
  logins: {},
  balances: [],
  models: { providers: [], routes: [] },
  modelsProviders: [],
  lastRun: null,
  running: false,
  lastRunError: null,
  willClaim: false,
  dashboardUrl: '/dsh-agent-checkin',
}
sectionHooks.slots[1] = null
effects.length = 0
const secondFrame = render(createElement(sectionMeta.component, {}))
if (process.env.DUMP_FRAME) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.DUMP_FRAME, secondFrame)
}
if (secondFrame.length <= firstFrame.length) {
  console.log('FRAME >>>', secondFrame.slice(0, 2000))
  throw new Error('settings section must render more once state is loaded')
}
console.log('[8] second frame length =', secondFrame.length, 'OK, settings section rendered with data')
console.log('[9] fetch calls =', JSON.stringify(calls))

// ---- 输入框徽标：认得 workbuddy 时渲染，认得别的时不出 ----
const gateMeta = byName('conversation.input.left')[0]
hookStore.clear()
effects.length = 0
const withWorkbuddy = render(createElement(gateMeta.component, {
  useProjection: () => ({ next: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }),
}))
const gateEffects = effects.splice(0)
await Promise.all(gateEffects.map((fn) => fn()))
// 把徽标组件槽里的 credits 设成 settingsDoc 里的 workbuddy 余额
const badgeHooks = hooksByName('UsageCreditsBadge')
if (badgeHooks === undefined) throw new Error('UsageCreditsBadge was never rendered')
badgeHooks.slots[0] = { balance: 128, source: 'measured', unit: '积分' }
badgeHooks.slots[1] = false
effects.length = 0
const workbuddyFrame = render(createElement(gateMeta.component, {
  useProjection: () => ({ next: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }),
}))
console.log('[10] gate(workbuddy) empty-before-fetch =', withWorkbuddy === '', '/ after-fetch =', workbuddyFrame)
if (!workbuddyFrame.includes('128')) throw new Error('badge should show the measured balance 128, got: ' + workbuddyFrame)

hookStore.clear()
effects.length = 0
const withZai = render(createElement(gateMeta.component, {
  useProjection: () => ({ next: { provider: 'zai', model: 'glm-4.6' } }),
}))
if (withZai !== '') throw new Error('gate must render nothing for an unknown provider, got: ' + withZai)
if (effects.length !== 0) throw new Error('gate must not start polling for an unknown provider')
const withNothing = render(createElement(gateMeta.component, {}))
if (withNothing !== '') throw new Error('gate must render nothing without useProjection')
console.log('[11] gate(zai) / gate(no projection) both empty and start no polling — OK')

console.log('\nALL CLIENT SMOKE CHECKS PASSED')
