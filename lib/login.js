/**
 * 「在插件里直接发起登录」的后端半侧。
 *
 * 为什么端点永远不等待登录完成：`engine/adapters/cdp.py --capture` 会开一个
 * **可见**浏览器窗口，让用户在里面登录，最长等 5 分钟，然后把 Cookie 写盘。
 * 这整个过程是「等人」而不是「算数」。如果 HTTP 请求一直挂着等它，
 * 用户一刷新设置页、一关弹层，面板就会显示「网络错误」——而浏览器其实还开着、
 * 凭证最后其实写成功了。所以：
 *
 *   POST …/login/start  → 立刻返回 {status:'running'}，后端继续跑
 *   GET  …/login/state  → 轮询过程，面板据此显示「等待你在浏览器里登录…」
 *
 * 三条纪律（都与 ai-checkin-adapter 的展示层约定一致）：
 *
 * 1. **不假装在跑**：注册表里没有那条进程就等于没跑；`status` 只由子进程真实
 *    的 stdout/退出码推导，不由「我记得我启动过」推导。
 * 2. **不假装成功**：`cdp.py` 只有在 `spec["verify"]` 真的调通接口并写盘后
 *    才退出 0。退出 0 我们才说 `ok`；「窗口已关闭」本身不是成功。
 * 3. **失败就说原因**：超时、Python 缺失、脚本没吐结论，都各自成码，
 *    面板上能看到到底是哪种。
 *
 * 输出解析用**状态行**而不是 JSON：`cdp.py` 是给人看的脚本，不打 JSON 信封。
 * 我们在它已有的中文输出里认固定的几个标记（见 MARK_TO_STATUS），
 * 认不出来就老实说「未知」，绝不猜成成功。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * 面板上能发起登录的平台，分两类：
 *
 * - `lingxi` / `jimeng`：凭证是**一个个 Cookie 文件**，走 `cdp.py --capture`
 *   ——浏览器里登录，Cookie 被 CDP 采下来、真实验证、写盘。
 * - `coze` / `kling`：这两个**没有领取接口**，福利机制是「以已登录状态访问一次」，
 *   凭证是**整个浏览器配置目录**（`.<id>_profile/`）。走各自适配器的 `--login`
 *   ——同一个独立 profile、同一套「看不到日常浏览器」规则，登录后**窗口还
 *     得由用户亲手关闭**（脚本在窗口关闭后才继续），随后用 `--dry-run` 核验
 *   登录态。这里没有 Cookie 文件可写，所以「保存凭证」对它们没有意义。
 */
export const LOGIN_PLATFORMS = ['lingxi', 'jimeng', 'coze', 'kling']

/** 「登录态存整个浏览器配置目录」的那一类：入口是 `--login`，核验是 `--dry-run`。 */
export const PROFILE_LOGIN_PLATFORMS = ['coze', 'kling']


/**
 * `cdp.py` 输出里可用于判断结局的标记。
 *
 * 匹配顺序很重要：`--capture` 失败时既会打超时行、也可能已经打过
 * 「尚未登录」之类的中途状态，所以 only 认**终点**标记，中途标记单独处理。
 */
const MARK_TIMEOUT = /超时（\d+s）仍未采集到可用凭证/
const MARK_SAVED = /采集成功/
const MARK_WAITING = /下还没有 Cookie/
const MARK_UNKNOWN_PLATFORM = /未知平台/

/** profile 型核验（`--dry-run`）的最长等待：冷启动无头浏览器可能要几十秒。 */
const PROFILE_VERIFY_TIMEOUT_MS = 120_000

/**
 * profile 型登录（coze/kling）关窗后 `--dry-run` 输出的归类。
 *
 * 这些适配器打的是给人看的中文行，最后一行是可解析的 JSON 信封
 * （与 bridge.py 汇总时同一约定）。判据只有结果码：
 *   result === 'DRY_RUN' → 登录态有效（这一轮是「以已登录状态访问」的意义所在）；
 *   ERROR/AUTH_REJECTED 等 → 没登录上；解析不出 JSON → 未知，不猜成功。
 *
 * @param {string} platform 平台 id（只用于报错文案）
 * @param {string} text 子进程输出全文
 */
