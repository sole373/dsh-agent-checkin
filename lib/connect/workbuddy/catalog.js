/**
 * WorkBuddy 模型目录（五层架构的第②层）：静态兜底表 + 上游目录拉取 +
 * 磁盘缓存（只存模型元数据，绝无 token）。
 *
 * 移植自 dsh-connect-workbuddy@4.6.5（MIT，Copyright (c) 2026 LaoDing）：
 *   - `FALLBACK_WORKBUDDY_MODELS`（CN 12 条，2026-08-30 快照）与
 *     `FALLBACK_WORKBUDDY_MODELS_GLOBAL`（国际 20 条，2026-09-11 快照）
 *     逐字对齐其 catalog.ts（host-heartbeat:3446-3669）——两区 roster 不同，
 *     一个区域的账号绝不能被喂另一个区域的兜底表；
 *   - `fetchCatalogModels` 逐字对齐其 `WorkBuddyUpstreamClient.fetchModels`
 *     （host-heartbeat:1835-1878）：两区首选 `/v3/config`；global 必须
 *     DESKTOP_UA（桌面渠道），CN 必须 CLIENT_UA（CLI 渠道——只有该渠道的
 *     /v3 答案含免费 hy4-preview-f）；CN 失败兜底
 *     `/v2/enterprises/personal/models`；
 *   - `WorkBuddyCatalog` 的状态机（种子=兜底表、set 非空守卫）对齐其
 *     catalog.ts:3712-3797；usable/enabled 两道闸在本插件由 index.js 的
 *     「无登录态不注册」承担，目录对象本身不再重复。
 *
 * 磁盘缓存只存模型元数据（id/name/窗口/倍率/reasoning 标志），落 DSH home；
 * 路径由调用方注入（`options.dshHome`，解析链见 index.js 的
 * resolveDshHomeRoot），注入缺省时只走内存，保证单测可跑。
 *
 * @module dsh-agent-checkin/connect/workbuddy/catalog
 */
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  readEnvelope,
  envelopeError,
  regionOf,
  globalBase,
  chatBase,
  originReferer,
  CLIENT_UA,
  DESKTOP_UA,
} from './shim.js'
import { selectCliModels, defaultCatalogStamp } from './models.js'

/** 目录拉取的 JSON 超时（老插件 upstream.ts JSON_TIMEOUT_MS 原样）。 */
const JSON_TIMEOUT_MS = 30_000

/**
 * Remote product-config path：CN 的首选目录源、global 的唯一目录源
 * （老插件 GLOBAL_CONFIG_PATH 原样）。`/v3/config` 按 UA 渠道分身。
 */
export const GLOBAL_CONFIG_PATH = '/v3/config'
/**
 * CN 的兜底目录路径（老插件 MODELS_CATALOG_PATH 原样）。这是老版 CLI 读的
 * 文档，与 App 读的 `/v3/config` 不是同一份 roster（价格栏会对不上），所以
 * 只在 `/v3` 失败时使用，且触发时必须上报。
 */
export const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/** 目录刷新的 TTL：约 30 分钟（任务书定案）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** 磁盘缓存的格式版本；不符即整份丢弃，下次成功刷新会重写。 */
const CATALOG_FORMAT_VERSION = 1

/**
 * Static CLI models captured from the CN endpoint (2026-08-30). The upstream
 * refresh replaces this list at startup; it exists so the provider registers
 * with a usable catalog even while the first fetch is in flight or offline.
 *
 * （逐字对齐老插件 host-heartbeat:3446-3519。）
 */
export const FALLBACK_WORKBUDDY_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 168e3, maxTokens: 32e3 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192e3, maxTokens: 64e3 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 2e5, maxTokens: 64e3 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1e6, maxTokens: 48e3 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1e6, maxTokens: 48e3 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 2e5, maxTokens: 48e3 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512e3, maxTokens: 128e3 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1e6, maxTokens: 32e3 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256e3, maxTokens: 32e3 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256e3, maxTokens: 32e3 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1e6, maxTokens: 5e4 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1e6, maxTokens: 5e4 },
]

/**
 * Static CLI models captured from the INTERNATIONAL gateway's desktop-channel
 * product config (`www.workbuddy.ai/v3/config`, 2026-09-11). The two regions
 * expose different rosters — the CN list has no `gpt-*`/`gemini-*` entries —
 * so a global account must never be seeded with the CN list. Order and rates
 * mirror the upstream.
 *
 * （逐字对齐老插件 host-heartbeat:3528-3669。）
 */
