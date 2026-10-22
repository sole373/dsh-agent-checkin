/**
 * 凭证面：状态查询、校验、落盘、清除。
 *
 * 设计上这是 `engine/bridge.py` 的薄门面——真正的校验规则（占位符、格式）只有
 * 一份，在 Python 侧。宿主侧不复制规则，只负责：
 *   1. 决定要不要落到磁盘（临时文件中转，避免凭证出现在进程参数里）；
 *   2. 把引擎的 JSON 结果收敛成设置面板能直接渲染的形状；
 *   3. 在引擎不可用时给出**可行动的**诊断，而不是一句「失败」。
 *
 * 一条硬纪律：**任何路径都不把凭证值回传或打印**。落盘成功后只回字段名。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_BY_ID } from './platforms.js'

/** 展示名统一取自 platforms.js 那唯一一份平台表，不在这里另抄一遍。 */
const labelOf = (id) => PLATFORM_BY_ID.get(id)?.name ?? id

/** 与 bridge.py 的 CREDENTIAL_KINDS 对齐。 */
export const CREDENTIAL_KINDS = {
  lingxi: 'cookie',
  jimeng: 'cookie',
}

/** 支持在面板里录入凭证的平台 id。 */
export const CREDENTIAL_PLATFORMS = Object.keys(CREDENTIAL_KINDS)

/** 每个平台凭证的来源说明——面板上直接展示，免得用户以为是插件在「登录」。 */
export const CREDENTIAL_SOURCES = {
  lingxi: {
    kind: 'cookie',
    label: 'WPS 灵犀登录 Cookie',
    how: '在浏览器登录 lingxi.wps.cn 后，F12 → Application → Cookies，'
      + '全选该域下所有 Cookie 拼成 `k=v; k2=v2` 一行。核心会话是 HttpOnly，务必全选。',
    entry: true,
  },
  jimeng: {
    kind: 'cookie',
    label: '即梦 AI 登录 Cookie',
    how: '在浏览器登录 jimeng.jianying.com 后复制整串 Cookie；也可以只贴 sessionid 的值。',
    entry: true,
  },
}

/**
 * 其余平台的凭证来源：全部来自各自客户端，插件只读不写。
 * 这份表是给面板用的「为什么这里没有输入框」的答案。
 *
 * kling 已支持在面板里**发起登录**（独立浏览器 profile，见 lib/login.js），
 * 但凭证是整个浏览器配置目录而不是一份 Cookie，没有「粘贴」这种录入方式，
 * 所以它们不出现在 sources（可录入粘贴）里，理由在下面如实写明。
 */
export const READONLY_CREDENTIAL_SOURCES = {
  workbuddy: 'WorkBuddy 客户端本地存储（Electron at-rest 加密），客户端登录后自动写出',
  workbuddy_intl: 'WorkBuddy 国际版客户端的凭据文件，客户端登录后自动写出',
  trae: 'TRAE 客户端 globalStorage，客户端登录后自动写出',
  kling: '凭证是整个浏览器配置目录（不是一份 Cookie）：请用上方的「打开登录窗口」发起登录，粘贴在这里没有用',
}

const MAX_CREDENTIAL_CHARS = 16_384

/** 引擎没起来时，面板该看到什么。 */
function engineUnavailable(detail) {
  return {
    ok: false,
    status: 'engine-unavailable',
    detail,
  }
}

/**
 * 跑一次 bridge.py 并把最后一行 JSON 解析出来。
 *
 * 与 lib/engine.js 分开写而不是复用：那里刻意不给子进程传 stdin（避免把
 * 凭证环境变量漏给上层日志），而这里需要 stdin 传值——路径不同就分开，
 * 免得为了共用把两边的安全性都削弱。
 */
