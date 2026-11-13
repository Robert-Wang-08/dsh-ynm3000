# Focus Hub 既有设计与实现核对（2026-11-13）

> 目的：在更新「多 Agent 会话的洞察任务聚合与追踪」方案前，先把 Focus Hub **已经设计什么、已经实现什么、当前数据是什么、哪些只是设计稿**分开。本文是证据核对，不是 Focus Hub 的验收报告；不修改 Focus Hub 任何文件。

## 0. 结论

1. **Focus Hub 不是“只有设计”的原型**：它已有可运行的工作台（8770）、任务树/项目/阶段/验收、受管对象库、建议收件箱、DSH 读取、分析流水线、对象 API、状态/阶段识别和 344 项自动化测试（325 模块 + 19 服务端回归）。
2. **它已经覆盖“DSH 文本会话 → 摘要/洞察/任务建议 → 对象/建议 → 人工采纳”的主链**，但只针对 **DSH、单一 workspace、user/assistant 文本块**；且 `firstFrameText` 的 1MiB 上限会让 13.8% 长会话失败（见 4.6），修复前不能算完整覆盖。
3. **V2 洞察设计没有实现**：候选类型、相对先验的新颖性、按“主张+条件+结果”去重、SOP/改进闭环、评测迁移都还在设计/离线阶段。
4. 因此本项目不应从零再写 DSH 摄取、对象 API、任务树或 UI；应做 **Focus Hub 的多源扩展 + V2 洞察层 + 跨源身份/去重/提升**，并保持“提议、不抢权威”的边界。
5. **本次核对直接修正了 v1.1 的三处假设**：DSH 多帧不是“只能靠 zstd CLI”（Focus Hub 已逐帧解码，但 `firstFrameText` 有 1MiB 上限，见 4.6）；Focus Hub 不是“27 个会话/无 API”（当前 28 会话、216 活跃对象、完整对象 API）；V2 洞察不是“已实现”（只是设计/离线评估）。

## 1. 证据基础

| 证据 | 内容 |
|---|---|
| 代码 | `focus-hub/mvp/{server,dsh-source,flow-runner,analysis-adapter,obj-store,obj-api,suggestions,association-store,status-map}.mjs`；`mvp/test/` 36 个测试文件 |
| 文档 | `README.md`、`docs/overall_entrance.md`、`docs/progress-control.md`、`docs/superpowers/specs/2026-10-25-long-conversation-insight-v2-design.md`、受管对象子集设计、事实与同步规则 |
| 运行数据 | `mvp/data/{project.json,objects.jsonl,suggestions.jsonl,associations.jsonl,attribution-overrides.json}`（只读统计） |
| 实测 | `node --test mvp/test/*.test.mjs` → **325 pass / 0 fail**；`node mvp/tests/server-regression.mjs` → **19 pass / 0 fail**；P0 扫描脚本 `evidence/p0-workspace-scan.mjs` |
| 文档自述 | UI 回归 124/124（2026-10-30 报告）；本次未重跑浏览器 |
| 时间 | 2026-11-13；Focus Hub 数据最后更新 2026-10-30（rev 28） |

## 2. 当前数据事实（只读统计）

