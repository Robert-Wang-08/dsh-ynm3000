#!/usr/bin/env node
/**
 * probe/smoke-client.mjs — dsh-plugin-subagent-monitor 客户端门禁冒烟。
 *
 * 覆盖 .ptc/specs/subagent-monitor.spec.md：
 *   §0/§7 交付形状（classic script 解析、单一 __ModuleLoader__.load 注册、
 *          id 与 package.json 一致、结尾形状、require 白名单、node --check）
 *   §1     inject 清单（slots/sessions/jobs/remote/remote.session）
 *   §2     typeOfTool（精确表 → 启发式 → 去前缀截断 → ?，固定色表/调色板）
 *          、typeOfSelection、routeOfDispatchArgs、typeOfRoute、rowType（路由优先）、badgeTitle
 *   §3     parseDispatch（纯 JSON / 前缀 / 数组 / 嵌套 / 转义字符串 / renderer 文本）
 *   §4     formatAge、turnEnd、statusOf、keepaliveOf、关联置信度、buildRows
 *   §5     collectDelegations（含派发显式路由捕获、tool/ptc-dispatch 兼读）、
 *          宿主非正式面契约夹具（drift guard）、foldEntries、trimTail
 *   §6     panelPositionFor、resourceUrl、faceOf 降级与组件渲染
 *
 * 用法：node probe/smoke-client.mjs   （期望输出 ALL PASSED）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── §0/§7：交付形状 ───────────────────────────────────────────────── */

const LOAD_PREFIX = 'window.__ModuleLoader__.load({'

check('§0 classic-script parse（vm.Script）', (() => {
  try { new vm.Script(source, { filename: 'client.js' }); return true } catch (e) { console.error(e.message); return false }
})())
check('§0 存在 __ModuleLoader__.load 前缀', source.includes(LOAD_PREFIX))
check('§0 恰好 1 个 load 注册', [...source.matchAll(/__ModuleLoader__\.load\(/g)].length === 1)
check('§0 id 与 package.json 一致', source.includes(`id: ${JSON.stringify(pkg.name)}`))
check('§0 结尾形状（return module.exports; … });）', source.trimEnd().endsWith('});') && /return module\.exports;/.test(source))
check('§0 无 ESM import/export 语句', !/^\s*(import|export)\s/m.test(source))

const requires = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
check('§0 require 白名单 = react', requires.length > 0 && requires.every((r) => r === 'react'), requires.join(', '))

for (const file of ['client.js', 'index.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { cwd: root, stdio: 'pipe' })
    check(`§0 node --check ${file}`, true)
  } catch (e) {
    check(`§0 node --check ${file}`, false, String(e.stderr || e.message))
  }
}

/* ── 载入模块（假 window.__ModuleLoader__ + 假 react） ──────────────── */

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  Date, Math, String, Number, Object, Array, JSON, isFinite, encodeURIComponent,
}
vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

check('§0 load 捕获到注册', captured !== null && captured.id === pkg.name)

