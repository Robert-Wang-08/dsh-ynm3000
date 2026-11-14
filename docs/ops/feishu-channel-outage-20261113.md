# 飞书通道 2026-11-13 夜间掉线复盘（RCA + 避免方案）

- 根任务：`task-20261114T020824624153Z-bc4dae8fd078`（PTC 根任务，账本 `.ptc/registry.jsonl`）
- 会话：`session-8c63cf78-11d9-4948-8e68-0b480a1bffc6`　主控实测模型：`opencode-go/deepseek-v4.1-flash`
- 取证方式：只读。未重启/停止任何服务，未改 profile 配置，未发送飞书消息。
- 时间口径：下文均用 **+08（本地）**；原始日志为 UTC（`Z`），括号内给出原始时间戳来源行号。

## 0. 结论（TL;DR）

用户感知的「飞书通道掉线」不是一次崩溃，而是**三条独立链路在 11-10 → 11-13 之间先后断掉**，19:58 最后一条（HITL 出站推送）也断了，于是"看起来整个通道崩了"。

| # | 链路 | 断在哪 | 断多久 | 直接原因 | 证据 |
|---|---|---|---|---|---|
| A | HITL **出站**（回合结束/审批推送） | 11-13 19:58:03 | 2 小时 35 分（到 22:33:46 人工拉起） | `feishu-daemon.mjs` 进程被**静默硬终止**：没有 `feishu-daemon-stop`、没有 `feishu-inbound-exit`、没有 `feishu-daemon-error`，stdout/stderr 重定向文件 0 字节 | `state/hitl.log` L37780 是断点前最后一行；L37781 才是 22:33:46 的新 daemon |
| B | HITL **入站**（你在飞书发消息 → 注入 DSH 会话） | 11-10 22:16:30 起永久失效 | 3 天（到 11-13 22:33:46） | `startInbound()` spawn `lark-cli event consume` 返回 **`Error: spawn EPERM`**，代码只置 `spawn-failed` 就 `return`，**没有重试** | L34829 / L35004 / L35062 / L35237 四次 `feishu-inbound-error stage=spawn` |
| C | superagent **话题回信 / feishu-watch** | 11-13 17:47:57 起未激活 | 4 小时 46 分（到 22:33:52） | 新实例启动时旧实例仍握着 sqlite：`Error: database is locked` → `feishu-watch: pending (waiting for service: orchestrator)`，**无启动重试** | `profiles/superagent/.artifacts/service-20261113T174757.err.log` |
| D | superagent 话题回信（**今天仍未修好**） | 11-08 17:37 起 | 至今（>5 天） | 15 条 `reply` 效果 100% 失败，累计重试 141–1333 次；原生发送器 `feishu-channel.ts:23` 仍无条件加 `--reply-in-thread` | `orchestrator.sqlite` `effect` 表 + `state/superagent-health/latest.json` `components.reply.state=error` |

**一句话根因**：飞书通道是**四个互不监督的进程/插件**拼起来的（HITL daemon、其入站子进程、superagent 编排器、feishu-watch），每一个都有"失败即永久静默"的分支，而**没有任何自动重启、开机自启或送到人的告警**；平台唯一的在线判据是「心跳文件 30 秒内更新过」，既不检查入站、也不检查 pid，所以三处故障都没有被发现。

## 1. 通道拓扑：到底有几个「飞书通道」

