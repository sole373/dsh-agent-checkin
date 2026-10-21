/**
 * 看板「模型接入」页的 HTML 渲染 + 表单读取。
 *
 * 这一页回答用户的两个问题：「哪些平台的模型出现在 DSH 模型选择器里」和
 * 「每个平台里显示哪几个模型」。它刻意做成看板的一个附属页（不是新的客户端
 * UI 包），原因记录在交付说明里：设置页依赖的客户端 UI 包在当前宿主上未启用，
 * 而看板页面不依赖任何宿主客户端包。
 *
 * 诚实性纪律（与 dashboard.js 同源，全部落在可见文字上）：
 *   1. 生效范围说清楚：已接入的平台，保存后**立即生效**（不需要重启宿主）；
 *      未接入的平台（本机没有登录态/客户端未装），勾了也不会出现——它们需要
 *      先在客户端登录、再重启宿主完成注册，页面原文写出。
 *   2. 模型清单的来源说清楚：来自本机客户端的目录缓存（每 30 分钟自动刷新），
 *      上游删掉的模型不会继续被勾选。
 *   3. 选择只存在本机（`<dshHome>/dsh-agent-checkin/model-selection.json`），不回写
 *      任何平台客户端，不迁移任何账号状态。
 *   4. 机械断言：所有动态文本都经 `escapeHtml`；value 属性一并转义。
 *
 * @module dsh-agent-checkin/models-page
 */

import { escapeHtml } from './dashboard.js'

const STYLE = `
*{box-sizing:border-box}
:root{color-scheme:light dark;--fg:#1a1a1a;--dim:#666;--bg:#fafafa;--card:#fff;--line:#e3e3e3;
--ok:#0a7d32;--okbg:#e8f5ec;--warn:#8a5a00;--warnbg:#fff4e0;--bad:#a11;--badbg:#fdeaea;--idle:#555;--idlebg:#eee}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--dim:#9a9a9a;--bg:#161616;--card:#1f1f1f;--line:#333;
--ok:#5fd08a;--okbg:#12331e;--warn:#e8b45c;--warnbg:#33280f;--bad:#ff8a8a;--badbg:#3a1717;--idle:#bbb;--idlebg:#2a2a2a}}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:900px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 12px}
.sub{color:var(--dim);font-size:13px;margin:0 0 24px}
.banner{padding:10px 14px;border-radius:8px;margin:0 0 12px;font-size:14px;border:1px solid var(--line);
background:var(--idlebg);color:var(--idle)}
.banner b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.card h2{margin:0 0 8px;display:flex;align-items:center;gap:10px}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}
.chip.warn{background:var(--warnbg);color:var(--warn)}
.chip.idle{background:var(--idlebg);color:var(--idle)}
.switch{display:flex;align-items:center;gap:8px;font-size:14px;margin:6px 0 10px;cursor:pointer}
.models{border-left:3px solid var(--line);padding:2px 0 2px 14px;margin:6px 0 0 10px}
.models.off{opacity:.55}
.mdl{display:flex;align-items:baseline;gap:8px;padding:3px 0;cursor:pointer;font-size:14px}
.mdlrow{display:flex;align-items:baseline;gap:10px}
.mdlrow .mdl{flex:1;min-width:0}
.img{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dim);white-space:nowrap;cursor:pointer}
.img img,.img .glyph{opacity:.75}
.imgbar{display:flex;align-items:center;gap:10px;margin:2px 0 6px;font-size:13.5px}
.imgbar .all{margin:0}
.rate{margin-left:auto;padding-left:10px;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.all{display:flex;align-items:center;gap:8px;padding:4px 0;margin:0 0 4px;font-size:13.5px;cursor:pointer;
color:var(--fg);font-weight:550}
input[type=checkbox]{width:16px;height:16px;accent-color:var(--ok)}
code{background:var(--idlebg);padding:1px 5px;border-radius:4px;font-size:12px}
.note{font-size:12.5px;color:var(--dim);margin:8px 0 0;line-height:1.7}
.savebar{display:flex;align-items:center;gap:14px;margin:20px 0}
button{font:inherit;font-weight:600;padding:8px 22px;border-radius:8px;border:1px solid var(--ok);
background:var(--okbg);color:var(--ok);cursor:pointer}
footer{margin-top:32px;font-size:12px;color:var(--dim);line-height:1.8}
a{color:inherit}
.empty{padding:36px 20px;text-align:center;color:var(--dim)}
`

