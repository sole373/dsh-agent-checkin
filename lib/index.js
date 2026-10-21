/**
 * dsh-agent-checkin —— 签到聚合 + 模型接入，两件事在同一个插件里完成。
 *
 *   1. **签到**：`checkin_run` 工具 / `/checkin` 命令 / `GET {statusRoute}/status` 端点。
 *   2. **模型接入**：把各平台背后的 OpenAI / Anthropic 兼容端点写成宿主
 *      `llm-pi-ai` 的 provider 路由，让模型选择器能直接选中它们。
 *
 * 两件事共享同一份平台清单，所以看板里的余额和模型选择器里的模型，指的都是
 * 同一批本机已登录客户端。
 *
 * @module dsh-agent-checkin
 */

import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { CheckinEngine, BUNDLED_ENGINE_DIR } from './engine.js'
import { PLATFORMS, PLATFORM_BY_ID, RESULT_CODES, isLoopbackHost, isLoopbackRequest, normalizeRow, summarize } from './platforms.js'
import { ModelRoutes, SUPPORTED_APIS, SUPPORTED_INPUTS, THINKING_LEVELS } from './models.js'
import { activateTrae } from './connect/trae/index.js'
import { activateQoder } from './connect/qoder/index.js'
import { activateWorkBuddy } from './connect/workbuddy/index.js'
import { activateDumate } from './connect/dumate/index.js'
import { activateLingxi } from './connect/lingxi/index.js'
import { createSelectionHub, parseSelectionForm, selectionFilePath } from './connect/selection.js'
import { renderModelsPage, readFormBody } from './models-page.js'
import { settingsNamespaceOf } from './connect/pi-deps.js'
import { localDay, planRound, readState, statePath, writeState } from './state.js'
import { escapeHtml, renderDashboard } from './dashboard.js'
import { Credentials } from './credentials.js'
import { Logins } from './login.js'
import { Balances } from './balances.js'
import { registerSettingsRoutes, sameOriginOk, settingsRoutePaths } from './settings-routes.js'
import { setAllowClaim as writeAllowClaim } from './allow-claim.js'

export const name = 'dsh-agent-checkin'

/**
 * 不声明 inject：签到、命令、HTTP、模型路由四块都在 apply 内部用 `ctx.inject()`
 * 按需挂载。任何一块所需的宿主服务缺席时，只有那一块不出现，而不是整个插件
 * 加载失败——签到不该因为宿主没装 webServer 就一起不可用。
 *
 * TRAE provider 那块单独说明：它需要 `llm` 服务（宿主的 pi-ai），宿主没有
 * （或用户没开 traeProvider）时静默跳过，不影响签到。
 */
export const inject = []

export const Config = Schema.object({
  pythonCommand: Schema.string()
    .default('python')
    .volatile()
    .description('调用签到引擎所用的 Python 可执行文件'),
  homeDir: Schema.string()
    .default(BUNDLED_ENGINE_DIR)
    .volatile()
    .description(
      '签到引擎根目录（需含 bridge.py 与 adapters/）。默认指向插件自带的 engine/；'
        + '只有想换成自己的检出时才需要改。',
    ),
  timeoutMs: Schema.number()
    .default(180_000)
    .volatile()
    .description('单轮签到超时（毫秒）'),
  allowClaim: Schema.boolean()
    .default(false)
    .volatile()
    .description(
      '是否允许**真实领取**。默认 false：工具与端点只做只读核对（dry-run）。'
        + '签到会真实改变账号余额，必须由你显式开启。'
        + '注意：开启也要求对应客户端本身已在本机登录。',
    ),
  pushResult: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      '手动跑完一轮签到后，是否把结果摘要注入当前会话。'
        + '注入不唤醒模型：内容会在该会话下一次请求时可见。'
        + '定时签到的结果由模型调用工具时自然产生，不依赖这一项。',
    ),
  statusRoute: Schema.string()
    .default('/dsh-agent-checkin')
    .description('看板 HTTP 端点前缀（挂在宿主 web 服务器上）'),
  traeProvider: Schema.boolean()
    .default(false)
    .description(
      '【仅首启种子】TRAE CN 模型接入的初始开关。现在平台接入默认全部尝试，'
        + '开关与模型勾选的权威在看板 `/dsh-agent-checkin/models` 页（改完立即生效，无需重启）；'
        + '本字段只在选择文件尚不存在时被读取一次，之后不再生效。',
    ),
  traeIntlEnabled: Schema.boolean()
    .default(false)
    .description('【仅首启种子】TRAE 国际版（provider id `trae-global`）的初始开关；权威见看板 `/dsh-agent-checkin/models`。'),
  qoderCnEnabled: Schema.boolean()
    .default(false)
    .description('【仅首启种子】Qoder CN（provider id `qoder-cn`）的初始开关；权威见看板 `/dsh-agent-checkin/models`。'),
  wbProvider: Schema.boolean()
    .default(false)
    .description(
      '【仅首启种子】WorkBuddy（provider id `workbuddy`，接管老插件 dsh-connect-workbuddy）'
        + '的初始开关；权威见看板 `/dsh-agent-checkin/models`。'
        + '若老插件仍在，WorkBuddy 组会因重名跳过——先在面板停用老插件。',
    ),
  wbProviderIntl: Schema.boolean()
    .default(false)
    .description('【仅首启种子】WorkBuddy 国际版（provider id `workbuddy-global`）的初始开关；权威见看板 `/dsh-agent-checkin/models`。'),
  modelRoutes: Schema.array(
    Schema.object({
      provider: Schema.string()
        .required()
        .description('DSH provider 路由名（小写字母/数字/连字符），例如 dumate'),
      displayName: Schema.string().description('在模型选择器里显示的名字'),
      api: Schema.string()
        .default('openai-completions')
        .description(`协议：${SUPPORTED_APIS.join(' | ')}`),
      baseURL: Schema.string().required().description('OpenAI/Anthropic 兼容端点根地址'),
      apiKeyEnv: Schema.string()
        .description('存放 API Key 的凭据引用名；省略表示该端点无需凭据'),
      models: Schema.array(
        Schema.object({
          id: Schema.string().required().description('上游模型 id'),
          name: Schema.string().description('展示名'),
          contextWindow: Schema.number().description('上下文窗口（token）'),
          maxTokens: Schema.number().description('单次输出上限（token）'),
          input: Schema.array(Schema.string()).description(`支持的模态：${SUPPORTED_INPUTS.join(' | ')}`),
          reasoningEfforts: Schema.any().description(
            `思考档位映射，例如 { "high": "high" }；传 false 表示明确不支持思考。可选档位：${THINKING_LEVELS.join(' | ')}`,
          ),
        }),
      )
        .required()
        .description('该路由下的模型清单——自定义路由必须逐个列出，不能为空'),
    }),
  )
    .default([])
    .description(
      '要接入 DSH 的模型路由。每一条会被写成宿主 llm-pi-ai 的一段 provider 配置，'
        + '由 `model_route_apply` 工具或 /checkin-models 命令写进当前 profile 的 patch。'
        + '留空则插件只做签到。',
    ),
})

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 看板数据随时间变化，且可能反映余额，禁止中间层缓存。
  'cache-control': 'no-store',
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // 页面自带内联样式，禁止外部资源；即使有注入也拿不到外发通道。
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sendHtml(res, status, html) {
  res.writeHead(status, { ...HTML_HEADERS, 'content-length': Buffer.byteLength(html) })
  res.end(html)
}

/** 403 页面：不解释内部结构，只说明为什么看不到。 */
function forbiddenPage() {
  return `<!doctype html><meta charset="utf-8"><title>403</title>
<body style="font:15px/1.6 system-ui;padding:40px;max-width:640px;margin:0 auto">
<h1 style="font-size:18px">拒绝访问</h1>
<p>签到看板只对本机回环地址开放，请求的 Host 或 Origin 不是本机。</p>
<p>请在运行 DSH 的这台机器上打开，例如
<code>http://127.0.0.1:&lt;端口&gt;/dsh-agent-checkin</code>。</p>`
}