- `project.json`：rev 28；**6 个项目**（default / skillhub / srs-requirements / excel-field-i18n / dsh-governance / ncbs-data-governance）；**16 个任务**（pending 9 / review 4 / done 2 / active 1）；projectId 分布 default 12、ncbs 2、skillhub 1、dsh 1；`project.insights` 仅 **3 条旧式洞察**；`parked` 1；`promoted` 1；`commits` 15。
- `objects.jsonl`：**892 个事件**；**332 个 created**（其中 **116 个 retired**，当前活跃 **216**）；created 302 artifacts（file 160 / insight 95 / summary 34 / report 13）、28 sessions、2 rules；**活跃 186 artifacts（file 160 / insight 17 / summary 9 / report 0）**；116 retired（insight 78 / summary 25 / report 13）；项目分布 default 305、skillhub 11、ncbs 9、dsh 7（按 created 计，未扣 retired）。
- 会话：28 个 SESSION，**28 个都有 cursors**；50 个 cursor 事件；cursor 形如 `SESSION.cursors[taskId]={offset,read_at,scanner_version}`，详细游标另存 `summary.flowCursors[taskId]`（`lastSeq/lastBlockIndex/eventCount/contentDigest`）。
- 洞察：95 个 `artifact/insight` created（**17 活跃 / 78 retired**）；153 个 artifact 带 `derived_from.taskId`（FH-03 70、FH-07 31、FH-06 11、SKILLHUB-01 11、NCBS-01 8、DSH-01 7 等）；其余 149 个 artifact 及 28 sessions/2 rules 无 taskId（共 178 个对象无 taskId）。
- 建议：`suggestions.jsonl` 20 条当前建议（submitted 20 / decided 20）；**9 adopted / 11 rejected**；kind 10 project-move / 5 insight / 4 suggest-task / 1 summary。
- 关联：`associations.jsonl` 58 个 fragment-upsert；只做显式话题/任务引用，不做语义匹配。
- 人工覆盖：`attribution-overrides.json` 4 overrides / 7 lineOverrides / **1 stage override** / **1 acceptance**。
- 与文档的偏差：`mvp/README.md` 写“233 测试 / 没有真实 LLM 提炼 / 分析适配器只有注入测试”，但当前代码已有 325 模块测试、Kimi→opencode-go provider 链和 `/api/flow/run` 分析；README 明显滞后于代码与进度表。**以代码/测试/数据为准，文档只作意图与边界参考。**

## 3. 已实现能力矩阵

| 能力 | 实现位置 | 证据 | 状态 |
|---|---|---|---|
| 任务树 / 父子 / 状态 / 完成标准 / 产出 / 证据 | `project.json` + `server.mjs` validate/commit | 16 任务、6 项目；`server-regression` 19/19 | 已实现 |
| 项目实体 / 项目切换 / 项目合并 | `projects[]` + `/api/projects`、`/api/projects/merge` | 6 项目；`project-merge-api.test.mjs` | 已实现 |
| 阶段（需求确认/方案/实现/验收）与人工纠正 | `attribution-overrides.stageOverrides` + `/api/attribution/stage` | 4 阶段；1 条 stage override | 已实现（人工） |
| 验收（只认人工） | `attribution-overrides.acceptances` + `/api/acceptance` | 1 条 acceptance；状态映射区分 task/digest/local | 已实现（人工） |
| 受管对象 4 类 + 修订 + 更正 + 作废 + 标记 + 确认 + 关联 + 游标 | `obj-store.mjs` / `obj-api.mjs` | 216 活跃 / 28 sessions / 95 created insights（17 活跃）/ 2 rules；`obj-*.test.mjs` | 已实现 |
| 对象执行门（RULE/PROCESS） | `confirmExecution` + `/api/objects/confirm` | 4 confirmed；执行输入/403 校验 | 已实现 |
| 建议收件箱（summary/insight/suggest-task/artifact/project-move） | `suggestions.mjs` + `/api/suggestions*` | 20 条、9 采纳/11 驳回；幂等 | 已实现 |
| 建议任务 → 任务树 | `/api/tasks/from-suggestion` | 兼容 `subkind=suggest-task` 与 `[suggest-task]` 标题；建 `T-*` pending | 已实现 |
| DSH 会话只读增量适配 | `dsh-source.mjs` | 多帧 zstd、contentDigest、seq/block 游标、torn 尾帧、fork 继承跳过；19 项测试 | 已实现 |
| 扫描→分析→对象→游标 | `flow-runner.mjs` + `/api/flow/run` | 单 workspace/task；partial 不推进游标；`409 flow-busy` | 已实现 |
| 分析输出 schema | `analysis-adapter.mjs` | summary/insight/suggest-task/artifact；digest；source/task 校验；max 4 insights/2 suggestions | 已实现（V1 口径） |
| 分析 provider 链 | `analysis-providers.mjs` / `server.mjs` | Kimi k3-256k → opencode-go deepseek-v4.1-flash；缺键明确 501 | 已实现 |
| 状态识别 | `status-map.mjs` | 任务态/摘要态/本机态三源；冲突双显；done 不当验收 | 已实现 |
| 轨道/任务脉冲/台账/年谱视图 | `railway-progress` / `task-pulse` / `ledger-view` / `task-timeline` | 只读 API + 测试 | 已实现 |
| UI 工作层/流程/会话/轨道 | `app.html` 等 | 文档报告 124/124；本次未重跑 | 已实现（未重验） |
| 多 Agent 来源（Codex/Claude/Cursor/OpenCode） | — | — | **未实现** |
| 全 workspace 扫描 | `scanWorkspace` 只按一个 workspace 的 projectKey 发现 | `/api/dsh/workspaces` 可列 workspace，但 flow 一次只扫一个 | **未实现**（可组合） |
| 工具/todo/job 事件摄取 | `dsh-source` 只取 user/assistant text block | 工具结果/reasoning/注入被过滤 | **未实现**（有意） |
| 跨源身份/任务/洞察去重 | 只有 DSH `ensureSession` by sourceRef、artifact by sourceRef | 无跨 Agent 语义/锚点解析 | **未实现** |
| V2 洞察质量（类型/新颖性/去重/SOP/改进） | V2 设计 + 离线评测 | 设计稿明确“未实现” | **仅设计** |
| 多进程并发写 | 单进程 ObjectStore + server 串行队列 | README 明确单进程/单文件 | **未实现** |
| 跨设备同步 | — | README 明确不做 | **未实现** |