/** 单个 provider 的卡片（勾选项的 checked 状态只反映当前存储，不猜测浏览器状态）。 */
function renderProviderCard(row) {
  const pid = escapeHtml(row.id)
  const attached = row.attached === true
  const chip = attached
    ? '<span class="chip ok">已接入</span>'
    : `<span class="chip ${row.statusKind === 'failed' ? 'warn' : 'idle'}">${escapeHtml(row.statusText ?? '未接入')}</span>`
  const enabledBox =
    `<label class="switch"><input type="checkbox" name="enabled:${pid}"${row.enabled ? ' checked' : ''}>`
    + `在 DSH 模型选择器里显示该平台</label>`

  let modelsBlock
  if (!attached) {
    modelsBlock = `<p class="note">${escapeHtml(row.statusText ?? '该平台尚未注册到宿主。')}
      先在本机客户端登录，然后重启宿主完成一次注册，这里就会出现它的模型清单。</p>`
  } else if (!Array.isArray(row.models) || row.models.length === 0) {
    modelsBlock = '<p class="note">当前没有可展示的模型（清单为空或暂时读取失败，30 分钟内会自动重试）。</p>'
  } else {
    const allChecked = row.modelIds === null
    const picked = Array.isArray(row.modelIds) ? new Set(row.modelIds) : null
    // 图片三态：`imageIds === null` = 跟随模型原生能力（默认）；数组 = 白名单
    // （空数组就是「全部禁止图片」）。它与模型白名单是两条独立的清单——
    // 关掉平台的模型可见性不该把图片勾选一起清掉。
    const imageAuto = !Array.isArray(row.imageIds)
    const imagePicked = Array.isArray(row.imageIds) ? new Set(row.imageIds) : null
    const items = row.models
      .map((model) => {
        const id = escapeHtml(model.id)
        const checked = allChecked || picked?.has(model.id) ? ' checked' : ''
        const native = model.nativeImage === true
        const imageOn = imagePicked === null ? native : imagePicked.has(model.id)
        // 倍率同样只取客户端自己给的数：没这个字段就整段不渲染。
        const rate = typeof model.multiplier === 'number' && Number.isFinite(model.multiplier) && model.multiplier >= 0
          ? `<span class="rate">${model.multiplier === 0 ? '（免费）' : `（${model.multiplier.toFixed(2)}x）`}</span>`
          : ''
        // tooltip 按「原生声明」分两档：说的是事实，不是猜测。目录/厂商表没标
        // 多模态的模型也允许手动勾上（上游能力以实测为准，字段不该挡住用户），
        // 但要把「这是你手动打开的」说清楚。
        const hint = native
          ? '客户端目录声明这个模型支持图片输入'
          : '客户端目录没有声明这个模型支持图片；勾上会对上游按「能收图片」发出请求（以上游实测为准）'
        return `<div class="mdlrow"><label class="mdl"><input type="checkbox" name="model:${pid}" value="${id}"${checked}>`
          + `${escapeHtml(model.name)} <code>${id}</code>${rate}</label>`
          + `<label class="img" title="${escapeHtml(hint)}"><input type="checkbox" name="image:${pid}" value="${id}"${imageOn ? ' checked' : ''}>图片</label></div>`
      })
      .join('')
    modelsBlock =
      // 隐藏标记：老页面没有这组字段，服务端据此判断「这次表单带没带图片选择」，
      // 没带就保持磁盘上的现值，不会被一次表单提交悄悄清成「全部禁止」。
      `<input type="hidden" name="imagesset:${pid}" value="1">`
      + `<div class="models${row.enabled ? '' : ' off'}">`
      + `<label class="all"><input type="checkbox" name="all:${pid}"${allChecked ? ' checked' : ''}>`
      + `全选（跟随客户端清单自动增减）</label>`
      + `<label class="all"><input type="checkbox" name="imageauto:${pid}"${imageAuto ? ' checked' : ''}>`
      + `图片输入：跟随模型原生能力（勾上时下面的「图片」只是展示，改动请先取消这里）</label>`
      + `${items}</div>`
      + '<p class="note">勾着「全选」时以全选为准；要排除个别模型，先取消「全选」再逐个勾。</p>'
      + '<p class="note">「图片」是每个模型独立的开关：勾上 = 告诉宿主这个模型能读图，带图消息才会路由给它。'
      + '默认跟随客户端目录的原生声明；目录没声明的模型也可以手动勾上，但能不能读图最终以上游为准。</p>'
      + (row.enabled ? '' : '<p class="note">该平台当前未启用——勾选上方「显示该平台」保存后，所选模型才会出现。</p>')
  }

  return `<section class="card"><h2>${escapeHtml(row.label)} ${chip}<code>${pid}</code></h2>
    ${enabledBox}
    ${modelsBlock}
  </section>`
}

