# 多 Agent 会话的洞察任务聚合与追踪（Focus Hub 式）：细化设计 v1.2

> 2026-11-12 初稿 / 2026-11-13 v1.2 · 设计交付，未实现 · 来源：Feishu 请求（「dsh 为主，支持 codex/opencode/cursor/claude 的会话聚合；自动读取、识别任务、按任务聚合、更新进度、登记到统一登记表；含目标/方案/成果物/裁决/洞察/总体计划/待办」；后续补充：「目标是聚合洞察任务，类似 Focus Hub 的需求，做好追踪，同时去重并洞察、提升」；2026-11-13 再补充：「深度理解 focushub 既有设计和已实现内容，更新一个方案」）
>
> 过程：6astra 主笔设计（v1.0 通用任务登记）→ Opus 5 / Kimi K3 独立挑战（基于 v1.0）→ 主控按本机实测证据裁决 → 用户补充“洞察任务/Focus Hub”后收敛为 v1.1 → **2026-11-13 对 Focus Hub 既有设计与实现做只读核对（325+19 项测试、当前 216 活跃对象/28 会话/95 创建/17 活跃洞察/16 任务）后更新为 v1.2**。v1.2 的关键变化：复用 Focus Hub 已有的 DSH 摄取/分析/对象/建议箱，不重写；本项目只做多源扩展 + V2 洞察/去重/提升 + 全局摄取。洞察专项由主控按 Focus Hub V2 设计与既有裁决补审，不冒充模型已评审。设计稿、挑战稿、裁决记录、实现核对与模型回执见附录。本文是最终设计，不是安装态说明。

## 〇、v1.2 Focus Hub 既有实现核对（先读）

只读核对 Focus Hub 的代码、文档、当前数据与测试后，必须修正 v1.1 的五个假设：

| v1.1 假设 | 核对结果 | v1.2 修正 |
|---|---|---|
| DSH 多帧 zstd 需要自写适配器/CLI | Focus Hub `dsh-source.mjs` **已实现逐帧解码**、contentDigest、seq/block 游标、torn 尾帧、fork 继承跳过；19 项测试通过。**但 `firstFrameText` 只有 1MiB 上限，实测 191/1,384 个 ≥1MiB 长会话全部 `zstd-decode`** | **复用 `dsh-source.mjs` 前先修 1MiB 首帧上限**，加回归；不重写 DSH 摄取 |
| Focus Hub 只有对象模型/没有完整 API | 已有 `obj-store/obj-api` 全量对象 API、`suggestions` 收件箱、`flow-runner`、`analysis-adapter`、任务/验收/阶段/项目接口；325 模块 + 19 服务端测试通过 | 本项目做 **摄取/提炼 companion**，不建第五个视图/第二对象库 |
| V2 洞察设计已可用 | V2 仍是设计/离线评测；代码是 V1 schema（summary/insight/suggest-task/artifact，最多 4 洞察/2 建议） | **V2 是新增工作**：类型/边界/新颖性/去重/改进闭环 |
| 未映射任务由登记表建平行任务树 | Focus Hub `project.json.tasks` 是任务唯一权威；对象库没有 task 对象 | **不建平行任务**；未映射先做 suggestion，用户采纳后才进任务树 |
| 五源齐上 P1 | Focus Hub 只做 DSH、单 workspace、user/assistant 文本 | P1 复用 DSH + 全 workspace；P2 Codex/Claude；P3 Cursor/OpenCode |

**核对证据**：`outputs/focus-hub-audit.md`（当前数据/API/测试/接缝逐项）；`node --test mvp/test/*.test.mjs` 325/325；`node mvp/tests/server-regression.mjs` 19/19；当前 `objects.jsonl` 216 活跃对象/28 会话/95 创建/17 活跃洞察/2 规则；`project.json` 16 任务/6 项目/3 条旧式洞察。**P0 实测还发现 `dsh-source.firstFrameText` 的 1MiB 上限：191/1,384 个长会话失败，必须先修再复用。**



## 〇.1 v1.1 需求收敛（背景）

v1.0 把问题写成“跨 Agent 任务登记”。用户在 2026-11-12 的补充把它收窄并抬高了：

> 目标是聚合洞察任务，类似 Focus Hub 的需求，做好追踪，同时去重并洞察、提升。

因此 v1.1 的主对象不是“任务卡”，而是 **Focus Hub 式的工作对象**：

| 对象 | 回答什么 | 本设计中的位置 |
|---|---|---|
| 会话（SESSION） | 证据从哪来 | 来源适配器 |
| 洞察（INSIGHT） | 什么认识值得以后找回 | 登记表「洞察」节 + 洞察队列 |
| 任务建议（TASK SUGGESTION） | 有哪些工作值得继续做 | 登记表「待办」节 + 任务匹配 |
| 任务/目标（TASK/GOAL） | 什么结果、什么验收 | 登记表「目标」节 + 项目任务树 |
| 里程碑（MILESTONE） | 到哪个阶段、有什么证据 | 登记表「总体计划」节 |
| 成果物（ARTIFACT） | 交付了什么、能否验证 | 登记表「成果物」节 |
| 裁决/约束（DECISION/RULE） | 人定了什么、什么能执行 | 登记表「裁决」节 + 执行门 |
| 材料/外部组/孤儿 | 归不进去的东西 | 单列，不猜 |

**五个必须同时成立的能力**：

1. **聚合**：跨会话、跨 Agent 收集洞察与任务建议，不按“一个会话一个任务”切。
2. **追踪**：按目标/轨道与阶段追踪；阶段由证据识别，人工可纠正；里程碑分 planned/reported/evidence_supported/accepted。
3. **去重**：任务按锚点/产物去重；洞察按“主张 + 条件 + 结果”去重，不按文字相似度合并相反观点。
4. **洞察**：区分“摘要（压缩）”与“洞察（高价值识别）”；每条洞察带来源、适用边界、性质（明确陈述/Agent 归纳/待验证假设）。
5. **提升**：洞察 → 改进候选（SOP/规则/任务计划/工具）→ 执行确认 → 实测结果 → 更新置信度与适用范围；没有实测就标“未验证改进”，不冒充成功。

**不做什么**：不重造 Focus Hub 的第五个视图；不把摘要换词当洞察；不把模型归纳当人工裁决；不因洞察存在就自动改任务/规则；不把任务建议直接建成任务。



## 一、结论先行

这套系统的难点不在“解析会话”，而在**洞察/任务身份、证据裁决、验收权与改进闭环**。建议把目标收窄为一句话：

> 为多 Agent 的本机会话建一个 **Focus Hub 式的洞察任务聚合投影**：自动收集证据、提议洞察/任务建议/进度；人保留合并、验收、执行和“提升”的最终裁决权。

最小可行路径不是重写工作台，而是**以 Focus Hub 为工作台/对象/任务权威，本项目做 companion**：多源来源适配 → 统一事件/证据 → 洞察/任务聚合 → Focus Hub 建议/对象 → 改进闭环。DSH 摄取直接复用 `dsh-source.mjs`/`flow-runner.mjs`/`analysis-adapter.mjs`；真正新增的是 **多源适配（Codex/Claude/Cursor/OpenCode）、全 workspace 摄取、V2 洞察/去重/提升**。登记卡是数据投影，不新建第五个 UI，不建平行任务；所有提议经 Focus Hub 的 suggestions/objects/任务建议进入，人工验收/阶段仍归 Focus Hub。不复制原始聊天，不双写 taskboard/PTC/Focus Hub，不自动销项，不把摘要当洞察。

**明确不建议**：第一期做“自动改任务状态 + 自动写回所有系统 + 全量 LLM 理解所有聊天 + 自动把洞察升级为规则”。这四件事会把一个登记/追踪问题变成不可审计的自动化事故。

## 二、目标、非目标与成功标准

### 2.1 目标

| 编号 | 目标 | 可检验的落地形态 |
|---|---|---|
| G1 | 自动读取多 Agent 本机会话 | 每个来源有只读适配器；首建可枚举，增量可按水位补齐；覆盖缺口可见 |
| G2 | 识别任务 | 先锚点、后 LLM；每个任务至少有 1 条证据和一个来源；无证据的候选不登记为任务 |
| G3 | 按任务聚合 | 同一任务可跨会话/跨 Agent；一个会话可拆多个任务；合并/拆分有审查记录 |
| G4 | 更新进度 | 证据驱动；状态、验收、等待原因分离；冲突与过期显式呈现；不出现“助手说完成=已完成” |
| G5 | 统一登记表 | 每张任务卡含「目标、方案、成果物、裁决、洞察、总体计划、待办」七节；机器可读、人可读、可追溯 |
| G6 | 可纠正、可重建 | 追加式账本 + 投影；删投影可重算；纠正保留历史；不静默覆盖 |
| G7 | 可扩展 | 新 Agent 只加适配器，不改任务模型和登记表 |
| G8 | 聚合洞察 | 从会话中识别值得以后找回的认识；每条带来源、适用边界、性质（明确陈述/Agent 归纳/待验证假设），并与摘要区分 |
| G9 | 去重 | 任务按锚点/产物去重；洞察按“主张+条件+结果”去重；相反观点并列，不按文字相似度合并 |
| G10 | 提升 | 洞察 → 改进候选（计划/约束/SOP/工具）→ 执行确认 → 实测结果 → 更新置信度；无实测不冒充成功 |

### 2.2 非目标

- 不替代 taskboard、PTC、superagent、focus-hub 的任务/执行/审批职责；不重造 Focus Hub 的第五个视图。
- 不自动修改代码、不自动合并 PR、不自动给外部系统写状态。
- 不把原始会话、客户数据、凭据复制进登记表。
- 不做云端多租户、不做向量知识库、不做通用 Agent 运行时。
- 不把“会话摘要”当任务事实或洞察；摘要只作压缩/候选证据。
- 不在第一期做“全自动任务完成”或“洞察自动升级为规则/SOP”。

### 2.3 成功标准

P1（复用 DSH/全 workspace）与 P2（Codex/Claude + V2 洞察）达到以下才算可用：

1. **覆盖**：最近 30 天活跃会话 ≥95% 被扫描；失败来源在视图上明确标注，不用空数据冒充完整；**同时报告锚点覆盖率**（有 A0/A1 硬锚点的段占比），精确率只在有锚点子集上解释，避免“达标但没用”。
2. **身份**：P1 抽样 30 个任务、P2 扩到 50 任务/200 段，人工判断“任务归属正确”≥90%；自动关联 precision ≥0.98、recall ≥0.80；**错误自动合并为 0**（宁可多拆、不可错并）；SESSION 重复 0。
3. **证据**：每张卡片的每条事实可点回来源会话与事件；无来源事实为 0；引文回链率 100%；来源被删后显式标“证据已失效”，不静默隐藏。
4. **进度**：自动标记 `verified` 的事实可复核；`done` 全部有人工/上游确认，误报 `done` 为 0；无验收标准时不显示百分比。
5. **成本**：日常增量一轮 ≤15 分钟、≤200 次模型调用/100 万输入 token；单轮可中断、可续跑；达到预算排队而不是静默加钱；连续 3 天超限自动切“规则-only”。
6. **安全**：默认不向外部模型发送原始会话；凭据检测命中后不入库；删除/重建可执行；无静默丢数据；模型运行位置在 P0 前确认。
7. **洞察质量**：洞察候选的证据回链率 100%；“摘要换词/空泛评价”误报率单独统计；洞察去重后重复率可解释；相反观点未被错误合并（错并为 0）。
8. **提升闭环**：每条“已提升”的改进必须有执行确认、验证方式与结果；无实测的改进标 `unverified_improvement`，不计为成功。
9. **复用不回归**：Focus Hub 的 325 模块 + 19 服务端测试仍通过；不重复建 SESSION；不向真实任务写假 cursor；V2 新增字段不破坏现有 95 创建/17 活跃洞察的读取/筛选。

> **时延口径**：5–15 分钟可见的是“证据层”（会话被发现、事件入库）；任务卡与七节内容是异步派生，可能延后数小时甚至隔天。不要承诺“任务层 5 分钟刷新”。

## 三、总体架构与数据流

### 3.1 架构

