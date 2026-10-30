/**
 * Magpie（本地路由网关）激活序列（五层架构的装配层）。
 *
 * 与灵犀/TRAE 不同，magpie 已经由宿主 `cordis.patch.yml` 的
 * `llm-pi-ai.providers.magpie` 注册进了聊天模型选择器——所以本模块**不再注册
 * provider**（再注册会 `DUPLICATE_ADAPTER`）。它只做一件事：把 magpie 网关的
 * 模型清单喂给「平台与模型」看板，并解析出倍率，像灵犀那样在右侧显示
 * `（x.xx）`。
 *
 * 倍率只透传真数字：magpie 网关 `/v1/models` 只对一部分模型在 `display_name`
 * 里公开了倍率（如 `glm-5.3 · x0.79`），其余模型 magpie 本身没给，本模块不编、
 * 按既有闸门（selection.js 的数字守卫）整字段省略。
 *
 * 网关是用户本机起的进程，可能没开：初次探测失败不 attach（看板不出现空行），
 * 后台每 60 秒重试直到接入；接入后每 30 分钟刷新一次目录。看板行随网关
 * 出现/隐藏，状态显示「网关不可达」。
 *
 * @module dsh-agent-checkin/connect/magpie
 */

/** Magpie 本地网关的 OpenAI 兼容模型端点。 */
const MAGPIE_MODELS_URL = 'http://127.0.0.1:3425/v1/models'

/** 初次探测 / 每次刷新的超时（网关是 localhost，3 秒足够）。 */
const MAGPIE_PROBE_TIMEOUT_MS = 3000

/** 接入成功后目录刷新周期。 */
const MAGPIE_REFRESH_MS = 30 * 60 * 1000

/** 网关未开时的重试间隔（不阻塞插件加载）。 */
const MAGPIE_RETRY_MS = 60 * 1000

/** Provider 路由 id（看板行 id；不重新注册 provider 本身）。 */
export const MAGPIE_PROVIDER = 'magpie'

/** 看板行显示名。 */
export const MAGPIE_DISPLAY_NAME = 'Magpie（本地路由）'

/**
 * 从 magpie 的 `display_name` 里抽倍率。
 *
 * magpie 把倍率拼成 `glm-5.3 · x0.79` 这种中点+`x`+数字的形式；中点之前是
 * 真名，之后是倍率装饰。没有倍率的名字（如 `Hy3`、`纯免费`）原样返回、不报倍率。
 * 数字守卫必须在模板串之前：非数字 / 负值一律当「没给倍率」，绝不进 `.toFixed()`。
 *
 * @param {string} [name]
 * @returns {{ base: string, multiplier?: number }}
 */
export function parseMagpieRate(name) {
  if (typeof name !== 'string' || name === '') return { base: name ?? '' }
  const match =
    name.match(/\s*[·|]\s*x\s*([0-9.]+)/iu) ??
    name.match(/\sx([0-9.]+)/u)
  if (!match) return { base: name.trim() }
  const multiplier = Number.parseFloat(match[1])
  if (!Number.isFinite(multiplier) || multiplier < 0) return { base: name.trim() }
  return { base: name.slice(0, match.index).trim(), multiplier }
}

/**
 * 拉 magpie 网关模型目录。
 *
 * 用 `MAGPIE_GATEWAY_KEY`（cordis 里 `apiKeyEnv` 同名）作 Bearer；缺失时用占位
 * 值——网关对 `/v1/models` 不强制鉴权（实测 `Bearer x` 即可）。返回 `data` 数组，
 * 解析失败 / 结构异常一律往外抛，由调用方判成「网关不可达」。
 *
 * @param {typeof fetch} fetchImpl 注入的 fetch（测试用；缺省取 globalThis.fetch）
 * @param {number} timeoutMs 超时
 * @param {string} [apiKey]
 * @returns {Promise<Array<object>>}
 */
