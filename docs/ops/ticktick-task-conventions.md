# TickTick 任务登记与反查规范 v0.1（草案）

> 设计来源：`codex-relay/gpt-6.1-sol`（reasoning_effort=high）子代理，2026-11-06。
> 复核：DSH 主控（`opencode-go/deepseek-v4.1-flash`），逐条挑战后给出裁决。
> 状态：**草案，含 1 个待用户裁决项（默认清单）**；未实施任何 skill/config 变更。
> 配套运维文档：`docs/ops/ticktick-mcp.md`（MCP 接入、凭据、NO_PROXY）。

## 0. 结论速览

| 维度 | 结论 |
| --- | --- |
| 现状是否有规范 | **有半套**：`ticktick-task-mcp` v0.2.0（SkillHub，self-authored）已规定焦点清单解析、字段映射、三集成标签、登记块雏形、状态约束；**缺**默认清单、命名词法、标签体系、DSH 会话登记、反查。见 §2 |
| 权威来源 | `.ptc/registry.jsonl` 是任务关系与历史的权威账本；TickTick 只是外部任务视图，完成/删除后本端不可见 |
| 写入纪律 | 一律显式传 `projectId`（禁止依赖 MCP 的 `defaultProjectId` 静默回落） |
| 默认清单 | **`0.DSH会话登记` / `6aeda4b68f0899596ed276da`**（2026-11-06 用户裁决 A）；仅用于「DSH 会话/根任务/子任务登记」，普通业务任务仍需反问 |
| 命名 | 短前缀 `[dsh]` + 人读标题；机器定位靠标签与登记块，不靠标题（主控否决了长机械前缀方案，见 §9-C6） |
| 标签 | 受控小写词表 + legacy alias；**去重必须不区分大小写**（实测服务端会小写化，见 §9-C2） |
| 会话登记 | `--- DSH-TICKTICK v1 ---` 定界块，含 session/root/subtask/账本指针/实际路由 |
| 反查 | 先账本映射（本地零成本）→ 再按清单扫描未完成任务；**过滤在脚本内完成，不进模型上下文**（§9-C9） |

## 1. 实测事实（本机 2026-11-06，全部由主控验证）

| 事实 | 证据 |
| --- | --- |
| `content` 8000 字符往返不截断 | 写入 8000 → 回读 8000 |
| 标签会被服务端**转小写并去重** | 写入 `['Harness-DSH','harness-dsh','proj-test','proj-test','中文标签']` → 回读 `['中文标签','harness-dsh','proj-test']` |
| 标签**顺序不保证** | 写入顺序与回读顺序不同 |
| `update_todo` 的 `patch.tags` 是**整体替换** | 更新为 `['proj-updated']` → 回读只剩该条 |
| `list_todos` 只返回**未完成**任务 | 完成后同一 `limit` 拉取不再出现 |
| `list_todos` 上限 200、**无分页** | schema `limit: 1..200`，无 offset/cursor |
| 无删除 / 无 reopen / 无跨清单或按标签搜索 | 工具表只有 7 个工具 |
| 回读含 `content` 与 `tags` | `list_todos` 返回字段含 content/tags/etag/modifiedTime |
| 默认清单「工作25」当前**仅 1 条未完成** | `list_todos` 实测；`🎯1.目标` 3 条、`ai-探索工具` 19 条 |

## 2. 现状盘点：既有 skill 覆盖了什么

`ticktick-task-mcp` v0.2.0（`%SkillHub%\store\installed\ticktick-task-mcp\SKILL.md`，2026-06-24 建、2026-09-21 更新，placement = codex IDE）：

| 已规定 | 缺口 |
| --- | --- |
| 焦点清单解析顺序：显式 → 会话焦点 → 反问；禁止列全部清单凑答案、禁止猜 | 无「默认清单」概念，且与 MCP `defaultProjectId` 静默回落冲突 |
| 字段映射（content/desc/日期/priority 0·1·3·5/tags/reminders/repeat/items） | 无命名词法，标题完全自由 |
| 三个强制集成标签：`codex-mcp`、`harness-<host>`、`mcp-ticktick` | 无受控词表、无会话/项目维度；是 Codex 时代命名 |
| 登记块（Harness/MCP 方式/设备/工作目录/时间/handoff 文件名） | 无 session_id、turn/step、root_task_id、账本指针、实际路由 |
| 完成只能 `complete_todo`；reopen 不支持要如实说 | 无任何反查规范 |
| 不泄露凭据、不谎称写入成功、摘要保留 task id | **DSH 会话当前加载不到该 skill**（不在 `~/.agents/skills`） |