```text
┌──────────────── 本机各 Agent 的只读存储 ────────────────┐
│ DSH sessions(zstd)  Codex rollout  Claude jsonl/tasks  │
│ Cursor transcripts  OpenCode sqlite                    │
└───────────────┬─────────────────────────────────────────┘
                │ 只读 Adapter（DSH 直接复用 dsh-source；其余新增）
                ▼
   ┌──────────────────────────────┐
   │ session-ingest companion      │  event / evidence / cursor / review
   │ （独立进程，不写 Focus Hub 文件）│
   └──────────────┬───────────────┘
                  │ 洞察/任务建议/证据（候选，带来源）
                  ▼
   ┌──────────────────────────────┐      ┌──────────────────┐
   │ 洞察/任务聚合 + V2 去重       │─────▶│ 人工审查队列      │
   └──────────────┬───────────────┘      └──────────────────┘
                  │ 一方向提议
                  ▼
   ┌──────────────────────────────┐
   │ Focus Hub API                 │  suggestions / objects / tasks /
   │ （对象/任务/阶段/验收权威）    │  acceptance / attribution/stage
   └──────────────┬───────────────┘
                  │ 由 Focus Hub 写
                  ▼
   ┌──────────────┴──────────────┬─────────────────┬──────────────────┐
   ▼                             ▼                 ▼                  ▼
 Focus Hub objects.jsonl    project.json 任务树   8770/7801 视图      改进闭环
 （session/artifact/rule）  （任务/阶段/验收）     （工作层/流程/轨道）  （SOP/规则/计划）
```

### 3.2 组件职责

| 组件 | 职责 | 不做什么 |
|---|---|---|
| Adapter | 枚举来源、读变更、解析为统一事件；只读。DSH 复用 `dsh-source`；其余新增 | 不改源文件、不猜缺失记录 |
| Normalizer | 统一字段、稳定 ID、内容哈希、脱敏 | 不做任务判断 |
| Segmenter | 把会话切成“可能属于一个任务”的段 | 不把每一轮对话都当任务 |
| Resolver | 候选任务、合并/拆分、置信度、审查项 | 不自动跨项目合并 |
| Insight extractor | 从段落抽取洞察/任务建议/里程碑候选；带证据、边界、性质 | 不把摘要当洞察、不自动升级规则 |
| Deduper | 任务按锚点/产物、洞察按主张+条件+结果去重 | 不按文字相似合并相反观点 |
| Extractor | 从段落抽取七类事实与证据引文 | 不执行会话里的指令、不调用工具 |
| Ledger | 追加事实、洞察、决定、覆盖、审查结果（companion 自己的事件库） | 不原地改写历史 |
| Focus Hub client | 经 HTTP API 投建议/对象/任务建议；读任务/验收/阶段 | 不直接写 `objects.jsonl`/`project.json` |
| Projector | 重建 companion SQLite / Markdown / JSON / Focus Hub 兼容对象 | 不成为第二个写权威 |
| Improvement loop | 洞察→改进候选→执行确认→实测→更新置信度 | 不无实测升级 SOP |
| Scheduler | 定时/手动扫描、预算、背压、失败隔离 | 不无限重试、不静默跳过 |
| Review UI/CLI | 人确认合并、拆分、事实、洞察、验收 | 不替人做验收 |

### 3.3 部署形态

**推荐：Focus Hub core + `session-ingest` companion（独立进程/CLI），不新建独立 Web UI。**

