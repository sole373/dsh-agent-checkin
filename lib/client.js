window.__ModuleLoader__.load({
  id: 'dsh-agent-checkin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 只 require 两个静态种子模块。宿主把 `react` / `react/jsx-runtime` 放进了
    // 静态模块表，不依赖任何其它插件的加载顺序；本包不需要 locale 服务
    // ——文案直接写死中英双语，少一个可能缺失的依赖就少一种开不出来页面的理由。
    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    /**
     * `h` 的适配层。
     *
     * `react/jsx-runtime` 的 `jsx(type, props, key?)` 只认两个参数：children 必须
     * 放在 `props.children` 里，**第三个参数是 key**，传数组过去会被当成 key
     * 静默忽略。本文件的既有写法是 `h(type, { children })`，而新加的用量面板大量
     * 用了 `h(type, props, children)` 这种更像 createElement 的三参写法——两者
     * 在真机上的结果完全不同：后者会渲染出一个**只有外层 div、里面全空的壳**。
     *
     * 这类错误在本机的测试桩里抓不到（桩当初把第三参数当 children 收下了），
     * 只会在宿主里表现成「点开菜单一片空白」。所以在这里统一适配，两种写法都成立：
     *   · `h(type, { children })`        → 原样交给 jsx
     *   · `h(type, props, children)`     → 合进 props.children 再交给 jsx
     */
    //
    // 另：宿主的 jsx-runtime 是精简内联版，**不判 props 为 null**——`jsx('tr', null)`
    // 会直接抛 `Cannot read properties of null (reading 'key')`（React 官方版有
    // `config !== null` 保护，这里没有）。所以 props 一律归一成对象再往下传。
    const jsx = jsxRuntime.jsx
    const h = (type, props, children) => {
      const base = props ?? {}
      return children === undefined ? jsx(type, base) : jsx(type, { ...base, children })
    }

    const { useEffect, useMemo, useState, useCallback, useRef } = react

    // ---- 样式 ----
    //
    // 类名统一带 `chub-` 前缀：宿主没有 CSS Modules 给我们这种外部包，
    // 全局样式表里裸类名撞车的概率不低。
    const CSS = `
/* >>> usage-panel css（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>> */
/* Token 用量页的样式已随功能迁到独立插件 dsh-token-usage。 */
/* <<< usage-panel css <<< */
.chub-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.chub-head { display: flex; flex-direction: column; gap: 4px; }
.chub-title { margin: 0; font-size: 15px; font-weight: 600; }
.chub-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
.chub-banner { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.6; }
.chub-banner.bad { border-color: var(--dsw-alias-state-error-primary, #d33); }
.chub-banner.warn { border-color: var(--dsw-alias-state-warning-primary, #d92); }
.chub-banner.info { border-color: var(--dsw-alias-border-l2); }
.chub-banner.nodeps { border-style: dashed; }
.chub-banner.nodeps code { background: rgba(127,127,127,.14); padding: 1px 4px; border-radius: 4px; }
.chub-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chub-grow { flex: 1 1 auto; }
.chub-btn { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.chub-btn:hover:not(:disabled) { background: rgba(127,127,127,.1); }
.chub-btn:disabled { opacity: .45; cursor: not-allowed; }
.chub-btn.primary { border-color: var(--dsw-alias-state-business-primary, #4a7); }
.chub-btn.primary:hover:not(:disabled) { background: rgba(74,170,119,.12); }
a.chub-link { display: inline-block; text-decoration: none; }
.chub-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.chub-table th, .chub-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); vertical-align: top; }
.chub-table th { font-weight: 600; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.chub-name { font-weight: 600; }
.chub-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.chub-muted { color: var(--dsw-alias-label-tertiary); }
.chub-tag { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2); }
.chub-tag.ok { border-color: var(--dsw-alias-state-success-primary, #2a7); color: var(--dsw-alias-state-success-primary, #2a7); }
.chub-tag.bad { border-color: var(--dsw-alias-state-error-primary, #d33); color: var(--dsw-alias-state-error-primary, #d33); }
.chub-tag.warn { border-color: var(--dsw-alias-state-warning-primary, #d92); color: var(--dsw-alias-state-warning-primary, #d92); }
.chub-tag.off { color: var(--dsw-alias-label-tertiary); }
.chub-input { font: inherit; font-size: 12px; width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.chub-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.chub-card > h3 { margin: 0; font-size: 13px; font-weight: 600; }
.chub-msg { font-size: 12px; line-height: 1.6; }
.chub-msg.bad { color: var(--dsw-alias-state-error-primary, #d33); }
.chub-msg.ok { color: var(--dsw-alias-state-success-primary, #2a7); }
.chub-msg.warn { color: var(--dsw-alias-state-warning-primary, #d92); }
.chub-msg.info { color: var(--dsw-alias-label-secondary, #667); }
.chub-edit-row > td { border-bottom: none; }
.chub-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 6px; flex-wrap: wrap; }
.chub-modes { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 2px; }
.chub-mode { font: inherit; font-size: 12px; cursor: pointer; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-tertiary); }
.chub-mode:hover { color: var(--dsw-alias-label-primary); }
.chub-mode.on { border-color: transparent; background: #4d6bfe; color: #fff; font-weight: 600; }
.chub-mode:disabled { opacity: .5; cursor: not-allowed; }
.chub-tab { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 12px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-tertiary); }
.chub-tab:hover { color: var(--dsw-alias-label-primary); }
.chub-tab.on { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.chub-models { max-height: 240px; overflow: auto; border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 8px; margin-top: 2px; display: flex; flex-direction: column; gap: 2px; }
.chub-models.off { opacity: .55; }
.chub-model { display: flex; align-items: baseline; gap: 6px; font-size: 12px; cursor: pointer; }
.chub-model input { margin: 0; }
/* 勾选行用 button 画：宿主设置面板里原生 <label><input type="checkbox"> 出现过
   「点了状态不变」的情况，而点击路径不归插件管；按钮的 onClick 一定走到我们手里，
   aria-pressed 同时承担读屏语义与按下样式。 */
.chub-pick { display: flex; align-items: baseline; gap: 6px; width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; text-align: left; cursor: pointer; padding: 3px 6px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-primary); }
.chub-pick:hover { background: rgba(127, 127, 127, .1); }
.chub-pick.on { border-color: var(--dsw-alias-border-l2); }
.chub-pick:disabled { cursor: not-allowed; opacity: .5; }
.chub-box { flex: 0 0 auto; align-self: center; width: 14px; height: 14px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 3px; font-size: 10px; line-height: 12px; text-align: center; color: transparent; }
.chub-pick.on .chub-box { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.chub-pick-name { flex: 0 0 auto; }
.chub-rate { margin-left: auto; padding-left: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.chub-rate.free { color: #2e9e5b; }
/* 图片开关自成一组控件：它是**独立的**每模型清单，与「是否显示这个模型」正交。
   颜色/形态沿用 .chub-mode 与 .chub-pick，但类名分开——两组合在一起会让
   「模型要不要显示」和「模型能不能收图」在测试与样式里互相污染。 */
.chub-imodes { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 0 2px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.chub-imode { font: inherit; font-size: 12px; cursor: pointer; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-tertiary); }
.chub-imode:hover { color: var(--dsw-alias-label-primary); }
.chub-imode.on { border-color: transparent; background: #4d6bfe; color: #fff; font-weight: 600; }
.chub-imode:disabled { opacity: .5; cursor: not-allowed; }
.chub-ipick { display: flex; align-items: baseline; gap: 6px; width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; text-align: left; cursor: pointer; padding: 2px 6px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-primary); }
.chub-ipick:hover { background: rgba(127, 127, 127, .1); }
.chub-ipick.on { border-color: var(--dsw-alias-border-l2); }
.chub-ipick:disabled { cursor: not-allowed; opacity: .5; }
.chub-ipick.on .chub-box { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.chub-ipicks { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow: auto; margin-top: 4px; }
`

    const CSS_TAG_ID = 'dsh-agent-checkin/client.css'
    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-agent-checkin'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- 与宿主半侧的通信 ----
    //
    // 面板**不**直接 spawn 子进程、也不读文件：那些都发生在宿主进程里，
    // 由 lib/index.js 注册的 `${prefix}/settings` 路由承担。浏览器这一侧只发 HTTP，
    // 这样凭证从头到尾没进过页面（也进不了 DevTools 的 network 面板之外的任何地方）。
    const DEFAULT_PREFIX = '/dsh-agent-checkin'

    // 这份前端代码的「形态标识」，与 settings-routes.js 的 CLIENT_UI_ID 必须一致。
    // 服务端把它与期望值比对后回 `clientUi.status`，面板据此显示「你看到的是旧界面」。
    // 改动前端交互（尤其是登录按钮的形态）时两边一起改。
    //
    // `post-button-pick-modes` = 按钮 + fetch POST；「平台与模型」页的勾选行是
    // button（原生 checkbox 在宿主面板里出现过「点了状态不变」），模型清单再分
    // 「全部模型 / 我自己挑」两种方式，每个模型后面带客户端给的倍率。
    const CLIENT_UI_ID = 'post-button-pick-modes'

    // 轮询间隔。登录是「等人」的过程，2 秒一次足够让状态看起来是活的，
    // 又不会把宿主日志刷满。超过这个时长没有任何变化也不停——用户可能只是
    // 在慢慢登录；什么时候收工由 cdp.py 自己的 300 秒超时决定。
    const LOGIN_POLL_MS = 2000

    // 手动签到的轮询间隔。一轮要 spawn Python 打十个平台，几十秒量级，
    // 1.5 秒问一次既能让「运行中」看起来是活的，也不至于把服务端刷出噪音。
    // 停止条件是服务端 `running` 变 false——那之后结果已经定型，再问也是同一个答案。
    const RUN_POLL_MS = 1500

    /** 登录过程的状态码 → 中文/英文短语。未知状态如实显示原文，不猜。 */
    const LOGIN_LABEL = {
      idle: ['未发起', 'Not started'],
      running: ['等待登录', 'Waiting for sign-in'],
      saved: ['已保存', 'Saved'],
      timeout: ['等待超时', 'Timed out'],
      cancelled: ['已取消', 'Cancelled'],
      error: ['失败', 'Failed'],
      'no-conclusion': ['没有结论', 'No conclusion'],
      'unsupported-platform': ['平台不支持', 'Platform unsupported'],
      'python-missing': ['找不到 Python', 'Python not found'],
      'not-started': ['未发起', 'Not started'],
    }

    function loginText(status) {
      const pair = LOGIN_LABEL[status]
      return pair === undefined ? String(status ?? '—') : t(pair[0], pair[1])
    }

    function loginClass(status) {
      if (status === 'saved') return 'chub-tag ok'
      if (status === 'running') return 'chub-tag warn'
      if (status === 'idle' || status === 'not-started' || status === 'cancelled') return 'chub-tag off'
      if (status === undefined || status === null) return 'chub-tag'
      return 'chub-tag bad'
    }

    /**
     * 把 start / cancel / state 三种响应统一成一份快照。
     *
     * 三者字段有重叠但不完全一致（cancel 回的是单平台快照，state 不带 platform
     * 时回的是 `{states:{...}}`），在页面里逐处判断字段存在性会让渲染代码
     * 变成一团 if。这里统一成 `{status, ok, running, detail, output}` 五件套，
     * 缺失的状态一律落成 `idle`——「不知道」不该长得像「成功」。
     *
     * `ok` 的语义**只有一个**：这一轮登录真的成功了吗。
     * 登录路由的载荷自带 `ok`，它说的是「采到凭证了没有」（进行中必然是 false）；
     * 请求本身成没成由 HTTP 状态与动作字段（started / cancelled）表达。
     * 所以这里的 ok 只能在 status 已是 `saved` 时成立——绝不能直接抄载荷里的
     * `result.ok`：宿主的失败响应统一带 `ok:false`，抄过来就会把「守卫拒绝」
     * 这类请求层面的失败，画成「登录失败」的状态标签。
     */
    function normalizeLogin(result) {
      if (result === undefined || result === null || typeof result !== 'object') {
        return { status: 'idle', ok: false, running: false, detail: '', output: '' }
      }
      const status = typeof result.status === 'string' ? result.status : 'idle'
      return {
        status,
        ok: status === 'saved' && result.ok === true,
        running: result.running === true || status === 'running',
        detail: typeof result.detail === 'string' ? result.detail : '',
        output: typeof result.output === 'string' ? result.output : '',
      }
    }

    /**
     * 把响应体解析成 `{ok, ...}`。
     *
     * 宿主的路由对失败统一回 `{ ok: false, status, detail }`；网络层失败（DSH 没起来、
     * 插件被禁用）连响应都没有，此时合成一个同形状的对象，让上层只用一套判断。
     */
    async function callJson(url, options) {
      let response
      try {
        response = await fetch(url, options)
      } catch (error) {
        return { ok: false, status: 'network', detail: '无法连接 DSH 服务：' + String(error && error.message ? error.message : error) }
      }
      let body = null
      const text = await response.text()
      if (text !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
      }
      if (body === null || typeof body !== 'object') {
        return { ok: false, status: 'bad-response', detail: '服务返回了无法解析的内容（HTTP ' + response.status + '）' }
      }
      // HTTP 失败而载荷里没带 ok 时补一个，让上层只用一套判断。
      // 注意：载荷**自带** ok 时不动它——登录那几条路由的 ok 说的是
      // 「这一轮登录成功了没有」，而此刻必然是 false；请求本身成没成由 HTTP 状态
      // 与动作字段（started / cancelled）表达。
      if (response.ok === false && body.ok === undefined) body.ok = false
      return body
    }

    function postJson(url, payload) {
      return callJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    }

    // ---- 小工具 ----

    function t(zh, en) {
      return isZhUi() ? zh : en
    }

    function fmtBalance(row) {
      if (typeof row.balance !== 'number' || !Number.isFinite(row.balance)) return '—'
      const unit = row.unit ?? ''
      const shown = Number.isInteger(row.balance) ? String(row.balance) : row.balance.toFixed(2)
      return unit === '' ? shown : shown + ' ' + unit
    }

    /**
     * 模型的倍率标签：`(0.79x)` / `(1.00x)` / `(免费)`。
     *
     * 数字只来自客户端自己的清单（WorkBuddy creditMultiplier / Qoder priceFactor），
     * 服务端已按「非有限数、负数一律不带」过滤过；这里再判一次是因为这个函数
     * 也吃老服务端（没有 multiplier 字段）返回的行。客户端没给倍率时返回 null，
     * 页面就空着那一列——**不猜**，猜出来的数字会让人做错选择。
     */
    function rateLabel(model) {
      const value = model?.multiplier
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      if (value === 0) return h('span', { key: 'r', className: 'chub-rate free', children: t('(免费)', '(free)') })
      return h('span', { key: 'r', className: 'chub-rate', children: '(' + value.toFixed(2) + 'x)' })
    }

    const STATUS_LABEL = {
      ok: ['正常', 'OK'],
      missing: ['未配置', 'Not set up'],
      failed: ['失败', 'Failed'],
      unknown: ['未知', 'Unknown'],
      absent: ['未配置', 'Not set'],
      present: ['已配置', 'Set'],
      invalid: ['内容无效', 'Invalid'],
      unsupported: ['不支持录入', 'Not supported'],
      unreadable: ['读不出来', 'Unreadable'],
    }

    function statusText(status) {
      const pair = STATUS_LABEL[status]
      if (pair === undefined) return String(status)
      return t(pair[0], pair[1])
    }

    function statusClass(status) {
      if (status === 'ok' || status === 'present') return 'chub-tag ok'
      if (status === 'failed' || status === 'invalid' || status === 'unreadable') return 'chub-tag bad'
      if (status === 'missing' || status === 'absent' || status === 'unknown') return 'chub-tag off'
      return 'chub-tag'
    }

    // 签到结果桶：与 lib/platforms.js 的 RESULT_CODES 四桶同一口径。
    // 「中性」（DRY_RUN/READONLY/INACTIVE）必须与「成功」长得不一样——
    // 把「只读核对通过」画成绿色成功标签，是这一类插件最典型的假报。
    const RUN_BUCKET = {
      success: ['chub-tag ok', ['成功', 'OK']],
      neutral: ['chub-tag off', ['未领取', 'Not claimed']],
      blocked: ['chub-tag warn', ['被拦住', 'Blocked']],
      failure: ['chub-tag bad', ['失败', 'Failed']],
      unknown: ['chub-tag', ['未知', 'Unknown']],
    }

    function runBucketClass(bucket) {
      const pair = RUN_BUCKET[bucket]
      return pair === undefined ? 'chub-tag' : pair[0]
    }

    function runBucketText(bucket) {
      const pair = RUN_BUCKET[bucket]
      return pair === undefined ? String(bucket ?? '—') : t(pair[1][0], pair[1][1])
    }

    /**
     * 把服务端的平台行数据推成编辑草稿。
     *
     * 关键约定：`modelIds === null` 在服务端表示「跟随客户端清单自动增减」，
     * 草稿里用 `mode: 'all'` 表达；显式清单用 `mode: 'pick'`。二者必须互译——
     * 否则用户看到「全部」被选中、保存后却变成了「勾了当时那 20 个、以后新增的
     * 不再出现」，模型选择器会悄悄少掉模型，而这种缺漏不会报错。
     *
     * `mode` 而不是 `all` 布尔：界面上这是**两种选择方式**（整类跟随 vs 自己挑），
     * 不是「一个叫全选的复选框」。用布尔值时「全选」既是方式又是动作，用户就只会
     * 看到默认全打勾、然后一个个去取消——这正是「不能直接选要用的模型」的来源。
     */
    function seedModelsDraft(providers) {
      const draft = {}
      for (const row of Array.isArray(providers) ? providers : []) {
        if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
        const ids = Array.isArray(row.models) ? row.models.map((model) => model.id) : []
        const isAll = row.modelIds === null
        const picked = isAll
          ? []
          : (Array.isArray(row.modelIds) ? row.modelIds.filter((id) => ids.includes(id)) : [])
        draft[row.id] = {
          enabled: row.enabled === true,
          mode: isAll ? 'all' : 'pick',
          modelIds: picked,
          // 图片三态原样搬进草稿：null = 跟随原生能力，数组 = 显式白名单。
          // 这里**不**把 null 归一成「所有原生支持的 id」——那会把「跟随」变成
          // 「钉死当前这一批」，以后客户端目录新增的多模态模型就不会自动能收图了。
          imageIds: Array.isArray(row.imageIds)
            ? row.imageIds.filter((id) => ids.includes(id))
            : null,
        }
      }
      return draft
    }

    // ---- 页面 ----

    /**
     * dsh-agent-checkin 的配置页。
     *
     * 三条展示纪律（与看板、README 同一口径）：
     *   1. 数据来源要标：这里显示的一切都来自宿主进程的实测，页面不做推断。
     *   2. 状态可降级：「已保存」不等于「能签到」，两者分开显示。
     *   3. 不跨平台求和：余额逐行列出，从不给合计。
     */
    function CheckinHubSection() {
      const prefix = DEFAULT_PREFIX
      const [state, setState] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState(null)
      const [checkResult, setCheckResult] = useState(null)
      const [credDraft, setCredDraft] = useState({})
      const [credResult, setCredResult] = useState({})
      const [modelPreview, setModelPreview] = useState(null)
      const [loginStates, setLoginStates] = useState({})
      // 手动积分：哪一行正在编辑（{platform, draft}）+ 每个平台最近一次保存结果。
      const [balanceEdit, setBalanceEdit] = useState(null)
      const [balanceResult, setBalanceResult] = useState({})
      // 请求层面的失败（被守卫拒绝、连不上服务、响应解析不了）：与「登录结果」
      // 分开一个槽位。两者混在一起写，就会出现「点按钮 → 红色标签说登录失败」
      // 这种把守卫拒绝误报成登录失败的展示。
      const [loginError, setLoginError] = useState(null)
      // 设置页内的页签：「签到与凭证」（原有全部卡片）／「平台与模型」（新增）。
      // 刻意用页签而不是往下再堆一张卡：平台接入 + 每平台几十个模型的清单，
      // 平铺会把原有配置挤到看不见的地方。
      const [page, setPage] = useState('config')
      // 平台/模型的编辑草稿：`{ [providerId]: { enabled, mode, modelIds, imageIds } }`。
      // null = 还没动过，渲染时用服务端行数据现推（保存成功后也置回 null，
      // 让页面重新对齐服务端事实，而不是把乐观状态当成结果展示）。
      const [modelsDraft, setModelsDraft] = useState(null)
      const [modelsMsg, setModelsMsg] = useState(null)

      const refresh = useCallback(async () => {
        // 带上 `?ui=`：服务端据此判断界面跑的是不是本版前端。浏览器缓存了旧 bundle
        // 时，磁盘和后端都已是新代码、界面却还是旧的，这个申报能让面板自己说出来，
        // 不必打开开发者工具。
        const next = await callJson(prefix + '/settings?ui=' + encodeURIComponent(CLIENT_UI_ID))
        if (next.ok === false) {
          setLoadError(next.detail ?? next.status ?? 'unknown')
          return
        }
        setLoadError(null)
        setState(next)
        // 首屏就带上登录状态：刷新页面后仍能看到上一次登录的结局，
        // 而不是一片「没发起过」。
        if (next.logins !== undefined && next.logins !== null) {
          const map = {}
          for (const [id, value] of Object.entries(next.logins)) map[id] = normalizeLogin(value)
          setLoginStates(map)
        }
      }, [prefix])

      useEffect(() => {
        refresh()
      }, [refresh])

      // 只要有任何平台处于「等待登录」，就持续轮询。
      // 停止条件是「没有 running 的了」——包括超时、取消、成功三种结局，
      // 它们的共同点都是后端已经落定，再问也不会有新答案。
      const anyLoginRunning = Object.values(loginStates).some((item) => item.running === true)
      useEffect(() => {
        if (!anyLoginRunning) return undefined
        let alive = true
        const timer = setInterval(async () => {
          const result = await callJson(prefix + '/settings/login/state')
          if (!alive) return
          if (result.ok === false || result.states === undefined) return
          const map = {}
          for (const [id, value] of Object.entries(result.states)) map[id] = normalizeLogin(value)
          setLoginStates(map)
          // 有结论了就把凭证状态一起刷新：登录可能刚刚把 Cookie 写进了文件。
          const finishedOk = Object.values(map).some((item) => item.status === 'saved')
          if (finishedOk) {
            setMessage({ kind: 'ok', text: t('登录成功，凭证已保存并验证通过。', 'Signed in — the credential was saved and verified.') })
            await refresh()
          }
        }, LOGIN_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [anyLoginRunning, prefix, refresh])

      const run = useCallback(async (key, fn) => {
        setBusy(key)
        setMessage(null)
        try {
          return await fn()
        } finally {
          setBusy(null)
        }
      }, [])

      // ---- 手动签到的轮询 ----
      //
      // 「立即签到」在服务端是异步起的（POST /settings/run 立刻返回），
      // 结果要靠轮询 `GET /settings/run/state` 取。停止条件是服务端 `running`
      // 变 false——那之后结果已定型，再问也是同一个答案。
      //
      // 刻意不复用 `refresh()` 做轮询：那一个每次要 spawn 两次 Python 读凭证
      // 落盘状态，1.5 秒一次会把轮询变成子进程风暴；run/state 是纯内存快照。
      const runNowRunning = state !== null && state.running === true
      useEffect(() => {
        if (!runNowRunning) return undefined
        let alive = true
        const timer = setInterval(async () => {
          const next = await callJson(prefix + '/settings/run/state')
          if (!alive || next.ok === false) return
          setState((prev) => (prev === null ? prev : { ...prev, running: next.running === true, lastRun: next.lastRun, lastRunError: next.lastRunError }))
        }, RUN_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [runNowRunning, prefix])

      // 跑完的那一刻给一句结论 + 刷新「当前积分」。用 ref 记住上一拍的 running，
      // 才认得出「运行中→结束」这个跳变；写进 useEffect 的依赖里会因 state
      // 每拍都是新对象而反复触发。refresh 是异步的，用 .catch 兜成日志级问题：
      // useEffect 回调不能是 async 函数（React 会把返回值当清理函数）。
      const prevRunRunning = react.useRef(false)
      useEffect(() => {
        if (state === null) return
        const was = prevRunRunning.current
        prevRunRunning.current = state.running === true
        if (!was || state.running === true) return
        if (state.lastRunError) {
          setMessage({ kind: 'bad', text: t('这一轮签到没有跑成：', 'This run did not finish: ') + String(state.lastRunError) })
          return
        }
        if (state.lastRun === null) return
        setMessage({ kind: 'info', text: t(
          '这一轮已结束，结果见下表。各平台积分是不同币种，不做合计。',
          'This run finished; see the table below. Credit units differ per platform; no totals.',
        ) })
        void refresh().catch(() => {})
      }, [state, refresh])

      /** 启动一轮签到。`force` 只影响「今日已领过还要不要硬跑」，不改变只读/真实领取。 */
      const onStartRun = (force) => run(force === true ? 'run-force' : 'run', async () => {
        const result = await postJson(prefix + '/settings/run', { force: force === true })
        // `started` 只说明这一轮被接受了，不等于成功；成功与否等末尾的结果表。
        if (result.started !== true) {
          setMessage({ kind: 'bad', text: result.detail ?? t('没能启动签到', 'Could not start the run') })
          return
        }
        if (result.alreadyRunning === true) {
          setMessage({ kind: 'info', text: t(
            '已经有一轮在跑了，这次点击没有重复发起（避免重复领取）。结果会自动出现在下面。',
            'A run is already in progress; this click did not start a second one (that would claim twice). Results will appear below.',
          ) })
        } else if (result.willClaim === true) {
          setMessage({ kind: 'info', text: t(
            '已开始一轮真实领取，通常几十秒。结果会自动出现在下面。',
            'A real claiming run has started — usually tens of seconds. Results will appear below.',
          ) })
        } else {
          setMessage({ kind: 'info', text: t(
            '已开始一轮只读核对（真实领取未开启，这一轮不会改动任何余额）。',
            'A read-only check has started (claiming is off, so no balance will change).',
          ) })
        }
        await refresh()
      })

      const checksById = useMemo(() => {
        const map = new Map()
        const list = checkResult && Array.isArray(checkResult.checks) ? checkResult.checks : []
        for (const row of list) map.set(row.id ?? row.platform, row)
        return map
      }, [checkResult])

      if (loadError !== null) {
        return h('div', {
          className: 'chub-root',
          children: [
            h('div', { className: 'chub-banner bad', key: 'e', children: t(
              '读不到设置：' + loadError + '。请确认插件已启用，且 DSH 服务在运行。',
              'Could not read settings: ' + loadError + '. Check that the plugin is enabled and DSH is running.',
            ) }),
            h('div', { className: 'chub-row', key: 'r', children: h('button', {
              type: 'button', className: 'chub-btn', onClick: () => run('load', refresh),
              children: t('重试', 'Retry'),
            }) }),
          ],
        })
      }

      if (state === null) {
        return h('div', { className: 'chub-root', children: h('p', { className: 'chub-sub', children: t('加载中…', 'Loading…') }) })
      }

      const platforms = Array.isArray(state.platforms) ? state.platforms : []
      const claiming = platforms.filter((p) => p.claiming === true)
      const readonly = platforms.filter((p) => p.claiming !== true)
      const credentials = state.credentials ?? {}
      const credSources = Array.isArray(credentials.sources) ? credentials.sources : []
      const readonlySources = Array.isArray(credentials.readonly) ? credentials.readonly : []
      const balanceRows = Array.isArray(state.balances) ? state.balances : []
      // 登录卡的行清单：能粘贴 Cookie 的平台（lingxi/jimeng）+ 能直接发起登录但
      // 没有 Cookie 可粘贴的平台（kling，登录态存整个浏览器 profile）。
      // 顺序保持稳定，别让面板在两次渲染之间跳来跳去。
      const loginSourceEntries = [
        ...credSources.map((src) => ({ ...src, pasteable: true })),
        ...readonlySources
          .filter((src) => src.platform === 'kling')
          .map((src) => ({
            platform: src.platform,
            label: '可灵 AI',
            pasteable: false,
          })),
      ]
      const loginSources = loginSourceEntries

      const onCheck = () => run('check', async () => {
        const result = await postJson(prefix + '/settings/check', {})
        setCheckResult(result)
        if (result.ok === false) setMessage({ kind: 'bad', text: result.detail ?? result.status ?? t('实测失败', 'Check failed') })
        else setMessage({ kind: 'ok', text: t('只读实测完成；本轮没有领取任何东西。', 'Read-only check finished; nothing was claimed.') })
      })

      // ---- 手动积分：直接改某平台「当前积分」的显示值 ----
      //
      // 这是记录不是充值：手动值永远带「手动」标签，绝不与引擎实测值混写。
      // 保存成功后立刻刷新，列表与看板同步更新。
      const startBalanceEdit = (item) => setBalanceEdit({
        platform: item.platform,
        draft: item.source === 'manual' && item.manual ? String(item.manual.value) : '',
        note: item.source === 'manual' && item.manual ? (item.manual.note ?? '') : '',
      })
      const submitBalanceEdit = (platform) => {
        const draft = (balanceEdit?.platform === platform ? balanceEdit.draft : '').trim()
        const note = (balanceEdit?.platform === platform ? balanceEdit.note : '').trim()
        const value = Number(draft)
        if (!Number.isFinite(value) || value < 0) {
          setBalanceResult((prev) => ({ ...prev, [platform]: { ok: false, detail: t('积分必须是 0 或更大的数字', 'Enter a number of 0 or more') } }))
          return
        }
        void saveBalance(platform, value, note)
      }
      const saveBalance = (platform, value, note) => run('balance:' + platform, async () => {
        const result = await postJson(prefix + '/settings/balance', { platform, value, note: note ?? '' })
        setBalanceResult((prev) => ({ ...prev, [platform]: result }))
        if (result.ok === true) {
          setBalanceEdit((prev) => (prev?.platform === platform ? null : prev))
          await refresh()
        }
      })
      const clearBalance = (platform) => run('balance-clear:' + platform, async () => {
        const result = await postJson(prefix + '/settings/balance', { platform, value: null })
        setBalanceResult((prev) => ({ ...prev, [platform]: result }))
        if (result.ok === true) await refresh()
      })

      const onSaveCredential = (platform) => run('cred:' + platform, async () => {
        const value = credDraft[platform] ?? ''
        if (value.trim() === '') {
          setCredResult((prev) => ({ ...prev, [platform]: { ok: false, detail: t('请先填入 Cookie', 'Paste a cookie first') } }))
          return
        }
        const result = await postJson(prefix + '/settings/credential', { platform, value })
        setCredResult((prev) => ({ ...prev, [platform]: result }))
        // 无论成败都清空输入框：明文凭证没有理由在页面上多留一秒。
        setCredDraft((prev) => ({ ...prev, [platform]: '' }))
      })

      const onClearCredential = (platform) => run('clear:' + platform, async () => {
        const result = await postJson(prefix + '/settings/credential/clear', { platform })
        setCredResult((prev) => ({ ...prev, [platform]: result }))
      })

      // 开关「真实领取」：插件通过宿主 configEditor 把 allowClaim 写回 profile patch。
      // `allowClaim` 是 volatile 字段，Loader 走纯 volatile 热提交，所以**不需要重启**。
      //
      // 三句话必须分开说，不能合成一句「已切换」：
      //   · ok && changed    —— 真的写进去了，已经热生效；
      //   · ok && !changed   —— 本来就是那个值，什么都没做（不谎称「已保存」）；
      //   · !ok              —— 写失败，`detail` 是服务端给的真实原因。
      const onAllowClaim = (enabled) => run('allow', async () => {
        const result = await postJson(prefix + '/settings/allow-claim', { enabled })
        if (result.ok !== true) {
          setMessage({ kind: 'warn', text: result.detail ?? t('改不动', 'Cannot change') })
        } else if (result.changed !== true) {
          setMessage({
            kind: 'info',
            text: t('本来就是这个状态，配置没有改动。', 'Already in that state; nothing was written.'),
          })
        } else {
          setMessage({
            kind: 'ok',
            text: t(
              '已写入配置并立即生效，不需要重启。下一次运行会按新状态执行。',
              'Saved and applied immediately, no restart needed. The next run follows the new setting.',
            ),
          })
        }
        await refresh()
      })

      // ---- 登录进度 ----
      //
      // 「打开登录窗口」是一个普通按钮，点了就 POST `${prefix}/settings/login/start`。
      //
      // 早前这里走的是 `<a href>` 导航（两跳 + 一次性令牌），想借浏览器导航自带的
      // Origin 过掉后端的同源守卫。在真实的 DSH 桌面应用里这条路走不通：
      // `target: '_self'` 会把宿主主界面整个导航走（28 个客户端插件被卸载，
      // 报「Failed to load plugins / entries did not activate」）；
      // `target: '_blank'` 则弹不出窗口，点了毫无反应。
      // 服务端已改为「不带 Origin 时只需本机回环」，面板内直接 POST 就够。
      //
      // 注意判据：**请求成功只说明采集进程起来了**，不代表登录成功。
      // `result.started` 才是「窗口已开」，最终是否登录成功要靠下面的轮询。

      const onStartLogin = (platform) => run('start:' + platform, async () => {
        const result = await postJson(prefix + '/settings/login/start', { platform })
        if (result.started !== true) {
          // 没启动就是没启动：写进 loginError，不塞进 loginStates 冒充一个「登录状态」。
          setLoginError({ platform, text: result.detail ?? t('没能打开登录窗口', 'Could not open the sign-in window') })
          return
        }
        setLoginError(null)
        setLoginStates((prev) => ({ ...prev, [platform]: normalizeLogin(result) }))
      })

      const onCancelLogin = (platform) => run('cancel:' + platform, async () => {
        const result = await postJson(prefix + '/settings/login/cancel', { platform })
        // 取消失败多半是「已经结束了」，如实说出来比静默好；同样不进 loginStates。
        if (result.cancelled !== true) {
          setLoginError({ platform, text: result.detail ?? t('没能取消', 'Could not cancel') })
          return
        }
        setLoginStates((prev) => ({ ...prev, [platform]: normalizeLogin(result) }))
      })

      const onPreviewModels = () => run('preview', async () => {
        const result = await postJson(prefix + '/settings/models/preview', {})
        setModelPreview(result)
      })

      const onApplyModels = () => run('apply', async () => {
        const result = await postJson(prefix + '/settings/models/apply', {})
        setModelPreview(result)
        setMessage(result.ok === true
          ? { kind: 'ok', text: t('模型路由已写入。', 'Model routes written.') }
          : { kind: 'bad', text: result.reason ?? result.detail ?? t('写入失败', 'Write failed') })
      })

      // ---- 平台与模型：草稿与保存 ----
      //
      // 保存走 JSON（`POST /settings/models/selection`），浏览器看板那条走 urlencoded
      // 表单——两条入口共用同一个选择中心和同一份校验，只有传输格式不同。
      // 保存成功后**不**假装成功：服务端回的行数据才是页面唯一事实来源，草稿清空、
      // 以回包重画；`changed` 为空就如实说「没有变化」。
      const modelsProviders = Array.isArray(state.modelsProviders) ? state.modelsProviders : []
      const draftModels = modelsDraft ?? seedModelsDraft(modelsProviders)

      const patchDraft = (id, patch) => {
        const base = draftModels
        const previous = base[id] ?? { enabled: false, mode: 'all', modelIds: [], imageIds: null }
        setModelsDraft({ ...base, [id]: { ...previous, ...patch } })
      }

      /** 选择方式：整类跟随客户端清单（all）或自己挑（pick）。 */
      const onSetMode = (row, mode) => {
        const ids = (row.models ?? []).map((model) => model.id)
        if (mode === 'all') {
          patchDraft(row.id, { mode: 'all', modelIds: [] })
          return
        }
        // 切到「自己挑」时保留已经勾过的 id（从「全部」切过来就是空集）：
        // 用户点这个按钮的意思是「我要自己挑」，不是「顺便把上一轮的清掉」。
        const entry = draftModels[row.id] ?? { enabled: false, mode: 'all', modelIds: [] }
        const kept = (entry.modelIds ?? []).filter((id) => ids.includes(id))
        patchDraft(row.id, { mode: 'pick', modelIds: kept })
      }

      /** 「自己挑」模式下的批量动作：全选 / 全不选 / 反选。 */
      const onBulkModels = (row, action) => {
        const ids = (row.models ?? []).map((model) => model.id)
        const entry = draftModels[row.id] ?? { enabled: false, mode: 'pick', modelIds: [] }
        const current = (entry.modelIds ?? []).filter((id) => ids.includes(id))
        if (action === 'all') {
          patchDraft(row.id, { mode: 'pick', modelIds: ids })
          return
        }
        if (action === 'none') {
          patchDraft(row.id, { mode: 'pick', modelIds: [] })
          return
        }
        patchDraft(row.id, { mode: 'pick', modelIds: ids.filter((id) => !current.includes(id)) })
      }

      // 单个模型只在「自己挑」模式里可点；点一下就是加/减一个 id，永远落成显式清单。
      const onToggleModel = (row, modelId) => {
        const ids = (row.models ?? []).map((model) => model.id)
        const entry = draftModels[row.id] ?? { enabled: false, mode: 'pick', modelIds: [] }
        const current = (entry.modelIds ?? []).filter((id) => ids.includes(id))
        const next = current.includes(modelId)
          ? current.filter((id) => id !== modelId)
          : current.concat(ids.includes(modelId) ? [modelId] : [])
        patchDraft(row.id, { mode: 'pick', modelIds: next })
      }

      // ---- 图片输入：独立的每模型清单 ----
      //
      // 与「显示哪些模型」正交：一个模型可以先不显示、但仍留着图片设置，反过来也一样。
      // 三态里 `null` = 跟随客户端目录的原生能力（客户端以后新增的多模态模型会自动
      // 能收图），一旦手动点过就落成显式白名单，并给出「恢复跟随原生能力」这一键——
      // 没有这一键，用户手滑一次就再也回不到自动档，只能去删状态文件。
      const imageStateOf = (row) => {
        const models = Array.isArray(row.models) ? row.models : []
        const draft = draftModels[row.id] ?? { imageIds: null }
        const imageIds = Array.isArray(draft.imageIds) ? draft.imageIds : null
        return { models, imageIds, picked: imageIds === null ? null : new Set(imageIds) }
      }

      /**
       * 某个模型当下是否会收图片。
       *
       * `null` 档直接读服务端算好的生效值 `model.image`（= 客户端目录的原生声明），
       * 页面不自己再推断一遍原生能力——两处各推一次，迟早会不一致。
       */
      const imageOnFor = (imageState, model) =>
        imageState.picked === null ? model.image === true : imageState.picked.has(model.id)

      const onToggleImage = (row, model) => {
        const imageState = imageStateOf(row)
        if (imageState.picked !== null) {
          const next = new Set(imageState.picked)
          if (next.has(model.id)) next.delete(model.id)
          else next.add(model.id)
          patchDraft(row.id, { imageIds: [...next] })
          return
        }
        // 从「跟随原生」切到显式清单：以当下的原生生效值为起点，只翻转被点的那一个。
        // 整体改成「空集」会让用户点一下就把别人的图片能力全关掉，那是个陷阱。
        const next = new Set(
          imageState.models.filter((item) => imageOnFor(imageState, item)).map((item) => item.id),
        )
        if (next.has(model.id)) next.delete(model.id)
        else next.add(model.id)
        patchDraft(row.id, { imageIds: [...next] })
      }

      /** 回到「跟随原生能力」（imageIds: null）。 */
      const onResetImage = (row) => {
        patchDraft(row.id, { imageIds: null })
      }

      const onSaveModels = () => run('models-save', async () => {
        setModelsMsg(null)
        // 只提交**当下可接入**的平台：未接入的平台留着开关也没用，塞进载荷只会让
        // 服务端多回一条 rejected，还得在界面上解释一遍。服务端有自己的校验，
        // 这里是让载荷如实反映「用户能做的决定」。
        const selectableIds = new Set(
          modelsProviders.filter((row) => row.selectable === true).map((row) => row.id),
        )
        const providers = {}
        for (const [id, entry] of Object.entries(draftModels)) {
          if (!selectableIds.has(id)) continue
          // 图片清单与平台开关、模型白名单分开搬：关掉平台不该丢掉勾好的图片，
          // 重新打开时要原样回来（服务端也是这么理解的，它的注释写在这条契约上）。
          const imageIds = Array.isArray(entry.imageIds) ? entry.imageIds : null
          const imagePart = { imageIds }
          if (entry.enabled !== true) {
            providers[id] = { enabled: false, ...imagePart }
            continue
          }
          providers[id] = entry.mode === 'all'
            ? { enabled: true, all: true, ...imagePart }
            : { enabled: true, modelIds: entry.modelIds ?? [], ...imagePart }
        }
        const result = await postJson(prefix + '/settings/models/selection', { providers })
        if (result.ok !== true) {
          setModelsMsg({ kind: 'bad', text: result.detail ?? result.reason ?? t('保存失败', 'Save failed') })
          return
        }
        setModelsDraft(null)
        const fresh = Array.isArray(result.providers) ? result.providers : null
        if (fresh !== null) setState((prev) => (prev === null ? prev : { ...prev, modelsProviders: fresh }))
        const changed = Array.isArray(result.changed) ? result.changed : []
        setModelsMsg(changed.length === 0
          ? { kind: 'ok', text: t('没有变化：服务端没有改写选择文件。', 'No change: nothing was written.') }
          : { kind: 'ok', text: t('已保存，模型选择器已刷新（不需要重启 DSH）。', 'Saved — the model picker has been refreshed (no DSH restart needed).') })
      })

      const rows = []

      // ---- 头部 ----
      rows.push(h('div', { className: 'chub-head', key: 'head', children: [
        h('h2', { className: 'chub-title', key: 't', children: t('dsh-agent-checkin', 'dsh-agent-checkin') }),
        h('p', { className: 'chub-sub', key: 's', children: page === 'models'
          ? t(
            '这里决定把哪些本机客户端接入成 DSH 的模型 provider，以及每个平台在模型选择器里显示哪些模型。保存即生效，不需要重启。',
            'Choose which local clients become DSH model providers and which models each one shows in the model picker. Saves take effect immediately, no restart.',
          )
          : t(
            '本页只读地探测各客户端的登录态，并可写入即梦 / 灵犀的 Cookie。所有结果都来自宿主进程的真实调用，页面不做推断。',
            'This page checks the sign-in state of each local client and can store cookies for 即梦 / 灵犀. Every result comes from a real call in the host process; the page infers nothing.',
          ) }),
      ] }))

      // ---- 真实领取开关 ----
      rows.push(h('div', { className: 'chub-card', key: 'claim', children: [
        h('h3', { key: 'h', children: t('真实领取', 'Actual claiming') }),
        h('p', { className: 'chub-sub', key: 'p', children: state.allowClaim === true
          ? t('已开启：签到会真实改变各平台的余额。', 'Enabled: check-in will really change balances.')
          : t('当前关闭：即使发起签到也只做只读核对，不会改动任何余额。', 'Disabled: even a check-in run only verifies, without changing balances.') }),
        h('div', { className: 'chub-row', key: 'r', children: [
          h('span', { key: 'tag', className: state.allowClaim === true ? 'chub-tag ok' : 'chub-tag off', children: state.allowClaim === true ? t('已开启', 'On') : t('只读', 'Read-only') }),
          h('button', {
            key: 'b', type: 'button', className: 'chub-btn',
            disabled: busy !== null,
            onClick: () => onAllowClaim(state.allowClaim !== true),
            children: state.allowClaim === true ? t('关闭真实领取', 'Turn claiming off') : t('开启真实领取', 'Turn claiming on'),
          }),
        ] }),
      ] }))

      // ---- 手动签到：本页唯一会真实改变余额的按钮 ----
      //
      // 三条纪律写在实现里而不是事后补丁：
      //   · 按钮文案与副标题如实反映「这一轮会不会真的领取」（allowClaim 决定）；
      //   · 「已开始」与「成功」是两句话——start 应答只被用来报告「起没起来」；
      //   · 结果表逐平台列余额，不提供合计（各平台是不同币种）。
      const lastRun = state.lastRun ?? null
      const lastRunRows = lastRun !== null && Array.isArray(lastRun.rows) ? lastRun.rows : []
      const runRunning = state.running === true
      rows.push(h('div', { className: 'chub-card', key: 'run', children: [
        h('h3', { key: 'h', children: t('立即签到', 'Run check-in now') }),
        h('p', { className: 'chub-sub', key: 'p', children: state.allowClaim === true
          ? t('点下面的按钮真实领取各平台积分，跑完自动显示逐平台结果。',
            'The button below really claims credits and shows per-platform results when done.')
          : t('当前是只读模式：点下面的按钮只核对一遍，不会改动任何余额。',
            'Read-only mode: the button below only verifies and changes no balances.') }),
        h('div', { className: 'chub-row', key: 'r', children: [
          h('button', {
            key: 'go', type: 'button', className: 'chub-btn primary',
            disabled: busy !== null || runRunning,
            onClick: () => onStartRun(false),
            children: busy === 'run' ? t('启动中…', 'Starting…') : (runRunning ? t('运行中…', 'Running…') : t('立即签到', 'Run check-in')),
          }),
          h('button', {
            key: 'again', type: 'button', className: 'chub-btn',
            disabled: busy !== null || runRunning,
            onClick: () => onStartRun(true),
            children: t('强制重跑', 'Force re-run'),
          }),
          runRunning ? h('span', { key: 'live', className: 'chub-tag warn', children: t('运行中', 'Running') }) : null,
        ] }),
        h('div', { className: 'chub-muted', key: 'hint', children: t(
          '「强制重跑」忽略「今天已领过就跳过」的保护，会不会重复领取由平台自己决定；普通点击不会重复领取。',
          '"Force re-run" ignores the "already claimed today" skip; whether that double-claims is up to each platform. A normal click never does.',
        ) }),
        state.lastRunError ? h('div', { className: 'chub-msg bad', key: 'err', children: t('上一轮没有跑成：', 'The last run did not finish: ') + String(state.lastRunError) }) : null,
        lastRun === null
          ? h('div', { className: 'chub-muted', key: 'none', children: t('还没跑过一轮。', 'No run yet.') })
          : h('div', { key: 'res', style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
              h('div', { key: 'meta', className: 'chub-muted', children: [
                (lastRun.claimed === true ? t('真实领取', 'Real claiming') : t('只读核对', 'Read-only'))
                  + (lastRun.downgraded === true ? t('（本轮被降级成只读）', ' (downgraded to read-only)') : '')
                  + (lastRun.restored === true ? t('（重启后恢复的历史结果）', ' (restored from the last session)') : '')
                  + ' · ' + (lastRun.finishedAt ?? '—')
                  + (typeof lastRun.elapsedMs === 'number' ? ' · ' + Math.round(lastRun.elapsedMs / 1000) + 's' : ''),
              ] }),
              lastRunRows.length === 0
                ? h('div', { key: 'norows', className: 'chub-muted', children: t('这一轮没有逐平台明细（可能是引擎没有返回）。', 'No per-platform detail in this run (the engine may not have returned any).') })
                : h('table', { className: 'chub-table', key: 'tbl', children: [
                    h('thead', { key: 'th', children: h('tr', { children: [
                      h('th', { key: 'n', children: t('平台', 'Platform') }),
                      h('th', { key: 'r', children: t('结果', 'Result') }),
                      h('th', { key: 'b', children: t('余额', 'Balance') }),
                      h('th', { key: 'd', children: t('说明', 'Detail') }),
                    ] }) }),
                    h('tbody', { key: 'tb', children: lastRunRows.map((r) => h('tr', { key: r.id, children: [
                      h('td', { key: 'n', children: h('div', { className: 'chub-name', children: r.name ?? r.id }) }),
                      h('td', { key: 'r', children: [
                        h('span', { className: runBucketClass(r.bucket), children: String(r.code ?? '—') }),
                        h('div', { className: 'chub-muted', children: String(r.codeLabel ?? '') }),
                      ] }),
                      h('td', { key: 'b', children: fmtBalance(r) }),
                      h('td', { key: 'd', children: h('div', { className: 'chub-muted', children: String(r.detail ?? '') }) }),
                    ] })) }),
                  ] }),
              Array.isArray(lastRun.skipped) && lastRun.skipped.length > 0 ? h('div', {
                key: 'skip', className: 'chub-muted',
                children: t('本轮跳过：', 'Skipped this round: ') + lastRun.skipped.map((s) => s.name ?? s.id).join('、'),
              }) : null,
            ] }),
      ] }))

      // ---- 操作行 ----
      rows.push(h('div', { className: 'chub-row', key: 'actions', children: [
        h('button', {
          key: 'check', type: 'button', className: 'chub-btn primary',
          disabled: busy !== null,
          onClick: onCheck,
          children: busy === 'check' ? t('实测中…', 'Checking…') : t('实测登录态（只读）', 'Check sign-in (read-only)'),
        }),
        h('a', { key: 'dash', className: 'chub-sub', href: prefix, target: '_blank', rel: 'noreferrer', children: t('打开看板 ↗', 'Open dashboard ↗') }),
      ] }))

      if (message !== null) {
        rows.push(h('div', { key: 'msg', className: 'chub-msg ' + message.kind, children: message.text }))
      }

      // ---- 可签到平台 ----
      rows.push(h('div', { className: 'chub-card', key: 'claiming', children: [
        h('h3', { key: 'h', children: t('有领取动作的平台（' + claiming.length + '）', 'Platforms with a claim action (' + claiming.length + ')') }),
        h('table', { className: 'chub-table', key: 'tb', children: [
          h('thead', { key: 'th', children: h('tr', { children: [
            h('th', { key: 'n', children: t('平台', 'Platform') }),
            h('th', { key: 'c', children: t('凭据来源', 'Credentials') }),
            h('th', { key: 's', children: t('实测结果', 'Check result') }),
          ] }) }),
          h('tbody', { key: 'tbody', children: claiming.map((p) => {
            const row = checksById.get(p.id)
            const src = credSources.find((c) => c.platform === p.id)
            return h('tr', { key: p.id, children: [
              h('td', { key: 'n', children: [
                h('div', { className: 'chub-name', children: p.name ?? p.id }),
                h('div', { className: 'chub-muted', children: p.note ?? '' }),
              ] }),
              h('td', { key: 'c', children: src !== undefined
                ? h('span', { className: 'chub-tag', children: src.label })
                : h('span', { className: 'chub-muted', children: t('本机客户端自动读取', 'Read from the local client') }) }),
              h('td', { key: 's', children: row === undefined
                ? h('span', { className: 'chub-muted', children: t('未实测', 'Not checked') })
                : h('div', { children: [
                    h('span', { className: statusClass(row.status), children: statusText(row.status) }),
                    h('div', { className: 'chub-mono muted', children: (row.code ?? '') + (typeof row.balance === 'number' ? ' · ' + fmtBalance(row) : '') }),
                  ] }) }),
            ] })
          }) }),
        ] }),
      ] }))

      // ---- 需要手工录 Cookie 的平台 ----
      //
      // 每个平台有两条路，并列摆出来而不分主次：
      //   ① 点「打开登录窗口」——弹出独立浏览器，登录完自动采集并验证写盘；
      //   ② 或者自己在 F12 里复制整个 Cookie 粘进来。
      // ② 留着是因为 ① 依赖本机能弹出 Chromium；有的环境（远程桌面、
      // 策略禁止子进程开窗）下只有手工那条路走得通。
      //
      // 「发起登录」与「可粘贴 Cookie」是两件事：loginSources 只要有登录按钮就出卡
      //（kling 属于「能登录但没有 Cookie 可粘贴」），credSources 才有输入框。
      if (credSources.length > 0 || loginSources.length > 0) {
        rows.push(h('div', { className: 'chub-card', key: 'cred', children: [
          h('h3', { key: 'h', children: t('登录 / 手工凭证', 'Sign-in / manual credentials') }),
          h('p', { className: 'chub-sub', key: 'p', children: t(
            '推荐点「打开登录窗口」：会弹出一个独立浏览器，你在里面登录，成功后自动保存并验证。也可以直接粘贴 Cookie（只有下面标了输入框的平台可以粘贴）。',
            'Preferred: press "Open sign-in window" — a separate browser opens, and the cookie is captured and verified once you sign in. Pasting a cookie still works (only platforms with an input below).',
          ) }),
          ...loginSources.map((src) => {

            const info = (credentials.entries ?? []).find((e) => e.platform === src.platform)
            const result = credResult[src.platform]
            const login = loginStates[src.platform] ?? normalizeLogin(null)
            const loginBusy = busy === 'cancel:' + src.platform
            // 用**按钮 + fetch POST**，不用 `<a href>` 导航。
            //
            // 这里前后错了五轮，把结论钉死免得再改：
            //
            //   - 渲染进程发的 POST **本来就不带 Origin**（同源 fetch 浏览器不加这个头），
            //     那不是「请求可疑」，是它本来的样子。
            //   - 走 `<a href>` 导航在 Electron 里两条路都是死的：
            //     `_self` 把整个宿主主界面导航走（28 个客户端插件被卸载，报
            //     「Failed to load plugins / entries did not activate」）；
            //     `_blank` 在这个宿主里弹不出窗口，点了毫无反应。
            //   - 服务端已改为「带 Origin 才严格同源校验，不带 Origin 时只需本机回环」，
            //     面板内直接 POST 因此可行，也**不需要浏览器替我们做任何事**。
            //
            // 所以：一个普通按钮，点了就 POST。失败原因显示在下面那一行。
            return h('div', { key: 'c-' + src.platform, className: 'chub-card', children: [
              h('div', { className: 'chub-row', key: 'top', children: [
                h('div', { className: 'chub-grow', children: [
                  h('div', { className: 'chub-name', children: src.label }),
                  h('div', { className: 'chub-muted', children: t('当前凭证：', 'Current credential: ') + (info === undefined ? t('状态未知', 'unknown') : statusText(info.status)) }),
                ] }),
                h('span', { className: loginClass(login.status), children: loginText(login.status) }),
                h('button', {
                  key: 'open', type: 'button', className: 'chub-btn primary',
                  disabled: loginBusy || login.running === true,
                  onClick: () => onStartLogin(src.platform),
                  children: t('打开登录窗口', 'Open sign-in window'),
                }),
                login.running !== true ? null : h('button', {
                  type: 'button', className: 'chub-btn', disabled: loginBusy,
                  onClick: () => onCancelLogin(src.platform),
                  children: t('取消', 'Cancel'),
                }),
              ] }),
              login.detail === '' ? null : h('div', {
                className: 'chub-msg ' + (login.status === 'saved' ? 'ok' : (login.running === true ? 'warn' : (login.status === 'idle' ? '' : 'bad'))),
                key: 'ld',
                children: login.detail,
              }),
              // 请求层面的失败单独一行：它的措辞来自服务端（守卫拦截原因等），
              // 与「登录本身的结果」不是一回事，不该混进上面那条状态里。
              loginError === null || loginError.platform !== src.platform ? null : h('div', {
                className: 'chub-msg bad',
                key: 'le',
                children: loginError.text,
              }),
              // 登录过程的原始输出：只在有内容时出现，且用等宽小字放在可滚区域里。
              // 它是排查「窗口开着但什么都没保存」唯一的线索，所以不藏着。
              login.output.trim() === '' ? null : h('pre', {
                key: 'lo',
                className: 'chub-mono',
                style: { whiteSpace: 'pre-wrap', margin: 0, maxHeight: 140, overflow: 'auto' },
                children: login.output.trim(),
              }),
              // 没有 Cookie 可粘贴的平台（kling，登录态存整个浏览器 profile）：
              // 这里只剩「登录结果」这一件事，不渲染 Cookie 输入框与保存/清除按钮——
              // 渲染一个永远用不上的输入框比少一个输入框更误导。
              src.pasteable === false ? null : h('input', {
                className: 'chub-input', type: 'password', autoComplete: 'off', spellCheck: false,
                placeholder: t('或者粘贴 Cookie（保存后立即只读验证）', 'Or paste a cookie (verified read-only after saving)'),
                value: credDraft[src.platform] ?? '',
                onChange: (event) => {
                  const value = event.target.value
                  setCredDraft((prev) => ({ ...prev, [src.platform]: value }))
                },
              }),
              src.pasteable === false ? null : result === undefined ? null : h('div', { className: 'chub-msg ' + (result.ok === true ? 'ok' : 'bad'), children: result.note ?? result.detail ?? '' }),
              src.pasteable === false ? null : h('div', { className: 'chub-row', key: 'btns', children: [
                h('button', {
                  type: 'button', className: 'chub-btn', disabled: busy !== null,
                  onClick: () => onSaveCredential(src.platform),
                  children: busy === 'cred:' + src.platform ? t('保存中…', 'Saving…') : t('保存粘贴的 Cookie', 'Save pasted cookie'),
                }),
                h('button', {
                  type: 'button', className: 'chub-btn', disabled: busy !== null,
                  onClick: () => onClearCredential(src.platform),
                  children: t('清除', 'Clear'),
                }),
              ] }),
            ] })
          }),
        ] }))
      }
      // ---- 只读平台 ----
      if (readonlySources.length > 0) {
        rows.push(h('div', { className: 'chub-card', key: 'ro', children: [
          h('h3', { key: 'h', children: t('不支持录入凭证的平台', 'Platforms without manual credentials') }),
          h('p', { className: 'chub-sub', key: 'p', children: t(
            '下列平台要么凭证在客户端本地加密存储，要么没有可调用的领取接口——录 Cookie 也没有用，所以这里不提供输入框。',
            'For these platforms the credential is stored encrypted inside the client, or there is no claimable endpoint — pasting a cookie would not help, so there is no input here.',
          ) }),
          h('ul', { key: 'ul', className: 'chub-sub', children: readonlySources.map((item) => h('li', { key: item.platform, children: [
            h('strong', { children: item.label }),
            ' — ',
            item.reason,
          ] })) }),
        ] }))
      }

      // ---- 手动积分：每个平台的「当前积分」 ----
      //
      // 优先级在服务端已合成（describeBalances）：实测值有就显示实测值（标「实测」），
      // 没有就显示手动值（标「手动」），两者都没有显示 —。点「修改」展开行内编辑，
      // 数字 + 一句备注；手动值**不是充值**，只是记录当前数量，面板与看板都会如实标注来源。
      if (balanceRows.length > 0) {
        rows.push(h('div', { className: 'chub-card', key: 'balances', children: [
          h('h3', { key: 'h', children: t('各平台当前积分', 'Current credits per platform') }),
          h('p', { className: 'chub-sub', key: 'p', children: t(
            '实测到的积分优先显示；引擎读不到的平台可以手动记录一个当前值（会标「手动」）。各平台积分是不同币种，不做合计。',
            'Measured credits are shown first; for platforms the engine cannot read you can record a manual value (tagged "manual"). Credit units differ per platform; no totals.',
          ) }),
          h('table', { className: 'chub-table', key: 'tb', children: [
            h('thead', { key: 'th', children: h('tr', { children: [
              h('th', { key: 'n', children: t('平台', 'Platform') }),
              h('th', { key: 'b', children: t('当前积分', 'Credits') }),
              h('th', { key: 'src', children: t('来源', 'Source') }),
              h('th', { key: 'op', children: '' }),
            ] }) }),
            h('tbody', { key: 'tb2', children: balanceRows.map((item) => {
              const isEditing = balanceEdit?.platform === item.platform
              const saveResult = balanceResult[item.platform]
              // 「手动」标签只有真正用手动值展示时才出现——实测值在就绝不冒充。
              const sourceTag = item.source === 'measured'
                ? h('span', { key: 'sm', className: 'chub-tag', children: t('实测', 'measured') })
                : item.source === 'manual'
                  ? h('span', { key: 'sm', className: 'chub-tag warn', children: t('手动', 'manual') })
                  : h('span', { key: 'sm', className: 'chub-muted', children: t('—', '—') })
              const balanceText = typeof item.balance === 'number'
                ? fmtBalance({ balance: item.balance, unit: item.unit })
                : '—'
              // 每个平台可能出两行：主行（固定四格）+ 编辑行（colSpan 4）。
              // 编辑行不能塞进主行里——多出的空 td 会把表格顶出一条假列。
              const mainRow = h('tr', { key: item.platform, children: [
                h('td', { key: 'n', children: h('div', { className: 'chub-name', children: item.name ?? item.platform }) }),
                h('td', { key: 'b', children: [
                  h('span', { className: 'chub-mono', children: balanceText }),
                  item.note ? h('div', { className: 'chub-muted', children: String(item.note) }) : null,
                ] }),
                h('td', { key: 'src', children: sourceTag }),
                h('td', { key: 'op', children: h('div', { className: 'chub-row', children: [
                  h('button', {
                    type: 'button', className: 'chub-btn', disabled: busy !== null,
                    onClick: () => startBalanceEdit(item),
                    children: t('修改', 'Edit'),
                  }),
                  // 只有没有实测值时才给「清除」：实测值来源没法被手动清除——
                  // 下一次运行它还会回来，装作清掉了是假动作。
                  item.source === 'manual' ? h('button', {
                    type: 'button', className: 'chub-btn', disabled: busy !== null,
                    onClick: () => clearBalance(item.platform),
                    children: t('清除', 'Clear'),
                  }) : null,
                ] }) }),
              ] })
              if (!isEditing) return mainRow
              const editRow = h('tr', { key: item.platform + ':edit', className: 'chub-edit-row', children: [
                h('td', { key: 'edit', colSpan: 4, children: [
                  h('div', { className: 'chub-row', children: [
                    h('input', {
                      className: 'chub-input', type: 'text', inputMode: 'decimal',
                      spellCheck: false, style: { maxWidth: 180 },
                      placeholder: t('当前积分数字', 'Current credit number'),
                      value: balanceEdit.draft,
                      onChange: (event) => setBalanceEdit((prev) => ({ ...prev, draft: event.target.value })),
                    }),
                    h('input', {
                      className: 'chub-input', type: 'text', spellCheck: false,
                      style: { maxWidth: 260 },
                      placeholder: t('备注（可选，如：含活动赠送）', 'Note (optional, e.g. incl. event bonus)'),
                      value: balanceEdit.note ?? '',
                      onChange: (event) => setBalanceEdit((prev) => ({ ...prev, note: event.target.value })),
                    }),
                    h('button', {
                      type: 'button', className: 'chub-btn primary', disabled: busy !== null,
                      onClick: () => submitBalanceEdit(item.platform),
                      children: busy === 'balance:' + item.platform ? t('保存中…', 'Saving…') : t('保存', 'Save'),
                    }),
                    h('button', {
                      type: 'button', className: 'chub-btn', disabled: busy !== null,
                      onClick: () => setBalanceEdit(null),
                      children: t('取消', 'Cancel'),
                    }),
                  ] }),
                  saveResult === undefined ? null : h('div', { className: 'chub-msg ' + (saveResult.ok === true ? 'ok' : 'bad'), children: saveResult.ok === true ? t('已保存。', 'Saved.') : (saveResult.detail ?? t('保存失败', 'Save failed')) }),
                ] }),
              ] })
              return [mainRow, editRow]
            }) }),
          ] }),
        ] }))
      }

      // ---- 模型路由 ----
      const models = state.models ?? {}
      const routes = Array.isArray(models.routes) ? models.routes : []
      rows.push(h('div', { className: 'chub-card', key: 'models', children: [
        h('h3', { key: 'h', children: t('模型路由（写入宿主 pi-ai）', 'Model routes (written to host pi-ai)') }),
        h('p', { className: 'chub-sub', key: 'p', children: routes.length === 0
          ? t('没有配置 modelRoutes，本区不做任何事。', 'No modelRoutes configured; this section does nothing.')
          : t('共 ' + routes.length + ' 条路由。预览不落盘。', routes.length + ' route(s). Preview does not write.') }),
        h('div', { className: 'chub-row', key: 'r', children: [
          h('button', { type: 'button', className: 'chub-btn', disabled: busy !== null || routes.length === 0, onClick: onPreviewModels, children: t('预览', 'Preview') }),
          h('button', { type: 'button', className: 'chub-btn primary', disabled: busy !== null || routes.length === 0, onClick: onApplyModels, children: t('写入', 'Write') }),
        ] }),
        modelPreview === null ? null : h('pre', { className: 'chub-mono', style: { whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }, children: JSON.stringify(modelPreview, null, 2) }),
      ] }))

      // ---- 「平台与模型」页签的内容 ----
      //
      // 只列**当下真实注册**的平台（selectable），未接入的也照样列出并写明原因：
      // 「我以为它是开着的」比「它明确说没接入」更容易浪费半小时。模型清单来自
      // 各平台适配器当下的实时目录，页面不缓存、不猜。
      const buildModelsRows = () => {
        const out = []
        out.push(h('div', { className: 'chub-card', key: 'mm-head', children: [
          h('h3', { key: 'h', children: t('接入哪些平台', 'Which providers') }),
          h('p', { className: 'chub-sub', key: 'p', children: t(
            '勾选的平台会出现在 DSH 对话窗的模型选择器里。每个平台有两种选择方式：「全部模型」= 跟随客户端清单（新增的自动出现）；「我自己挑」= 从空白开始，点一下选中、再点取消，只显示你点的那几个。保存即生效，不需要重启。',
            'Checked providers appear in the DSH chat model picker. Each provider has two modes: “All models” follows the client catalog (new models appear automatically); “Pick them myself” starts from nothing — click to select, click again to deselect, and only those are shown. Changes apply on save, no restart.',
          ) }),
          h('p', { className: 'chub-sub', key: 'p2', children: t(
            '括号里的倍率取自客户端自己的清单（WorkBuddy 的 creditMultiplier、Qoder 的 priceFactor、TRAE 的 consumption_rate）：1.00x 是原价，0.79x 表示打 79 折积分，免费额度模型显示「免费」。个别模型客户端没给倍率，那一列留空——不猜。',
            'The multiplier in brackets comes from the client catalog itself (WorkBuddy creditMultiplier, Qoder priceFactor, TRAE consumption_rate): 1.00x is list price, 0.79x means 79% of the credit cost, free-tier models show free. For models whose client gives no multiplier, that column stays empty rather than guessed.',
          ) }),
          h('div', { className: 'chub-row', key: 'r', children: [
            h('button', {
              key: 'save', type: 'button', className: 'chub-btn primary',
              disabled: busy !== null,
              onClick: onSaveModels,
              children: busy === 'models-save' ? t('保存中…', 'Saving…') : t('保存', 'Save'),
            }),
            h('button', {
              key: 'reset', type: 'button', className: 'chub-btn',
              disabled: busy !== null,
              onClick: () => { setModelsDraft(null); setModelsMsg(null); refresh() },
              children: t('放弃修改并重新读取', 'Discard and reload'),
            }),
          ] }),
          modelsMsg === null ? null : h('div', {
            key: 'msg',
            className: 'chub-msg' + (modelsMsg.kind === 'bad' ? ' bad' : ''),
            children: modelsMsg.text,
          }),
        ] }))

        if (modelsProviders.length === 0) {
          out.push(h('div', { className: 'chub-msg bad', key: 'mm-empty', children: t(
            '宿主没有报告任何平台：插件可能没有在宿主进程里跑起来（看宿主日志确认装配是否成功）。',
            'The host reported no providers — the plugin may not be running inside the host process (check the host log).',
          ) }))
          return out
        }

        for (const row of modelsProviders) {
          const models = Array.isArray(row.models) ? row.models : []
          const ids = models.map((model) => model.id)
          const selectable = row.selectable === true
          const entry = draftModels[row.id] ?? { enabled: false, mode: 'all', modelIds: [] }
          const isPick = entry.mode === 'pick'
          const picked = isPick ? (entry.modelIds ?? []).filter((id) => ids.includes(id)) : []
          const pickedCount = isPick ? picked.length : models.length
          out.push(h('div', { className: 'chub-card', key: 'mm-' + row.id, children: [
            h('div', { className: 'chub-row', key: 'title', children: [
              h('h3', { key: 'n', children: row.label ?? row.id }),
              h('span', { key: 'tag', className: selectable ? 'chub-tag ok' : 'chub-tag off', children: selectable ? t('已接入', 'Available') : t('未接入', 'Unavailable') }),
              h('span', { key: 'id', className: 'chub-mono', children: row.id }),
            ] }),
            h('p', { className: 'chub-sub', key: 's', children: selectable
              ? t('实时可用模型 ' + models.length + ' 个，当前会显示 ' + pickedCount + ' 个。', models.length + ' model(s) live, ' + pickedCount + ' will show.')
              : String(row.statusText ?? t('这个平台当前没有注册成功。', 'This provider is not registered right now.')) }),
            // 勾选行统一用按钮：原生 checkbox 在宿主设置面板里出现过「点了不变」，
            // 而这条点击路径不归插件控制。按钮的状态完全由我们要不要改 state 决定。
            h('button', {
              key: 'on',
              type: 'button',
              className: 'chub-pick' + (entry.enabled === true ? ' on' : ''),
              'aria-pressed': entry.enabled === true ? 'true' : 'false',
              disabled: !selectable || busy !== null,
              onClick: () => patchDraft(row.id, { enabled: entry.enabled !== true }),
              children: [
                h('span', { key: 'box', className: 'chub-box', children: entry.enabled === true ? '✓' : '' }),
                h('strong', { key: 't', children: t('在模型选择器里显示这个平台', 'Show this provider in the model picker') }),
              ],
            }),
            models.length === 0 ? null : h('div', { key: 'models', className: 'chub-models' + (entry.enabled === true ? '' : ' off'), children: [
              // 两种选择方式，平铺成两枚按钮：默认不预勾 34 个模型、逼用户一个个取消。
              // 选了「我自己挑」就是一个都不勾，直接从空白开始点要用的那几个。
              h('div', { className: 'chub-modes', key: 'mode', children: [
                h('button', {
                  key: 'mode-all',
                  type: 'button',
                  className: 'chub-mode' + (isPick ? '' : ' on'),
                  disabled: busy !== null,
                  'aria-pressed': isPick ? 'false' : 'true',
                  onClick: () => onSetMode(row, 'all'),
                  children: t('全部模型（跟随客户端清单）', 'All models (follow the catalog)'),
                }),
                h('button', {
                  key: 'mode-pick',
                  type: 'button',
                  className: 'chub-mode' + (isPick ? ' on' : ''),
                  disabled: busy !== null,
                  'aria-pressed': isPick ? 'true' : 'false',
                  onClick: () => onSetMode(row, 'pick'),
                  children: t('我自己挑', 'Pick them myself'),
                }),
              ] }),
              isPick
                ? h('div', { className: 'chub-row', key: 'bulk', children: [
                  h('button', {
                    key: 'bulk-none', type: 'button', className: 'chub-btn', disabled: busy !== null,
                    onClick: () => onBulkModels(row, 'none'),
                    children: t('全不选', 'Clear'),
                  }),
                  h('button', {
                    key: 'bulk-all', type: 'button', className: 'chub-btn', disabled: busy !== null,
                    onClick: () => onBulkModels(row, 'all'),
                    children: t('全选', 'Select all'),
                  }),
                  h('button', {
                    key: 'bulk-invert', type: 'button', className: 'chub-btn', disabled: busy !== null,
                    onClick: () => onBulkModels(row, 'invert'),
                    children: t('反选', 'Invert'),
                  }),
                  h('span', { key: 'cnt', className: 'chub-sub', children: t('已选 ' + picked.length + ' / ' + models.length, picked.length + ' / ' + models.length + ' selected') }),
                ] })
                : h('p', { className: 'chub-sub', key: 'allhint', children: t(
                  '整类跟随：模型选择器里会显示这个平台的全部模型，客户端以后新增的也会自动出现。想只留几个，就点「我自己挑」。',
                  'Follow-the-catalog: every model of this provider is shown, and models added later appear automatically. To show only a few, choose “Pick them myself”.',
                ) }),
              isPick
                ? h('p', { className: 'chub-sub', key: 'pickhint', children: t(
                  '从空白开始点要用的模型：点一下选中，再点取消。一个都不点时保存，这个平台就不贡献模型。',
                  'Start from nothing and click the models you want: click to select, click again to deselect. Saving with none selected means this provider contributes no models.',
                ) })
                : null,
              isPick
                ? models.map((model) => {
                  const on = picked.includes(model.id)
                  return h('button', {
                    key: 'm-' + model.id,
                    type: 'button',
                    className: 'chub-pick' + (on ? ' on' : ''),
                    'aria-pressed': on ? 'true' : 'false',
                    disabled: busy !== null,
                    onClick: () => onToggleModel(row, model.id),
                    children: [
                      h('span', { key: 'box', className: 'chub-box', children: on ? '✓' : '' }),
                      h('span', { key: 'n', className: 'chub-pick-name', children: model.name ?? model.id }),
                      model.name !== undefined && model.name !== model.id
                        ? h('span', { key: 'id', className: 'chub-mono', children: model.id })
                        : null,
                      rateLabel(model),
                    ],
                  })
                })
                : null,
            ] }),
            // ---- 图片输入：与「显示哪些模型」正交的第二组开关 ----
            //
            // 每个模型一行，勾上 = 对上游按"能收图片"发出请求。`imageIds === null`
            // 时所有勾选状态来自客户端目录的原生声明（服务端算好的 model.image），
            // 点任意一行就落成显式清单——不给"先点一下才启用"的中间态，那样用户
            // 永远不知道自己现在到底在哪个档。
            models.length === 0 ? null : (() => {
              const imageState = imageStateOf(row)
              const explicitly = imageState.picked !== null
              const imageCount = imageState.models.filter((model) => imageOnFor(imageState, model)).length
              const setAllImages = (on) => patchDraft(row.id, {
                imageIds: on ? imageState.models.map((model) => model.id) : [],
              })
              return h('div', { key: 'images', className: 'chub-imodes', children: [
                h('span', { key: 'lbl', className: 'chub-sub', children: t(
                  '图片输入（' + imageCount + ' / ' + imageState.models.length + ' 个模型' + (explicitly ? '，手动清单' : '，跟随原生') + '）：',
                  'Image input (' + imageCount + ' / ' + imageState.models.length + (explicitly ? ', manual list' : ', following native') + '):',
                ) }),
                h('button', {
                  key: 'img-none', type: 'button', className: 'chub-imode', disabled: busy !== null,
                  onClick: () => setAllImages(false),
                  children: t('全部关掉', 'All off'),
                }),
                h('button', {
                  key: 'img-all', type: 'button', className: 'chub-imode', disabled: busy !== null,
                  onClick: () => setAllImages(true),
                  children: t('全部打开', 'All on'),
                }),
                h('button', {
                  key: 'img-auto', type: 'button',
                  className: 'chub-imode' + (explicitly ? '' : ' on'),
                  disabled: busy !== null,
                  'aria-pressed': explicitly ? 'false' : 'true',
                  onClick: () => onResetImage(row),
                  children: t('跟随原生能力', 'Follow native'),
                }),
                h('div', { key: 'hint', className: 'chub-sub', children: t(
                  '勾上 = 对上游按「能收图片」发出请求。目录没声明图片的模型也可以手动打开——能不能真读图以上游实测为准；「跟随原生能力」= 目录以后新增的多模态模型自动能收图。',
                  'Checked = the request is sent as image-capable. You can enable models the catalog does not declare as vision — whether upstream really reads the image is up to it. “Follow native” = multimodal models added to the catalog later become image-capable automatically.',
                ) }),
                h('div', { key: 'list', className: 'chub-ipicks', children: imageState.models.map((model) => {
                  const on = imageOnFor(imageState, model)
                  const nativeOk = model.image === true
                  return h('button', {
                    key: 'i-' + model.id,
                    type: 'button',
                    className: 'chub-ipick' + (on ? ' on' : ''),
                    'aria-pressed': on ? 'true' : 'false',
                    disabled: busy !== null,
                    title: nativeOk
                      ? t('客户端目录声明这个模型支持图片输入', 'The client catalog declares this model supports image input')
                      : t('客户端目录没有声明图片能力；勾上会对上游按能收图片发出请求', 'The catalog does not declare vision for this model; checking sends image-capable requests anyway'),
                    onClick: () => onToggleImage(row, model),
                    children: [
                      h('span', { key: 'box', className: 'chub-box', children: on ? '✓' : '' }),
                      h('span', { key: 'n', className: 'chub-pick-name', children: model.name ?? model.id }),
                      nativeOk
                        ? null
                        : h('span', { key: 'v', className: 'chub-mono', children: t('目录未声明', 'not declared') }),
                    ],
                  })
                }) }),
              ] })
            })(),
          ] }))
        }
        return out
      }

      // ---- 数据来源 ----
      rows.push(h('div', { className: 'chub-sub', key: 'src', children: t(
        '数据来源：宿主进程对本地客户端的实时探测（' + (state.at ?? '—') + '）。各平台积分币种不同，本页不提供合计。',
        'Source: live probing of local clients by the host process (' + (state.at ?? '—') + '). Credit units differ per platform; no totals are shown.',
      ) }))

      // ---- 前端版本自证 ----
      //
      // 浏览器缓存了旧的 client bundle 时，磁盘和后端都已是新代码，界面里跑的
      // 却还是旧的——表现是「点了按钮永远报同一条错」。这条显示让这种情况
      // **自己说出来**，不必打开开发者工具（F12 打不开的环境里只能这样）。
      // 只在不是 match 时出现：正常情况下它是噪音，异常时才是有用的那一行。
      const clientUi = state.clientUi ?? {}
      let bannerRow = null
      if (clientUi.status !== 'match') {
        const isStale = clientUi.status === 'stale'
        bannerRow = h('div', {
          key: 'ui',
          className: 'chub-msg' + (isStale || clientUi.status === 'unknown' ? ' bad' : ''),
          children: isStale
            ? t(
              '界面代码不是当前版本（浏览器缓存的旧前端：申报 ' + String(clientUi.claimed) + '，期望 ' + String(clientUi.expected) + '）。请按 Ctrl+Shift+R 强制刷新，或重启 DSH 后再试。',
              'This page is running an outdated front-end bundle (claimed ' + String(clientUi.claimed) + ', expected ' + String(clientUi.expected) + '). Press Ctrl+Shift+R to hard-reload, or restart DSH.',
            )
            : t(
              '界面代码早于当前版本（旧前端没有版本申报）。请按 Ctrl+Shift+R 强制刷新，或重启 DSH 后再试。',
              'This page is running an older front-end (no version claim). Press Ctrl+Shift+R to hard-reload, or restart DSH.',
            ),
        })
      }

      // ---- 页签 ----
      //
      // 为什么要页签：平台接入 + 每个平台几十个模型，平铺会把原有的签到配置挤到
      // 看不见的地方；而「签到与凭证」是每天都要看的，不能被挤下去。
      const tabRow = h('div', { className: 'chub-tabs', key: 'tabs', children: [
        h('button', {
          key: 'config', type: 'button',
          className: page === 'config' ? 'chub-tab on' : 'chub-tab',
          onClick: () => setPage('config'),
          children: t('签到与凭证', 'Check-in & credentials'),
        }),
        h('button', {
          key: 'models', type: 'button',
          className: page === 'models' ? 'chub-tab on' : 'chub-tab',
          onClick: () => setPage('models'),
          children: t('平台与模型', 'Providers & models'),
        }),
      ] })

      const headRow = rows[0]
      const bodyRows = page === 'models' ? buildModelsRows() : rows.slice(1)
      const children = [bannerRow, headRow, tabRow, ...bodyRows]
        .filter((item) => item !== null && item !== undefined)

      return h('div', { className: 'chub-root', children })
    }

    // >>> usage-panel parts（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>>
    // ---- client-usage-shared.js ----
/**
     * 前端共享小工具：界面语言判据 + provider 人类可读名。
     *
     * 这个文件原本是「用量统计页面 + 输入框余额徽标」共用的片段。Token 用量那部分
     * 已于 0.9.0 迁到独立插件 dsh-token-usage；本插件这边只留下余额徽标还要用的
     * 两样东西：语言判据与 provider 名字表。
     *
     * 保留成独立片段文件（而不是塞进 client.js 主干）是为了让这一段能单独
     * `node --check`、能被人一眼读完——client.js 是生成物，混进去就会被覆盖。
     */

    /** 当前界面语言是否为中文。与 client.js 的 `t()` 同一判据，避免两处各猜一次。 */
    function isZhUi() {
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    }

    /** 把 provider id 翻成一个人类能读的名字；不认识的照原样显示，不猜。 */
    const PROVIDER_LABELS = {
      workbuddy: 'WorkBuddy',
      'workbuddy-global': 'WorkBuddy AI',
      trae: 'TRAE',
      'trae-global': 'TRAE AI',
      'qoder-cn': 'Qoder',
      'deepseek-account': 'DeepSeek（账号）',
      'deepseek-official': 'DeepSeek（官方）',
      siliconflow: 'SiliconFlow',
      xiaomi: '小米 MiMo',
      zai: '智谱 GLM',
      openrouter: 'OpenRouter',
      freeroute: 'FreeRoute',
      dumate: '百度搭子',
      lingxi: 'WPS 灵犀',
    }

    function providerLabel(id) {
      if (id === '') return '未知来源'
      return PROVIDER_LABELS[id] ?? id
    }

    // ---- client-credits.js ----
// ---- 输入框徽标：当前 provider 的积分余额 ----
    //
    // 用户要的是「在对话框的模型前显示当前引用 agent 的积分余额」。落地时踩到的第一个
    // 事实是：**只有本插件自己接管了 provider 的连接器，才知道怎么问出余额**。所以这里
    // 的显示规则分成三档，每一档都必须诚实：
    //
    //   1. **托管 provider**（本插件注册的 workbuddy / trae / qoder 等）：走
    //      `${prefix}/settings` 已有的状态接口，那里已经带着各平台实测到的余额。
    //   2. **本机自带 API Key 的 provider**（siliconflow / xiaomi / zai…）：这些是
    //      后付费的 token 计费，没有「积分余额」这种东西。硬编一个数字出来是撒谎，
    //      所以只显示它今天花了多少 token——这是从会话日志里真实读到的。
    //   3. **两者都不是**：整个徽标不渲染，也不拉起任何轮询。
    //
    // 归属判断放在 Gate 里而不是组件里：这样切到别的 provider 时连 fetch 都不会发生。

    /** 本插件托管的 provider → 签到平台 id。余额从 `/settings` 的 platforms 里取。 */
    const USAGE_BALANCE_PROVIDERS = {
      workbuddy: 'workbuddy',
      'workbuddy-global': 'workbuddy_intl',
      trae: 'trae',
      'trae-global': 'trae',
      'qoder-cn': 'qoder',
      dumate: 'dumate',
      lingxi: 'lingxi',
    }

    /** 余额轮询间隔：余额按天变，一分钟一次已经远超需要。 */
    const USAGE_CREDITS_POLL_MS = 60_000

    /** 从选中的 provider 上看归属。与宿主 `modelSelection` 投影的两种形态都兼容。 */
    function usageProviderOf(projection) {
      const provider = (projection?.next ?? projection?.lastUsed)?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    }

    function UsageCreditsBadge(props) {
      const { provider, zh } = props
      const [credits, setCredits] = useState(undefined)
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        if (provider === undefined) return undefined
        let alive = true
        const read = async () => {
          const result = await callJson(DEFAULT_PREFIX + '/settings', { cache: 'no-store' })
          if (!alive) return
          if (!result.ok) {
            setFailed(true)
            return
          }
          const wanted = USAGE_BALANCE_PROVIDERS[provider]
          const row = (result.platforms ?? []).find((item) => item.id === wanted)
          const balance = row?.balance
          setFailed(false)
          setCredits(typeof balance?.balance === 'number' ? balance : undefined)
        }
        read()
        const timer = setInterval(read, USAGE_CREDITS_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [provider])

      if (failed) return null
      if (credits === undefined) return null
      const value = Number.isInteger(credits.balance) ? String(credits.balance) : credits.balance.toFixed(1)
      const unit = credits.unit ?? ''
      return h('span', {
        className: 'chub-credit-badge',
        title: zh
          ? providerLabel(provider) + ' 当前余额（来源：' + (credits.source === 'measured' ? '实测' : '手动录入') + '）'
          : providerLabel(provider) + ' balance (' + (credits.source === 'measured' ? 'measured' : 'manual') + ')',
      }, unit === '' ? value : value + ' ' + unit)
    }

    /**
     * 归属闸门：只在自己认识这个 provider 时渲染。
     *
     * `useProjection` 是宿主给 session scope 组件的标准 prop；拿不到（比如这个
     * slot 不是 session scope）时直接不渲染，而不是退化成「随便显示一个数」。
     */
    function UsageCreditsGate(props) {
      const { useProjection } = props
      const zh = isZhUi()
      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
      const provider = usageProviderOf(projection)
      if (provider === undefined) return null
      if (USAGE_BALANCE_PROVIDERS[provider] === undefined) return null
      return h(UsageCreditsBadge, { provider, zh })
    }
    // <<< usage-panel parts <<<

    // ---- 注册 ----

    const inject = ['slots']

    /**
     * 注册进**设置侧栏**（`settings.section`），而不是「内置插件」分区里的一个标签页。
     *
     * 为什么换：那个分区归宿主自己的插件清单所有，第三方页面挤进去会让
     * 「内置插件」这个标题名不副实；而且用户要找一个能改配置的页面时，
     * 直觉是翻设置左侧的分区列表，不是先点进插件再找第二个标签。
     *
     * order = 1000 是这里唯一刻意的选择：这是外部插件贡献的分区，
     * 排在内置分区（账号 -10、通用 0、模型 10、内置插件 15、预设 20）之后，
     * 让它落在侧栏最下面，不改变用户对内置列表位置的既有印象。
     *
     * label 是 thunk：宿主的 `resolveSlotLabel` 会在分区账本或语言变化时重新求值，
     * 所以语言切换后侧栏文案跟着变。
     */
    function apply(ctx) {
      try {
        ensureCss()
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-agent-checkin',
          order: 1000,
          label: () => t('dsh-agent-checkin', 'dsh-agent-checkin'),
        }, CheckinHubSection))
      } catch (error) {
        // 设置分区没开出来不该影响签到本身（宿主半侧照常工作），但必须留下原因。
        // eslint-disable-next-line no-console
        console.error('[dsh-agent-checkin] settings section failed to register:', error)
      }

      // ---- 输入框：当前 provider 的积分余额 ----
      //
      // `conversation.input.left` 是输入框左侧的列表位。`dsh-connect-workbuddy`
      // 也占用这个 slot（order 4，只对自家 provider 渲染），本插件 order 5
      // 紧随其后，两者靠「只认自己认识的 provider」共存，不会同时出现两个徽标。
      try {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-agent-checkin-credits',
          order: 5,
          locale: 'dsh-agent-checkin',
        }, UsageCreditsGate))
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[dsh-agent-checkin] composer credits failed to register:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