## 4. 关键接缝（合并/扩展时必须遵守）

### 4.1 会话与游标

- 会话对象按 `source_ref = dsh://session/<sessionId>` **全局去重**（`flow-runner.ensureSession` 查 `listReferenceable`）。`ObjectStore.createSession` 本身**不去重**，外部适配器必须先查/复用，否则同一 DSH 会话会出现两份 SESSION。
- 游标双写：`SESSION.cursors[taskId]`（offset/read_at/scanner_version）与 `SESSION.summary.flowCursors[taskId]`（workspace + lastSeq/lastBlockIndex/eventCount/contentDigest + offset + scannerVersion + updatedAt）。只写一个字段会破坏 `flow-runner` 续读。
- `scanWorkspace` 的 cursor 绑定 `taskId + workspace + sessionId`；`partial`/错误时**不推进**；fork 会话按 `inheritedEventCount` 跳过继承前缀。
- 新来源适配器应复用同一 SESSION 对象/游标语义，但 cursor 的 `lastSeq/lastBlockIndex` 是 DSH 特有；其他来源需要映射到自己的稳定 key（如 Claude uuid+line、OpenCode part id），不要伪装成 DSH seq。

### 4.2 对象与任务

- 对象库只有 `session / artifact / rule / process`，**没有 task 对象**；任务只在 `project.json.tasks`。不要给任务建 ARTIFACT 冒充任务。
- 洞察/摘要/报告/文件是 ARTIFACT 的 subkind；`suggest-task` 实际落成 `insight`，靠标题前缀 `[suggest-task]` 或 `derived_from.kind` 识别；这是既有兼容约定。
- 对象写入只走 `/api/objects/*`（HTTP）或 `ObjectStore`（同进程）；**不要直接 append `objects.jsonl`**，否则 revision/cursor/link/retire 全绕过。
- `propose` 不接受 `suggest-task` 作为 subkind；建议任务走 `suggestions` 收件箱或 `derived_from` 约定。
- 任务状态只有 `pending/active/review/done`；`blocked/unknown` 是状态映射的展示态，不是 `project.json` 状态。**不要给 project.json 写 blocked/canceled。**
- 任务状态没有窄接口；`/api/task/move` 只改父子；状态变更走 `/api/commit` 全量 state（baseRev/hash）。外部聚合器不应代替用户提交全量 state。
- 验收是 `attribution-overrides.acceptances` 覆盖层，不是 project.json 的 done；只有 `/api/acceptance` 人工动作产生。`status-map` 三源冲突双显，不静默合并。