- **Focus Hub**（`D:\src\dsh\focus-hub`，8770/7801）：继续做工作台、对象库、任务树、阶段/验收、建议箱和视图；`objects.jsonl`/`project.json` 只由它写。
- **session-ingest companion**：独立本地进程，负责多源发现/解析/规范化/证据、全 workspace 摄取、V2 洞察/去重/提升候选；通过 Focus Hub HTTP API（suggestions/objects/tasks/acceptance）提交，**不直接写 Focus Hub 数据文件**。
- **CLI**：`session-ingest scan|status|review|export|rebuild`，与 companion 共用存储和单写者锁；可由 Windows 计划任务/登录触发器调用。
- **不新增 DSH 插件/第五个视图**：展示复用 Focus Hub；如需在 DSH 里看，只做深链/只读入口，不新建面。
- **单写者**：companion 自己的 ingest 状态用 `locks/writer.lock` + OS named mutex；Focus Hub 的写入串行由其 server 保证；不要跨进程写同一 Focus Hub 文件。
- **Windows 清单**：计划任务用“登录时触发”；长路径 `\\?\`；本地 IPC 用 named pipe；CLI 参数 UTF-8。
- 存储：companion 状态 `%USERPROFILE%\.dsh\session-ingest\`（cursor/evidence/review）；Focus Hub 数据仍在 `focus-hub/mvp/data/`，只经 API 读写。不把 companion 状态放进 Focus Hub 数据目录。
- 运行时：复用 Focus Hub 的 `dsh-source.mjs`（Node v24 zstd 逐帧）与 `node:sqlite`（companion 事件库）；不引入 npm 原生依赖。

**为什么不做成独立 Web 应用**：Focus Hub 已经是工作台，独立 UI 会变成第五个孤立入口。**为什么不把扫描器塞进 8770 单进程**：1,424 个 DSH zstd、1.83GB OpenCode、Cursor 加密库和多源解析会拖住交互；Focus Hub 也明确单进程/单写者。**为什么不直接写 Focus Hub 文件**：会绕过 revision/cursor/link/执行门，制造第二真相。

### 3.4 数据流（一次增量）

1. Scheduler 触发 `scan`，读取 `source_cursors`。
2. 每个 Adapter 枚举变更会话；按预算截断，记录本轮覆盖。
3. 解析新增记录 → 统一事件 → 内容哈希去重 → 写 `event`。
4. Segmenter 只为“新增/变更的会话”重算受影响段；旧段保留 `superseded_by`。
5. Resolver 为每个段生成候选：先查 Focus Hub `project.json` 任务 ID/`knownTaskIds` 与 A0/A1 锚点，再查同项目相似任务，最后才问 LLM；**不创建任务**。
6. 高置信锚点只自动挂证据/关系；任务归属仍是 suggestion，不自动改 Focus Hub 任务树；其余进 `review_items`，不阻塞其他任务。
7. Insight extractor / Extractor 对已链接段抽取：洞察候选、任务建议、里程碑候选、七类事实；每条带证据、边界、性质（明确陈述/Agent 归纳/待验证假设）。
8. Deduper 先按 A0/A1 锚点/产物去重任务，再按“主张+条件+结果”去重洞察；相反观点并列，不按文字相似合并。
9. 新事实/洞察/建议以 `proposed` 写入 companion `ledger.jsonl`；人工审查后，洞察/摘要/任务建议经 Focus Hub `/api/suggestions` 提交（或按对象 API `propose`），由 Focus Hub 自己落对象；本项目不直接 append `objects.jsonl`。
10. Projector 重建七节卡、索引与 Focus Hub 兼容对象；视图显示 `coverage`、`stale`、`conflicts`、`source_health`。任务/验收/阶段仍从 Focus Hub 读。
11. 只有已采纳的洞察才生成改进候选；改进需执行确认、验证方式与结果，未实测标 `unverified_improvement`。

## 四、来源适配器与统一事件模型

### 4.1 适配器契约

```ts
interface SourceAdapter {
  id: 'dsh' | 'codex' | 'claude' | 'cursor' | 'opencode';
  version: string;
  capabilities: {
    listing: boolean;          // 能否枚举历史
    incremental: 'seq' | 'offset' | 'mtime' | 'db-watermark';
    nativeTasks: boolean;      // 是否有结构化任务/待办
    encrypted: boolean;        // 是否需要解密/授权导出
    stableIds: boolean;
    fidelity: { text: 'full' | 'partial' | 'unsupported'; tools: ...; tasks: ... };
  };
  discover(cursor: SourceCursor | null): Promise<DiscoveredResource[]>;
  parse(resource: DiscoveredResource, cursor: SourceCursor | null): Promise<ParseResult>;
  normalize(records: RawRecord[], resource: DiscoveredResource): Promise<CanonicalEvent[]>;
  coverage(): Promise<CoverageReport>;
}
```

`DiscoveredResource` 至少含 `resourceId, nativeSessionId, generation, fingerprint, path, capabilities`。`generation` 在文件被替换/重写时递增；**事件身份不能只靠文本哈希**，必须优先用来源原生 ID + 资源代次 + 记录位置；文本哈希只用于变更检测和重复内容提示。

硬约束：

- 适配器只读打开源文件/数据库；SQLite 使用 `mode=ro`，不写 WAL、不 checkpoint、不 vacuum。
- 任何“解密/导出”必须走独立、可关闭的能力位；默认关闭。Cursor 根 blob 解密在第一期不启用。
- 适配器失败只影响该来源本轮；不得让 DSH 解析失败阻塞 Codex/Claude。
- 每个适配器必须报告 `complete | partial | missing` 与原因；视图不得把 partial 显示成 complete。
- **路径与仓库身份在适配器层规范化**：`canonical_path`（绝对路径、大小写/分隔符统一）+ `repo_id`（remote URL + 提交范围）；同名目录/同名仓库**不能单独作为锚点**，必须有 commit/PR/文件集重合；规范化失败降级为候选，不自动关联。
- 半条记录不消费；损坏的压缩尾帧留待下轮；文件缩短/指纹变化时递增 `generation` 并重扫。

### 4.2 各来源的落点与风险

| 来源 | 第一期策略 | 关键风险 | 设计对策 |
|---|---|---|---|
| DSH | **复用 Focus Hub `dsh-source.mjs`**：`session.v4.jsonl.zstd`，逐帧解码、contentDigest、seq/block 游标、torn 尾帧、fork 继承；扩展全 workspace | 多帧 zstd、compaction、单 workspace | 不重写解码；用 `/api/dsh/workspaces` 枚举 + 逐 workspace `scanWorkspace`；独立 ingest cursor；`seq`/digest 去重 |
| Codex | 支持活跃 rollout；归档 `.zst` 第二期 | `world_state` 含大段 AGENTS.md，token 浪费 | 只取 `session_meta/event_msg/response_item/turn_context`；丢弃 `world_state` |
| Claude | 支持主会话 + `tasks/*.json`；子代理按 `isSidechain` 去重 | 子代理与主会话共享 sessionId，可能重复计数 | 任务按 `taskId` 唯一；事件按 `uuid` 唯一；子代理默认只作证据，不单独成任务 |
| Cursor | 第一期只接 `agent-transcripts/*.jsonl`；`store.db` 根 blob 加密作为待验证项；IDE 路径标 `unsupported` | 加密根 blob、IDE DB 路径未定 | 不声称完整支持；UI 标注“仅 transcript / IDE unsupported”；解密 spike 通过后再开 |
| OpenCode | 支持 `opencode.db`：session/message/part/todo | 1.83GB + 79MB WAL；全表扫描会顶 WAL、拖慢写入方；`todo` 无独立 id | `mode=ro` + `PRAGMA query_only`；查询限时 15 秒；按 `time_updated` 水位 + 5 分钟重叠；首建用 SQLite 在线 backup API 到临时副本，不复制裸主库（会丢 WAL）；WAL 大小进 lag 指标；`todo` 去重键 `(session_id, position, content_hash)`，内容变更视为新版本 |
| 扩展 | 新 Agent 只实现 Adapter | 格式各异 | 统一事件模型 + 契约测试；不支持就明确“未接入”，不猜 |

### 4.3 统一事件模型

```ts
type CanonicalEvent = {
  id: string;                 // `${source}:${resourceId}:${generation}:${nativeKey}`，稳定
  source: SourceId;
  resourceId: string;         // 文件/DB/会话资源 ID
  sessionId: string;          // 本系统 ID：`${source}:${sha1(nativeSessionId)}`
  nativeSessionId: string;
  generation: number;         // 文件被替换/重写时递增
  parserVersion: string;
  nativeEventId?: string;     // DSH seq / Codex ordinal / Claude uuid / OpenCode part id
  seq?: number;
  occurredAt: number;         // 来源时间
  observedAt: number;         // 采集时间
  kind: 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result'
      | 'todo_snapshot' | 'title' | 'turn_marker' | 'session_meta';
  role?: 'user' | 'assistant' | 'tool' | 'system';
  actor?: string;             // 用户/模型/工具/子代理
  cwd?: string;
  projectHint?: string;
  parentId?: string;          // 父子会话/子代理
  turnId?: string;
  tool?: { name: string; callId?: string; input?: unknown; output?: unknown };
  text?: string;              // 本地处理用；已脱敏；可配置为不持久化
  textHash: string;
  anchors?: Anchor[];         // 从文本/工具参数中抽出的 ticket/pr/commit/path
  sensitivity: 'public' | 'internal' | 'private' | 'secret';
  redaction: { applied: boolean; kinds: string[] };
  evidenceRef: { path: string; locator: string; digest: string }; // 回溯指针
};
```

`Session` 至少含：`id, source, nativeId, resourceId, generation, path, cwd, projectId, title, startedAt, updatedAt, agentPreset, models[], parentSessionId, contentHash, cursor, coverage`。

`Segment` 至少含：`id, sessionId, startEventId, endEventId, anchorSet, topicHint, status(active|superseded), tokenEstimate, createdAt`。默认单段 ≤8,000 token；超限沿 turn 切开并继承上下文引用，不只靠时间间隔。

**身份规则**：事件 ID 不能只按文本哈希生成，否则同一命令重复执行会被吃掉；必须优先用原生 ID + 资源代次 + 记录位置。文本哈希只用于变更检测与“重复内容提示”。

### 4.4 增量与游标

| 来源 | 游标 | 变更检测 | 截断/重建 |
|---|---|---|---|
| DSH | `lastSeq` + 文件前缀 hash | 整文件解压后 `seq > lastSeq` | 前缀 hash 变 → 全量重算，旧事件标 `replaced` |
| Codex | 字节 offset + 最后一行 hash | 追加读 | offset 超文件尾/首行 hash 变 → 全量重读 |
| Claude | 字节 offset + 最后一行 hash | 追加读 | 文件变短/重写 → 全量重读 |
| Cursor transcript | 字节 offset | 追加读 | 重写 → 全量重读 |
| OpenCode | `max(time_updated)` | `time_updated > watermark - 5min` | 用 message/part id 去重；不依赖 rowid；**时间戳可能非单调** → 复合水位 `(id, time_updated)` + `time_skew_detected` 审计模式，暂停增量并逐行对账 |
| Cursor store.db | 文件 mtime/size | 第二期再定 | 加密根 blob 未解前不进入 |

**幂等**：事件 ID、`textHash`、`(source, sessionId, nativeKey, generation)` 唯一；重复扫描只更新 `updatedAt`，不重复计数。文件缩短、替换或指纹变化时递增 `generation` 并重扫；旧代次证据保留，不覆盖。

## 五、任务识别与聚合

### 5.1 先定义清楚四个东西

- **Goal（目标）**：人希望得到的结果，通常一句话 + 验收标准。
- **Task（任务）**：围绕一个可验收结果的稳定工作单元；可跨会话、跨 Agent。
- **Segment（段）**：会话中一段连续上下文；是“证据单位”，不必然是任务。
- **Evidence（证据）**：事件、工具结果、提交、PR、测试、人工确认；是事实的来源。

**会话不是任务**。一个会话可以拆多个任务；一个任务可以引用多个会话。任务卡是唯一登记单位。

### 5.2 锚点优先级（先确定性，后模型）

| 级别 | 锚点 | 处置 | 例子 |
|---|---|---|---|
| A0 | 带命名空间的外部任务号：superagent ticket、PTC task/subtask、taskboard taskId、GitHub issue/PR | 直接映射/自动链接（同命名空间、无冲突） | `da9baec…`、`#123`、`task-2026…` |
| A1 | 结构化 native task/todo | 以 native id 建任务或链接 | Claude `<taskId>.json`、OpenCode `todo`、DSH `todo/write` |
| A2 | 项目 + 产物：cwd、git branch、commit、PR、文件路径集合 | 同项目内候选；**MVP 不自动合并** | 同一 repo 同一 PR |
| A3 | 会话标题 + 首条用户请求 + 时间窗 | 候选，需审查 | 标题“修复登录回调” |
| A4 | 语义相似（标题/目标 embedding） | 只作候选，不自动合并 | 两个“优化首页” |

规则：**只有 A0/A1 可自动链接；A2 需同项目且产物重合，仍进人工；A3/A4 只进审查队列。跨项目一律不自动合并，除非 A0 完全相同。** PR/commit 可能服务多个任务，不能单独作为合并许可；cwd/标题只缩小候选范围。每段最多 20 个候选，无候选时生成“待确认任务”，不强配最近任务。

### 5.3 分段

1. 以 `turn/start`（DSH）、`turn_context`（Codex）、`user` 消息（Claude/Cursor）、`message role=user`（OpenCode）为候选边界。
2. 新段起点：用户消息不是上一段的续写（无“继续/接着/还有”等指代）、出现新 A0/A1 锚点、cwd/项目变化、长停顿（>30 分钟）或显式计划/todo。
3. 段终点：下一个起点前；工具循环不切段；一次用户请求后的连续工具/助手回合归同段。
4. 只有“多用户轮次且无锚点”的会话才调用 LLM 判断是否拆段；否则规则优先。
5. 重算分段时旧段保留 `superseded_by`，不物理删除；任务链接可迁移并留审查记录。

**每个来源的任务边界信号不同**，不能假设统一：DSH 用 ticket/trigger/todo/turn；Codex 用 `task_started/turn_context`；Claude 用原生 `taskId` 或用户请求（无原生信号时依赖人工/外部引用）；Cursor 用 `<user_query>`；OpenCode 用 `todo`/用户消息。Claude 子代理复制主会话内容时，关系应是 `extends/continues`（证据链），**不是 `same_task`**；是否需要合并由人工首次确认，不能自动。

### 5.4 候选生成

对每个段：

- 先跑 A0/A1/A2 锚点匹配；
- 无匹配则生成一个候选任务：标题取首条用户请求的简短摘要（规则截断，不调模型）；
- 若段内有多个明显目标，标 `possible_split` 进审查，不自动拆；
- LLM 只在“需要判断任务边界/补全七类事实”时使用，且输出必须带原文引文。

### 5.5 实体解析（合并/拆分）

评分只作候选排序，**不作为自动合并的唯一依据**；模型输出必须带 `candidate_id/relation/evidence_refs/reasons/counterevidence`，关系只允许 `same_task/subtask/depends_on/related/unrelated`，无证据指针拒收：

| 条件 | 分数 | 处置 |
|---|---|---|
| 同一 A0 外部任务号（命名空间一致） | ≥0.98 | 自动链接 |
| 同一 A1 native task id | ≥0.98 | 自动链接 |
| 同项目 + 同 PR/commit/文件集 | 0.75–0.98 | 人工确认（默认建议合并） |
| 同项目 + 标题相似 ≥0.85 + 时间重叠 | 0.75–0.98 | 人工确认 |
| 同标题但不同项目 | <0.75 | 不自动，提示“可能同名” |
| 仅语义相似 | <0.75 | 保持独立，只建 related 建议 |

- **合并**：保留主任务 ID，旧 ID 进 `aliases` 并重定向到主任务；所有证据、事实、todo 迁移；进度去重后重算；审查记录写 `ledger`。
- **拆分**：从原任务拆出子任务；原任务变“伞任务”或保留父关系；不复制证据，只重链。
- **拒绝合并**：记 `review.decided(reject)` 并生成 `do_not_merge`，以后同一对候选不再反复打扰（除非新证据）。
- 跨 Agent 重复劳动：先按产物（PR/commit/文件/测试）去重；没有共同产物时，允许“两条并行记录”，不强行合并。
- **硬否决**：目标互斥、客户域不同、人工明确拒绝合并；出现任一即不自动合并。

### 5.6 稳定 ID

- 任务：`T-<ULID>`（可排序、无冲突）；显示短号 `T-8F3K`。
- 别名：`alias(system, externalId) -> taskId`，外部系统 ID 永远不直接当主键。
- 防止“标题改了任务就丢了”：标题只是属性，不是身份。

### 5.7 防任务爆炸：先归类，再登记

无锚点会话如果“一段一任务”，几天就会产生数百张低质量卡片。规则：

1. 一个段要成为任务卡，至少满足：有用户目标陈述（想要的结果/动作）+（≥2 个用户/助手回合，或 ≥1 个交付物/工具动作，或显式 native task）。
2. 不满足的段进 `unclassified_segments`，只在“未归类会话”视图按项目/时间聚合，不生成卡片、不参与进度。
3. 未归类段可被人工“提升为任务”，或在下一次出现锚点时自动归入已有任务。
4. 同一项目下连续的小会话，按“项目 + 7 天窗口”聚合为 `workstream` 提示，不自动建卡。
5. 纯问答、查资料、一次性命令不建任务；它们只在证据需要时被引用。
6. **历史回填不轰炸人工队列**：回填产生的弱匹配只落 `related` 建议并折叠，任务卡标 `provisional`；`review_items` 加 `origin=backfill|incremental`，只有增量进入默认队列。首建期间队列上限 200，溢出自动降级为 related，不继续堆。

### 5.8 三个典型场景

| 场景 | 正确处理 | 错误做法 |
|---|---|---|
| 一个会话里先修登录、再改首页 | 按新用户请求切两段，各建/链一个任务；共享的工具结果只归相关段 | 整会话一个任务，进度混在一起 |
| 同一任务在 DSH 和 Claude 各做一半 | 同一 A0/A1 锚点自动链到同一任务；证据去重；进度按验收项而非会话计 | 两个任务各算 50%，或按标题合并到错误项目 |
| 两个项目都有“优化首页” | 标题相似但项目不同：不自动合并，提示“可能同名”；各自建卡 | 语义相似自动合并，导致跨项目污染 |


### 5.9 跨 Agent 分工：先建“临时任务锚”，再收证据

常见场景：Claude 定义目标、Cursor 编码、Codex 跑测试，三方都没有同一个 ticket。处理顺序：

1. 不自动把三段合成一个任务；先生成 `provisional_anchor`（**摄取层候选，不建 Focus Hub 任务树条目**；`task_provenance=registry-only`），标题取最早的用户目标，标注“待确认”。
2. 用户或模型提议把后续段用 `cross_session_anchor` 指向该锚点；P1 只接受人工 `link`，P2 才允许高置信提议。
3. 证据 `evidence_refs[]` 允许数组，每项带 `provider_session`（提供者会话）与 `role`（定义/实现/测试）；一个事实可由多源支持，但每条引文仍可回链。
4. 三个段的阶段分别记录（目标/实现/测试），汇总到同一任务的「总体计划」；不要用一段的状态代表全任务。
5. 若之后发现 taskboard/PTC 已有对应任务，**不要改原 `task_provenance`**；给 `provisional_anchor` 与上游任务建 alias/关系，新事实挂上游任务，原任务标 `merged` 并保留历史；不复制两份任务。



## 六、进度、证据与验收

### 6.1 状态与维度分离

| 维度 | 取值 | 说明 |
|---|---|---|
| 工作状态 | `todo / in_progress / blocked / in_review / done / canceled` | 与 DSH taskboard 词表对齐；`canceled` 表示不再继续，不是“完成” |
| 等待原因 | `human / dependency / external / unknown` | 与工作状态正交；不把“等上游”混成“待外部” |
| 验收 | `none / claimed / verified / accepted` | 与工作状态分开；`done` 不等于 `accepted` |
| 证据来源 | `human / native_task / tool / git / test / agent_report / model` | 决定可信等级 |
| 新鲜度 | `fresh / stale` | 超阈值无新证据只标 stale，不改状态 |

> 与 session-summary 既有六状态（待人工/待决定/待外部/在办/已闭环/作废）不是一一对应；登记表用上面的工作状态 + 等待原因表达，映射关系在 P1 用真实数据核对，不强行改写上游词义。

### 6.2 证据等级与自动边界

| 证据 | 可自动做什么 | 不可做什么 |
|---|---|---|
| 人工确认（用户明确说“验收/通过”） | 标记 `accepted`；可置 `done` | 仍需绑定验收对象/版本 |
| 上游权威状态（taskboard done、superagent ticket done） | 镜像为 `done`，并标注 `acceptanceSource` | 不能把“PR merged”解释成用户验收；PR merged 只到 `in_review`/`verified` |
| 工具结果（测试通过、构建成功、文件生成） | 标记对应交付物 `verified`；测试需记录命令、版本、退出码、用例摘要 | 不能推出整个任务 done；会话里的测试日志只是“记录到的结果”，不是系统重新独立验证 |
| Git/PR 事实（commit、PR 打开/合并） | 交付物 `verified`，任务可到 `in_review` | 不能自动 `done`（除非上游明确） |
| Agent 自报（“已完成/已修复”） | 只作 `claimed`，进审查 | 永不自动销项 |
| 模型推断 | 只作候选/提醒 | 不作为验收证据 |

### 6.3 自动更新规则（建议默认）

- `todo → in_progress`：段内有用户请求且有首个动作（工具调用/文件修改/计划），且非纯问答。
- `in_progress → in_review`：出现可验收交付物（PR 打开、文件产出、报告生成）且至少一条 `verified` 证据；**且任务已定义验收标准**。没有验收标准时只能显示“成果候选已出现”，不能自动 `in_review`。
- `any → blocked`：出现明确阻塞语（等权限/等人/等上游）或依赖任务未完成且用户确认；不因“沉默”自动 blocked。
- `in_review → done`：仅人工确认，或上游任务系统明确 done；两者都写 `acceptanceSource/At`。PR merged 只到 `in_review`，不是用户验收。
- 纠正：新证据与旧状态冲突 → 旧事实 `superseded`，新事实 `proposed`；任务标 `contested`，不静默覆盖。
- 过期：7 天无新证据且未 done → `stale=true`；30 天要求复核；不自动 canceled。

**状态推进白名单**（不是概率，而是“允许的证据组合”；未列出的组合不得推进）：

| 转移 | 允许的证据组合 | 禁止 |
|---|---|---|
| `todo → in_progress` | 用户确认任务存在 + 首个工具/文件/计划动作 | 仅标题出现、仅助手声称 |
| `in_progress → in_review` | 任务已定义验收标准 + 至少一条 `verified` 交付物 | 无验收标准、仅 agent_report |
| `in_progress → blocked` | 明确失败工具结果 / 用户说等外部 / 依赖任务未完成且确认 | 沉默、模型推断 |
| `in_review → done` | 人工验收，或上游权威 done（带 `acceptanceSource`） | PR merged、测试通过、助手“完成” |
| `done → in_review` | 反证/验收被质疑，需人工重开 | 自动回滚历史 |

`acceptance_undefined` 是合法状态：任务没有验收标准时显示为灰色“未定义验收”，不自动推进到 `in_review`；用户可随时补标准。**验收标准只能由授权人显式定义，模型不得从会话内容推导“隐含验收条件”**；无标准时即使有 commit/测试/助手声明，也只显示“成果候选已出现”。人工审查队列积压 >10 条且 >4 小时时，新的自动推进降级为候选，不继续进 `in_review`。证据被修正后，系统必须标出受影响的推进并请求重审，不能静默保持旧状态。

### 6.4 进度呈现

- 有验收标准：`已完成验收项 / 总验收项`，并显示 `unknown` 项数；不显示百分比。
- 无验收标准：显示“已完成事实数 / 总事实数（无验收口径）”，明确不是完成度。
- 跨 Agent 重复证据：同一交付物只计一次；并行会话不重复计数。
- 进度每次变化写 `progress_snapshot`，保留时间序列，便于解释“为什么从 3/7 变成 4/7”。

### 6.5 审查队列（决定工具会不会被放弃）

- 默认只收**增量**候选；回填候选折叠为 `related`，不占队列。
- 每条审查项必须展示：候选关系、证据引文、为什么现在提（新事件/新锚点）、不合并的理由、影响哪个任务/进度。
- 操作：`accept / reject / merge / split / rename / mark-do-not-merge`；支持批量接受同类（同锚点、同项目）。
- 队列上限 200；溢出自动降级为 `related` 建议并提示“先清理队列”。每日新增目标 ≤20 条；超过说明规则或模型阈值需要调，不是用户不够勤奋。
- 拒绝一次后生成 `do_not_merge`，同一对候选不再反复出现；用户可随时撤销。
- 审查结果全部写 ledger；不直接改源系统。



## 七、统一登记表

### 7.1 任务卡七节

| 节 | 内容 | 权威/来源 | 关键字段 |
|---|---|---|---|
| 目标 | 要的结果 + 验收标准 | 用户原话优先；模型只能提议 | `statement`, `acceptance[]`, `source` |
| 方案 | 选定的做法、关键取舍、备选 | 会话中的设计/计划；人工确认 | `approach`, `alternatives[]`, `status` |
| 成果物 | 文件、PR、commit、报告、服务 | 工具/Git/文件系统证据 | `kind`, `uri`, `state`, `verifiedBy` |
| 裁决 | 人明确做出的决定（含否决） | 人工确认；上游决策系统 | `decision`, `options[]`, `decider`, `status` |
| 洞察 | 可复用的经验/反模式 | 会话提炼；需人审 | `insight`, `scope`, `confidence` |
| 总体计划 | 阶段、里程碑、当前阶段 | 会话计划/人工 | `phases[]`, `current`, `nextGate` |
| 待办 | 可执行下一步 | native todo 优先；人工 | `text`, `state`, `owner`, `due` |

每节都是**条目列表**，不是一段自由文本；每条有 `id/state/origin/evidence/validFrom/supersedes`。空节显示“未提取”，不编造。

任务卡外层还必须有：`task_id/aliases/title/project/authority/status/revision/coverage/conflicts`；每个条目带共同信封：`fact_id/evidence_refs/asserted_by/recorded_at/valid_at/revision/supersedes/verification`。`asserted_by` 必须能区分 `source:user / source:native_task / tool / git / test / agent_report / model:<name+version>`；模型提炼是派生主张，不能写成“用户确认”。

`evidence` 条目额外带 `source_available`（源文件是否仍存在）、`locator`、`digest`。源被删除后 `source_available=false`，卡片显式标“证据已失效”，不隐藏、不删事实。

### 7.2 存储组合

```text
~/.dsh/session-registry/
  ledger.jsonl            # 登记事实/决定/审查/覆盖的唯一写入口；原始事件另存 events
  events/                 # 统一事件日志（按来源/月份分区，可重建 SQLite）
  registry.sqlite         # 查询投影，可删除重建
  cards/<task-id>.md      # 人读任务卡（生成物）
  index.md                # 按项目/状态索引（生成物）
  registry.json           # 机器快照（生成物）
  registry.csv            # 单表视图：一行一任务，七节摘要列（生成物）
  review/                 # 待审项（生成物，可重建）
  outbox/                 # 未来一方向写回的命令（P4，不在 MVP）
  quarantine/             # 解析失败/未知格式的记录，不静默丢
  state/cursors.json      # 来源水位
  state/sources.json      # 来源开关/隐私策略
  runs/<run-id>.json      # 每轮扫描统计、模型用量、覆盖
  locks/                  # 单写者锁
```

SQLite 最小表：`sessions, events, segments, tasks, task_links, anchors, facts, evidence, progress, conflicts, review_items, aliases, source_cursors, runs, outbox, projection_checkpoint, quarantine`。其中 `events/facts/review_items` 只由 ledger 投影，不单独接受写；`projection_checkpoint` 记录已投影到账本的位置，崩溃后从 checkpoint 续。

**提交单位**：一批事件先 append 到 `events/` 并 fsync，再推进 `projection_checkpoint`；投影从 checkpoint 之后重放，不重放已投影行。`integrity-check` 输出“日志最后 seq / 投影最后 seq / 差异数”，差异 >0 时先标只读，不静默修。

**生成物不可手改回灌**：Markdown/JSON 是只读视图；手改不会隐式改账本。纠正必须走 CLI 形成 `fact.*/review.decided` 事件。

**为什么不是只存 Markdown**：合并、去重、纠正、跨任务查询都需要稳定 ID 和原子追加；Markdown 是投影。**为什么不是只存 SQLite**：人要 review diff、要跨设备带走、要被其他工具读取；追加 JSONL + 生成物两者都要。**为什么不用向量库**：第一期难点是身份与验收，不是召回；语义相似只作候选。

### 7.3 单表视图（“统一登记表”的直接形态）

`index.md` 顶部给一张表，`registry.csv` 给同一张表的机器版：

| 任务ID | 标题 | 状态 | 项目 | 目标 | 方案 | 成果物 | 裁决 | 洞察 | 总体计划 | 待办 | 来源 | 更新 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T-8F3K | 登录回调修复 | in_review | repo-a | 1 条 | 1 条 | 2 个（1 verified） | 0 | 1 条 | 第 2/3 阶段 | 3 待办 | DSH+Claude | 22:00 |

原则：表里每个单元格只放**摘要 + 计数 + 状态**，点击进卡片看证据；不把长文塞进表格，也不把表格当第二份数据。生成物可随时重建，表头固定，便于导出到 Excel/Obsidian。

### 7.3 事实与版本

`ledger.jsonl` 每行一个事件，至少：

```json
{"v":1,"id":"evt_01J...","at":"2026-11-12T22:00:00+08:00","kind":"fact.proposed",
 "taskId":"T-01J...","section":"deliverable","factId":"F-01J...",
 "value":{"kind":"pr","uri":"https://github.com/o/r/pull/123","state":"open"},
 "origin":"git","evidence":[{"source":"dsh","sessionId":"dsh:...","eventId":"dsh:...:123","quoteHash":"..."}],
 "confidence":0.95,"actor":"adapter:github"}