## 3. 默认清单与焦点清单（v0.1）

### 3.1 优先级（覆盖既有 skill，新增第 4 档）

1. 用户本轮显式 `projectId`；
2. 用户本轮显式 `projectName`（`exact: true` 且唯一）；
3. 本会话已明确设定的焦点清单（用户说过「以后都写 X」）；
4. **仅当意图是 DSH 会话/根任务/子任务登记**且用户未指定业务清单时，用「默认登记清单」；
5. 其它情况（普通新增/更新/完成）无清单信息 → **必须反问**。

同时给 `projectId` 与 `projectName` 时必须解析为同一清单，否则反问。显式选择不改变会话焦点，除非用户明说。

### 3.2 默认登记清单（已裁决：A）

设计稿沿用 `config.json` 的 `工作25 / 677658b9f5e71d000000002b`。主控**不采纳直接沿用**，理由：

- 该清单名含年份前缀「25」，语义是 2025 年的工作清单，现在是 2026 年；
- 实测其中仅 1 条未完成任务，用作文档化的会话登记落点没有可观测价值；
- 把「配置里现存的值」升格为「规范默认值」，等于把历史遗留固化为规范 —— 违反「默认值必须是被显式确认的选择」。

**裁决（2026-11-06，用户选 A）**：新建专用清单

```text
projectId   = 6aeda4b68f0899596ed276da
projectName = 0.DSH会话登记
color       = #4A90D9
```

落地动作（已完成）：`ticktick_create_project` 建清单 → 备份并改写 `%APPDATA%\ticktick-mcp\config.json` 的 `defaultProjectId/defaultProjectName`（备份 `config.json.bak-before-dsh-registry-20261106-175834`）→ skill 升到 v0.3.0 并把默认清单写进 skill 本体。

残留约束不变：使用默认清单前必须校验 id 与 name 一致，不一致即「配置漂移」，**失败关闭**，不得静默换清单；MCP 的 `defaultProjectId` 只在 MCP 重启后生效，故所有写入仍显式传 `projectId`。

## 4. 命名（v0.1，主控已简化）

```text
[dsh] <动作>: <主体>[ ~dup-<n>]
```

- `[dsh]` 为固定来源前缀（小写 ASCII，长度固定 5 字符）；`source` 的细分（user/migration）放标签 `src-*`，不进标题；
- 动作 ≤ 24 字、主体 ≤ 80 字、整标题 ≤ 120 个 Unicode 字符；超限先压主体，**不得截断前缀**；
- 日期、优先级、根任务 id **一律不进标题**（放字段 / 登记块 / 标签），避免标题漂移；
- 禁换行、控制字符、零宽字符，禁 token/密钥/整段日志；
- 重名：默认反问；用户明确要求时追加 `~dup-2`、`~dup-3`，并在登记块写 `supersedes_ref`。

正例：`[dsh] 修复: TickTick 反查超时`、`[dsh] 研究: MCP 标签索引方案`、`[dsh] 补录: 历史会话登记 ~dup-2`
反例：`修复 TickTick 反查`（无前缀）、`[DSH][src-x] 修复: y`（大写+伪结构）、`[dsh] 修复: y 2026-11-06 P5`（日期优先级进标题）

> 与设计稿的差异：否决了 `DSH[src-…][proj-…] 动作: 主体` 的长机械前缀。原因：TickTick 在手机端是给人看的；`proj-p677658b9` 不可读，且把一个 UUID 派生 slug 塞进每一条标题，等于用人体工效换机器便利。机器定位由标签（`proj-*`、`sess-*`、`root-*`）与登记块承担。

## 5. 标签（v0.1）

### 5.1 受控词表

