/**
 * 模型接入的「选择中心」——平台开关 + 每平台的模型勾选。
 *
 * 背景与动机（为什么这个文件存在）：
 *   dsh-agent-checkin 的三个客户端模型接入（TRAE / Qoder / WorkBuddy）原本由
 *   cordis.patch.yml 里的装配期布尔字段（traeProvider 等） gating。装配期字段的
 *   修改需要重启宿主才成立，用户于是只能在"重启一次"和"不接入了"之间二选一。
 *   需求（面板/看板上可视化地选平台、选模型，且**立即生效**）和这个机制天然冲突：
 *   一个从未注册过的 provider 无法凭空出现在模型选择器里，注册这件事只能发生在
 *   激活期。
 *
 * 解法（本模块的职责边界）：
 *   1. 注册（装配期）：三个平台只要有本机登录态就一律注册，不再看那些布尔字段。
 *      没有登录态的平台本来就会跳过注册（startRegion 的既有语义），行为不变。
 *   2. 可见性/可用性（运行期）：注册成功的 provider 是否出现在模型选择器、出
 *      现哪几个模型，全部由本模块持有的选择状态决定。选择状态的读取发生在每次
 *      构建模型清单和每次目录发现时（live 闭包），所以面板上改一下、下一毫秒
 *      选择器就是新的——不需要重启。
 *   3. 持久化：选择状态落在 `<dshHome>/dsh-agent-checkin/model-selection.json`（原子
 *      写入），进程重启后依然成立。历史遗留的装配期布尔字段只在选择文件**尚不
 *      存在**时作为首启种子迁移一次，之后它们不再是权威。
 *
 * 状态形状（version 1）：
 *   {
 *     "version": 1,
 *     "providers": {
 *       "trae":         { "enabled": true,  "modelIds": null, "imageIds": null },
 *       "trae-global":  { "enabled": false, "modelIds": null, "imageIds": null },
 *       "qoder-cn":     { "enabled": true,  "modelIds": ["QoderModelGLM"], "imageIds": [] },
 *       "workbuddy":    { "enabled": true,  "modelIds": null, "imageIds": ["deepseek-v4.1-flash"] },
 *       "workbuddy-global": { "enabled": true, "modelIds": ["gpt-5.2"] }
 *     }
 *   }
 *   `modelIds: null` 表示「全选（跟随客户端清单）」，`[]` 表示「一个都不显示」。
 *
 * @module dsh-agent-checkin/connect/selection
 */

import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** 选择文件格式版本；结构不兼容时整体作废回落种子（与 lib/state.js 同纪律）。 */
export const SELECTION_FORMAT_VERSION = 1

/**
 * 本插件管辖的全部 provider 路由。
 *
 * 注意 `qoder`（国际区）虽然存在，但装配期一直默认关闭（Qoder 只在客户端里
 * 遇到过 CN 版），这里仍列出来——选择页面对它显示「未接入」，未来接入时无需
 * 改页面。id 与各激活器导出的常量逐字一致：
 * TRAE_PROVIDERS（trae/index.js:82 附近）、REGIONS（qoder/credentials.js:50）、
 * WORKBUDDY_PROVIDERS（workbuddy/index.js:48）。
 */
export const SELECTION_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'trae', platform: 'TRAE', label: 'TRAE CN（本机客户端）' }),
  Object.freeze({ id: 'trae-global', platform: 'TRAE', label: 'TRAE Global（国际版客户端）' }),
  Object.freeze({ id: 'qoder-cn', platform: 'Qoder', label: 'Qoder CN（本机客户端）' }),
  // 2026-10-22 决策：`workbuddy`（国内版）模型接入停用，只保留签到。
  // 不在此列出 → 「模型接入」页不显示、也无法开启；CN 签到照常在签到看板。
  // 要恢复：把下面这行解注，同时恢复 workbuddy/index.js 的 'cn' region。
  // Object.freeze({ id: 'workbuddy', platform: 'WorkBuddy', label: 'WorkBuddy（本机客户端）' }),
  Object.freeze({ id: 'workbuddy-global', platform: 'WorkBuddy', label: 'WorkBuddy Global（国际版客户端）' }),
  Object.freeze({ id: 'dumate', platform: 'DuMate', label: 'DuMate（百度搭子，本机客户端）' }),
  Object.freeze({ id: 'lingxi', platform: 'Lingxi', label: '灵犀（WPS Lingxi，云端 API）' }),
])

/**
 * 归一一个 id 清单：非数组 → null（= 三态里的「跟随默认」），数组 → 去重去空。
 * `imageIds` 与 `modelIds` 共用这段，保证两个清单的容错口径完全一致。
 */