```

- `fact.proposed` 之后只能追加 `fact.accepted/rejected/superseded`，不原地修改。
- `decision.recorded` 必须带 `decider`（人/上游系统）和 `authorityScope`。
- `review.decided` 必须带 `reviewer` 与理由；同一候选不重复打扰。
- 任何投影都能从 `events/` + `ledger.jsonl` 重建；重建前后 `registry.json` 的 `contentHash` 应一致（除生成时间）。

### 7.4 任务卡示例

```markdown
---
id: T-01J8Z3K4
title: 多 Agent 会话的洞察任务聚合与追踪（Focus Hub 式）
status: in_review
project: C:\Users\wwm_1\.dsh\state\superagent\work\session-aggregation-design-da9baec1170c
sources: [feishu:oc_..., dsh:worker-da9baec...]
updatedAt: 2026-11-12T22:00:00+08:00
confidence: high
---

## 目标
- 细化跨 Agent 会话聚合与登记方案，先设计不实现。 [证据](...)
- 验收：七节齐全、可追溯、有挑战与裁决。 [证据](...)

## 方案
- 只读适配器 + 统一事件 + 洞察/任务聚合 + 登记投影。 [证据](...)
- 备选：单一全能 Agent（否决：不可审计、成本高）。 [证据](...)

## 成果物
- design v1.2（本地文件，待评审） — state=proposed
- 6astra 设计稿 / opus5 挑战 / kimi 挑战 — state=verified（存在且可读）

## 裁决
- 登记表按模式 B：已映射任务只读上游；未映射任务有登记权威（非执行/验收）。 decider=用户（待确认）
- P1 只接 DSH；P2 Codex/Claude；P3 Cursor/OpenCode。 decider=设计默认（待确认）

## 洞察
- 会话不是任务；洞察/任务身份、证据裁决、验收/执行权才是难点。
- 摘要 ≠ 洞察；去重看“主张+条件+结果”，不按文字相似。

## 总体计划
- P0 盘点/契约 → P1 DSH-only → P2 Codex/Claude + LLM 提炼/去重 → P3 Cursor/OpenCode + 提升闭环。

