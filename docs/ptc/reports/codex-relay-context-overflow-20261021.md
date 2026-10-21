# codex-relay/gpt-6.1-sol「上下文超限」整轮失败的取证与根因（2026-10-21）

- 取证对象：会话 `session-91ead7d3-c703-4b2d-b072-0897d6163637`（工作区 `D:\src\ncbs\ca-docs\治理数据标准治理`），turn 55
- 触发答复：`pi-ai detected context overflow for model "gpt-6.1-sol"` → `code: CONTEXT_WINDOW_EXCEEDED` → `turn/end { kind: "error" }`
- 取证工具：本仓库 `.ptc/scan-sessions2.mjs`、`.ptc/dump-session.mjs`、`.ptc/analyze*.mjs`（拼接式 zstd 帧解码，复刻 `dsh-session-persistence-jsonl` 的 `scanZstdFrames`）

## 一、一句话结论

这**不是真的上下文溢出**，而是**声明的窗口小于实际占用**导致的误判：`codex-relay` 的模型条目没有声明 `contextWindow`，DSH 回落到 `DEFAULT_CONTEXT_WINDOW = 262144`；而该会话当时的 prompt 占用已达 **353,728 tokens**，上游 relay 照常受理并给出完整回答。pi-ai 的「静默溢出」判定（`stopReason === 'stop'` 且 `input + cacheRead > contextWindow`）把这次成功回答改判成上下文超限，整轮就此失败；compaction 的自动恢复因为**自己的摘要请求同样以 `stop` 结束、占用同样超声明窗口**，每一次都撞同一个判定，于是反复重试 22 次、耗时约 45 分钟后放弃。

## 二、证据链

### 2.1 关键时间线（本地时间 UTC+8）

| 时刻 | 事件 | 证据位置 |
| --- | --- | --- |
| 10-20 21:17 | turn 55 开始 | `turn/start` seq(turn=55) |
| 10-20 23:52 | turn 55 内第一次 compaction 失败 | `compaction/end { error } ` |
| 10-21 00:35:53 | 最后一次上游过载重试（SERVER 1/5） | `notices.jsonl` n64 |
| 10-21 00:36:28 | 模型完成回答（output 2,490 tokens）却被判 overflow | `assistant/attempt` seq 7256 |
| 10-21 00:37:37 | 整轮以 `CONTEXT_WINDOW_EXCEEDED` 结束 | `turn/end` seq 7260 |

- turn 55 共 43 个 step，总时长 **200.6 分钟**；其中 **22 次** compaction 失败集中在最后约 45 分钟——即用户感知到的「停住了」。

### 2.2 终端失败那一步的真实内容（seq 7256，step 43）

```json
{"type":"finish","reason":{"kind":"error","failure":{
  "message":"pi-ai detected context overflow for model \"gpt-6.1-sol\"",
  "code":"CONTEXT_WINDOW_EXCEEDED"}},
 "replayState":{"response":{"api":"openai-responses","provider":"codex-relay",
   "model":"gpt-6.1-sol","responseId":"resp_094cbf50e4769db6016ad798713e988196842b787d6bb087bf",
   "stopReason":"stop"}}}
usage: {"inputTokens":192,"outputTokens":2490,"totalTokens":356218,"cacheReadTokens":353536}
```

要点：

1. `responseId` 存在、`stopReason: "stop"`、output 2,490 tokens → **上游已经完整生成回答**，请求并没有被拒绝；
2. `input + cacheRead = 192 + 353,536 = 353,728`，远超声明窗口 262,144；
3. failure.message 是 DSH 的**兜底文案**（`mapStopReason` 里 `message.errorMessage ?? \`pi-ai detected context overflow for model ...\``），说明触发的是 **pi-ai 的 usage 型静默溢出**分支，而不是上游返回的报错文本。

### 2.3 声明窗口的来源