function normalizeIdList(value) {
  if (!Array.isArray(value)) return null
  const seen = new Set()
  return value.filter((id) => typeof id === 'string' && id.length > 0 && !seen.has(id) && seen.add(id))
}

/** 单个 provider 的选择条目：enabled 开关 + modelIds 白名单 + imageIds 图片开关。 */
export function normalizeEntry(raw) {
  const entry = { enabled: false, modelIds: null, imageIds: null }
  if (raw === null || typeof raw !== 'object') return entry
  entry.enabled = raw.enabled === true
  entry.modelIds = normalizeIdList(raw.modelIds)
  entry.imageIds = normalizeIdList(raw.imageIds)
  return entry
}

/**
 * 图片开关 → 判定用的集合。
 *
 * @returns {null | Set<string>} `null` = 跟随模型原生能力（不覆盖）；否则是白名单集合，
 *   空集合表示「全部禁止图片」。
 */
export function imageIdSet(entry) {
  const list = entry?.imageIds
  return Array.isArray(list) ? new Set(list) : null
}

/**
 * 某个模型最终是否接受图片输入。
 *
 * @param {null | Set<string>} images {@link imageIdSet} 的结果
 * @param {string} modelId 模型 id
 * @param {boolean} nativeAllows 目录/客户端自己声明的原生图片能力
 * @returns {boolean}
 */
export function imageAccepted(images, modelId, nativeAllows) {
  return images === null ? nativeAllows === true : images.has(modelId)
}

/**
 * 把图片选择盖到一份模型清单上（激活器构建清单时的统一入口）。
 *
 * `imageIds: null` 时**原样返回**（不碰目录自己的 multimodal 声明，行为与引入本功能
 * 之前逐字一致）；显式清单时按 id 重写 `multimodal` 字段——三个平台的 `toPiModel`
 * 都只看这一个布尔，所以覆盖点只此一处，不必改各自的转换函数。
 *
 * @template T
 * @param {T[]} models 目录条目（必须带 `id`，可带 `multimodal`）
 * @param {{imageIds?: string[]|null}} entry 选择条目（直接用 `hub.get()` 的返回值即可）
 * @returns {T[]}
 */
export function applyImageSelection(models, entry) {
  const images = imageIdSet(entry)
  if (images === null) return models
  return models.map((model) => (model !== null && typeof model === 'object'
    ? { ...model, multimodal: images.has(model.id) }
    : model))
}

/**
 * 归一化整份选择状态。
 *
 * @param {unknown} raw 磁盘上读到的任意值（损坏/异构时逐字段回落）
 * @param {Record<string, {enabled:boolean, modelIds?:string[]|null}>} [seed]
 *   首启种子：文件不存在时用它初始化（历史装配期布尔字段的迁移入口）。
 * @returns {{ version: number, providers: Record<string, {enabled: boolean, modelIds: string[]|null}> }}
 */
export function normalizeStore(raw, seed) {
  const providers = Object.create(null)
  for (const { id } of SELECTION_PROVIDERS) {
    providers[id] = normalizeEntry(seed?.[id])
  }
  if (raw !== null && typeof raw === 'object' && raw.providers !== null && typeof raw.providers === 'object') {
    for (const [id, value] of Object.entries(raw.providers)) {
      providers[id] = normalizeEntry(value)
    }
  }
  return { version: SELECTION_FORMAT_VERSION, providers }
}

/**
 * 过滤一个平台的模型清单（纯函数，激活器在构建模型清单时调用）。
 *
 * 语义：
 *   - `enabled: false` → 返回空数组（模型组整体隐藏）；
 *   - `modelIds: null` → 原样返回（全选，跟随客户端清单）；
 *   - `modelIds: [...]` → 只保留 id 命中的条目（按条目的 `id` 字段）。
 *
 * @template T
 * @param {T[]} models 激活器目录里的原始条目（形状不限，但必须有 `id`）
 * @param {{enabled: boolean, modelIds: string[]|null}} entry 选择条目
 * @returns {T[]}
 */
export function applySelectionFilter(models, entry) {
  if (!Array.isArray(models)) return []
  if (!entry || entry.enabled !== true) return []
  if (!Array.isArray(entry.modelIds)) return models
  const wanted = new Set(entry.modelIds)
  return models.filter((model) => model !== null && typeof model === 'object' && wanted.has(model.id))
}

