/**
 * 宿主私有依赖的生产路径加载器。
 *
 * `@deepseek-ai/dsh-llm-pi-ai`、`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`
 * 只存在于宿主 app.asar 内（经 peerDependencies 声明解析），单跑 node 时
 * `require.resolve`/`import` 一律 MODULE_NOT_FOUND。所以：
 *
 *   - 本模块只在插件运行于宿主内、且用户打开了对应平台开关时才会被
 *     **动态** import——静态 import 它会让 `lib/index.js` 在单测里直接炸掉；
 *   - 单测永远不走这里，而是把 mock 直接喂给 `createShimAdapter` 的 `deps`。
 *
 * @module dsh-agent-checkin/connect/pi-deps
 */

/**
 * 动态装载 pi-ai 依赖族。
 *
 * @returns {Promise<{ PiAiAdapter, createProvider, openAICompletionsApi, resolveRetryPolicy, resolveImageAttachmentAccess? }>}
 * @throws 宿主缺任一键模块时抛错（调用方 catch 后软失败，不注册该平台）
 */
export async function loadPiDeps() {
  const [piAdapterMod, piAiMod, apiMod, llmMod] = await Promise.all([
    import('@deepseek-ai/dsh-llm-pi-ai'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    // dsh-llm 提供 retryPolicy 与 resolveImageAttachmentAccess（图片附件 ->
    // 执行世界只读路径的标准解析器），缺了不致命：对应字段为 undefined，
    // adapter 侧逐项判空（见 baseadapter.hostAttachmentResolvers）。
    import('@deepseek-ai/dsh-llm').catch(() => undefined),
  ])
  if (typeof piAdapterMod?.PiAiAdapter !== 'function') {
    throw new Error('@deepseek-ai/dsh-llm-pi-ai 未导出 PiAiAdapter')
  }
  if (typeof piAiMod?.createProvider !== 'function') {
    throw new Error('@earendil-works/pi-ai 未导出 createProvider')
  }
  if (typeof apiMod?.openAICompletionsApi !== 'function') {
    throw new Error('@earendil-works/pi-ai/api/openai-completions.lazy 未导出 openAICompletionsApi')
  }
  return {
    PiAiAdapter: piAdapterMod.PiAiAdapter,
    createProvider: piAiMod.createProvider,
    openAICompletionsApi: apiMod.openAICompletionsApi,
    resolveRetryPolicy: llmMod?.resolveRetryPolicy,
    resolveImageAttachmentAccess: llmMod?.resolveImageAttachmentAccess,
  }
}

/**
 * 本插件在宿主里的 settings 命名空间。
 *
 * 惯例抄自 dsh-connect-trae 的 `settingsNamespaceOf`：优先取 Loader 条目 id
 * （即 `ctx.fiber.entry?.options.id`），取不到退回插件名。注册
 * `registerConfigurableProviders` 时 `settingsNs` 必填非空，缺了宿主
 * `undefined.length` 直接 TypeError。
 */
export function settingsNamespaceOf(ctx) {
  return ctx?.fiber?.entry?.options?.id ?? 'dsh-agent-checkin'
}
