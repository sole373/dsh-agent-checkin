/**
 * 幂等与状态持久化。
 *
 * 这个模块刻意做成**纯函数 + 显式依赖**，不碰 ctx、不碰时钟（`now` 由调用方给）：
 * 幂等逻辑一旦不确定，测试就只能靠等一天才能验证，那等于没测。
 *
 * ## 为什么要幂等
 *
 * 每日定时和手动 `/checkin` 完全可能撞在同一天里。`inFlight` 只挡「同一时刻并发」，
 * 挡不住「上午跑过一次、下午又跑一次」——那会对同一平台发起第二次领取请求。
 * skill 的纪律是「幂等优先」，这里落实成：**同一自然日内，已经成功领取过的平台不再重领**。
 *
 * 不把粒度做成「整轮」是有理由的：一轮里各平台独立，某平台失败不该连累其它平台，
 * 也不该让整个轮次因为一个平台而无法重试。
 *
 * ## 为什么失败要允许重试
 *
 * 一次网络抖动不该毁掉一整天。只有**成功**（success 桶）才记为「今天做过了」；
 * 失败、被沙箱挡住、未知一律不记，下次照常尝试。宁可多试一次，也不要因为一次
 * 偶发失败就整天不再领取。
 *
 * @module dsh-agent-checkin/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 状态文件 schema 版本。
 *
 * 带版本号是为了将来结构变了能**识别出来**而不是误读：旧版本读不懂就当作没有历史，
 * 而不是拿错字段去判断「今天已经领过」——那种误判会让人白白损失一天的签到。
 */
export const STATE_VERSION = 1

/** 状态文件名（相对插件状态目录）。 */
export const STATE_FILE = 'last-run.json'

/**
 * 本机自然日标识（YYYY-MM-DD，本地时区）。
 *
 * 用本地日期而不是 UTC：用户理解「今天」是按自己的钟表，不是按格林尼治。
 * 用 ±1 天的偏差去判断「今天领过没有」会让人在半夜踩坑。
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function localDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 哪些结果算「今天这个平台已经做过了」。
 *
 * 只有 success 桶算。特别是：
 *   - `DRY_RUN` / `READONLY` 不算 —— 演练没动余额，正式跑时必须放行
 *   - `SANDBOX_BLOCKED` 不算 —— 环境问题，换环境就该能跑
 *   - 任何 failure 都不算 —— 允许重试
 */
const DONE_CODES = new Set(['OK', 'ALREADY', 'DONE'])

/**
 * 判断一行结果是否「已在本日完成领取」。
 * @param {{code?: string, claiming?: boolean}} row
 */
export function isClaimedDone(row) {
  return row?.claiming === true && DONE_CODES.has(String(row.code ?? '').toUpperCase())
}

/**
 * 从上一轮结果里提取本日已完成的平台 → 该平台的结果行。
 *
 * @param {object|null} previous 上一轮完整结果（`{ dryRun, rows, finishedAt }`）
 * @param {string} today `localDay()` 的结果
 * @returns {Map<string, object>} platform id → 那一次成功的行
 */
export function claimedToday(previous, today) {
  const claimed = new Map()
  if (!previous || typeof previous !== 'object') return claimed
  // 跨日了就没有「今天已领过」这回事。
  const previousDay =
    typeof previous.day === 'string'
      ? previous.day
      : typeof previous.finishedAt === 'string'
        ? localDay(new Date(previous.finishedAt))
        : null
  if (previousDay !== today) return claimed
  // 上一轮本身是演练，那它什么都没领，不能拿来当「今天已领过」的证据。
  if (previous.dryRun === true) return claimed
  for (const row of Array.isArray(previous.rows) ? previous.rows : []) {
    if (!row || typeof row.id !== 'string') continue
    if (isClaimedDone(row)) claimed.set(row.id, row)
  }
  return claimed
}

/**
 * 决定这一轮实际该请求哪些平台。
 *
 * @param {object} options
 * @param {string[]|undefined} options.only 调用方指定的平台；省略表示全部
 * @param {object|null} options.previous 上一轮结果
 * @param {string} options.today 本机自然日
 * @param {boolean} options.dryRun 本轮是否演练（演练不做幂等跳过）
 * @param {boolean} options.force 强制重跑，绕过幂等
 * @param {readonly {id: string}[]} options.platforms 全部平台
 * @returns {{run: string[], skipped: {id: string, name: string, code: string}[]}}
 */