```
① HITL 侧（D:\src\dsh\dsh-wechat-hitl）
   DSH 宿主插件 pkg/dsh-wechat-hitl/index.js   ← 只写发件箱 + 只读心跳，不拉起任何进程
        │  回合结束 / 审批 / 提问 → state/pending.json（发件箱）
        ▼
   feishu-daemon.mjs（独立 node 进程，WMI 脱离 DSH Job 启动）
        ├─ 每 5s drainOutbox() → lark-cli 机器人直发（出站 A）
        ├─ 每 5s 写心跳 state/feishu-daemon.json（tickAt）
        └─ 子进程 lark-cli event consume im.message.receive_v1（入站 B，长连接）
   唯一启动入口：tools/restart-feishu-daemon.ps1（人手/会话触发，无计划任务、无开机自启）

② superagent 侧（D:\src\dsh-superagent，跑在 profile superagent 的 dsh web :3082）
   dsh-superagent（编排器 orchestrator，sqlite = .dsh/state/superagent/orchestrator.sqlite）
        └─ dsh-superagent/feishu-watch（飞书来源 → 工单；回信走 effect kind=reply）  ← C / D
        └─ dsh-superagent/github-watch
   启动入口：profile superagent 的 dsh web 服务（.artifacts/service-*.log、service.pid）

③ DSH 自己的状态栏（可观测性）
   profile web（pid 4284，11-13 17:49:03 起持续存活）→ 我当前所在宿主
   健康报告：.dsh/state/superagent-health/latest.{json,md}（写文件，不推送）
```

关键点：**①②是两套独立实现、独立凭据、独立日志**，但对外都叫"飞书通道"；任一套坏了，用户看到的都是"飞书没反应"。

## 2. 时间线（证据绑定）

| 时间（+08） | 事件 | 证据 |
|---|---|---|
| 11-08 17:37 | superagent 第一条 `reply` 效果开始失败（此后累计 1333 次） | `orchestrator.sqlite` `effect.since=2026-11-08T17:37:48Z` |
| 11-09 18:37:37 | HITL daemon 最后一次**成功**启动入站 | `hitl.log` L33634–33635 |
| 11-10 20:01:45 / 21:28:56 / 21:44:45 / 22:16:30 | 四次重启 daemon，四次都 `feishu-inbound-error spawn EPERM`，入站再未恢复 | L34828–34829、L35003–35004、L35061–35062、L35236–35237 |
| 11-11 → 11-13 白天 | 入站 0 条；出站正常（回合结束推送照常） | `hitl.log` 全量 `op:feishu-inbound` 共 32 条，11-10 19:53 后直到 11-13 23:30 才有下一条 |
| 11-13 17:47:57 | superagent 新实例启动 → `database is locked` → 编排器与 feishu-watch 永久 pending | `service-20261113T174757.err.log` |
| 11-13 17:56:56 | 你在飞书发了一条消息（当时入站已死） | 该事件 `timestamp=1794563816835`，直到次日 01:02:17 才被投递（滞后 **7h05m**） |
| 11-13 17:49:03 | profile web 宿主启动（`dsh web` pid 4284，**故障全程存活**） | `Get-Process 4284`；`logs/dsh-default-startup-20261113-174753.log` |
| 11-13 19:58:03 | **最后一条出站成功**；此后 daemon 再无任何日志 | `hitl.log` L37780 `2026-11-13T11:58:03.488Z outbox-sent` |
| 11-13 19:58 → 22:33 | 通道全静默 2h35m；期间无 `feishu-daemon-stop`/`inbound-exit`/`daemon-error` 任何一条 | 全日志 `op` 直方图中**不存在** `feishu-daemon-stop`（历史上从未优雅退出过） |
| 11-13 22:25:07 | 你发的一条飞书消息（无人应答） | 事件 `timestamp=1794579907483`，23:30:22 才投递（滞后 65 分钟） |
| 11-13 22:33:46 | HITL daemon 被人工拉起（pid 1732，config `~/.lark-cli-dsh-superagent-feishu2`），入站 pid 5600 连接成功 | L37781–37782、`[source] feishu-websocket: connected` |
| 11-13 22:33:52 | superagent 服务新实例（此时 sqlite 已释放）→ orchestrator + feishu-watch 恢复 | `service-20261113T223352.out.log`、`service.pid` |
| 11-13 23:30 / 11-14 01:02 | 被积压的旧事件被重放（滞后 65 分钟 / 7 小时） | `op:feishu-inbound` 两条 |
| 11-14 10:11–10:13 | 15 条 `reply` 效果**仍在退避重试**，全部失败 | `effect.due`、`components.reply.state=error` |

