/**
 * 看板页面的 HTML 渲染。
 *
 * 单独成模块的理由：它是一大坨字符串拼接，混进 `index.js` 会淹没装配逻辑；更重要的
 * 是这些字符串**能脱离宿主单独测试**——页面里每一条诚实性纪律都可以用断言钉住，
 * 写在 `index.js` 里就只能靠人眼看。
 *
 * 六条纪律（全部以「可见文字」的形式落在页面上，而不是藏在注释里）：
 *   1. 默认只读：allowClaim 关闭时页面顶部必须有明确提示，且不得出现「已领取」字样。
 *   2. 数据来源标签：每个数字都标清是实时拉的、盘上读回的、还是压根没有。
 *   3. 不跨平台求和：页面**不出现**任何总额数字，附一句说明为什么。
 *   4. 状态可降级：没有结果、读取失败、全部跳过，都有各自的独立呈现，不硬凑成一张表。
 *   5. READONLY 不进成功：`claiming === false` 的平台单独分组，不混进成功计数。
 *   6. 机械断言：所有来自平台的数据都经 `escapeHtml`，余额为 null 就不显示数字。
 *
 * @module dsh-agent-checkin/dashboard
 */

/** HTML 转义：平台返回的 detail 是不可信输入，直接拼进页面会变成注入点。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const BUCKET_CLASS = Object.freeze({
  success: 'ok',
  neutral: 'idle',
  blocked: 'warn',
  failure: 'bad',
  unknown: 'idle',
})

/**
 * 分组：真实领取平台 vs 只读平台。
 *
 * 这两组必须分开显示。混在一张表里，读者会自然地以为「只读核对成功」也是签到成功，
 * 于是成功数被虚增，而相应平台其实根本没有可调用的领取接口。
 */
function groupRows(rows) {
  const claiming = []
  const readonly = []
  for (const row of rows) (row.claiming ? claiming : readonly).push(row)
  return { claiming, readonly }
}

function renderBalance(row) {
  // 余额未知就不显示数字，也不显示 0——0 是一个具体读数，未知不是。
  if (row.balance === null || row.balance === undefined) {
    return '<span class="bal none" title="本次未取到余额">—</span>'
  }
  const unit = row.unit ? escapeHtml(row.unit) : ''
  return `<span class="bal">${escapeHtml(row.balance)}<small>${unit}</small></span>`
}

function renderRow(row) {
  const cls = BUCKET_CLASS[row.bucket] ?? 'idle'
  const detail = row.detail
    ? `<div class="detail">${escapeHtml(row.detail)}</div>`
    : ''
  return `<tr>
      <td class="name">${escapeHtml(row.name)}</td>
      <td><span class="chip ${cls}">${escapeHtml(row.codeLabel)}</span></td>
      <td class="right">${renderBalance(row)}</td>
    </tr>${detail ? `<tr class="detail-row"><td colspan="3">${detail}</td></tr>` : ''}`
}

/** 头部：本轮到底是什么性质的一次运行。 */
function renderHeadline(run, meta) {
  const parts = []
  if (run.allSkipped) {
    parts.push(
      '<div class="banner idle">今天所有指定平台都已经成功领取过，本轮没有发起任何请求。'
        + '这是幂等保护，不是失败。</div>',
    )
  } else if (run.claimed) {
    parts.push('<div class="banner ok">本轮为真实领取</div>')
  } else {
    parts.push(
      '<div class="banner idle">本轮为只读核对，<b>没有领取任何积分</b>。</div>',
    )
  }
  if (run.downgraded) {
    parts.push(
      '<div class="banner warn">配置未开启 <code>allowClaim</code>，'
        + '本轮已降级为只读核对，未实际领取。</div>',
    )
  }
  if (!meta.allowClaim && !run.downgraded && !run.dryRun) {
    // 理论上 downgraded 会覆盖这种情况；两条都写是为了「改了一处忘了另一处」时仍不误导。
    parts.push(
      '<div class="banner warn"><code>allowClaim</code> 当前关闭，'
        + '任何运行都会降级为只读核对。</div>',
    )
  }
  if (run.restored) {
    parts.push(
      `<div class="banner idle">📦 以下数据来自磁盘上的上一次运行`
        + `（${escapeHtml(run.finishedAt ?? '时间未知')}），不是本次新跑的。</div>`,
    )
  }
  return parts.join('\n')
}

