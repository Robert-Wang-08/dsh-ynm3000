# kimi 额度耗尽未切换 provider —— 本地 DSH failover 取证报告

- 时间：2026-10-23 11:48–12:04（Asia/Shanghai，UTC+8）
- 目标会话：`session-78456a12-8cad-463b-bbb1-881769cfe5a2`（工作区 `D:\src\ncbs`）
- 插件：`dsh-deepseek-keypool` 3.5.0（`D:/src/dsh/dsh-provider-failover`，link 登记进 web profile）
- 结论：**failover 没有“失效”，它在候选耗尽时按设计原地放弃**；真正的问题是「一次网络抖动 + 一次额度耗尽就把整条梯子冷却清空」，且“无候选”这条决策只留在内存里，会话和 notices.jsonl 都看不到。

## 1. 现场证据

### 1.1 目标会话日志（session.v4.jsonl.zstd 解压后）

```
turn 181 step 18  assistant/attempt  finish=failure{code:"QUOTA",
  message:"429 {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"You've reached your 5-hour usage limit...\"}}"}
turn 181 step 18  step/end  ->  turn/end reason=error QUOTA   （无任何 llm/retry，无 failover）
turn 182 step 1   system/message  "当前模型为 gpt-6.1-sol"    （用户手工改选 openai-codex）
turn 182 step 1   assistant/attempt  fetch failed (TRANSPORT) ×5  无切换
```

- 11:52:32 的 QUOTA 之后，宿主没有重试、没有切换，整轮直接报错结束。
- 12:04:25 `kimi-coding/k3-256k → openai-codex/gpt-6.1-sol` 被记录为
  `kind=manual-switch, trigger=observed:route-change`，即**这是人工改选**，不是插件切的。
  （插件只在 `agent/request` 钩子里观测 base 变化并补记这条通知，见 index.js:2323-2340。）

### 1.2 插件 notices.jsonl（3 条关键记录）

```
11:26:24  failover  SERVER       codex-relay -> kimi-coding   (tier 1)
11:48:15  （无 failover 记录，opencode-go 被判 no-candidate，只写冷却）
11:52:32  （无任何记录 ← 就是“看起来没切换”的那一刻）
```

### 1.3 决定性证据：内存 ignored 环（GET http://127.0.0.1:3080/provider-failover/status）

```json
{"at":1792727552695,"session":"session-78456a12-...","provider":"kimi-coding",
 "category":"no-candidate",
 "reason":"可切换失败已确认，但档位表中没有可用候选（已尝试/冷却中/能力不兼容/不可解析）。",
 "code":"QUOTA","message":"429 ... You've reached your 5-hour usage limit ...",
 "turn":181,"step":18}
```

→ 插件**判定为可切换**（QUOTA ∈ failurePolicy.switchOn），并真的去选候选了，
只是 `pickCandidate()` 返回 `undefined`（index.js:2596-2611），于是 `next()` 交回宿主。

### 1.4 为什么一个候选都没有：五条路由同时冷却

冷却时长 = `cooldownByCode[code]` 优先，否则回退**条目**的 `cooldownMs`（`route-config.json` 里每条都是 1800000 = 30 分钟），
只有 QUOTA 被 `cooldownByCode` 抬到 5 小时（index.js:483-494）。

11:52:32 那一刻的全局冷却表（本次事件推导 + 当前 `/status.cooling` 交叉核对）：

| 路由 | 冷却来源 | 冷却到 | 11:52:32 可用？ |
| --- | --- | --- | --- |
| codex-relay | SERVER 502（11:26:24） | 11:56:24 | 否 |
| openai-codex | TRANSPORT（11:24:41） | 11:54:41 | 否 |
| kimi-coding | 本次失败路由本身 | 11:57:12 | 否 |
| ais-2dsglm | QUOTA 403 quota_exceeded（10:37:36） | 15:37:36 | 否 |
| opencode-go | TRANSPORT（11:48:15） | 12:18:15 | 否 |