| 位置 | 值 | 说明 |
| --- | --- | --- |
| `profiles/web/cordis.patch.yml` `codex-relay.models[*]` | 无 `contextWindow` | 只声明了 `reasoningEfforts` |
| `dsh-llm-pi-ai/lib/index.js:927` | `DEFAULT_CONTEXT_WINDOW = 262144` | 目录与配置都没给窗口时的回落值 |
| 会话 `request/context` 事件 | `codex-relay/gpt-6.1-sol → contextWindow: 262144` | 运行时实测值，seq 294/6366/6900/7058 |
| 同模型官方档 | `openai-codex/gpt-6.1-sol → 500000` | pi-ai 目录命中，seq 6128/6908 |

即：同一份会话在 `openai-codex`（声明 500k）下不会误判；一旦故障转移到 `codex-relay`（未声明 → 262,144），353k 的 prompt 立刻「超窗」。

### 2.4 为什么 failover 没有接住

- `codex-relay` 在 turn 55 期间确实频繁返回上游过载：`server_error: Our servers are currently overloaded. Please try again later.`（`PI_AI_ERROR`）。
- 插件按 `failurePatterns: 'overloaded'` 折算成 `SERVER`，并在原地重试（`retryPolicy.SERVER = 5 次 × 5s`），`notices.jsonl` 里有 n53–n64 共十余条 `kind:"retry"` 记录 → **过载这一类它确实 handle 了**。
- 但对 `CONTEXT_WINDOW_EXCEEDED` 是**刻意不切换**：`index.js:946` `isSwitchable` 直接返回 `{hit:false, category:'context', reason:'上下文窗口超限；切换密钥无效，请缩短上下文或先压缩。'}`（README 第 44、237 行同义）。换 provider/换 key 确实缩短不了历史，这条策略本身没错。
- 结论：**failover 的行为符合设计；错的是被判成 overflow 这件事本身**。用户感觉「应该有 handle」，实际上这里需要的不是切换，而是不要把成功回答判成 overflow。

### 2.5 为什么 compaction 反复重试也救不回来

`compaction-basic` 的恢复路径（`lib/index.js:861-887`）在收到 `CONTEXT_WINDOW_EXCEEDED` 后调用 `compactIfNeeded(agent,'context-overflow')`：先 `toolResultPruner` 剪枝，再 `selectCompactableRange(..., retainTokens=0)` 选出几乎整段历史，然后 `summarizeWithLlm` **把这段历史原样重放**并追加压缩指令（`lib/index.js:292-338`）。

后果：摘要请求的 prompt 就是「整段历史 + 指令」，占用仍然 > 262,144；它同样以 `stop` 结束 → 同一个静默溢出判定 → `compaction/end { error: "pi-ai detected context overflow ..." }`。22 次尝试里 14 次是这个错，另外 8 次是上游过载（`server_error`）。

结构性限制：**当会话本身已超出（声明的）窗口时，这种「重放前缀 + 追加指令」的摘要方式永远不可能成功**——它要压缩的正是它必须发送的内容。它只适用于「剪枝后已经低于窗口、只是阈值触发」的场景。

另一个放大问题：`maxOverflowRetries` 只在**成功压缩**后才自增（`lib/index.js:877/885`），失败分支不自增。于是每次 step 都重新尝试一遍注定失败的压缩，turn 内表现为长耗时「假死」，而不是快速失败。

## 三、修复建议（未执行，等确认）

### 3.1 主修：给 codex-relay 模型声明真实窗口

`profiles/web/cordis.patch.yml` 的 `codex-relay.models` 逐条补 `contextWindow`（至少 `gpt-6.1-sol`，同族的 `gpt-5.6-sol / gpt-6-sol / gpt-6-luna` 同理）：

```yaml
          - id: gpt-6.1-sol
            name: GPT-6.1 Sol
            contextWindow: 400000      # 实测已受理 353,728 prompt tokens；取 400k 留余量
            maxTokens: 32768
            reasoningEfforts: { minimal: minimal, low: low, medium: medium, high: high, xhigh: xhigh, max: max }
```

注意事项：

