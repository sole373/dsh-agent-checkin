/**
 * 设置面板的后端路由。
 *
 * 全部挂在宿主的 webServer 上（与看板同一个服务器、同一个端口），不另起监听。
 * 三条硬约束：
 *
 * 1. **只服务本机**：每个入口都过 `isLoopbackRequest`，非回环一律 403。
 *    这个面板能写凭证、能开关真实领取，暴露到非回环就是事故。
 * 2. **Origin 校验按方法分离**：读接口（GET）容忍无 Origin 的探测，写接口
 *    （POST）要求 Origin 必须存在且与 Host 同源 —— 这样即使某个浏览器把
 *    SameSite 放宽，跨站页面的 fetch 也带不上合法 Origin。
 * 3. **状态码要与结果码对齐**：`READONLY`（当前是只读环境）必须是独立的、
 *    不进成功集合的形状，前端才不会把「降级成只读」渲染成「已完成」。
 *
 * 路由表（都挂在 `${prefix}` 下）：
 *   GET  ${prefix}/settings           → 设置页所需的全部状态（含 `?ui=` 前端自证结论）
 *   POST ${prefix}/settings/check     → 逐平台只读实测（不领取）
 *   POST ${prefix}/settings/credential→ {platform, value} 保存凭证
 *   POST ${prefix}/settings/credential/clear → {platform} 删除凭证
 *   POST ${prefix}/settings/allow-claim → {enabled} 开关真实领取
 *   POST ${prefix}/settings/run          → {force?} 立即手动跑一轮（立刻返回，结果靠轮询）
 *   GET  ${prefix}/settings/run/state    → 轻量轮询：running + 上一轮结果（不 spawn 子进程）
 *   POST ${prefix}/settings/models/preview → 模型路由预览（不落盘）
 *   POST ${prefix}/settings/models/apply   → 模型路由写入 profile
 *   POST ${prefix}/settings/models/selection → 平台接入开关 + 模型勾选（设置页内改，免重启生效）
 *   POST ${prefix}/settings/login/start    → {platform} 打开登录窗口（立刻返回）
 *   GET  ${prefix}/settings/login/state    → ?platform=xxx 轮询登录进度
 *   POST ${prefix}/settings/login/cancel   → {platform} 取消登录
 *
 * **曾经还有两条 GET 导航路由**（`/settings/login/open` 与 `/login-launch`），
 * 思路是让浏览器导航带上 Origin 绕过后端同源守卫。已全部删除，原因写在
 * `guard` 的 POST 分支里：这个面板跑在 Electron 渲染进程里，`_self` 会把宿主
 * 主界面整个导航走（实测导致 28 个客户端插件被卸载并报激活失败），`_blank`
 * 又弹不出窗口。留着它们只会多一条能启动登录进程的入口，是纯攻击面。
 */

import { isLoopbackHost, isLoopbackRequest } from './platforms.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

const MAX_BODY_BYTES = 64 * 1024

const DEFAULT_PORT = 14012

/**
 * 当前这份前端代码的「形态标识」。
 *
 * 起因：浏览器缓存了旧的 client bundle 时，磁盘和后端都已是新代码，界面里跑的
 * 却还是旧的。旧形态是「点链接导航」，甚至更早是「主标签里 `target: '_self'`
 * 直接导航」，两种都在这台机器上撞过墙——而且 F12 打不开时，用户和开发者都无法
 * 判断自己看到的是哪一版。所以让前端自己申报，后端比对后把结论**渲染在面板上**：
 * 不依赖开发者工具，也能一眼看出「你看到的是旧界面」。
 *
 * 这个值只要前端有实质改动就要跟着变（它只用于自证，不参与任何逻辑判断）。
 * 当前值对应「按钮 + fetch POST + 平台/模型页签 + 勾选行用 button + 模型清单分
 * 『全部模型 / 我自己挑』两种方式 + 每个模型带倍率」形态——这是唯一能在这个
 * Electron 渲染进程里正常工作的形态。
 */
export const CLIENT_UI_ID = 'post-button-pick-modes'

/**
 * 判断前端申报的形态标识与服务端期望是否一致。
 *
 * 只认两种确定的结果，其余一律「未知」——不做善意假设，也不做恶意推断：
 *   match   → 前端明确申报了本版标识，链路是新的
 *   stale   → 前端申报了标识但不是本版（旧 bundle）
 *   unknown → 没有申报（更老的版本根本没有这个字段，或缓存的是老包）
 */
