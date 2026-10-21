/**
 * WorkBuddy 接入的组装与注册层（M3 里程碑）。
 *
 * 注册序列逐行对齐 dsh-connect-workbuddy@4.6.5（MIT，Copyright (c) 2026
 * LaoDing）lib/index.js:6300-6405，并套用本仓库 connect/qoder/index.js（M2）
 * 已验证的装配形状：
 *
 *   1. 按开关选出要启动的 region（enabled→'workbuddy'（CN），
 *      intlEnabled→'workbuddy-global'；都关 → { ok:false, reason:'disabled' }）；
 *   2. 逐 region：凭据 store（桌面 App auth 目录只读扫描 + 进程内存刷新
 *      overlay）→ 目录（静态兜底种子 + 磁盘缓存 + 后台刷新）→ loopback shim；
 *      本机无登录态的 region 记 info 跳过，绝不在选择器里放一条必 401 的路由；
 *   3. 一个共享 adapter（createShimAdapter）覆盖所有已启动 region；
 *   4. registerProviderGroup；失败 → 关掉所有 shim、ok:false 返回，不抛出。
 *      **DUPLICATE_ADAPTER 专项**：老插件 dsh-connect-workbuddy 与本插件注册
 *      同名 provider id（'workbuddy' / 'workbuddy-global'），老插件未关闭/
 *      卸载时宿主会拒绝重复注册。此时记 warn 说明缘由、返回
 *      { ok:false, reason:'duplicate-adapter' }——绝不抛出、绝不影响签到与
 *      其它平台；
 *   5. registerModelDiscovery：request.provider 命中 region 时回当前目录的
 *      [{ id, name, input }]，不认识回 []；
 *   6. ctx.effect(() => dispose)：release + clearInterval + 关 shim；
 *   7. 目录刷新不阻塞注册：后台 refresh + setInterval 30min + .unref?.()；
 *      目录为空 = 模型组隐藏。
 *
 * 凭据红线：桌面 App 文件只读；刷新得到的 token 只活在该 store 的进程内存
 * overlay 里，绝不落盘（区别于老插件的 workbuddy-vault）。目录缓存只存模型
 * 元数据，落 DSH home（options.dshHome 优先 → 动态 import
 * '@deepseek-ai/dsh-home-paths' → `DSH_HOME || ~/.dsh`，保证单测可跑）。
 *
 * @module dsh-agent-checkin/connect/workbuddy
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createShimAdapter, hostAttachmentResolvers } from '../baseadapter.js'
import { registerProviderGroup, registerModelDiscovery } from '../registry.js'
import { loadPiDeps, settingsNamespaceOf } from '../pi-deps.js'
import { createWorkBuddyCredentialStore } from './credentials.js'
import { createWorkBuddyCatalog, CATALOG_REFRESH_INTERVAL_MS } from './catalog.js'
import { createWorkBuddyShim } from './shim.js'
import { toPiModel, workBuddyDisplayName, workBuddyModelInput, imageDefaultFor } from './models.js'
import { applyImageSelection } from '../selection.js'

/** Provider route this bundle owns for the CN gateway（老插件原样）. */
export const WORKBUDDY_PROVIDER = 'workbuddy'
/** Provider route this bundle owns for the international gateway（老插件原样）. */
export const WORKBUDDY_GLOBAL_PROVIDER = 'workbuddy-global'
/** The provider id each region registers as（老插件 WORKBUDDY_PROVIDERS 原样）. */
export const WORKBUDDY_PROVIDERS = {
  cn: WORKBUDDY_PROVIDER,
  global: WORKBUDDY_GLOBAL_PROVIDER,
}
/** Region a provider route id belongs to（老插件 regionOfProvider 原样）. */
export function regionOfProvider(provider) {
  for (const [region, id] of Object.entries(WORKBUDDY_PROVIDERS)) if (id === provider) return region
  return undefined
}
/** Human-readable provider name, shown in the DSH model picker（老插件原样）. */
export const WORKBUDDY_PROVIDER_DISPLAY_NAMES = {
  cn: 'WorkBuddy',
  global: 'WorkBuddy Global',
}