排除项（都已核实，不是本次原因）：
- **机器没有重启/睡眠**：System 日志 11-13 18:30–23:30 无 Kernel-Power / 6008 / BugCheck；宿主 pid 4284 从 17:49 一直活到现在。
- **不是 DSH 宿主崩溃**：故障窗口里宿主进程仍在（19:50–20:20 仍有会话回合在跑）。
- **不是配置热改**：`profiles/web/cordis.yml` 只在 17:49:04 写过一次（宿主启动），`cordis.patch.yml` 直到 11-14 09:45 才被改。
- **不是 21001 数据安全策略**：本轮没有任何 `feishu-inbound-blocked 21001`（那是 11-05/11-06 的历史问题）。

## 3. 根因分层

### 3.1 直接原因（触发的那一下）
- **A**：HITL daemon 在 19:58:03 之后被**外部硬终止**。判据：三种正常/异常退出路径都会留痕（`SIGINT/SIGTERM` → `feishu-daemon-stop`；入站子进程退出 → `feishu-inbound-exit` + 10s 重连；drain 异常 → `feishu-daemon-error`；未捕获异常 → stderr 进 `state/feishu-daemon.out`），而三者**全部没有**，且该 out 文件 0 字节、mtime 停在 11-10 22:16:29。`TerminateProcess`/`Stop-Process -Force` 正好符合"零痕迹"。
  - 客观限制：**谁执行的无法从现有日志断定**（没有进程审计、没有 command line 审计）。可排除"脚本优雅停止"（`restart-feishu-daemon.ps1 -Action stop` 用的是 `Stop-Process -Force`，本身也零痕迹，所以这个脚本既是可能的执行者、也是同类风险）。
- **B**：`startInbound()` 的 spawn 失败分支不重试（`feishu-daemon.mjs:249–254`），而 EPERM 恰恰是"受限会话里启动"的稳定复现结果（`restart-feishu-daemon.ps1:97–99` 自己写明了这一点）。
- **C**：新实例启动早于旧实例释放 sqlite → `database is locked` → 插件只把状态记成 pending，**没有第二次尝试**。
- **D**：`feishu-channel.ts:23` 无条件 `--reply-in-thread`，与 11-12 已定位过的 `2200 / server_error` 同一类失败，但**修复只落在 HITL 侧，没落在 superagent 侧**。

### 3.2 放大因素（让一次失败变成数小时/数天）
1. **没有监督者**：HITL daemon 唯一启动入口是人手脚本；DSH 插件只 `read` 心跳（`lib/hitl-store.js:3133` `feishuDaemonAlive`）。没有计划任务、没有开机自启、没有 restart-on-failure。
2. **在线判据太弱**：`feishuDaemonAlive` 只看"心跳 30 秒内更新过"，**不看 `inbound` 状态、不看 pid**。所以 B 故障时"通道显示在线"，实际入站早死了。
3. **心跳写不进 hint**：`hint` 只在 `blocked:policy` 或"落点未设置"时才有值，`spawn-failed` 不给 hint → `fx-hitl daemon status` 看不出"入站没起来"。
4. **告警只在文件里**：superagent 健康报告其实**已经**把 `reply` 标成 `error`（`.dsh/state/superagent-health/latest.json`），但它只写文件，不推送给人 → D 故障 5 天无人知。
5. **重试风暴**：D 的 15 条 effect 以 5s→5min 退避**永久重试**，累计 7000+ 次失败；它既污染日志/CPU，也掩盖"这是硬故障不是瞬时抖动"。
6. **两套通道共用一个"人"**：A/B/C/D 任一坏掉，用户都只会说"飞书掉线"，排查必须同时看 `hitl.log`、`service-*.log`、`orchestrator.sqlite`、`latest.json` 四处——这就是为什么今晚的故障要靠人重开会话才拉起。