const hookIdentity = (fn) => fn
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (fn) => fn(),
  useEffect: hookIdentity,
  useRef: (init) => ({ current: init }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (init) => {
    const box = { value: typeof init === 'function' ? init() : init }
    const setter = (next) => { box.value = typeof next === 'function' ? next(box.value) : next }
    return [box.value, setter]
  },
}
const exports_ = captured.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require: ${name}`)
  return fakeReact
})

check('§1 inject 权限清单正确', JSON.stringify(exports_.inject) === JSON.stringify(['slots', 'sessions', 'jobs', 'uiWorkspace', 'remote', 'remote.session']))
check('§1 inject 含 uiWorkspace', exports_.inject.includes('uiWorkspace'))
check('§7 exports.apply / __test 就位', typeof exports_.apply === 'function' && exports_.__test !== undefined)

const T = exports_.__test
const {
  hash32, PALETTE, TYPE_COLORS, typeOfTool, typeOfSelection, colorForLabel,
  routeOfDispatchArgs, typeOfRoute, routeTarget, badgeTitle,
  parseDispatch, extractBalanced, decodeJsonEscapes,
  formatAge, turnEndLabel, turnEndStatus, statusOf, keepaliveOf, isActiveRow, modeLabel,
  formatTokens, tokensOfProjection, tokensLabel, isOneShotRow, rowFontSize, rowChip,
  persistKey, resolveStorage, snapshotRow, loadPersisted, savePersisted, restoreRow, mergePersisted, rowsSignature,
  PERSIST_VERSION, PERSIST_KEY_PREFIX, PERSIST_MAX_ROWS, PERSIST_MAX_TEXT,
  associateBackground, associateForeground,
  contentText, preview, collectDelegations, foldEntries, trimTail,
  buildRows, rowType, resourceModeOf, resourceUrl,
  panelPositionFor, windowSource, faceOf, UNAVAILABLE,
  EMPTY_WINDOW, EMPTY_JOBS, NO_OUTPUT_TEXT, DEFAULT_TOLERANCE_MS,
} = T

/* ── §2：工具名 → 类型短名 ─────────────────────────────────────────── */

check('§2 调色板 12 槽', PALETTE.length === 12)
check('§2 hash32 确定性 + 32 位', hash32('x') === hash32('x') && hash32('x') >>> 0 === hash32('x'))

const EXACT = {
  subagent_kimi_docs: ['Kimi', '#A7E0A9'],
  subagent_cursor_grok: ['Cursor', '#2F6FEB'],
  subagent_opencode_dsv41: ['DS4.1', '#8ECDF7'],
  subagent_opencode: ['OpenCode', '#7CB342'],
  subagent_codex_relay: ['Codex-Relay', '#2F6FEB'],
  subagent_codex: ['Codex', '#2E9E5B'],
  subagent_claude_code: ['ClaudeCode', colorForLabel('ClaudeCode')],
  subagent_claude_opus5_plan: ['Opus5', '#E0501E'],
  subagent_claude_opus48_plan: ['Opus48', '#C2410C'],
  subagent_fork: ['fork', '#8B5CF6'],
  subagent: ['spawn', '#8ECDF7'],
}
for (const [name, [label, color]] of Object.entries(EXACT)) {
  const got = typeOfTool(name)
  check(`§2 精确 ${name} → ${label}`, got.label === label, JSON.stringify(got))
  check(`§2 精确 ${name} 颜色`, got.color === color, `${got.color} vs ${color}`)
}
check('§2 固定色表含 10 项', Object.keys(TYPE_COLORS).length === 10)
check('§2 行徽标显式渲染类型名而非仅颜色', source.includes('data-subagent-type-name') && source.includes('TYPE_SWATCH_STYLE'))

check('§2 启发式 kimi（大小写不敏感）', typeOfTool('X_KIMI_extra').label === 'Kimi')
check('§2 启发式 cursor', typeOfTool('subagent_my_cursor_v2').label === 'Cursor')
check('§2 启发式 opencode', typeOfTool('foo-opencode-bar').label === 'OpenCode')
check('§2 启发式 codex', typeOfTool('codex_thing').label === 'Codex')
check('§2 启发式 claude', typeOfTool('claude_unknown').label === 'Claude')
check('§2 启发式 deepseek → DS4.1', typeOfTool('deepseek_agent').label === 'DS4.1')
check('§2 启发式 dsv41 → DS4.1', typeOfTool('dsv41_special').label === 'DS4.1')
check('§2 启发式 grok', typeOfTool('grok_fast').label === 'Grok')
check('§2 启发式顺序：dsv41 先于 opencode', typeOfTool('opencode_dsv41_thing').label === 'DS4.1')
check('§2 modelSelection 降级：Codex', typeOfSelection({ lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol' } }).label === 'Codex')
check('§2 modelSelection 降级：Codex-Relay', typeOfSelection({ lastUsed: { provider: 'codex-relay', model: 'gpt-5.6-sol' } }).label === 'Codex-Relay')
check('§2 modelSelection 降级：DS4.1', typeOfSelection({ lastUsed: { provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash' } }).label === 'DS4.1')
check('§2 modelSelection 降级：Opus48', typeOfSelection({ lastUsed: { provider: 'anthropic-relay', model: 'claude-opus-4.8' } }).label === 'Opus48')
check('§2 modelSelection 未知返回 null', typeOfSelection({ lastUsed: { provider: 'unknown', model: 'm' } }) === null)

check('§2 兜底去前缀截断 10', typeOfTool('subagent_custom_thing_name').label === 'custom_thi')
check('§2 兜底无前缀', typeOfTool('weirdname').label === 'weirdname')
check('§2 兜底空 → ?', typeOfTool('').label === '?' && typeOfTool('subagent_').label === '?')
check('§2 非串 → spawn? 否：空名', typeOfTool(42).label === '?' && typeOfTool(null).label === '?')
check('§2 未知类型色走调色板', PALETTE.includes(typeOfTool('subagent_custom_thing_name').color))

/* ── §3：结果解析 ──────────────────────────────────────────────────── */

check('§3 纯 JSON 对象', (() => { const r = parseDispatch('{"kind":"background","jobId":"subagent-14"}'); return r && r.kind === 'background' && r.jobId === 'subagent-14' })())
check('§3 带前缀', (() => { const r = parseDispatch('WI-1 dispatched: {"kind":"background","jobId":"subagent-1"}'); return r && r.jobId === 'subagent-1' })())
check('§3 JSON 数组取首个', (() => { const r = parseDispatch('[{"kind":"background","jobId":"subagent-5"},{"kind":"continuable","subagentId":"child-9"}]'); return r && r.kind === 'background' && r.jobId === 'subagent-5' })())
check('§3 嵌套对象', (() => { const r = parseDispatch('{"amended":"x","dispatched":{"kind":"background","jobId":"subagent-7"}}'); return r && r.jobId === 'subagent-7' })())
check('§3 转义字符串', (() => { const r = parseDispatch('"{\\"kind\\":\\"background\\",\\"jobId\\":\\"subagent-3\\"}"'); return r && r.jobId === 'subagent-3' })())
check('§3 continuable', (() => { const r = parseDispatch('{"kind":"continuable","subagentId":"child-2"}'); return r && r.kind === 'continuable' && r.subagentId === 'child-2' })())
check('§3 foreground', (() => { const r = parseDispatch('{"kind":"foreground","runId":"run-8"}'); return r && r.kind === 'foreground' && r.runId === 'run-8' })())
check('§3 renderer 后台文本', (() => { const r = parseDispatch('started background subagent job subagent-42'); return r && r.kind === 'background' && r.jobId === 'subagent-42' })())
check('§3 renderer 续接文本', (() => { const r = parseDispatch('started subagent child-77'); return r && r.kind === 'continuable' && r.subagentId === 'child-77' })())
check('§3 无 JSON → null', parseDispatch('one-shot output only, nothing else') === null)
check('§3 空/非串 → null', parseDispatch('') === null && parseDispatch(null) === null && parseDispatch(123) === null)
check('§3 extractBalanced 尊重字符串', extractBalanced('a {"k":"}"} b') === '{"k":"}"}')
check('§3 decodeJsonEscapes', decodeJsonEscapes('{\\"a\\":1,\\n}') === '{"a":1,\n}')

/* ── §4：时间与状态 ────────────────────────────────────────────────── */

check('§4 formatAge 秒', formatAge(0) === '0 秒' && formatAge(45000) === '45 秒')
check('§4 formatAge 分钟', formatAge(90000) === '2 分钟')
check('§4 formatAge 小时', formatAge(3600000) === '1 小时')
check('§4 formatAge 小时+分钟', formatAge(5400000) === '1 小时 30 分钟')
check('§4 formatAge 负/NaN', formatAge(-5) === '0 秒' && formatAge(NaN) === '0 秒')
check('§4 turnEndLabel', turnEndLabel('completed') === '本轮完成' && turnEndLabel('nope') === '本轮结束')
check('§4 turnEndStatus 映射', turnEndStatus('completed').text === '已完成' && turnEndStatus('aborted').text === '已停止' && turnEndStatus('error').text === '已失败')
check('§4 modeLabel', modeLabel('background') === '后台' && modeLabel('continuable') === '续接' && modeLabel('foreground') === '前台')

const jobRow = (job, observed) => ({ kind: 'job', job, observed: observed || null, child: null })
check('§4 statusOf job running', statusOf(jobRow({ status: 'running' })).text === '运行中')
check('§4 statusOf job completed', statusOf(jobRow({ status: 'completed' })).text === '已完成')
check('§4 statusOf job failed', statusOf(jobRow({ status: 'failed' })).text === '已失败')
check('§4 statusOf child running', statusOf({ kind: 'child', job: null, child: { running: true } }).text === '运行中')
check('§4 statusOf child turn-end', statusOf({ kind: 'child', job: null, child: { running: false }, turnEndKind: 'aborted' }).text === '已停止')
check('§4 statusOf delegation', statusOf({ kind: 'delegation', job: null, child: null, delegation: {} }).text === '已派发')
check('§4 isActiveRow', isActiveRow(jobRow({ status: 'running' })) === true && isActiveRow(jobRow({ status: 'completed' })) === false)

const NOW = 1000000
check('§4 keepalive job 流式', keepaliveOf(jobRow({ status: 'running', startedAt: NOW - 10000 }, { streaming: true }), NOW) === '活跃 · 已运行 10 秒')
check('§4 keepalive job progress', keepaliveOf(jobRow({ status: 'running', startedAt: NOW - 10000, progress: '3/10' }), NOW) === '3/10')
check('§4 keepalive job 已运行', keepaliveOf(jobRow({ status: 'running', startedAt: NOW - 5000 }), NOW) === '已运行 5 秒')
check('§4 keepalive job detail', keepaliveOf(jobRow({ status: 'completed', startedAt: NOW - 9000, finishedAt: NOW, detail: 'exit code: 0' }), NOW) === 'exit code: 0')
check('§4 keepalive child 静默（UI 推断）', (() => {
  const text = keepaliveOf({ kind: 'child', job: null, child: { running: true, updatedAt: NOW - 200000 }, timing: null }, NOW)
  return text.indexOf('运行中 · 已静默 ') === 0 && text.includes('非 ACP 真实心跳')
})())
check('§4 keepalive child 本轮', keepaliveOf({ kind: 'child', job: null, child: { running: true, updatedAt: NOW }, timing: { active: { since: NOW - 30000, through: NOW } } }, NOW) === '本轮已运行 30 秒')
check('§4 keepalive child 结算', keepaliveOf({ kind: 'child', job: null, child: { running: false, updatedAt: NOW }, timing: { settledMs: 120000 } }, NOW) === '已结算 2 分钟')
check('§4 keepalive child 最近活动', keepaliveOf({ kind: 'child', job: null, child: { running: false, updatedAt: NOW - 7000 } }, NOW) === '最近活动 7 秒前')

/* ── §4：关联置信度 ────────────────────────────────────────────────── */

const bgJob = { label: 'docs', startedAt: NOW }
check('§4 background 唯一 → exact', associateBackground(bgJob, [{ id: 'c1', label: 'docs', createdAt: NOW + 2000 }]).confidence === 'exact')
check('§4 background 取时间差最小', associateBackground(bgJob, [
  { id: 'far', label: 'docs', createdAt: NOW + 20000 },
  { id: 'near', label: 'docs', createdAt: NOW + 1000 },
]).childId === 'near')
check('§4 background 同等候选 → ambiguous（不猜）', associateBackground(bgJob, [
  { id: 'a', label: 'docs', createdAt: NOW + 1000 },
  { id: 'b', label: 'docs', createdAt: NOW + 1000 },
]).confidence === 'ambiguous')
check('§4 background label 不符 → none', associateBackground(bgJob, [{ id: 'c1', label: 'other', createdAt: NOW + 1000 }]).confidence === 'none')
check('§4 background 超出容忍窗 → none', associateBackground(bgJob, [{ id: 'c1', label: 'docs', createdAt: NOW - DEFAULT_TOLERANCE_MS - 1 }]).confidence === 'none')
check('§4 foreground 唯一窗口 → exact-by-unique-window', associateForeground({ label: 'docs', startedAt: NOW }, [{ id: 'c1', label: 'docs', createdAt: NOW + 1000 }]).confidence === 'exact-by-unique-window')
check('§4 foreground 多候选 → ambiguous', associateForeground({ label: 'docs', startedAt: NOW }, [
  { id: 'a', label: 'docs', createdAt: NOW + 1000 },
  { id: 'b', label: 'docs', createdAt: NOW + 2000 },
]).confidence === 'ambiguous')

/* ── §4：buildRows 合并 ────────────────────────────────────────────── */

const childEntry = (id, label, createdAt, mode) => ({ id, label, createdAt, mode: mode || 'continuable' })

const rowsChildOnly = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW)],
  jobs: [],
  delegations: [],
  now: NOW,
})
check('§4 buildRows 仅子会话 → 1 行 unmatched', rowsChildOnly.length === 1 && rowsChildOnly[0].kind === 'child' && rowsChildOnly[0].confidence === 'unmatched')

const rowsProjectedType = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW)],
  jobs: [],
  delegations: [],
  modelSelectionOf: () => ({ lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol' } }),
  now: NOW,
})
check('§4 buildRows 持久化模型选择回填类型', rowsProjectedType[0].modelSelection.lastUsed.provider === 'openai-codex' && rowType(rowsProjectedType[0]).label === 'Codex')

const rowsContinuable = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW)],
  jobs: [],
  delegations: [{ callId: 'x', name: 'subagent_kimi_docs', startedAt: NOW, resultText: '{"kind":"continuable","subagentId":"c1"}' }],
  now: NOW,
})
check('§4 buildRows continuable → exact + 工具名', rowsContinuable.length === 1 && rowsContinuable[0].confidence === 'exact' && rowsContinuable[0].toolName === 'subagent_kimi_docs' && rowsContinuable[0].mode === 'continuable')

const rowsRouted = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW)],
  jobs: [],
  delegations: [{
    callId: 'r', name: 'subagent_kimi_docs', startedAt: NOW,
    route: { provider: 'codex-relay', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    resultText: '{"kind":"continuable","subagentId":"c1"}',
  }],
  now: NOW,
})
check('§4 buildRows 派发路由传播到行并盖过工具名标签', (() => {
  if (rowsRouted.length !== 1 || rowsRouted[0].route === null) return false
  const t = rowType(rowsRouted[0])
  return rowsRouted[0].route.provider === 'codex-relay' && t.label === 'Codex-Relay' && t.driver === 'Kimi' && t.via === 'route'
})(), JSON.stringify(rowsRouted[0] && rowsRouted[0].route))

const rowsBg = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW + 1000, 'one-shot')],
  jobs: [{ id: 'subagent-1', kind: 'subagent', label: 'docs', status: 'completed', startedAt: NOW, output: { total: 0, earliest: 0 } }],
  delegations: [{ callId: 'x', name: 'subagent_cursor_grok', startedAt: NOW, resultText: '{"kind":"background","jobId":"subagent-1"}' }],
  now: NOW,
})
check('§4 buildRows 后台 job+child 合并为 1 行', rowsBg.length === 1 && rowsBg[0].kind === 'job' && rowsBg[0].jobId === 'subagent-1', JSON.stringify(rowsBg.map((r) => r.key)))
check('§4 buildRows 合并行带 child 且 exact', rowsBg[0].linkedChildId === 'c1' && rowsBg[0].childId === 'c1' && rowsBg[0].key === 'child:c1' && rowsBg[0].confidence === 'exact' && rowsBg[0].toolName === 'subagent_cursor_grok')

const rowsOneToOne = buildRows({
  sessionId: 's1',
  children: [childEntry('only', 'docs', NOW + 1000, 'one-shot')],
  jobs: [
    { id: 'j1', kind: 'subagent', label: 'docs', status: 'running', startedAt: NOW, output: { total: 0, earliest: 0 } },
    { id: 'j2', kind: 'subagent', label: 'docs', status: 'running', startedAt: NOW + 100, output: { total: 0, earliest: 0 } },
  ],
  delegations: [],
  now: NOW,
})
check('§4 buildRows child 一对一消费、不被两个 job 复用', rowsOneToOne.filter((r) => r.childId === 'only').length === 1 && rowsOneToOne.filter((r) => r.confidence === 'unmatched').length === 1)

const rowsAmbiguous = buildRows({
  sessionId: 's1',
  children: [childEntry('c1', 'docs', NOW + 1000, 'one-shot'), childEntry('c2', 'docs', NOW + 1000, 'one-shot')],
  jobs: [{ id: 'subagent-2', kind: 'subagent', label: 'docs', status: 'running', startedAt: NOW, output: { total: 0, earliest: 0 } }],
  delegations: [],
  now: NOW,
})
check('§4 buildRows 同等候选 → ambiguous 未合并', rowsAmbiguous.length === 3 && rowsAmbiguous.some((r) => r.confidence === 'ambiguous'))

const rowsSort = buildRows({
  sessionId: 's1',
  children: [childEntry('old', 'old', NOW - 5000), childEntry('new', 'new', NOW)],
  jobs: [],
  delegations: [],
  now: NOW,
})
check('§4 buildRows 按 startedAt 倒序', rowsSort[0].childId === 'new')

/* ── §5：结果文本与输出折叠 ────────────────────────────────────────── */

check('§5 contentText 字符串/块', contentText('hi') === 'hi' && contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }]) === 'a\nb')
check('§5 preview 折叠截断', preview('  a   b\nc  ', 3) === 'a b…')

const entries = [
  { type: 'event', event: { type: 'tool/call', data: { callId: 'k1', name: 'subagent_kimi_docs', arguments: '{"description":"write docs","run_in_background":true}' } } },
  { type: 'event', event: { type: 'tool/result', data: { message: { toolCallId: 'k1', content: [{ type: 'text', text: '{"kind":"background","jobId":"subagent-9"}' }] } } } },
  { type: 'event', event: { type: 'tool/call', data: { callId: 'k2', name: 'other_tool' } } },
]
const delegations = collectDelegations(entries)
check('§5 collectDelegations 只收 subagent 前缀 + 配对', delegations.length === 1 && delegations[0].name === 'subagent_kimi_docs' && parseDispatch(delegations[0].resultText).jobId === 'subagent-9')
check('§5 collectDelegations 解析 description/run_in_background', delegations[0].label === 'write docs' && delegations[0].runInBackground === true)

const routedEntries = [
  { type: 'event', event: { type: 'tool/call', data: { callId: 'r1', name: 'subagent', arguments: '{"description":"relay job","provider":"codex-relay","model":"gpt-5.6-sol","reasoning_effort":"high"}' } } },
  { type: 'event', event: { type: 'tool/result', data: { message: { toolCallId: 'r1', content: [{ type: 'text', text: '{"kind":"continuable","subagentId":"c9"}' }] } } } },
  { type: 'event', event: { type: 'tool/call', data: { callId: 'r2', name: 'subagent', arguments: '{"description":"no route"}' } } },
  { type: 'event', event: { type: 'tool/result', data: { message: { toolCallId: 'r2', content: [{ type: 'text', text: '{"kind":"continuable","subagentId":"c10"}' }] } } } },
]
const routedDelegations = collectDelegations(routedEntries)
check('§5 collectDelegations 捕获派发显式路由', routedDelegations.length === 2
  && routedDelegations[0].route !== null && routedDelegations[0].route.provider === 'codex-relay'
  && routedDelegations[0].route.model === 'gpt-5.6-sol' && routedDelegations[0].route.reasoningEffort === 'high',
  JSON.stringify(routedDelegations[0] && routedDelegations[0].route))
check('§5 collectDelegations 无路由字段 → route null', routedDelegations[1].route === null)
check('§5 routeOfDispatchArgs 只认非空字符串', (() => {
  const a = routeOfDispatchArgs({ provider: 'x' })
  return routeOfDispatchArgs(null) === null && routeOfDispatchArgs({}) === null
    && routeOfDispatchArgs({ run_in_background: true }) === null
    && a.provider === 'x' && a.model === null && a.reasoningEffort === null
})())

/* §5 追加：PTC 分发记录（run_code 内的子代理调用不产生 tool/call）。 */
const ptcEntries = [
  { type: 'event', event: { type: 'tool/ptc-dispatch', data: {
      rootCallId: 'tool_a', subCallId: 'tool_a:ptc:1', name: 'subagent',
      arguments: { description: 'probe route', provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash', run_in_background: true },
      isError: false, content: [{ type: 'text', text: '{"kind":"one-shot"}' }] } } },
  { type: 'event', event: { type: 'tool/ptc-dispatch', data: {
      rootCallId: 'tool_b', subCallId: 'tool_b:ptc:2', name: 'subagent_cursor_grok',
      arguments: { description: 'cursor probe' }, content: [{ type: 'text', text: 'ACP-OK' }] } } },
  { type: 'event', event: { type: 'tool/ptc-dispatch', data: { rootCallId: 'tool_c', subCallId: 'tool_c:ptc:1', name: 'read', arguments: { file_path: 'a' } } } },
]
const ptcDelegations = collectDelegations(ptcEntries)
check('§5 collectDelegations 兼读 tool/ptc-dispatch（只收 subagent 前缀）', ptcDelegations.length === 2
  && ptcDelegations[0].name === 'subagent' && ptcDelegations[1].name === 'subagent_cursor_grok',
  JSON.stringify(ptcDelegations.map((d) => d.name)))
check('§5 ptc-dispatch 捕获显式路由与描述', ptcDelegations[0].route !== null
  && ptcDelegations[0].route.provider === 'ais-2dsglm' && ptcDelegations[0].route.model === 'deepseek-v4.1-flash'
  && ptcDelegations[0].label === 'probe route' && ptcDelegations[0].runInBackground === true,
  JSON.stringify(ptcDelegations[0]))
check('§5 ptc-dispatch 无路由字段/自带 content → route null + 结果文本', ptcDelegations[1].route === null && ptcDelegations[1].resultText === 'ACP-OK')
check('§5 ptc-dispatch 字符串 arguments 也解析', (() => {
  const one = collectDelegations([{ type: 'event', event: { type: 'tool/ptc-dispatch', data: {
    rootCallId: 'tool_d', subCallId: 'tool_d:ptc:1', name: 'subagent', arguments: '{"description":"str args","provider":"codex-relay","model":"gpt-5.6-sol"}' } } }])
  return one.length === 1 && one[0].label === 'str args' && one[0].route.provider === 'codex-relay'
})())
check('§5 ptc-dispatch 缺 id/形状异常不抛', (() => {
  const odd = collectDelegations([{ type: 'event', event: { type: 'tool/ptc-dispatch', data: { name: 'subagent' } } }, { type: 'event', event: { type: 'tool/ptc-dispatch' } }, null])
  return odd.length === 1 && odd[0].callId === null && odd[0].route === null
})())

/* §5 追加：宿主非正式面的**契约夹具**（drift guard）。形状取自本机真实记录
   （session-63114170 / session-34d349f8）。宿主若改名下列字段，这些断言立刻变红，
   而不是让面板静默退回驱动名。 */
const PTC_DISPATCH_KEYS = ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', 'content']
const ptcRealRecord = { type: 'event', event: { type: 'tool/ptc-dispatch', data: {
  rootCallId: 'tool_zVmMCrraXHetNSnPDz9KEsBL', parentCallId: 'tool_zVmMCrraXHetNSnPDz9KEsBL',
  subCallId: 'tool_zVmMCrraXHetNSnPDz9KEsBL:ptc:1', name: 'subagent',
  arguments: { description: 'Route evidence probe', provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash', run_in_background: false },
  isError: false, content: [{ type: 'text', text: 'DS-OK' }] } } }
check('§5 契约：ptc-dispatch 含 name/arguments/content/subCallId', PTC_DISPATCH_KEYS.every((k) => k in ptcRealRecord.event.data))
check('§5 契约：真实 ptc-dispatch 记录 → 一行 + 实际路由', (() => {
  const one = collectDelegations([ptcRealRecord])
  return one.length === 1 && one[0].callId === 'tool_zVmMCrraXHetNSnPDz9KEsBL:ptc:1'
    && one[0].name === 'subagent' && one[0].route.provider === 'ais-2dsglm'
    && one[0].route.model === 'deepseek-v4.1-flash' && one[0].resultText === 'DS-OK'
})())
// 注意：会话事件里的 catalog 记录字段是 childId/childCreatedAt，面板消费的是**投影**
// 条目（id/createdAt）——这里钉的正是面板实际读的那个形状。
check('§5 契约：投影 catalog 条目 id/createdAt/mode/label → 子行', (() => {
  const rows = buildRows({ sessionId: 's1', children: [{ id: 'ce840d44-ea44-40ab-b435-e73eef252a10', createdAt: 1791968737625, mode: 'one-shot', label: 'Route evidence probe' }],
    jobs: [], delegations: [], byId: {}, observed: {}, timingOf: () => null, modelSelectionOf: () => null, tokensOf: () => null, now: 1791968737625 })
  return rows.length === 1 && rows[0].kind === 'child' && rows[0].mode === 'foreground'
    && rows[0].oneShot === true && rows[0].label === 'Route evidence probe' && rows[0].createdAt === 1791968737625
})())
check('§5 契约：投影 modelSelection 形状 {lastUsed,next} 驱动实际路由', (() => {
  const typed = typeOfRoute({ toolName: undefined, route: null, modelSelection: { lastUsed: { provider: 'codex-relay', model: 'gpt-5.6-sol' }, next: null } })
  return typed !== null && typed.source === 'selection' && typed.route.provider === 'codex-relay' && typed.route.model === 'gpt-5.6-sol'
})())

const childEntries = [
  { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } } },
  { type: 'transient', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: ' wor' } } } },
  { type: 'transient', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'tool-call-delta', name: 'read_file' } } } },
  { type: 'event', event: { type: 'tool/call', data: { name: 'read_file', arguments: '{"p":"a"}' } } },
  { type: 'event', event: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }], isError: false } } } },
  { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  { type: 'event', event: { type: 'nonsense' } },
]
const folded = foldEntries(childEntries)
check('§5 foldEntries 处理 live-chunk/assistant/tool/turn-end', folded.some((l) => l === 'hello') && folded.some((l) => l.indexOf('→ read_file') === 0) && folded.some((l) => l.indexOf('← ok') === 0) && folded.some((l) => l.indexOf('— 本轮完成') === 0), JSON.stringify(folded))
check('§5 foldEntries 形状异常不抛', Array.isArray(foldEntries(null)) && foldEntries([null, {}]).length === 0)

const manyLines = Array.from({ length: 300 }, (_, i) => 'line-' + i)
const trimmed = trimTail(manyLines, 200, 1000000)
check('§5 trimTail 行裁剪', trimmed.lines.length === 200 && trimmed.truncated === true && trimmed.lines[0] === 'line-100')
const trimmedBytes = trimTail(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 200, 120)
check('§5 trimTail 字节裁剪', trimmedBytes.lines.length === 2 && trimmedBytes.truncated === true)

/* ── §6：定位、资源链接、行类型 ────────────────────────────────────── */

check('§6 panelPositionFor 下方优先', panelPositionFor({ left: 100, top: 300, bottom: 316 }, { width: 1000, height: 800 }).top === 322)
check('§6 panelPositionFor 下方不足翻上', panelPositionFor({ left: 100, top: 600, bottom: 616 }, { width: 1000, height: 620 }).top === 600 - 6 - 380)
check('§6 panelPositionFor 右侧夹取', panelPositionFor({ left: 900, top: 300, bottom: 316 }, { width: 1000, height: 800 }).left === 1000 - 480 - 8)
check('§6 panelPositionFor 移动端按实际面板宽夹取', panelPositionFor({ left: 280, top: 200, bottom: 220 }, { width: 320, height: 700 }).left === 8)
check('§6 panelPositionFor 无锚点不抛', typeof panelPositionFor(null, undefined).top === 'number')
check('§6 resourceUrl 形状', resourceUrl('c1', 's1', 'continuable') === 'dsh-resource://subagentchat/session/c1?parent=s1&mode=continuable')
check('§6 resourceModeOf', resourceModeOf({ mode: 'continuable' }) === 'continuable' && resourceModeOf({ mode: 'foreground' }) === 'one-shot')
check('§6 rowType 实际路由优先于工具名', rowType({ toolName: 'subagent_kimi_docs', modelSelection: { lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol' } } }).label === 'Codex')
check('§6 rowType 路由口径保留驱动名', (() => {
  const t = rowType({ toolName: 'subagent_kimi_docs', modelSelection: { lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol' } } })
  return t.via === 'route' && t.driver === 'Kimi' && t.route.model === 'gpt-5.6-sol'
})())
check('§6 rowType 派发显式路由优先于 modelSelection', rowType({
  toolName: 'subagent',
  route: { provider: 'codex-relay', model: 'gpt-5.6-sol' },
  modelSelection: { lastUsed: { provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash' } },
}).label === 'Codex-Relay')
check('§6 rowType spawn 裸工具按实际路由显示 DS4.1', (() => {
  const t = rowType({ toolName: 'subagent', modelSelection: { lastUsed: { provider: 'ais-2dsglm', model: 'deepseek-v4.1-flash' } } })
  return t.label === 'DS4.1' && t.driver === 'spawn' && t.via === 'route' && t.route.provider === 'ais-2dsglm'
})())
check('§6 rowType 路由不可识别回落工具名', (() => {
  const t = rowType({ toolName: 'subagent_kimi_docs', route: null, modelSelection: { lastUsed: { provider: 'unknown', model: 'm' } } })
  return t.label === 'Kimi' && t.via === 'tool' && t.driver === 'Kimi'
})())
check('§6 rowType 无证据才显示通用名', rowType({ kind: 'job' }).label === '后台' && rowType({ kind: 'child' }).label === '子代理' && rowType(null).via === 'fallback')
check('§6 typeOfRoute 来源标注', (() => {
  const a = typeOfRoute({ route: { provider: 'codex-relay', model: 'gpt-5.6-sol' } })
  const b = typeOfRoute({ modelSelection: { lastUsed: { provider: 'openai-codex', model: 'gpt-5.6-sol' } } })
  return a.source === 'dispatch' && a.label === 'Codex-Relay' && b.source === 'selection' && b.label === 'Codex' && typeOfRoute({}) === null
})())
check('§6 badgeTitle 注明实际路由与驱动', badgeTitle(rowType({
  toolName: 'subagent',
  route: { provider: 'codex-relay', model: 'gpt-5.6-sol' },
})) === '实际路由：Codex-Relay（codex-relay / gpt-5.6-sol）· 驱动 spawn')
check('§6 badgeTitle 工具口径回退', badgeTitle(rowType({ toolName: 'subagent_fork' })) === '子代理类型（驱动）：fork')
check('§6 徽标渲染带 via 与 tooltip', /"data-subagent-type-via":\s*type\.via,[\s\S]{0,160}title:\s*badgeTitle\(type\)/.test(source))

/* ── §1/§6：faceOf 降级 + windowSource ─────────────────────────────── */

function makeCtx({ sessions, jobs, uiWorkspace } = {}) {
  return {
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'jobs') return jobs
      if (name === 'uiWorkspace') return uiWorkspace
      return undefined
    },
  }
}

check('§1 faceOf 无 sessions → UNAVAILABLE', !('parentSourceFor' in faceOf(makeCtx())))

const throwingSessions = { binding() { throw new Error('boom') } }
const throwingFace = faceOf(makeCtx({ sessions: throwingSessions }))
check('§1 faceOf binding 抛错 → 空窗口降级（不抛）', throwingFace !== UNAVAILABLE && throwingFace.parentSourceFor('s1').getSnapshot() === EMPTY_WINDOW)

const fakeSourceWindow = { entries: [], hasMore: true, revision: 3, change: { kind: 'replace', entries: [] } }
let subCount = 0
const fakeSource = { subscribe: () => { subCount += 1; return () => { subCount -= 1 } }, getSnapshot: () => fakeSourceWindow }
const okSessions = { binding: () => ({ eventSource: fakeSource }), subagentAddress: () => undefined, retain: () => null, refreshProjections: () => Promise.resolve() }
const goodFace = faceOf(makeCtx({ sessions: okSessions, jobs: { state: { subscribe: () => () => {}, getSnapshot: () => EMPTY_JOBS } } }))
const goodParentSource = goodFace.parentSourceFor('s1')
check('§1 faceOf 正常分支按标准 props sessionId 创建 parentSource', goodParentSource.getSnapshot() === fakeSourceWindow)
check('§1 faceOf jobsSource 透传', goodFace.jobsSource !== null && goodFace.jobsSource.getSnapshot() === EMPTY_JOBS)
check('§1 windowSource 订阅转发/退订', (() => { const un = goodParentSource.subscribe(() => {}); const bound = subCount === 1; un(); return bound && subCount === 0 })())
check('§1 windowSource 缺 binding → 空窗口', windowSource({ binding: () => ({}) }, 's1').getSnapshot() === EMPTY_WINDOW)

/* ── §6：组件渲染（假 react 钩子直读快照） ─────────────────────────── */

let capturedSlotOptions = null

check('§6 渲染：UNAVAILABLE → null', (() => {
  const reg = captureComponent()
  return reg({ ...UNAVAILABLE }) === null
})())

function captureComponent() {
  let component = null
  const ctx = {
    get(name) {
      if (name === 'sessions') return okSessions
      if (name === 'jobs') return { state: { subscribe: () => () => {}, getSnapshot: () => EMPTY_JOBS } }
      return undefined
    },
    slots: {
      inject(seat, factory) { component = factory().component; return () => {} },
      register(_options, comp) { capturedSlotOptions = _options; return { options: _options, component: comp } },
    },
  }
  exports_.apply(ctx)
  return component
}

const component = captureComponent()
check('§6 apply 注册组件为函数', typeof component === 'function')
check('§6 header action inject 无参数并返回可用 face', capturedSlotOptions !== null && typeof capturedSlotOptions.inject === 'function' && typeof capturedSlotOptions.inject().parentSourceFor === 'function')

const emptyList = { byId: {}, projectionsBySession: { s1: { values: { subagentCatalog: [] } } } }
const renderProps = (listState, extra) => ({
  sessionId: 's1',
  useSessions: (selector) => selector(listState),
  jobsSource: { subscribe: () => () => {}, getSnapshot: () => EMPTY_JOBS },
  parentSourceFor: () => ({ subscribe: () => () => {}, getSnapshot: () => EMPTY_WINDOW }),
  subagentAddress: () => undefined,
  retain: () => null,
  observe: () => () => {},
  watchRows: () => () => {},
  refreshProjections: () => {},
  openChild: () => {},
  ...extra,
})

check('§6 渲染：无子代理/任务 → null（零占用）', component(renderProps(emptyList)) === null)

const catalogList = { byId: {}, projectionsBySession: { s1: { values: { subagentCatalog: [childEntry('c1', 'docs', NOW - 1000)] } } } }
const rendered = component(renderProps(catalogList))
check('§6 渲染：有子代理 → root span + 触发器', rendered !== null && rendered.type === 'span' && rendered.props['data-subagent-monitor-root'] === true)
const trigger = Array.isArray(rendered.props.children) ? rendered.props.children[0] : null
const triggerText = trigger !== null && Array.isArray(trigger.props.children) ? trigger.props.children.join('') : ''
check('§6 渲染：触发器文案「子代理 1」', trigger !== null && trigger.type === 'button' && triggerText === '子代理 1')

check('§6 渲染：无 useSessions 标准 props → null', component({ sessionId: 's1' }) === null)
check('§6 渲染：无 sessionId → null', component({ useSessions: (s) => s(catalogList) }) === null)

/* ── §6：openChild 导航（uiWorkspace.openSession，address 透传/安全构造） ── */

check('§6 源码不再调用 window.open', !source.includes('window.open'))
check('§6 行尾“打开子会话”渲染为 button 命令而非 a 链接', source.includes('data-subagent-open-child') && source.indexOf('h("a"') === -1)
check('§6 仅在 openChild 可用时渲染命令按钮', source.includes('typeof face.openChild === "function"'))
check('§6 导航成功后关闭监控面板', /data-subagent-open-child[\s\S]{0,400}navigated === true/.test(source))

const exactAddress = { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable' }
const navSessions = {
  binding: () => ({ eventSource: fakeSource }),
  subagentAddress: (id) => (id === 'c1' ? exactAddress : undefined),
  retain: () => null,
  refreshProjections: () => Promise.resolve(),
}
let openCalls = []
const navFace = faceOf(makeCtx({
  sessions: navSessions,
  jobs: { state: { subscribe: () => () => {}, getSnapshot: () => EMPTY_JOBS } },
  uiWorkspace: { openSession: (address) => { openCalls.push(address) } },
}))
check('§6 openChild 精确透传 subagentAddress 结果', navFace.openChild('c1', 'p1', 'continuable') === true && openCalls[0] === exactAddress)
check('§6 openChild 缺 address 时安全构造 one-shot', (() => {
  openCalls = []
  const ok = navFace.openChild('c2', 'p1', 'one-shot')
  const a = openCalls[0]
  return ok === true && a.parentSessionId === 'p1' && a.childSessionId === 'c2' && a.mode === 'one-shot'
})())
check('§6 openChild 未识别 mode → unknown', (() => {
  openCalls = []
  navFace.openChild('c3', 'p1', 'weird')
  return openCalls[0].mode === 'unknown'
})())
check('§6 无 uiWorkspace 时不暴露 openChild 命令', (() => {
  const noNav = faceOf(makeCtx({ sessions: navSessions }))
  return noNav.openChild === undefined
})())
check('§6 openChild openSession 抛错 → false', (() => {
  const throwingNav = faceOf(makeCtx({
    sessions: navSessions,
    uiWorkspace: { openSession: () => { throw new Error('nope') } },
  }))
  return throwingNav.openChild('c1', 'p1', 'continuable') === false
})())
check('§6 openChild subagentAddress 抛错 → 仍安全构造并导航', (() => {
  let captured = null
  const brokenSessions = { ...navSessions, subagentAddress: () => { throw new Error('boom') } }
  const brokenFace = faceOf(makeCtx({ sessions: brokenSessions, uiWorkspace: { openSession: (a) => { captured = a } } }))
  const ok = brokenFace.openChild('c9', 'p1', 'continuable')
  return ok === true && captured.parentSessionId === 'p1' && captured.childSessionId === 'c9' && captured.mode === 'continuable'
})())
check('§6 openChild 空/非串 childId → false', navFace.openChild('', 'p1', 'one-shot') === false && navFace.openChild(null, 'p1', 'one-shot') === false)
check('§6 openChild 畸形 address 回退安全构造', (() => {
  const malformed = { ...navSessions, subagentAddress: () => ({ parentSessionId: 'p1', mode: 'continuable' }) }
  const out = []
  const mf = faceOf(makeCtx({ sessions: malformed, uiWorkspace: { openSession: (a) => { out.push(a) } } }))
  mf.openChild('c5', 'p1', 'one-shot')
  return out[0].childSessionId === 'c5' && out[0].mode === 'one-shot'
})())

/* ── §8：token 归集、本地持久化、历史行与行视觉 ───────────────────── */

check('§8 formatTokens 千位', formatTokens(1500) === '1.5k' && formatTokens(1000) === '1k')
check('§8 formatTokens 百万', formatTokens(2500000) === '2.5M' && formatTokens(1000000) === '1M')
check('§8 formatTokens 不足千', formatTokens(999) === '999' && formatTokens(0) === '0')

const realProjection = {
  tokenUsage: { totals: { outputTokens: 1200, uncachedInputTokens: 800, cacheReadTokens: 200 } },
  contextPressure: { surfaceTokens: 4000, contextWindow: 200000 },
}
const tokensReal = tokensOfProjection(realProjection)
check('§8 tokensOfProjection 读取真实投影',
  tokensReal !== null && tokensReal.output === 1200 && tokensReal.input === 1000
  && tokensReal.context === 4000 && tokensReal.contextWindow === 200000)
check('§8 tokensOfProjection 空→null', tokensOfProjection({}) === null && tokensOfProjection(null) === null)
check('§8 tokensLabel 真实投影', (() => {
  const text = tokensLabel({ tokens: tokensReal })
  return text.includes('生成 1.2k') && text.includes('输入 1k') && text.includes('上下文 4k/200k')
})())
check('§8 tokensLabel 无 tokens 返回空', tokensLabel({ tokens: null }) === '' && tokensLabel({}) === '')

check('§8 前台 one-shot 行不产生 token', (() => {
  const out = buildRows({
    sessionId: 's1',
    children: [],
    jobs: [],
    delegations: [{ callId: 'x', name: 'subagent_opencode', startedAt: NOW, resultText: '{"kind":"foreground","runId":"run-1"}' }],
    tokensOf: () => ({ output: 999, input: 1000, context: null, contextWindow: null }),
    now: NOW,
  })
  return out.length === 1 && out[0].oneShot === true && tokensLabel(out[0]) === ''
})())

check('§8 job 无 child 时无 token', (() => {
  const out = buildRows({
    sessionId: 's1',
    children: [],
    jobs: [{ id: 'j1', kind: 'subagent', label: 'bg', status: 'running', startedAt: NOW, output: { total: 0, earliest: 0 } }],
    delegations: [],
    tokensOf: () => ({ output: 5, input: 5, context: null, contextWindow: null }),
    now: NOW,
  })
  return out.length === 1 && out[0].tokens === null && tokensLabel(out[0]) === ''
})())

const fakeStorage = () => {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
  }
}
const liveRow = (key, startedAt, extra) => ({
  key,
  kind: 'child',
  childId: key.indexOf('child:') === 0 ? key.slice(6) : undefined,
  jobId: undefined,
  runId: undefined,
  toolName: undefined,
  label: key,
  mode: 'continuable',
  oneShot: false,
  archived: false,
  tokens: null,
  confidence: 'exact',
  startedAt,
  child: null,
  timing: null,
  job: null,
  observed: null,
  delegation: undefined,
  ...extra,
})

check('§8 持久化键按会话隔离', persistKey('a') !== persistKey('b') && persistKey('a').indexOf(PERSIST_KEY_PREFIX) === 0)

check('§8 save/load 往返', (() => {
  const st = fakeStorage()
  const ok = savePersisted(st, 's1', [liveRow('child:c1', NOW)])
  const back = loadPersisted(st, 's1')
  return ok === true && back.length === 1 && back[0].key === 'child:c1' && typeof back[0].statusText === 'string'
})())

check('§8 损坏 JSON→空数组不抛', (() => {
  const st = fakeStorage()
  st.setItem(persistKey('s1'), '{bad json')
  const back = loadPersisted(st, 's1')
  return Array.isArray(back) && back.length === 0
})())

check('§8 保存上限 80 行', (() => {
  const st = fakeStorage()
  const rows = []
  for (let i = 0; i < 100; i++) rows.push(liveRow('child:c' + i, NOW - i * 1000))
  savePersisted(st, 's1', rows)
  const back = loadPersisted(st, 's1')
  return back.length === PERSIST_MAX_ROWS && back[0].startedAt === NOW
})())

check('§8 mergePersisted 保留被裁剪历史行', (() => {
  const stored = [snapshotRow(liveRow('child:old', NOW - 999000), NOW)]
  const live = [liveRow('child:new', NOW)]
  const merged = mergePersisted(live, stored)
  const old = merged.find((r) => r.key === 'child:old')
  return merged.length === 2 && old !== undefined && old.archived === true && old.confidence === 'archived'
})())

check('§8 mergePersisted 实时行优先不重复', (() => {
  const stored = [snapshotRow(liveRow('child:c1', NOW - 5000), NOW)]
  const live = [liveRow('child:c1', NOW)]
  const merged = mergePersisted(live, stored)
  return merged.length === 1 && merged[0].archived === false && merged[0].startedAt === NOW
})())

check('§8 历史行 statusOf 标注历史', statusOf({ archived: true, archivedStatus: '已完成' }).text === '历史 · 已完成')
check('§8 历史行 isActiveRow false', isActiveRow({ archived: true, child: { running: true } }) === false)
check('§8 历史行 keepalive 文案', keepaliveOf({ archived: true }, NOW).includes('历史记录'))

check('§8 rowFontSize 一次性小于可续接', rowFontSize({ oneShot: true }) < rowFontSize({ oneShot: false }))
check('§8 rowChip 四种',
  rowChip({ archived: true }).text === '历史'
  && rowChip({ oneShot: true }).text === '一次性'
  && rowChip({ mode: 'continuable' }).text === '可续接'
  && rowChip({ mode: 'background' }).text === '后台')

check('§8 源码含 data-subagent-oneshot', source.includes('data-subagent-oneshot'))
check('§8 源码含 data-subagent-tokens', source.includes('data-subagent-tokens'))
check('§8 源码含 data-subagent-chip', source.includes('data-subagent-chip'))
check('§8 源码含图例', source.includes('可续接（可继续对话）') && source.includes('data-subagent-legend'))
check('§8 一次性无 childId 不渲染打开按钮', /canLink[\s\S]{0,120}oneShotNoChild/.test(source) && source.includes('data-subagent-open-child'))
check('§8 rowsSignature 稳定', (() => {
  const rowsA = [liveRow('child:c1', NOW)]
  const s1 = rowsSignature(rowsA)
  const s2 = rowsSignature(rowsA)
  const changed = rowsSignature([liveRow('child:c1', NOW, { job: { status: 'completed', startedAt: NOW } })])
  return s1 === s2 && typeof s1 === 'string' && s1.length > 0 && s1 !== changed
})())
check('§8 源码不含估算字样', !source.includes('估算') && source.indexOf('≈') === -1)

check('§8 归档行保留派发路由', (() => {
  const row = { ...liveRow('job:subagent-9', NOW - 1000), kind: 'job', route: { provider: 'codex-relay', model: 'gpt-5.6-sol', reasoningEffort: 'high' } }
  const restored = mergePersisted([], [snapshotRow(row, NOW)])[0]
  return restored.archived === true && restored.route !== null && restored.route.provider === 'codex-relay' && restored.route.model === 'gpt-5.6-sol'
})())
check('§8 归档行路由仍能驱动徽标', (() => {
  const row = { ...liveRow('job:subagent-9', NOW - 1000), kind: 'job', toolName: 'subagent_codex_relay', route: { provider: 'codex-relay', model: 'gpt-5.6-sol' } }
  const restored = mergePersisted([], [snapshotRow(row, NOW)])[0]
  const type = rowType(restored)
  return type.via === 'route' && type.route !== null && type.route.provider === 'codex-relay'
})())
check('§8 无路由的行归档后 route 为 null', (() => {
  const restored = mergePersisted([], [snapshotRow(liveRow('job:subagent-8', NOW - 1000), NOW)])[0]
  return restored.route === null
})())
/* ── 汇总 ─────────────────────────────────────────────────────────── */

console.log('')
if (failed > 0) {
  console.error(`FAILED: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`ALL PASSED (${passed} checks)`)