## 待办
- [ ] 用户确认 D2–D24（见第十三节；D1 已确认模式 B）
- [ ] 做 Cursor 解密 spike
```

> 卡片是渲染结果；实际条目存为带 `fact_id/evidence_refs/asserted_by/recorded_at/revision/supersedes/verification` 的 JSON。上例的 `[证据](...)` 在真实卡片里是事件深链，不是自由文本链接。

## 八、自动化、成本与运维

### 8.1 调度

- 发现：默认每 5 分钟枚举一次来源资源；增量扫描默认每 60 秒可配（或低频 30 分钟）；不每天全量解压。
- 单批预算：≤500 条事件、≤32MiB 解码内容或 ≤15 秒，任一达到即让出调度；历史回填每轮只占 30% 预算，新数据优先。
- 模型预算：默认每日 ≤200 次调用、≤100 万输入 token；达到任一额度即排队，不牺牲证据采集。**连续 3 天超上限 → 自动切规则-only 并通知**，不无限排队。
- 背压：`review` 待审 >200 条时暂停 LLM 抽取/自动候选，只做确定性锚点；溢出候选降级为 `related`，不继续堆。
- 首建前先采样 50 个会话，实测真实事件率与弱锚点占比，再定预算；数字写进裁决日志，不用拍脑袋。
- 失败：每个 Adapter 独立 try/catch；失败来源标 `partial`，下一轮重试；退避 1/5/30 分钟，连续 5 次失败隔离并告警；权限错误/不支持格式不无限重试。
- 锁：`locks/writer.lock` 单写者；companion、CLI、计划任务不能同时写；Focus Hub 的写入由其 server 串行，不跨进程写其文件。
- 仪表盘：`last_scan / last_success / lag / parse_errors / unsupported / pending_reviews / model_calls / tokens / anchor_coverage / wal_size`；覆盖分完整、部分、未知；“没读到”不显示为“没有”。

### 8.2 量级与成本（本机实测）

- 存量：DSH 1,424 个会话文件；Codex 235 活跃 + 25 归档；Claude 54 主会话；Cursor 114 转录；OpenCode 302 会话/10,313 消息/43,028 parts。
- 首建全量解析可行（DSH 最大文件数 MB；OpenCode 只按时间窗查询），但不要每轮全量。按 1,424 个 DSH 会话、平均 1–3 个有效段估算，首建约 2,000–4,000 段；只对“无锚点且多用户轮次”的段调用模型，首建模型调用控制在 200–400 次以内，其余靠确定性锚点。
- 日常：按每天 2,000 条新事件、10% 需要模型、每次 4k input token 估算，约 20–50 次调用、80–200k input token；实际以 P1 采样校准。达到日预算即排队，不静默加钱。
- 缓存键：`segmentHash + anchorContext + modelVersion + promptVersion + privacyPolicyVersion`；同一段不重复抽取；模型/提示词/策略变化才失效。

### 8.3 运维

- `registry status`：来源覆盖、最后成功时间、待审数、失败数、token 用量。
- `registry integrity-check`：日志/投影/checkpoint 差异、证据失效数、quarantine 数。
- `registry rebuild`：从 `events/` + `ledger.jsonl` 重建 SQLite/Markdown；失败不破坏旧投影。
- `registry export --format md|json`：导出快照；默认不含原始引文。
- 升级：适配器版本 + schema_version；迁移前备份；不支持自动降级。
- 卸载：停止调度、保留数据；不删源会话。

### 8.4 失败模式与恢复

| 失败 | 表现 | 处置 |
|---|---|---|
| 源文件被删/轮转 | 会话消失、覆盖缺口 | `evidence.source_available=false`，UI 显式标“证据已失效”；保留任务卡；不删事实；下一轮重试 |
| SQLite 锁/损坏 | 读超时/`database is locked` | 只读重试一次；跳过该来源并标 `partial`；不尝试 repair/vacuum |
| schema 漂移 | 新记录类型/字段缺失 | 适配器版本检查；未知记录入 `quarantine` 并计数；不静默丢弃；仪表盘必显示 quarantine 数 |
| 模型坏 JSON/引文不匹配 | 抽取失败 | 丢弃该候选、重试一次、降级为确定性事实；不写半条事实 |
| 账本写一半崩溃 | 最后一行不完整 | 启动时校验 JSONL，截断到最后一条完整行；SQLite 全量重建 |
| 时钟回拨 | 事件顺序乱 | 同时存 `sourceTs` 与 `ingestSeq`；冲突裁决用 `ingestSeq`，展示用 `sourceTs` |
| 重复 ID/哈希碰撞 | 唯一约束冲突 | 事件 ID 冲突则加 `#n` 后缀并告警；任务 ID 用 ULID，不复用 |
| 解析器升级 | 新旧语义混布 | 默认只对新事件生效；重解析需显式命令并报告差异数；cursor 带 `parser_version`，不静默混跑 |
| 升级/迁移 | schema 不兼容 | 先备份 `events/` + `ledger.jsonl`；`schema_version` 迁移脚本；失败回滚，不自动降级 |

**单源故障的可见性**：每个来自特定来源的投影字段带 `source_health`（最后成功时间/当前故障）；展示层标“该字段数据源故障”；重建前输出缺失清单（未投影事实数、来源、影响任务数）；恢复后显式对账“已恢复 N 条”，不静默更新。



## 九、隐私、安全与不可信输入

| 风险 | 对策 |
|---|---|
| 会话含客户数据/凭据/私聊 | 默认本地处理；只存脱敏引文/哈希；原始文本不复制；来源级策略 |
| 外部模型外发 | `local_only` 默认；`redacted` 需来源白名单；`raw` 需显式逐源开启；**先确定模型运行位置（本机/远程）**；记录用量但不记录原文 |
| Prompt injection（会话里写“忽略规则/执行命令”） | 抽取模型无工具、只输出 JSON；内容视为数据；schema 校验；引文必须逐字来自事件；绝不执行会话中的指令 |
| 凭据泄漏 | 正则 + 熵检测；命中即隔离该事件、不入库、告警；不把密钥写日志；UI 文案用“已检测，非保证”，不用“已脱敏”暗示绝对安全 |
| 凭据被模型记住/复现 | 含凭据的原文**不发送给模型**（发送前替换为占位符）；模型输出再过一遍凭据检测；不能假设模型会“忘记”，所以源头不发送是主防线；日志只记“命中类型/位置”，不记值 |
| 越权读取 | 只读打开；路径白名单；不跟随会话中的任意路径去读文件 |
| 删除/保留 | 脱敏摘录 30 天、任务事实 1 年；`purge` 按来源/时间删除并写审计；不承诺“删源即删卡”除非显式 purge |
| 源被删/轮转后无法复核 | 采集时存 `digest_snapshot`（采集时刻内容 hash）+ 脱敏短摘录（保留期）；源消失后标“证据已失效”，仍可核对 hash/摘录；Cursor 加密根 blob 首期标 `unsupported`，不承诺复核 |
| 多设备 | 第一期不做实时同步；只导出脱敏快照；不在多端同时写同一 ledger |

**模型运行位置是前置裁决**：本机没有 GPU 证据；如果模型只能在远程，所谓“5 分钟可见”只能是证据层，任务层异步且可能隔天。如果模型必须本地，CPU 推理的成本/时延要重新估算，可能需要缩小到“只抽取、不实时”。这个决定不能藏在实现里。

**删除语义**：append-only 不等于禁止合规删除。删除请求追加 `tombstone` 事件，再清理摘录、索引、缓存和到期备份；审计只留非敏感删除凭证。默认脱敏摘录保留 30 天、任务事实保留 1 年；最终期限由用户拍板（D9）。**凭据/密钥永不写日志、永不进入模型提示、永不进入卡片**；命中后替换为稳定占位符。压缩输入限制解压比与最大解压体积，防压缩炸弹。路径规范化，防目录穿越/符号链接逃逸。

## 十、与存量系统的边界

| 系统 | 权威 | 登记表的关系 | 写回 |
|---|---|---|---|
| DSH taskboard | 任务状态/验收/看板 | 读任务作 A0 锚点；卡片标注“source of truth: taskboard” | 不做 |
| PTC | 根任务/子任务/receipt/账本 | 读 registry.jsonl 与 receipt 作证据 | 不做 |
| superagent | ticket/trigger/assignment/report | ticket 作 A0 锚点；report 作证据 | 不做 |
| session-summary | 会话摘要/目标聚合/六状态待办 | 复用其 digest/extract；登记表不重写摘要 | 不做 |
| focus-hub / track | 对象库（SESSION/ARTIFACT/RULE/PROCESS）、任务树、阶段与验收、洞察视图 | 作为首选工作台：聚合器只“提议/追加”Focus Hub 兼容对象；不直接改 `objects.jsonl` 绕过 API，不替它推进阶段/验收 | 不做（经 Focus Hub API/执行确认后由它写） |
| 本登记表 | 跨 Agent 任务的登记投影 + 人工裁决记录 | 对“未进入任何上游系统”的任务，登记表是登记权威（不是执行/验收权威）；对已映射任务只读 | 只写自己的 ledger |

**权威模式（必须选一个，不能混）**：

| 模式 | 对已映射任务 | 对未映射任务 | 本期 |
|---|---|---|---|
| A 纯只读 | 只展示，不推进状态 | 只展示候选，不建正式任务 | 可选 |
| **B 投影权威（推荐）** | 只读上游状态，不覆盖；冲突标 advisory | 登记表有“登记权威”（身份/归属/七节），但执行/验收仍归人/上游 | **采用** |
| C 受控写回 | 先 outbox，等上游确认再更新 | 同 B | P4 以后再评估 |

“是否已进入上游”用静态 `task_provenance` 记录：`upstream:taskboard/T001` 或 `registry-only`，**不允许动态切换**；新增来源若发现与既有任务相关，只能建 alias/关系，不能把 `registry-only` 偷改成上游权威。模式 B 下，登记表不能替 taskboard 改 status，也不能把“登记”说成“验收”。

**一条铁律**：同一事实只有一个写权威。登记表可以“引用/镜像/提议”，不能“替上游改状态”。Focus Hub 的对象/任务/阶段/验收是它的权威；聚合器只能按 15.7 的 A 方案提交提议，且经过其执行门。第二期若要做“提议到 taskboard”，必须是一方向、带人工确认、可撤销的导出：`outbox` 保存请求，成功后等待读取权威事件再更新投影；不能同时写本地最终状态和远端状态。若 taskboard 与 PTC 对同字段都声称权威，阻断并请用户裁决。上游系统的实际写 API/权限**尚未验证**，本表是责任建议，不是现状承诺。

### 10.1 字段级权威（避免“只读投影”变成第二任务系统）

| 字段 | 权威 | 登记表行为 |
|---|---|---|
| 任务 status / owner / priority | taskboard / PTC / superagent / Focus Hub 任务树 | 只读镜像；标 `authority`；不覆盖 |
| 目标 / 验收标准 | 上游任务系统或人工确认 | 引用；人工修正写本地 `decision`，不回写上游 |
| 方案 / 成果物 / 洞察 / 总体计划 | 会话 + 人工确认 | 登记表可提议、可展示；执行前确认 |
| 阶段 / 验收 | Focus Hub 或上游权威 | 只读镜像；阶段推进/验收必须人工 |
| 删除 | 源系统 | 登记表只标“已消费/已失效”，不物理删上游 |

**权威冲突**：默认不静默选一个。允许 `authority_decision` 记录“本任务信任哪个系统/字段”，并把低优来源标 `advisory`；没有该决定时显示冲突并请求用户裁决；高优权威不可达 24 小时标 `authority_unreachable`。优先级是每个字段可配置的，不假设“PTC 永远高于 taskboard”。

## 十一、分期落地

| 阶段 | 目标 | 交付 | 验收（可测试） | 投入 |
|---|---|---|---|---|
| P0 复用核对/契约 | 证明“复用 Focus Hub 可行” | Focus Hub 只读核对（已完成）、**修 `firstFrameText` 1MiB 首帧上限 + 回归**、`dsh-source/flow-runner/analysis` 复用验证、`/api/dsh/workspaces` + 3–5 workspace 扫描 benchmark、对象/建议/任务 API 契约、V2 元数据字段决策、模型位置裁决 | 325+19 测试基线通过；**191 个 ≥1MiB 长会话全部可读**；3–5 workspace 扫描无源写入；SESSION 去重 0 重复；不污染真实任务 cursor；V2 字段兼容 95 创建/17 活跃旧洞察 | 4–6 人日 |
| P1 DSH 全 workspace + 复用主链 | 先有可信的 DSH 洞察/建议/卡 | 复用（已修 1MiB 首帧的）`dsh-source`/`flow-runner`/`analysis-adapter`；全 workspace 枚举（`/api/dsh/workspaces`）+ 独立 ingest cursor；SESSION 去重；洞察/摘要/任务建议投 `suggestions`；七节卡生成（数据视图，不新建 UI）；既有 Focus Hub 界面展示 | 30 个真实 DSH 任务/洞察可追溯；SESSION 重复 0；cursor 不污染真实任务；建议采纳/驳回可回放；`done` 全部人工/上游；文本-only 边界明示 | 8–12 人日 |
| P2 Codex+Claude+V2 洞察 | 跨 Agent、可去重、可评估 | Codex/Claude Adapter（文本级）；V2 洞察类型/边界/新颖性/主张+条件+结果去重；合并/拆分审查；50 任务/200 段评测；DSH 只读侧栏/卡 | 自动关联 precision ≥0.98/recall ≥0.8；洞察证据回链 100%；摘要换词误报可控；无自动 done/规则；V2 旧对象兼容 | 15–20 人日 |
| P3 Cursor+OpenCode+提升闭环 | 日常可用 + 改进 | 2 个 Adapter、增量调度、冲突/过期、预算/背压、健康页、洞察→改进候选→执行确认→实测/回退 | 增量一轮 ≤15 分钟；重复扫描幂等；单源失败不影响其他；改进有验证/回退；Cursor 标 partial 或完成 spike | 10–15 人日 |
| P4 可选 | 降低手工 | 导出到 taskboard 的“提议”通道、多设备快照、更多 Agent | 每次写回有人确认、可撤销；双写检测为 0 | 5+ 人日 |

**总计约 37–53 人日**（单人估算，不含用户评审与上游系统改造）。MVP（P0+P1）约 12–18 人日；复用 Focus Hub 后，P0/P1 不再承担“从零写 DSH 解析/对象 API/分析链”的工作，但 P0 必须计入 1MiB 首帧修复。这不是“两三天能上线”的项目；先做 P0/P1 才能判断 P2 的 V2 洞察质量。