### 3.3 系统性缺陷（真正的"为什么会反复发生"）
- 状态机**只覆盖"业务重试"**（出站发件箱有 outbox/dedup/退避），**不覆盖"进程存活"**（无 supervisor、无 health probe、无 alert）。
- 每次修复都收敛到"改代码 + 手工重启"，**没有把重启变成可自动执行、可验证的运行动作**。
- 观测信号（心跳、健康报告）与**告警动作**（推送给人）之间没有连线。

## 4. 今天仍在发生的故障（必须一并修掉，否则"避免了"也还是坏的）

```
effect kind=reply, 15→16 条（数量还在涨），attempts 141…1338，error="… helpdesk/open?id=6626260912531570952 (2200)"
最早 since=2026-11-08T17:37:48Z；最新 due 2026-11-14T02:12（= 本地 10:12，仍在重试）
health: instances[id=superagent].components.reply.state = error（2026-11-14T02:33:22Z）
```

**关键升级（2026-11-14 10:34 复测）**：用只读 `node:sqlite` 直接读活库，错误文本里带 **`(2200)`**——与 [feishu-reply-2200-rootcause-20261112.md](feishu-reply-2200-rootcause-20261112.md) 记录的 `server_error 2200` **同一个故障类**。也就是说：11-12 的修复只落在 HITL 侧发送器，**superagent 原生发送器这一侧从未修**。

含义：**你在这 5 天里"问了没回"的工单回执，飞书侧一条都没发出去**（这 15 条就是它们），失败点在发送参数（`--reply-in-thread`）而不是网络。

修复判据（做完要看这三条同时成立）：
1. `effect` 表中 `kind='reply' AND attempts>0` 的条数归零（要么发送成功，要么被显式标记为终态并记录原因）。
2. `.dsh/state/superagent-health/latest.json` 里 `instances[0].components.reply.state == ready`。
3. 新一条工单回执能在 30 秒内出现在对应飞书话题里，且 `effect.attempts` ≤ 1。

## 5. 如何避免（分层方案）

> 本节由独立设计 worker（`subagent_codex_astra` / `codex-relay` / `gpt-6-astra`，route `design-codex-astra`，receipt `receipt-design-feishu-76b6ab3b85dd`）产出，主控已逐条验收其代码级断言（见 §9 复核记录）。
> **本会话只交付设计与验收口径，不实施任何变更**（契约禁止重启/改配置）；实施属安装性变更，按 `AGENTS.md` §8 须同步 README 与装机引导。

### 5.0 三条设计原则（为什么是这几条）

1. **存活 / 就绪 / 送达 必须分开报**：把"心跳新鲜""入站已连""真的发出去了"合成一个绿色状态，正是本次三个故障全部被漏掉的原因。
2. **自动修复只允许"确认死亡才补起"**：不得按旧心跳或旧 PID 杀进程；不得把现有 `restart-feishu-daemon.ps1` 裸套定时任务——它缺互斥与进程身份核验（`restart-feishu-daemon.ps1:59-63` 只在"心跳新鲜且 inbound=running"时跳过启动，会给"活着但不健康"的 daemon 再起一份）。
3. **执行层用宿主计划任务**：这是本机唯一已被证明"沙箱外、无人值守也能跑"的通道——11-13 20:00/21:00/22:00 故障最严重时，`git-watchdog` 仍每小时落盘（`.ptc/logs/git-watchdog-20261113-200013-234.log` 等）。

### 5.1 最小可落地集（今天可做，不打断任何会话）

