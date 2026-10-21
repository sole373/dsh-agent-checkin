/**
 * 模型接入：把已登录客户端的 OpenAI / Anthropic 兼容端点接进 DSH。
 *
 * ## 为什么不自己写 LlmAdapter
 * 宿主自带 `@deepseek-ai/dsh-llm-pi-ai`，它是成熟的协议适配器——负责流式分块、
 * 工具调用增量、usage 归一、reasoning 档位映射、图片额度控制。在插件里再写一遍
 * 等于重造一套流式协议，而且会和宿主抢同一个 LLM 注册位，宿主一升级就悄悄漂移。
 *
 * ## 那怎么接
 * pi-ai 的 `providers` 本来就是「任意自定义路由」的容器：只要同时给出
 * `api` + `baseURL` + 非空 `models`，宿主就会用 createProvider 现搭一个 provider：
 *
 *   providers:
 *     my-route:
 *       apiKeyEnv: MY_KEY          # role: credential-ref
 *       api: openai-completions    # openai-completions | openai-responses | anthropic-messages
 *       baseURL: https://x/v1
 *       displayName: My Route
 *       models: [{ id, name, contextWindow, maxTokens, input, reasoningEfforts, compat }]
 *
 * 所以"接入"这件事本质上就是**生成一份正确的 provider 配置**并保证它落在
 * pi-ai 真正读取的位置。
 *
 * ## 落地位置只有一处：当前 profile 的 patch
 * 已核对宿主 `dsh-config-editor` 的源码，它把写入目标固定为
 * `profileContext.patchPath`（即 `$DSH_HOME/profiles/<name>/cordis.patch.yml`）：
 * home patch 与命令行 overlay **只参与优先级解析，不作为写入目标**——写了也会被
 * 更高层覆盖，属于"看起来成功其实没生效"。
 *
 * 因此本模块分两条写入路径：
 *   1. **首选** `configEditor.edit(entry, change)`：保留 YAML 注释与 `!!js` 表达式、
 *      原子写、失败回滚、与 HMR 串行，并且**当场热生效**（不必重启）。
 *   2. **退化** 直接改 profile patch 里的 `llm-pi-ai` 条目，保留其余全部条目。
 *      只在宿主没提供 configEditor 时使用，且明确告知需要重启。
 *
 * 两条路径都**绝不**覆盖用户自己的 provider：只增改本插件声明的那几条路由。
 *
 * @module dsh-agent-checkin/models
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** pi-ai 支持的三种协议——与宿主 buildProvider 的 PROTOCOLS 表一致。 */
export const SUPPORTED_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/** pi-ai 允许的模态。未声明时宿主补 `['text']`。 */
export const SUPPORTED_INPUTS = Object.freeze(['text', 'image'])

/** pi-ai 的 reasoning 档位（升序）。 */
export const THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** 宿主 `llm-pi-ai` 在 profile patch 中的默认条目 id / name。 */
const PI_AI_ENTRY_ID = 'llm-pi-ai'
const PI_AI_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai'

const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768

/** 宿主 provider 路由名会被用作 credential 记录 id，必须是 lower-kebab。 */
const PROVIDER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 把一条插件配置归一成宿主可用的 provider profile。
 *
 * 缺字段时**记录问题而不是猜**：猜错的 baseURL 只会得到一堆莫名其妙的 404，
 * 比一开始就说清楚难查得多。
 *
 * @param {object} route 插件配置里的一条 modelRoutes
 * @param {number} index 用于定位是哪一条
 */