export function classifyProfileVerify(platform, text) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const payload = JSON.parse(line)
      const code = typeof payload?.result === 'string' ? payload.result : ''
      const detail = typeof payload?.detail === 'string' ? payload.detail : ''
      if (code === 'DRY_RUN') {
        return { status: 'saved', ok: true, detail: '登录成功：这个平台的登录态已经保存在独立浏览器配置里' }
      }
      if (code !== '') {
        const reason = detail !== '' ? `：${detail}` : ''
        return { status: 'auth-rejected', ok: false, detail: `窗口已关闭，但核验登录态没有通过（${code}${reason}）。请再点一次「打开登录窗口」，确认在弹出的浏览器里真正登录。` }
      }
    } catch {
      /* 不是 JSON，继续往前找 */
    }
  }
  if (MARK_UNKNOWN_PLATFORM.test(raw)) {
    return { status: 'unsupported-platform', ok: false, detail: '引擎不认识这个平台' }
  }
  return {
    status: 'unknown',
    ok: false,
    detail: `窗口已关闭，但 ${platform} 的核验输出里没有得出结论。可以把下面这段输出拿去排查，或再试一次登录。`,
  }
}

/**
 * 把一段输出归类成状态码。
 *
 * @param {string} text 子进程 stdout 全文
 * @param {string} [failure] 未正常完成时的兜底码（timeout / killed / …）
 * @returns {{status: string, ok: boolean, detail: string}}
 */
export function classifyCaptureOutput(text, failure) {
  const raw = String(text ?? '')
  if (MARK_UNKNOWN_PLATFORM.test(raw)) {
    return { status: 'unsupported-platform', ok: false, detail: '引擎不认识这个平台' }
  }
  if (MARK_SAVED.test(raw)) {
    return { status: 'saved', ok: true, detail: '采集成功并已写入本机凭证文件' }
  }
  if (MARK_TIMEOUT.test(raw)) {
    // 从超时行里把「最后状态」抠出来——那就是用户真正需要的下一步提示。
    const line = raw.split(/\r?\n/).find((l) => MARK_TIMEOUT.test(l)) ?? ''
    const tail = line.split('最后状态：')[1]?.trim()
    return {
      status: 'timeout',
      ok: false,
      detail: tail && tail !== '' ? `等待超时：${tail}` : '等待超时，没有采集到可用凭证',
    }
  }
  if (failure !== undefined) {
    if (failure === 'killed') {
      return { status: 'cancelled', ok: false, detail: '已取消：登录窗口被关闭，没有保存凭证' }
    }
    return { status: 'error', ok: false, detail: failure }
  }
  // 进程正常退出（码 0）却没有「采集成功」——这一点必须当成失败，
  // 不能因为退出码是 0 就当成功（脚本的 0 也可能是「什么都没做」）。
  return {
    status: 'no-conclusion',
    ok: false,
    detail: '登录流程结束了，但输出里没有成功标记——没有保存任何凭证',
  }
}

const MAX_LOG_CHARS = 4_000

/**
 * 登录进程注册表。
 *
 * 与 Credentials 分开写：那一个是「一次问一句、几秒答完」的 RPC，
 * 这一个是「跑几分钟、随时被问进度」的长任务，两者的超时语义相反
 * （前者越短越好，后者必须比人等的时间长），塞进一个类里必然互相拖累。
 */
export class Logins {
  #getConfig
  #logger
  /** @type {Map<string, object>} */
  #jobs = new Map()

  constructor(getConfig, logger) {
    this.#getConfig = getConfig
    this.#logger = logger
  }

  /** 该平台当前有没有在跑（供面板禁用按钮）。 */
  running(platform) {
    const job = this.#jobs.get(platform)
    return job !== undefined && job.status === 'running'
  }