function renderSummary(summary) {
  if (!summary) return ''
  const cells = [
    ['平台数', summary.total],
    ['成功', summary.success],
    ['中性', summary.neutral],
    ['失败', summary.failure],
  ]
  if (summary.blocked) cells.push(['环境受阻', summary.blocked])
  if (summary.unknown) cells.push(['未知', summary.unknown])
  const tiles = cells
    .map(
      ([label, value]) =>
        `<div class="tile"><span class="v">${escapeHtml(value)}</span>`
        + `<span class="k">${escapeHtml(label)}</span></div>`,
    )
    .join('')
  return `<section class="tiles">${tiles}</section>
    <p class="note">「成功」含真实领取与今日已领两种终态；
    其中<b>存在真实领取动作且成功</b>的是 ${escapeHtml(summary.healthy)} 个。
    各平台积分为不同币种，<b>页面刻意不做跨平台求和</b>。</p>`
}

function renderRiskNotes(rows, platformsById) {
  const items = rows
    .map((row) => [row, platformsById.get(row.id)])
    .filter(([, spec]) => spec?.note)
    .map(
      ([row, spec]) =>
        `<li><b>${escapeHtml(row.name)}</b>：${escapeHtml(spec.note)}</li>`,
    )
  if (items.length === 0) return ''
  return `<section class="panel"><h2>注意事项</h2><ul>${items.join('')}</ul></section>`
}

/**
 * 逐平台当前积分：与设置面板同一数据源（index.js describeBalances），
 * 优先级口径（实测优先 / 手动兜底 / 来源标签）已在服务端合成，这里照实渲染。
 *
 * - 来源三态标签：实测（引擎本轮读到的）/ 手动（用户填的，不是充值）/ —（两个都没有）。
 * - 手动条目附带 note（用户写的「含活动赠送」之类）。
 * - balances 为 null 时整节不渲染（服务端取数失败已在日志里说原因，
 *   看板其余部分照常显示，这正是「状态可降级」纪律）。
 */
function renderBalances(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return ''
  const rows = balances
    .map((b) => {
      const unit = b.unit ? ` <small>${escapeHtml(b.unit)}</small>` : ''
      let value
      let sourceChip
      let note = ''
      if (b.source === 'measured' && typeof b.balance === 'number') {
        value = `<span class="bal">${escapeHtml(b.balance)}${unit}</span>`
        sourceChip = '<span class="chip ok">实测</span>'
        if (b.measuredSource) note = `（来自字段 ${escapeHtml(b.measuredSource)}）`
      } else if (b.source === 'manual' && typeof b.balance === 'number') {
        value = `<span class="bal">${escapeHtml(b.balance)}${unit}</span>`
        sourceChip = '<span class="chip idle">手动</span>'
        if (b.note) note = `（${escapeHtml(b.note)}）`
      } else {
        value = '<span class="bal none" title="尚未实测，也没有手动值">—</span>'
        sourceChip = '<span class="chip idle">无数据</span>'
      }
      const kind = b.claiming ? '' : ' <span class="chip idle">只读</span>'
      return `<tr>
          <td class="name">${escapeHtml(b.name)}${kind}</td>
          <td class="right">${value}</td>
          <td>${sourceChip}${note ? ` <span class="note">${note}</span>` : ''}</td>
        </tr>`
    })
    .join('')
  return `<section class="panel"><h2>各平台当前积分</h2>
    <p class="note">实测值来自上一次签到运行读到的余额；标「手动」的是你在设置面板里填的数，
    只是你记录的数量，<b>不是充值</b>。各平台积分是不同币种，不做跨平台求和。</p>
    <table><thead><tr><th>平台</th><th class="right">当前积分</th><th>来源</th></tr></thead>
    <tbody>${rows}</tbody></table></section>`
}