| 编号 | 措施 | 落点文件 | 判据 |
|---|---|---|---|
| **M1** | 只读外置健康探针，输出四层健康：daemon 心跳是否推进、入站是否 ready、进程身份/单实例、superagent `:3082` ready、`effect` 是否在重试 | 新增 `dsh-wechat-hitl/tools/test-feishu-health.ps1` | exit 0=ready / 1=unhealthy / 2=unknown；把不存在的 stateDir 喂进去必须返回 **2 而不是 0** |
| **M2** | MonitorOnly 监督计划任务（每 1–2 分钟，只观测不修复）：异常写 `state/feishu-supervisor.log` + 宿主通知（30s 确认、首次通知、15min 合并、恢复通知） | 新增 `tools/register-feishu-supervisor.ps1`，注册方式对齐 `dsh-git-watchdog-register.ps1`（Interactive / `IgnoreNew` / `StartWhenAvailable` / 上限 30 分钟） | `Get-ScheduledTask -TaskName DSH-Feishu-Supervisor \| Select State,Principal,Settings` 可核查；手工 `Start-ScheduledTask` 后日志出现一条 incident |
| **M3** | 修回信重试风暴（§4 的 D 故障）：去掉无条件 `--reply-in-thread`，并把 15 条历史 `reply` 效果显式转终态（记录原因） | `D:\src\dsh-superagent\src\channels\feishu-channel.ts:23` | §4 的三条判据（attempts>0 归零 / `components.reply=ready` / 新回执 attempts ≤ 1） |

M1 必须顺手修掉现有 `restart-feishu-daemon.ps1:44` 的 `Show-Status | Out-Null; exit 0`——状态分支吞输出且恒返回 0，**不能作为自动探针**。

> **M1 已实现（2026-11-14 10:55，根任务 `task-20261114T023457210275Z-e6f3f9d2a89c`）**
> 交付：`tools/test-feishu-health.ps1`（四层 / 0-1-2 三态 / unknown 不退化）、`tools/feishu-reply-health.mjs`（只读 sqlite 数回信重试）、`restart-feishu-daemon.ps1 -Action status` 三态修复、README §8 用法与 unknown 语义、自检 `test/test-feishu-health.ps1`（14/14）。
> 实测：生产环境返回 **unhealthy / exit 1**，原因是 L4 抓到真实回信重试风暴（pending=16、maxAttempts=1342、错误含 `(2200)`）——即 M1 已在报 D 故障；L1/L3 ready，L2 在沙箱内为 unknown（设计如此，正式运行在宿主或计划任务）。
> **M1 第二轮修正（2026-11-14 12:40，宿主实测驱动）**
> - 宿主首跑报 `instance: multiple-instances (35408 1732)` 属**探针误报**：35408 是 `cmd.exe /c` 包装壳，与 node 真身同刻启动。已改为只把"首个 token 是 node/bun"的进程算实例，壳记入 `wrappers`；真实数据复跑得 `count=1 matchedProcesses=2 wrappers=35408:cmd.exe`。
> - 同时修正时间戳时区：接口 `at` 是 UTC，人读曾把 `12:04:39+08` 显示成 `04:04:39`（误以为凌晨重启过）。现统一输出带偏移的本地 ISO。
> - 复跑顺带确认：superagent 宿主于 **12:04:14 本地**重启一次，之后 `runtime/feishu=ready`（12:04:39/43），**未复现** 11-13 17:47 的 `database is locked` → `feishu-watch pending`；但重启模式仍在（11-13 17:47、22:33、11-14 12:04），S4 的启动重试仍有必要。
> 自检 25 例全绿。
>
> 仍未做：M2（MonitorOnly 监督计划任务）与 S1–S6 加固；改动的 5 个文件尚未 commit。

### 5.2 完整加固集（有序，含依赖）