| 标签 | 含义 | 强制 |
| --- | --- | --- |
| `mcp-ticktick` | 经 TickTick MCP 写入 | ✅ |
| `harness-dsh` | DSH 宿主 | ✅ |
| `src-<dsh\|user\|migration>` | 来源 | ✅ |
| `kind-<register\|handoff\|followup\|idea\|fix>` | 用途（闭集，禁止自造） | ✅ |
| `proj-<slug>` | TickTick 清单短名（人工确认的稳定 ASCII） | ✅ |
| `sess-<session 前 8+ hex>` | DSH 会话 | 有会话上下文时 ✅ |
| `root-<task-id 去 task- 前缀>` | PTC 根任务 | 有则 ✅ |
| `sub-<subtask-id>` | PTC 子任务 | 有则 ✅ |
| `route-<route 枚举值>` | PTC 路由标签 | 推荐 |
| `dom-<slug>` | 领域 | 可选 |

- 全部小写 ASCII + 连字符；单个受控标签 ≤ 64 字符，用户标签 ≤ 32 字符；
- 建议总数 8–11 个，上限 12；
- **设备名不进标签**（否决 `harness-aero17`，见 §9-C5）：换机即断谱系，设备只写登记块 `host` 字段。

### 5.2 去重与大小写（相对设计稿的修正）

实测服务端会把标签转小写并去重，因此：

- 客户端 **必须按不区分大小写去重**（`Harness-DSH` 与 `harness-dsh` 是同一个），设计稿「按大小写敏感原值去重」不成立；
- 生成时一律小写；用户标签保留原语义但**预期会被服务端小写化**，回读以服务端值为准；
- 反查对受控标签做精确（小写）匹配，对用户标签按用户给定原值做不区分大小写匹配。

### 5.3 Codex 时代兼容

`codex-mcp` → `mcp-ticktick` 的 legacy alias；`harness-codex` → 旧宿主标识（**不得**据此推断当前 DSH 会话）。旧任务不动、不重命名；DSH 续写时追加 canonical 标签但不删旧标签，反查接受 alias 并标记 `legacy=true`。新建 DSH 任务不再写 codex 标签。

## 6. 会话登记块（v0.1）

```text
--- DSH-TICKTICK v1 ---
schema: dsh.ticktick.registration/v1
status: open
source: dsh
created_at: 2026-11-06T17:30:00+08:00
updated_at: 2026-11-06T17:30:00+08:00
timezone: Asia/Shanghai
host: aero17
profile: web
workspace_id: dsh
workspace_path: D:\src\dsh
session_id: session-01df0c0f-3242-4f55-8387-01e7e989f23e
turn_step: turn-02/step-01
root_task_id: task-20261106T092952972423Z-6a389306361b
subtask_id: subtask-20261106T092953603347Z-f87c922802ea
ledger_path: .ptc/registry.jsonl
ledger_ref: event:evt-20261106T093743681625Z-c0ebdad79ce0
project_id: <实际 projectId>
project_name: <实际清单名>
ticktick_task_id: pending
executor: main-controller | subagent_<tool>
route: <ptc route 枚举>
provider: <实际 provider>
model: <实际 model>
reasoning_effort: <实际 effort 或 ->
kind: session-register
handoff_ref: 无
summary: <≤120 字>
--- END DSH-TICKTICK ---
```

规则：

- 一行一字段、值内禁换行；可选缺失写 `-`，字段本身不省略；
- `ticktick_task_id` 初次为 `pending`，拿到真实 id 后**两步**：先追加账本 receipt（含 projectId/taskId/etag），再 `update_todo` 把该字段替换为真实 id；第二步失败**不得重新 add**，只走 reconcile；
- `ledger_ref` 必须是可定位指针（`event:<event_id>` / `receipt:<subtask_id>`），不能写「见账本」；
- `executor/route/provider/model` 记**实际观测值**，未派发子代理时 `executor=main-controller`，禁止按默认路由臆造；
- 禁写 token / client secret / 整段会话原文；
- 实测 content 8000 字符可往返，故软预算 **4096 UTF-8 字节**，登记块至少预留 2048 字节；超限降级顺序：摘要 → 可选路由辅助字段 → 长描述转 session log 只留指针 → `workspace_path` 改 `-`（保留 workspace_id/host）→ 仍超则 compact 块重试**一次**后失败关闭。

## 7. 反查（v0.1）

### 7.1 判定树（替代设计稿的加权评分）