### 4.3 建议与采纳

- 外部 Agent 应投 `/api/suggestions`（summary/insight/suggest-task/artifact/project-move）；采纳由 Focus Hub 自己写对象。
- `suggest-task` 采纳为对象后，再由用户/接口 `/api/tasks/from-suggestion` 建 `T-*` 任务；不要绕过这一步直接改 `project.json.tasks`。
- 建议用 `proposer + title` 对 pending 幂等；`proposer` 必填，`refs` 最多 32，body 最多 8000 字。
- `project-move` 采纳会调 `assignProject`；项目归属不是自动推断。

### 4.4 扫描/分析

- `/api/flow/run` 必填 `projectId/taskId/taskTitle/workspace`；一次只扫一个 workspace；`409 flow-busy`；`partial` 不推进游标。
- `/api/dsh/workspaces` 可从 `~/.dsh/storages/workspace.json` 列出 workspace 路径；全量聚合可“枚举 workspace → 逐 workspace 调 scan”，但每个 workspace 需要 taskId；全局摄取需要一个专门的 cursor 命名空间/任务，不能复用真实任务污染。
- `dsh-source` 只输出 user/assistant 的 text block；工具调用、todo/write、job 事件不进入来源。若新项目要识别任务/进度，需要扩展 `isHumanMessageEvent`/事件模型，或先从任务树/摘要取。
- `analysis-adapter` 的 V1 产出：summary（含 digest）、insight（最多 4）、suggest-task（最多 2）、artifact；没有 V2 的 insight_type/nature/boundary/novelty/relations，也没有“主张+条件+结果”去重。
- 分析 provider 链默认 Kimi k3-256k → opencode-go；缺键 501，不推进游标；单源 8000 字符截断，批次上限/32 source。

### 4.6 P0 实测发现：`firstFrameText` 的 1MB 上限（2026-11-13）

- `dsh-source.mjs` 的 `firstFrameText` 对大于 1MiB 的文件只取前 1MiB 调 `zstdDecompressSync`。zstd 帧不能在半帧处解；如果首帧压缩后 >1MiB，必然报 `unexpected end of file`。
- 实测：本机 **1,384** 个 `session.v4.jsonl.zstd` 中，**191 个 ≥1MiB**；对这 191 个用 1MiB 头解码，**191/191 全部失败**；用完整 buffer 解同一个 1.8MB 文件，首帧正常解出 6,983,979 字节（session head 正常）。
- 影响：**约 13.8% 的长会话被 `scanWorkspace` 标 `partial` 并跳过**；Focus Hub 当前 325+19 测试没有覆盖“首帧 >1MiB”的夹具，所以测试全过但真实覆盖有洞。
- 修复建议（P0，先于“复用”声明）：`firstFrameText` 改用完整压缩 buffer（或流式读够首帧），并新增 >1MiB 首帧的回归测试；不要靠降低扫描范围或静默跳过。修好后重跑 3–5 个 workspace 的扫描，确认 191 个长会话不再 `zstd-decode`。
- 这是 **P0 阻断项**，不是设计假设：在修复前，不能说 Focus Hub 的 DSH 摄取“覆盖完整”；P1 复用必须先修。

### 4.5 数据/并发

- 单进程、单数据目录；`ObjectStore` 同实例串行，跨进程无锁；`server.mjs` 的 `serialize` 只保护进程内。
- 任何外部伴随进程都不得直接写 `objects.jsonl/project.json`；要么 HTTP API，要么与 Focus Hub 同进程。
- `project.json` 与 `objects.jsonl` 是两套事实：任务树在 project.json，洞察/会话在 objects.jsonl；`project.json.insights` 只有 3 条旧式，95 created/17 active 洞察在对象库。不要假设二者已统一。
- `objects.jsonl` 有 append/link/correct/retire 事件；不要用“读 JSON 后整文件重写”的方式处理它。

