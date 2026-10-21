/**
 * Lingxi（WPS 灵犀）激活序列（五层架构的装配层）。
 *
 * 序列逐行对齐 ref/connect-qoder index.js:441-530（MIT）的模板：
 *
 *   1. 开关为假 → `{ ok:false, reason:'disabled' }`（调用方打 info，不算错误）；
 *   2. 读凭据（从 engine/lx_cookie.txt）——读不到/未登录 → ok:false + 可读原因；
 *   3. deps 缺省走 `loadPiDeps()`（宿主外必抛）→ 软失败 ok:false；
 *   4. 起 shim（await ready）→ `createShimAdapter` → `registerProviderGroup`；
 *      注册失败 → `shim.close()` + ok:false，如实带 error，**绝不抛出**——
 *      一个平台的失败不能拖垮其它平台与签到；
 *   5. `registerModelDiscovery` 按 provider 返回当前目录；
 *   6. `ctx.effect(() => dispose)`：release 注册句柄 + 关 shim + 清定时器；
 *   7. 目录刷新不阻塞注册：后台先刷一次，然后每 30 分钟一次；目录读不到 =
 *      模型组隐藏，不崩溃。
 *
 * @module dsh-agent-checkin/connect/lingxi
 */

import { createLingxiCatalog, CATALOG_REFRESH_INTERVAL_MS } from './catalog.js'
import { readLingxiCookie, lingxiCookieFileCandidates } from './credentials.js'
import { createShimAdapter, hostAttachmentResolvers } from '../baseadapter.js'
import { registerProviderGroup, registerModelDiscovery } from '../registry.js'
import { loadPiDeps, settingsNamespaceOf } from '../pi-deps.js'
import { applyImageSelection } from '../selection.js'
import { createLingxiShim } from './shim.js'
import { toPiModel, filterSelectable } from './models.js'

/** Provider route this bundle owns. */
export const LINGXI_PROVIDER = 'lingxi'

/** Human-readable provider name. */
export const LINGXI_DISPLAY_NAME = '灵犀（WPS Lingxi）'

/**
 * 读取 Lingxi Cookie。
 *
 * 解析顺序见 `./credentials.js#lingxiCookieFileCandidates`：用户可写目录优先
 * （`<dshHome>/dsh-agent-checkin/engine/lx_cookie.txt`），包内 `engine/` 兜底。
 *
 * 为什么不再只认包内路径：`package.json` 的 `files` 白名单刻意排除
 * `engine/*_cookie.txt`，从 tgz 重装后包内 Cookie 必然消失，provider 会静默
 * 不注册（调用方只 logger.warn）——这正是「灵犀模型突然不见了」的成因。
 *
 * @returns {string | undefined}
 */
function readCookieFile() {
  return readLingxiCookie()
}

/**
 * 激活 Lingxi 模型路由。
 *
 * @param {object} ctx 插件上下文（需要 ctx.llm / ctx.effect / ctx.emit）
 * @param {object} options
 * @param {boolean} options.enabled 开关——仅在未提供 `options.selection` 时生效
 * @param {object} [options.selection] 选择中心（lib/connect/selection.js）。提供时
 *   平台注册不再看装配期布尔字段：只要有本机登录态就注册，模型是否出现在
 *   选择器里由选择中心实时决定（看板「模型接入」页可开关，免重启）。
 * @param {string} [options.settingsNs] 配置命名空间（缺省取宿主惯例值）
 * @param {object} [options.deps] 宿主私有依赖（单测注入 mock；缺省动态加载）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 上游 fetch 注入（测试用）
 * @returns {Promise<{ ok: boolean, reason?: string, error?: unknown,
 *   providerIds?: string[], dispose?: () => void }>}
 */