export const FALLBACK_WORKBUDDY_MODELS_GLOBAL = [
  { id: 'default-model', name: 'Auto', contextWindow: 176e3, maxTokens: 24e3, creditMultiplier: 0.79 },
  { id: 'fast-model', name: 'Fast', contextWindow: 2e5, maxTokens: 32e3, creditMultiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256e3, maxTokens: 32e3, creditMultiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272e3, maxTokens: 72e3, creditMultiplier: 3.31 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176e3, maxTokens: 24e3, creditMultiplier: 3.33 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 6.67 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1e6, maxTokens: 64e3, creditMultiplier: 0 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192e3, maxTokens: 64e3, creditMultiplier: 0 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1e6, maxTokens: 128e3, creditMultiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272e3, maxTokens: 72e3, creditMultiplier: 1.65 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272e3, maxTokens: 72e3, creditMultiplier: 1.25 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1e6, maxTokens: 65536, creditMultiplier: 0.99 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1e6, maxTokens: 48e3, creditMultiplier: 0.79 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1e6, maxTokens: 48e3, creditMultiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1e6, maxTokens: 32e3, creditMultiplier: 1.62 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256e3, maxTokens: 32e3, creditMultiplier: 0.52 },
]

/**
 * Static fallback directory for a region. Each region keeps its own roster;
 * the fallback must match the region so an account never shows the other
 * region's models（老插件 fallbackModelsFor 原样）.
 */
export function fallbackModelsFor(region) {
  return region === 'global' ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS
}

/**
 * Read the model directory for the credential's region（逐字对齐老插件
 * `WorkBuddyUpstreamClient.fetchModels`，host-heartbeat:1835-1878）.
 *
 * Both regions prefer `/v3/config` — the document the WorkBuddy app itself
 * consumes — and differ in the user agent that requests it. That difference
 * is load-bearing: `/v3` serves a different roster per client channel.
 * Global asks as the desktop channel ({@link DESKTOP_UA}) — the CLI channel's
 * answer there omits `deepseek-v4.1-flash` and `gpt-6-astra` even though both
 * are chat-usable. CN asks as the CLI channel ({@link CLIENT_UA}) — the only
 * CN channel whose `/v3` answer contains the free `hy4-preview-f`.
 *
 * CN falls back to {@link MODELS_CATALOG_PATH} when `/v3` fails, returns a
 * non-zero envelope, or resolves to no usable model. The fallback is silent
 * when unused and reported via `onFallback` when it fires.
 *
 * @param {object} credential 已解析的凭据（含 accessToken/domain/uid）
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 测试注入；缺省全局 fetch
 * @param {(message: string) => void} [options.onFallback] CN 兜底触发时上报
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object[]>} 解析后的 WorkBuddyModelInfo 数组（未盖戳）
 */
export async function fetchCatalogModels(credential, { fetchImpl, onFallback, signal } = {}) {
  const doFetch = fetchImpl ?? fetch
  const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
  if (regionOf(credential.domain) === 'global') {
    const response = await doFetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        ...(credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
        ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain }),
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
        'Connection': 'close',
        'User-Agent': DESKTOP_UA,
      },
      signal: timeout,
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    return selectCliModels(data['models'], data['agents'])
  }
  const readCatalog = async (path) => {
    const response = await doFetch(`${chatBase(credential)}${path}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: timeout,
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    return selectCliModels(data['models'], data['agents'])
  }
  try {
    return await readCatalog(GLOBAL_CONFIG_PATH)
  } catch (error) {
    onFallback?.(
      `CN model catalog ${GLOBAL_CONFIG_PATH} failed; falling back to ${MODELS_CATALOG_PATH}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    return await readCatalog(MODELS_CATALOG_PATH)
  }
}

/** 缓存条目必须自带的最小字段集；其余字段原样保留。 */
function validCachedModel(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value
  return (
    typeof raw['id'] === 'string' &&
    raw['id'] !== '' &&
    typeof raw['name'] === 'string' &&
    raw['name'] !== '' &&
    typeof raw['contextWindow'] === 'number' &&
    raw['contextWindow'] > 0 &&
    typeof raw['maxTokens'] === 'number' &&
    raw['maxTokens'] > 0
  )
}

