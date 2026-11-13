# 长任务体系：最小实现路径（v1.3，经 Opus 5.5 独立复核修订）

<!-- origin: self; author: agent; created: 2026-11-04; updated: 2026-11-04; version: 1.3.0; managed-by: project -->
<!-- 复核：Opus 5.5 独立复核（subagent eacf7cb9），本版采纳其 4 处结构性更正 -->

## 0. 结论

四条硬要求（跨会话任务管理 / 人机混合编排 / 可聚焦 / 历史悬停可追溯）的承载物**都已存在**，缺的是**一个只读导出器 + 一页约定**，不是新层。
最短路径 **1–2 天**：导出四源 → spec-track 现成渲染；不新建应用、不占插件席位、不新增视图容器。

## 1. 相对 v1.2 的四处更正（复核指出，已实测确认）

| # | v1.2 的说法 | 更正后 | 证据 |
|---|---|---|---|
| 1 | "三份任务权威" | **四份**：focus-hub `project.json` 是第 4 个任务库，且规模最大 | 实测 taskboard **2 任务**／focus-hub **16 任务**、6 项目、27 会话归属 |
| 2 | 聚合"三源"，排除 focus-hub | focus-hub 必须入聚合：它是 ②④ 的唯一载体 | `project.json` `parked[]` 有 **PARK-02**（from=FH-07） |
| 3 | "冻结 focus-hub 四个视图" | **不能冻结轨道视图**——它是 ④历史悬停的唯一渲染器 | `overall_entrance.md:26`、`mvp/railway-progress.mjs:136-147` |
| 4 | "新写只读聚合层 + 视图技能" | 两半都已存在：导出器只需 ≤150 行，渲染用 spec-track | `server.py:1-19`（只读四路由）、`track_model.py`（project matrix） |

## 2. 四条硬要求的承载矩阵

| 要求 | 唯一现成载体 | 现状 | 缺什么 |
|---|---|---|---|
| ① 跨会话任务管理 | taskboard `taskSessionId`；focus-hub 会话归属 | 有字段、有 27 会话归属 | 无**会话轴**的统一视图 |
| ② 人机混合编排 | taskboard（**无 actor 门**：转移表允许 in_review→done，现网停在 in_review 是 agent 自律）、supervisor（需 stage 全过或用户释放）、focus-hub（`POST /api/acceptance`） | 机制齐全，语义三套 | 缺**一页约定**，否则"哪个视图开着以谁为准" |
| ③ 可聚焦 | spec-track `/track/<slug>` 路由 + focus-hub L1 单轨视图 | 有路由、有视图 | 缺"默认落哪条轨"的约定；**用路由解决，不新建焦点字段** |
| ④ 历史悬停可追溯 | focus-hub `parked[]` + 轨道虚线站点 | **有 1 条真实 PARK-02** | 缺 `fromSession` / `createdAt`，追不到出处 |

## 3. 最小方案（三件事）

### 动作 1：≤150 行只读导出器
输入四源：taskboard `~/.dsh/dsh-taskboard.json`、supervisor `sessionProjections`、PTC `.ptc/registry.jsonl`、focus-hub `project.json` + `objects.jsonl`。
输出：`skillhub/.scratch/unified-<source>/feature-track.json` + `feature-track.history.jsonl`（数据目录，已被 gitignore）。**模板必须自建**：`unified-lanes-template.json` 六泳道；不可套 spec-track 默认 7 阶段 SDD 模板。

字段：任务挂在 station 的 `features`（`_lift_embedded_work_items` 提升为 work_items）；保留 `raw_status`/`owner`/`acceptor`/`source`，并补 `sessionRef`（会话指针）、`needsHuman`（等人门）、`gateSince`（门禁起始，epoch ms）。
**验收**：四源各 ≥1 条真实任务同屏；PARK-02 显示为"暂挂"站且可点回 FH-07；删任一 source 副本其余仍渲染；导出不改任何源文件（`git status` 无新增）。

### 动作 2：一页约定（5 条，贴导出器 README）

```
1. 每条任务只有一个写权威（source 字段）；聚合层 0 写端点、永不写回。
2. 会话内 agent 只能推进到 in_review / awaiting-user，不得标 done 或验收。
3. 验收仅 human-confirm 一种：taskboard GUI done / supervisor 用户释放或终审 /
   focus-hub /api/acceptance，三选一；聚合记录 acceptanceSource + acceptanceAt。
4. 跨源同一任务不合并；确需关联时人工登记 alias 映射文件，聚合只读。
5. parked/暂挂必须保留 from、reason、fromSession，视图与"作废"分开展示。
```