| 编号 | 措施 | 落点文件 | 关键改动 | 判据 |
|---|---|---|---|---|
| **S1** | 单实例与身份核验 | `tools/restart-feishu-daemon.ps1` + 新增 `feishu/feishu-supervisor.mjs` | 跨会话互斥 + daemon 终身单实例锁；用 machineId + 规范化 stateDir + PID **及其创建时间** + 完整入口识别（防 PID 复用）；已活但 degraded 只报障；身份不明/枚举被拒 **不启动** | 两个并发启动只剩 1 个 daemon；unknown 时绝不起新实例 |
| **S2** | 入站自愈 | `feishu/feishu-daemon.mjs:238-297` | 同步 throw + `child.on('error')` + `close/exit` 统一进一次性 failure handler（generation 防双触发）；瞬态退避 1/2/4/8/30/60s 带抖动，稳定后回收；`starting→ready` 必须由 `[event] ready` / `websocket: connected` 证据驱动；EPERM 连续 3 次转 `blocked:spawn`（带 `nextRetryAt`、低频复查、告警），**不要靠换启动方式逃逸沙箱**；同一时刻 child ≤ 1 | 注入 EPERM 后不再永久静默；error+close 只计一次；child 数恒 ≤ 1 |
| **S3** | 先装心跳再首次 drain | `feishu/feishu-daemon.mjs:329-334` | `setInterval(heartbeat)` 移到 `await tick()` **之前**；心跳写临时文件后原子替换，写失败落独立 stderr | 故意让首次 drain 挂起，心跳仍每 5s 推进（不被误判死亡） |
| **S4** | superagent 启动生命周期 | `src/app/runtime.ts:90-98`、`src/index.ts:21-24`、`src/app/store.ts`、`src/app/http.ts` | 保留目录锁；区分"合法占用 ELOCKED"与 SQLite BUSY/LOCKED；WAL/DDL 前设短 `busy_timeout`（100–250ms）；启动异步退避重试（1/2/4/8/15s，总 60s）后转 degraded 并每 5 分钟有限重试（**不能把 `logger.warn` 当终点**）；失败清理 DB 句柄/锁/timer；只对可安全重试的事务重放 | 锁释放后 **无需重启宿主** 即 runtime/feishu ready；持续冲突显示 degraded + `nextRetryAt` |
| **S5** | 心跳字段与在线语义 | `feishu/feishu-daemon.mjs` + `lib/hitl-store.js:3133-3141` | 心跳增加 `schemaVersion/machineId/instanceId/seq/childPid/inboundReadyAt/lastTransportAt/lastDrainAt/nextRetryAt/lastFailure`；`feishuDaemonAlive` 保留兼容并新增 `ready`（心跳新鲜 **且** inbound=ready **且** pid 存在）；普通 stderr 单列 diagnostic，`lastError` 不再塞 `connected` | spawn-failed/stale 不再显示绿色；时钟回拨判为 clock-skew 而非断线 |
| **S6** | 开机自启 + 告警出口 + 演练 | `tools/register-feishu-supervisor.ps1`、`docs/feishu-health.md`、`state/feishu-hitl-supervisor.json` | 开机触发 + 漏触发补跑；告警出口必须与 daemon/入站链路**独立**（宿主通知 + 另行授权的备用渠道），记录发送成功/失败与 incidentId；先 MonitorOnly，稳定后再开 Repair；必须验证"用户未登录也能起"（别把 AtLogon 冒充开机自启，别用 SYSTEM 替真账号） | 计划任务 `-Action Verify` 通过；故障演练只产生 1 个 incident 且有投递凭证 |

**顺序与依赖**：M1 → M2 → S1 → S3 → S2 → S4 → S5 → S6。
S1 落地前**不得**给现有 start 脚本挂定时任务；S2/S3 属 daemon 代码，切换须走通道维护窗口（先排空发件箱、优雅关入站 stdin 等 close、再替换），**不重启 DSH**；S4 需先在隔离 profile 验证，且生产侧要等无活动会话。

### 5.3 为什么"只做 M2（定时重启）"不行

定时重启是"用重启掩盖故障"：它会把 S1 的重复实例风险、S2 的入站永久失效、S4 的编排器 pending 都变成"每 N 分钟重启一次"的假稳定，且重启时正在跑的发件箱条目与入站事件可能丢。只有"观测先行 + 确认死亡才补起 + 分层健康"能同时解决 A/B/C/D 四类。