/**
 * 一个区域的可变目录：shim 的 `/v1/models` 与 adapter 共用。
 *
 * 状态机对齐老插件 `WorkBuddyCatalog`：构造时种子=该区域静态兜底表（离线
 * 或首拉未完成时 provider 依然有可用目录）；`set` 拒绝空表（空是「无账号」
 * 的合法状态，但那是注册层的判断，不是目录的）。磁盘缓存只存模型元数据，
 * 损坏即忽略，下次成功刷新重写。
 *
 * @param {object} options
 * @param {'cn'|'global'} [options.region] 该区域；决定兜底表与缓存文件名
 * @param {string} [options.dshHome] 缓存根（由 index.js 解析注入）；缺省只走内存
 * @param {object} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] 刷新传输的 fetch 注入
 */
export function createWorkBuddyCatalog({ region = 'cn', dshHome, logger, fetchImpl } = {}) {
  let models = fallbackModelsFor(region).map((model) => ({ ...model }))
  let fetchedAtMs = 0
  const cachePath =
    typeof dshHome === 'string' && dshHome !== ''
      ? join(dshHome, `dsh-agent-checkin.workbuddy-catalog.${region}.json`)
      : undefined

  /** Current entries; the fallback list until the upstream answer lands. */
  function current() {
    return models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  function set(next) {
    if (!Array.isArray(next) || next.length === 0) throw new Error('workbuddy model catalog cannot be empty')
    models = next.map((model) => ({ ...model }))
  }

  /** Best-effort 写盘；失败只记 warn，绝不影响目录本身。 */
  async function save() {
    if (cachePath === undefined) return
    try {
      await mkdir(join(cachePath, '..'), { recursive: true })
      await writeFile(
        cachePath,
        JSON.stringify({ version: CATALOG_FORMAT_VERSION, region, fetchedAt: fetchedAtMs, models }, null, 2),
        'utf8',
      )
    } catch (error) {
      logger?.warn?.(`dsh-agent-checkin: workbuddy ${region} 目录缓存写入失败 ${cachePath}`, error)
    }
  }

  /**
   * 读取磁盘缓存（异步、best-effort）。区域不符、版本不符、条目全废或文件
   * 损坏时保持兜底表不变；命中有效缓存则替换之。
   *
   * @returns {Promise<boolean>} 是否用缓存替换了兜底表
   */
  async function load() {
    if (cachePath === undefined) return false
    let parsed
    try {
      parsed = JSON.parse(await readFile(cachePath, 'utf8'))
    } catch {
      return false
    }
    if (parsed?.version !== CATALOG_FORMAT_VERSION || parsed?.region !== region) return false
    if (!Array.isArray(parsed?.models)) return false
    const cached = parsed.models.filter(validCachedModel)
    if (cached.length === 0) return false
    set(cached)
    fetchedAtMs = Number(parsed.fetchedAt) || 0
    return true
  }

  /**
   * 从上游刷新目录：成功 → `defaultCatalogStamp` 盖戳（multimodal 默认表 +
   * off 默认表）+ set + 写缓存，返回 true；失败 → 保留现值、记 warn、返回
   * false。绝不把一次瞬时故障变成空目录。
   *
   * @param {object} credential 已解析凭据
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<boolean>} 目录是否被替换（调用方据此 invalidate adapter）
   */
  async function refresh(credential, { signal } = {}) {
    let fetched
    try {
      fetched = await fetchCatalogModels(credential, {
        fetchImpl,
        signal,
        onFallback: (message) => logger?.warn?.(`dsh-agent-checkin: workbuddy ${region} ${message}`),
      })
    } catch (error) {
      logger?.warn?.(`dsh-agent-checkin: workbuddy ${region} 目录刷新失败，保留现有目录`, error)
      return false
    }
    try {
      set(defaultCatalogStamp(fetched))
    } catch (error) {
      logger?.warn?.('dsh-agent-checkin: workbuddy %s 上游目录解析为空，保留现有目录', region, error)
      return false
    }
    fetchedAtMs = Date.now()
    await save()
    return true
  }

  return {
    region,
    current,
    set,
    load,
    refresh,
    /** 缓存文件路径（未注入 dshHome 时为 undefined）；测试观测用。 */
    get cachePath() {
      return cachePath
    },
    /** 上次成功刷新的时间戳（0 = 本进程还没刷成功过）；测试观测用。 */
    get fetchedAtMs() {
      return fetchedAtMs
    },
  }
}
