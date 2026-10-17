# Resilient ACP Subagent Provider

`@local/dsh-subagent-acp-resilient` 是 `@deepseek-ai/dsh-subagent-acp` 0.2.0-rc.2 的替换实现：
沿用同一套 subprocess / ACP seam 与同一份对外契约，补上**分级超时、动态活动检测、有界拆除、
成果保护与恢复记录**。它解决的是这样一类故障：子进程已经在改文件，父会话却永远拿不到结果。

## 为什么需要它（上游 0.2.0-rc.2 的真实缺陷）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 没有任何超时字段（`startupTimeoutMs` 等 YAML 键会被 schemastery **原样透传但不生效**） | 写在 YAML 里的超时参数是空的，故障时无任何边界 |
| 2 | `disposeAcpChild` 在 `terminate()` 之后 `await child.waitForExit()`，无 signal、无上限 | 子进程留下后代占住 managed range 时 `dispose()` 永不返回 → tool 调用永不返回 |
| 3 | prompt 只与 watchdog / cancel 赛跑，**不与子进程退出赛跑** | 子进程写完文件就退出（Windows 管道不上报 close）时，`session/prompt` 一直挂着，直到硬上限 |
| 4 | `markActivity('process-exit')` 把子进程死亡当作“有进展” | 检测延迟最多一个 `idleTimeoutMs` |
| 5 | 超时路径调用 `requestCancel()` 会把 `flags.cancelled` 置位 | `settleRunResult` 返回 `aborted` 并**丢弃诊断**，已改动的文件对模型完全不可见 |
| 6 | `dsh-tool-subagent` 未声明 `timeoutMs` | `dsh-tool-call-timeout-policy` 不会为子代理调用武装任何 deadline，provider 是唯一边界 |

## 分级超时阶梯

全部可配置，默认值即生产值；不合法组合在**加载时**被拒绝，而不是等到第一次超时。

| 档位 | 键 | 默认 | 说明 |
|---|---|---|---|
| 进程启动 | `processStartTimeoutMs` | 30s | 必须收到**首个入站 ACP 帧**；用于抓“启动了但没到达 agent”的 shim/launcher |
| 会话建立 | `startupTimeoutMs` | 60s | `initialize` 到 `session/new` 应答 |
| 空闲告警 | `idleWarnMs` | 3min | 只告警，**不失败** |
| 空闲升级 | `idleTimeoutMs` | 10min | 无“被证实的进展”则升级 deadline |
| 普通软超时 | `softTimeoutMs` | 10min | 仅在**进展未被证实**时命中 |
| 普通硬上限 | `absoluteTimeoutMs` | 20min | 普通阶梯天花板 |
| 复杂软超时 | `complexSoftTimeoutMs` | 20min | 一次有据升档后使用 |
| 复杂硬上限 | `complexHardTimeoutMs` | 45min | 复杂阶梯天花板 |
| 活动重检量子 | `activityExtensionMs` | 15s | watchdog 重检间隔，也是“近期进展”的判定窗口 |
| 活动探测间隔 | `activityProbeMs` | 30s | 工作区指纹采样的最小间隔 |
| 退出结算窗 | `exitSettleMs` | 3s | 观测到退出但 prompt 仍挂起时的最后读取窗口 |
| 超时结算窗 | `recoverySettleMs` | 5s | 超时后、拍快照前的等待 |
| 拆除上限 | `disposeEofGraceMs` / `disposeGraceMs` / `disposeFinalGraceMs` / `disposalTimeoutMs` | 6s / 3s / 10s / 30s | 四级有界拆除 |

约束（加载时校验）：`processStartTimeoutMs ≤ startupTimeoutMs`、`softTimeoutMs ≤ absoluteTimeoutMs ≤ complexHardTimeoutMs`、
`complexSoftTimeoutMs ≤ complexHardTimeoutMs`，所有数值必须为正的有限数且不超过 `MAX_TIMER_DELAY_MS`。

