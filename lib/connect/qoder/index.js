/**
 * Qoder 接入的组装与注册层（M2：默认只开国内区 `qoder-cn`，国际区 `qoder`
 * 代码保留、由 `intlEnabled` 开关控制，默认关）。
 *
 * 注册序列逐行对齐 dsh-connect-qoder@0.2.0 lib/index.js:441-530 + :680-688
 * （MIT License）：
 *
 *   1. 按开关选出要启动的 region（enabled→qoder-cn，intlEnabled→qoder；
 *      都关 → { ok:false, reason:'disabled' }）；
 *   2. 逐 region startRegion：解析凭据（app 登录态每请求重读磁盘 > env PAT
 *      经 exchangePat 兑换后按 expiresAt 复用）、起 loopback shim；无凭据的
 *      region 记 info 跳过，绝不在选择器里放一条必死的路由；
 *   3. 一个共享 adapter（createShimAdapter）覆盖所有已启动 region；
 *   4. registerProviderGroup；失败 → 关掉所有 shim、ok:false 返回，不抛出；
 *   5. registerModelDiscovery：request.provider 命中 region 时回当前目录的
 *      [{ id, name, input }]，不认识回 []；
 *   6. ctx.effect(() => dispose)：release + clearInterval + 关 shim；
 *   7. 目录刷新不阻塞注册（空目录 = 模型组隐藏），30min TTL 定时续。
 *
 * 与 ref 的两处刻意偏差：
 *
 *   - **目录缓存路径注入**。ref 从 '@deepseek-ai/dsh-home-paths' 静态 import
 *     resolveDshHome；该包只在宿主内可解析，单跑 node 必炸。这里改为
 *     `options.dshHome` 优先 → 动态 import → `DSH_HOME || ~/.dsh` 回退。
 *   - **设置面板 v1 不暴露**。useMaximumContextWindow / imageOverrides /
 *     enabledModelIds 固定为（false, 'auto', [] 无过滤），但 preferences
 *     holder 结构保留，adapter 与 shim 每次构建时重读，以后接设置零改动。
 *
 * usage 读取（readUsage/fetchUsage）保留在 runtime 与 upstream.js 导出，
 * v1 不挂 web 路由（后续整合进既有面板）。
 *
 * @module dsh-agent-checkin/connect/qoder
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createShimAdapter, hostAttachmentResolvers } from '../baseadapter.js'
import { registerProviderGroup, registerModelDiscovery } from '../registry.js'
import { loadPiDeps } from '../pi-deps.js'
import { REGIONS, loadCredential, loadEnvCredential } from './credentials.js'
import { exchangePat, fetchModels, fetchUsage } from './upstream.js'
import { createQoderShim } from './shim.js'
import { filterByEnabled, toPiModel, displayNameFor } from './models.js'

/** How long a fetched catalog stays fresh before it is refetched. */
const CATALOG_TTL_MS = 30 * 60 * 1000

/** On-disk format this reader accepts; other versions are discarded. */
const CATALOG_FORMAT_VERSION = 1

/**
 * Resolve where the per-region catalog cache lives.
 *
 * 宿主内走 '@deepseek-ai/dsh-home-paths'（peer 依赖，单跑 node 解析不到，
 * 所以只能动态 import）；单测经 `options.dshHome` 注入；都缺省时退回
 * `DSH_HOME || ~/.dsh`，保证任何环境可跑。
 */
async function resolveDshHomeRoot(injected) {
  if (typeof injected === 'string' && injected.length > 0) return injected
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    if (typeof mod?.resolveDshHome === 'function') return mod.resolveDshHome()
  } catch {
    // 不在宿主内：走环境变量与默认目录。
  }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * The last catalog that actually loaded, per region.
 *
 * A restart must not drop the user to an empty model group when a good catalog
 * was fetched minutes earlier, and a temporary upstream failure must not either.
 * Only model metadata is stored — never a token.
 */