  /**
   * 启动一次登录采集。
   *
   * 立刻返回，不 await 登录过程本身——见文件头注释。
   * 同一平台已有一个在跑时按**幂等**处理：返回现有任务的快照而不是再开一个窗口，
   * 否则用户连点两下就会弹出两个浏览器抢同一个配置目录。
   */
  start({ platform } = {}) {
    const id = String(platform ?? '').trim()
    if (!LOGIN_PLATFORMS.includes(id)) {
      return {
        ok: false,
        status: 'unsupported',
        detail: `平台「${id}」不支持在插件里发起登录（可用：${LOGIN_PLATFORMS.join(' / ')}）`,
      }
    }
    if (this.running(id)) {
      return { started: true, alreadyRunning: true, ...this.state({ platform: id }) }
    }

    const cfg = this.#getConfig()
    const engineDir = cfg.homeDir
    // 两类登录不同的入口脚本与参数：
    //   - Cookie 型（lingxi/jimeng）：cdp.py --capture <id>，登录中自动采集写盘；
    //   - profile 型（coze/kling）：<id>.py --login，登录后用户关窗，再 --dry-run 核验。
    const profileLogin = PROFILE_LOGIN_PLATFORMS.includes(id)
    const script = join(engineDir, 'adapters', profileLogin ? `${id}.py` : 'cdp.py')
    const args = profileLogin ? ['--login'] : ['--capture', id]
    const startedAt = new Date().toISOString()

    let child
    try {
      child = spawn(cfg.pythonCommand ?? 'python', [script, ...args], {
        cwd: engineDir,
        windowsHide: true,
        // stdin 必须是 pipe 而不是 inherit：继承 stdin 的子进程在某些终端里
        // 会和父进程抢输入，表现为「窗口开着但什么都没发生」。
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.#jobs.set(id, {
        platform: id,
        status: 'error',
        ok: false,
        detail: `无法启动 Python：${detail}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        output: '',
        pid: null,
      })
      return { ok: false, ...this.state({ platform: id }) }
    }

    // 用户的登录窗口知道自己要关的时候不需要我们插话，直接把 stdin 关掉。
    child.stdin?.end()

    const job = {
      platform: id,
      status: 'running',
      ok: false,
      detail: profileLogin
        ? '已打开登录窗口；在该窗口里登录，然后**亲手关闭这个窗口**（关闭后本插件才开始核验登录态）'
        : '已打开登录窗口，等待你在浏览器里完成登录',
      startedAt,
      finishedAt: null,
      output: '',
      pid: child.pid ?? null,
      child,
    }
    this.#jobs.set(id, job)

    child.stdout?.on('data', (chunk) => this.#append(job, chunk))
    child.stderr?.on('data', (chunk) => this.#append(job, chunk))
    child.on('error', (error) => {
      const detail = error instanceof Error ? error.message : String(error)
      this.#finish(job, error.code === 'ENOENT' ? 'python-missing' : detail)
    })
    // 登录窗口被用户关掉时适配器进程跟着退出。Cookie 型（cdp.py）在关窗前就已
    // 把凭证写盘，输出里的「采集成功」是唯一判据；profile 型（--login）关窗是
    // **正常流程的一步**，登录与否要靠随后的 `--dry-run` 核验，不能拿退出码充数。
    child.on('close', (code, signal) => {
      if (job.status !== 'running') return
      if (profileLogin) {
        this.#verifyProfileLogin(job, code, signal)
        return
      }
      const failure = code === 0 ? undefined : (signal !== null && signal !== undefined ? 'killed' : 'killed')
      const verdict = classifyCaptureOutput(job.output, failure)
      job.status = verdict.status
      job.ok = verdict.ok
      job.detail = verdict.detail
      job.exitCode = code
      this.#finish(job)
    })

    this.#logger.info('已启动 %s 的登录采集（pid %s）', id, job.pid ?? '?')
    // `started` 而不是 `ok`：这里表达的是「进程拉起来了」，登录成没成要等轮询。
    // 用 `ok` 会和快照里「这一轮登录是否成功」撞名（快照此刻必然是 ok:false）。
    return { started: true, ...this.state({ platform: id }) }
  }

  /** 主动取消：结束子进程，并把状态如实标成 cancelled。 */
  cancel({ platform } = {}) {
    const id = String(platform ?? '').trim()
    const job = this.#jobs.get(id)
    if (job === undefined) {
      return { ok: false, status: 'not-started', detail: '该平台没有进行中的登录' }
    }
    if (job.status !== 'running') {
      return { ok: false, status: job.status, detail: '该平台的登录已经结束了' }
    }
    job.status = 'cancelled'
    job.ok = false
    job.detail = '已取消：登录没有完成'
    job.finishedAt = new Date().toISOString()
    job.exitCode = null
    try {
      job.child?.kill()
    } catch {
      /* 已经结束了 */
    }
    this.#logger.info('已取消 %s 的登录采集', id)
    // `cancelled: true` 是「这个动作执行了」；快照的 `status:'cancelled'` + `ok:false`
    // 是「这一轮登录没有成功」。两个维度分开说，别让 HTTP 层去猜。
    return { cancelled: true, ...this.state({ platform: id }) }
  }

  /**
   * 某一平台的登录快照。**不含 pid、不含输出全文以外的任何本机路径**：
   * 面板是浏览器页面，不该多知道一点本机的事。
   */
  state({ platform } = {}) {
    const id = String(platform ?? '').trim()
    const job = this.#jobs.get(id)
    if (job === undefined) {
      return {
        platform: id,
        status: 'idle',
        ok: false,
        running: false,
        detail: '还没有在本次会话里发起过登录',
        startedAt: null,
        finishedAt: null,
        output: '',
      }
    }
    return {
      platform: id,
      status: job.status,
      ok: job.ok === true,
      running: job.status === 'running',
      detail: job.detail ?? '',
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      output: job.output,
      exitCode: job.exitCode ?? null,
    }
  }

  /** 所有平台的快照，用于面板首屏渲染（不必为每个平台各发一次请求）。 */
  states() {
    return Object.fromEntries(LOGIN_PLATFORMS.map((id) => [id, this.state({ platform: id })]))
  }

  /** 取消所有在跑的登录（插件卸载时用，免得留下孤儿子进程）。 */
  dispose() {
    for (const job of this.#jobs.values()) {
      if (job.status !== 'running') continue
      job.status = 'cancelled'
      job.ok = false
      job.detail = '已取消：插件被卸载，登录没有完成'
      job.finishedAt = new Date().toISOString()
      try {
        job.child?.kill()
      } catch {
        /* 已结束 */
      }
    }
  }

  #append(job, chunk) {
    job.output += String(chunk)
    // 只保留尾部：cdp.py 正常只打十几行，但我们不能假设它不会刷屏，
    // 一个长任务把内存吃满比看不到日志更糟。
    if (job.output.length > MAX_LOG_CHARS) {
      job.output = job.output.slice(job.output.length - MAX_LOG_CHARS)
    }
  }

  #finish(job, failure) {
    if (job.status !== 'running') return
    const verdict = classifyCaptureOutput(job.output, failure)
    job.status = verdict.status
    job.ok = verdict.ok
    job.detail = verdict.detail
    job.finishedAt = new Date().toISOString()
    if (verdict.ok) {
      this.#logger.info('%s 的登录采集成功', job.platform)
    } else {
      this.#logger.warn('%s 的登录采集未成功：%s', job.platform, job.detail)
    }
  }

  /**
   * Profile 型登录（coze/kling）关窗后的核验：跑 `<id>.py --dry-run`，
   * 它会读独立 profile、按各平台自己的方式确认登录态。
   *
   * 退出码**不能**当结论——用户没登录就关了窗口，脚本同样退出 0，
   * 但 dry-run 的 JSON 里写着「未登录」。所以只认最后一行 JSON 的
   * `result` 字段，认不出就老实报「未知」，绝不猜成成功。
   */
  #verifyProfileLogin(job, code, signal) {
    if (signal !== null && signal !== undefined) {
      job.status = 'cancelled'
      job.ok = false
      job.detail = '登录窗口被强制终止，登录没有完成'
      job.finishedAt = new Date().toISOString()
      return
    }
    const cfg = this.#getConfig()
    const script = join(cfg.homeDir, 'adapters', `${job.platform}.py`)
    job.exitCode = code
    job.detail = '登录窗口已关闭，正在核验登录态…'
    let child
    try {
      child = spawn(cfg.pythonCommand ?? 'python', [script, '--dry-run'], {
        cwd: cfg.homeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      job.status = 'error'
      job.ok = false
      job.detail = `核验登录态失败，无法启动 Python：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = new Date().toISOString()
      this.#logger.warn('%s 的登录核验没有跑起来：%s', job.platform, job.detail)
      return
    }
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
      if (out.length > MAX_LOG_CHARS) out = out.slice(out.length - MAX_LOG_CHARS)
    })
    child.stderr?.on('data', (chunk) => {
      out += String(chunk)
      if (out.length > MAX_LOG_CHARS) out = out.slice(out.length - MAX_LOG_CHARS)
    })
    job.output += out
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已结束 */
      }
    }, PROFILE_VERIFY_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      job.status = 'error'
      job.ok = false
      job.detail = '核验登录态失败：Python 子进程没能启动'
      job.finishedAt = new Date().toISOString()
    })
    child.on('close', () => {
      clearTimeout(timer)
      job.output += out
      const verdict = classifyProfileVerify(job.platform, out)
      job.status = verdict.status
      job.ok = verdict.ok
      job.detail = verdict.detail
      job.finishedAt = new Date().toISOString()
      if (verdict.ok) {
        this.#logger.info('%s 的登录核验通过', job.platform)
      } else {
        this.#logger.warn('%s 的登录核验未通过：%s', job.platform, job.detail)
      }
    })
  }
}