/**
 * Resolve where the per-region catalog cache lives.
 *
 * 宿主内走 '@deepseek-ai/dsh-home-paths'（peer 依赖，单跑 node 解析不到，
 * 所以只能动态 import）；单测经 `options.dshHome` 注入；都缺省时退回
 * `DSH_HOME || ~/.dsh`，保证任何环境可跑（与 connect/qoder 同一条链）。
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

/** DUPLICATE_ADAPTER 判定：code 或 message 命中即视为「同名 provider 已被注册」。 */
function isDuplicateAdapterError(error) {
  const haystack = `${String(error?.code ?? '')}\n${String(error?.message ?? error ?? '')}`
  return haystack.includes('DUPLICATE_ADAPTER')
}

/** Best-effort close of every started shim; never throws. */
async function closeAllShims(started) {
  for (const { shim } of started) {
    try {
      await shim.close()
    } catch {
      // 尽力关闭：失败路径上没有比这更能做的事了。
    }
  }
}

/**
 * Start one region: credential store → catalog → loopback shim.
 *
 * @returns the runtime pieces, or `undefined` when the region has no local
 *   sign-in (logged at info, not an error) or its shim could not listen
 *   (logged at error). A skipped region is simply absent, never fatal.
 */
async function startRegion(region, { logger, dshHome, options }) {
  const store =
    options.stores?.[region] ??
    createWorkBuddyCredentialStore({
      region,
      authDirs: options.authDirs,
      desktopPath: options.desktopPath,
      resolveAtRestKey: options.resolveAtRestKey,
      fetchImpl: options.fetchImpl,
    })

  // A region is published only when it can actually answer. Registering a
  // provider whose sign-in is missing puts a dead route in the model picker:
  // selecting it sends a request the gateway answers 401, and the UI reports
  // that as "the provider rejected this request" — blaming the user's account
  // for a channel this plugin should never have offered（老插件 issue #12）.
  let credential
  try {
    credential = await store.current()
  } catch (error) {
    logger?.warn?.(`dsh-agent-checkin: workbuddy ${region} 登录态读取失败，该区域不注册`, error)
    return undefined
  }
  if (credential === undefined) {
    logger?.info?.(`dsh-agent-checkin: workbuddy ${region} 本机无登录态，该区域不注册（签到任务不受影响）`)
    return undefined
  }

  const catalog = createWorkBuddyCatalog({ region, dshHome, logger, fetchImpl: options.fetchImpl })
  await catalog.load()

  const createShim = options.createShim ?? createWorkBuddyShim
  const shim = createShim({
    catalog,
    resolveCredential: () => store.resolve(),
    logger,
    fetchImpl: options.fetchImpl,
  })
  try {
    await shim.ready
  } catch (error) {
    logger?.error?.(`dsh-agent-checkin: workbuddy ${region} loopback 端点启动失败，该区域不注册`, error)
    return undefined
  }
  return { region, store, catalog, shim }
}

/**
 * Activate the WorkBuddy provider group（M3）。
 *
 * @param ctx 宿主插件上下文（需要 `llm` 服务与可选的 `effect`/`emit`/`logger`）
 * @param {object} options
 * @param {boolean} options.enabled CN 区 `workbuddy` 开关（仅在未提供
 *   `options.selection` 时生效，装配期兼容路径）
 * @param {boolean} options.intlEnabled 国际区 `workbuddy-global` 开关（同上）
 * @param {object} [options.selection] 选择中心（lib/connect/selection.js）。提供时
 *   平台注册不再看装配期布尔字段：模型是否出现在选择器里由选择中心实时决定，
 *   看板「模型接入」页可开关（免重启）。
 * @param {string} [options.settingsNs] registerConfigurableProviders 的命名空间；
 *   缺省取 `settingsNamespaceOf(ctx)`
 * @param {object} [options.deps] pi 依赖注入；缺省动态 import 宿主私有模块
 * @param {object} [options.logger]
 * @param {string} [options.dshHome] 目录缓存根（测试注入）
 * @param {typeof fetch} [options.fetchImpl] 上游传输注入（测试）
 * @param {{ cn?: object, global?: object }} [options.stores] 凭据 store 注入（测试）
 * @param {string[]} [options.authDirs] 凭据扫描目录注入（测试）
 * @param {string} [options.desktopPath] 显式 auth 文件（测试）
 * @param {Function} [options.resolveAtRestKey] at-rest 密钥解析注入（测试）
 * @param {Function} [options.createShim] shim 工厂注入（测试）
 * @returns `{ ok, reason?, providerIds?, dispose?, error? }`——任何失败路径
 *   都以返回值呈现，绝不抛出。
 */