**MVP 明确不做**：重写 Focus Hub 的 DSH 扫描/对象 API/分析链；Cursor 加密库完整还原；自动写回；自动验收；全量向量检索；跨设备实时同步；全自动任务合并；工具/todo/job 事件摄取（P2 再评估）。

**评估集（P1 结束前建）**：30 个会话，按来源分层（DSH 12 / Codex 6 / Claude 6 / Cursor 3 / OpenCode 3），覆盖“一会话多任务、一任务多会话、同名不同项目、跨 Agent 重复劳动、只有工具无用户目标、长会话压缩”。人工标注：任务边界、任务链接、七节事实、证据位置。指标：任务识别 precision/recall、链接 precision（错并为 0 是硬门槛）、七节完整率、证据回链率、误报 done 率、每任务审查耗时。评估集不得进入提示词或训练；每次规则/模型变更跑回归。

**实现前必须做的 spike**：

1. Cursor `store.db` 根 blob 解密/官方导出是否可行；不可行则永久标注 transcript-only。
2. DSH 多帧 zstd 解码：Node 内置 API 只解首帧（已实测）；验证逐帧迭代器或系统 `zstd` CLI 的稳定性与性能。
3. DSH 会话 compaction 是否重写前缀、`seq` 是否跨重写稳定；用真实文件验证。
3. Claude 子代理与主会话的重复计数；按 `isSidechain`/路径验证。
4. Codex 归档 `.zst` 覆盖范围与 `local_thread_catalog` 对应关系。
5. 30 个会话的“任务身份”人工金标；先测合并精度，再谈自动化。

## 十二、关键洞察、反模式与不要做

### 12.1 关键洞察

1. **会话不是任务**：任务是一等公民，会话只是来源；不先解决这个，登记表会退化成“聊天索引”。
2. **先收 structured task，再让 LLM 猜**：Claude tasks、OpenCode todo、DSH todo/write、Codex thread catalog 已经给了大量锚点；LLM 应该补盲，不是从零理解。
3. **最大风险是身份与验收权**：解析错可以修；错并任务、错标完成会污染全部进度。
4. **只读聚合 + 人工裁决比自动写回可持续**：写回会制造第二真相和权限事故。
5. **证据指针比原文副本更安全**：登记表要能回答“凭什么”，不是“全文是什么”。
6. **跨 Agent 去重先看产物**：同一 PR/commit/文件比“标题相似”可靠得多。
7. **增量水位是可用性分水岭**：全量扫描只能首建；日常必须按 cursor 增量。
8. **“自动更新进度”应重新定义为“自动收集证据并提议状态”**；否则就是自报销项。
9. **不完整也能有用**：明确标 partial 比“全平台支持”的假象可靠；覆盖缺口本身就是信息。
10. **统一入口不等于统一权威**：展示可以合并，决定权不能合并；每个领域保留自己的写权威。
11. **模型越强，提交权限越应窄**：模型用于补盲，不用于裁定自己的工作；强模型只处理人工选定的疑难候选。

### 12.2 反模式

- 把会话摘要当任务事实，把“助手说完成”当验收。
- 用语义相似度自动合并任务；用标题当唯一 ID。
- **重写 Focus Hub 已经实现的 DSH 扫描/对象 API/分析链**，制造两套 SESSION/对象/游标。
- 登记表双写 taskboard/PTC；或让 Agent 直接改验收状态。
- 把原始聊天/客户数据全量复制进登记表。
- 一个“大 Agent”每轮重读全部历史；一个提示词包打所有来源。
- 用百分比表示没有验收标准的进度；用消息数/工具调用数冒充完成度。
- 为 Cursor 加密库绕过安全边界、破解或导出私人数据。

## 十三、裁决候选（需用户拍板）

| # | 决策 | 建议默认 | 备选 | 影响 |
|---|---|---|---|---|
| D1 | 登记表的权威边界 | **用户已确认（2026-11-13）：模式 B**——已映射任务只读上游；未映射任务有登记权威（非执行/验收）；不写回 | 成为唯一任务系统 | 决定是否双写/迁移 |
| D2 | 首期来源 | P1 DSH；P2 Codex/Claude；P3 Cursor/OpenCode | 五源齐上 | 决定 P1 工作量与价值 |
| D3 | 外部模型策略 | 默认 local-only；无锚点段可用脱敏远程 | 全部本地 / 全部允许 | 隐私 vs 覆盖率 |
| D4 | `done` 的判定 | 仅人工或上游权威；工具证据只到 verified | 允许 PR merged 自动 done | 误报 vs 自动化 |
| D5 | 存储位置 | companion 状态 `~/.dsh/session-ingest/`；Focus Hub 数据仍在 `focus-hub/mvp/data/`，只经 API；导出快照，不进 git | 放进 Focus Hub 数据目录/进项目仓库 | 同步/隐私/可携带 |
| D6 | UI 优先级 | 复用 Focus Hub 视图 + Markdown/JSON 卡；不新建第五个 UI | 先做独立 GUI | 交付速度/重复建设 |
| D7 | 任务粒度 | 以“可验收工作单元”为准；目标可含多任务 | 一会话一任务 | 聚合质量 |
| D8 | Cursor 支持 | transcript-only（partial）；IDE 标 unsupported；解密通过再升级 | 第一期完整支持 | 风险/工作量 |
| D9 | 保留期 | 脱敏摘录 30 天、任务事实 1 年 | 永久保留 | 隐私/容量 |
| D10 | 调度频率 | 发现 5 分钟、增量 60 秒 / 低频 30 分钟；预算上限 | 实时/每日 | 成本/新鲜度 |
| D11 | 自动关联阈值 | 仅 A0/A1 且 ≥0.98；A2 一律人工 | 放宽到 A2 自动 | 错并风险 |
| D12 | 写回 | 前 3 个月只读；P4 才做 outbox 提议 | 首期受控写回 | 第二真相风险 |
| D13 | 部署形态 | Focus Hub core + `session-ingest` companion（独立进程/CLI）；不新增 DSH 插件/独立 Web | 全塞 8770 单进程 / 独立 Web | 资源隔离与重复建设 |
| D14 | 模型运行位置 | P0 前确认本机/远程；任务层允许异步 | 假定本机实时推理 | 5 分钟承诺是否成立 |
| D15 | 任务 ID 迁移 | ULID + 重定向表 + 导出/导入；外部引用旧 ID 时保留 aliases | 用标题/路径派生 ID | 换机/重建是否漂移 |
| D16 | 回填队列 | 回填不进默认人工队列；只落 related/provisional | 回填也进队列 | 首日是否被淹没 |
| D17 | Focus Hub 集成 | 方案 A：作为 Focus Hub 的摄取/提炼适配器，复用其对象与视图 | 独立第五个视图 / 只导出快照 | 是否重复建设 |
| D18 | 洞察采纳与执行门 | 阅读/引用不设审批；改任务/规则/行为才要执行确认 | 洞察一律先审批 | 用户是否还敢记 |
| D19 | 改进/SOP 升级 | 无实测不升级；一次成功只算参考案例 | 成功三次自动 SOP | 规则污染风险 |
| D20 | 权威冲突裁决 | 字段级 `authority` + `authority_decision`；冲突不静默选边 | 固定优先级（如 PTC 永远高） | 跨系统状态互相覆盖 |
| D21 | 与 Focus Hub 的合并形态 | **同一产品、两个组件**：Focus Hub 工作台/对象权威 + 本项目的摄取/提炼适配器；分阶段合并 | 立刻单进程/单仓库合并；或保持两个产品 | 耦合度/交付速度 |
| D22 | DSH 摄取实现 | **先修 `firstFrameText` 的 1MiB 输入/128MiB 输出上限（改流式 header），再复用** `dsh-source.mjs`/`flow-runner.mjs`/`analysis-adapter.mjs`；只扩展全 workspace/多来源 | 从零重写 DSH 解析/分析 | 交付周期/回归风险 |
| D23 | V2 洞察元数据 | 先增量写 `derived_from.insight`（类型/边界/新颖性/关系），必要时再升对象字段；旧 95 创建/17 活跃不改 | 改写对象库/重算旧洞察 | 兼容性/迁移风险 |
| D24 | 全局摄取游标 | 独立 `__ingest__`/companion cursor 命名空间；不占用真实任务 ID | 用真实任务扫描所有会话 | 污染任务读点/视图 |

> **用户已确认**：D1 = 模式 B（2026-11-13，飞书原话「模式b」）。其余 D2–D24 仍待拍板；D17/D21 是同一个问题的两个层次：要不要接 Focus Hub（D17）与接到什么程度（D21）；D22–D24 是 v1.2 的实现选择。
>
> **与合并的关系**：若 D17/D21 通过，D1 的“未映射任务登记权威”收窄为**摄取层候选**；Focus Hub 任务树是唯一正式任务权威，本项目不建平行任务列表。已映射任务仍只读上游，未映射候选不冒充上游。

### 未决问题（需要用户回答，不能由设计默认）

1. 谁有权说“这个任务完成/验收”？只有你，还是某些上游系统（taskboard done、PR merged）也可以？
2. 哪些来源允许把脱敏内容发给远程模型？有没有“绝对不能外发”的来源？
3. 登记表要不要跨设备同步？如果要，冲突时以哪台为准？
4. 现有 taskboard/PTC/superagent 里已有任务，登记表是“只链接”还是“允许导入副本”？
5. 任务粒度：你希望一张卡对应“一个可验收结果”，还是“一次会话/一个项目阶段”？
6. 保留期：证据指针、任务卡、审查记录分别保留多久？删除源会话后卡片怎么办？
7. 审查负担：你每天愿意花多少分钟处理合并/拆分/验收？超过多少就应该自动降级为“只提示”？
8. 是否接受“第一期 Cursor 只能看 transcript、看不到加密聊天”的不完整覆盖？

## 十四、待验证清单

- [ ] Cursor `store.db` 根 blob 加密算法/密钥/官方导出；transcript 覆盖是否足够。
- [ ] **P0 阻断：`firstFrameText` 1MiB 上限**：191/1,384 个 ≥1MiB 长会话当前 `zstd-decode`；改成完整 buffer/流式读首帧，加 >1MiB 回归；修后 191 个全部可读。
- [ ] **复用验证**：`dsh-source.mjs` 对当前 28 个 SESSION/50 个 cursor 的只读重放；不重写解码。
- [ ] **全 workspace**：`/api/dsh/workspaces` 枚举 + 3–5 个 workspace 的 `scanWorkspace` benchmark；1,384 个 v4 文件的覆盖/耗时。
- [ ] **全局 ingest cursor**：独立命名空间扫描后，真实任务的 `cursors`/`flowCursors` 不变（不污染）。
- [ ] **Focus Hub 回归**：325 模块 + 19 服务端测试作为基线；新代码不得改坏。
- [ ] **V2 元数据兼容**：`derived_from.insight` 增量字段可读写；95 创建/17 活跃旧洞察仍可列表/筛选/历史。
- [ ] `dsh-source` 的 compaction/torn/fork 行为在真实会话上的边界；`contentDigest` 历史变化。
- [ ] Claude 子代理 JSONL 与主会话的重复计数；`isSidechain` 语义。
- [ ] Codex `archived_sessions` 覆盖范围；`local_thread_catalog` 与 rollout 的映射。
- [ ] OpenCode `time_updated` 水位在 WAL/并发写下的可靠性；`todo` 表无 id 的稳定键；主键/索引实测。
- [ ] 上游 taskboard/PTC/superagent 的实际 schema、写 API、权限与六状态映射；权威矩阵获用户确认。
- [ ] 删除/墓碑/审计链：删除后索引、缓存、备份不残留；恢复演练。
- [ ] 30 个真实任务的人工金标：合并 precision/recall、七节抽取完整率；再扩展到 50 任务/200 段；按时间切分并加 100 对硬负例。
- [ ] OpenCode 注入测试：人为回拨 `time_updated` 后跑增量，断言不丢；`todo` 去重键验证。
- [ ] JSONL offset 校验：offset 处首行必须可解析且 native id 连续，否则回退 generation 重扫。
- [ ] 任务 ID 跨重建/换机稳定性：导出/导入后旧 ID 是否仍能重定向；外部引用是否破链。
- [ ] 模型抽取的引文校验：多少比例能逐字回链；不能回链的如何降级。
- [ ] 隐私：哪些来源允许脱敏外发；凭据正则/熵检测的误报率。

## 十五、洞察任务模型（Focus Hub 对齐，v1.1/v1.2）

