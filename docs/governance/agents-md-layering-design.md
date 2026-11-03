# AGENTS.md 分层方案（设计稿 v1）

<!-- origin: self; author: agent; created: 2026-10-31; updated: 2026-10-31; version: 1.0.0; managed-by: project; asset-type: design-doc -->

> 状态：**设计，未实施**。实施前需按 §10 逐步执行并逐条验收。

## 0. 一句话

一份内核（Kernel）+ 每工具一层薄壳（Shim）+ 一张路由表 + 按需文档；渲染交给 SkillHub，**不做文件级链接**。

## 1. 目标与非目标

目标：
- 任何工具读到"自己该读的那一份"，没有无关内容（消除 Memorix 进 DSH、`npx openskills` 进 DSH 这类串味）。
- 通用规则只有一处可写（唯一事实源），改一次、四处同步，且**不会静默分裂**。
- 单文件远低于 DSH 的 64KB 上限（`agent-instructions.maxBytes = 65536`），不触发截断。
- 换设备可一键复现（不靠手动重建链接）。

非目标：
- 不追求"四个工具读同一个物理文件"（理由见 §9 不做的事）。
- 不重构 SkillHub 的 IDE source 发现逻辑（除非后续确实需要，见 §4 路径 B）。
- 不改 `focus-hub/AGENTS.md`（已符合分层，无冗余）。

## 2. 事实基础（已核实，非推测）

| 事实 | 证据 |
|---|---|
| DSH 只读两类指令：工作区祖先链的 `AGENTS.md`/`CLAUDE.md`（含 `.local` 覆盖）+ 唯一用户级文件 `$DSH_HOME/AGENTS.md` | `dsh-agent-instructions/lib/index.js` L17/L18/L141/L148/L578 |
| DSH 全树对 `.agents` 的引用为 0（指令侧）；`.agents` 只作**技能根** | 同包 grep；`dsh-skill-filesystem/lib/index.js` L78/L160/L177 |
| `~/.dsh/AGENTS.md` **当前不存在** → DSH 目前没有任何用户级全局指令 | 文件探测 |
| 指令体量硬上限 64KB | profile `cordis.patch.yml` L598-601 |
| SkillHub 已有"按 target 组合 section"的模型 | `store/agent_instructions/targets/codex.repo.yaml`（`sections:` 列表 + `renderer: codex_agents_md`） |
| SkillHub 的 AGENTS.md 分发只遍历已启用 IDE source（`ide_root/AGENTS.md`） | `core/agents_md.py` L70-L72/L284-L288 |
| 技能目录由 `agents_md.py` 生成并可原地回填 | `core/agents_md.py` L162-L225 |

## 3. 三层结构

| 层 | 内容 | 载体 | 谁读 |
|---|---|---|---|
| **L0 内核** | 长任务机制（含"每轮反馈必报进度"）、检索边界、工具路由表 | SkillHub fragment `global-rules.md`（唯一事实源） | 全部工具（经渲染） |
| **L1 薄壳** | 各工具 AGENTS.md = 内核渲染块 + 该工具专属小节 | 4 个路径（见 §4） | 对应工具 |
| **L2 按需** | 项目治理、运行手册、工具长指南、技能完整目录 | `~/.agents/skills-catalog.md`、`~/.codex/memorix-guide.md`、仓库 `docs/governance`、`docs/runbooks` | 触发时才读 |

铁律三条：
1. 内核条文**只写 fragment**，任何工具文件里的内核段都是渲染产物。
2. 工具专属内容**只写在薄壳或 L2**，不进 fragment。
3. L2 必须有 pointer 才存在（没指针的文档等于没有）。

## 4. 文件清单与预算

| 文件 | 目标行数 | 体量硬门槛 | 现状 | 生成方式 |
|---|---|---|---|---|
| `store/agent_instructions/fragments/global-rules.md` | ≤60 | — | 44 行 | 人改（SkillHub 渲染） |
| `~/.dsh/AGENTS.md` | ≤40 | ≤6KB | **不存在** | 首版手工 + 一致性校验（路径 B）；后续可迁路径 A |
| `~/.agents/AGENTS.md` | ≤120 | ≤16KB | 1592 行 | SkillHub 生成（技能目录移出） |
| `~/.codex/AGENTS.md` | ≤80 | ≤16KB | 141 行 | SkillHub 生成 + 手工小节 |
| `~/.cursor/AGENTS.md` | ≤25 | ≤6KB | 13 行 | SkillHub 生成 |