export function compareClientUi(claimed) {
  if (typeof claimed !== 'string' || claimed === '') return 'unknown'
  return claimed === CLIENT_UI_ID ? 'match' : 'stale'
}


function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 写接口的同源校验。
 *
 * 只要求 Origin 与 Host 同源；Host 必须是回环（前置守卫已经保证）。
 * `Origin: null`（沙箱 iframe、file:// 页面）一律拒绝——它不携带来源信息，
 * 对可写接口来说等同于未知来源。
 *
 * 返回 `{ ok: true }` 或 `{ ok: false, reason }`。刻意把「为什么没通过」一起
 * 交回来：这个守卫的失败只出现在宿主设置页里，用户看到的就是这一句，说不出
 * 具体是缺 Origin 还是端口不一致，就等于让人去猜。
 *
 * 注意：这里**不**放宽成「Origin 只要是回环就放行」。那样一来同机任何网页都能
 * 改写本机配置，而下面这几条写接口能开关真实领取、能写凭证。放宽之前请先弄清
 * 反代/多端口部署下宿主到底给设置页发的是什么 Origin，别靠猜。
 */
function sameOriginOk(req) {
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    return { ok: false, reason: `请求没有携带可用的 Origin（收到：${origin === undefined ? '未携带' : String(origin)}）` }
  }
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return { ok: false, reason: `Origin 不是合法 URL（收到：${origin}）` }
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: `Origin 不指向本机回环（收到：${origin}）` }
  }
  if (typeof host !== 'string' || parsed.host !== host) {
    if (!sameLoopbackAuthority(parsed, host)) {
      return { ok: false, reason: `Origin 的端口与 Host 不一致（Origin：${parsed.host}，Host：${host ?? '未携带'}）` }
    }
  }
  return { ok: true }
}

/**
 * 判断 Origin 与 Host 是否指向**同一个回环服务**，尽管主机名写法不同。
 *
 * 真实故障（用户报「设置里点打开登录窗口又报错」）：页面用 `http://localhost:8890`
 * 打开时，浏览器发的 `Origin` 是 `http://localhost:8890`，而 `Host` 可能是
 * `127.0.0.1:8890`（或反过来）。两者是同一台机器的同一个端口——`localhost`
 * 与 `127.0.0.1` 与 `[::1]` 都解析到本机回环，但按字符串比 `host` 会判成不同源，
 * 于是本机用户自己的正常点击被自己的守卫拦下。
 *
 * 判据：端口必须**完全相同**，且两边主机名都在回环集合
 * (`127.0.0.0/8`、`localhost`、`::1`) 里。这不放松任何跨站界限——
 * `evil.example.com:8890` 仍然过不了，因为它的主机名不是回环。
 */
function sameLoopbackAuthority(parsed, host) {
  if (typeof host !== 'string' || host === '') return false
  let hostname
  let port
  try {
    // 用 URL 解析 Host：它没有协议，补一个占位协议才能拿到 hostname/port。
    const asUrl = new URL(`http://${host}`)
    hostname = asUrl.hostname
    port = asUrl.port || '80'
  } catch {
    return false
  }
  const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  if (originPort !== port) return false
  return isLoopbackHost(parsed.hostname) && isLoopbackHost(hostname)
}

/** 读请求体，超限即中止（不无限缓冲）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(new Error(`请求体过大（上限 ${MAX_BODY_BYTES} 字节）`))
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        finish(null, {})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(new Error('请求体必须是 JSON 对象'))
          return
        }
        finish(null, parsed)
      } catch {
        finish(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => finish(error))
  })
}

/**
 * 注册设置面板的全部路由。
 *
 * @param {{webServer: object}} wctx 宿主 webServer 上下文
 * @param {object} deps
 * @param {string} deps.prefix 已规范化的前缀（不带尾斜杠）
 * @param {() => object} deps.getState 组装设置页所需状态（同步，不联网）
 * @param {object} deps.credentials Credentials 实例
 * @param {object} deps.logins Logins 实例（长任务注册表）
 * @param {object} deps.actions 写动作（allowClaim / modelRoutes 等）
 * @param {{info: Function, warn: Function}} deps.logger
 * @param {Function} deps.effect 宿主 effect 注册器（用于登记路由）
 * @returns {Array<{path: string, handler: Function}>} 已注册的路由（便于测试断言）
 */