export function normalizeRoute(route, index) {
  const problems = []
  const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
  const baseURL = typeof route?.baseURL === 'string' ? route.baseURL.trim() : ''
  const api =
    typeof route?.api === 'string' && route.api.trim() ? route.api.trim() : 'openai-completions'

  if (!provider) problems.push('缺少 provider 名')
  else if (!PROVIDER_ID_RE.test(provider)) {
    problems.push(`provider 名「${provider}」不合法，只能用小写字母、数字和连字符`)
  }
  if (!baseURL) problems.push('缺少 baseURL')
  else if (!/^https?:\/\//i.test(baseURL)) problems.push(`baseURL 必须是 http(s) 地址：${baseURL}`)
  if (!SUPPORTED_APIS.includes(api)) {
    problems.push(`不支持的 api「${api}」，可选：${SUPPORTED_APIS.join(' | ')}`)
  }

  const models = []
  const seen = new Set()
  if (Array.isArray(route?.models)) {
    for (const m of route.models) {
      const id = typeof m?.id === 'string' ? m.id.trim() : ''
      if (!id) continue
      if (seen.has(id)) {
        problems.push(`模型「${id}」重复声明`)
        continue
      }
      seen.add(id)

      const contextWindow = Number.isInteger(m.contextWindow) && m.contextWindow > 0
        ? m.contextWindow
        : DEFAULT_CONTEXT_WINDOW
      const maxTokens = Number.isInteger(m.maxTokens) && m.maxTokens > 0
        ? m.maxTokens
        : DEFAULT_MAX_TOKENS

      const input = Array.isArray(m.input) && m.input.length
        ? m.input.filter((x) => SUPPORTED_INPUTS.includes(x))
        : undefined

      // reasoningEfforts 可以是 false（明确不支持思考），也可以是 {档位: 线上拼写}。
      // 校验失败时丢字段而不是让整条路由被宿主拒掉——路由可用性优先。
      let reasoningEfforts
      if (m.reasoningEfforts === false) {
        reasoningEfforts = false
      } else if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') {
        const entries = Object.entries(m.reasoningEfforts).filter(
          ([level, wire]) => THINKING_LEVELS.includes(level) && (wire == null || typeof wire === 'string'),
        )
        if (entries.length) reasoningEfforts = Object.fromEntries(entries)
      }

      models.push({
        id,
        name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id,
        contextWindow,
        maxTokens,
        ...(input ? { input } : {}),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      })
    }
  }

  // 自定义路由必须在配置里逐个列出模型：pi-ai 的 installed catalog 里没有它，
  // 没有 models 就 "resolves no models" 直接把整条路由作废。
  if (!models.length) problems.push('models 不能为空——自定义路由必须在配置里逐个列出模型')

  return {
    key: provider || `route-${index}`,
    provider,
    displayName:
      typeof route?.displayName === 'string' && route.displayName.trim()
        ? route.displayName.trim()
        : provider,
    api,
    baseURL,
    apiKeyEnv:
      typeof route?.apiKeyEnv === 'string' && route.apiKeyEnv.trim()
        ? route.apiKeyEnv.trim()
        : undefined,
    models,
    problems,
    valid: problems.length === 0,
  }
}

/**
 * 转成宿主 `llm-pi-ai` 的 provider profile 形状。
 * 字段名严格对齐宿主 schema，多写一个未声明的键都会被 schemastery 拒绝。
 */
export function toProviderProfile(route) {
  return {
    displayName: route.displayName,
    api: route.api,
    baseURL: route.baseURL,
    ...(route.apiKeyEnv ? { apiKeyEnv: route.apiKeyEnv } : {}),
    models: route.models.map((m) => ({ ...m })),
  }
}

/** YAML 标量安全化：条件满足时用裸串，否则用双引号转义。 */
function yamlScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_][A-Za-z0-9_./:@+-]*$/.test(text)) return text
  return JSON.stringify(text)
}

/**
 * 生成 `llm-pi-ai` 条目里 `providers:` 的 YAML 片段（**不含** `- id:` 行）。
 *
 * 只在退化路径（没有 configEditor）里用；正常路径走结构化对象，不碰文本。
 *
 * @param {object[]} routes 已校验通过的路由
 * @param {string} indent providers 键的缩进
 */
