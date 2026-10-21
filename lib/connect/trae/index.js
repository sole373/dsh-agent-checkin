/**
 * TRAE 激活序列（五层架构的装配层）：凭据 → 目录 → shim → adapter → 注册。
 *
 * 序列逐行对齐 ref/connect-qoder index.js:441-530（MIT）的模板：
 *
 *   1. 开关为假 → `{ ok:false, reason:'disabled' }`（调用方打 info，不算错误）；
 *   2. 读凭据（`loadTraeCredentials`）——读不到/已过期 → ok:false + 可读原因；
 *   3. `regionOfCredential` 定区域：'cn' → provider `trae`；非 cn →
 *      `trae-global`（需 intlEnabled，未开 → ok:false 'intl-disabled'）；
 *   4. deps 缺省走 `loadPiDeps()`（宿主外必抛）→ 软失败 ok:false；
 *   5. 起 shim（await ready）→ `createShimAdapter` → `registerProviderGroup`；
 *      注册失败 → `shim.close()` + ok:false，如实带 error，**绝不抛出**——
 *      一个平台的失败不能拖垮其它平台与签到；
 *   6. `registerModelDiscovery` 按 provider 返回当前目录；
 *   7. `ctx.effect(() => dispose)`：release 注册句柄 + 关 shim + 清定时器；
 *   8. 目录刷新不阻塞注册：后台先刷一次，然后每 30 分钟一次；目录读不到 =
 *      模型组隐藏，不崩溃。
 *
 * @module dsh-agent-checkin/connect/trae
 */

import { loadTraeCredentials, isExpired } from '../../trae-credentials.js'
import { loadModelCatalog } from '../../trae-catalog.js'
import { createShimAdapter, hostAttachmentResolvers } from '../baseadapter.js'
import { registerProviderGroup, registerModelDiscovery } from '../registry.js'
import { loadPiDeps, settingsNamespaceOf } from '../pi-deps.js'
import { applyImageSelection } from '../selection.js'
import { createTraeShim } from './shim.js'
import { regionOfCredential } from './upstream-raw.js'
import { toPiModel, filterSelectable, modelDisplayName } from './models.js'

/** 区域 → provider id（与 ref TRAE_PROVIDERS 一致）。 */
export const TRAE_PROVIDERS = { cn: 'trae', ai: 'trae-global' }

/** 区域 → 展示名（与 ref TRAE_PROVIDER_DISPLAY_NAMES 一致）。 */
export const TRAE_PROVIDER_DISPLAY_NAMES = { cn: 'Trae', ai: 'Trae Global' }

/** 目录刷新周期（30 分钟）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/**
 * 激活 TRAE 模型路由。
 *
 * @param {object} ctx 插件上下文（需要 ctx.llm / ctx.effect / ctx.emit）
 * @param {object} options
 * @param {boolean} options.enabled 国内区（Trae CN）开关——仅在未提供
 *   `options.selection` 时生效（装配期兼容路径）
 * @param {boolean} options.intlEnabled 国际区（Trae Global）开关——同上
 * @param {object} [options.selection] 选择中心（lib/connect/selection.js）。提供时
 *   平台注册不再看装配期布尔字段：只要有本机登录态就注册，模型是否出现在
 *   选择器里由选择中心实时决定（看板「模型接入」页可开关，免重启）。
 * @param {string} [options.settingsNs] 配置命名空间（缺省取宿主惯例值）
 * @param {object} [options.deps] 宿主私有依赖（单测注入 mock；缺省动态加载）
 * @param {object} [options.logger]
 * @param {string} [options.storagePath] 显式 storage.json（测试用）
 * @param {Function} [options.fetchImpl] 上游 fetch 注入（测试用）
 * @returns {Promise<{ ok: boolean, reason?: string, error?: unknown,
 *   providerIds?: string[], dispose?: () => void }>}
 */