class CatalogStore {
  constructor(region, dshHome, logger) {
    this.path = join(dshHome, `.qoder-catalog.${region.id}.json`)
    this.logger = logger
    this.entries = []
    this.fetchedAt = 0
    this.load()
  }

  load() {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.version !== CATALOG_FORMAT_VERSION) return
      if (!Array.isArray(parsed.entries)) return
      this.entries = parsed.entries
      this.fetchedAt = Number(parsed.fetchedAt) || 0
    } catch {
      // A damaged cache is simply ignored; the next fetch replaces it.
    }
  }

  save() {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      writeFileSync(
        this.path,
        JSON.stringify({ version: CATALOG_FORMAT_VERSION, fetchedAt: this.fetchedAt, entries: this.entries }, null, 2),
        'utf8',
      )
    } catch (error) {
      this.logger?.warn?.(`dsh-agent-checkin: qoder 目录缓存写入失败 ${this.path}`, error)
    }
  }

  current() {
    return this.entries
  }

  fresh() {
    return Date.now() - this.fetchedAt < CATALOG_TTL_MS
  }

  replace(entries) {
    this.entries = entries
    this.fetchedAt = Date.now()
    this.save()
  }
}

/**
 * A model id is the catalog display name with whitespace removed, so the id is
 * stable and readable; the upstream key is tracked beside it for the wire.
 */
function modelIdFor(entry) {
  return (entry.display_name || 'QoderModel').replace(/\s+/g, '')
}

/**
 * Reshape one entry from {@link fetchModels} for storage and lookup.
 *
 * The catalog interpretation (vision, reasoning, effort support, and the
 * always-thinking rule) already happened in `fetchModels`, so this only adds
 * the user-facing id.
 */
function normalizeEntry(entry) {
  return {
    id: modelIdFor({ display_name: entry.name }),
    key: entry.key,
    name: entry.name,
    isVL: entry.isVL === true,
    isReasoning: entry.isReasoning === true,
    supportsEffort: entry.supportsEffort === true,
    alwaysThinking: entry.alwaysThinking === true,
    effortLevels: Array.isArray(entry.effortLevels) ? entry.effortLevels : [],
    maxInputTokens: entry.maxInputTokens ?? 0,
    // `toPiModel` sizes each model from these two, so dropping them here (which
    // is what happened before) made `useMaximumContextWindow` do nothing at all:
    // with no `contextOptions` the "widest offered window" is 0, the switch has
    // nothing to prefer, and every model falls back to `max_input_tokens` — a
    // smaller per-request floor, not the capacity the catalog advertises. They
    // are carried through verbatim so the setting and the picker agree.
    defaultContextWindow: entry.defaultContextWindow ?? 0,
    contextOptions: Array.isArray(entry.contextOptions) ? entry.contextOptions : [],
    // The credit multiplier Qoder charges for this model. It is display-only,
    // but the picker shows it beside the name so the cost of a choice is visible
    // before the request is sent. `toPiModel` is what formats it.
    priceFactor: Number(entry.priceFactor) || 0,
  }
}

/**
 * Owns one region: its credential, catalog, and refresh lifecycle.
 *
 * 凭据与目录逻辑逐字对齐 ref 的 RegionRuntime；usage 读取（readUsage）保留，
 * v1 只是不挂路由。
 */
class RegionRuntime {
  constructor(region, { logger, dshHome, loaders }) {
    this.region = region
    this.logger = logger
    this.catalog = new CatalogStore(region, dshHome, logger)
    this.loaders = loaders
    this.credential = undefined
    this.exchanged = undefined
    this.refreshTimer = undefined
    /** Last usage reading and when it was taken; see {@link RegionRuntime.readUsage}. */
    this.usage = undefined
    this.usageAt = 0
  }