export async function activateWorkBuddy(ctx, options = {}) {
  const logger = options.logger ?? ctx?.logger
  // 选择模式（options.selection 存在）下 enabled/intlEnabled 让位给选择中心：
  // 平台只要本机有登录态就注册，可见性由看板「模型接入」页实时控制（免重启）。
  const usingSelection = options.selection !== undefined
  const enabled = usingSelection || options.enabled === true
  const intlEnabled = usingSelection || options.intlEnabled === true
  if (!enabled && !intlEnabled) return { ok: false, reason: 'disabled' }

  const settingsNs = options.settingsNs ?? settingsNamespaceOf(ctx)
  if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
    logger?.warn?.('dsh-agent-checkin: workbuddy settingsNs 缺失，无法注册 provider 目录')
    return { ok: false, reason: 'settings-ns-missing' }
  }

  const regions = [
    ...(enabled ? ['cn'] : []),
    ...(intlEnabled ? ['global'] : []),
  ]
  const dshHome = await resolveDshHomeRoot(options.dshHome)

  /**
   * adapter 清单与目录发现共用的选择入口：平台开关 + 模型勾选，现读现筛；
   * 最后把「图片开关」盖到 `multimodal` 上（`imageIds: null` 时原样返回，
   * 保持目录刷新时 `defaultCatalogStamp` 盖出的原生声明）。
   */
  const regionModels = (region, catalog) => {
    const base = catalog.current()
    if (!usingSelection) return base
    const providerId = WORKBUDDY_PROVIDERS[region]
    const selected = options.selection.filter(providerId, base)
    return applyImageSelection(selected, options.selection.get(providerId))
  }

  const started = []
  for (const region of regions) {
    const entry = await startRegion(region, { logger, dshHome, options })
    if (entry !== undefined) started.push(entry)
  }
  if (started.length === 0) {
    logger?.info?.('dsh-agent-checkin: workbuddy 没有可启动的区域（本机未登录或 shim 不可用），WB 组不注册')
    return { ok: false, reason: 'no-credential' }
  }

  let deps = options.deps
  if (deps === undefined) {
    try {
      deps = await loadPiDeps()
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: workbuddy 宿主 pi 依赖不可用，WB 组不注册（签到与其它平台不受影响）', error)
      await closeAllShims(started)
      return { ok: false, reason: 'pi-deps-unavailable' }
    }
  }

  let bundle
  try {
    bundle = createShimAdapter({
      deps,
      providers: started.map(({ region, catalog, shim }) => ({
        id: WORKBUDDY_PROVIDERS[region],
        displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES[region],
        shim,
        // `toPiModel` 逐字对齐老插件：id 原样透传（deepseek-v4.1-flash），
        // baseUrl 指向本 region 的 loopback shim。
        buildModels: (baseUrlV1) =>
          regionModels(region, catalog).map((info) => toPiModel(info, baseUrlV1, WORKBUDDY_PROVIDERS[region])),
      })),
      retryNs: 'dsh-agent-checkin.workbuddy',
      // 带图请求走宿主持久附件服务（对齐宿主自注册 pi-ai 的接法）；
      // 没有附件服务时 pi-ai 仍会诚实拒绝图片输入。
      ...hostAttachmentResolvers(ctx, deps.resolveImageAttachmentAccess),
    })
  } catch (error) {
    logger?.error?.('dsh-agent-checkin: workbuddy adapter 装配失败', error)
    await closeAllShims(started)
    return { ok: false, reason: 'adapter-failed', error }
  }

  const registration = registerProviderGroup(ctx, {
    adapter: bundle.adapter,
    providers: started.map(({ region }) => ({
      id: WORKBUDDY_PROVIDERS[region],
      displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES[region],
    })),
    settingsNs,
    label: 'workbuddy',
    logger,
  })
  if (!registration.ok) {
    await closeAllShims(started)
    if (isDuplicateAdapterError(registration.error)) {
      logger?.warn?.(
        'dsh-agent-checkin: workbuddy provider 注册冲突（DUPLICATE_ADAPTER）——' +
          '老插件 dsh-connect-workbuddy 未关闭/卸载，本插件 WB 组跳过，签到与其它平台不受影响',
      )
      return { ok: false, reason: 'duplicate-adapter', error: registration.error }
    }
    logger?.warn?.('dsh-agent-checkin: workbuddy provider 注册失败，WB 组不注册', registration.error)
    return { ok: false, reason: 'register-failed', error: registration.error }
  }

  // 登记到选择中心：设置页「平台与模型」页签从这里读实时清单（未筛的全集）与状态。
  // 只在 provider 注册成功后登记，保证「已接入」标签指的都是真的可路由。
  for (const runtime of started) {
    options.selection?.attach(WORKBUDDY_PROVIDERS[runtime.region], {
      label: WORKBUDDY_PROVIDER_DISPLAY_NAMES[runtime.region],
      platform: 'WorkBuddy',
      listAll: () =>
        runtime.catalog.current().map((model) => ({
          id: model.id,
          name: workBuddyDisplayName(model),
          // 原生图片能力 = 老插件那张厂商分类表的判定（supportsImages:false 一票
          // 否决，unknown 一律 false）。目录刷新时 defaultCatalogStamp 也是按这个
          // 表盖的 multimodal，所以它就是「imageIds: null」档的实际默认值。
          nativeImage: imageDefaultFor(model),
          // 倍率直接取客户端清单的 creditMultiplier（0.79 = 打 79 折积分）。
          // 缺字段就不带，页面上那一行留空——不编一个看起来像事实的数。
          ...(typeof model.creditMultiplier === 'number' ? { multiplier: model.creditMultiplier } : {}),
        })),
      status: () => ({ text: `已接入（${runtime.region === 'cn' ? '国内版' : '国际版'}客户端）` }),
    })
  }

  const releaseDiscovery = registerModelDiscovery(ctx, {
    settingsNs,
    label: 'workbuddy',
    logger,
    discover: async (provider) => {
      const region = regionOfProvider(provider ?? '')
      if (region === undefined) return []
      const entry = started.find((candidate) => candidate.region === region)
      if (entry === undefined) return []
      return regionModels(region, entry.catalog).map((model) => ({
        id: model.id,
        name: workBuddyDisplayName(model),
        input: workBuddyModelInput(model),
      }))
    },
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    registration.release?.()
    releaseDiscovery?.()
    for (const runtime of started) {
      options.selection?.detach(WORKBUDDY_PROVIDERS[runtime.region])
      if (runtime.refreshTimer !== undefined) clearInterval(runtime.refreshTimer)
      void runtime.shim.close()
    }
  }
  ctx?.effect?.(() => dispose)

  // 目录刷新不阻塞注册：provider 先以兜底表上线，后台刷新成功后 invalidate
  // 让 adapter 重建 profiles；目录为空 = 模型组隐藏。定时器 30min TTL 续期，
  // unref 绝不拖住宿主退出。
  for (const runtime of started) {
    const refreshOnce = async () => {
      let credential
      try {
        credential = await runtime.store.resolve()
      } catch (error) {
        logger?.warn?.(`dsh-agent-checkin: workbuddy ${runtime.region} 目录刷新前凭据解析失败，保留现有目录`, error)
        return
      }
      const changed = await runtime.catalog.refresh(credential)
      if (changed === true && disposed !== true) {
        bundle.invalidate()
        ctx?.emit?.('llm/adapters-updated')
      }
    }
    void refreshOnce().then(() => {
      if (disposed) return
      runtime.refreshTimer = setInterval(() => {
        void refreshOnce()
      }, CATALOG_REFRESH_INTERVAL_MS)
      runtime.refreshTimer.unref?.()
    })
  }

  return {
    ok: true,
    providerIds: bundle.providerIds,
    regions: started.map(({ region }) => region),
    dispose,
  }
}
