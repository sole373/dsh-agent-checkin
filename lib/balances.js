/**
 * 「每个产品当前积分」的用户侧数据：实测优先，手动可改。
 *
 * 两条来源、优先级从高到低：
 *
 * 1. **实测值**（`measured`）：签到引擎本轮真实读到的余额，随 `lastRun` 走，
 *    本模块不管——这里只处理第 2 条。
 * 2. **手动值**（`manual`）：用户在面板上直接填的数字。有些平台插件根本
 *    读不到余额（如可灵、即梦没有本地余额接口），有些平台用户想记一个
 *    引擎看不到口径的数（如「灵感动画另算的部分」）。这不是造假：
 *    面板上永远标明每个数来自哪里，手动值带着「手动」标签。
 *
 * 存储是插件状态目录下的 `checkin-balance-overrides.json`：
 *   { "version": 1, "balances": { "<platformId>": { "value": 1500, "note": "…", "updatedAt": "…" } } }
 *
 * 三条纪律：
 * - **不跨平台求和**：各平台积分是不同币种，这里只存不加。
 * - **写前校验**：value 必须是非负有限数字，note 长度有上限；写盘走「写临时
 *   文件再改名」，坏一半也不会把旧数据弄丢。
 * - **来源可查**：`resolve()` 返回的每一项都带 `source`（measured / manual / none），
 *   前端照实话讲，不把手动值冒充实测值。
 */

import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const STORE_NAME = 'checkin-balance-overrides.json'
export const STORE_VERSION = 1

/** 手动备注的长度上限：够写「含活动赠送」这类说明，防一段作文把面板撑爆。 */
export const NOTE_MAX_LENGTH = 120

/**
 * 非负有限数字校验。布尔是 int 的子类，必须先挡掉——
 * `true` 若被当成 1 存进去，面板就会显示一个谁也没填过的 1。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isManualBalanceValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** @param {unknown} value */
function sanitizeNote(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, NOTE_MAX_LENGTH)
}

/** @param {unknown} raw 磁盘上读到的整个 JSON */
function sanitizeStore(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore()
  const balances = raw.balances
  if (balances === null || typeof balances !== 'object' || Array.isArray(balances)) return emptyStore()
  const out = {}
  for (const [platform, entry] of Object.entries(balances)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { value, note, updatedAt } = entry
    if (!isManualBalanceValue(value)) continue
    out[platform] = {
      value,
      note: sanitizeNote(note),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    }
  }
  return { version: STORE_VERSION, balances: out }
}

function emptyStore() {
  return { version: STORE_VERSION, balances: {} }
}

export class Balances {
  /**
   * @param {{ dir: () => string, logger?: {info?: Function, warn?: Function} }} deps
   *   `dir()` 返回存放状态文件的目录（插件状态目录），每次调用现取。 */
  constructor(deps) {
    this.#deps = deps
  }

  #deps
  #cache = null

  /** 状态文件绝对路径。 */
  path() {
    return join(this.#deps.dir(), STORE_NAME)
  }

  /**
   * 读所有手动值（返回深拷贝：条目对象也复制，调用方改不动缓存）。
   * 之前只展开外层 `{...balances}`、条目对象仍与缓存共享——调用方一改
   * 返回值里的条目，缓存就被污染。文档说了「返回内部拷贝」，就说到做到。
   * 文件不存在 = 没有任何手动值，这是正常状态不是错误。
   */
  async list() {
    if (this.#cache !== null) {
      return Object.fromEntries(
        Object.entries(this.#cache.balances).map(([id, entry]) => [id, { ...entry }]),
      )
    }
    const path = this.path()
    if (!existsSync(path)) {
      this.#cache = emptyStore()
      return {}
    }
    try {
      const text = await readFile(path, 'utf8')
      const parsed = sanitizeStore(JSON.parse(text))
      this.#cache = parsed
      return Object.fromEntries(
        Object.entries(parsed.balances).map(([id, entry]) => [id, { ...entry }]),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#deps.logger?.warn?.('读手动积分文件失败（按没有手动值处理）：%s', message)
      return {}
    }
  }

  /**
   * 写/改某平台的手动值。`value === null` 表示清除该项目（回到「无手动值」）。
   * @param {{ platform: string, value: number|null, note?: string }} input
   */
  async set({ platform, value, note }) {
    const id = String(platform ?? '').trim()
    if (id === '') {
      return { ok: false, status: 'invalid', detail: 'platform 不能为空' }
    }
    const balances = await this.list()
    if (value === null) {
      if (balances[id] === undefined) {
        // 清除一个本来就没有的项：目标状态已达成，如实说明而不是报错。
        return { ok: true, changed: false, platform: id, manual: null }
      }
      delete balances[id]
    } else {
      if (!isManualBalanceValue(value)) {
        return { ok: false, status: 'invalid', detail: '积分必须是不小于 0 的数字' }
      }
      balances[id] = { value, note: sanitizeNote(note), updatedAt: new Date().toISOString() }
    }
    const store = { version: STORE_VERSION, balances }
    const path = this.path()
    try {
      await mkdir(this.#deps.dir(), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
      await rename(tmp, path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status: 'write-failed', detail: `写入手动积分失败：${message}` }
    }
    this.#cache = store
    return {
      ok: true,
      changed: true,
      platform: id,
      manual: value === null ? null : { ...balances[id] },
    }
  }

  /**
   * 合成「面板/看板要显示的那个数」：实测优先，手动兜底。
   * @param {string} platform 平台 id
   * @param {{ balance: number|null, balanceSource?: string|null }} measured 本轮实测（没有传 {balance:null}）
   */
  async resolve(platform, measured = { balance: null }) {
    const manualMap = await this.list()
    const manual = manualMap[platform]
    const mBalance = typeof measured?.balance === 'number' && Number.isFinite(measured.balance)
      ? measured.balance
      : null
    if (mBalance !== null) {
      return {
        balance: mBalance,
        source: 'measured',
        // measured 的来源字段（引擎归一化写的 balance_source_field）原样透传。
        detail: measured?.balanceSource ?? null,
        manual: manual ?? null,
      }
    }
    if (manual !== undefined) {
      return { balance: manual.value, source: 'manual', detail: manual.note || null, manual }
    }
    return { balance: null, source: 'none', detail: null, manual: null }
  }

  /** 缓存只在成功写盘后更新；外部改了文件（罕见）下次读盘自然看到。 */
  forgetCache() {
    this.#cache = null
  }
}