### 15.1 对象与信封

Focus Hub 已经有一套可复用的对象语义：`SESSION / ARTIFACT(kind=summary|insight|report|file) / RULE / PROCESS / 任务树 / 里程碑 / parked / 材料 / 外部组`。本设计不另造一套；跨 Agent 聚合层输出 **Focus Hub 兼容对象**，由 Focus Hub 的 8770/7801 或 DSH 薄视图消费。

最小信封（沿用 Focus Hub `objects.jsonl` 的字段语义）：

| 字段 | 要求 |
|---|---|
| `object_id` | 前缀 + ULID；前缀与 `object_kind` 一致 |
| `object_kind / subkind` | `session / artifact / rule / process / task / milestone / suggestion`；artifact 再分 `summary/insight/report/file` |
| `title / summary` | 必填；summary 不含秘密或未授权正文 |
| `status` | `proposed / active / confirmed / retired / rejected`，与“执行确认”正交 |
| `project_id` | 必填；不从目录名推断 |
| `source_ref / source_hash` | 来源会话/事件指针 + sha256 |
| `canonical_body_location` | 证据取源位置；不复制原文 |
| `revision / supersedes` | 连续正整数；更正产生新 revision，旧版保留但退出引用 |
| `cursors` | 仅 SESSION，按 `task_id` 分区（同一会话给两个任务用，各记各的读点） |
| `provenance` | `captured_at`、`scanner_version`、`model/prompt_version`（若经模型） |
| `privacy_scope / sync_mode` | 默认 `local / index_only` |

**两道门**（Focus Hub 用户口径）：

1. **阅读/引用门**：摘要、洞察产生即可查看、检索、被后续分析引用，不设审批。
2. **执行门**：把洞察/规则/流程拿去**改任务、改约束、改行为**时才需要确认，记录确认主体（人/Agent）与时间。执行门关着不影响对象可见。

### 15.2 洞察对象

```json
{
  "object_kind": "artifact", "subkind": "insight",
  "title": "同一会话可服务多个任务时，读点必须按任务分区",
  "claim": "会话读点属于 SESSION 且按 task_id 分区，否则两个任务会互相顶掉进度。",
  "why_keep": "跨任务复用同一会话时，决定增量扫描与重复处理是否正确。",
  "evidence": [{"session_id": "dsh:...", "event_id": "...:123", "quote": "…", "role": "user"}],
  "scope": "多任务共用同一会话的增量扫描",
  "boundary": "单任务单会话不适用；跨设备同步未验证",
  "insight_type": "design_principle|observation|hypothesis|correction|risk|process",
  "nature": "explicit_user|agent_inference|verified_observation",
  "status": "candidate|accepted|disputed|superseded|retired",
  "novelty": "new|known|refines|contradicts|unknown",
  "confidence": "low|medium|high",
  "execution_confirmed_by": null,
  "relations": [{"type": "refines|contradicts|duplicates|depends_on", "target": "I-..."}],
  "revision": 1
}
```

规则：

- **摘要 ≠ 洞察**：摘要是压缩，洞察是高价值识别；不能把摘要换词当洞察。
- 每条洞察必须有“值得以后找回”的理由、来源引文、适用边界；边界未知就写 unknown，不补编。
- 性质必须区分：用户明确说、Agent 归纳、实测观察；模型归纳不得写成“用户确认”。
- 洞察可以只保留为认识，不必转成任务；登记 ≠ 采纳为执行规则。
- 更正产生新 revision，旧版保留但退出引用；矛盾可见，不静默覆盖。

### 15.3 任务建议对象

任务建议不是任务。字段：`deliverable`（交付什么）、`why_continue`（为什么继续）、`relation`（advance_existing / subtask / new_task / none / unrelated）、`completion_criteria`（未知就写 unknown）、`evidence`。匹配顺序：**推进已有任务 → 拆已有任务子项 → 确有新任务 → 无需建任务 → 归属不明**。只有用户确认“采纳”才在任务树建任务；模型不得直接建顶层任务。

### 15.4 阶段、轨道与里程碑

- 阶段：`需求确认 → 方案 → 实现 → 验收`；由证据识别（已确认对象/任务完成 → 验收；代码/文件类产物或推进中会话 → 实现；设计/报告/摘要 → 方案；无产物 → 需求确认），每个目标带 `stageBasis`；人工可纠正，纠正优先。
- 轨道：一条轨道=一个一级目标；会话归入其推进的轨道；洞察/约束/成果物记“最后关联轨道”；无归属进 `orphans / materials / externalGroups`，不猜。
- 里程碑：`planned / reported / evidence_supported / accepted`；`reported`（自称完成）不等于 `evidence_supported`，更不等于 `accepted`；条件未定义就写“验收条件未知”。

### 15.5 去重（任务与洞察分开）

| 对象 | 去重键 | 允许合并 | 禁止 |
|---|---|---|---|
| 任务 | 外部任务号/PR/commit/native task + 项目 + 产物 | 同 A0/A1 锚点；同项目同产物人工确认 | 仅标题/语义相似；跨项目同名 |
| 洞察 | `claim + conditions + outcome` + 适用范围 | 同一主张、同条件、同结果，来源不同 → 合并证据，保留多来源 | 文字相似但条件/结论相反；把“相关”当“同一”；把摘要当洞察 |
| 摘要 | 来源会话 + 覆盖区间 + 版本 | 同区间可重建 | 与洞察混为一类 |
| 成果物 | uri + digest + revision | 同产物 | 同名不同版本 |

洞察合并后：一个 canonical 对象 + 多个 `source_refs` + `aliases`；不同条件的相反观点**并列**并建 `contradicts` 关系，不互相覆盖。合并/拆分必须留审查记录；人工拒绝生成 `do_not_merge`。去重指标：重复率、错并率（硬门槛 0）、合并后证据数、审查负担。

### 15.6 提升闭环（洞察 → 改进）

```text
洞察候选 → 核对（证据/条件/反例）→ 人工/授权采纳
        → 改进候选（任务计划 / 约束 / SOP / 工具 / 交互）
        → 执行确认（改任务/规则前）
        → 小范围试用或实测
        → 结果与反例回写 → 更新置信度/适用范围
```

- 改进必须有“改什么、为什么、预期指标、验证方式、失败回退”；没有实测就标 `unverified_improvement`，不写成成功。
- 一次成功不升级为通用 SOP；SOP 候选需条件、步骤、验证、失败分支。
- 失败/反例保留，用于缩小适用范围；不删除历史。
- 改进动作仍然只写自己的对象/账本；改任务树/规则必须走 Focus Hub 的执行确认或上游授权。

### 15.7 与 Focus Hub 的集成（推荐 A）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐）** | 聚合器作为 Focus Hub 的“会话摄取/提炼适配器”：输出 Focus Hub 兼容对象，经其 `capture/propose/correct/confirm_execution/link` 或对象 API 写入；复用 8770/7801 的工作层/流程/会话/轨道视图 | 避免第五个孤立视图；复用对象版本、读点、执行门、验收；需要遵守 Focus Hub 单进程/对象 API 边界 |
| B | 独立登记服务 + Focus Hub 兼容 schema；只导出快照，不直接写 Focus Hub | 风险低、集成慢；用户可能在两个视图间切换 |
| C | 只做 DSH 侧栏，不复用 Focus Hub | 最快，但重复建设、与用户“类似 Focus Hub”的预期不符 |

选 A 的前提：Focus Hub 的对象 API/单进程边界可接受（当前 8770 单进程、`objects.jsonl` + `project.json`），且不直接改 `objects.jsonl` 绕过 API；聚合器只做“提议/追加”，不做验收/阶段推进（阶段推进与任务验收必须人工，沿用 Focus Hub 口径）。

**核对后的 A 方案（模块级，2026-11-13）**：Focus Hub 已有可复用的实现，不要从零写：

| Focus Hub 模块 | 已实现 | 本项目动作 |
|---|---|---|
| `mvp/dsh-source.mjs` | DSH v4 多帧 zstd、contentDigest、seq/block 游标、torn 尾帧、fork 继承跳过；19 项测试。**但 `firstFrameText` 1MiB 上限导致 191/1,384 长会话失败** | **先修 1MiB 首帧并加回归**，再复用/扩展；不要重写 DSH 解码 |
| `mvp/flow-runner.mjs` | scan→raw artifact→analysis→insight/summary/suggest-task→links→cursor；partial 不推进；409 flow-busy | 复用 DSH 主链；全局摄取另加 cursor 命名空间 |
| `mvp/analysis-adapter.mjs` | summary/insight/suggest-task/artifact、digest、source/task 校验；最多 4 洞察/2 建议 | 复用 V1；V2 元数据/去重是新增层 |
| `mvp/obj-store.mjs` + `obj-api.mjs` | SESSION/ARTIFACT/RULE/PROCESS、revision/correct/retire/mark/ack/link/cursor/confirm | **只经 API 写**；不直接 append `objects.jsonl` |
| `mvp/suggestions.mjs` + API | summary/insight/suggest-task/artifact/project-move 收件箱；幂等；采纳由 Focus Hub 写 | 外部 Agent 投建议，不直接写对象 |
| `mvp/server.mjs` 项目/任务/验收/阶段 | `project.json` 任务树、`/api/tasks/from-suggestion`、`/api/acceptance`、`/api/attribution/stage`、`/api/projects` | 不建平行任务；不改 status；验收只走人工 |
| `mvp/association-store.mjs` | 显式话题/任务引用（58 fragment）、revision、人工改关联 | 复用为显式关联；不做语义合并 |
| 测试基线 | 325 模块 + 19 服务端通过（2026-11-13 实测） | P0/P1 以这批测试为回归基线 |

**三个硬边界**（v1.2 新增）：

1. **只做文本摄取，不假装有工具/待办**：`dsh-source` 只取 `user/message` + `assistant/message` 的 text block，工具结果/reasoning/todo/job 被过滤。P1 接受“文本 + 任务树 + 摘要”的输入；tool/todo 事件是新增能力，不能声称复用。
2. **全局摄取不能污染真实任务游标**：`/api/dsh/workspaces` 能列出 workspace，`scanWorkspace` 一次一个 workspace 且 cursor 绑定 `taskId`；全量聚合要使用独立的 `__ingest__`/companion cursor 命名空间或本项目自己的 cursor 表，不能拿真实任务 ID 扫所有会话，否则任务视图会出现假读点。
3. **V2 洞察不是已有能力**：现有 `analysis-adapter` 是 V1（最多 4 条洞察、无类型/边界/新颖性/去重/提升）；V2 需要在现有 95 创建/17 活跃洞察之上**增量加字段**，不能改写对象库；先定义兼容字段（`derived_from` 扩展或新对象字段），P0 决定。

#### 15.7.1 能否合并：能，但按“同一产品、两个组件”合并

**结论**：Focus Hub 和本项目**可以合并**，而且应该合并到用户只看见一个工作台；但不建议现在把扫描器/LLM/多源解析直接塞进 Focus Hub 的 8770 单进程。合并分三层，按证据逐层推进：

| 层次 | 做什么 | 时间 | 风险 |
|---|---|---|---|
| L1 产品层合并（推荐立刻） | 一个入口/一套对象模型：Focus Hub 是工作台与对象/任务/阶段/验收权威；本项目是它的“会话摄取/洞察提炼适配器”，只提交提议 | P0/P1 | 低；不碰 Focus Hub 核心 |
| L2 仓库/启动链路合并（P1 验证后） | 把 adapter 作为 Focus Hub 仓库内的 module/companion，同一启动脚本/同一套测试；仍可独立进程 | P1 后 | 中；需要 Focus Hub 接受新模块 |
| L3 单进程/单存储合并（暂不做） | 扫描、事件、洞察、对象都在一个进程/一个 store | 暂不 | 高；Focus Hub 单进程/单写者会被多源大库拖死，且要重做 cursor/evidence/dedupe |

**合并后的分工（必须写死）**：

- Focus Hub：对象、任务树、轨道/阶段、验收、执行门、UI；`objects.jsonl`/`project.json` 只由它写。
- 本项目：只读会话、增量 cursor、证据、洞察/建议候选、去重；通过 Focus Hub API/outbox 提交，不直接改运行数据。
- 两者共享同一对象 ID/来源指针；本项目的去重与 Focus Hub 的对象版本不互相覆盖。
- 失败隔离：摄取适配器崩溃/卡住不影响 8770/7801 的现有工作；反之 Focus Hub 重启不丢摄取游标。

