/**
 * 签到引擎：以子进程方式驱动 Python 桥接层，把结果收敛成插件内部结构。
 *
 * 为什么走子进程而不是在 Node 里重写解密：十个平台的凭证解密方式各不相同
 * （Electron at-rest AES-256-GCM、Chromium OSCrypt、纯标准库 AES-CBC、
 * Ed25519 签名、CDP 浏览器自动化）。这些实现已经由 AICheckin 打磨过并被
 * 实测覆盖，重写一遍只会引入新的失败面。插件的职责是**调度与呈现**。
 *
 * @module dsh-agent-checkin/engine
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * 插件自带的那份签到引擎位置：`<package root>/engine`。
 *
 * 市场装出来的包没有用户机器上的 AICheckin 检出，所以默认值必须指向包内。
 * `import.meta.url` → `lib/engine.js`，上级目录就是包根。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
export const BUNDLED_ENGINE_DIR = join(HERE, '..', 'engine')

/** 桥接层脚本在引擎目录下的固定相对位置。 */
const BRIDGE_REL = 'bridge.py'

/** 拼桥接层脚本路径。Windows 与 POSIX 都用各自的分隔符，不写死反斜杠。 */
function bridgePath(homeDir) {
  return join(homeDir, BRIDGE_REL)
}

/**
 * 在受控环境下运行一个 Python 脚本并收集 stdout/stderr。
 *
 * 刻意不复用 `ctx.subprocess`：该 seam 会剥掉形似凭据的环境变量，而签到适配器
 * 恰恰**需要**读取本机凭证路径相关的环境；同时它是可选的宿主服务，插件不应
 * 因为它缺席就整体激活失败。
 */
function runPython(command, args, options) {
  return new Promise((resolve, reject) => {
    const { cwd, timeoutMs, signal } = options
    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    const chunks = { stdout: [], stderr: [] }
    let stdoutBytes = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }

    const onAbort = () => {
      child.kill()
      finish(reject, new Error('签到被取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`签到超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    child.stdout.on('data', (buf) => {
      stdoutBytes += buf.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(reject, new Error('签到输出超过上限，已中止'))
        return
      }
      chunks.stdout.push(buf)
    })
    child.stderr.on('data', (buf) => chunks.stderr.push(buf))

    child.on('error', (error) => {
      finish(
        reject,
        new Error(
          error.code === 'ENOENT'
            ? `找不到可执行文件「${command}」，请确认已安装 Python 并加入 PATH`
            : `启动 ${command} 失败：${error.message}`,
        ),
      )
    })

    child.on('close', (code) => {
      finish(resolve, {
        exitCode: code,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      })
    })
  })
}

/** 从混杂的 stdout 里取出最后一行可解析的 JSON 对象。 */
function parseJsonOutput(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // 继续往前找：某些平台会打印带花括号的进度行。
    }
  }
  return null
}

export class CheckinEngine {
  /**
   * @param {object|(() => object)} config
   *   字面量配置，或返回当前配置的取值函数。传函数是为了让 `volatile` 配置项
   *   （settings 面板里能实时改的那些）在每次运行时被重新读取——在 apply 时
   *   一次性解构会让面板上的修改看起来生效、实际无效。
   * @param {object} logger
   */
  constructor(config, logger) {
    this.config = config
    this.logger = logger
  }

  /** 读取当前配置快照，供每次运行使用。 */
  currentConfig() {
    return typeof this.config === 'function' ? this.config() : this.config
  }

  /** 校验配置里指向的 Python 桥接层是否存在。 */
  async probe(signal) {
    const { pythonCommand, homeDir } = this.currentConfig()
    const script = bridgePath(homeDir)
    if (!existsSync(script)) {
      throw new Error(
        `签到引擎未找到：${script}\n`
          + 'homeDir 必须指向含 bridge.py 与 adapters/ 的目录。'
          + `插件自带的是 ${BUNDLED_ENGINE_DIR}，通常无需修改。`,
      )
    }
    const result = await runPython(
      pythonCommand,
      ['-c', 'import sys; sys.stdout.write(sys.version.split()[0])'],
      { cwd: homeDir, timeoutMs: 20_000, signal },
    )
    if (result.exitCode !== 0) {
      throw new Error(
        `Python 不可用（exit ${result.exitCode}）：${result.stderr.trim().split('\n')[0] ?? ''}`,
      )
    }
    return { python: result.stdout.trim(), script }
  }

  /**
   * 执行一轮签到。
   * @param {{dryRun?: boolean, only?: string[], signal?: AbortSignal}} options
   */
  async run(options = {}) {
    const { pythonCommand, homeDir, timeoutMs } = this.currentConfig()
    const script = bridgePath(homeDir)
    if (!existsSync(script)) {
      throw new Error(
        `签到引擎未找到：${script}\n`
          + '请检查 homeDir 配置（默认应为插件自带的 engine/ 目录）。',
      )
    }
    const args = [script, '--home', homeDir]
    if (options.dryRun) args.push('--dry-run')
    if (options.only?.length) args.push('--only', options.only.join(','))

    const started = Date.now()
    const result = await runPython(pythonCommand, args, {
      cwd: homeDir,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    })
    const elapsedMs = Date.now() - started

    const payload = parseJsonOutput(result.stdout)
    if (!payload) {
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n')
      throw new Error(
        `签到引擎未返回可解析结果（exit ${result.exitCode}）：\n${tail || '（无输出）'}`,
      )
    }
    if (payload.ok !== true) {
      throw new Error(String(payload.error ?? '签到引擎报告失败但未给出原因'))
    }
    return {
      dryRun: payload.dry_run === true,
      source: payload.source === 'live' ? 'live' : 'dry_run',
      generatedAt: payload.generated_at ?? null,
      elapsedMs,
      rows: Array.isArray(payload.results) ? payload.results : [],
    }
  }
}