function notFoundPage(prefix) {
  return `<!doctype html><meta charset="utf-8"><title>404</title>
<body style="font:15px/1.6 system-ui;padding:40px;max-width:640px;margin:0 auto">
<h1 style="font-size:18px">没有这个页面</h1>
<p>签到看板：<code>${escapeHtml(prefix)}</code>；模型接入：<code>${escapeHtml(prefix)}/models</code>。</p>`
}

/** 主机名是否为回环地址（含端口形式）。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 工具结果的文本渲染（人类可读内容与规范值分开）。 */
function renderText(text) {
  return { type: 'text', text }
}

/**
 * 命令成功结果。
 *
 * 与工具结果的 `renderText` 是两套东西：`dsh-commands` 的 normalizeResult 只认
 * `{ kind: 'success' | 'error', text? }`，传工具那种 `{ type: 'text' }` 会在注册时
 * 被拒（"handler must return a CommandResult"）。所以两者不能混用。
 */
function cmdOk(text) {
  return { kind: 'success', text }
}

/** 命令失败结果。text 必须非空，退化文案也要有内容。 */
function cmdFail(text) {
  return { kind: 'error', text: text && text.trim() !== '' ? text : '命令执行失败，未获得错误详情。' }
}

/**
 * 解析 `/checkin` 的输入：平台 id 列表 + 是否强制重跑。
 *
 * `--force` 是幂等保护的口子。没有它，一旦某个平台今天已经领过、但用户确实想重跑
 * （比如怀疑上一轮结果不准），就无路可走；有了它，绕过保护必须是**显式**的。
 */
function parseCheckinInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const force = tokens.some((t) => t === '--force' || t === 'force')
  const only = tokens.filter((t) => !t.startsWith('-') && t !== 'force')
  return { only, force }
}