**`idleWarnMs > idleTimeoutMs` 不报错，而是钳制到 `idleTimeoutMs` 并打告警。** 理由：该档纯告警、永不导致失败，
钳制是唯一安全解；这样旧配置（例如 bundle 里只写了 `idleTimeoutMs: 120000`）仍然能加载，
**部署顺序因此无关紧要**——先换插件还是先换配置都不会丢掉整行 provider。
其余四条约束会改变"运行何时被判死"，因此仍然硬失败。

## 动态活动检测：不会仅凭“长时间没输出”判失败

进展由**两个独立证人**判定，任一成立即算有进展：

1. **ACP 事件** —— 任何 `session/update` 通知（含 `agent_thought_chunk`）与权限请求；
2. **工作区指纹** —— 每 `activityProbeMs` 至少一次的有界快照对比（跳过 `.git` / `node_modules` / `.ptc`），
   基线每次探测后刷新，所以“有进展”永远指**近期**变化，而不是“自启动以来变过”。

watchdog 的判定顺序是 **硬上限 → 空闲 → 软超时**，且软超时/空闲档都要求
`idleFor <= activityExtensionMs` 即“近期无进展”才允许命中。真正的进展还会触发**一次**有据升档到复杂阶梯。

## 结果一定回传

- prompt 与四个对手赛跑：watchdog 阶梯、**子进程退出观测**、调用方取消、`session/prompt` 应答。
- 子进程退出但未应答：等 `exitSettleMs` 读完在途字节，然后以 `stopReason: 'error'` 结算（**绝不谎报 completed**）。
- 超时路径走 `requestRemoteCancel()`（发 `session/cancel` 但**不置位 `flags.cancelled`**），
  这样 `settleRunResult` 会保留诊断而不是把它换成一句 `aborted`。
- `dispose()` 永远在有界时间内返回 `{quiesced, failures, waitedMs, childProvenStopped}`。
  子进程**已被证实退出**时，即使后代仍占住 managed range，也只记录为 `stopped-with-survivors` 并保留结果；
  只有子进程本身从未被证实停止才抛错。

## 超时后保护成果

诊断文本包含：命中档位、超时种类、已耗时、空闲时长、最后活动、空闲告警次数、
退出结算时长、恢复状态、**改动文件数**、改动到的测试文件、进程结果、managed range 是否已空、测试线索。

- 不改回滚：已有改动**永不**自动回滚。
- **工作区守卫**：某个 cwd 的上一个 ACP 子进程未被证实停止（`unproven-stopped`）时，
  `guardWorkspaceReuse: true`（默认）会拒绝在那个 cwd 再起一个写入型 ACP 子代理，
  避免两个 agent 同时改一棵树。已退出但残留后代的情况只记录、不阻塞，以免造成会话内永久锁。
- **恢复记录**：每次超时/异常结算都会在 `recoveryRecordDir`（默认 `$DSH_HOME/acp-recovery`）
  写一条无正文内容的 JSON，供会话之外事后取证。
- 逃生口：`guardWorkspaceReuse: false`，或重启 DSH（守卫是进程内状态）。

## 配置

```yaml
- insert:
    - id: subagent-acp-cursor
      name: '@local/dsh-subagent-acp-resilient'
      config:
        providerName: cursor-grok
        # Windows：cursor-agent / opencode 在 PATH 上只有 .cmd/.ps1 shim，没有 .exe。
        # 裸名做 command 会 spawn 失败（ENOENT / EINVAL），必须经 cmd /c 包装。
        command: cmd
        args: [ '/c', 'cursor-agent --model auto acp' ]
        permission: allow
        processStartTimeoutMs: 30000
        startupTimeoutMs: 60000
        idleWarnMs: 180000
        idleTimeoutMs: 600000
        softTimeoutMs: 600000
        absoluteTimeoutMs: 1200000
        complexSoftTimeoutMs: 1200000
        complexHardTimeoutMs: 2700000
        activityExtensionMs: 15000
        activityProbeMs: 30000
        exitSettleMs: 3000
        recoverySettleMs: 5000
        guardWorkspaceReuse: true
```