export function planRound({ only, previous, today, dryRun, force, platforms }) {
  const wanted = Array.isArray(only) && only.length > 0 ? only : platforms.map((p) => p.id)

  // 演练不跳过：只读核对本来就不动余额，重复跑没有代价，而且用户可能就是想刷新余额看一眼。
  if (dryRun || force) {
    return { run: wanted, skipped: [] }
  }

  const done = claimedToday(previous, today)
  const run = []
  const skipped = []
  for (const id of wanted) {
    const hit = done.get(id)
    if (hit) {
      skipped.push({ id, name: hit.name ?? id, code: hit.code })
    } else {
      run.push(id)
    }
  }
  return { run, skipped }
}

/**
 * 只保留可以落盘、且**不含任何凭证**的字段。
 *
 * 这是一个白名单，不是黑名单：将来引擎多返回了字段，默认不会被动写进磁盘。
 * 签到状态文件里出现 token / cookie / 密钥，就是把「只读不外传」的纪律换成隐患。
 *
 * @param {object} run 完整一轮结果
 */
export function toPersistable(run) {
  const rows = Array.isArray(run?.rows) ? run.rows : []
  return {
    version: STATE_VERSION,
    day: typeof run.day === 'string' ? run.day : localDay(new Date(run?.finishedAt ?? Date.now())),
    finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
    dryRun: run?.dryRun === true,
    claimed: run?.claimed === true,
    downgraded: run?.downgraded === true,
    source: typeof run?.source === 'string' ? run.source : 'unknown',
    elapsedMs: typeof run?.elapsedMs === 'number' ? run.elapsedMs : null,
    summary: run?.summary ?? null,
    rows: rows.map((row) => ({
      id: typeof row.id === 'string' ? row.id : 'unknown',
      name: typeof row.name === 'string' ? row.name : '未知平台',
      unit: typeof row.unit === 'string' ? row.unit : '',
      claiming: row.claiming === true,
      code: typeof row.code === 'string' ? row.code : 'UNKNOWN',
      codeLabel: typeof row.codeLabel === 'string' ? row.codeLabel : '',
      bucket: typeof row.bucket === 'string' ? row.bucket : 'unknown',
      // detail 里可能带服务器返回的片段，但它不含凭证；保留它是为了能追溯失败原因。
      detail: typeof row.detail === 'string' ? row.detail : '',
      balance: typeof row.balance === 'number' ? row.balance : null,
      balanceNote: typeof row.balanceNote === 'string' ? row.balanceNote : '',
      balanceSource: typeof row.balanceSource === 'string' ? row.balanceSource : 'none',
    })),
  }
}

/**
 * 从磁盘读回上一轮结果。
 *
 * 任何异常都降级为 `null`（当作没有历史），不抛：
 * 状态文件损坏不该让整个插件激活失败，而「没有历史」是插件本来就能正常工作的状态。
 *
 * @param {string} filePath
 * @returns {object|null}
 */
export function readState(filePath) {
  try {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    // 版本不认识就当作没历史，而不是拿未知结构去判断「今天领过没有」。
    if (parsed.version !== STATE_VERSION) return null
    if (!Array.isArray(parsed.rows)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 原子写入状态文件。
 *
 * 先写临时文件再 rename：中途崩溃时要么是旧内容、要么是新内容，不会是半截 JSON。
 * 写入失败只返回 false，不抛——存不下状态不该让一次成功的签到变成失败。
 *
 * @param {string} filePath
 * @param {object} run 完整一轮结果
 * @returns {boolean}
 */
export function writeState(filePath, run) {
  const payload = toPersistable(run)
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      if (existsSync(tmp)) writeFileSync(tmp, '', 'utf8')
    } catch {
      // 清理失败也无所谓，临时文件名带 pid，不会覆盖真实状态。
    }
    return false
  }
}

/**
 * 状态文件路径：`<root>/last-run.json`。
 * @param {string} root 状态目录
 */
export function statePath(root) {
  return join(root, STATE_FILE)
}