export async function activateLingxi(ctx, options = {}) {
  const log = options.logger ?? ctx?.logger
  // 选择模式下 enabled 让位给选择中心（装配期字段只是首启种子）：
  // 平台只要本机有登录态就注册，可见性由看板「模型接入」页实时控制。
  if (options.selection === undefined && !options.enabled) return { ok: false, reason: 'disabled' }

  let cookie
  try {
    cookie = readCookieFile()
  } catch (error) {
    return { ok: false, reason: `凭证不可用：${error.message}` }
  }
  if (!cookie || typeof cookie !== 'string' || cookie.length === 0) {
    const searched = lingxiCookieFileCandidates().join(' | ')
    return { ok: false, reason: `Lingxi Cookie 文件缺失（已查找：${searched}；请登录灵犀客户端后运行 CDP 采集，或设置环境变量 LINGXI_COOKIE_FILE）` }
  }

  const providerId = LINGXI_PROVIDER
  const displayName = LINGXI_DISPLAY_NAME
  const settingsNs = options.settingsNs ?? settingsNamespaceOf(ctx)

  const deps = options.deps ?? await loadPiDeps().catch(() => undefined)
  if (deps === undefined) {
    return { ok: false, reason: 'pi-ai 依赖不可用（插件未运行在宿主内）' }
  }

  // 目录状态：可刷新。初始读不到按空目录处理——模型组隐藏，不崩溃。
  const catalog = createLingxiCatalog({ cookie, logger: log })
  try {
    await catalog.refresh()
  } catch (error) {
    log?.warn?.('dsh-agent-checkin: lingxi 初始模型目录不可用（模型组先隐藏，后台继续重试）', error)
  }

  // 模型清单的实时入口：先取客户端目录里可选的模型，再过一遍选择中心。
  // 每次调用都现读选择状态——看板上勾选/取消勾选后，模型选择器在下一个
  // llm/adapters-updated 周期就是新的，不需要重启宿主。
  //
  // 图片开关也在这里统一盖章（applyImageSelection）：`imageIds: null` 时原样返回，
  // 保持"跟随目录 multimodal"的老行为；用户显式勾选时按 id 重写 multimodal。
  const currentModels = () => {
    const all = filterSelectable(catalog.current())
    if (!options.selection) return all
    const selected = options.selection.filter(providerId, all)
    return applyImageSelection(selected, options.selection.get(providerId))
  }

  const shim = createLingxiShim({
    // 凭据每请求现取：从文件读取最新 Cookie。
    resolveCredential: async () => {
      const live = readCookieFile()
      if (!live || typeof live !== 'string' || live.length === 0) {
        throw new Error('Lingxi Cookie 不可用或未登录')
      }
      return live
    },
    catalog,
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
      buildModels: (baseUrlV1) => currentModels().map((m) => toPiModel(m, baseUrlV1, providerId)),
    }],
    retryNs: settingsNs,
    // 带图请求走宿主持久附件服务（对齐宿主自注册 pi-ai 的接法）。
    ...hostAttachmentResolvers(ctx, deps.resolveImageAttachmentAccess),
  })

  const registration = registerProviderGroup(ctx, {
    adapter,
    providers: [{ id: providerId, displayName }],
    settingsNs,
    label: 'lingxi',
    logger: log,
  })
  if (!registration.ok) {
    await shim.close()
    return { ok: false, reason: `provider 注册失败：${registration.error?.message ?? registration.error}`, error: registration.error }
  }

  const releaseDiscovery = registerModelDiscovery(ctx, {
    settingsNs,
    label: 'lingxi',
    logger: log,
    discover: async (provider) => {
      if (provider !== providerId) return []
      return currentModels().map((m) => ({
        id: m.id,
        name: m.name,
        input: m.multimodal === true ? ['text', 'image'] : ['text'],
      }))
    },
  })

  // 登记到选择中心：设置页「平台与模型」页签从这里读实时清单（未筛的全集）与状态。
  // 只在 provider 注册成功后才登记，保证「已接入」标签指的都是真的可路由。
  options.selection?.attach(providerId, {
    label: displayName,
    platform: 'Lingxi',
    listAll: () =>
      filterSelectable(catalog.current()).map((model) => ({
        id: model.id,
        name: model.name,
        nativeImage: model.multimodal === true,
        multiplier: model._multiplier || '',
      })),
    status: () => ({ text: '已接入（云端 API）' }),
  })

  let refreshTimer
  const refresh = async () => {
    const changed = await catalog.refresh()
    if (changed) {
      invalidate()
      ctx?.emit?.('llm/adapters-updated')
    }
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