## 6. 飞书通道健康自检清单（照抄即可）

```powershell
# ① HITL 守护进程：是不是活的、入站是不是在跑
Get-Content D:\src\dsh\dsh-wechat-hitl\state\feishu-daemon.json | ConvertFrom-Json |
  Select-Object pid, startAt=@{n='startLocal';e={[datetimeoffset]::FromUnixTimeMilliseconds($_.startedAt).ToLocalTime()}},
                tickAt=@{n='tickLocal';e={[datetimeoffset]::FromUnixTimeMilliseconds($_.tickAt).ToLocalTime()}},
                inbound, lastError
# 期望：inbound=running；tickLocal 距今 < 15s；对应 pid 真实存在
Get-Process -Id (Get-Content D:\src\dsh\dsh-wechat-hitl\state\feishu-daemon.json | ConvertFrom-Json).pid -ErrorAction SilentlyContinue

# ② 出站最近是否真的发出去过（不是只有心跳）
Select-String -Path D:\src\dsh\dsh-wechat-hitl\state\hitl.log -Pattern '"op":"(outbox-sent|feishu-send)"' | Select-Object -Last 3

# ③ 入站是否真的收到过（这是 B 故障的判据，心跳看不出来）
Select-String -Path D:\src\dsh\dsh-wechat-hitl\state\hitl.log -Pattern '"op":"feishu-inbound"' | Select-Object -Last 3

# ④ superagent 编排器与 feishu-watch（必须带这个头）
Invoke-RestMethod -Uri http://127.0.0.1:3082/orchestrator/api/state -Headers @{ 'X-Orchestrator-Request' = '1' } |
  Select-Object runtime.state, feishu.state, setup.feishuProblem
# 期望：runtime.state=ready 且 feishu.state=ready 且 feishuProblem=$null

# ⑤ 有没有卡死的回信
python - <<'PY'
import sqlite3, os
p = os.path.expanduser(r"~/.dsh/state/superagent/orchestrator.sqlite")
c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
print(c.execute("SELECT kind, attempts, substr(error,1,80), due FROM effect WHERE attempts>0").fetchall())
PY
# 期望：空列表
```

失败含义：①不满足 = 守护进程死了（本次 A）；①②都满足但③为空 = 入站静默死亡（本次 B）；④不满足 = 编排器/feishu-watch 未激活（本次 C）；⑤非空 = 回信在无限重试（本次 D）。

## 7. 明确不要做

1. **不要在受限/沙箱会话里启动或重启飞书 daemon**：`spawn EPERM` 会让"入站"永久失效且不重试（本次 B 就是这么来的）。必须在**宿主 PowerShell / 计划任务 / 桌面快捷方式**这一层执行。
2. **不要用 `kill -9` / `Stop-Process -Force` 停 daemon**：`lark-cli event consume` 自身提示 `kill -9` 会跳过清理并可能泄漏服务端订阅；应发 SIGTERM（Windows 下用不带 `/F` 的 `taskkill`，或让脚本走优雅路径，从而留下 `feishu-daemon-stop` 痕迹）。
3. **不要在活动 profile 上热改插件/依赖**：会热重载层栈并打断该宿主上所有在跑会话。
4. **不要并发起第二个 daemon**：两个实例会抢同一份 `pending.json` 与同一事件订阅（当前 `restart-feishu-daemon.ps1` 只在"心跳新鲜 **且** inbound=running"时跳过启动，见 5.x）。
5. **不要用"心跳新鲜"当唯一在线判据**：它会把 `spawn-failed` 判成在线。

## 8. 限制与未验证项