- `maxTokens` 会作为 compaction 的输出预留预算参与 `messageBudget = contextWindow - reservedCompletionTokens`；不要随手把它写成几十万，否则压缩阈值会被推得很高。
- 声明后阈值约为 `min(0.8 × window, window - maxTokens - headroom 65536)`；400k 窗口下约在 320k 触发压缩，正好落在本次 353k 之前。
- 真实上限未知：目前只证明 ≥353,728 被受理。建议单独做一次阶梯探测（或用网关文档确认）再定 400k / 500k。
- 改配置属 profile 变更：按 AGENTS.md 先备份 `cordis.patch.yml`（`.bak-before-*`），改后重启 DSH 新开会话验收（工具表/模型目录在启动时生成）。

### 3.2 可选：failover 侧加一条「容量感知」护栏

切换候选时若目标路由的声明窗口小于当前会话的实测占用（可从 `request/context` + usage 估算），跳过该候选。本次正是「从 500k 档切到 262k 档」把健康会话推进了误判区。

### 3.3 可选：把这类失败从「必然重试」改成「快速失败 + 明确提示」

- compaction：失败分支也计入 `maxOverflowRetries`；或当「摘要请求 prompt 仍超窗口」时直接放弃并抛出可判读的错误，避免每 step 重放几十万 token。
- 建议向 DSH 上游反馈：`mapStopReason` 的 usage 型静默溢出分支在「上游实际受理了请求」时应降级为警告（例如同时满足 `output > 0` 且 `stopReason === 'stop'` 时视为成功），否则「小窗口声明 + 大窗口上游」必然误杀完整回答。

## 四、验证清单（修复后）

1. `request/context` 事件里 `codex-relay/gpt-6.1-sol` 的 `contextWindow` 变为新值；
2. 用 30 万级 token 的会话跑一轮「以 `stop` 结束」的收口，确认 `turn/end` 不再是 `CONTEXT_WINDOW_EXCEEDED`；
3. `compaction/summary` 能在阈值处成功落盘，`compaction/end` 不再出现 `context overflow`；
4. `notices.jsonl` 中出现 `kind:"switch"` 时，目标路由的窗口不小于当时占用。

---

## 五、实施记录（2026-10-21，已执行）

### 5.1 变更内容

`profiles/web/cordis.patch.yml` → `config.providers.codex-relay.models`：为 9 个模型补 `contextWindow`，并在 `models:` 下写入 8 行「上下文窗口声明规则」注释（防回归）。

| 模型 | 新增 contextWindow | 依据 |
| --- | --- | --- |
| `gpt-6.1-sol` | **500000** | pi-ai 官方同 id 目录（`providers/data/openai-codex.json` → 500000） |
| `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-luna` / `gpt-6` / `gpt-5.6` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` | 272000 | 同上目录，该族官方统一 272000 |

未声明的两个：`gpt-5.4-mini`、`codex-auto-review`（pi-ai 目录未收录、未实测），继续走 `DEFAULT_CONTEXT_WINDOW`；补录前不要用它们跑长会话。

### 5.2 备份与校验

- 备份：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml.bak-before-codex-relay-context-window-20261021T013800`
- 差异：`+17` 行（9 行 `contextWindow` + 8 行注释），无其它改动
- `python -c yaml.load(...)`（注册 `!` 多构造器）：解析通过，`[10]/config/providers/codex-relay/models[*]` 的窗口值与上表一致
- `dsh --profile web --dump-config`：exit 0，合成树中 `gpt-6.1-sol.contextWindow = 500000`
- 回滚：把上述 `.bak-before-*` 覆盖回 `cordis.patch.yml` 并重启

### 5.3 生效条件（尚未完成）

模型目录在 **DSH 启动时**构建，当前进程仍持有旧值（262144）。需要：

1. 停掉当前 `dsh web`；
2. 用同一入口重启：`pwsh -File D:\src\dsh\dsh-permission-compat\tools\dsh-web-safe.ps1`（会重放并校验宿主 compat 补丁，幂等）；
3. 用新打印的 `?token=…` 地址重开页面；
4. 按第四节 1–3 条验收（第 4 条在看到一次真实 `switch` 时检查）。