export function apply(ctx, config) {
  const logger = ctx.logger('dsh-agent-checkin')

  /**
   * 读取当前生效的配置。
   *
   * `volatile()` 字段是引用对象（只有 `.get()`），普通字段就是字面值；这里统一
   * 归一化，让调用点不必区分。每次运行都重新读，settings 面板上的修改才真的
   * 生效——在 apply 时解构一次是最容易犯、又最难察觉的错。
   */
  const readConfig = () => {
    const pick = (value) => (value && typeof value.get === 'function' ? value.get() : value)
    return {
      pythonCommand: pick(config.pythonCommand),
      homeDir: pick(config.homeDir),
      timeoutMs: pick(config.timeoutMs),
      allowClaim: pick(config.allowClaim) === true,
      pushResult: pick(config.pushResult) !== false,
      statusRoute: config.statusRoute,
      traeProvider: config.traeProvider,
      traeIntlEnabled: config.traeIntlEnabled === true,
      qoderCnEnabled: config.qoderCnEnabled === true,
      wbProvider: config.wbProvider === true,
      wbProviderIntl: config.wbProviderIntl === true,
      modelRoutes: config.modelRoutes,
    }
  }

  const engine = new CheckinEngine(() => readConfig(), logger)
  const modelRoutes = new ModelRoutes(config.modelRoutes ?? [], logger, {
    // 解析 $DSH_HOME：宿主服务在就交给它，不在就退回环境变量/默认路径。
    homeDir: async () => {
      const paths = ctx.get('homePaths')
      if (paths?.dshHome) return paths.dshHome
      return process.env.DSH_HOME || joinHome()
    },
    // 退化路径的写入目标：当前 profile 的 patch（不是 home patch！）。
    // 只有 profile patch 才真正决定 llm-pi-ai 的 providers。
    targetPath: async () => {
      const profile = ctx.get('profileContext')
      if (profile?.patchPath) return profile.patchPath
      return null
    },
    // 首选路径：宿主 configEditor（保留注释、原子写、失败回滚、热生效）。
    editor: () => ctx.get('configEditor'),
    // configEditor.edit 需要一个具体的 Loader 条目；按 id 找 llm-pi-ai。
    entry: () => {
      const editor = ctx.get('configEditor')
      if (!editor || typeof editor.entries !== 'function') return undefined
      try {
        const match = [...editor.entries()].find((e) => e?.options?.id === 'llm-pi-ai')
        return match
      } catch {
        return undefined
      }
    },
  })

  /**
   * 插件状态目录：`<dshHome>/dsh-agent-checkin`。
   *
   * 放在 dshHome 而不是插件安装目录：市场装的包通常只读，状态必须写到用户可写的位置。
   */
  /** 宿主的 dshHome：状态目录与选择文件的共同根，只在一处解析。 */
  const dshHome = () => {
    const paths = ctx.get('homePaths')
    return paths?.dshHome || process.env.DSH_HOME || joinHome()
  }

  const stateDir = () => join(dshHome(), 'dsh-agent-checkin')

  const stateFile = () => statePath(stateDir())

  // ---- 模型接入选择中心（看板「模型接入」页的后端状态） ----
  //
  // 平台注册是装配期事实（激活期做一次），但「注册了的平台显示不显示、显示哪
  // 些模型」是运行期事实——它归这里管，改了立即生效，不需要重启宿主。落地细节
  // 见 lib/connect/selection.js 顶部注释。
  //
  // 首启种子的来源是老的装配期布尔字段（traeProvider 等）：选择文件还不存在时
  // 把它们迁移进来一次，此后文件是权威，那些字段只保留兼容含义。
  const activationOutcomes = Object.create(null)
  const selectionHub = createSelectionHub({
    // selectionFilePath 自己会拼 <dshHome>/dsh-agent-checkin，这里必须给 **dshHome**，
    // 给 stateDir() 会得到 dsh-agent-checkin/dsh-agent-checkin/model-selection.json（曾发生过）。
    filePath: () => selectionFilePath(dshHome()),
    seed: () => {
      const cfg = readConfig()
      return {
        trae: { enabled: cfg.traeProvider === true },
        'trae-global': { enabled: cfg.traeIntlEnabled === true },
        'qoder-cn': { enabled: cfg.qoderCnEnabled === true },
        workbuddy: { enabled: cfg.wbProvider === true },
        'workbuddy-global': { enabled: cfg.wbProviderIntl === true },
      }
    },
    onWarn: (message) => logger.warn('dsh-agent-checkin: %s', message),
  })

  /**
   * 「模型接入」页的行数据：选择中心读到的注册平台（附实时模型清单）+
   * 没注册成 功/没注册 的平台（附原因）。渲染与解析共用这一份，保证勾选的
   * id 一定来自当下真实存在的清单。
   */
  const modelsViewRows = () => {
    return selectionHub.describeAll().map((row) => {
      if (row.attached) {
        return { ...row, selectable: true, statusKind: 'live', statusText: row.statusText ?? '已接入' }
      }
      const outcome = activationOutcomes[row.platform]
      const anySiblingAttached = selectionHub
        .describeAll()
        .some((other) => other.platform === row.platform && other.attached)
      let statusText
      if (anySiblingAttached) {
        statusText = '本机登录的客户端不是这个区（例如登录的是国内版，这里的国际版就不适用）'
      } else {
        statusText = activationReasonText(outcome?.reason ?? undefined)
      }
      return { ...row, selectable: false, statusKind: outcome ? 'failed' : 'pending', statusText, models: [] }
    })
  }

  /** 装配期失败原因 → 页面可读文案（含用户下一步该做什么）。 */
  const activationReasonText = (reason) => {
    if (reason === undefined) return '尚未尝试接入（宿主启动后未运行过模型接入装配）'
    const map = {
      disabled: '装配期开关未启用（老配置路径，会被看板选择取代）',
      'no-credential': '本机没有读到登录态——请先打开该平台客户端登录，然后重启宿主',
      'settings-ns-missing': '宿主配置命名空间缺失，无法注册 provider 目录',
      'pi-deps-unavailable': '宿主 pi 依赖不可用（插件未运行在宿主内）',
      'duplicate-adapter': '与老插件 dsh-connect-workbuddy 重名——请先停用/卸载老插件，然后重启宿主',
      'register-failed': 'provider 注册失败（详见宿主日志）',
      'adapter-failed': 'adapter 装配失败（详见宿主日志）',
      'intl-disabled': '国际区未启用（当前只注册本机登录的那个区）',
    }
    return map[reason] ?? `接入失败：${reason}`
  }

  /**
   * 设置页「平台与模型」的保存动作（JSON 载荷，由 settings-routes 校验过 Origin 后调用）。
   *
   * 校验纪律与浏览器看板的表单路径一致：**只认当下真实存在的注册平台**，模型 id
   * 必须落在该平台实时清单里——页面可能是几分钟前渲染的，目录可能已经刷掉了某个
   * 模型；把过期 id 存进选择文件只会让选择器里出现一个「点了没反应」的条目。
   *
   * 返回值里带 `providers`（保存后的完整行数据），让面板无需再发一次 GET 就能
   * 把页面刷成服务端事实；`changed` 为空说明这次点击什么都没改（如实告知）。
   */
  const saveModelsSelection = (input) => {
    const providers = input?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
      return { ok: false, status: 'invalid', detail: 'providers 必须是对象：{ [providerId]: { enabled, modelIds | all } }' }
    }
    const rows = modelsViewRows()
    const byId = new Map(rows.map((row) => [row.id, row]))
    /** @type {Record<string, {enabled?: boolean, modelIds?: string[]|null}>} */
    const updates = {}
    const rejected = []
    for (const [pid, patch] of Object.entries(providers)) {
      const row = byId.get(pid)
      if (row === undefined || row.selectable !== true) {
        rejected.push(pid)
        continue
      }
      if (patch === null || typeof patch !== 'object') {
        rejected.push(pid)
        continue
      }
      const enabled = patch.enabled === true
      // 图片开关是**独立的**每模型清单，与平台开关、模型白名单互不牵连：关掉平台
      // 不该丢掉用户勾好的图片，重新打开时要原样回来。因此载荷里没带 `imageIds`
      // 就保持现状——老前端（以及只看模型的调用方）不会被这次扩字段影响。
      //
      // 三态语义与 selection.js 一致：`null` = 跟随模型原生能力（默认）、`[]` =
      // 全部禁止、`[...]` = 白名单。数组同样与当下清单求交，目录里已下线的模型
      // 不会残留成一条「勾了但没有这个模型」的记录。
      const allowed = new Set((row.models ?? []).map((model) => model.id))
      /** @type {string[]|null|undefined} undefined = 本次不改。 */
      let imageIds
      if ('imageIds' in patch) {
        if (patch.imageIds === null) {
          imageIds = null
        } else if (Array.isArray(patch.imageIds)) {
          imageIds = patch.imageIds.filter((id) => typeof id === 'string' && allowed.has(id))
        } else {
          rejected.push(pid)
          continue
        }
      }
      const imagePart = imageIds === undefined ? {} : { imageIds }
      if (!enabled) {
        updates[pid] = { enabled: false, ...imagePart }
        continue
      }
      // `all: true` 与 `modelIds: null` 同义：跟随客户端清单自动增减。
      if (patch.all === true || patch.modelIds === null || patch.modelIds === undefined) {
        updates[pid] = { enabled: true, modelIds: null, ...imagePart }
        continue
      }
      if (!Array.isArray(patch.modelIds)) {
        rejected.push(pid)
        continue
      }
      updates[pid] = {
        enabled: true,
        modelIds: patch.modelIds.filter((id) => typeof id === 'string' && allowed.has(id)),
        ...imagePart,
      }
    }
    const changed = selectionHub.update(updates)
    if (changed.length > 0) {
      logger.info('设置页更新了模型接入选择：%s（已通知宿主刷新模型选择器）', changed.join(', '))
    }
    return { ok: true, changed, rejected, providers: modelsViewRows() }
  }

  /** 最近一轮结果，供端点读取而不必每次重跑。 */
  let lastRun = null
  /** 同一时刻只允许一轮签到在跑，避免并发触发重复领取。 */
  let inFlight = null
  /**
   * 最近一次「跑起来就抛异常」的原因（面板触发的那条链路）。
   *
   * 面板用轮询取结果，抛出的异常没人 await，不在这里留住就会变成一条只进日志的
   * 静默失败——面板会一直显示「没有结果」，用户看不出到底是没跑还是跑挂了。
   */
  let lastRunError = null
  /** 是否已尝试从磁盘恢复过（只试一次，避免每次读盘）。 */
  let restoreAttempted = false

  /**
   * 从磁盘恢复上一轮结果。
   *
   * 只在第一次需要时读一次：状态文件在宿主生命周期内不会由别的进程改（本插件是唯一写者），
   * 每次 `/checkin-status` 都读盘没有收益。
   */
  const ensureRestored = () => {
    if (restoreAttempted) return
    restoreAttempted = true
    const stored = readState(stateFile())
    if (stored) {
      lastRun = {
        ...stored,
        // 从盘上读回的结果标注出来源，让界面能区分「这是这次刚跑的」还是「上次留下的」。
        restored: true,
      }
      logger.info('已从磁盘恢复上一轮签到结果（%s）', stored.finishedAt ?? '时间未知')
    }
  }

  const executeRun = async ({ dryRun, only, force, signal }) => {
    // 关键安全默认：未开启 allowClaim 时，一律降级为只读核对。
    // 每次运行现读，面板上关掉会立刻在下一次运行生效（不是下次重启）。
    const effectiveDryRun = dryRun || !readConfig().allowClaim
    ensureRestored()
    const today = localDay()

    // 幂等：同一自然日内已成功领取过的平台不再重领。
    // 演练（effectiveDryRun）时不做跳过，只读核对重复跑没有代价。
    const plan = planRound({
      only,
      previous: lastRun,
      today,
      dryRun: effectiveDryRun,
      force: force === true,
      platforms: PLATFORMS,
    })

    // 全部平台今天都领过了：不发任何请求，如实返回跳过结果。
    // 这不是失败，也不能算成功——它是第三种状态，独立报告。
    if (plan.run.length === 0 && plan.skipped.length > 0) {
      lastRun = {
        dryRun: false,
        source: 'skipped',
        generatedAt: null,
        elapsedMs: 0,
        claimed: false,
        downgraded: false,
        allSkipped: true,
        day: today,
        skipped: plan.skipped,
        rows: plan.skipped.map((s) => ({
          id: s.id,
          name: s.name,
          unit: PLATFORM_BY_ID.get(s.id)?.unit ?? '',
          claiming: true,
          code: 'ALREADY',
          codeLabel: `今日已完成（${s.code}），未重复请求`,
          bucket: 'success',
          detail: '幂等跳过：今天已经成功领取过。要强制重跑请加 force。',
          balance: null,
          balanceNote: '',
          balanceSource: 'none',
        })),
        summary: null,
        finishedAt: new Date().toISOString(),
        restored: false,
      }
      lastRun.summary = summarize(lastRun.rows)
      writeState(stateFile(), lastRun)
      return lastRun
    }

    const result = await engine.run({
      dryRun: effectiveDryRun,
      only: plan.run.length > 0 ? plan.run : undefined,
      signal,
    })
    const rows = result.rows.map(normalizeRow)
    lastRun = {
      ...result,
      // 如实标注：这一轮到底有没有真的领取。
      claimed: result.dryRun === false,
      downgraded: !dryRun && effectiveDryRun,
      allSkipped: false,
      day: today,
      skipped: plan.skipped,
      rows,
      summary: summarize(rows),
      finishedAt: new Date().toISOString(),
      restored: false,
    }
    // 落盘失败不影响本轮结果：存不下状态不该把一次成功的签到变成失败。
    if (!writeState(stateFile(), lastRun)) {
      logger.warn('签到结果未能写入状态文件：%s', stateFile())
    }
    return lastRun
  }

  const runOnce = (options) => {
    if (inFlight) return inFlight
    const controller = new AbortController()
    const outer = options.signal
    const onAbort = () => controller.abort()
    outer?.addEventListener('abort', onAbort, { once: true })
    lastRunError = null
    inFlight = executeRun({ ...options, signal: controller.signal }).finally(() => {
      outer?.removeEventListener('abort', onAbort)
      inFlight = null
    })
    return inFlight
  }

  /**
   * 面板上的「立即签到」按钮走这里：起一轮，**不等它跑完**就返回。
   *
   * 为什么不在 HTTP 处理器里 await 完整一轮：spawn Python 打十个平台要几十秒，
   * 期间面板只能干转圈；一旦浏览器超时或用户刷新，请求就断了，而签到还在后台跑。
   * 所以这里只负责「起没起来」，结果由 `settingsState().lastRun` 轮询取。
   *
   * 返回值必须让调用方分清三件事，不能都用 `ok` 糊过去：
   *   · 已经在跑了 → `alreadyRunning: true`，没有新起一轮（runOnce 会复用 inFlight）；
   *   · 这一轮已经跑完了（缓存命中，通常是几毫秒内的第二次点击）→ `finished: true`；
   *   · 还在跑 → `running: true`。
   */
  const startPanelRun = ({ force }) => {
    // runOnce 在已有一轮在跑时会**复用**那个 promise，不再发一轮请求——
    // 这正是我们要的（重复点击不能变成重复领取），但必须如实告诉面板。
    const reused = inFlight !== null
    const cfg = readConfig()
    const promise = runOnce({ dryRun: false, force: force === true })
    // 异常必须留住：面板是轮询取结果的，没人 await 这个 promise。
    promise.catch((error) => {
      lastRunError = errorMessage(error)
      logger.warn('面板触发的签到失败：%s', lastRunError)
    })
    return {
      started: true,
      // 复用一节正在跑的：没起新一轮，但确实在跑。
      alreadyRunning: reused,
      // executeRun 是 async，赋值后 inFlight 一定非空；这里仍按实际值算，
      // 免得哪天实现改成同步返回时这个字段开始撒谎。
      running: inFlight !== null,
      // 面板要能提前告诉用户「这一轮会不会真的领取」，不让他点完才发现是只读。
      willClaim: cfg.allowClaim,
      allowClaim: cfg.allowClaim,
    }
  }

  const describe = () => ({
    platforms: PLATFORMS,
    allowClaim: readConfig().allowClaim,
    models: modelRoutes.describe(),
  })

  /**
   * 看板用的逐平台当前积分（与 settingsState().balances 同一数据源）。
   *
   * 和 settingsState 里那份的区别只是时机：面板每次 refresh 都会重取，
   * 看板每次页面渲染取一次。合成逻辑（实测优先/手动兜底/来源标签）只在
   * describeBalances 一处，两边不会各说各话。
   */
  const dashboardBalances = async () => {
    try {
      return await describeBalances()
    } catch (error) {
      // 渲染看板时余额清单取不到不该拖垮整页——renderDashboard 对 null 的
      // 处理是「不渲染这一节」，页面其余部分照常。
      logger.warn('看板取逐平台积分失败（本节跳过）：%s', errorMessage(error))
      return null
    }
  }

  // ---- 凭证面：状态 / 校验 / 落盘 / 清除 ----
  //
  // 单独一个门面而不是散在 HTTP 处理器里：它要 spawn Python 子进程，
  // 逻辑量超过一个路由该有的体量，而且测试时要能脱离 webServer 直接调用。
  const credentials = new Credentials(() => readConfig(), logger)

  // ---- 登录采集：在面板里直接发起「弹出浏览器 → 登录 → 自动保存 Cookie」 ----
  //
  // 与 credentials 分开：那一个是几秒答完的 RPC，这一个是几分钟的等人过程。
  // 注册表存在插件实例上，所以同一个平台的登录在整轮会话里只有一份状态，
  // 面板刷新、重新打开都不会「忘记」正在跑的那次登录。
  const logins = new Logins(() => readConfig(), logger)
  // 插件被卸载/DSH 退出时结束在跑的浏览器，别把登录窗口留成孤儿。
  ctx.on?.('dispose', () => logins.dispose())

  // ---- 手动积分：实测优先、用户可改的「每个产品当前积分」 ----
  //
  // 有的平台（phanthywork）没有余额接口，有的平台用户想记引擎看不到口径的数。
  // 手动值永远带「手动」标签展示，绝不冒充实测值；存储在 <dshHome>/dsh-agent-checkin。
  const balances = new Balances({ dir: stateDir, logger })

  /**
   * 开关「真实领取」。
   *
   * 走宿主的 `configEditor.edit()` 把自己的配置写回 profile patch。因为
   * `allowClaim` 在 Config 里声明了 `.volatile()`，Loader 对「只翻这一个字段」
   * 的变更走纯 volatile 热提交：写进运行中的引用、不 dispose、不重启，
   * 所以 `readConfig()` 下一次调用就是新值，面板立刻显示已开启。
   *
   * 具体机制、以及为什么不做「直接改文本」的退化路径，见 `lib/allow-claim.js`。
   */
  const setAllowClaim = async (enabled) => {
    const result = await writeAllowClaim({
      editor: ctx.get('configEditor'),
      enabled,
      current: readConfig().allowClaim,
      logger,
    })
    if (result.changed) {
      logger.info('allowClaim 已改为 %s（configEditor 热写入，无需重启）', enabled)
    }
    return result
  }

  /**
   * 「每个产品当前积分」逐平台汇总：实测优先，手动兜底，来源可查。
   *
   * 合成在服务端一次做完（而不是发给前端两份数据让它自己合）：
   * 优先级只有这一处说了算，面板与看板不会各自推出一份不一致的口径。
   * 实测值来自上一轮结果（没有跑过 = 没有），不是现查——现查要跑完整一轮。
   */
  const describeBalances = async () => {
    ensureRestored()
    const measuredById = new Map(
      (Array.isArray(lastRun?.rows) ? lastRun.rows : []).map((row) => [row.id, row]),
    )
    const out = []
    for (const platform of PLATFORMS) {
      const row = measuredById.get(platform.id)
      const resolved = await balances.resolve(platform.id, {
        balance: typeof row?.balance === 'number' ? row.balance : null,
        balanceSource: row?.balanceSource ?? null,
      })
      out.push({
        platform: platform.id,
        name: platform.name,
        unit: platform.unit ?? '',
        claiming: platform.claiming === true,
        // `measured` 一侧的实测信息（可能是 null——从没跑过或没读到）。
        measuredBalance: typeof row?.balance === 'number' ? row.balance : null,
        measuredAt: lastRun?.finishedAt ?? null,
        measuredNote: row?.balanceNote ?? '',
        measuredSource: row?.balanceSource ?? null,
        // 合成后的展示值与来源：'measured' | 'manual' | 'none'。
        balance: resolved.balance,
        source: resolved.source,
        note: resolved.detail ?? '',
        manual: resolved.manual,
      })
    }
    return out
  }

  /** 面板「手动积分」写操作：value 为 null 表示清除该平台的手动值。 */
  const setBalance = ({ platform, value, note } = {}) =>
    balances.set({ platform, value: value === undefined ? undefined : value, note })

  /**
   * 把一轮结果压成面板能直接渲染的形状。
   *
   * 刻意不把整个 `lastRun` 原样丢出去，而是**逐字段摘**：这份载荷会进浏览器，
   * 里面不该有多余的引擎内部字段（比如 Python 侧路径）。余额与结果码原样保留——
   * 面板的展示纪律是「读到了就必须显示」，在服务端删字段就等于让前端无米下锅。
   */
  const serializeRun = (run) => {
    if (!run) return null
    const rows = Array.isArray(run.rows) ? run.rows : []
    return {
      day: run.day ?? null,
      claimed: run.claimed === true,
      dryRun: run.dryRun === true,
      downgraded: run.downgraded === true,
      allSkipped: run.allSkipped === true,
      restored: run.restored === true,
      source: run.source ?? null,
      finishedAt: run.finishedAt ?? run.generatedAt ?? null,
      elapsedMs: run.elapsedMs ?? null,
      summary: run.summary ?? null,
      // 逐平台明细：面板要能显示「哪个平台成功、余额多少」，只给汇总数字没法用。
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        unit: row.unit ?? '',
        claiming: row.claiming === true,
        code: row.code ?? null,
        codeLabel: row.codeLabel ?? '',
        bucket: row.bucket ?? 'unknown',
        detail: row.detail ?? '',
        // `balance: null` 与「余额是 0」是两件事，别在前端用 `||` 归一。
        balance: typeof row.balance === 'number' ? row.balance : null,
        balanceNote: row.balanceNote ?? '',
      })),
      skipped: Array.isArray(run.skipped)
        ? run.skipped.map((s) => ({ id: s.id, name: s.name, code: s.code ?? null }))
        : [],
    }
  }

  /** 设置页首屏要的全部状态：静态表 + 凭证落盘状态 + 上一轮结果，不联网。 */
  const settingsState = async () => {
    const cfg = readConfig()
    ensureRestored()
    return {
      ok: true,
      at: new Date().toISOString(),
      allowClaim: cfg.allowClaim,
      // 面板要能如实显示「这些平台本轮不会真的领取」，所以把 claiming 一并带上。
      platforms: PLATFORMS,
      credentials: await credentials.describeWithState(),
      // 登录进行到哪一步（只有两个可录入平台有这一项）。
      logins: logins.states(),
      // 每个平台「当前积分」：实测优先、手动兜底，每项带来源标签。
      balances: await describeBalances(),
      models: modelRoutes.describe(),
      // 设置页「平台与模型」页签的行数据：哪个平台已注册、它的实时模型清单、
      // 当前勾了什么。与浏览器看板同源（同一份 modelsViewRows），两处不会各说各话。
      modelsProviders: modelsViewRows(),
      lastRun: serializeRun(lastRun),
      // 面板上的「立即签到」是异步起的，页面靠这两个字段判断进度与失败。
      // `running` 只说明「有一轮在跑」，不说明它会成功——结论永远看 lastRun。
      running: inFlight !== null,
      lastRunError,
      // 目前这一轮会不会真的领取：allowClaim=false 时即使有人点了「签到」也只会核对。
      // 把结论直接算在服务端，避免前端自己推断出一份不一致的口径。
      willClaim: cfg.allowClaim,
      dashboardUrl: `${config.statusRoute.replace(/\/+$/, '') || '/dsh-agent-checkin'}`,
    }
  }

  // ---- 工具面：签到 + 模型路由落盘 ----
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() =>
      tctx.tools.register(
        defineCheckinTool({ runOnce, getLastRun: () => lastRun, describe }),
      ),
    )
    tctx.effect(() =>
      tctx.tools.register(defineModelRouteTool({ modelRoutes })),
    )
  })

  // ---- 命令面：面向人的入口 ----
  //
  // 契约照宿主 `dsh-commands` 的 normalizeDefinition/normalizeResult 写：
  //   · 处理器字段名是 `handler`（不是 execute），签名 ({ agent, rawInput, attachments, signal })
  //   · `input` 是对象 `{ hint }`，不是字符串
  //   · 返回值必须是 CommandResult `{ kind: 'success' | 'error', text? }`
  // 任一条不符，宿主会在注册时抛 TypeError，整个命令面消失且界面不提示。
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() =>
      cctx.commands.register({
        name: 'checkin',
        description: '对已安装的 AI 客户端执行一轮签到（默认只读核对）',
        input: { hint: '可选：平台 id（逗号分隔，如 trae,dumate）；加 --force 绕过当天幂等' },
        async handler({ agent, rawInput, signal }) {
          const { only, force } = parseCheckinInput(rawInput)
          try {
            const run = await runOnce({ dryRun: false, only, force, signal })
            const text = formatRun(run)
            // 手动链路的结果推送：把摘要 inject 进当前会话，不唤醒模型。
            // 命令结果本身已经给了用户，所以推送失败只记日志、不改命令结果——
            // 用户看到的是签到结果，不该因为附带推送没成功而变成「失败」。
            if (readConfig().pushResult) {
              pushToAgent(agent, `【dsh-agent-checkin】上一轮结果已归档，供后续对话参考。\n\n${text}`)
            }
            return cmdOk(text)
          } catch (error) {
            return cmdFail(`签到失败：${errorMessage(error)}`)
          }
        },
      }),
    )
    cctx.effect(() =>
      cctx.commands.register({
        name: 'checkin-status',
        description: '查看上一轮签到结果与各平台余额',
        async handler() {
          if (!lastRun) return cmdOk('还没有跑过签到。发送 `/checkin` 开始一轮。')
          return cmdOk(formatRun(lastRun))
        },
      }),
    )
    cctx.effect(() =>
      cctx.commands.register({
        name: 'checkin-models',
        description: '把配置里的模型路由写进当前 profile，让它们出现在模型选择器里',
        async handler() {
          try {
            return cmdOk(formatApply(await modelRoutes.apply()))
          } catch (error) {
            return cmdFail(`写入模型路由失败：${errorMessage(error)}`)
          }
        },
      }),
    )
    cctx.effect(() =>
      cctx.commands.register({
        name: 'checkin-schedule',
        description: '管理每日自动签到：on [HH:mm] 开启，off 关闭，status 查看',
        input: { hint: 'on [HH:mm] | off | status（默认 09:00）' },
        async handler({ agent, rawInput }) {
          try {
            return await handleScheduleCommand(agent, rawInput)
          } catch (error) {
            return cmdFail(`定时签到操作失败：${errorMessage(error)}`)
          }
        },
      }),
    )
  })

  // ---- HTTP 面：只读看板 + 设置面板后端 ----
  ctx.inject(['webServer'], (wctx) => {
    const prefix = config.statusRoute.replace(/\/+$/, '') || '/dsh-agent-checkin'

    // 设置面板的读/写接口。全部挂在与看板同一个 webServer / 同一个端口上，
    // 不另起监听——否则用户要记住两个地址，而且多一个对外暴露面。
    registerSettingsRoutes(wctx, {
      prefix,
      getState: settingsState,
      credentials,
      logins,
      // 设置页能做的写事：开关真实领取、立即跑一轮、预览/写入模型路由、
      // 改每个平台的手动积分。每一件都复用已存在的实现，不新写一套落盘逻辑。
      actions: {
        setAllowClaim,
        startRun: startPanelRun,
        runState: () => ({
          ok: true,
          running: inFlight !== null,
          lastRunError,
          lastRun: serializeRun(lastRun),
        }),
        setBalance,
        previewModels: () => modelRoutes.apply({ dryRun: true }),
        applyModels: () => modelRoutes.apply(),
        // 「平台与模型」页签的保存（设置页内直接改，免重启生效）。
        saveModelsSelection,
      },
      logger,
      effect: (fn) => wctx.effect(fn),
    })

    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/status`,
        async handler(req, res) {
          // 端点只服务本机看板：非回环的 Host/Origin 一律拒绝，避免同机其它
          // 来源（或经 DNS rebinding 伪装的外部页面）读到签到状态。
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { error: 'forbidden' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const meta = describe()
          ensureRestored()
          if (!lastRun) {
            sendJson(res, 200, {
              ok: true,
              empty: true,
              hint: '还没有跑过签到；在 dsh 里发送 /checkin，或调用 checkin_run 工具。',
              ...meta,
            })
            return
          }
          sendJson(res, 200, { ok: true, ...meta, ...lastRun })
        },
      }),
    )
    // ---- 看板「模型接入」页：第二个页签 ----
    //
    //   GET  {prefix}/models       读选择中心 + 各平台实时目录，渲染勾选页
    //   POST {prefix}/models/save  保存勾选 → 立即让宿主重画模型选择器（不重启）
    //
    // 与 /status 一样只服务回环；写接口额外要求同源 Origin，且表单里的模型 id
    // 会严格对回当下的真实目录（parseSelectionForm），手改出来的 id 直接丢弃。
    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/models`,
        async handler(req, res) {
          if (!isLoopbackRequest(req)) {
            sendHtml(res, 403, forbiddenPage())
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendHtml(res, 405, '<!doctype html><meta charset="utf-8"><p>只接受 GET；保存请用页面上的表单。</p>')
            return
          }
          sendHtml(res, 200, renderModelsPage({ prefix, rows: modelsViewRows() }))
        },
      }),
    )
    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/models/save`,
        async handler(req, res) {
          if (!isLoopbackRequest(req)) {
            sendHtml(res, 403, forbiddenPage())
            return
          }
          if (req.method !== 'POST') {
            sendHtml(res, 405, '<!doctype html><meta charset="utf-8"><p>只接受 POST。</p>')
            return
          }
          // 写出选择状态属于写操作：必须带同源 Origin，挡掉同机其它页面的跨站提交。
          const origin = sameOriginOk(req)
          if (!origin.ok) {
            sendJson(res, 403, { error: 'forbidden', reason: origin.reason })
            return
          }
          const body = await readFormBody(req)
          if (!body.ok) {
            sendJson(res, 400, { error: 'bad-request', reason: body.reason })
            return
          }
          let changed = []
          try {
            // 行数据现取：目录可能在上次渲染之后刷新过，用旧清单解析等于放行过期 id。
            changed = selectionHub.update(parseSelectionForm(body.params, modelsViewRows()))
          } catch (error) {
            logger.warn('模型接入选择保存失败：%s', errorMessage(error))
            sendHtml(res, 500, `<!doctype html><meta charset="utf-8"><p>保存失败：${escapeHtml(errorMessage(error))}</p>`)
            return
          }
          if (changed.length > 0) {
            logger.info('模型接入选择已更新：%s（已通知宿主刷新模型选择器）', changed.join(', '))
          }
          // 303 回 GET：刷新页面不会重复提交，浏览器地址栏也停在干净的 URL 上。
          res.writeHead(303, { location: `${prefix}/models`, 'content-length': 0 })
          res.end()
        },
      }),
    )
    // 人类看板。挂在 prefix 前缀上（kind 非 exact 即最长前缀匹配），
    // 所以 `{prefix}`、`{prefix}/` 都命中；/status、/models 由上面的 exact 路由优先吃掉。
    wctx.effect(() =>
      wctx.webServer.register({
        kind: 'prefix',
        path: prefix,
        async handler(req, res) {
          if (!isLoopbackRequest(req)) {
            sendHtml(res, 403, forbiddenPage())
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendHtml(res, 405, '<!doctype html><meta charset="utf-8"><p>只接受 GET。')
            return
          }
          // 子路径只服务根页面。看板是单文件，没有静态资源可发；
          // 404 比回退到首页更诚实——不会让人以为某个子路径真的存在。
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
          if (pathname.replace(/\/+$/, '') !== prefix) {
            sendHtml(res, 404, notFoundPage(prefix))
            return
          }
          ensureRestored()
          const meta = describe()
          let html
          try {
            html = renderDashboard({
              run: lastRun,
              meta,
              statusUrl: `${prefix}/status`,
              modelsUrl: `${prefix}/models`,
              balances: await dashboardBalances(),
            })
          } catch (error) {
            // 渲染炸了也要给出一页可读的文字，不能返回半截 HTML。
            logger.warn('看板渲染失败：%s', errorMessage(error))
            html = renderDashboard({
              run: lastRun,
              meta,
              statusUrl: `${prefix}/status`,
              modelsUrl: `${prefix}/models`,
              error: `页面渲染出错：${errorMessage(error)}`,
            })
          }
          sendHtml(res, 200, html)
        },
      }),
    )
  })

  // ---- 模型接入：把本机已登录的客户端挂成模型 provider（新架构，五层同构） ----
  //
  // 三个平台（TRAE / Qoder / WorkBuddy）共用 lib/connect/ 的 shim+adapter+registry
  // 骨架，各自独立激活、独立失败：任何一个平台没登录、装配失败或被老插件占名，
  // 都只影响它自己的模型组，绝不拖垮签到与其它平台。
  //
  // 「装不装」和「显示什么」是两件事，分别归两层管：
  //   - 注册是装配期事实。provider 没注册就永远不可能出现在模型选择器里，所以这里
  //     一律把三个平台都试一遍（真没登录态的平台自己会跳过，行为与旧版一致）。
  //     老的 traeProvider 等布尔字段不再是开关，只在选择文件还不存在时当一次种子。
  //   - 显示哪个平台、显示它下面哪些模型，是运行期事实，归 selectionHub：adapter
  //     每次重画模型清单/目录发现都会重新向它要一遍，看板保存后 emit 一次
  //     llm/adapters-updated 就当场生效——不需要重启宿主。
  ctx.inject(['llm'], (lctx) => {
    const settingsNs = settingsNamespaceOf(lctx)
    /** @type {Array<[string, Function]>} 平台在激活器里的选项由 selection 接管。 */
    const platforms = [
      ['TRAE', activateTrae],
      ['Qoder', activateQoder],
      ['WorkBuddy', activateWorkBuddy],
      ['DuMate', activateDumate],
      ['Lingxi', activateLingxi],
    ]
    // 选择变了 → 让宿主重画模型选择器。订阅本身包在 effect 里，dispose 自动退订。
    lctx.effect(
      () =>
        selectionHub.subscribe((changedIds) => {
          try {
            lctx.emit?.('llm/adapters-updated')
            logger.info('模型接入选择已变更：%s', changedIds.join(', '))
          } catch (error) {
            // 通知失败不影响「选择已生效」：下一次清单构建仍会读到新状态。
            logger.warn('通知宿主刷新模型选择器失败：%s', errorMessage(error))
          }
        }),
      'dsh-agent-checkin.selection',
    )
    lctx.effect(async () => {
      for (const [label, activate] of platforms) {
        try {
          // enabled/intlEnabled 保留为 true 只为兼容激活器里的老判定分支；
          // 实际可见性由 selection 决定（见 lib/connect/selection.js 顶部注释）。
          const result = await activate(lctx, {
            enabled: true,
            intlEnabled: true,
            settingsNs,
            logger,
            selection: selectionHub,
          })
          activationOutcomes[label] = result ?? { ok: false, reason: 'unknown' }
          if (!result?.ok) {
            logger.warn('%s 模型接入未注册（不影响签到与其它平台）：%s', label, result?.reason ?? '未知原因')
          } else {
            logger.info('%s 模型接入已注册：%s', label, (result.providerIds ?? []).join(', '))
          }
        } catch (error) {
          activationOutcomes[label] = { ok: false, reason: errorMessage(error) }
          logger.warn('%s 模型接入装配异常（不影响签到与其它平台）：%s', label, errorMessage(error))
        }
      }
    }, 'dsh-agent-checkin.connect')
  })

  // ---- 启动自检：失败只给诊断，不打断激活 ----
  ctx.effect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const info = await engine.probe()
        if (cancelled) return
        logger.info('签到引擎就绪：Python %s，桥接脚本 %s', info.python, info.script)
      } catch (error) {
        if (cancelled) return
        logger.warn('签到引擎不可用（插件其余部分仍可加载）：%s', errorMessage(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, 'dsh-agent-checkin.probe')

  // ---- 每日定时 + 结果推送 ----
  //
  // 两条宿主事实决定了这里的形状，先写清楚免得后来人「优化」掉：
  //
  // 1. 宿主 Schedule 只能把提醒投递进**某个已存在的会话**（`create(sessionId, ...)`），
  //    它没有「插件自己的宿主级定时器」。所以定时任务必须绑定到一个会话，
  //    这里绑定发起 `/checkin-schedule on` 的那个会话。
  // 2. Schedule 的投递回执只证明「消息进了收件箱」，不证明模型跑过；插件也拿不到
  //    「定时器触发」的回调。所以签到必须在**提醒文本让模型去调用 checkin_run** 这条
  //    链路上完成，而不是指望插件自己在到点时被叫醒。
  //
  // 结果推送因此分两种，都不伪造「已推送成功」：
  //   · 定时链路：模型收到提醒 → 调 checkin_run → 工具结果就是推送本身。
  //   · 手动链路：`/checkin` 跑完后，把摘要 inject 进当前会话（不唤醒），
  //     该会话下一次请求时可见。
  const scheduleState = {
    /** 当前由本插件创建的每日任务 id（每会话一条）。 */
    taskId: null,
    sessionId: null,
  }

  /** 定时提醒正文：明确要求模型去调用工具，而不是自己编造结果。 */
  const reminderPrompt = () =>
    '该做今天的签到核对了。请调用 checkin_run 工具执行一轮（不传 dryRun 时由插件配置决定'
    + '是真实领取还是只读核对；结果里会写明本轮到底是哪一种）。拿到结果后：'
    + '按平台逐条报告状态与余额，标出失败或环境受阻的平台，'
    + '并提醒各平台积分是不同币种、不要跨平台相加。'
    + '如果你没有 checkin_run 工具，就如实说明本插件未挂载，不要臆造签到结果。'

  const scheduleTitle = () => 'dsh-agent-checkin：每日签到'

  const DEFAULT_DAILY_TIME = '09:00'

  /** 把当前定时状态整理成人类可读文本。 */
  const describeSchedule = (extra, activeTime) => {
    const cfg = readConfig()
    const lines = []
    if (scheduleState.taskId) {
      lines.push(
        `每日自动签到：已开启，每天 ${activeTime ?? '（时间见宿主任务表）'}（本机时区）`,
      )
      lines.push(`绑定会话：${scheduleState.sessionId}`)
      lines.push(`任务 id：${scheduleState.taskId}`)
      lines.push('到点时本会话会收到一条提醒，由模型调用 checkin_run 完成签到。')
    } else {
      lines.push('每日自动签到：未开启')
      lines.push(
        `用 \`/checkin-schedule on ${DEFAULT_DAILY_TIME}\` 在当前会话开启`
          + `（时间可省略，默认 ${DEFAULT_DAILY_TIME}）。`,
      )
    }
    lines.push(`allowClaim=${cfg.allowClaim ? 'true（会真实领取积分）' : 'false（只读核对）'}`)
    if (!cfg.allowClaim) {
      lines.push('⚠️ 当前 allowClaim=false：即使定时提醒触发并调用了工具，本轮也只会核对、不会领取。')
    }
    if (extra) lines.push('', extra)
    return lines.join('\n')
  }

  /**
   * 把消息注入会话，不唤醒模型。
   *
   * `inject()` 与 `followup()` 的区别是关键：inject 落在下一个被接纳的步骤里，
   * 不会打断或唤醒空闲会话。签到结果属于「该知道但不该打断」的信息，选 inject。
   * 拿不到 agent 时如实返回 false，让调用方知道没推成，而不是假装推过。
   */
  const pushToAgent = (agent, text) => {
    if (!agent || typeof agent.inject !== 'function') return false
    try {
      agent.inject({
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-agent-checkin' },
      })
      return true
    } catch (error) {
      logger.warn('结果推送失败：%s', errorMessage(error))
      return false
    }
  }

  /** 校验 HH:mm，返回规范化后的 `HH:mm:ss`；非法返回 null。 */
  const normalizeDailyTime = (raw) => {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw ?? '').trim())
    if (!m) return null
    const hour = Number(m[1])
    const minute = Number(m[2])
    const second = m[3] === undefined ? 0 : Number(m[3])
    if (hour > 23 || minute > 59 || second > 59) return null
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  }

  /** 本机时区名（IANA）。取不到就如实报错，不猜一个时区糊过去。 */
  const localTimeZone = () => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return typeof zone === 'string' && zone !== '' ? zone : null
    } catch {
      return null
    }
  }

  /** 找到本插件在该会话下已存在的定时任务（catalog 含 active 与 inactive）。 */
  const findOwnTask = async (schedule, sessionId) => {
    if (typeof schedule.catalog !== 'function') return null
    const title = scheduleTitle()
    const all = await schedule.catalog()
    return (
      all.find(
        (t) => t.sessionId === sessionId && t.title === title && t.status === 'active',
      ) ?? null
    )
  }

  /** `/checkin-schedule` 的实现：on / off / status。 */
  const handleScheduleCommand = async (agent, rawInput) => {
    const schedule = ctx.get('schedule')
    if (!schedule || typeof schedule.create !== 'function') {
      return cmdFail(
        '宿主没有提供 Schedule 服务，无法创建每日定时。'
          + '这通常意味着当前组合没有挂载 @deepseek-ai/dsh-schedule（或它不是 Web 组合）。',
      )
    }
    const sessionId = typeof agent?.id === 'string' ? agent.id : null
    if (!sessionId) {
      return cmdFail('拿不到当前会话 id，无法把定时任务绑定到这个会话。')
    }

    const [sub, arg] = String(rawInput ?? '').trim().split(/\s+/)
    const action = (sub ?? '').toLowerCase() || 'status'

    if (action === 'status') {
      const own = await findOwnTask(schedule, sessionId)
      scheduleState.taskId = own?.id ?? null
      scheduleState.sessionId = own ? sessionId : null
      // 记录里存的是规范化后的本地时间（daily 规则才带 time），据此显示实际生效值。
      const activeTime = typeof own?.time === 'string' ? own.time.slice(0, 5) : undefined
      return cmdOk(describeSchedule(undefined, activeTime))
    }

    if (action === 'off') {
      const own = await findOwnTask(schedule, sessionId)
      if (!own) {
        scheduleState.taskId = null
        scheduleState.sessionId = null
        return cmdOk('当前会话没有由本插件创建的每日定时，无需关闭。')
      }
      const result = await schedule.delete({ sessionId, id: own.id })
      scheduleState.taskId = null
      scheduleState.sessionId = null
      if (result?.deleted === true) {
        return cmdOk(`已关闭每日自动签到（删除任务 ${own.id}）。`)
      }
      return cmdFail(
        `关闭失败：宿主返回 ${String(result?.code ?? '未说明原因')}。任务可能已被别处删除。`,
      )
    }

    if (action === 'on') {
      const cfg = readConfig()
      const wanted = arg ?? DEFAULT_DAILY_TIME
      const time = normalizeDailyTime(wanted)
      if (!time) {
        return cmdFail(`时间格式不对：「${wanted}」。请用 24 小时制 HH:mm，例如 09:00。`)
      }
      const timeZone = localTimeZone()
      if (!timeZone) {
        return cmdFail('取不到本机 IANA 时区名，无法创建按本地钟表时间触发的定时。')
      }

      // 幂等：已经有本插件的任务就先删掉再建，避免同一会话叠出多条。
      const existing = await findOwnTask(schedule, sessionId)
      if (existing) {
        await schedule.delete({ sessionId, id: existing.id })
      }

      const record = await schedule.create(sessionId, {
        prompt: reminderPrompt(),
        title: scheduleTitle(),
        daily: { time, time_zone: timeZone },
      })
      scheduleState.taskId = record.id
      scheduleState.sessionId = sessionId

      const lines = [
        `已开启每日自动签到：每天 ${time.slice(0, 5)}（${timeZone}）`,
        `任务 id：${record.id}`,
        `首次触发：${record.scheduledAt}`,
        '',
        '到点时本会话会收到一条提醒，由模型调用 checkin_run 完成签到并汇报结果。',
        cfg.allowClaim
          ? '当前 allowClaim=true：会真实领取积分。'
          : '⚠️ 当前 allowClaim=false：到点只会核对，不会领取。要真实领取请先在设置里开启 allowClaim。',
        '',
        '注意：宿主保证的是「提醒被投进本会话收件箱」，不保证到点立刻唤醒模型；'
          + '本会话处于空闲时，提醒会等你下次打开它时才被处理。',
      ]
      return cmdOk(lines.join('\n'))
    }

    return cmdFail(`不认识的子命令「${action}」。可用：on [HH:mm]、off、status。`)
  }

  for (const route of modelRoutes.routes) {
    if (!route.valid) {
      logger.warn('模型路由「%s」配置不完整，已跳过：%s', route.key, route.problems.join('；'))
    }
  }

  const initial = readConfig()
  logger.info(
    '已加载 %d 个签到平台、%d 条模型路由；allowClaim=%s traeProvider=%s',
    PLATFORMS.length,
    modelRoutes.size,
    String(initial.allowClaim),
    String(initial.traeProvider),
  )
}


