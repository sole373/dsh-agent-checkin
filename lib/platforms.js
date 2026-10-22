/**
 * 平台目录：把 AICheckin 的十个适配器映射成插件侧稳定标识。
 *
 * 「是否真实领取」是这里最关键的字段：
 *   - claiming: true   → 有明确的领取动作，跑一轮会真实改变余额
 *   - claiming: false  → 只读或「打开即发放」，**没有可调用的领取接口**
 *
 * 把这个区分做进类型里，是为了守住一条纪律：只读结果不能混进「签到成功」。
 * 否则既虚增了成功数，又把一个不存在的动作伪装成了已完成。
 *
 * @module dsh-agent-checkin/platforms
 */

/**
 * @typedef {object} PlatformSpec
 * @property {string} id      传给桥接层的 `--only` 值
 * @property {string} name    展示名
 * @property {string} unit    余额单位（各平台币种不同，不可相加）
 * @property {boolean} claiming 是否存在真实的领取动作
 * @property {string} note    备注
 */

/** @type {readonly PlatformSpec[]} */
export const PLATFORMS = Object.freeze([
  {
    id: 'workbuddy',
    name: 'WorkBuddy（国内版）',
    unit: '积分',
    claiming: true,
    note: 'Electron at-rest 凭证；每日签到有真实增额',
  },
  {
    id: 'workbuddy_intl',
    name: 'WorkBuddy（国际版）',
    unit: 'credits',
    claiming: true,
    note: '与国内版同源但凭证库独立',
  },
  {
    id: 'trae',
    name: 'TRAE Work',
    unit: '积分',
    claiming: true,
    note: '自定义 AES-CBC 凭证；注意服务端可能标记设备号（9074），本插件不会更换设备号',
  },
  {
    id: 'lingxi',
    name: 'WPS 灵犀',
    unit: '积分',
    claiming: true,
    note: '浏览器 Cookie 方案',
  },
  {
    id: 'jimeng',
    name: '即梦 AI',
    unit: '灵感值',
    claiming: false,
    note: '需真实浏览器（CDP）执行，只读核对会返回演练态',
  },
  {
    id: 'kling',
    name: '可灵 AI',
    unit: '灵感值',
    claiming: false,
    note: '「以登录状态访问」即当日福利的领取方式；可在设置面板发起登录（独立浏览器 profile），没有领取接口',
  },
])

/** @type {Map<string, PlatformSpec>} */
export const PLATFORM_BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]))

/**
 * 结果码分桶。四桶之外一律进 `unknown`——**不猜**。
 * `readonly` 单独成桶而不并入 success，是这套系统的核心诚实性约束。
 *
 * `blocked` 与 `failure` 分开，是因为二者对使用者意味着完全不同的行动：
 *   - failure：平台侧的事（登录过期、被风控、网络不通）→ 去重新登录
 *   - blocked：**本机运行环境**的事（沙箱不让写临时目录）→ 换个环境重跑即可
 * 把沙箱拒绝混进 `failure` 会让人误以为凭证坏了，从而去做无用的重新登录。
 */
export const RESULT_CODES = Object.freeze({
  success: Object.freeze(['OK', 'ALREADY', 'DONE']),
  neutral: Object.freeze(['DRY_RUN', 'READONLY', 'INACTIVE']),
  blocked: Object.freeze(['SANDBOX_BLOCKED']),
  failure: Object.freeze([
    'AUTH_REJECTED',
    'FORBIDDEN',
    'NETWORK',
    'ERROR',
    'EXCEPTION',
  ]),
})

/**
 * 识别「不是平台的问题，是本机环境的问题」的失败。
 *
 * 现实成因：适配器解密凭证时要 `tempfile.mkdtemp()` 写密钥文件，再调 Node 做
 * AES-256-GCM。在 DSH 的 workspace-write 沙箱里，子进程的 `TMP`/`TEMP` 会被
 * 重定向且**目录可建、文件不可写**，于是抛 `PermissionError [Errno 13]`。
 *
 * 问题在于上游适配器把它归到了「凭证不可用」（适配器把
 * `FileNotFoundError/ValueError/OSError` 一起捕获）。那个措辞会把人引向
 * 「重新登录」，而重新登录根本解决不了沙箱限制。这里不改适配器（两个项目共用
 * 它），只在插件侧**据实重判结果码**，并保留原始 detail 供追溯。
 *
 * @param {string} detail 适配器给出的原始说明
 * @returns {boolean}
 */