  /**
   * Resolve the current credential, exchanging a PAT when that is the source.
   *
   * The Qoder app owns the token's lifecycle and refreshes it in its own
   * store, so an expired token is re-read from disk rather than cached — a
   * user who reopened the app is picked up on the next request, with no
   * restart. A PAT, by contrast, is exchanged once and then reused until its
   * own expiry.
   */
  async resolveCredential() {
    if (this.exchanged !== undefined) {
      if (this.exchanged.source === 'env-pat' && this.exchanged.expiresAt > Date.now()) return this.exchanged
      if (this.exchanged.source !== 'env-pat' && !this.exchanged.expired) return this.exchanged
    }
    const fromApp = this.loaders.loadCredential(this.region, process.env.APPDATA ?? '')
    const credential = fromApp ?? this.loaders.loadEnvCredential(this.region)
    this.credential = credential
    if (credential === undefined) {
      this.exchanged = undefined
      return undefined
    }
    if (credential.source === 'env-pat') {
      const exchanged = await exchangePat(this.region, credential.token)
      this.exchanged = {
        ...credential,
        token: exchanged.token,
        refreshToken: exchanged.refreshToken,
        expiresAt: exchanged.expiresAt,
      }
      return this.exchanged
    }
    this.exchanged = credential
    return credential
  }