**合并后的 Mode B（与 D1 对齐）**：Focus Hub 任务树是唯一正式任务权威；本项目**不再建平行任务列表**。未映射的工作先作为 `suggestion` 对象（或摄取层 `provisional_anchor`），用户采纳后才进 Focus Hub 任务树；`task_provenance=registry-only` 只存在于摄取层候选，不在 UI 上与 Focus Hub 任务并列。发现 Focus Hub 已有同名/同锚点任务时，建 alias/关系并挂证据，不复制第二份任务。

**SESSION 去重**：Focus Hub 当前有 **28 个 SESSION 对象**（`source_ref=dsh://session/...`、`source_hash`、`canonical_body_location`），**28 个都有 cursors**（50 个 cursor 事件）。适配器必须先按 `source_ref`/`source_hash` 对齐，复用已有 SESSION 与 `cursors[task_id]`/`summary.flowCursors[task_id]`，不重复建；只有新来源/新会话才建新 SESSION。`ObjectStore.createSession` 本身不做去重，外部适配器必须自己查。否则合并会立即产生“同一 DSH 会话两份对象”的脏数据。

**全 workspace 摄取**：Focus Hub 的 `/api/dsh/workspaces` 可从 `~/.dsh/storages/workspace.json` 列出 workspace 路径；`scanWorkspace` 一次只扫一个 workspace（按 `projectKey` 发现目录 + `header.cwd` 校验）。要覆盖本机 1,424 个 DSH 会话，采用“枚举 workspace → 逐 workspace 扫描”的组合，而不是改 `discoverSessionDirs` 去猜所有目录；每个 workspace 扫描要复用 `scanWorkspace` 的 cursor/partial/fork 规则。P0 先测 3–5 个 workspace 的耗时与覆盖，再决定是否并行。

**任务树/对象库是两套事实**：`project.json.tasks` 是任务唯一权威（16 任务/6 项目）；对象库只有 SESSION/ARTIFACT/RULE/PROCESS，**没有 task 对象**；`project.json.insights` 只有 3 条旧式，95 创建/17 活跃洞察在对象库。不要假设“对象即任务”或“洞察已统一”。任务建议走 `suggestions` + `/api/tasks/from-suggestion`；不要在对象库或本项目另建任务表。

**合并顺序**：P0 只做只读适配器 + Focus Hub 对象 API 验证（不写）；P1 一方向提交洞察/建议/证据，复用 SESSION；P2 把 adapter 作为 Focus Hub 仓库模块（L2）；L3 单进程等 P2 质量/隔离证明后再评估。

**为什么不是“立刻单进程合并”**：Focus Hub 当前是单进程、单写者、对象/任务为中心的本地工作台；本项目要读 1,424 个 DSH zstd、1.83GB OpenCode、Cursor 加密库，并做 LLM 提炼。把两者塞进一个进程，会让一个坏来源拖死工作台，也让 Focus Hub 的核心对象模型承担它没设计过的多源 cursor/证据/去重职责。先做 L1/L2，等 P1 证明“任务/洞察卡可信”再谈 L3。

**如果用户要“一个仓库”**：L2 即可满足——adapter 进 Focus Hub 仓库，作为 `session-ingest/` 模块，有独立进程/独立测试；不要求和 8770 同进程。**如果用户要“一个进程”**：必须先把 Focus Hub 的对象 API 改成可重入、可批量、可回滚，并接受摄取故障隔离；这是 P2 以后的事，不是 P0。

### 15.8 对前文的影响（必须一起读）

- 第 5 节的任务识别仍适用，但“任务”只是对象之一；新增的洞察/建议/里程碑按 15.2–15.4 处理。
- 第 6 节的进度改为“任务状态 + 阶段 + 里程碑状态 + 洞察采纳状态”四轴，不再只用一个任务状态。
- 第 7 节的七节卡片保留，但「洞察」节是主对象；「待办」节含任务建议；「总体计划」节含轨道/里程碑/阶段。
- 第 11 节 P1 增加“SESSION + 确定性洞察（用户明确决定/约束/风险）+ 任务建议”；P2 增加“洞察提炼/去重/新颖性”；P3 增加“提升闭环”。
- 第 13 节新增 D17（Focus Hub 集成）、D18（洞察采纳与执行门）、D19（改进/SOP 升级）、D20（权威冲突裁决）、D21（合并形态）、D22（DSH 复用）、D23（V2 元数据）、D24（全局摄取游标）。



## 十六、Focus Hub 实现核对与集成契约（v1.2 摘要）

> 详细证据见 [focus-hub-audit.md](focus-hub-audit.md)；本节只给设计必须遵守的结论。核对日期 2026-11-13，只读，未改 Focus Hub 数据。

### 16.1 当前事实

- 代码：`server/dsh-source/flow-runner/analysis-adapter/obj-store/obj-api/suggestions/association-store/status-map` 均已实现；`node --test mvp/test/*.test.mjs` **325/325**，`node mvp/tests/server-regression.mjs` **19/19**。
- 数据：216 活跃对象（186 artifacts：file 160/insight 17/summary 9/report 0；28 sessions；2 rules）；created 302 artifacts，116 retired（insight 78/summary 25/report 13）；28 SESSION 全部有 cursors；`project.json` 16 任务/6 项目/3 条旧式洞察；20 建议（9 采纳/11 驳回）；58 关联；1 acceptance；1 stage override；rev 28。
- 文档滞后：`mvp/README` 仍写“233 测试/没有真实 LLM 提炼”，但代码已有 provider 链与 `/api/flow/run`；以代码/测试/数据为准。
- **P0 实测（2026-11-13）**：1,384 个 v4 会话文件中 **191 个 ≥1MiB**；`dsh-source.firstFrameText` 只取前 1MiB，191/191 全部 `zstd-decode`，完整 buffer 可正常解。**这是复用前的 P0 阻断项**，详见审计 4.6。
- **P0 修复预览（2026-11-14）**：副本改成流式读到首行，**191/191 解出 header，953ms**；5 个 workspace `partial:false`。补丁/脚本在 `evidence/fix-preview/`，未应用到 Focus Hub。

### 16.2 已实现 vs 仅设计

| 已实现（可复用） | 仅设计/未实现（本项目新增） |
|---|---|
| 任务树/项目/阶段/验收（人工） | 多 Agent 来源（Codex/Claude/Cursor/OpenCode） |
| 对象库 4 类 + revision/correct/retire/mark/ack/link/cursor/执行门 | 全 workspace 摄取（当前一次一个 workspace） |
| 建议收件箱 + 采纳/驳回 + 建议任务建任务 | 工具/todo/job 事件摄取（当前只 user/assistant text） |
| DSH 多帧扫描（contentDigest/seq/block/torn/fork）；**但有 1MiB 首帧上限：191/1,384 长会话失败，P0 先修** | 跨源会话/任务/洞察去重 |
| flow-runner（scan→analysis→objects→cursor） | V2 洞察类型/边界/新颖性/关系/改进闭环 |
| analysis-adapter V1（summary/insight/suggest-task/artifact） | V2 评测（时间切分/硬负例/新颖性） |
| 状态映射（任务态/摘要态/本机态，冲突双显） | 多进程并发/跨设备 |

### 16.3 接入契约（只走这些）

| 目的 | 接口/模块 | 硬约束 |
|---|---|---|
| 列 workspace | `GET /api/dsh/workspaces` | 从 `~/.dsh/storages/workspace.json` 读取；不猜目录 |
| 扫 DSH | `scanWorkspace` / `GET /api/dsh/scan` | 一次一个 workspace；text-only；cursor 绑定 task/workspace/session；**>1MiB 首帧先修** |
| 跑完整流 | `POST /api/flow/run` | 必填 projectId/taskId/taskTitle/workspace；409 flow-busy；partial 不推进 |
| 建/复用 SESSION | `/api/objects/session` + `ensureSession` 逻辑 | 先按 `source_ref` 查重；不要重复 create |
| 提交洞察/摘要/建议 | `/api/suggestions`（推荐）或 `/api/objects/propose` | 外部 Agent 优先 suggestions；不直接 append 文件 |
| 采纳任务建议 | `/api/tasks/from-suggestion` | 只建 `T-*` pending；不复制第二任务树 |
| 验收/阶段 | `/api/acceptance`、`/api/attribution/stage` | 只人工；本项目不代签 |
| 任务状态 | 不调用 | 只读 `project.json`/状态映射；不改 status |
| 对象历史/执行 | `/api/objects`、`/api/objects/history`、`/api/objects/execution-input` | 只读/确认；不绕过 revision |

### 16.4 与 v1.1 的差异（已写入正文）

1. **DSH 摄取复用** `dsh-source`，不再自写；但 P0 **先修 1MiB 首帧上限**（191/1,384 长会话失败），否则复用不完整；**修复预览已 191/191 通过**，仍需应用补丁+回归。
2. **全局摄取独立 cursor**：用 `__ingest__`/companion 命名空间，不占用真实任务 ID；否则任务视图出现假读点。
3. **任务树唯一**：不建平行任务；未映射先 suggestion，采纳才进 `project.json.tasks`。
4. **V2 是新增层**：现有 analysis-adapter 是 V1；V2 元数据先增量写 `derived_from.insight`，不改 95 创建/17 活跃旧洞察。
5. **文本-only 先做**：工具/todo/job 是新增能力，不声称复用；P2 再评估。

### 16.5 仍需验证

- **P0 smoke（2026-11-13）**：前 5 个 workspace 共 305 个登记会话；`limit=20` 时 44–126ms、每个只读到 1–6 个会话；其中 `D:\nutstore\1.logseq` 命中一个 1.8MB 长会话 `zstd-decode`（即 1MiB 上限）。这不是全量覆盖 benchmark。
- **1MiB 首帧修复的回归**：修后 191 个长会话全部可读；加一个 >1MiB 首帧夹具进 `dsh-source.test.mjs`。
- **修复预览（2026-11-14）**：流式 header 副本 191/191 成功（953ms），5 个 workspace `partial:false`；logseq `limit=500` 扫描 37 sessions/500 messages/648ms/partial:false。补丁 `firstframe-1mib.patch`、脚本 `verify.mjs`；尚未应用到 Focus Hub。
- 1,384 个 v4 文件/1,424 个会话目录按 workspace 枚举扫描的覆盖/耗时；全 workspace 的 cursor 命名空间。
- `dsh-source` 当前 28 SESSION 的 `summary.flowCursors` 与 `cursors` 是否一致（本次只读字段，未跑 flow）。
- V2 元数据放 `derived_from` 的兼容性；95 创建/17 活跃旧洞察的读取/筛选。
- 多源 SESSION 的 `source_ref` 命名空间（`codex://`/`claude://`/`cursor://`/`opencode://`）与 dedupe。
- Focus Hub 8770/7801 双端数据边界；本次只核 8770 数据文件。



## 附录

- A. 实测盘点：[source-inventory.md](../evidence/source-inventory.md)（本机只读探测，含 5 来源路径/记录/规模/风险）。
- B. 6astra 设计稿：[astra-design-v0.1.md](astra-design-v0.1.md)。
- C. Opus 5 挑战：[opus5-challenge.md](opus5-challenge.md)；Kimi K3 挑战：[kimi-k3-challenge.md](kimi-k3-challenge.md)。
- D. 裁决记录：[adjudication.md](adjudication.md)；模型回执：[receipts/](receipts/)。
- E. 术语表：Goal/Task/Segment/Evidence/Fact/Anchor/Projection。
- F. 本设计自身的登记卡示例：[self-card-example.md](self-card-example.md)（七节如何落到一张真实卡上）。
- G. Focus Hub 对齐依据：`D:\src\dsh\focus-hub\docs\superpowers\specs\2026-10-25-long-conversation-insight-v2-design.md`（洞察/任务建议/里程碑/SOP 四类产物、无泄漏评测）；`docs\session-summary-2026-10-20-focus-hub-insights.md`（I01–I14 洞察登记样例）；`docs\superpowers\reports\2026-10-25-insight-challenge-adjudication.md`（双模型挑战与主控裁决）；`docs\overall_entrance.md` §7（轨道/阶段/归属规则）；`mvp\data\objects.jsonl`（对象信封样例）。这些是外部项目证据，不是本设计的实现。
- H. Focus Hub 实现核对：[focus-hub-audit.md](focus-hub-audit.md)（模块/API/数据/测试/接缝/未验证项，2026-11-13 只读）。

> 版本：v1.2（2026-11-13 Focus Hub 既有设计与实现核对后更新；D1 已由用户确认为模式 B，其余 D2–D24 待裁决）。本设计未实现、未部署；所有“已支持”表述以实测盘点与 Focus Hub 实现核对为限。