export function looksLikeSandboxDenial(detail) {
  if (typeof detail !== 'string' || detail === '') return false
  // 只认「权限拒绝」这一族；泛化的 ERROR 不动，避免把真问题吞掉。
  const denied = /\[Errno 13\]|PermissionError|file access denied|拒绝访问/i.test(detail)
  if (!denied) return false
  // 再要求一条「确实指向运行环境」的线索，才排除「凭证文件本身不可读」这类真故障。
  // 两种线索都算数：①路径在临时目录下 ②报错本身点名 sandbox（DSH 会单独插一行
  // `[sandbox: file access denied under workspace-write mode]`，那一行没有路径）。
  const sandboxTmp = /\\Temp\\|\\temp\\|\/tmp\/|TMPDIR|\bTEMP\b|dsh-[A-Za-z0-9]{6,}/i.test(detail)
  const sandboxNamed = /sandbox|workspace-write/i.test(detail)
  return sandboxTmp || sandboxNamed
}

/**
 * 沙箱拒绝的说明文案。点明「不是凭证问题」，否则使用者会白跑一趟重新登录。
 * @param {string} original 适配器原始 detail
 */
export function sandboxDenialDetail(original) {
  return (
    '运行环境阻止了写临时文件，不是凭证问题：适配器需要 mkdtemp 写解密密钥，' +
    '当前沙箱（workspace-write）允许建目录但拒绝写文件，因此无法解密本地凭证。' +
    '在桌面版正常环境或关闭沙箱后重跑即可。原始报错：' +
    original
  )
}

/**
 * 是否为「可以当成余额展示」的数字。
 *
 * 三个坑逐条挡掉：
 *   - NaN / Infinity：JSON 里不会出现，但适配器算错时可能传进来，显示成 NaN 会误导；
 *   - '1500' 这种数字字符串：不猜，宁可显示「未取到」也不做隐式转换；
 *   - true：`typeof true === 'boolean'` 已排除，但 JSON 里 true 与 1 易混，这里显式挡。
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

const CODE_BUCKET = new Map([
  ...RESULT_CODES.success.map((c) => [c, 'success']),
  ...RESULT_CODES.neutral.map((c) => [c, 'neutral']),
  ...RESULT_CODES.blocked.map((c) => [c, 'blocked']),
  ...RESULT_CODES.failure.map((c) => [c, 'failure']),
])

const CODE_LABEL = Object.freeze({
  OK: '签到成功',
  ALREADY: '今日已签到',
  DONE: '已完成',
  DRY_RUN: '演练（未领取）',
  READONLY: '只读（无领取动作）',
  INACTIVE: '不适用',
  SANDBOX_BLOCKED: '被本机沙箱拦截（非凭证问题）',
  AUTH_REJECTED: '登录态失效',
  FORBIDDEN: '被拒绝',
  NETWORK: '网络失败',
  ERROR: '出错',
  EXCEPTION: '异常',
})

/**
 * 把桥接层返回的原始行规范化。
 *
 * 桥接层已把 `platform` 收敛成稳定 id，适配器自报的中文展示名放在 `name`
 * （见 `bridge.py` 的 `normalize_result`）。这里优先按 id 精确命中；对更早的
 * 桥接层版本还会把展示名塞在 `platform` 里，所以保留一次名称反查作为兼容。
 * 都查不到就保留原文，让界面显示明确的「未知平台」而不是错误地归到某个平台。
 *
 * @param {Record<string, unknown>} raw
 */