**路径 A（首选，其他三份用）**：在 `store/agent_instructions/targets/` 新增 `agents.global.yaml`/`cursor.global.yaml`，每个 target 用 `sections:` 组合 `global-rules` + `tool-adapter.<tool>`；工具专属小节做成 section 文件，而不是写进渲染产物。

**路径 B（DSH 首版用）**：`~/.dsh` 不在 SkillHub 的 IDE source 登记中，走路径 A 需要改 `agents_md.py` 的 target 发现逻辑（L284-L288 只遍历 enabled IDE source），风险大于收益。首版手工建壳，文件头写 `<!-- source: skillhub/global-rules#内核 vX.Y.Z -->`，并配一条校验：内核段 md5 与 fragment 渲染结果比对，不一致即报错。

## 5. 内核内容（唯一事实源，≤40 行）

1. `<!-- BEGIN SKILLHUB:long-task-control -->` 块全文（现有 10 条，含第 10 条"每轮反馈必报进度"）
2. `<!-- BEGIN SKILLHUB:search-boundary -->` 块（从 `.agents` L22-L24 迁入）：OneDrive 云同步目录禁止 rg/Glob/Grep 扫描，需显式排除
3. 工具路由表（新增，常驻，8 行以内）：

```
读取方路由：DSH 只读 ~/.dsh/AGENTS.md；Codex 只读 ~/.codex/AGENTS.md；
Cursor 只读 ~/.cursor/AGENTS.md；遵循 .agents 约定的工具读 ~/.agents/AGENTS.md。
技能：所有工具的技能本体统一在 ~/.agents/skills/<id>/SKILL.md。
```

## 6. 各薄壳骨架

`~/.dsh/AGENTS.md`（新建，≤40 行）
```
# AGENTS（DSH 用户级）
<!-- 内核渲染块：long-task-control 10 条 + 检索边界 + 路由表 -->
## DSH 专属
- 技能调用用 skill 工具；不执行 npx openskills。
- 插件/配置变更先备份（dsh-backup-restore）；跨设备要求见 workspace AGENTS.md §8。
```

`~/.codex/AGENTS.md`（≤80 行）
```
# Global Codex Instructions
<!-- 内核渲染块 -->
## DSH 进程保护（保留）
## 推理升档建议（AGENT-CONFIG-SYNC 托管块，保留）
## 检索边界（并入内核后删除本地副本）
## Memorix（10 行速查 + pointer → memorix-guide.md）
```

`~/.agents/AGENTS.md`（≤120 行）
```
# AGENTS
<!-- 内核渲染块 -->
## Skill 索引（按场景 5-12 行分类触发词）
完整目录见 skills-catalog.md（128 条，按需读）；本机 DSH 会话用 skill 工具，其余工具参见该文件 <usage>。
```

`~/.cursor/AGENTS.md`（≤25 行）
```
# AGENTS
<!-- 内核渲染块（若 Cursor 不支持托管块渲染则手抄并标注 source） -->
## Cursor 侧说明：全局指令见 ~/.agents/AGENTS.md
<!-- asset-layout 托管块保留 -->
```

## 7. 内容归位表

