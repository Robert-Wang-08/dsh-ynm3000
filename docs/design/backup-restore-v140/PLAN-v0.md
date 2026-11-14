# 一键备份与恢复能力 v1.4.0 —— 收口与收尾方案（v0 草案）

> 时间：2026-11-14 · 工作区 `D:\src\dsh` · 基线 DSH `0.2.1-rc.5` / config-pack `v0.11.7`
> 本文是方案草案（v0），待 glm-5.3-flash 挑战后出定稿 v1.0。

## 1. 目标

1. 把 2026-11-09 之后缺失的恢复点补上：产出一次 **全 profile bundle**（9 个 profile）。
2. 把已集成的改动落到远端：根仓库、7 个子仓库全部 `ahead=0`、`behind=0`。
3. 让"覆盖缺口"不再复发：子模块工作树为空时该仓库不会被静默漏掉。

非目标：不改 profile 配置、不动 work 组仓库、不引入新的第三方插件。

## 2. 现状基线（本轮实测）

| 项 | 数值 | 证据 |
|---|---|---|
| 根仓库分叉 | 0 落后 / 8 领先（含 merge commit `79ab78a`） | `rev-list --left-right --count origin/main...HEAD` |
| config-pack | 0 / 4（merge `02d91c3`） | 同上 |
| wechat-hitl | 0 / 2，工作区 5 条脏项 | `git status` |
| 最近 bundle | `dsh-backup-20261109-014401`（5 天前） | `dsh-restore.ps1 -List` |
| 一键范围 | 8 仓（漏 `D:\src\dsh-superagent`） | `-Status` 改前实测 |
| v1.4.0 后范围 | 9 仓 | `-Status -IncludeSiblingRepos` |
| 沙箱 | `workspace-write` 禁写 `.git` 与 `%USERPROFILE%\.dsh` | `insufficient permission ... .git/objects` |

## 3. 执行步骤

### P0 收口（必须在沙箱外执行一次）

```powershell
pwsh -NoProfile -File D:\src\dsh\.ptc\run-closing-backup.ps1
```

顺序由脚本保证：子仓库提交 → 根仓库最后 → 备份 bundle 先于提交 → 可选 `-Push`。
判据：退出码 0 **且** `.ptc\reports\commit-backup-<UTC>.json` 的 `backup.status=ok`（`bundle.json` 可读、`failed=0`）。

### P1 兄弟检出远端对齐（否则纳入即 FAIL-PUSH）

`D:\src\dsh-superagent` 的 `origin` 仍指只读上游 `deepseek-ai/dsh-superagent-prototype`。
处理：`origin` → `upstream`，新增 `origin` = 维护 fork `Robert-Wang-08/dsh-superagent-prototype`，
与 `.gitmodules` 已采用的 URL 保持一致；之后该仓才允许加进 `-IncludeSiblingRepos` 的推送路径。

### P2 未跟踪文档归类（按 §10 口径）

- 该入库：`docs/ops/feishu-channel-outage-20261113.md`、`docs/design/session-aggregation/evidence/fix-preview/`（3 文件）
- 该丢弃或忽略：`a-prime-demo.txt`、`dsh-superagent-0.1.0.tgz`
- wechat-hitl 的 3 个测试脚本：确认是有意保留的回归件再入库

### P3 防复发

1. `dsh-git-watchdog.ps1` 增加一条检查：最近 bundle 超过 7 天 → 告警（当前它只查仓库分叉/落后）。
2. `-Status` 输出加一行「兄弟检出：已纳入 / 未纳入」，避免默认静默。

## 4. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 收口把 wechat-hitl 2 个在飞的已跟踪改动一起提交 | 用户未审先提交 | 提交前先 `git diff` 展示；用户否决就 `-Only` 排除 |
| 兄弟检出远端未对齐就纳入 | `FAIL-PUSH`，脚本不阻断根仓库推送 | P1 先做，或本次收口不加 `-IncludeSiblingRepos` |
| bundle 是 partial（未 `-Rehearse`） | 跨机恢复需 `-AllowPartial`，未演练装依赖 | 文档已写明；需要强恢复点时可加 `-RehearseOnline` |
| 沙箱外执行无人值守 | 推送后无法回滚远端 | 不做 force push；失败即停在本地提交 |

## 5. 验收口径

1. `-Status` 9 仓全 clean、`领先/落后` 全 0。
2. `dsh-restore.ps1 -List` 出现 2026-11-14 的新 bundle，`bundle.json` 9 个 profile 全 `ok`。
3. `git -C <each> status -sb` 无 `ahead`。
4. `README.md` / `一键提交与备份.md` / `简要说明` 三处版本号与实测一致（v1.4.0）。
5. AGENTS.md §8 三门槛：代码走 Git 可取、配置走共享盘、安装性变更有一键路径或文档。

## 6. 待挑战的问题

1. P0 用「沙箱外手动跑一次」是否可接受？有没有办法让 DSH 会话内可复现（例如把收口做成计划任务/服务）？
2. `-IncludeSiblingRepos` 默认探固定兄弟目录，是否该改为配置驱动（`~/.dsh/device/`）？
3. P1 改 `origin` 是否会影响子模块克隆语义（`.gitmodules` 已是 fork，但本地 worktree 在别处）？
4. P2 用 `-IncludeUntracked` 一次性入库，还是逐条 `git add` 更稳？
5. P3 的新鲜度告警阈值 7 天是否合理？