export function normalizeRow(raw) {
  const rawName = typeof raw.platform === 'string' ? raw.platform : ''
  const spec =
    PLATFORM_BY_ID.get(rawName) ??
    PLATFORMS.find((p) => rawName.includes(p.name) || p.name.includes(rawName)) ??
    null
  const rawDetail = typeof raw.detail === 'string' ? raw.detail : ''
  let code = typeof raw.result === 'string' ? raw.result.toUpperCase() : 'UNKNOWN'

  // 据实重判：适配器把沙箱拒绝报成「凭证不可用 / ERROR」，这里纠正成环境问题。
  // 只改判「失败」族；已明确为 AUTH_REJECTED 等平台侧结论的不动。
  let detail = rawDetail
  if (code === 'ERROR' || code === 'EXCEPTION') {
    if (looksLikeSandboxDenial(rawDetail)) {
      code = 'SANDBOX_BLOCKED'
      detail = sandboxDenialDetail(rawDetail)
    }
  }
  const bucket = CODE_BUCKET.get(code) ?? 'unknown'

  // 余额：只认数字，绝不把「没读到」写成 0。
  //
  // 桥接层（engine/bridge.py 的 BALANCE_FALLBACK_FIELDS）已经把各平台的专用字段
  // 统一成 balance，理论上读到 raw.balance 就够了。这里仍然兜一层，是因为
  // 使用者可以把 homeDir 指向自己那份 AICheckin——那份不一定带这个补丁，
  // 余额会继续留在 total / total_credits 里。看板的纪律是「读到了就得显示出来」，
  // 字段没对齐就显示成「未取到」属于反向假报，所以按 id 再认一次等价字段。
  //
  // 只放确实等价于可用余额的字段：TRAE 的 credits_limit 是总额，绝不能当余额。
  const FALLBACK_BALANCE_FIELDS = {
    trae: ['total_credits'],
    workbuddy: ['total_credits'],
  }
  let balanceValue = isFiniteNumber(raw.balance) ? raw.balance : null
  if (balanceValue === null) {
    for (const field of FALLBACK_BALANCE_FIELDS[spec?.id] ?? []) {
      if (isFiniteNumber(raw[field])) {
        balanceValue = raw[field]
        break
      }
    }
  }
  return {
    id: spec?.id ?? (rawName || 'unknown'),
    name: spec?.name ?? (rawName || '未知平台'),
    unit: spec?.unit ?? (typeof raw.balance_unit === 'string' ? raw.balance_unit : ''),
    claiming: spec?.claiming ?? false,
    code,
    codeLabel: CODE_LABEL[code] ?? `未识别结果码 ${code}`,
    bucket,
    detail,
    balance: balanceValue,
    balanceNote: typeof raw.balance_note === 'string' ? raw.balance_note : '',
    // 余额是本次实时拉到的，还是适配器标注为其它口径？留着让界面如实呈现。
    balanceSource: balanceValue === null ? 'none' : 'live',
  }
}

/**
 * 汇总一轮结果。
 *
 * **刻意只计数、从不跨平台累加余额**：积分 / credits / 灵感值是不同币种，
 * 相加得到的数字没有任何意义，只会误导使用者。
 *
 * @param {ReturnType<typeof normalizeRow>[]} rows
 */
export function summarize(rows) {
  const summary = {
    total: rows.length,
    success: 0,
    neutral: 0,
    /** 本机环境挡住、换个环境就能跑的——单列，不并入 failure */
    blocked: 0,
    failure: 0,
    unknown: 0,
    /** 有真实领取动作且结果为成功的平台数——即「签到正常」的严格口径 */
    healthy: 0,
  }
  for (const row of rows) {
    summary[row.bucket] += 1
    if (row.bucket === 'success' && row.claiming) summary.healthy += 1
  }
  return summary
}

/**
 * 主机名字符串是否指向本机回环。
 *
 * 单独成函数、放在这一层，是因为它被三处共用：只读看板、设置面板的读接口、
 * 设置面板的写接口。三处各写一份判据，迟早会有一处被「顺手放宽」——而这个
 * 判据一旦放宽，等于把「能开关真实领取、能写凭证」的面板暴露给了外部页面。
 *
 * @param {unknown} value 形如 `127.0.0.1`、`127.0.0.1:14021`、`localhost:8080`
 */
export function isLoopbackHost(value) {
  if (typeof value !== 'string' || value === '') return false
  return (
    value === 'localhost' ||
    value.startsWith('localhost:') ||
    value === '127.0.0.1' ||
    value.startsWith('127.0.0.1:') ||
    value === '[::1]' ||
    value.startsWith('[::1]:')
  )
}

/**
 * 请求是否来自本机回环。
 *
 * `host` 缺失即判否：HTTP/1.1 要求必带 Host，缺失说明不是正常浏览器流量。
 * `origin` 缺失（同源 GET、curl）判是；存在时必须同样是回环，否则拒绝——
 * 这一条挡住的是「外部页面用浏览器打本机端口」的路径。
 *
 * 注意这**只**是读接口的门槛。写接口还要求 Origin 与 Host 严格同源，
 * 见 settings-routes.js 的 sameOriginOk：读接口容忍无 Origin，写接口不容忍。
 */
export function isLoopbackRequest(req) {
  if (!isLoopbackHost(req?.headers?.host)) return false
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  try {
    return isLoopbackHost(new URL(origin).host)
  } catch {
    return false
  }
}