/**
 * 解析看板「模型接入」页 POST 回来的表单，得到选择中心的更新。
 *
 * 表单字段命名（forms 是普通 HTML，没有 JS 也能工作）：
 *   - `enabled:<providerId>`  —— 勾选 = 该平台接入启用；
 *   - `all:<providerId>`      —— 勾选 = 全选（modelIds 存 null，跟随客户端清单）；
 *   - `model:<providerId>`    —— 多值复选，value 是模型 id；
 *   - `imagesset:<providerId>`—— 隐藏标记：这个平台的表单带图片字段（老页面没有它）；
 *   - `imageauto:<providerId>`—— 勾选 = 图片跟随模型原生能力（imageIds 存 null）；
 *   - `image:<providerId>`    —— 多值复选，value 是允许收图片的模型 id（白名单）。
 *
 * 图片字段的三种写法与三态一一对应：有 `imageauto:<pid>` → null（跟随原生）；
 * 没有 `imageauto` 但表单带 `imagesset` → 收集 `image:` 多值（一个都没有 = 空数组，
 * 表示「全部禁止图片」——这与「没设置过」是两件事，不能合并）；整组字段都不存在
 * （老页面/第三方调用方）→ `imageIds` 不出现在更新里，保持磁盘上的现值。
 *
 * 只有「可选写的行」（selectable，即该平台已注册且模型清单可读）才采纳；其余
 * 平台保持现状——为读不到清单的平台保存一串勾选没有意义，还会把过期 id 存进
 * 选择文件。勾选的 id 与行内现存清单求交，目录已刷新掉的下线模型不会残留。
 *
 * @param {URLSearchParams|Map<string,string>} params 表单（checkbox 同名多值）
 * @param {Array<{id: string, selectable: boolean, enabled: boolean, models: Array<{id: string}>}>} rows
 *   与页面渲染同一来源的行（看板在 POST 时现取，保证清单新鲜）。
 * @returns {Record<string, {enabled?: boolean, modelIds?: string[]|null, imageIds?: string[]|null}>}
 */
export function parseSelectionForm(params, rows) {
  const has = (name) => params != null && typeof params.has === 'function' && params.has(name)
  const getAll = (name) => (params != null && typeof params.getAll === 'function' ? params.getAll(name) : [])
  const updates = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    // 只认行内已知的 provider id：既过滤掉畸形 id，也避免 `__proto__` 这类键污染原型。
    if (!row || typeof row.id !== 'string' || row.id.length === 0 || row.selectable !== true) continue
    if (row.id === '__proto__' || row.id === 'constructor' || row.id === 'prototype') continue
    const listed = new Set((Array.isArray(row.models) ? row.models : []).map((m) => m.id))
    /** @type {string[]|null|undefined} undefined = 本次表单没带图片字段，不动。 */
    let imageIds
    if (has(`imagesset:${row.id}`)) {
      imageIds = has(`imageauto:${row.id}`)
        ? null
        : getAll(`image:${row.id}`).filter((id) => typeof id === 'string' && listed.has(id))
    }
    const imagePart = imageIds === undefined ? {} : { imageIds }
    const enabled = has(`enabled:${row.id}`)
    if (!enabled) {
      updates[row.id] = { enabled: false, ...imagePart }
      continue
    }
    if (has(`all:${row.id}`)) {
      updates[row.id] = { enabled: true, modelIds: null, ...imagePart }
      continue
    }
    const picked = getAll(`model:${row.id}`).filter((id) => typeof id === 'string' && listed.has(id))
    updates[row.id] = { enabled: true, modelIds: picked, ...imagePart }
  }
  return updates
}

/**
 * 创建选择中心（每插件激活一份，不跨进程共享）。
 *
 * @param {object} options
 * @param {() => string} options.filePath 惰性给出选择文件绝对路径（stateDir 在
 *   激活早期可能还没就绪，所以存函数，用到时才求值）。
 * @param {() => Record<string, {enabled: boolean}>} [options.seed] 首启种子的
 *   惰性来源（历史装配期布尔字段 → enabled 布尔）。只在文件不存在时读一次。
 * @param {(message: string) => void} [options.onWarn] 持久化失败等非致命告警。
 * @returns 选择中心句柄
 */