function renderPlatformCatalog(platforms) {  const rows = platforms
    .map(
      (p) =>
        `<tr>
          <td class="name">${escapeHtml(p.name)}</td>
          <td><span class="chip ${p.claiming ? 'ok' : 'idle'}">`
        + `${p.claiming ? '可领取' : '只读'}</span></td>
          <td class="right">${escapeHtml(p.unit)}</td>
        </tr>`,
    )
    .join('')
  return `<section class="panel"><h2>支持平台</h2>
    <p class="note">「只读」表示该平台没有可调用的领取接口，
    跑一轮不会改变余额；它的结果不计入签到成功。</p>
    <table><thead><tr><th>平台</th><th>类型</th><th class="right">余额单位</th></tr></thead>
    <tbody>${rows}</tbody></table></section>`
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1a1a1a;--dim:#666;--bg:#fafafa;--card:#fff;--line:#e3e3e3;
--ok:#0a7d32;--okbg:#e8f5ec;--warn:#8a5a00;--warnbg:#fff4e0;--bad:#a11;--badbg:#fdeaea;--idle:#555;--idlebg:#eee}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--dim:#9a9a9a;--bg:#161616;--card:#1f1f1f;--line:#333;
--ok:#5fd08a;--okbg:#12331e;--warn:#e8b45c;--warnbg:#33280f;--bad:#ff8a8a;--badbg:#3a1717;--idle:#bbb;--idlebg:#2a2a2a}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:900px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 12px;color:var(--dim);font-weight:600;
letter-spacing:.04em;text-transform:uppercase}
.sub{color:var(--dim);font-size:13px;margin:0 0 24px}
.banner{padding:10px 14px;border-radius:8px;margin:0 0 10px;font-size:14px;border:1px solid transparent}
.banner.ok{background:var(--okbg);color:var(--ok);border-color:var(--ok)}
.banner.warn{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}
.banner.bad{background:var(--badbg);color:var(--bad);border-color:var(--bad)}
.banner.idle{background:var(--idlebg);color:var(--idle);border-color:var(--line)}
.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:12px 18px;min-width:88px;display:flex;flex-direction:column}
.tile .v{font-size:26px;font-weight:650;line-height:1.2}
.tile .k{font-size:12px;color:var(--dim)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px;margin:18px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;color:var(--dim);font-weight:600;padding:6px 8px;
border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.name{font-weight:550}
td.right,th.right{text-align:right}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}
.chip.warn{background:var(--warnbg);color:var(--warn)}
.chip.bad{background:var(--badbg);color:var(--bad)}
.chip.idle{background:var(--idlebg);color:var(--idle)}
.bal{font-variant-numeric:tabular-nums;font-weight:600}
.bal small{font-weight:400;color:var(--dim);margin-left:2px;font-size:11px}
.bal.none{color:var(--dim);font-weight:400}
.detail{font-size:12.5px;color:var(--dim);margin-top:4px;word-break:break-word}
tr.detail-row td{padding-top:0;border-bottom:1px solid var(--line)}
.note{font-size:12.5px;color:var(--dim);margin:12px 0 0;line-height:1.7}
ul{margin:0;padding-left:20px;font-size:13.5px}
li{margin:6px 0}
code{background:var(--idlebg);padding:1px 5px;border-radius:4px;font-size:12.5px}
.empty{padding:36px 20px;text-align:center;color:var(--dim)}
.empty b{color:var(--fg)}
footer{margin-top:32px;font-size:12px;color:var(--dim);line-height:1.8}
`

/**
 * 渲染整页。
 *
 * @param {object} options
 * @param {object|null} options.run         上一轮结果（可能是 null）
 * @param {object} options.meta             `describe()` 的结果（平台目录、allowClaim）
 * @param {string} [options.statusUrl]      前端轮询的 JSON 端点
 * @param {string} [options.modelsUrl]      模型接入页（平台开关 + 模型勾选）
 * @param {string} [options.error]          读取状态时的错误（有值时整页只报错）
 * @returns {string} 完整 HTML
 */
export function renderDashboard({ run, meta, statusUrl, modelsUrl, error, balances }) {
  const platforms = Array.isArray(meta?.platforms) ? meta.platforms : []
  const platformsById = new Map(platforms.map((p) => [p.id, p]))
  const allowClaim = meta?.allowClaim === true

  let body
  if (error) {
    // 降级成一句实话，而不是渲染一张空表让人以为「一个平台都没有」。
    body = `<div class="banner bad">读取签到状态失败：${escapeHtml(error)}</div>`
  } else if (!run) {
    body = `<div class="empty"><b>还没有跑过签到。</b><br>
      在 DSH 里发送 <code>/checkin</code>，或调用 <code>checkin_run</code> 工具。
      </div>`
  } else {
    const { claiming, readonly } = groupRows(run.rows ?? [])
    const mainTable = claiming.length
      ? `<section class="panel"><h2>签到结果</h2>
          <table><thead><tr><th>平台</th><th>状态</th><th class="right">余额</th></tr></thead>
          <tbody>${claiming.map(renderRow).join('')}</tbody></table></section>`
      : ''
    // 只读平台单独一节：它们没有领取动作，混进上表会被当成签到成功。
    const readOnlyTable = readonly.length
      ? `<section class="panel"><h2>只读平台（无领取动作）</h2>
          <p class="note">这些平台不存在可调用的领取接口，跑一轮不会改变余额；
          结果仅供参考，不计入签到成功。</p>
          <table><thead><tr><th>平台</th><th>状态</th><th class="right">余额</th></tr></thead>
          <tbody>${readonly.map(renderRow).join('')}</tbody></table></section>`
      : ''
    const skipped = Array.isArray(run.skipped) && run.skipped.length
      ? `<section class="panel"><h2>今天已领过、本轮跳过</h2>
          <p class="note">幂等保护：同一自然日内已成功领取的平台不再重复请求。
          确实要重跑，发送 <code>/checkin --force</code>。</p>
          <ul>${run.skipped
            .map((s) => `<li>${escapeHtml(s.name)}（${escapeHtml(s.code)}）</li>`)
            .join('')}</ul></section>`
      : ''
    body = [renderHeadline(run, meta), renderSummary(run.summary), mainTable, readOnlyTable, skipped]
      .filter(Boolean)
      .join('\n')
  }

  // 完成时间有两个来源：index.js 组装的 lastRun 用 finishedAt（插件自己记的收尾时刻），
  // 引擎原始结果用 generatedAt（桥接层生成 JSON 的时刻）。两者都认，避免任一方
  // 单独传入时页面显示空档——「完成时间：—」会让读者以为是刚跑完还没来得及记。
  const when = escapeHtml(run?.finishedAt || run?.generatedAt || '—')
  const source = run?.source ? escapeHtml(run.source) : '—'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-agent-checkin 看板</title>
<style>${STYLE}</style>
</head>
<body><main>
  <h1>dsh-agent-checkin</h1>
  <p class="sub">数据来源：${source} ｜ 完成时间：${when}
    ｜ allowClaim：<b>${allowClaim ? '已开启' : '已关闭（只读）'}</b>
    ${modelsUrl ? `｜ <a href="${escapeHtml(modelsUrl)}">模型接入（选平台 / 选模型）</a>` : ''}</p>
  ${body}
  ${renderBalances(balances)}
  ${renderRiskNotes(run?.rows ?? [], platformsById)}
  ${renderPlatformCatalog(platforms)}
  <footer>
    本页只在本机回环地址上提供，非本机来源一律拒绝。<br>
    各平台积分/credits 是不同币种，不做跨平台求和。<br>
    「只读」平台没有可调用的领取接口，其结果不计入签到成功。<br>
    <a href="${escapeHtml(statusUrl ?? '')}">查看原始 JSON</a>
    ${modelsUrl ? `｜ <a href="${escapeHtml(modelsUrl)}">模型接入（选平台 / 选模型）</a>` : ''}
  </footer>
</main></body>
</html>`
}
