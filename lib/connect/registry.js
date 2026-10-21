/**
 * 统一注册器（五层架构的第⑤层）。
 *
 * 逐行对齐 ref/connect-qoder index.js:499-530（MIT）的注册序列：
 *
 *   1. `registerAdapter(providerIds, adapter)` —— provider id **数组** + 一个
 *      共享 adapter（传单字符串必失败，空数组抛 INVALID_ADAPTER）；
 *   2. `registerConfigurableProviders([{ provider, displayName, settingsNs,
 *      settingsPath: [], declared: false }])` —— `settingsNs` 必填非空，
 *      `declared:false` 是宿主合法字段；
 *   3. 任一步失败：释放已到手的句柄、记日志、返回 ok:false —— 绝不把半个
 *      注册留给宿主，也绝不让一个平台的失败拖垮其它平台与签到；
 *   4. 成功时返回 release()，由调用方挂进 `ctx.effect` 清理链。
 *
 * DUPLICATE_ADAPTER（老插件未清干净时的过渡态）由调用方按平台策略处理：
 * 本模块只如实把错误交回去，不私自吞掉。
 *
 * @module dsh-agent-checkin/connect/registry
 */

/**
 * 注册一组 provider。
 *
 * @param {object} ctx 插件上下文（需要 ctx.llm 与 ctx.logger）
 * @param {object} options
 * @param {object} options.adapter 共享的 PiAiAdapter 实例
 * @param {Array<{ id: string, displayName: string }>} options.providers
 * @param {string} options.settingsNs 配置命名空间（必填非空，缺了宿主
 *   `undefined.length` 直接 TypeError）
 * @param {string} options.label 日志前缀（平台名）
 * @param {object} [options.logger]
 * @returns {{ ok: boolean, release?: () => void, error?: unknown }}
 */
export function registerProviderGroup(ctx, { adapter, providers, settingsNs, label, logger }) {
  const llm = ctx?.llm ?? (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined)
  const log = logger ?? ctx?.logger
  if (!llm || typeof llm.registerAdapter !== 'function') {
    log?.warn?.('dsh-agent-checkin: %s 宿主未提供 llm.registerAdapter，跳过注册', label)
    return { ok: false, error: new Error('llm service unavailable') }
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, error: new Error('providers 不能为空') }
  }
  if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
    return { ok: false, error: new Error('settingsNs 必填非空') }
  }

  let releaseAdapter
  let releaseDirectory
  try {
    releaseAdapter = llm.registerAdapter(
      providers.map((p) => p.id),
      adapter,
    )
    releaseDirectory = llm.registerConfigurableProviders(
      providers.map((p) => ({
        provider: p.id,
        displayName: p.displayName,
        settingsNs,
        settingsPath: [],
        declared: false,
      })),
    )
  } catch (error) {
    releaseAdapter?.()
    releaseDirectory?.()
    log?.error?.('dsh-agent-checkin: %s provider 注册失败', label, error)
    return { ok: false, error }
  }

  const release = () => {
    releaseAdapter?.()
    releaseDirectory?.()
  }
  return { ok: true, release }
}

/**
 * 注册模型发现（声明了 settingsNs 的 provider 的配套义务，§3.7）。
 *
 * 形状对齐 ref/connect-trae :6733：`registerModelDiscovery(settingsNs, fn)`，
 * fn 收 `(request, signal)`，按 `request.provider` 决定返回哪个区域的模型，
 * 返回 `[{ id, name, ... }]` 数组；区域不认识或未启用时返回 `[]`。
 *
 * 失败只记 warn：发现服务缺席不该影响已注册的模型路由。
 *
 * @returns {(() => void) | undefined} 注销句柄（宿主不支持时为 undefined）
 */
export function registerModelDiscovery(ctx, { settingsNs, discover, label, logger }) {
  const llm = ctx?.llm ?? (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined)
  const log = logger ?? ctx?.logger
  if (typeof llm?.registerModelDiscovery !== 'function') return undefined
  try {
    return llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const cancellation = signal ?? request?.signal
      return discover(request?.provider ?? '', cancellation)
    })
  } catch (error) {
    log?.warn?.('dsh-agent-checkin: %s registerModelDiscovery 失败（不影响模型路由）', label, error)
    return undefined
  }
}
