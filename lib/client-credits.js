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