**验收**：导出 JSON 每条含 `source/owner/acceptor`；聚合层无写端点（代码可证）；校验脚本对每条断言三字段。

### 动作 3：导出层补 parked 追溯字段
从 `objects.jsonl` 的会话事件或 attribution 推出 `fromSession` / `createdAt`，**不改 focus-hub 代码**。
**验收**：PARK-02 的 `fromSession` 非空或显式 `unknown`；暂挂站点可点回来源对象。

## 4. spec-track 复用边界（不能整段照搬）

| 维度 | 现状 | 改造 |
|---|---|---|
| 粒度 | 7 阶段模板（`track_template.json` s1–s7） | 阶段→`stations`，任务→`work_items[]` |
| 状态 | 仅 4 值 pending/active/done/skipped | 保留 `raw_status`，显示层做 7→4 有损映射（`in_review` 不可映 pending） |
| 语义 | 无 owner/claim/acceptance/parked | 附加字段承载；parked 需新增一种展示 |
| 进度 | `mapped_progress` 会算百分比（`track_model.py:1070-1089`） | **隐藏或改模板**（与"禁止合并百分比"冲突） |
| 路径 | `REPO_ROOT` 固定 skillhub；artifact 代理限库内 | DSH 制品需复制或扩白名单（改动一行，需安全复核） |
| 规模 | 16+2 任务，风险低 | PTC 695 行**事件**不得逐条成站，只导任务、按项目分 track |

## 5. 明确不做（复核建议，接受）

1. 不做统一 id 空间合并，不做 evidenceSeqs 统一寻址——四问都没有以它们为输入的消费方。
2. 不以"拉起 8770/7801 + git 提交"作前置：`.git/` 子目录当前不可写，聚合只读文件即可。
3. 不冻结 focus-hub 轨道视图，不新建视图容器或插件席位。
4. 不做 DSH/Codex 双侧一致视图验收（未经验证，过度承诺）。
5. 不在聚合层做任何写操作或验收动作。

## 6. 待确认（1 项）

导出器落点：独立脚本（`tools/unify/export.py`，零依赖）还是并进 spec-track 的 `track_render.py` 子命令。
建议前者：不碰 skillhub 主干，可随时废弃。

## 7. 证据索引

- 复核结论：Opus 5.5 独立复核（本会话 subagent `eacf7cb9`，2026-11-04）
- 实测：taskboard 2 任务 / rev 15；focus-hub 16 任务 / rev 28 / parked 1（PARK-02 from FH-07）/ 6 项目；track 模板 7 阶段
- 代码：`tools/track/track_render.py:1-24`、`server.py:1-19`、`track_model.py:14-19/284-346/1070-1089`、`track_template.json`
- 依据：`overall_entrance.md:26/40-44`、`progress-control.md:21/32/36/48`

## 8. 实施记录（2026-11-04，已落地）

**已建**
- `tools/unify/export.py`（138 行，stdlib 零依赖）：读 taskboard / focus-hub（+ 可选 PTC），产出 6 泳道轨道 + 嵌入式 features。
- `tools/unify/README.md`：用法、五条约定、源映射表、已知边界。

**已验**
- 导出：taskboard **2** 条（`needsHuman=true` 1 条、`gateSince` 非空）/ focus-hub **17** 条（16 任务 + PARK-02，`from=FH-07`）。
- 任务级视图：`track_render.py show unified-focus-hub --model project --template <lane 模板>` → 17 个 WorkItems 全部列出。
- 只读性：导出前后三个仓库 `git status` 变更数不变（dsh 14 / focus-hub 12 / skillhub 8，均为既有改动）。

**已知缺口（须下一轮处理，不在本轮伪称完成）**
1. `track_render.py html` 是 **stage 级**渲染器，会丢掉 station 的 `features`（页面只有 6 个泳道，没有任务名）。要在网页看到任务，需给 `track_html.py` 加一节渲染 features。
2. supervisor **未接入**：状态只存在于 DSH 运行时的 `sessionProjections`，文件层读不到；需走 `/api/task-supervisor?sessionId=…`。
3. `fromSession` 多为空：`objects.jsonl` 无 PARK-02 的会话关联事件，`unknown` 是正常结果，不作为验收失败。
4. 单页图 `candidate.archify.md` 仍是 v1.2 口径（三阶段 / 三四五六计数），**对外分享前必须重渲染**。