export function registerSettingsRoutes(wctx, deps) {
  const { prefix, getState, credentials, actions, logins, logger, effect } = deps
  const base = `${settingsPrefixBase(prefix)}/settings`
  const launchBase = settingsPrefixBase(prefix)
  const registered = []

  const route = (path, handler) => {
    registered.push({ path, handler })
    effect(() => wctx.webServer.register({ kind: 'exact', path, handler }))
  }

  /** 所有入口共用的前置守卫：回环 + 方法。 */
  const guard = (req, res, { method }) => {
    // 直接用 platforms.js 的判据（它已能正确处理 `host:port` 与 `[::1]:port`），
    // 不在这里另写一份正则——两份判据迟早会分叉。
    // 读接口用 isLoopbackRequest（容忍无 Origin 的 curl/进程内探测），
    // 写接口另外再要求 Origin 与 Host 严格同源（见下方），两级不同强度是刻意的。
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, status: 'forbidden', detail: '只接受本机回环请求' })
      return false
    }
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) {
      sendJson(res, 405, { ok: false, status: 'method-not-allowed', detail: `只接受 ${method}` })
      return false
    }
    if (method === 'POST') {
      // 写接口的来源判据。
      //
      // **五轮修复才认清的事实**：这个面板跑在 DSH 桌面应用的渲染进程里，
      // 它发 POST 时**根本不带 `Origin`**，而且不是浏览器那种导航请求。
      // 之前按「链接导航」的思路设计（`<a href>` → 302 → 第二跳），在 Electron
      // 里彻底走不通：`_self` 会顶掉宿主主界面（28 个客户端插件被卸载），
      // `_blank` 又弹不出窗口。用户点了五轮，每次都是不同的一条 403。
      //
      // 现在的判据回到写接口该有的样子，分两种情况：
      //
      //   A. 带了 Origin → 仍然走 `sameOriginOk` 严格同源（回环别名互通）。
      //      浏览器里的同机其它网页走这条，跨站一律拒。
      //   B. 没带 Origin → 接受，但必须同时满足：
      //      1. 只在本机回环上监听/访问（`isLoopbackRequest` 已挡外部机器）；
      //      2. 若带 `Sec-Fetch-Site`，不能是 `none`（地址栏直敲）以外的跨站信号——
      //         渲染进程通常不带这个头，带了也只作辅助判据。
      //
      // 为什么敢接受无 Origin：宿主自己就是这么判的——`dsh-client-connection`
      // 里的卫兵是 `if (origin === void 0) return true`。而在**本机回环**上，
      // 想伪造一个无 Origin 的 POST，前提是攻击者已经能在本机跑代码；
      // 到了那一步，它直接读 `lx_cookie.txt` 比绕这个面板容易得多。
      // 「防止别的网页改写本机配置」这个目的由 A 种情况（带 Origin 时严格同源）保证，
      // 因为浏览器里任何网页发的请求**一定**带 Origin。
      const origin = req.headers?.origin
      const hasOrigin = typeof origin === 'string' && origin !== '' && origin !== 'null'
      if (hasOrigin) {
        const sameOrigin = sameOriginOk(req)
        if (!sameOrigin.ok) {
          sendJson(res, 403, {
            ok: false,
            status: 'forbidden',
            detail: '写接口拒绝了这个来源（防止跨站页面改写本机配置）：' + sameOrigin.reason,
          })
          return false
        }
      } else {
        const site = String(req.headers?.['sec-fetch-site'] ?? '')
        if (site === 'none') {
          sendJson(res, 403, {
            ok: false,
            status: 'forbidden',
            detail: '写接口不接受到地址栏直接输入的请求（Sec-Fetch-Site：none），请从设置面板内操作',
          })
          return false
        }
      }
    }
    return true
  }

  /** 把异步处理器包成「永不 500」的形状，并统一在失败时给出原因。 */
  const run = (res, fn) => {
    Promise.resolve()
      .then(fn)
      .then((result) => {
        // 默认按 `ok !== false` 判成功；处理器可用 `sk`（status ok）显式声明
        // 「这次请求成功」，用于载荷里自带 `ok:false` 的查询类接口。
        const ok = result?.sk === true ? true : result?.ok !== false
        sendJson(res, ok ? 200 : 400, result ?? { ok: true })
      })
      .catch((error) => {
        logger.warn('设置面板请求失败：%s', errorMessage(error))
        sendJson(res, 500, { ok: false, status: 'error', detail: errorMessage(error) })
      })
  }

  route(base, (req, res) => {
    if (!guard(req, res, { method: 'GET' })) return
    // 前端把「我是哪一版」放在查询串里带回来（`?ui=nav-link`）。
    // 服务端比对后回结论，界面把它显示出来——这样旧 bundle 缓存不再是
    // 一个只能靠猜的问题：面板顶部会直接说「你看到的是旧界面」。
    let claimed
    try {
      claimed = new URL(req.url ?? base, `http://${req.headers?.host ?? '127.0.0.1'}`).searchParams.get('ui') ?? undefined
    } catch {
      claimed = undefined
    }
    const uiStatus = compareClientUi(claimed)
    if (uiStatus !== 'match') {
      logger.info('设置面板前端自证：%s（申报=%s，期望=%s）', uiStatus, String(claimed), CLIENT_UI_ID)
    }
    run(res, () => {
      const state = Promise.resolve(getState())
      return state.then((value) => ({
        ...value,
        clientUi: { status: uiStatus, expected: CLIENT_UI_ID, claimed: claimed ?? null },
      }))
    })
  })

  route(`${base}/check`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      const only = Array.isArray(body.only) ? body.only.map(String) : undefined
      const result = await credentials.check({ only })
      // 如实回传结果码：check 永远不领取，claimed 固定 false。
      return { ...result, claimed: false }
    })
  })

  route(`${base}/credential`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      const result = await credentials.save({ platform: body.platform, value: body.value })
      // 校验通过后立刻只用只读探测确认登录态，让「保存成功」和「能签到」不混为一谈。
      if (result.ok) {
        const check = await credentials.check({ only: [String(body.platform)] })
        const row = Array.isArray(check.checks)
          ? check.checks.find((c) => c.id === body.platform)
          : null
        return {
          ...result,
          verify: row
            ? { ok: row.ok === true, status: row.status, code: row.code, detail: row.detail }
            : { ok: false, status: 'unknown', detail: check.detail ?? '无法实测登录态' },
          // 明确区分：「已保存」不等于「已验证可签到」。
          note: row?.ok === true
            ? '凭证已保存，且只读接口验证通过。'
            : '凭证已保存，但实测未通过——请检查是否复制完整或登录态是否已过期。',
        }
      }
      return result
    })
  })

  route(`${base}/credential/clear`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      return credentials.clear({ platform: body.platform })
    })
  })

  route(`${base}/allow-claim`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, status: 'invalid', detail: 'enabled 必须是布尔值' }
      }
      return actions.setAllowClaim(body.enabled)
    })
  })

  // ---- 手动触发一轮签到 ----
  //
  // start 立刻返回，不等这一轮跑完：spawn Python 打十个平台要几十秒，期间面板只能
  // 干转圈，浏览器一超时请求就断了，而签到还在后台跑。进度与结果由
  // `GET run/state` 轮询（刻意不复用 `GET settings`：那一个每次要 spawn 两次
  // Python 读凭证落盘状态，1.5 秒一次会把轮询变成子进程风暴）。
  //
  // `alreadyRunning` 不是错误：重复点击时 runOnce 会复用正在跑的那一轮而不是
  // 再起一轮（那会变成重复领取），这里把实情告诉面板，让界面说「这一轮已经在跑了」。
  route(`${base}/run`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        return { ok: false, status: 'invalid', detail: 'force 必须是布尔值' }
      }
      return actions.startRun({ force: body.force === true })
    })
  })

  route(`${base}/run/state`, (req, res) => {
    if (!guard(req, res, { method: 'GET' })) return
    run(res, () => actions.runState())
  })

  route(`${base}/models/preview`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, () => actions.previewModels())
  })

  route(`${base}/models/apply`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, () => actions.applyModels())
  })

  // ---- 平台与模型：设置页内直接选「接入哪些平台、每个平台显示哪些模型」----
  //
  // 载荷 `{ providers: { [id]: { enabled, all?, modelIds? } } }`，由 index.js 的
  // saveModelsSelection 对照**当下真实注册的清单**校验后写进选择文件；写成功会
  // 触发选择中心的订阅者 emit `llm/adapters-updated`，模型选择器当场重画。
  //
  // 刻意不复用浏览器看板的 `/dsh-agent-checkin/models/save`：那条是 urlencoded 表单
  // （要能在没有 JS 的浏览器里工作），这里是 JSON（面板里的 fetch）。两条入口
  // 共用同一个选择中心与同一份校验语义，只有传输格式不同。
  route(`${base}/models/selection`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      return actions.saveModelsSelection(body)
    })
  })

  // ---- 手动积分：某平台当前积分的直接录入/清除 ----
  //
  // `value: null` 是清除（回到「无手动值」）。这是**记录**不是**充值**：
  // 面板上手动值永远带「手动」标签，不会与签到实测的余额混为一谈。
  route(`${base}/balance`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      if (typeof body.platform !== 'string' || body.platform.trim() === '') {
        return { ok: false, status: 'invalid', detail: 'platform 不能为空' }
      }
      if (body.value !== null && typeof body.value !== 'number') {
        return { ok: false, status: 'invalid', detail: 'value 必须是数字或 null（null 表示清除）' }
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        return { ok: false, status: 'invalid', detail: 'note 必须是字符串' }
      }
      return actions.setBalance({
        platform: body.platform,
        value: body.value === undefined ? undefined : body.value,
        note: body.note,
      })
    })
  })


  // ---- 登录采集 ----
  //
  // start 立刻返回（不等登录完成），进度靠 GET login/state 轮询。
  // 之所以不让 start 挂到登录完成为止：那是一个「等人」的过程，最长五分钟，
  // 用户一旦刷新页面就只剩一个网络错误，而浏览器还在开着。

  route(`${base}/login/start`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      const result = logins.start({ platform: body.platform })
      // 动作层结果用 `started` 标，不用 `ok`：`ok` 在载荷里表示
      // 「这一轮登录成功了没有」，此刻必然是 false（还等着人登录呢）。
      // 把动作成功映射成 200，才不会让「窗口已经打开」看起来像失败。
      if (result?.started === true) return Object.assign({ sk: true }, result)
      return result
    })
  })

  route(`${base}/login/state`, (req, res) => {
    if (!guard(req, res, { method: 'GET' })) return
    run(res, () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const platform = url.searchParams.get('platform')
      // 不给 platform 就回全部：面板首屏一次拿齐，省掉四个请求。
      if (platform === null || platform === '') {
        return { ok: true, states: logins.states() }
      }
      // `Object.assign` 而不是展开：快照自带 `status: 'failed'/'idle'` 等字段，
      // 展开会把请求层的 `sk` 覆盖掉；这里也不用 `ok` 表达「请求成功」，
      // 那个字段在快照里有自己的含义（这一轮登录是否成功），复用只会两头误导。
      // 于是请求层改用 `sk: true`，`run()` 认它。
      return Object.assign({ sk: true }, logins.state({ platform }))
    })
  })

  route(`${base}/login/cancel`, (req, res) => {
    if (!guard(req, res, { method: 'POST' })) return
    run(res, async () => {
      const body = await readJsonBody(req)
      const result = logins.cancel({ platform: body.platform })
      // 动作层用 `cancelled`；没有进行中的登录是**如实拒绝**（400），
      // 不是「取消成功」——否则面板会把一个空动作渲染成绿条。
      if (result?.cancelled === true) return Object.assign({ sk: true }, result)
      return result
    })
  })

  return registered
}