即：10:37 起 ais 因额度耗尽退出 5 小时；11:24–11:48 的一串
`Connection error.` / `terminated` / `fetch failed`（同机网络抖动）把另外四条各自冷却 30 分钟；
到 kimi 报额度时，**整条梯子（tier1+tier2）无一条可用**。12:04 用户改选 openai-codex 后
它同样 `fetch failed`，此时冷却仍未过期，于是再次 `no-candidate`。

## 2. 缺陷清单（按严重度）

1. **冷却粒度与故障性质不匹配（主因）**：`TRANSPORT`/`SERVER` 这类瞬时故障也吃 30 分钟
   条目冷却，只要连续几跳抖动就能把五条路由一起冻住。瞬时类应降到 60s 级，重试预算（5×5s）已经够兜底。
2. **“无候选”不进任何持久化/会话可见通道**：只写 `state.ignoredLog`（内存，上限 50，不落盘、
   不推会话）。代码注释写着“没有可用候选也是决策，必须留痕”，实际留痕不出内存 →
   用户看到的就是“bare 429，疑似 failover 失效”。
3. **失败即冷却，即使最终没切走**：冷却写入（index.js:2564-2570）在 `pickCandidate` 之前，
   所以一次“根本没换供应商”的失败仍然延长了该路由的不可用时间（opencode-go 就是这样被冻的）。
4. **冷却被更短的冷却覆盖**：`set()` 直接覆盖，不取 max。codex-relay 10:38:46 因 QUOTA 被判 5 小时冷却，
   11:26:24 一条 SERVER 就把它改写为 30 分钟——额度已死的路由 30 分钟后会被重新捡回，打一次再冻一次。
5. **`failurePolicy.transportRetries: 1` 是死配置**：`readLocalRouteConfig()`（index.js:512-528）只读取
   `tiers / switchOn / maxSwitchesPerTurn / cooldownByCode`，`transportRetries` 从不生效；
   实际生效的是内置 `retryPolicies.TRANSPORT.attempts=5`（与日志里的 `1/5…5/5` 一致）。
6. **遗留诊断代码**：index.js:1178-1190 的 `TEMP DIAGNOSTIC (remove after …)` 每次激活都会写
   `~/.dsh/failover-config-dump.json`。
7. **生效条件**：`route-config.json` 只在插件激活时读一次（index.js:1176），改完必须重启 DSH。

## 3. 建议修复

### 3.1 配置层（立即可做，改 `%USERPROFILE%\.dsh\plugins\provider-failover\route-config.json`，需重启）

```json
"failurePolicy": {
  "switchOn": ["QUOTA","AUTH","INVALID_CREDENTIAL","MISSING_CREDENTIAL","NO_ADAPTER","SERVER","RATE_LIMIT","TRANSPORT"],
  "doNotSwitchOn": ["POLICY"],
  "onExhausted": "error",
  "maxSwitchesPerTurn": 6,
  "cooldownByCode": {
    "QUOTA": 18000000,
    "AUTH": 1800000,
    "INVALID_CREDENTIAL": 1800000,
    "MISSING_CREDENTIAL": 1800000,
    "NO_ADAPTER": 1800000,
    "TRANSPORT": 60000,
    "SERVER": 60000,
    "RATE_LIMIT": 300000
  }
}
```

效果推演：同一场景下 openai-codex（11:24 冷却→11:25 解除）与 opencode-go（11:48→11:49 解除）
在 11:52:32 都可用，kimi 的 QUOTA 会立即切到 opencode-go 或 openai-codex。
（`cooldownMs` 每条也可一并从 1800000 降到 60000，作为未分类码的兜底。）

### 3.2 代码层（改 `dsh-provider-failover`，走 Git 跨设备生效）

- 无候选时 `pushNotice({kind:'exhausted', trigger:'no-candidate', ...})`，让决策进 notices.jsonl + 会话面板。
- 冷却写入改为 `coolingUntil = max(现有, now + 本次)`，禁止短路已被判死的长冷却。
- “失败即冷却”改为仅在真正切走后写入，或对 `no-candidate` 路径使用更短的冷却。
- 实现或删除 `transportRetries`，并删除 index.js:1178-1190 的临时诊断块。

### 3.3 验证