export function toProvidersYaml(routes, indent = '      ') {
  const lines = []
  for (const route of routes) {
    const p = toProviderProfile(route)
    lines.push(`${indent}${route.provider}:`)
    lines.push(`${indent}  displayName: ${yamlScalar(p.displayName)}`)
    lines.push(`${indent}  api: ${p.api}`)
    lines.push(`${indent}  baseURL: ${yamlScalar(p.baseURL)}`)
    if (p.apiKeyEnv) lines.push(`${indent}  apiKeyEnv: ${yamlScalar(p.apiKeyEnv)}`)
    lines.push(`${indent}  models:`)
    for (const m of p.models) {
      lines.push(`${indent}    - id: ${yamlScalar(m.id)}`)
      lines.push(`${indent}      name: ${yamlScalar(m.name)}`)
      lines.push(`${indent}      contextWindow: ${m.contextWindow}`)
      lines.push(`${indent}      maxTokens: ${m.maxTokens}`)
      if (m.input?.length) lines.push(`${indent}      input: [${m.input.join(', ')}]`)
      if (m.reasoningEfforts === false) {
        lines.push(`${indent}      reasoningEfforts: false`)
      } else if (m.reasoningEfforts) {
        lines.push(`${indent}      reasoningEfforts:`)
        for (const [level, wire] of Object.entries(m.reasoningEfforts)) {
          lines.push(wire == null ? `${indent}        ${level}:` : `${indent}        ${level}: ${yamlScalar(wire)}`)
        }
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** 原子写：先写临时文件再 rename，避免半截文件让宿主读不到配置。 */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** 把一段 YAML 行按「顶层键」切片：返回 [{key, start, end}]，end 不含。 */
function splitProviderBlocks(lines, from, to) {
  const blocks = []
  for (let i = from; i < to; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent !== 6) continue
    const match = /^\s{6}([A-Za-z0-9_][A-Za-z0-9_./:@-]*):\s*$/.exec(line)
    if (!match) continue
    blocks.push({ key: match[1], start: i, end: to })
  }
  for (let i = 0; i < blocks.length - 1; i += 1) blocks[i].end = blocks[i + 1].start
  if (blocks.length > 0) {
    // 尾块要把 providers 子块之后的空行/更浅缩进切掉，不能吞掉下一个配置。
    const last = blocks[blocks.length - 1]
    let end = last.end
    while (end > last.start + 1 && lines[end - 1].trim() === '') end -= 1
    last.end = end
  }
  return blocks
}

/**
 * 退化路径：在 profile patch 文本里就地合并 providers，保留其余条目。
 *
 * 用文本手术而不是 `yaml.load → yaml.dump`：后者会丢掉用户的注释、锚点、
 * 引号风格和 `!!js` 表达式。
 *
 * 关键约束：**只增改本插件声明的 provider 键，别人的键（例如用户自己配的
 * siliconflow）一个字节都不动。** 早期版本整段替换 `providers:` 子块，
 * 会把用户已有路由直接吃掉——那是不可接受的数据丢失。
 *
 * @param {string} text 现有 patch 全文
 * @param {object[]} routes 要写入的路由
 */
export function mergeProvidersIntoPatch(text, routes) {
  const ours = new Set(routes.map((r) => r.provider))
  const blockYaml = toProvidersYaml(routes, '      ')
  const lines = text.split(/\r?\n/)

  const entryStart = lines.findIndex((line) => /^- id:\s*["']?llm-pi-ai["']?\s*$/.test(line))
  if (entryStart < 0) {
    // 没有任何 llm-pi-ai 条目：整块追加（providers 与其它字段互不干扰）。
    const base = text.trimEnd()
    return `${base}${base ? '\n' : ''}- id: ${PI_AI_ENTRY_ID}\n  name: ${yamlScalar(PI_AI_ENTRY_NAME)}\n  config:\n    providers:\n${blockYaml}`
  }

  // 条目范围：从 entryStart 到下一条顶格 `- ` 之前。
  let entryEnd = lines.length
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      entryEnd = i
      break
    }
  }

  // 找 config: 与 providers: 的位置。
  let configIdx = -1
  let providersIdx = -1
  for (let i = entryStart + 1; i < entryEnd; i += 1) {
    if (/^\s{2}config:\s*$/.test(lines[i])) configIdx = i
    if (/^\s{4}providers:\s*$/.test(lines[i])) {
      providersIdx = i
      break
    }
  }

  if (providersIdx < 0) {
    // 条目在但没写 providers：插到 config: 之后；连 config: 也没有就补出来。
    if (configIdx < 0) {
      lines.splice(entryStart + 2, 0, '  config:', '    providers:', blockYaml.trimEnd())
    } else {
      lines.splice(configIdx + 1, 0, '    providers:', blockYaml.trimEnd())
    }
    return lines.join('\n')
  }

  // providers 子块范围：到缩进 <=4 且非空的行为止。
  let providersEnd = entryEnd
  for (let i = providersIdx + 1; i < entryEnd; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= 4) {
      providersEnd = i
      break
    }
  }

  const existing = splitProviderBlocks(lines, providersIdx + 1, providersEnd)
  const kept = existing.filter((b) => !ours.has(b.key))
  const replaced = existing.filter((b) => ours.has(b.key))

  if (replaced.length === 0) {
    // 我们的键都是新的：插到 providers 子块末尾，原来的一切原样保留。
    lines.splice(providersEnd, 0, ...blockYaml.trimEnd().split('\n'))
    return lines.join('\n')
  }

  // 同一 provider 已在文件里：用我们的定义替换掉它的整块，从后往前改，
  // 这样前面块的 index 不受影响。
  for (const block of [...replaced].reverse()) {
    const fresh = toProvidersYaml(
      routes.filter((r) => r.provider === block.key),
      '      ',
    ).trimEnd().split('\n')
    lines.splice(block.start, block.end - block.start, ...fresh)
  }
  // 剩下的新键统一追加到子块末尾。
  const missing = routes.filter((r) => !existing.some((b) => b.key === r.provider))
  if (missing.length > 0) {
    const tail = kept.length > 0 ? Math.max(...kept.map((b) => b.end)) : providersIdx + 1
    lines.splice(tail, 0, ...toProvidersYaml(missing, '      ').trimEnd().split('\n'))
  }
  return lines.join('\n')
}

export class ModelRoutes {
  /**
   * @param {object[]} rawRoutes 插件配置里的 modelRoutes
   * @param {object} logger cordis logger
   * @param {{
   *   homeDir: () => Promise<string>,
   *   targetPath: () => Promise<string|null>,
   *   editor: () => object|undefined,
   *   entry: () => object|undefined,
   * }} options
   *   - `targetPath`：退化路径要写的 profile patch
   *   - `editor`：宿主 configEditor 服务（首选路径），惰性读取，因为它可能后到
   *   - `entry`：`llm-pi-ai` 在 Loader 里的条目，configEditor.edit 需要它
   */
  constructor(rawRoutes, logger, options) {
    this.logger = logger
    this.options = options
    this.routes = (rawRoutes ?? []).map(normalizeRoute)
    /** 落盘结果，供看板端点如实汇报。 */
    this.lastApply = null
  }

  get size() {
    return this.routes.filter((r) => r.valid).length
  }

  get validRoutes() {
    return this.routes.filter((r) => r.valid)
  }

  /** 看板/诊断用：哪些接上了、哪些是坏的、为什么、下一步该做什么。 */
  describe() {
    return {
      configured: this.routes.length,
      applicable: this.size,
      routes: this.routes.map((r) => ({
        provider: r.provider,
        displayName: r.displayName,
        api: r.api,
        baseURL: r.baseURL,
        apiKeyEnv: r.apiKeyEnv ?? null,
        models: r.models.map((m) => m.id),
        valid: r.valid,
        problems: r.problems,
      })),
      lastApply: this.lastApply,
    }
  }

  /**
   * 把路由写进当前 profile 的 patch。
   *
   * @param {{dryRun?: boolean}} options
   */
  async apply(options = {}) {
    const routes = this.validRoutes
    if (!routes.length) {
      const result = {
        ok: false,
        reason: '没有可用的模型路由配置（全部未通过校验或未配置）',
        problems: this.routes.flatMap((r) => r.problems.map((p) => `${r.key}: ${p}`)),
        at: new Date().toISOString(),
      }
      this.lastApply = result
      return result
    }

    if (options.dryRun) {
      const result = {
        ok: true,
        dryRun: true,
        mode: 'preview',
        providers: routes.map((r) => r.provider),
        yaml: toProvidersYaml(routes),
        at: new Date().toISOString(),
      }
      this.lastApply = result
      return result
    }

    const editor = this.options.editor?.()
    const entry = this.options.entry?.()
    if (editor && entry) {
      const result = await this.#applyViaEditor(editor, entry, routes)
      this.lastApply = result
      return result
    }

    const result = await this.#applyViaFile(routes)
    this.lastApply = result
    return result
  }

  /**
   * 首选路径：交给宿主 configEditor。
   *
   * 它会做锁定、校验、原子写、失败回滚，并且走 Loader 让配置**立刻生效**——
   * 不需要重启，也不会丢注释。
   */
  async #applyViaEditor(editor, entry, routes) {
    const providers = Object.fromEntries(routes.map((r) => [r.provider, toProviderProfile(r)]))
    try {
      await editor.edit(entry, (current) => ({
        ...current,
        providers: { ...(current?.providers ?? {}), ...providers },
      }))
    } catch (error) {
      const result = {
        ok: false,
        mode: 'config-editor',
        reason: error instanceof Error ? error.message : String(error),
        providers: Object.keys(providers),
        at: new Date().toISOString(),
      }
      this.logger.warn('通过 configEditor 写入模型路由失败：%s', result.reason)
      return result
    }

    const result = {
      ok: true,
      mode: 'config-editor',
      targetPath: editor.documentPath ?? null,
      providers: Object.keys(providers),
      // configEditor 走 Loader 重载，配置已生效，但**provider 表还挂在旧快照上**：
      // 模型选择器要看到新路由仍需要新会话。如实说明，不承诺热更新成功。
      needsReload: true,
      at: new Date().toISOString(),
    }
    this.logger.info('已通过 configEditor 写入 %d 条模型路由', routes.length)
    return result
  }

  /**
   * 退化路径：直接改 profile patch（宿主没有 configEditor 时）。
   *
   * ⚠️ 已知竞态：**宿主自己也会写这个文件**。实测 `agent-default-model` 条目会在
   * 用户于界面切换模型时被宿主整体改写（本机就曾从 `workbuddy-global/deepseek-v4.1-flash`
   * 变成 `deepseek-account/deepseek-flash`）。本路径是 read → 改 → atomic write，
   * 中间没有任何锁，与宿主写入重叠时后写者覆盖先写者。
   *
   * 之所以仍然保留：没有 configEditor 的宿主里，这是唯一能落地的方式。但既然
   * 首选路径可用，就绝不走这里。写入前重新读一次文件（而不是复用之前的快照）
   * 把窗口压到最小。
   */
  async #applyViaFile(routes) {
    const targetPath = await this.options.targetPath?.()
    if (!targetPath) {
      const result = {
        ok: false,
        mode: 'file',
        reason: '无法确定当前 profile 的 patch 路径，且宿主未提供 configEditor',
        at: new Date().toISOString(),
      }
      this.logger.warn(result.reason)
      return result
    }

    // 紧挨着写之前才读，尽可能缩小与宿主写入的重叠窗口。
    let existing = ''
    try {
      existing = await readFile(targetPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      existing = '# Your patch layer for this dsh profile.\n'
    }

    const next = mergeProvidersIntoPatch(existing, routes)
    await writeAtomic(targetPath, next)

    const result = {
      ok: true,
      mode: 'file',
      targetPath,
      providers: routes.map((r) => r.provider),
      // 直接改文件不会触发 Loader 重载，必须重启。
      needsRestart: true,
      // 如实标注这不是受锁保护的写入，让用户知道可能被宿主改回。
      unlocked: true,
      at: new Date().toISOString(),
    }
    this.logger.warn(
      '已把 %d 条模型路由写入 %s（重启 dsh 后生效）；此路径无文件锁，'
        + '若宿主同时改写该文件可能被覆盖，建议宿主提供 configEditor 时重试',
      routes.length,
      targetPath,
    )
    return result
  }
}