function joinHome() {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  return `${home.replace(/[\\/]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}.dsh`
}

function formatRun(run) {
  const sourceLabel =
    run.source === 'skipped'
      ? '未发起请求（今天已经领过）'
      : run.source === 'live'
        ? '实时请求'
        : run.source === 'dry_run'
          ? '只读核对'
          : String(run.source ?? '未知')
  const claimedLabel = run.allSkipped ? '无领取动作' : run.claimed ? '真实领取' : '只读核对'
  const lines = [`签到汇总（${claimedLabel}，数据来源 ${sourceLabel}）`]
  if (run.restored) {
    // 从磁盘读回的结果必须标出来，否则会被误当成本次刚跑的新数据。
    lines.push(
      `📦 这是上一次运行留下的结果（${run.finishedAt ?? '时间未知'}），不是本次新跑的。`
        + '要刷新请发送 `/checkin`。',
    )
  }
  if (run.downgraded) {
    lines.push('⚠️ 配置未开启 allowClaim，本轮已降级为只读核对，未实际领取。')
  }
  if (run.allSkipped) {
    lines.push(
      '今天所有指定平台都已经成功领取过，本轮没有发起任何请求。'
        + '这是幂等保护，不是失败。确实要强制重跑请加 `--force`。',
    )
  }
  lines.push('')
  for (const row of run.rows) {
    const balance = row.balance === null ? '' : `，余额 ${row.balance}${row.unit}`
    lines.push(`· ${row.name}：${row.codeLabel}${balance}`)
    if (row.detail) lines.push(`    ${row.detail}`)
  }
  // 幂等跳过的平台单列出来：它们没被请求，不该混进上面的结果里充数。
  if (Array.isArray(run.skipped) && run.skipped.length > 0 && !run.allSkipped) {
    const names = run.skipped.map((s) => s.name).join('、')
    lines.push('')
    lines.push(`⏭️ 今天已经领过、本轮跳过：${names}（要重跑请加 \`--force\`）`)
  }
  const s = run.summary
  lines.push('')
  lines.push(
    `共 ${s.total} 个平台：成功 ${s.success}、中性 ${s.neutral}`
      + (s.blocked ? `、环境受阻 ${s.blocked}` : '')
      + `、失败 ${s.failure}`
      + (s.unknown ? `、未知 ${s.unknown}` : '')
      + `；其中存在真实领取动作且成功的 ${s.healthy} 个`,
  )
  if (s.blocked) {
    // 单列出来并给出行动指引，否则使用者会看到「失败」而去重新登录。
    lines.push(
      '⚠️ 标「环境受阻」的平台是被本机沙箱挡住了写临时文件，'
        + '与登录态无关；在桌面版正常环境重跑即可。',
    )
  }
  // 平台自带的注意事项：这些是用户该知道的副作用，不该只躺在源码注释里。
  const risks = run.rows.filter((r) => PLATFORM_BY_ID.get(r.id)?.note)
  if (risks.length > 0) {
    lines.push('')
    lines.push('注意事项：')
    for (const r of risks) lines.push(`· ${r.name}：${PLATFORM_BY_ID.get(r.id).note}`)
  }
  // 不是客套话：跨平台相加会得到一个没有意义的数字。
  lines.push('（各平台积分为不同币种，不做跨平台求和）')
  if (run.elapsedMs != null) lines.push(`耗时 ${(run.elapsedMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}

function formatApply(result) {
  if (!result.ok) {
    const lines = [`模型路由写入未完成：${result.reason}`]
    if (result.problems?.length) {
      lines.push('', '配置问题：')
      for (const p of result.problems) lines.push(`· ${p}`)
    }
    return lines.join('\n')
  }
  if (result.mode === 'preview') {
    return [
      `将写入 ${result.providers.length} 条模型路由：${result.providers.join(', ')}`,
      '',
      '```yaml',
      result.yaml.trimEnd(),
      '```',
    ].join('\n')
  }
  const lines = [
    `已写入 ${result.providers.length} 条模型路由：${result.providers.join(', ')}`,
    `写入方式：${result.mode === 'config-editor' ? '宿主 configEditor（已热应用配置）' : '直接改 profile patch'}`,
  ]
  if (result.targetPath) lines.push(`目标文件：${result.targetPath}`)
  if (result.needsRestart) {
    lines.push('⚠️ 需要重启 dsh 才会生效（provider 表在启动时由 profile patch 装配）。')
  } else if (result.needsReload) {
    lines.push('新开会话即可在模型选择器里看到这些路由；当前会话仍用旧模型表。')
  }
  return lines.join('\n')
}

