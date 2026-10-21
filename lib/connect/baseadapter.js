/**
 * PiAiAdapter 工厂（五层架构的第④层）。
 *
 * 一个 adapter 实例可服务多个 provider id（`registerAdapter([ids], adapter)`
 * 的契约）：每个 provider 是 profiles 表里的另一条记录，模型的 `baseUrl`
 * 指向该 provider 自己的 loopback shim，路由到模型即路由到区域、凭据与
 * 协议翻译层。
 *
 * 形状逐行对齐 ref/connect-qoder adapter.js:371-445（MIT）：
 * `createProvider` + `openAICompletionsApi` 组 piProvider，外面套
 * `new PiAiAdapter({ profiles, auth: INERT_AUTH, resolveApiKey })`。
 *
 * **依赖注入说明**：`PiAiAdapter` / `createProvider` / `openAICompletionsApi`
 * 只存在于宿主 app.asar 内，单跑 node 时 import 不到。所以本模块不 import
 * 它们，全部由调用方（生产路径经动态 import）注入——单测因此可以传入 mock，
 * 永远不触碰宿主私有模块。
 *
 * @module dsh-agent-checkin/connect/baseadapter
 */

/** 单条流式读取的空闲上限。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** 图片预算，取 dsh-llm-pi-ai 默认值；纯文本模型永远收不到图。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/**
 * 惰性 pi-ai 凭据面。
 *
 * 这条路只靠 shim 共享密钥鉴权（每请求由 `resolveApiKey` 解析），pi-ai 自己
 * 的凭据生命周期绝不能为它造出凭据，所以所有环境查询都答「没存过、没有」。
 * （与 ref/connect-qoder adapter.js:42-59 逐字同构，MIT。）
 */
export const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-agent-checkin: 本路由没有 pi-ai 凭据生命周期')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  }
}

/** 订阅配额报不出逐 token 价格，如实报零。 */
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 宿主附件服务的标准接法，逐行对齐 app.asar 内宿主自注册
 * （@deepseek-ai/dsh-llm-pi-ai/lib/index.js 与 dsh-llm-deepseek 同款）：
 *
 *   resolveAttachments: () => ctx.get("attachments")
 *   resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
 *     attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref)
 *
 * pi-ai 在请求带图时调用 `config.resolveAttachments()`：返回 undefined 就抛
 * `pi-ai image input requires the durable attachment service`。这里惰性取
 * 宿主 cordis 服务，所以宿主后挂上附件服务也能在下一个请求生效。
 *
 * @param {object} ctx 插件 cordis 上下文（可空：单测/宿主外场景全链路判空）
 * @param {Function|undefined} resolveImageAttachmentAccess 来自
 *   `@deepseek-ai/dsh-llm`（pi-deps 透传）；缺省时只接附件、不接文件路径视图
 * @returns {{ resolveAttachments: () => unknown, resolveImageAccess?: Function }}
 */
export function hostAttachmentResolvers(ctx, resolveImageAttachmentAccess) {
  return {
    resolveAttachments: () => ctx?.get?.('attachments'),
    ...(typeof resolveImageAttachmentAccess === 'function'
      ? {
          resolveImageAccess: (attachments, ref) =>
            resolveImageAttachmentAccess(
              attachments,
              (hostPath) => ctx?.get?.('fs')?.processPathFromHostPath?.(hostPath),
              ref,
            ),
        }
      : {}),
  }
}

/**
 * 组装一个服务多个 provider 的 PiAiAdapter。
 *
 * @param {object} options
 * @param {object} options.deps 宿主私有依赖（生产路径动态 import 后注入）：
 *   `{ PiAiAdapter, createProvider, openAICompletionsApi, resolveRetryPolicy }`
 * @param {Array<object>} options.providers 每个元素：
 *   `{ id, displayName, shim: { baseUrl(), token() }, buildModels: (baseUrlV1) => object[] }`
 *   `buildModels` 在每次重建时调用，返回该 provider 的 pi-ai 模型描述数组
 *   （id/name/api/provider/baseUrl/input/cost/contextWindow/... 由平台自己的
 *   toPiModel 产出）。
 * @param {string} [options.retryNs] retryPolicy 的配置命名空间前缀
 * @param {Function} [options.resolveAttachments] 请求带图时取持久附件服务
 *   （`() => ctx.get('attachments')`，见 hostAttachmentResolvers）；缺省时
 *   带图请求会抛 UNSUPPORTED_CONTENT——这是诚实行为，宿主没挂附件服务时
 *   图片确实无处可取。
 * @param {Function} [options.resolveImageAccess] 把附件宿主路径映射成执行
 *   世界只读路径（模型用工具读图时用），同样建议走 hostAttachmentResolvers。
 * @returns {{ adapter: object, invalidate: () => void, providerIds: string[] }}
 */
export function createShimAdapter({ deps, providers, retryNs = 'dsh-agent-checkin', resolveAttachments, resolveImageAccess }) {
  const { PiAiAdapter, createProvider, openAICompletionsApi, resolveRetryPolicy } = deps ?? {}
  if (typeof PiAiAdapter !== 'function') throw new TypeError('createShimAdapter: deps.PiAiAdapter 必填')
  if (typeof createProvider !== 'function') throw new TypeError('createShimAdapter: deps.createProvider 必填')
  if (typeof openAICompletionsApi !== 'function') throw new TypeError('createShimAdapter: deps.openAICompletionsApi 必填')
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('createShimAdapter: providers 不能为空')
  }

  const buildProfiles = () => {
    const profiles = new Map()
    for (const entry of providers) {
      const providerId = entry.id
      const displayName = entry.displayName
      const buildModels = () => entry.buildModels(`${entry.shim.baseUrl()}/v1`)
      const provider = {
        ...createProvider({
          id: providerId,
          name: displayName,
          auth: {
            apiKey: {
              name: 'loopback shim token',
              async resolve({ credential }) {
                const apiKey = credential?.key
                return apiKey === undefined || apiKey.length === 0
                  ? undefined
                  : { auth: { apiKey }, source: displayName }
              },
            },
          },
          models: buildModels(),
          api: openAICompletionsApi(),
        }),
        getModels: buildModels,
      }
      profiles.set(providerId, {
        provider: providerId,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: typeof resolveRetryPolicy === 'function'
          ? resolveRetryPolicy(undefined, `${retryNs}.${providerId}.retryPolicy`)
          : undefined,
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
      })
    }
    return profiles
  }

  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // 每个 provider 的 shim 密钥是这条路出示的唯一凭据。
    resolveApiKey: async (provider) => {
      const entry = providers.find((p) => p.id === provider)
      return entry?.shim.token()
    },
    // 图片输入的持久附件服务（宿主 ctx.get('attachments')）。缺省时 pi-ai 对
    // 带图请求抛 UNSUPPORTED_CONTENT，与宿主未挂附件服务时的语义一致。
    ...(resolveAttachments !== undefined ? { resolveAttachments } : {}),
    ...(resolveImageAccess !== undefined ? { resolveImageAccess } : {}),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
    providerIds: providers.map((p) => p.id),
  }
}