| 现有内容 | 位置 | 归属 | 动作 |
|---|---|---|---|
| 128 条 `<skill>` 目录（L43-L1571，1526 行） | .agents | L2 | 下沉 `~/.agents/skills-catalog.md`；主文件留 pointer；改 `agents_md.py` 输出目标 |
| `<usage>`（`npx openskills read`） | .agents L1573-L1578 | L2 | 随目录下沉，主文件声明"DSH 用 skill 工具" |
| `<globals>` OneDrive 禁令 | .agents L22-L24 | L0 | 迁入内核"检索边界"块 |
| 会话类 Skill 速查表 | .agents L27-L37 | L1 | 与技能索引合并为分类触发词 |
| Memorix 指南（63 行） | .codex L68-L130 | L2 | 下沉 `~/.codex/memorix-guide.md`，壳留 10 行 |
| DSH 进程保护 / 推理升档 | .codex L23-L57 | L1 | 保留 |
| asset-layout 块 | 三处各一份 | L0/L1 | 保留（git-friendly）；收敛为单一 target 后仍在用 |
| §7 skill 资产治理历史 | dsh L67-L75 | L2 | 下沉 `docs/governance/skill-asset-layout.md` |
| §8 判定口径与实例 | dsh L88-L95 | L2 | 下沉 `docs/governance/cross-device-update-rule.md` |
| §2 登记状态核查指令 | dsh L29 | L1 | 移入 §4 变更约束 |
| focus-hub 全部 | focus-hub | L1 | 不动 |

## 8. 变更流程（防覆盖）

1. 改通用规则 → 改 fragment → `skillhub agents_md preview` → `generate` → 4 份文件自动更新。
2. 改工具专属 → 改该 target 的 `tool-adapter.*` section → 重新渲染。
3. 改 DSH 薄壳（路径 B 期间）→ 手改后跑一致性校验；fragment 变更时同步。
4. **任何情况下不手改托管块内部**（`BEGIN/END SKILLHUB` 之间）。

## 9. 风险与不做的事

不做：文件级符号链接/硬链接共用一份（原因：生成器重写会打断、工具专属内容串味、64KB 截断、跨设备需手工重建）。

风险与对策：

| 风险 | 对策 |
|---|---|
| `agents_md generate` 覆盖手工改动 | 只改 fragment/section/生成器；渲染区永不手改 |
| `~/.dsh/AGENTS.md` 与内核漂移 | 一致性校验命令纳入验收；版本号写进文件头 |
| 技能目录下沉后找不到技能 | 验收项：`skill` 工具仍能列出全部技能；pointer 指向绝对路径 |
| 体量增长再次失控 | 单文件体量硬门槛（≤16KB）+ 每次渲染后检查 |

## 10. 迁移步骤

1. **备份**：四份文件各留 `.bak-before-layering-20261031`。
2. **建 DSH 薄壳**（P0）：写 `~/.dsh/AGENTS.md`；新开会话验证系统提示出现 `Instructions from: ~/.dsh/AGENTS.md`。
3. **内核抽取**（P1）：`<globals>` → fragment 的 search-boundary 块；路由表进 fragment；重渲染。
4. **技能目录下沉**（P2）：改 `agents_md.py` 输出 → 生成 `skills-catalog.md` → 主文件留 pointer → 验证 skill 工具正常。
5. **Codex Memorix 下沉**（P3）：生成 `memorix-guide.md`，壳留 10 行速查。
6. **项目层下沉**（P4）：dsh §7/§8 → `docs/governance/`，§2 核查指令并入 §4。

## 11. 验收标准（可测）

1. `~/.dsh/AGENTS.md` 存在且 ≤40 行；新会话系统提示出现该路径。
2. 四份文件各有内核段，行号落在托管块内；非托管区搜"长任务默认机制"应只在 fragment 命中。
3. 四份文件同步内文两两比较：托管块外交集为空（无手抄副本）。
4. 每份文件 ≤16KB；DSH 那份 ≤6KB。
5. `skill` 工具列出的技能数与 `skills-catalog.md` 条数一致（能力未丢）。
6. 设备 B：`git pull` + `agents_md generate` 后四份文件 hash 与设备 A 一致（路径 B 的 DSH 文件另需一步拷贝/生成）。

## 12. 跨设备（对应 workspace AGENTS.md §8）

| 门槛 | 本方案如何满足 |
|---|---|
| 代码类 Git 更新即生效 | fragment/section/target 与生成器改动进 SkillHub 仓库并推送 |
| 配置类共享盘/本机不硬编码 | 内核不含设备绝对路径；技能目录 pointer 用 `~` 相对或 SkillHub 解析 |
| 安装性变更留一键路径 | 生成命令写进 README/PROMPT：`skillhub agents_md generate` + 校验命令 |
