# Superagent Deferred Risks — Minimal Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` task-by-task. 本文是方案，不是执行授权。

**Goal:** 保留已有三个未提交修复，最小修复已留存私聊线程的缓存缺失误判，并明确重试、格式与构建安全边界。

**Architecture:** 第一批只改分类回退和对应测试；不新增网络调用、数据库表或全局重试上限。构建采用现有工具的显式停服/备份/build/apply/verify流程，自动重启、stdin和首次未知私聊发现均独立审批。

**Tech Stack:** TypeScript, Vitest 4, SQLite effects, Node execFile, PowerShell 7, tsdown.

## 0. 身份、范围与状态

- 根任务：task-20261113T044743999676Z-e5c6335f469b；用户选择1A，仅分析与方案，不改源码、不提交、不推送、不重启。
- **状态：已完成源码核查、两轮独立review及主控修订，待用户批准实施；不是源码已实现或全套测试通过。**
- 子模块HEAD：8c32a9d。保留 [feishu-channel.ts](../../../dsh-superagent/src/sources/feishu-channel.ts)、[registry.spec.ts](../../../dsh-superagent/tests/registry.spec.ts)、[runtime.spec.ts](../../../dsh-superagent/tests/runtime.spec.ts) 原三个修改。
- PTC账本存在历史非法迁移，CLI拒绝追加；不修历史、不建第二权威账本、不宣称PTC已收口。
- 并发新增launch-superagent.cmd、现有备份、同名兄弟目录均不在改动范围。

## 1. 已核实的风险