function defineCheckinTool({ runOnce, getLastRun, describe }) {
  return {
    name: 'checkin_run',
    description:
      '对已安装的 AI 客户端执行一轮每日签到，返回各平台结果与余额。'
        + '默认只做只读核对（不领取任何积分）；仅当插件配置 allowClaim=true 时才真实领取。'
        + '各平台积分为不同币种，读数不可跨平台相加。',
    parameters: {
      dryRun: {
        type: 'boolean',
        description: 'true 表示只查状态不领取。即使传 false，未开启 allowClaim 时也会降级为只读。',
      },
      only: {
        type: 'array',
        items: { type: 'string' },
        description: `只跑指定平台，可选值：${PLATFORMS.map((p) => p.id).join(', ')}；省略表示全部`,
      },
      useCache: {
        type: 'boolean',
        description: 'true 表示直接返回上一轮结果，不重新执行',
      },
      force: {
        type: 'boolean',
        description:
          'true 表示绕过当天的幂等保护，强制重新领取。'
            + '默认 false：同一自然日内已经成功领取过的平台会被跳过，避免重复请求。'
            + '只在确实需要重试时用。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: formatToolValue(value) }],
    },
    async execute(args, exec) {
      if (args.useCache) {
        const cached = getLastRun()
        return cached ? { ...cached, ...describe() } : { empty: true, ...describe() }
      }
      return runOnce({
        dryRun: args.dryRun === true,
        only: args.only,
        force: args.force === true,
        signal: exec.signal,
      })
    },
  }
}

function defineModelRouteTool({ modelRoutes }) {
  return {
    name: 'model_route_apply',
    description:
      '把配置里的模型路由写进当前 profile 的 patch，让这些端点出现在 DSH 的模型选择器里。'
        + '建议先用 dryRun 预览将要写入的 provider 配置。',
    parameters: {
      dryRun: {
        type: 'boolean',
        description: 'true 只预览不落盘',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: formatApply(value) }],
    },
    async execute(args) {
      return modelRoutes.apply({ dryRun: args.dryRun === true })
    },
  }
}

function formatToolValue(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (value.empty) return '还没有跑过签到。'
  return formatRun(value)
}

export { PLATFORMS, RESULT_CODES, isLoopbackRequest }