1. 重启 DSH 后 `GET /provider-failover/status` → `cooling` 为空、`tiers` 五条 `cooling:false`。
2. `/failover-probe` 全量探测，确认五条路由真实可用（额度/凭据/网络）。
3. 复现法（不消耗额度）：临时把某条命令行成 `TRANSPORT`（或断开网络 3 秒），观察该路由冷却
   应为 60s，并在 60s 后重新成为候选；`no-candidate` 应出现在 `/status.ignored` 且（代码层修完后）出现在 notices。
4. 回归：`node probe/smoke-config.mjs`（插件自带配置/行为冒烟）。

## 4. 已实施（2026-10-23 14:2x，本机执行）

### 4.1 配置层（设备配置，重启 DSH 生效）

- 文件：`%USERPROFILE%\.dsh\plugins\provider-failover\route-config.json`
- 备份：`route-config.json.bak-before-cooldown-fix-20261023-141732`（5145 字节）
- `failurePolicy.cooldownByCode` 由 `{QUOTA:18000000}` 扩为
  `{QUOTA:18000000, AUTH:1800000, INVALID_CREDENTIAL:1800000, MISSING_CREDENTIAL:1800000, NO_ADAPTER:1800000, TRANSPORT:60000, SERVER:60000, RATE_LIMIT:300000}`
- 五个条目的 `cooldownMs` 由 1800000 降为 60000（未登记类别的兜底从 30 分钟降到 60 秒）
- 删除死配置 `failurePolicy.transportRetries: 1`（代码从未读取）

### 4.2 代码层（`dsh-provider-failover` 提交 `6947f13`）

1. 冷却只在**选中下一跳之后**写入；no-candidate 路径不再冻结失败路由。
2. `coolDownRoute()`：冷却 `Math.max(既有, now+本次)`，只延长不缩短。
3. no-candidate 推 `kind=exhausted` 会话通知（`notices.jsonl` + 通知条，含冷却摘要）；client 增「无可用候选」标签。
4. `pickInTiers()` 显式排除 `excludeRoute`（原先靠「先写冷却」的副作用间接排除）。
5. `cooldownMsFor()` 支持 `effective:<CODE>`：未归一化但折算出 QUOTA 的失败也吃 5 小时冷却。
6. README 增「冷却语义与『无候选』」小节；`WINDOWFIX` 上下文窗口溢出切换一并落库。

### 4.3 验证证据

| 项目 | 结果 |
| --- | --- |
| `node probe/smoke-cooldown.mjs`（新增 15 条断言） | ALL PASSED |
| `node probe/smoke-config.mjs`（既有回归） | ALL PASSED |
| 设备配置经 `normalize()` 复算 | QUOTA 5h / AUTH 30min / TRANSPORT 60s / SERVER 60s / RATE_LIMIT 5min |
| 未归一化 `usage limit`（effective:QUOTA） | 5h（修正前只吃条目兜底的 60s） |
| `node --check index.js / client.js` | 通过 |

**行为推演**：同一场景（11:52:32 kimi QUOTA）下 openai-codex 冷却止于 11:25、opencode-go 冷却止于 11:49，
二者均在候选池内 → QUOTA 会立即切走，不再原地失败。

### 4.4 尚未完成

- 需重启 DSH 才能让配置与代码同时生效；重启后用 `/failover-probe` + `GET /provider-failover/status`（`cooling` 应为空）验收。
- 遗留 `index.js:1178-1190` 的 `TEMP DIAGNOSTIC` 块（每次激活写 `~/.dsh/failover-config-dump.json`）仍待清理。

## 5. 结论

- 本次不是“failover 失效”，而是**候选池被瞬时故障的 30 分钟冷却清空** + **该决策不可见**。
- 止血（已完成）：`cooldownByCode` 把 TRANSPORT/SERVER 降到 60s、条目兜底降到 60s（配置，重启生效）。
- 根治（已完成）：无候选必须可见 + 冷却只增不减 + 失败不无条件冷却 + 生效码取类（`dsh-provider-failover@6947f13`）。
- 剩余：重启后跑 `/failover-probe` 与 `/status.cooling` 做端到端验收；清理遗留诊断块。