```text
L0 用户直接给了 TickTick taskId
   → 账本取 projectId → 该清单 list_todos 精确核对 taskId → 命中即返回
L1 用户给了 root/subtask/session
   → 账本 mapping 精确命中 → 用其 projectId+taskId 核对 → 返回
L2 用户给了清单 + 关键词/标签
   → 只拉该清单（limit 200）→ 脚本内过滤 → 唯一命中则返回，多个则列候选
L3 只有 session_id / 标签 / 标题
   → 先账本（本地，零 API）→ 仍然空才扫描清单
扫描策略：并发 4，单请求超时 3s，整体超时 15s；
   先扫账本涉及的清单，命中唯一精确项即停止未开始的请求；
   任何清单返回恰好 200 条 → 标记 truncated_possible，禁止断言"全局不存在"
```

**唯一性规则**：精确标识（taskId / 账本映射 / root / subtask / session）命中且唯一 → 直接采用；其余命中只能作为候选并要求用户选择。取消加权评分与「15 分阈值」：权重无实证依据，且「冲突扣 100」会使分数为负、规则未定义边界。

### 7.2 过滤在脚本层（成本红线）

22 清单 × 200 条 = 4400 条任务。**禁止**把全量结果喂进模型上下文：扫描与过滤必须在 `run_code`/脚本内完成，只把「命中项 + 每清单计数 + 超时/截断标记」回传。

### 7.3 查不到 / 已完成 / 外部状态

- 查不到 → 输出「可见未完成集合未命中」+ 扫描范围 + 截断/超时标记，**不得声称任务不存在**；
- 已完成任务不可见 → 若用户指向已完成项，靠账本历史映射确认；要继续则**用户明确要求**新建 follow-up 并写 `supersedes_ref`；
- reopen 不支持：如实说明，恢复需求只能新建任务；
- **外部完成/删除不可观测**（无 webhook）：只能在下一次拉清单时发现「mapping 中的 taskId 已不在未完成集合」，此时登记一条 `ticktick_state_drift` 待人工确认，**不得**自动标记账本任务完成。设计稿遗漏了这条观测缺口。

## 8. 与既有 skill 的合并