## 5. 与 v1.1 方案的差异（必须修正）

| v1.1 说法 | 核对后 | 设计修正 |
|---|---|---|
| DSH 多帧只能逐帧/CLI，建议自写 DSH 适配器 | Focus Hub `dsh-source.mjs` 已逐帧解码，含 contentDigest/seq/torn/fork；但 `firstFrameText` 1MiB 上限导致 191/1,384 长会话失败 | **复用 dsh-source**，但 P0 必须先修 1MiB 上限并加回归；不要重写整个 DSH 适配器 |
| Focus Hub 已有 27 会话、对象 API 可用 | 当前 28 会话、216 活跃对象、325+19 测试、对象 API 完整 | 以当前数据为准；集成前跑一次健康检查 |
| V2 洞察设计已可用 | V2 只是设计/离线评测；代码是 V1 分析 schema | **V2 是新增工作**，不能当作已有能力 |
| 本项目需要独立登记库/UI | Focus Hub 已有对象库/任务树/建议箱/视图 | 本项目做 **摄取/提炼 companion**，不建第五个视图 |
| 未映射任务由登记表建平行任务 | Focus Hub 任务树是唯一任务权威 | **不建平行任务**；未映射先做 suggestion，采纳才进任务树 |
| 5 源齐上 P1 | Focus Hub 只做 DSH 文本；多源是新增 | P1 复用 DSH + 全 workspace；P2 再接 Codex/Claude；P3 Cursor/OpenCode |

## 6. 对更新方案的直接建议

1. **P0 先修 1MiB 首帧上限，再跑复用**：`firstFrameText` 改完整 buffer/流式读首帧，加 >1MiB 回归；然后验证 28 会话/216 对象/游标与 `/api/dsh/workspaces` 枚举。未修前不要进入 P1。
2. **全局摄取用独立 cursor 命名空间**：例如 `__ingest__` 或 `session-ingest` 任务，不污染真实任务；或者把多源摄取放在 companion 自己的 cursor 表，Focus Hub 只接收对象/建议。
3. **先做“建议收件箱 + 对象”而不是“任务树”**：洞察/摘要/任务建议投 suggestions；用户采纳后才经 `/api/tasks/from-suggestion` 建任务。
4. **V2 洞察作为新层**：在 `analysis-adapter` 输出后增加结构化 `insight` 元数据/去重；对象 summary/derived_from 可承载，但要设计字段迁移，不能改坏现有 95 created/17 active 洞察。
5. **多源适配器只做“规范化 + 证据指针”**：Codex/Claude/Cursor/OpenCode 先转成与 DSH 消息类似的 `{role,text,sourceRef}`，复用 analysis/suggestions；工具/待办事件后置。
6. **合并形态**：Focus Hub 核心 + `session-ingest` companion（L1）；P1 后再进 Focus Hub 仓库（L2）；不要 L3 单进程。

## 7. 仍未验证

- **P0 smoke（2026-11-13）**：前 5 个 workspace 共 305 个登记会话；`limit=20` 时 44–126ms、每个只读到 1–6 个会话；其中 `D:\nutstore\1.logseq` 命中一个 1.8MB 长会话 `zstd-decode`（4.6 的 1MiB 上限）。这不是全量覆盖 benchmark。
- `/api/dsh/workspaces` 对 1,384 个 v4 文件/1,424 个会话目录的覆盖/性能；逐 workspace 扫描 + 全局 cursor 的成本。
- `dsh-source` 对 28 个当前 SESSION 的 cursor 与 `flow-runner` 的 summary.flowCursors 是否一致（本次只读对象字段，未跑 flow）。
- V2 洞察元数据放 `derived_from` 还是新对象字段；对现有 95 created/17 active 洞察的兼容。
- 多源会话对象与 Focus Hub 现有 DSH SESSION 的去重/映射（source_ref 命名空间）。
- 7801 工作层与 8770 的数据同步/只读边界；本次只核 8770 数据文件。
- 多进程/并发；Focus Hub 明确不支持，不要假设。

