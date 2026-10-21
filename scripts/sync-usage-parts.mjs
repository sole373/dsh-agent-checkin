/**
 * 把 lib/client-*.js 的片段同步进 lib/client.js 的标记区。
 *
 * 为什么要这一步：宿主的 client bundle 只认 package.json `exports` 里那一个
 * `./client` 入口，运行期不可能临时 require 另一个本地文件；而 client.js 本身
 * 只能 require `react` / `react/jsx-runtime`。所以新功能只能落进同一个 factory
 * 作用域——片段单独成文件（好读、好审、能 `node --check`），由这个脚本拼进去。
 *
 * 0.9.0 起，Token 用量那部分（面板、图表、能力排行、榜单页）已迁到独立插件
 * dsh-token-usage。本脚本现在只同步两样与本插件自身有关的片段：
 *   · client-usage-shared.js —— 语言判据与 provider 名字表（余额徽标要用）
 *   · client-credits.js     —— 输入框的余额徽标
 *
 * 样式不再由本脚本注入：签到设置页与徽标的 CSS 直接写在 client.js 主干里
 * （那段本来就不在标记区），用量页的 CSS 已随功能迁到新插件。
 *
 * 标记区里的内容一律视为生成物：改内容请改片段文件，然后重跑本脚本。
 * 不要手改标记区，否则下次同步会被覆盖（本脚本不会吞掉标记外的任何东西）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const CLIENT = join(LIB, 'client.js')
const PARTS = ['client-usage-shared.js', 'client-credits.js']

const CODE_BEGIN = '// >>> usage-panel parts（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>>'
const CODE_END = '// <<< usage-panel parts <<<'

/** 用起止标记替换老内容；标记缺失时直接报错，而不是猜位置。 */
function replaceBetween(source, begin, end, body) {
  const from = source.indexOf(begin)
  if (from < 0) throw new Error('start marker missing: ' + begin)
  const to = source.indexOf(end, from)
  if (to < 0) throw new Error('end marker missing: ' + end)
  return source.slice(0, from) + body + source.slice(to + end.length)
}

/**
 * 把片段插进去，顺带把缩进补齐。
 *
 * 片段文件是顶层代码（缩进从 0 开始，这样单独 `node --check` 才诚实）；
 * client.js 里它们位于 factory 内，需要右移。**只加前缀空格，不动行内内容**
 * ——任何改写都可能碰到字符串常量。
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.trim() === '' ? line : pad + line))
    .join('\n')
}

let source = readFileSync(CLIENT, 'utf8')

const code = PARTS.map((name) => {
  const body = indent(readFileSync(join(LIB, name), 'utf8').trimEnd(), 4)
  return '    // ---- ' + name + ' ----\n' + body
}).join('\n\n')
source = replaceBetween(source, CODE_BEGIN, CODE_END, CODE_BEGIN + '\n' + code + '\n    ' + CODE_END)

writeFileSync(CLIENT, source, 'utf8')
console.log('synced', PARTS.length, 'parts into client.js')