1. **19:58:03 的杀进程者未定位**：没有 Windows 进程审计/命令行审计，无法证明是哪个 shell/会话/工具执行的终止。本报告只能排除"优雅退出、崩溃留痕、机器重启、宿主崩溃"四类，并指出 `Stop-Process -Force` 类操作天然零痕迹。
2. **superagent `database is locked` 的锁持有者未查明**：worker 复核指出当前代码是先 `lockSync(stateDir)` 再 `new Store`，且未设 `busy_timeout`；因此更可能是"旧实例未完全退出 + 无启动重试"，但不能断言锁持有者。要根治需做启动顺序与 `busy_timeout` 处理，而非简单"加锁"。
3. **CIM `Win32_Process` 枚举在本沙箱内被拒（Access denied）**，因此"当前机器上到底有几个 daemon 实例"无法在本会话内证明，需在宿主 PowerShell 用 `Get-CimInstance Win32_Process` 复核。
4. **本次未做任何写入型修复**：所有方案均为建议；`reply` 重试风暴仍在进行。
5. `profiles/web/cordis.patch.yml` 今日 09:45:01 被就地重写一次（内容仍是 42508 字节，`wechat-hitl` 挂载与 11-13 一致，无对应 `.bak`）；成因未查，不影响本次结论。
6. 计划任务细节（`DSH-Git-Watchdog` 的注册参数）在本沙箱内 `Get-ScheduledTask` 返回"拒绝访问"，只能从 `.ptc/logs/git-watchdog-*.log` 每小时落盘这一事实反推"外部调度器在跑"。

## 9. 证据附录

| 证据 | 位置 | 关键内容 |
|---|---|---|
| 出站断点 | `dsh-wechat-hitl/state/hitl.log` L37780–37781 | `11:58:03.488Z outbox-sent` → `14:33:46.995Z feishu-daemon-start pid=1732` |
| 入站 EPERM ×4 | 同上 L34829、L35004、L35062、L35237 | `"op":"feishu-inbound-error","stage":"spawn","error":"Error: spawn EPERM"` |
| 最后一次健康入站 | 同上 L33634–33635 | `2026-11-09T10:37:37Z feishu-inbound-start pid=24772` |
| 无优雅退出 | 同上，全量 `op` 直方图 | 无 `feishu-daemon-stop`、无对应时刻的 `feishu-inbound-exit` |
| 无 stderr 痕迹 | `state/feishu-daemon.out` | 0 字节，mtime 11-10 22:16:29 |
| 恢复后重放 | `hitl.log` `op:feishu-inbound` | 事件 `timestamp` 1794563816835（17:56:56）→ 投递 11-14 01:02:17；1794579907483（22:25:07）→ 投递 23:30:22 |
| 早退分支 | `feishu/feishu-daemon.mjs` 238–297、318–334 | spawn 失败即 return；仅 SIGINT/SIGTERM 写 stop；`setInterval(heartbeat)` 在 `await tick()` 之后 |
| 唯一启动入口 | `tools/restart-feishu-daemon.ps1` 46–55、59–63、97–99 | stop 用 `Stop-Process -Force`；仅"心跳新鲜且 inbound=running"才跳过启动；承认受限会话会 spawn-failed |
| 在线判据 | `lib/hitl-store.js` 3132–3134 | `feishuDaemonAlive(maxAgeMs=30000)` 只看心跳年龄 |
| 编排器/feishu-watch 未激活 | `profiles/superagent/.artifacts/service-20261113T174757.err.log` | `dsh-superagent: Error: database is locked`；`feishu-watch: pending (waiting for service: orchestrator)` |
| 回信卡死 | `~/.dsh/state/superagent/orchestrator.sqlite` `effect` | 15 条 `reply`，attempts 141–1333，`helpdesk?id=66262` |
| 健康信号已存在但不告警 | `~/.dsh/state/superagent-health/latest.json` | `instances[0].components.reply.state=error` |
| 同类故障历史 | `docs/ops/feishu-reply-2200-rootcause-20261112.md` | `sync_to_chat_info` + `--reply-in-thread` → `server_error 2200` |
| 外部调度器可用 | `.ptc/logs/git-watchdog-20261113-190014/200013/210012/220013` | 20:00/21:00/22:00 每小时仍在跑（沙箱外） |