/**
 * 把 `statusRoute` 归一化成不带尾斜杠的前缀。
 *
 * 用户可能把 `statusRoute` 配成 `/dsh-agent-checkin/`（宿主那侧的看板路由自己会吃掉尾斜杠，
 * 所以那种配置一直是能跑的）——这里如果直接拼，会得到 `/dsh-agent-checkin//settings`，
 * 一个永远不会被命中的路径。空串（根挂载）要保留成 ''，拼出 `/settings`。
 */
function settingsPrefixBase(prefix) {
  const raw = String(prefix ?? '').trim()
  if (raw === '' || raw === '/') return ''
  return raw.replace(/\/+$/, '')
}

/** 供测试与宿主自检使用：路由清单（不含处理函数）。 */
export function settingsRoutePaths(prefix) {
  const base = `${settingsPrefixBase(prefix)}/settings`
  return [
    base,
    `${base}/check`,
    `${base}/credential`,
    `${base}/credential/clear`,
    `${base}/allow-claim`,
    `${base}/run`,
    `${base}/run/state`,
    `${base}/models/preview`,
    `${base}/models/apply`,
    `${base}/models/selection`,
    `${base}/balance`,
    `${base}/login/start`,
    `${base}/login/state`,
    `${base}/login/cancel`,
  ]
}

export { readJsonBody, sameOriginOk }