async function fetchMagpieModels(fetchImpl, timeoutMs, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(MAGPIE_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey && apiKey.length > 0 ? apiKey : 'x'}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
    return list
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 激活 Magpie 模型路由（只看板、不注册 provider）。
 *
 * @param {object} ctx 插件上下文（需要 ctx.effect / ctx.logger）
 * @param {object} [options]
 * @param {object} options.selection 选择中心（lib/connect/selection.js）
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 注入 fetch（测试用）
 * @returns {Promise<{ ok: boolean, reason?: string, providerIds?: string[], dispose?: () => void }>}
 */
export async function activateMagpie(ctx, options = {}) {
  const log = options.logger ?? ctx?.logger
  const selection = options.selection
  if (!selection || typeof selection.attach !== 'function') {
    return { ok: false, reason: 'selection 中心不可用' }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '运行环境无 fetch（插件未运行在宿主内）' }
  }
  const apiKey = process.env.MAGPIE_GATEWAY_KEY

  let attached = false
  let cached = []
  let statusText

  /** 看板实时清单：剥掉倍率装饰后的裸名 + 真数字倍率（无则不带字段）。 */
  const buildList = () =>
    cached.map((model) => {
      const { base, multiplier } = parseMagpieRate(model.display_name)
      return {
        id: model.id,
        name: base,
        nativeImage: Array.isArray(model.modalities?.input) && model.modalities.input.includes('image'),
        ...(typeof multiplier === 'number' ? { multiplier } : {}),
      }
    })

  const doAttach = () => {
    if (attached) return
    attached = true
    selection.attach(MAGPIE_PROVIDER, {
      label: MAGPIE_DISPLAY_NAME,
      platform: 'Magpie',
      listAll: buildList,
      status: () => ({ text: statusText ?? '已接入（本地路由）' }),
    })
  }

  /**
   * 刷一次目录。失败时若已接入则保留上次清单（看板不闪空），未接入则不挂行。
   * @returns {Promise<{ ok: boolean, attached: boolean, reason?: string }>}
   */
  const refresh = async () => {
    let models
    try {
      models = await fetchMagpieModels(fetchImpl, MAGPIE_PROBE_TIMEOUT_MS, apiKey)
    } catch (error) {
      statusText = `网关不可达：${error?.message ?? error}`
      return { ok: false, attached, reason: 'gateway-unavailable' }
    }
    if (!Array.isArray(models) || models.length === 0) {
      statusText = '网关未返回模型'
      return { ok: false, attached, reason: 'empty-catalog' }
    }
    cached = models
    statusText = '已接入（本地路由）'
    doAttach()
    return { ok: true, attached: true }
  }

  // 初次探测：网关通常开着，直接接入；不开则后台每 60s 重试直到接入。
  const first = await refresh()

  let retryTimer
  let refreshTimer
  const startRefresh = () => {
    refreshTimer = setInterval(async () => {
      try {
        await refresh()
      } catch {
        /* 保留上次清单，不闪空 */
      }
    }, MAGPIE_REFRESH_MS)
    refreshTimer.unref?.()
  }

  if (!attached) {
    retryTimer = setInterval(async () => {
      const result = await refresh()
      if (result.attached) {
        clearInterval(retryTimer)
        startRefresh()
      }
    }, MAGPIE_RETRY_MS)
    retryTimer.unref?.()
  } else {
    startRefresh()
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (retryTimer !== undefined) clearInterval(retryTimer)
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    selection.detach?.(MAGPIE_PROVIDER)
  }
  ctx?.effect?.(() => dispose)

  if (!first.ok) {
    log?.info?.('dsh-agent-checkin: magpie 网关暂不可达（后台重试接入）：%s', first.reason)
  } else {
    log?.info?.('dsh-agent-checkin: magpie 模型接入已注册（看板）')
  }

  return {
    ok: first.ok,
    reason: first.reason,
    providerIds: attached ? [MAGPIE_PROVIDER] : [],
    dispose,
  }
}