function runBridge({ pythonCommand, engineDir, args, input, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const script = join(engineDir, 'bridge.py')
    let child
    try {
      child = spawn(pythonCommand, [script, ...args], {
        cwd: engineDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经结束了 */
      }
      finish({ ok: false, error: `引擎超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, error: '已取消' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish({ ok: false, error: `无法启动 Python：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // 桥接层保证 JSON 在最后一行；前面可能混有适配器的 print。
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
      let parsed = null
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i])
          break
        } catch {
          /* 继续往上找 */
        }
      }
      if (!parsed) {
        finish({
          ok: false,
          error: `引擎没有返回可解析的 JSON（退出码 ${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 400)}` : ''}`,
        })
        return
      }
      finish({ ok: true, payload: parsed, exitCode: code, stderr: stderr.trim() })
    })

    if (input !== undefined) {
      child.stdin?.end(input, 'utf8')
    } else {
      child.stdin?.end()
    }
  })
}

/**
 * 凭证服务的门面。所有方法都不抛异常，统一返回 `{ ok, status, detail }` 形状，
 * 让 HTTP 层可以无脑包成 200/400 —— 面板最怕的是「一个 500 什么都不说」。
 */
export class Credentials {
  #getConfig
  #logger

  /**
   * @param {() => {pythonCommand: string, homeDir: string, timeoutMs: number}} getConfig
   * @param {{warn: Function, info: Function}} logger
   */
  constructor(getConfig, logger) {
    this.#getConfig = getConfig
    this.#logger = logger
  }

  #call(args, options = {}) {
    const cfg = this.#getConfig()
    return runBridge({
      pythonCommand: cfg.pythonCommand,
      engineDir: cfg.homeDir,
      args,
      input: options.input,
      // 凭证操作都是本地动作，不需要签到那种长超时。
      timeoutMs: Math.min(cfg.timeoutMs ?? 60_000, 60_000),
      signal: options.signal,
    })
  }

  /**
   * 查所有平台的凭证状态。`live=true` 时额外逐平台实测登录态。
   *
   * 注意 live 会真的发网络请求（只读接口），所以默认关闭：打开面板不该等于
   * 悄悄打十次接口。
   */
  async status({ live = false, signal } = {}) {
    // 只查真正支持录入的两个平台。其余平台的凭证情况在下列实测里体现，
    // 没必要为「文件在不在」再 spawn 一次子进程。
    const supported = {}
    for (const id of CREDENTIAL_PLATFORMS) {
      const res = await this.#call(['--credential', id], { signal })
      if (!res.ok) {
        supported[id] = engineUnavailable(res.error)
        continue
      }
      const entry = res.payload?.credential ?? {}
      supported[id] = {
        ok: true,
        status: entry.status ?? 'unknown',
        detail: entry.detail ?? '',
        path: entry.path ?? null,
        ...CREDENTIAL_SOURCES[id],
      }
    }

    const result = {
      ok: true,
      checkedAt: new Date().toISOString(),
      supported,
      readonly: READONLY_CREDENTIAL_SOURCES,
      live: null,
    }
    if (live) result.live = await this.check({ signal })
    return result
  }

  /** 逐平台只读实测（不领取）。慢，但这是「登录到底通不通」的唯一可信判据。 */
  async check({ only, signal } = {}) {
    const args = ['--check']
    if (Array.isArray(only) && only.length > 0) args.push('--only', only.join(','))
    const res = await this.#call(args, { signal })
    if (!res.ok) return engineUnavailable(res.error)
    const payload = res.payload ?? {}
    if (payload.ok !== true) {
      return { ok: false, status: 'failed', detail: payload.error ?? '引擎返回失败' }
    }
    return {
      ok: true,
      status: 'checked',
      generatedAt: payload.generated_at ?? null,
      // 体检固定不领取；把这一条当作契约写明，前端不必再推断。
      claimed: false,
      counts: payload.counts ?? null,
      checks: Array.isArray(payload.checks) ? payload.checks : [],
    }
  }

  /**
   * 校验并保存一份凭证。
   *
   * 流程：写临时文件 → `bridge.py --save-cookie <平台> <临时文件>` → 桥接层删临时文件。
   * 为什么不用参数传值：命令行参数在进程列表里对同机任何进程可见。
   */
  async save({ platform, value, signal } = {}) {
    const id = String(platform ?? '').trim()
    if (!CREDENTIAL_PLATFORMS.includes(id)) {
      return {
        ok: false,
        status: 'unsupported',
        detail: READONLY_CREDENTIAL_SOURCES[id] ?? `平台「${id}」不支持手工录入凭证`,
      }
    }
    const text = String(value ?? '')
    if (text.trim() === '') {
      return { ok: false, status: 'invalid', detail: '内容为空' }
    }
    if (text.length > MAX_CREDENTIAL_CHARS) {
      return { ok: false, status: 'invalid', detail: '内容过长，Cookie 不会超过这个长度' }
    }

    let dir = null
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-checkin-cred-'))
      const file = join(dir, 'credential.txt')
      await writeFile(file, text, { encoding: 'utf8', mode: 0o600 })
      const res = await this.#call(['--save-cookie', id, file], { signal })
      if (!res.ok) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        return engineUnavailable(res.error)
      }
      const payload = res.payload ?? {}
      // 无论桥接层是否成功，中转文件都要立刻清掉（桥接层通常已删）。
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      dir = null
      if (payload.ok === true) {
        this.#logger.info('已录入 %s 的凭证（字段 %s 个）', id, payload.field_count ?? '?')
        return {
          ok: true,
          status: 'present',
          platform: id,
          path: payload.path ?? null,
          fields: Array.isArray(payload.fields) ? payload.fields : [],
          fieldCount: payload.field_count ?? 0,
        }
      }
      return {
        ok: false,
        status: payload.status ?? 'invalid',
        detail: payload.detail ?? '桥接层拒绝了这份凭证',
      }
    } catch (error) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      return engineUnavailable(error instanceof Error ? error.message : String(error))
    }
  }

  /** 删除该平台已录入的凭证（只删插件自己的文件，不碰客户端）。 */
  async clear({ platform, signal } = {}) {
    const id = String(platform ?? '').trim()
    if (!CREDENTIAL_PLATFORMS.includes(id)) {
      return {
        ok: false,
        status: 'unsupported',
        detail: READONLY_CREDENTIAL_SOURCES[id] ?? `平台「${id}」不支持手工录入凭证`,
      }
    }
    const res = await this.#call(['--clear-cookie', id], { signal })
    if (!res.ok) return engineUnavailable(res.error)
    const payload = res.payload ?? {}
    if (payload.ok === true) {
      this.#logger.info('已删除 %s 的凭证文件', id)
      return { ok: true, status: 'absent', platform: id, removed: payload.removed === true }
    }
    return {
      ok: false,
      status: payload.status ?? 'error',
      detail: payload.detail ?? '删除未完成',
    }
  }

  /**
   * 面板需要的元信息：哪些平台可录入、其余平台为什么不可录入。
   * 纯静态，不碰磁盘也不联网——用于首屏渲染，避免打开设置页就 spawn 子进程。
   *
   * 字段名与浏览器半侧 `lib/client.js` 的消费口径一致：`sources[]` 每项带
   * `platform`，`readonly[]` 每项带 `platform`+`reason`。改这里就必须同步改那边。
   */
  describe() {
    return {
      sources: CREDENTIAL_PLATFORMS.map((id) => ({ platform: id, ...CREDENTIAL_SOURCES[id] })),
      readonly: Object.entries(READONLY_CREDENTIAL_SOURCES).map(([platform, reason]) => ({
        platform,
        label: labelOf(platform),
        reason,
      })),
      supported: CREDENTIAL_PLATFORMS,
      note: '凭证只写入本机文件，不上传；面板回显只显示字段名，不显示值。',
    }
  }

  /**
   * 与 `describe()` 合并后的首屏形状：静态元信息 + 两个可录入平台的**落盘状态**。
   *
   * 只读文件（`--credential`），不联网——设置页一打开就打十次接口是不可接受的。
   * 「是否真的能签到」交给显式的 `POST /settings/check`。
   */
  async describeWithState({ signal } = {}) {
    const base = this.describe()
    const entries = []
    for (const id of CREDENTIAL_PLATFORMS) {
      const res = await this.#call(['--credential', id], { signal })
      const entry = res.ok ? (res.payload?.credential ?? {}) : {}
      entries.push({
        platform: id,
        status: res.ok ? (entry.status ?? 'unknown') : 'unreadable',
        detail: res.ok ? (entry.detail ?? '') : (res.error ?? ''),
        path: res.ok ? (entry.path ?? null) : null,
      })
    }
    return { ...base, entries }
  }
}