### 未声明键会静默失效（务必注意）

schemastery **不校验未知键**，会原样透传。因此拼错一个超时键不会报错，只会**不生效**。
本 provider 会对“形状像保护参数但未声明”的键打出 `INERT` 告警；`test/config.test.mjs`
把 `DECLARED_CONFIG_KEYS` 与 schema 锁死，防止两边漂移。

### 本机实测基线（2026-10-14，`cursor-agent --model auto acp`）

`initialize` ≈ 1.5s、`session/new` ≈ **28s**、最简单的“只回一个词”prompt 往返 ≈ **24s**，
一次完整往返 ≈ 53s。opencode ≈ 8.6s、kimi ≈ 9.5s。**不要**把会话建立档调到 30s 以下。

## 非阻塞调度（推荐用法）

不要用前台等待让父会话阻塞在一个慢外部 agent 上。`tool-subagent` 已支持受托管的后台执行：
调用 `subagent_*` 时带 `run_in_background: true`，它会创建一个 `ctx.jobs` Task，立即返回 job id，
完成时再通知父会话。ACP 没有 `prepareContinuable`，所以 `backgroundMode` 必须是 `one-shot`
（设成 `continuable` 会在加载时抛错）。

## 安装（另一台设备）

已发布为私有仓库并钉了 annotated tag，**仓库根即包根**：

```powershell
dsh plugin --profile <profile> add github:Robert-Wang-08/dsh-subagent-acp-resilient#v0.2.1
```

已实测：从该 tag 全新安装可解析（+31 包）、模块可导入、默认阶梯为 30s/60s/10min/45min。
运行时依赖（`@agentclientprotocol/sdk`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-brand`）
与各 peer 均可从公共 npm 解析。

**插件本体不等于配置。** `cordis.patch.yml` 里的 `subagent-acp-*` provider 行、PTC bundle、
以及各档 tier 值都必须在该设备另行就位，否则插件装上了也没有 agent 可用。
`dsh-config-pack` 的 PTC companion 模板是这条路的分发载体。

**事实源与发布的关系：** 工作区 `D:/src/ynm3000` 里的这份是事实源，跨设备安装用的独立仓库
由它单向镜像而来：

```bash
git subtree split --prefix=dsh-subagent-acp-resilient -b acp-publish
git push https://github.com/Robert-Wang-08/dsh-subagent-acp-resilient.git acp-publish:main
```

改完要重新推，否则独立仓库会落后于事实源（**它不会自动同步**）。

## 测试与诊断工具

```bash
node --test --test-timeout=20000 --test-reporter=tap test/config.test.mjs test/resilience.test.mjs
node tools/probe-acp.mjs --command cmd --args /c --args "cursor-agent --model auto acp"
node tools/e2e-cursor-acp.mjs --budget-ms 420000
node tools/scan-session-log.mjs "$DSH_HOME/sessions"
```

- `test/resilience.test.mjs` —— 11 个行为用例（正常完成、改完文件后迟到应答、退出却无应答、
  部分完成后软超时、拆除无法证实有界且有守卫、静默但有进展、空闲告警不失败、取消仍为 aborted、
  进程启动与会话建立分档、cwd 不存在在加载期被拒、子进程已退出但残留后代不阻塞）。
- `test/config.test.mjs` —— 配置完整性：声明键与 schema 互不漂移、默认阶梯、INERT 告警、非法组合被拒。
- `tools/probe-acp.mjs` —— 对真实 agent 的分档探针，把“没启动 / 会话卡住 / 只是慢”分开。
- `tools/e2e-cursor-acp.mjs` —— 走真实 provider 代码路径驱动真实 Cursor ACP 的端到端验证。
- `tools/scan-session-log.mjs` —— 解压扫描 DSH V4 会话日志，找历史故障形态。

## 版本

见 `package.json` 的 `metadata` 戳（`origin: self` / `managed-by` / `version`）。