| 项目 | 证据 | 最小结论 |
|---|---|---|
| 回复重试 | [outbox:24](../../../dsh-superagent/src/app/outbox.ts#L24)、[effects:141](../../../dsh-superagent/src/app/effects.ts#L141) | 没有次数上限，退避封顶300秒；不因此直接新增三次丢弃 |
| 三次阈值 | [effects:155](../../../dsh-superagent/src/app/effects.ts#L155)、[store:259–261](../../../dsh-superagent/src/app/store.ts#L259-L261) | 仅健康显错与放行同工单同会话后续消息，不终止该消息重试 |
| 私聊缓存 | [feishu-loops:240](../../../dsh-superagent/src/sources/feishu-loops.ts#L240) | 缺缓存直接变成false，可能把已知私聊轮询结果误判为群聊 |
| 未登记私聊 | [feishu-loops:138–150](../../../dsh-superagent/src/sources/feishu-loops.ts#L138-L150) | 补读集合只有配置群+缓存已知私聊；首次未知私聊发现不由本补丁解决 |
| @格式 | [feishu-channel:25–28](../../../dsh-superagent/src/sources/feishu-channel.ts#L25-L28) | content JSON避免@file，但退化为纯文本；现有安全取舍保留 |
| 构建补丁 | [补丁说明:18](../../ops/dsh-superagent-patches/README.md#L18) | 重新build覆盖lib；先固化手工安全顺序，不先扩建生命周期框架 |

这些是源码证实的结构性风险，不表示已经发生过丢消息事故。

## 2. 第一批文件边界

- 修改 [feishu-loops.ts](../../../dsh-superagent/src/sources/feishu-loops.ts)：分类回退。
- 修改 [sources.spec.ts](../../../dsh-superagent/tests/sources.spec.ts)：复用现有私聊topic-poll fixture。
- 后续更新 [补丁说明](../../ops/dsh-superagent-patches/README.md)：部署顺序、失败保持停止、完整产物快照。
- 如新增安装/服务动作，必须同步 [根README](../../../README.md) 与 [装机引导](../../bootstrap/PROMPT-新设备装机-引导.md)。本轮不改这些文件。

## Task 1: 建立缓存丢失红测

- [ ] 在sources.spec.ts复制现有第151行测试，命名为 `preserves direct classification when the chat cache is missing`。**从新测试中删除原第154行 `h.store.set('feishu-chats', { oc_dm: true })`，不是注释后换位置执行。** 保留原测试本身不动，新测试只保留p2p source Trigger、订阅、lark mock与live对照；不得调用其他辅助函数补写此缓存。
- [ ] 在首次poll之前额外断言 `expect(h.store.get(KV.feishu.chats)?.oc_dm).toBeUndefined()`（复用该测试文件第5行已有的KV导入）。保留以下最终断言，不放宽深等值比较：
```ts
expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([live])
expect(live).toMatchObject({
  addressed: 'direct',
  channel: { address: { chatId: 'oc_dm', direct: 'true' } },
  threads: [{ source: 'feishu', id: 'oc_dm:om_root' }],
})
```
- [ ] 运行红测；预期当前代码得到group而非p2p，深等值断言失败：
```powershell
pnpm --dir dsh-superagent exec vitest run tests/sources.spec.ts -t 'preserves direct classification when the chat cache is missing'
```
本轮没有创建此测试或执行红绿实验；上述是未来实施步骤，不是通过声明。

## Task 2: 实现最小分类回退

- [ ] 在feishu-loops.ts新增私有函数，复用现有类型和导入：
```ts
function retainedChatType(ctx: SourceContext, thread: Thread, ref: FeishuRef): boolean | undefined {
  const candidates = [ctx.triggers.get(ref.triggerId), ctx.triggers.latest(thread.key)]
  for (const retained of candidates) {
    if (retained?.source !== SOURCE || retained.meta.chatId !== ref.chatId) continue
    if (typeof retained.meta.direct === 'boolean') return retained.meta.direct
  }
  return undefined
}
```
- [ ] 在pollThread的enabled检查后、任何checkpoint/initialized写入前解析direct；删除原第240行：
```ts
const chats = ctx.state.get(KV.feishu.chats) ?? {}
const cached = chats[ref.chatId]
const direct = cached ?? retainedChatType(ctx, thread, ref)
if (direct === undefined) throw new Error(`Feishu chat type unavailable for ${ref.chatId}`)
if (cached === undefined) ctx.state.set(KV.feishu.chats, { ...chats, [ref.chatId]: direct })
```
- [ ] 保留显式false，不用逻辑或；未知抛错由已有pollError承接，不推进checkpoint，不标sent/gone，不按oc_前缀或通用2200猜私聊。
- [ ] 新增回归矩阵，每个测试名均以 `preserves direct classification` 开头，保证下方selector全部选中：
  1. `preserves direct classification for cached false`：缓存false+留存true时保留false（既有缓存优先；不混入历史污染修复）。
  2. `preserves direct classification for cached true`：缓存true+留存false时保留true。
  3. `preserves direct classification through latest fallback`：get找不到、latest同chatId且direct=true时恢复true并回填缓存。
  4. `preserves direct classification through incomplete retained trigger`：get存在但direct不是boolean，latest同chatId有boolean时继续检查latest。
  5. `preserves direct classification without cross-chat contamination`：候选均不同chatId或不同source时，不回填，进入可观察未知分支。
  6. `preserves direct classification checkpoints when metadata is unknown`：缓存与候选均未知；pollError含chat type unavailable，checkpoint和initialized逐值不变，无receive、无新发送。
- [ ] 兼容性门槛：完全未知的旧群聊线程过去会默认false继续轮询，本方案会显错暂停该线程；这是有意的fail-closed行为变化，不得声称完全无回归。审批前明确接受此取舍；测试必须覆盖旧线程元数据缺失场景。
- [ ] 缓存读取、解析、写回必须保持在首个await之前且中间无await；当前方案没有调用ctx.atomic，不能因为接口存在就声称事务保护。增加poll和live事件交错测试，证明没有覆盖另一chatId的更新；若实施时引入await，写回时重新读取map并在真实ctx.atomic回调内合并，不沿用跨await的旧快照。
- [ ] 运行绿测、旧测试和非输出型别检查：
```powershell
pnpm --dir dsh-superagent exec vitest run tests/sources.spec.ts -t 'preserves direct classification|translates a polled topic reply'
pnpm --dir dsh-superagent exec tsc --noEmit --incremental false
```
- [ ] 范围声明：只恢复已有留存线程；不能恢复从未登记过的第一条私聊，不凭空补造游标，不静默覆盖历史污染缓存。若缓存与留存冲突需另行明确仲裁规则。

## Task 3: 安全部署采用现有工具，不自动停服/重启

- [ ] 执行前重新盘点共享同一真实包目录的profile链接；先确认当前git顶层不是同名兄弟副本。
- [ ] 后续获得停服授权，运行现有stop并逐步检查退出码；运行回合存在时不得自动Force，PID/端口/共享实例未确认停止就不build。
- [ ] 在忽略的子模块.artifacts/rebuild-<timestamp>内保存完整lib快照和哈希；确认快照绝对路径不等于lib，不只依赖构建后的prepatch-backup。
- [ ] 每步非零即止、保持停止：
```powershell
git -C dsh-superagent rev-parse --show-toplevel
pnpm --dir dsh-superagent build
pwsh -File docs/ops/patch-dsh-superagent.ps1 -Mode apply -PkgPath ./dsh-superagent
pwsh -File docs/ops/patch-dsh-superagent.ps1 -Mode verify -PkgPath ./dsh-superagent
```
这些是逐条检查的运维命令，不可整段执行而忽略LASTEXITCODE。
- [ ] 任一步失败都不start；保留日志，明确批准后按同一部署前完整lib快照恢复、核对每个文件哈希，保持停止直至重新验收。
- [ ] 三条补丁applied、构建中Feishu参数和管理状态分开验收；verify通过不代表服务激活。启动仍需明确授权。
- [ ] 自动rebuild动作延后：若以后批准，须默认拒绝运行中服务、保留手工停止标记、无隐式restart、并发互斥；用假pnpm/patch/service测试失败断点与快照恢复，不在线上试停服务。

## 3. 暂不实施的产品决策

1. **重试上限/死信**：先定N、错误分类、旧高attempts、终态receipt、health展示、单条人工恢复、幂等键和ack顺序。不能只加maxAttempts=3后吞失败；ticket retry不是单条回复重发。
2. **未知首次私聊发现**：缓存/留存回退无法发现不存在的chatId；需先核实chat-list/chat-get实际字段与权限。本轮未调用这些API，不宣称可用。
3. **@Markdown stdin**：离线CLI帮助确认markdown支持标准输入，但Commands.run尚无stdin接口。本批保留纯文本；未来添加可选input时保留cwd/90秒超时/AbortSignal/env/脱敏，测EPIPE、Unicode、提前退出、取消及群/私聊幂等，不用shell/临时文件/零宽字符。
4. **旧副本/230027**：不自动归档或删除旧副本；权限错误另行处理，不与分类修复混同，不读取凭据。

## 4. 本轮已执行的只读验证

- 三条补丁verify：exit0，全部applied。
- Feishu/CLI定点测试：exit0，14passed/16skipped；非全套通过声明。
- 离线 `lark-cli im +messages-reply --help`：exit0，markdown支持stdin；无消息发送。
- SourceContext已有get/latest接口：[host:62](../../../dsh-superagent/src/sources/host.ts#L62)，无需暴露新SQL。
- 当前仅superagent profile链接到本子模块；实施时重新盘点，不当永久保证。

## 5. 评审、执行门槛和回滚

- 设计链已执行：GPT-6.1 Sol主控草拟→Opus5独立review→Opus4.8复核→主控逐条验收修订。以下保留不同意见，不把worker自述当完成证据。
- Opus5建议移除retry风险讨论并立即ship；主控未采纳其过度概括。已识别的永久错误会终止，但通用2200/未识别权限错误仍可无限重试；3次不是停止条件。用户仅批准分析，不允许ship。
- Opus4.8指出红测seed指令应更明确，已改成逐字删除并增加poll前缓存缺失断言；补齐true/false优先级、latest、缺字段、错chatId和完全未知的测试矩阵。
- 主控纠正Opus4.8两项推论：atomic仅是接口，草案代码未调用；完全未知即抛错对旧群聊线程是可观察行为变化，必须接受兼容性门槛。
- 源码核查worker实际运行时已由主控读取projcache的modelSelection.lastUsed确认：opencode-go/deepseek-v4.1-flash high。外部两个plan reviewer的模型名来自工具档与返回自述，provider未独立观测；不虚构运行时provider。
- 实施在隔离工作树进行，精确保存并带入原三文件补丁，不在活服务目录checkout/reset/stash。
- 当前授权不含commit/push；不得自动git add -A；子模块提交与父仓指针分别审批。
- 源码回滚只反向本批新增改动，不覆盖原三文件；产物回滚用同一次部署前完整lib快照。
- 下一步唯一动作：请用户批准第一批“分类回退+回归测试+部署说明”，包括未知类型fail-closed取舍；即使批准也不包含提交、推送、服务重启。