| 决策 | 内容 |
| --- | --- |
| 单一 canonical 本体 | 扩写 `ticktick-task-mcp` → **v0.3.0**，不另建 DSH 副本（避免默认清单/标签/登记格式分叉） |
| schema 版本独立 | `dsh.ticktick.registration/v1`；只加可选字段保持 v1，改必填才升版 |
| 条款 | 保留：焦点清单顺序、禁猜、字段映射、状态约束、凭据纪律；**修改**：三标签 → canonical 词表；登记块 → v1 schema；**新增**：默认清单例外、命名词法、反查、drift 检测 |
| 加载路径 | 共享盘本体 `%SkillHub%\store\installed\ticktick-task-mcp\`（保留 self-authored stamp）→ 通过 SkillHub DSH placement 链到 `C:\Users\wwm_1\.agents\skills\ticktick-task-mcp` → 重启 DSH 后新会话可见 |
| 禁止 | 不把工作区绝对路径、凭据写进 skill 本体 |

## 9. 主控复核：10 条挑战与裁决

| # | 挑战 | 裁决 |
| --- | --- | --- |
| C1 | 默认清单直接沿用 `工作25`（含「25」年份语义、实测仅 1 条未完成）是把遗留值固化成规范 | **不采纳原方案**，改为待裁决项（§3.2 / §12） |
| C2 | 「标签按大小写敏感去重」与实测矛盾（服务端强制小写+去重） | **采纳挑战**，改为不区分大小写去重 |
| C3 | 「检测 etag 冲突 → 重读合并」在 MCP 层做不到（`patch` 不携带 etag，无条件更新语义） | **删除该条**，改为「写后回读校验 + 字段级 patch」；真正冲突靠人工消歧 |
| C4 | 反查加权评分（+100/-100、15 分阈值）是无依据常数 | **改为判定树 + 唯一性规则** |
| C5 | `harness-aero17` 强制标签把设备名写死，破坏跨设备谱系 | **删除**，设备只进登记块 `host` |
| C6 | 长机械标题前缀损害 App 内可读性 | **简化**为 `[dsh] 动作: 主体` |
| C7 | 两阶段写入在 fetch failed 下有孤儿任务风险，且「预检」未定义命中即复用 | **补规则**：预检按 canonical key（project+root+subtask+kind）判重，命中即复用/更新，**不得再 add**；receipt 先于块更新 |
| C8 | 「禁止在生产清单写测试」与「默认清单即生产清单」自相矛盾，且未定义测试清单生命周期 | **补规则**：测试只用隔离清单或 mock；隔离清单由用户明确授权后 `create_project` 创建并常驻复用，用完不删（MCP 无删除） |
| C9 | 22×200 全量扫描进上下文会吃掉大量 token | **采纳挑战**，过滤下沉脚本层（§7.2） |
| C10 | 遗漏：外部完成不可观测、会话焦点清单无持久化位置、`kind` 未定义闭集 | **补齐**：drift 检测（§7.3）、焦点清单存为会话内状态并在 `event(kind=note)` 留痕、`kind` 闭集（§5.1） |

## 10. 验证计划（可执行，实施 skill 时逐条跑）

| 断言 | 手段 | 期望 |
| --- | --- | --- |
| 默认清单校验 | `ticktick_list_projects({includeClosed:true})` | id 与 name 一致；不一致 → 失败关闭报漂移 |
| 写入必带 projectId | 代码审查 + mock | 任何 add/update/complete 均无隐式回落 |
| 命名合规 | 纯函数 fixture（正例 3 / 反例 3） | 结构+长度校验通过/拒绝 |
| 标签去重 | fixture：`['Harness-DSH','harness-dsh']` | 合并后只剩 `harness-dsh` |
| 标签更新语义 | 隔离清单实测 | `patch.tags` 视为**整体替换**，实现必须读-合并-写 |
| 登记块可解析 | parser fixture + 实地写入回读 | 字段齐全、时间带时区、`pending` 可替换 |
| 按 session 反查 | mock 清单 + 脚本过滤 | 只返回 session 精确匹配项，且不进上下文全量 |
| 截断标记 | fixture 返回 200 条 | 标 `truncated_possible` |
| 超长降级 | 注入 5 KB 摘要 | 按顺序降级后登记块仍可解析 |
| 歧义消歧 | 同标题同标签不同 root | 不更新，列候选反问 |
| 幂等 | 模拟「add 成功但 receipt 未写」 | 预检命中 canonical key → 复用，不重复 add |
| drift | 手工在 App 完成某任务 | 下次扫描标 `ticktick_state_drift`，账本不被自动改 |

## 11. 风险

- **skill 未加载**：规范不落地到 skill/placement 前，DSH 会话不会自动遵守（当前会话也不具备）。
- **无删除/无 reopen**：误建误完成无法回滚，只能靠「先反问、后写」和 follow-up。
- **配置漂移**：`config.json` 的 `defaultProjectId` 与规范声明可能不一致 —— 必须失败关闭。
- **反查成本**：清单越多、未完成任务越多，L3 扫描越慢；健康线是每清单未完成 ≤ 180 条。
- **观测缺口**：外部完成/删除无推送，只能靠下次扫描发现。

## 12. 待裁决项

**已清空。** 唯一阻塞项（默认登记清单）由用户于 2026-11-06 裁决为 **(A) 新建 `0.DSH会话登记`**，见 §3.2 与 §13。

## 13. 实施记录（2026-11-06）

| 项 | 状态 |
| --- | --- |
| 清单 `0.DSH会话登记` | 已创建，`projectId=6aeda4b68f0899596ed276da` |
| MCP 默认清单 | `config.json` 已改为上述二元组（已备份，需重启 DSH 才对 MCP 生效） |
| skill v0.3.0 | 本体 `%SkillHub%\store\installed\ticktick-task-mcp\SKILL.md`（9.5 KB）；`skill.json` 版本 0.3.0；`SKILL.meta.yaml` change_log 与 DSH placement 已登记 |
| DSH 接入 | `C:\Users\wwm_1\.agents\skills\ticktick-task-mcp` → job junction 指向本体（本体唯一） |
| 首条真实登记 | `taskId=6aeda5a28f082b13078cef32`，标题 `[dsh] 实施: TickTick 登记规范 v0.3.0 落地`，7 个受控标签，`DSH-TICKTICK v1` 块含真实 task id 与 `ledger_ref: event:evt-20261106T100241482568Z-714ab77796c7` |
| 反查验收 | L1（账本映射）与 L3（登记块按 session_id 扫描）均命中同一 taskId，结果一致 |

裁决后需要同步三处：本规范 §3.2、`%APPDATA%\ticktick-mcp\config.json` 的 `defaultProjectId/defaultProjectName`、以及 skill 的默认清单声明。