export async function activateTrae(ctx, options = {}) {
  const log = options.logger ?? ctx?.logger
  // 选择模式下 enabled/intlEnabled 让位给选择中心（装配期字段只是首启种子）：
  // 平台只要本机有登录态就注册，可见性由看板「模型接入」页实时控制。
  if (options.selection === undefined && !options.enabled) return { ok: false, reason: 'disabled' }

  let credential
  try {
    credential = loadTraeCredentials(options.storagePath)
  } catch (error) {
    return { ok: false, reason: `凭证不可用：${error.message}` }
  }
  if (isExpired(credential)) {
    return { ok: false, reason: 'TRAE 登录态已过期，请在 TRAE 客户端重新登录' }
  }

  const regionKey = regionOfCredential(credential)
  if (regionKey !== 'cn' && !options.intlEnabled && options.selection === undefined) {
    return { ok: false, reason: 'intl-disabled' }
  }
  const providerId = TRAE_PROVIDERS[regionKey] ?? TRAE_PROVIDERS.ai
  const displayName = TRAE_PROVIDER_DISPLAY_NAMES[regionKey] ?? TRAE_PROVIDER_DISPLAY_NAMES.ai
  const settingsNs = options.settingsNs ?? settingsNamespaceOf(ctx)

  const deps = options.deps ?? await loadPiDeps().catch(() => undefined)
  if (deps === undefined) {
    return { ok: false, reason: 'pi-ai 依赖不可用（插件未运行在宿主内）' }
  }

  // 目录状态：可刷新。初始读不到按空目录处理——模型组隐藏，不崩溃。
  let catalog = { models: [] }
  const readCatalog = () => {
    catalog = loadModelCatalog({ credential })
  }
  try {
    readCatalog()
  } catch (error) {
    log?.warn?.('dsh-agent-checkin: trae 初始模型目录不可用（模型组先隐藏，后台继续重试）', error)
  }
  // 模型清单的实时入口：先取客户端目录里可选的模型，再过一遍选择中心。
  // 每次调用都现读选择状态——看板上勾选/取消勾选后，模型选择器在下一个
  // llm/adapters-updated 周期就是新的，不需要重启宿主。
  //
  // 图片开关也在这里统一盖章（applyImageSelection）：`imageIds: null` 时原样返回，
  // 保持"跟随目录 multimodal"的老行为；用户显式勾选时按 id 重写 multimodal。
  // 只此一处改动，`toPiModel` 与目录发现都自然读到新值。
  const currentModels = () => {
    const all = filterSelectable(catalog.models)
    if (!options.selection) return all
    const selected = options.selection.filter(providerId, all)
    return applyImageSelection(selected, options.selection.get(providerId))
  }

  const shim = createTraeShim({
    // 凭据每请求现取：客户端里重新登录后下一个请求就用上新 token。
    resolveCredential: async () => {
      const live = loadTraeCredentials(options.storagePath)
      if (isExpired(live)) throw new Error('TRAE 登录态已过期，请在 TRAE 客户端重新登录')
      return live
    },
    resolveModels: currentModels,
    region: { id: providerId, key: regionKey, displayName },
    logger: log,
    fetchImpl: options.fetchImpl,
  })
  try {
    await shim.ready
  } catch (error) {
    return { ok: false, reason: `loopback shim 启动失败：${error.message}`, error }
  }

  const { adapter, invalidate } = createShimAdapter({
    deps,
    providers: [{
      id: providerId,
      displayName,
      shim,
      // 选择器真身路线：宿主 buildModelCatalog → llm.listModels → 这里的 buildModels。
      // 2026-10-21 复盘：只修 discover 不够——discover 喂的是设置页目录继承，
      // 聊天模型选择器读的是 toPiModel 的 name，所以 toPiModel 必须同样折倍率+消歧
      // （对齐原版 ref/connect-trae index.js:555，也与我们 qoder 的写法一致）。
      buildModels: (baseUrlV1) => {
        const all = currentModels()
        return all.map((m) => toPiModel(m, baseUrlV1, providerId, all))
      },
    }],
    retryNs: settingsNs,
    // 带图请求走宿主持久附件服务（对齐宿主自注册 pi-ai 的接法）。
    ...hostAttachmentResolvers(ctx, deps.resolveImageAttachmentAccess),
  })

  const registration = registerProviderGroup(ctx, {
    adapter,
    providers: [{ id: providerId, displayName }],
    settingsNs,
    label: 'trae',
    logger: log,
  })
  if (!registration.ok) {
    await shim.close()
    return { ok: false, reason: `provider 注册失败：${registration.error?.message ?? registration.error}`, error: registration.error }
  }

  const releaseDiscovery = registerModelDiscovery(ctx, {
    settingsNs,
    label: 'trae',
    logger: log,
    // 选择器渲染的是这里的 `name`（不看 multiplier 字段），所以倍率必须折进
    // 名字里才看得见——与原版 `traeModelDisplayName` 的做法一致。
    // 同名条目（-Official 与基础版）追加来源后缀消歧。
    discover: async (provider) => {
      if (provider !== providerId) return []
      const all = currentModels()
      return all.map((m) => ({
        id: m.id,
        name: modelDisplayName(m, all),
        input: m.multimodal === true ? ['text', 'image'] : ['text'],
      }))
    },
  })

  // 登记到选择中心：设置页「平台与模型」页签从这里读实时清单（未筛的全集）与状态。
  // 只在 provider 注册成功后才登记，保证「已接入」标签指的都是真的可路由。
  //
  // multiplier 来自 trae-catalog.js 提取的 features.consumption_rate.data.rate
  // （活动价 activity_discount 优先）——2026-10-18 更正：之前「TRAE 没有倍率」的
  // 结论是错的，倍率藏在嵌套的 features 里，不在顶层。个别模型（自定义 base_url
  // 变体 deepseek//…）确实没有，normalizeEntry 会整字段省略，前端如实留空。
  options.selection?.attach(providerId, {
    label: displayName,
    platform: 'TRAE',
    listAll: () =>
      filterSelectable(catalog.models).map((model) => ({
        id: model.id,
        name: model.name,
        // TRAE 的图片能力来自客户端目录的 multimodal 字段，这就是它的「原生」
        // 声明；页面对 imageIds: null（跟随原生）那一档要能画出真实勾选状态。
        nativeImage: model.multimodal === true,
        ...(typeof model.multiplier === 'number' ? { multiplier: model.multiplier } : {}),
      })),
    status: () => ({ text: `已接入（${regionKey === 'cn' ? '国内版' : '国际版'}客户端）` }),
  })

  let refreshTimer
  const refresh = async () => {
    try {
      readCatalog()
    } catch (error) {
      log?.warn?.('dsh-agent-checkin: trae 模型目录刷新失败（沿用旧目录）', error)
      return
    }
    invalidate()
    ctx?.emit?.('llm/adapters-updated')
  }
  // 不阻塞注册：后台先刷一次，然后进入 30 分钟周期。unref 让定时器不拖住进程。
  void refresh().then(() => {
    refreshTimer = setInterval(refresh, CATALOG_REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    options.selection?.detach(providerId)
    registration.release?.()
    releaseDiscovery?.()
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    void shim.close()
  }
  ctx?.effect?.(() => dispose)

  return { ok: true, providerIds: [providerId], dispose }
}