  /** Refresh the model catalog from upstream, keeping the last good one on failure. */
  async refreshCatalog(force = false) {
    if (!force && this.catalog.fresh()) return
    let credential
    try {
      credential = await this.resolveCredential()
    } catch (error) {
      this.logger?.warn?.(`dsh-agent-checkin: qoder ${this.region.displayName} 凭据解析失败`, error)
      return
    }
    if (credential === undefined) return
    try {
      const raw = await fetchModels(this.region, credential)
      const entries = raw.map(normalizeEntry)
      if (entries.length > 0) {
        this.catalog.replace(entries)
        this.invalidate?.()
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-agent-checkin: qoder ${this.region.displayName} 目录刷新失败`, error)
    }
  }

  /** Look up the upstream key for a user-facing model id. */
  upstreamKey(modelId) {
    const found = this.catalog.current().find((entry) => entry.id === modelId)
    return found?.key
  }

  /** The catalog entry behind a user-facing model id. */
  entryFor(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId)
  }

  /**
   * Read the account's usage, with a short cache.
   *
   * v1 不挂路由，仅保留给后续面板整合；语义与 ref 一致：失败的读取绝不进
   * 缓存，一次瞬时的上游故障不会把面板钉死在错误态。
   */
  async readUsage(force = false) {
    if (!force && this.usage !== undefined && Date.now() - this.usageAt < 20 * 1000) {
      return this.usage
    }
    const credential = await this.resolveCredential()
    if (credential === undefined) return undefined
    const usage = await fetchUsage(this.region, credential)
    this.usage = usage
    this.usageAt = Date.now()
    return usage
  }
}

/**
 * Start one region's shim and catalog lifecycle.
 *
 * @returns the runtime plus its shim, or `undefined` when the region has no
 *   usable sign-in or the shim could not listen (the region is then simply
 *   absent rather than fatal).
 */
async function startRegion(region, { logger, dshHome, loaders, enabledIdsFor, createShim, selectModels }) {
  const runtime = new RegionRuntime(region, { logger, dshHome, loaders })

  // A region is published only when it can actually answer. Registering a
  // provider whose sign-in is missing or expired puts a dead route in the model
  // picker: selecting it sends a request the gateway answers with 403, which
  // the UI reports as "the provider rejected this request" — blaming the user's
  // account for a channel this plugin should never have offered. Skipping the
  // region leaves the other one working and the picker honest.
  let credential
  try {
    credential = await runtime.resolveCredential()
  } catch (error) {
    logger?.warn?.(`dsh-agent-checkin: qoder ${region.displayName} 登录态不可用，该区域不注册`, error)
    return undefined
  }
  if (credential === undefined) {
    logger?.info?.(`dsh-agent-checkin: qoder ${region.displayName} 本机无登录态，该区域不注册`)
    return undefined
  }
  if (credential.expired === true) {
    logger?.warn?.(
      `dsh-agent-checkin: qoder ${region.displayName} 登录态已过期，该区域不注册` +
        `（打开 ${region.displayName} 客户端续期后重启宿主）`,
    )
    return undefined
  }

  const shim = createShim({
    region,
    resolveCredential: () => runtime.resolveCredential(),
    resolveModels: () => (selectModels ? selectModels(region.id, runtime.catalog.current()) : runtime.catalog.current()),
    resolveUpstreamKey: (id) => runtime.upstreamKey(id),
    resolveAlwaysThinking: (id) => runtime.entryFor(id)?.alwaysThinking === true,
    // Read on every listing so curating the roster reaches the picker live.
    resolveEnabledIds: () => enabledIdsFor(region.id),
    logger,
  })
  try {
    await shim.ready
  } catch (error) {
    logger?.error?.(`dsh-agent-checkin: qoder ${region.displayName} loopback 端点启动失败`, error)
    return undefined
  }
  return { runtime, shim }
}

/** Best-effort close of every started shim; never throws. */
async function closeAllShims(started) {
  for (const { shim } of started) {
    try {
      await shim.close()
    } catch {
      // 尽力关闭：注册失败路径上没有比这更能做的事了。
    }
  }
}

/**
 * Activate the Qoder provider group.
 *
 * @param ctx - the plugin context, with `llm` injected.
 * @param {object} options
 * @param {boolean} options.enabled - 国内区 `qoder-cn` 开关（仅在未提供
 *   `options.selection` 时生效，装配期兼容路径）。
 * @param {boolean} options.intlEnabled - 国际区 `qoder` 开关（默认关；同上）。
 * @param {object} [options.selection] - 选择中心（lib/connect/selection.js）。提供时
 *   平台注册不再看装配期布尔字段：模型是否出现在选择器里由选择中心实时决定，
 *   看板「模型接入」页可开关（免重启）。
 * @param {string} options.settingsNs - registerConfigurableProviders 的命名空间。
 * @param {object} [options.deps] - pi 依赖注入；缺省动态 import 宿主私有模块。
 * @param {object} [options.logger]
 * @param {string} [options.dshHome] - 目录缓存根（测试注入；缺省见
 *   {@link resolveDshHomeRoot}）。
 * @param {Function} [options.loadCredential] - app 登录态读取（测试注入）。
 * @param {Function} [options.loadEnvCredential] - env PAT 读取（测试注入）。
 * @param {Function} [options.createShim] - shim 工厂（测试注入）。
 * @returns `{ ok, reason?, providerIds?, dispose? }`。
 */
export async function activateQoder(ctx, options = {}) {
  const logger = options.logger ?? ctx?.logger
  // 选择模式（options.selection 存在）下 enabled/intlEnabled 让位给选择中心：
  // 平台只要本机有登录态就注册，可见性由看板「模型接入」页实时控制。
  const usingSelection = options.selection !== undefined
  const enabled = usingSelection || options.enabled === true
  const intlEnabled = usingSelection || options.intlEnabled === true
  if (!enabled && !intlEnabled) return { ok: false, reason: 'disabled' }

  const settingsNs = options.settingsNs
  if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
    logger?.warn?.('dsh-agent-checkin: qoder settingsNs 缺失，无法注册 provider 目录')
    return { ok: false, reason: 'settings-ns-missing' }
  }

  const regions = REGIONS.filter((region) => (region.id === 'qoder-cn' ? enabled : intlEnabled))

  // The context-window, image, and roster preferences live in a mutable holder
  // so a future settings section can change them without re-registering the
  // adapter; the adapter re-reads them every time it builds a model list, and
  // the shim re-reads them on every listing. v1 exposes no panel, so the
  // values are the fixed defaults: 不偏好最大窗口、图片随目录、空表不过滤。
  const preferences = { useMaximumContextWindow: false, imageOverrides: {}, enabledModelIds: {} }

  /** The models the user enabled for one region; empty means "no filter". */
  const enabledIdsFor = (regionId) => {
    // 选择中心优先：看板「模型接入」页保存的白名单即时生效（null = 不筛）。
    const selected = usingSelection ? options.selection.get(regionId) : undefined
    if (selected !== undefined) {
      return Array.isArray(selected.modelIds)
        ? selected.modelIds.filter((id) => typeof id === 'string' && id.length > 0)
        : []
    }
    const byRegion = preferences.enabledModelIds
    if (byRegion === null || typeof byRegion !== 'object') return []
    const list = byRegion[regionId]
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id.length > 0) : []
  }

  /** 平台整体开关 + 白名单的一次性应用（adapter 清单与目录发现共用）。 */
  const selectModels = (regionId, entries) =>
    usingSelection ? options.selection.filter(regionId, entries) : entries

  /**
   * 图片开关 → Qoder 的三种模式（'on'/'off'/'auto'）。
   *
   * `toPiModel` 的图片参数是三态字符串，而选择中心存的是 `imageIds: string[]|null`，
   * 这里做唯一一次互译：
   *   - `null`（默认）= 跟随目录 `is_vl` → `'auto'`，行为与引入图片开关前逐字一致；
   *   - 命中白名单 → `'on'`；未命中 → `'off'`。
   * 选择中心优先于 preferences holder（后者是 v1 遗留的固定默认值）。
   */
  const imageModeFor = (regionId, modelId) => {
    if (usingSelection) {
      const selected = options.selection.get(regionId)
      if (Array.isArray(selected?.imageIds)) {
        return selected.imageIds.includes(modelId) ? 'on' : 'off'
      }
      return 'auto'
    }
    const overrides = preferences.imageOverrides
    if (overrides === null || typeof overrides !== 'object') return 'auto'
    const saved = overrides[modelId]
    return saved === 'on' || saved === 'off' ? saved : 'auto'
  }

  /** 某个模型最终是否声明图片输入（adapter 清单与目录发现共用同一判定）。 */
  const imageAllowedFor = (regionId, entry) => {
    const mode = imageModeFor(regionId, entry.id)
    if (mode === 'on') return true
    if (mode === 'off') return false
    return entry.isVL === true
  }

  const dshHome = await resolveDshHomeRoot(options.dshHome)
  const loaders = {
    loadCredential: options.loadCredential ?? loadCredential,
    loadEnvCredential: options.loadEnvCredential ?? loadEnvCredential,
  }
  const createShim = options.createShim ?? createQoderShim

  const started = []
  for (const region of regions) {
    const entry = await startRegion(region, { logger, dshHome, loaders, enabledIdsFor, createShim, selectModels })
    if (entry !== undefined) started.push(entry)
  }
  if (started.length === 0) {
    logger?.info?.('dsh-agent-checkin: qoder 没有可启动的区域（未登录或 shim 不可用）')
    return { ok: false, reason: 'no-credential' }
  }

  let deps = options.deps
  if (deps === undefined) {
    try {
      deps = await loadPiDeps()
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: qoder 宿主 pi 依赖不可用，该平台不注册', error)
      await closeAllShims(started)
      return { ok: false, reason: 'pi-deps-unavailable' }
    }
  }

  let bundle
  try {
    bundle = createShimAdapter({
      deps,
      providers: started.map(({ runtime, shim }) => ({
        id: runtime.region.id,
        displayName: runtime.region.displayName,
        shim,
        buildModels: (baseUrlV1) =>
          selectModels(runtime.region.id, filterByEnabled(runtime.catalog.current(), enabledIdsFor(runtime.region.id))).map(
            (entry) =>
              toPiModel(
                entry,
                baseUrlV1,
                runtime.region.id,
                preferences.useMaximumContextWindow === true,
                imageModeFor(runtime.region.id, entry.id),
              ),
          ),
      })),
      retryNs: 'dsh-agent-checkin.qoder',
      // 带图请求走宿主持久附件服务（对齐宿主自注册 pi-ai 的接法）。
      ...hostAttachmentResolvers(ctx, deps.resolveImageAttachmentAccess),
    })
  } catch (error) {
    logger?.error?.('dsh-agent-checkin: qoder adapter 装配失败', error)
    await closeAllShims(started)
    return { ok: false, reason: 'adapter-failed' }
  }

  for (const { runtime } of started) {
    runtime.invalidate = () => {
      bundle.invalidate()
      ctx?.emit?.('llm/adapters-updated')
    }
  }

  const registration = registerProviderGroup(ctx, {
    adapter: bundle.adapter,
    providers: started.map(({ runtime }) => ({ id: runtime.region.id, displayName: runtime.region.displayName })),
    settingsNs,
    label: 'qoder',
    logger,
  })
  if (!registration.ok) {
    await closeAllShims(started)
    return { ok: false, reason: 'register-failed' }
  }

  // 登记到选择中心：设置页「平台与模型」页签从这里读实时清单（未筛的全集）与状态。
  // 只在 provider 注册成功后登记，保证「已接入」标签指的都是真的可路由。
  for (const { runtime } of started) {
    options.selection?.attach(runtime.region.id, {
      label: runtime.region.displayName,
      platform: 'Qoder',
      listAll: () =>
        runtime.catalog.current().map((entry) => ({
          id: entry.id,
          name: entry.name,
          // 原生图片能力看目录的 is_vl（Qoder 给每个模型都发布了这个标记）。
          nativeImage: entry.isVL === true,
          // Qoder 的倍率来自上游清单的 priceFactor（0 = 免费额度模型）。
          ...(typeof entry.priceFactor === 'number' ? { multiplier: entry.priceFactor } : {}),
        })),
      status: () => ({ text: '已接入' }),
    })
  }

  const releaseDiscovery = registerModelDiscovery(ctx, {
    settingsNs,
    label: 'qoder',
    logger,
    // 选择器渲染的是这里的 `name`（不看 multiplier 字段），所以倍率必须折进
    // 名字里才看得见。`displayNameFor` 与 `toPiModel` 共用同一套格式化：
    // 有倍率显示 `· x0.26`，0 显示 `· 免费`，错峰窗口生效时追加 ` 错峰`。
    discover: async (provider) => {
      const entry = started.find(({ runtime }) => runtime.region.id === provider)
      if (entry === undefined) return []
      const now = new Date()
      return selectModels(provider, filterByEnabled(entry.runtime.catalog.current(), enabledIdsFor(provider))).map(
        (model) => ({
          id: model.id,
          name: displayNameFor(model, now),
          input: imageAllowedFor(provider, model) ? ['text', 'image'] : ['text'],
        }),
      )
    },
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    registration.release?.()
    releaseDiscovery?.()
    for (const { runtime, shim } of started) {
      options.selection?.detach(runtime.region.id)
      if (runtime.refreshTimer !== undefined) clearInterval(runtime.refreshTimer)
      void shim.close()
    }
  }
  ctx?.effect?.(() => dispose)

  // Load credentials and catalogs without blocking activation: the providers
  // are registered either way, and an empty catalog is how DSH hides a model
  // group until a sign-in appears.
  for (const { runtime } of started) {
    void runtime.refreshCatalog(true).then(() => {
      runtime.refreshTimer = setInterval(() => {
        void runtime.refreshCatalog(true)
      }, CATALOG_TTL_MS)
      runtime.refreshTimer.unref?.()
    })
  }

  return { ok: true, providerIds: bundle.providerIds, dispose }
}