export function createSelectionHub({ filePath, seed, onWarn }) {
  const warn = (message) => {
    try {
      onWarn?.(message)
    } catch {
      // 告警通道自身炸掉不能牵连主流程。
    }
  }

  /** @type {null | {version: number, providers: Record<string, {enabled: boolean, modelIds: string[]|null}>}} */
  let store = null
  /** 文件是否已经读过（含「读不到」）。种子只应用一次，之后以文件为准。 */
  let loaded = false
  /** @type {Set<(changedIds: string[]) => void>} */
  const subscribers = new Set()
  /**
   * 已注册平台的活目录登记：`listAll()` 返回**未筛**的可展示清单（id+name，
   * 可选 multiplier = 该模型相对基础价/基础积分的倍率），`status()` 返回页面
   * 状态文案。只有注册成功（shim 起来 + provider 注册通过）的平台才会登记。
   *
   * `multiplier` 只用客户端自己给出的数字：WorkBuddy 的 `creditMultiplier`、
   * Qoder 的 `priceFactor`、TRAE 的 `features.consumption_rate.data.rate`
   * （活动价 `activity_discount.data.current.consumption_rate` 优先）。
   * 谁没给就不编一个——页面上那一行宁可空着，也不给用户一个看起来像事实的猜测值。
   * `nativeImage` 是平台自己声明的原生图片能力（TRAE/目录 `multimodal`、WorkBuddy
   * `imageDefaultFor`、Qoder `isVL`）：页面用它写 tooltip、判断「默认该不该勾」，
   * 也让 `imageIds: null`（跟随原生）这一档能如实画出来。
   * @type {Map<string, {label: string, platform: string, listAll: () => Array<{id: string, name: string, multiplier?: number, nativeImage?: boolean}>, status?: () => {text?: string}}|undefined>}
   */
  const attached = new Map()

  const readStore = () => {
    if (loaded) return store
    loaded = true
    let raw
    try {
      raw = JSON.parse(readFileSync(filePath(), 'utf8'))
    } catch {
      // 不存在或读不动：按首启种子初始化。种子本身可能抛（readConfig 在宿主
      // 早期未必就绪）——种子失败等价于「全部默认关」。
      let seedEntries
      try {
        const fromConfig = seed?.()
        seedEntries = fromConfig && typeof fromConfig === 'object' ? fromConfig : undefined
      } catch (error) {
        warn(`模型选择首启种子读取失败（按全部未启用处理）：${error?.message ?? error}`)
        seedEntries = undefined
      }
      store = normalizeStore(undefined, seedEntries)
      return store
    }
    if (raw?.version !== SELECTION_FORMAT_VERSION) {
      // 版本不符：整份作废回落种子，下一次保存会覆盖成新格式。
      warn('模型选择文件版本不符，已回落到首启种子（旧文件会被下一次保存覆盖）')
      let seedEntries
      try {
        const fromConfig = seed?.()
        seedEntries = fromConfig && typeof fromConfig === 'object' ? fromConfig : undefined
      } catch {
        seedEntries = undefined
      }
      store = normalizeStore(undefined, seedEntries)
      return store
    }
    store = normalizeStore(raw)
    return store
  }

  /** 原子落盘：tmp + rename，失败只报警不抛（内存态仍是权威）。 */
  const persist = () => {
    const path = filePath()
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...store }, null, 2), 'utf8')
      renameSync(tmp, path)
      return true
    } catch (error) {
      warn(`模型选择保存失败（本次运行内存态仍生效，重启后可能复原）：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 读一个平台的选择（未知 id 默认「启用且不筛」——未知 id 只可能来自未来
   * 新增的 provider，让它默认可见再由用户关，比静默隐藏诚实）。
   */
  const get = (id) => {
    const entry = readStore().providers[id] ?? normalizeEntry({ enabled: true })
    return { enabled: entry.enabled, modelIds: entry.modelIds, imageIds: entry.imageIds }
  }

  /**
   * 应用选择过滤（激活器构建模型清单/目录发现时的统一入口）。
   * models 为空/undefined 时原样兜底，保证注册成功但清单未就绪时行为不变。
   */
  const filter = (id, models) => applySelectionFilter(Array.isArray(models) ? models : [], get(id))

  /** 变更若干平台的选择；返回实际发生变化的 provider id 列表。 */
  const update = (entries) => {
    const data = readStore()
    const changed = []
    if (entries === null || typeof entries !== 'object') return changed
    for (const [id, patch] of Object.entries(entries)) {
      if (patch === null || typeof patch !== 'object') continue
      const next = { ...get(id) }
      if (typeof patch.enabled === 'boolean' && patch.enabled !== next.enabled) next.enabled = patch.enabled
      if ('modelIds' in patch) {
        const normalized = normalizeEntry({ modelIds: patch.modelIds, enabled: next.enabled })
        if (JSON.stringify(normalized.modelIds) !== JSON.stringify(next.modelIds)) next.modelIds = normalized.modelIds
      }
      if ('imageIds' in patch) {
        const normalized = normalizeEntry({ imageIds: patch.imageIds, enabled: next.enabled })
        if (JSON.stringify(normalized.imageIds) !== JSON.stringify(next.imageIds)) next.imageIds = normalized.imageIds
      }
      const baseline = data.providers[id]
      const differs =
        baseline === undefined ||
        baseline.enabled !== next.enabled ||
        JSON.stringify(baseline.modelIds) !== JSON.stringify(next.modelIds) ||
        JSON.stringify(baseline.imageIds) !== JSON.stringify(next.imageIds)
      if (differs) {
        data.providers[id] = next
        changed.push(id)
      }
    }
    if (changed.length > 0) persist()
    if (changed.length > 0) notify(changed)
    return changed
  }

  /** 订阅变更（index.js 用它把 llm/adapters-updated 转发出去）；返回退订函数。 */
  const subscribe = (fn) => {
    if (typeof fn !== 'function') return () => {}
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  const notify = (changedIds) => {
    for (const fn of subscribers) {
      try {
        fn(changedIds)
      } catch {
        // 单个订阅者失败不拦其它人，也不改变「保存已生效」的事实。
      }
    }
  }

  /** 登记一个已注册平台的活目录（重复登记覆盖旧的——幂等）。 */
  const attach = (id, entry) => {
    if (typeof id !== 'string' || entry === null || typeof entry !== 'object') return
    if (typeof entry.listAll !== 'function') return
    attached.set(id, {
      label: typeof entry.label === 'string' ? entry.label : id,
      platform: typeof entry.platform === 'string' ? entry.platform : id,
      listAll: entry.listAll,
      status: typeof entry.status === 'function' ? entry.status : undefined,
    })
  }

  const detach = (id) => attached.delete(id)

  /**
   * 看板数据视图：SELECTION_PROVIDERS 全量 + 任何额外登记的 id。
   * listAll()/status() 抛错按「这条暂时读不到」处理，绝不让整个页面渲染失败。
   */
  const describeAll = () => {
    const data = readStore()
    const known = SELECTION_PROVIDERS.map(({ id, platform, label }) => ({ id, platform, label }))
    for (const id of attached.keys()) {
      if (!known.some((row) => row.id === id)) {
        const entry = attached.get(id)
        known.push({ id, platform: entry.platform ?? id, label: entry.label ?? id })
      }
    }
    return known.map((row) => {
      const live = attached.get(row.id)
      const entry = data.providers[row.id]
      // 图片三态：`null` = 跟随原生能力，`[]` = 全禁止，`[...]` = 白名单。
      // 页面要能画出「当前生效」的勾选状态，所以每行模型都给 image（生效值）
      // 与 nativeImage（平台自己声明的原生能力，用来写 tooltip 与做默认值）。
      const images = Array.isArray(entry?.imageIds) ? new Set(entry.imageIds) : null
      let models = []
      let statusText
      if (live) {
        try {
          models = live.listAll().map((model) => {
            const nativeImage = model.nativeImage === true
            const row = {
              id: model.id,
              name: model.name,
              nativeImage,
              image: images === null ? nativeImage : images.has(model.id),
            }
            // 只透传真数字：NaN/字符串/负值一律当成「这个平台没给倍率」。
            if (typeof model.multiplier === 'number' && Number.isFinite(model.multiplier) && model.multiplier >= 0) {
              row.multiplier = model.multiplier
            }
            return row
          })
        } catch (error) {
          statusText = `清单读取失败：${error?.message ?? error}`
          models = []
        }
        if (statusText === undefined) {
          try {
            statusText = live.status?.()?.text
          } catch {
            // 状态读不到不算事，页面会用默认文案。
          }
        }
      }
      return {
        id: row.id,
        platform: row.platform,
        label: row.label ?? row.id,
        attached: live !== undefined,
        selectable: live !== undefined,
        enabled: entry?.enabled === true,
        modelIds: entry?.modelIds ?? null,
        imageIds: entry?.imageIds ?? null,
        models,
        statusText,
      }
    })
  }

  return { get, filter, update, subscribe, attach, detach, describeAll }
}

/** 默认选择文件的落点：`<dshHome>/dsh-agent-checkin/model-selection.json`。 */
export function selectionFilePath(dshHome, basename = 'model-selection.json') {
  return join(dshHome ?? '.', 'dsh-agent-checkin', basename)
}

// writeFileSync/renameSync 上面的 persist 用；escapeHtml 等 DOM 工具不在这里。
