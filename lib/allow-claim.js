/**
 * 开关「真实领取」：把 `allowClaim` 写回宿主 Loader。
 *
 * ## 为什么这件事能做成（推翻早期结论）
 *
 * 早期实现断言「拿不到写回 Loader 的句柄，配置对象是只读快照」，于是面板只能
 * 让用户自己去改 `cordis.patch.yml` 再重启。那个结论是错的。真实机制是：
 *
 *   1. 宿主有 `configEditor` 服务（`@deepseek-ai/dsh-config-editor`），它的
 *      `entries()` 返回**当前 profile patch 提供的全部条目**——包括本插件自己。
 *      `edit(entry, change)` 会加文件锁、校验、原子写、失败回滚，并调
 *      `reconcileProfilePatches` 让 Loader 重新对账。
 *
 *   2. `allowClaim` 在插件 Config 里声明了 `.volatile()`。Loader 的
 *      `_commitVolatile()` 对「只改了 volatile 字段」的配置变更走**热提交**：
 *      把新值写进运行中 fiber 的 volatile 引用，发 `loader/volatile-update`，
 *      **不 dispose、不重启插件**（见 `cordis-plugin-loader` 的 `update()`：
 *      `volatileOnly && this._commitVolatile()` 成立时 `pending` 为空，直接 return）。
 *
 *      判据在 `equalExceptVolatile(legacy.config, next, Config)`：递归比较时
 *      `schema?.meta?.volatile` 为真的字段一律视为相等。所以只翻 `allowClaim`
 *      一次对账就是「纯 volatile 变更」。
 *
 *   3. 插件的 `readConfig()` 每次调用都用 `value.get()` 现读 volatile 引用，
 *      所以热提交之后**下一次读就是新值**：面板立刻显示已开启，下一次签到
 *      真的会领取。整个过程不需要重载、不需要重启。
 *
 * ## 为什么没有「直接改文件」的退化路径
 *
 * 没有 configEditor 的旧宿主上，本可以自己 read → 改文本 → 原子写 profile patch。
 * 刻意不做：那条路没有 YAML 解析器可用来校验写出的结果（插件零第三方依赖），
 * 一旦把用户的 patch 写坏，下次启动整个 profile 都起不来。相比之下「让用户手改
 * 一行再重启」虽然笨，但失败面为零。宁可如实说改不动，也不拿用户的配置文件
 * 做没有校验的文本手术。
 *
 * @module dsh-agent-checkin/allow-claim
 */

/** 本插件在 profile patch 里的条目 id（与 index.js 的 `name` 一致）。 */
export const ENTRY_ID = 'dsh-agent-checkin'

/**
 * 在 Loader 条目列表里找本插件自己。
 *
 * 不能缓存：`entries()` 的成员是活对象，重新对账后可能被替换；`edit()` 也要求
 * 传进去的 entry 在写的那一刻仍然「是当前的」。所以每次现取。
 *
 * @param {object} editor 宿主 configEditor 服务
 * @returns {object|undefined} Loader 条目
 */
export function findOwnEntry(editor) {
  if (!editor || typeof editor.entries !== 'function') return undefined
  try {
    return [...editor.entries()].find((e) => e?.options?.id === ENTRY_ID)
  } catch {
    return undefined
  }
}

/**
 * 把 `allowClaim` 写成 `enabled`。
 *
 * 返回值区分三种结果，界面据此显示不同的话：
 *   · `changed: true`  —— 真的写进去了，且已热生效；
 *   · `changed: false` —— 本来就是那个值，什么都没做；
 *   · `ok: false`      —— 没写成功，`detail` 说明原因，**绝不假报成功**。
 *
 * @param {object} options
 * @param {object} options.editor 宿主 configEditor（缺失则走不可用分支）
 * @param {boolean} options.enabled 目标值
 * @param {boolean} options.current 当前生效值（用于「本来就是这个值」判定）
 * @param {object} options.logger
 * @returns {Promise<object>}
 */
export async function setAllowClaim({ editor, enabled, current, logger }) {
  if (current === enabled) {
    return { ok: true, changed: false, allowClaim: current, mode: 'noop', needsReload: false }
  }

  if (!editor || typeof editor.edit !== 'function') {
    return {
      ok: false,
      status: 'editor-unavailable',
      changed: false,
      allowClaim: current,
      detail:
        '这个宿主没有提供 configEditor 服务，插件无法写回自己的配置。'
        + `请手动把 profile 的 cordis.patch.yml 里本插件条目的 config.allowClaim 改成 ${enabled}，`
        + '然后重启 DSH。',
    }
  }

  const entry = findOwnEntry(editor)
  if (!entry) {
    return {
      ok: false,
      status: 'entry-missing',
      changed: false,
      allowClaim: current,
      detail:
        '没在 Loader 的配置条目里找到本插件（可能本插件不是由 profile patch 挂载的）。'
        + `请手动把 profile 的 cordis.patch.yml 里本插件条目的 config.allowClaim 改成 ${enabled}，`
        + '然后重启 DSH。',
    }
  }

  try {
    await editor.edit(entry, (raw) => ({ ...raw, allowClaim: enabled }))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger?.warn?.('通过 configEditor 写入 allowClaim 失败：%s', reason)
    return {
      ok: false,
      status: 'write-failed',
      changed: false,
      allowClaim: current,
      detail: `写入配置失败：${reason}。当前仍然是${current ? '已开启' : '只读核对'}状态。`,
    }
  }

  return {
    ok: true,
    changed: true,
    allowClaim: enabled,
    mode: 'config-editor',
    targetPath: editor.documentPath ?? null,
    // allowClaim 是 volatile 字段，Loader 走纯 volatile 热提交，插件没有被重启。
    needsReload: false,
  }
}