/**
 * 渲染整个「模型接入」页。
 *
 * @param {object} options
 * @param {string} options.prefix 看板路由前缀（如 /dsh-agent-checkin）
 * @param {Array<{id:string, label?:string, platform?:string, attached?:boolean,
 *   enabled?:boolean, modelIds?:string[]|null, models?:Array<{id:string,name:string}>,
 *   statusKind?:string, statusText?:string}>} options.rows 服务端合成的行
 * @param {string[]} [options.changedIds] 刚保存过的 provider id（页面顶部提示）
 * @returns {string} 完整 HTML
 */
export function renderModelsPage({ prefix, rows, changedIds }) {
  const safeRows = Array.isArray(rows) ? rows : []
  const byPlatform = new Map()
  for (const row of safeRows) {
    const platform = row.platform || row.id
    if (!byPlatform.has(platform)) byPlatform.set(platform, [])
    byPlatform.get(platform).push(row)
  }
  const cards = safeRows.length
    ? [...byPlatform.entries()]
        .map(([platform, list]) =>
          `<div class="card" style="margin-bottom:0;padding-bottom:6px"><h2>${escapeHtml(platform)}</h2></div>`
          + list.map(renderProviderCard).join(''))
        .join('')
    : '<div class="empty"><b>没有可选的平台。</b></div>'

  const changed =
    Array.isArray(changedIds) && changedIds.length > 0
      ? `<div class="banner"><b>已保存，立即生效：</b>${escapedList(changedIds)}</div>`
      : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>模型接入 · dsh-agent-checkin</title>
<style>${STYLE}</style>
</head>
<body><main>
  <h1>模型接入</h1>
  <p class="sub">选择哪些平台的模型出现在 DSH 对话窗的模型选择器里，以及每个平台显示哪些模型。
    ⋅ <a href="${escapeHtml(prefix ?? '/')}">« 返回签到看板</a></p>
  <div class="banner"><b>生效规则：</b>「已接入」的平台，开关与勾选保存后<b>立即生效，不需要重启宿主</b>；
    「未接入」的平台需要先在本机客户端登录、再重启宿主完成注册。
    模型清单来自客户端本地目录缓存（每 30 分钟自动刷新），每次保存都会按最新清单求交。</div>
  ${changed}
  <form method="post" action="${escapeHtml((prefix ?? '') + '/models/save')}">
    ${cards}
    <div class="savebar">
      <button type="submit">保存</button>
      <span class="note" style="margin:0">保存立即生效；选择只保存在本机
        <code>~/.dsh/dsh-agent-checkin/model-selection.json</code>，不回写任何客户端。</span>
    </div>
  </form>
  <footer>
    本页只在本机回环地址上提供，非本机来源一律拒绝。<br>
    未勾选的模型不会出现在模型选择器；已开始对话不受影响，下一次选择生效。<br>
    <a href="${escapeHtml((prefix ?? '') + '/status')}">查看签到状态 JSON</a>
  </footer>
</main></body>
</html>`
}

/** changedIds 的转义列举（renderModelsPage 内部复用）。 */
function escapedList(ids) {
  return ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('、')
}

/**
 * 读一个表单 POST 的请求体并解析为 {@link URLSearchParams}。
 *
 * 与 settings-routes 的 readJsonBody 同一条纪律：限制大小（64 KiB，按配置表单的
 * 合理上限）、拒绝错误的内容类型，不无限缓冲。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<{ok: true, params: URLSearchParams} | {ok: false, reason: string}>}
 */
export function readFormBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    const type = String(req.headers?.['content-type'] ?? '')
    const mime = type.split(';')[0].trim().toLowerCase()
    if (mime !== 'application/x-www-form-urlencoded') {
      resolve({ ok: false, reason: `表单只接受 application/x-www-form-urlencoded（收到：${type || '未携带'}）` })
      return
    }
    let size = 0
    const chunks = []
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        done({ ok: false, reason: `表单超过 ${maxBytes} 字节上限` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        done({ ok: true, params: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) })
      } catch (error) {
        done({ ok: false, reason: `表单解析失败：${error?.message ?? error}` })
      }
    })
    req.on('error', (error) => {
      done({ ok: false, reason: `表单读取失败：${error?.message ?? error}` })
    })
  })
}
