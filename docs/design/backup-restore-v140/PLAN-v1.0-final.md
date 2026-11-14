# 一键备份与恢复能力 v1.4.1 —— 收口与收尾方案（定稿 v1.0）

> 2026-11-14 · 工作区 `D:\src\dsh` · 基线 DSH `0.2.1-rc.5` / config-pack `v0.11.7`
> 来源：主控草案 `PLAN-v0.md` → **ais-2dsglm / glm-5.3-flash 对抗评审**（六段式，5 条致命缺陷）→ 主控逐条核验裁决 → 本定稿。
> 裁决原则：挑战者给证据的照做；证据与实测冲突的以实测为准；会放大无人值守风险的替代方案不做。

## 1. 裁决表

| # | 挑战意见 | 裁决 | 依据 / 已落地动作 |
|---|---|---|---|
| F1 | 子仓 push 失败仍推 root → 远端子模块指针断链 | **采纳** | 实测 `dsh-commit-backup.ps1:611-626` 推送循环无依赖门禁。已改 v1.4.1：子仓任一 push 失败即跳过 root push 并计 failure |
| F2 | sibling 推到 fork 必 non-FF（本地无 `c0b7df4` 对象） | **采纳** | 实测：sibling main=`8c32a9d`（=上游 tip）、fork main=`c0b7df4`、`cat-file -e c0b7df4` exit=128。本轮 sibling **不纳入**推送 |
| F3 | run-closing 没有方案自己写的审查闸门 | **采纳** | 已重写为四道门（备份门禁 / 提交白名单 / 推送闸门 / 回执复核），不传 `-IncludeUntracked` |
| F4 | 备份失败不阻断、退出码仍 0 | **部分采纳** | 采纳"必须 abort"，但**不收 partial**：默认不加 `-Rehearse` 时 partial 是常态，收它会让人人失败。v1.4.1：`failed/missing/unverified` → exit 3，partial 保留告警 |
| F5 | P2 只分类不执行；`-IncludeUntracked` 会扫进垃圾 | **采纳** | 已加 `.gitignore`：`a-prime-demo.txt`、`*.tgz`、`*.tar.gz`；`JunkPatterns` 补 `*.tgz/*.tar.gz/*.zip/*.7z/*.exe/*.nupkg`；runner 改为白名单式（不传 `-IncludeUntracked`） |
| 前提 1 | "备份先于提交"只有顺序没有门禁 | **采纳** | 同 F4，已加门禁 |
| 前提 2 | 沙箱内可用 `-BackupDest` 产出 bundle | **采纳并立即执行** | 实测：`dsh-backup.ps1 backup -AllProfiles -Dest D:\src\dsh\.ptc\backups` 需补 `-AllowPrivateToDest` 才能写工作区外路径；本机用它产出了当天恢复点 |
| 前提 3 | "9 个 profile"是硬编码数 | **采纳（挑战者正确）** | 实测本轮 bundle 为 **10 个**：acp、dsh-tui、focushub-dev、headless、packed、plugtest、sa-local、superagent、web、web-restore（`node_modules` 不计）。
口径 = `~/.dsh/profiles` 下带 `package.json` 的目录；**名单以 `bundle.json` 的 `profiles[]` 为准，不写死数字**（11-09 那份是 9 个，本轮多了 `dsh-tui`） |
| 前提 4 | sibling 纳入不等于 root gitlink 会 bump | **采纳** | v1.4.0 修的是盘点可见性；root 的 gitlink `160000 c0b7df4` 只在 root 提交时由 `git add` 记录，与 sibling 推送无因果 |
| 前提 5 | "展示 diff 给人看"与无人在场互斥 | **采纳** | 处置结论改为**先落进脚本**，不依赖运行时的临时确认 |
| 前提 6 | `dsh-restore.ps1 -List` 只扫默认备份根 | **采纳** | 用 `-BackupDest` 产出的 bundle 必须显式 `-Snapshot` 指定；验收改为两步 |
| 替代 P0 | 两段式 + schtasks | **部分驳回** | 采纳两段式（沙箱内产 bundle）+ 人工在普通 PowerShell 跑收口；**不做 schtasks/常驻自动化**：那会把自动提交变成周期性行为，正是 F3 的风险源 |
| 替代 P1 | 本轮不纳入 sibling，改独立任务 | **采纳** | 见 §3 P1 |
| 替代 P3③ | watchdog 阈值应 ≤5 天 | **驳回（挑战者被我的 v0 误导）** | 实测 `dsh-git-watchdog.ps1` 已内建"最近实质变化晚于 bundle.created_at（零容差）"+ 读 `commit-backup-*` 回执，本轮实跑已输出 `backupStale`（"dsh 一键备份需要更新"）。**v0 里"7 天阈值"是我写错，删除该条**，不需要改阈值 |
| 替代 P3⑤ | 验收用 `git ls-remote` 比对本地 HEAD | **采纳** | 写进 §4 验收清单（沙箱内可执行，不依赖出沙箱窗口） |
| 验收 #1 | "9 仓全 clean 全 0" 验不出问题 | **采纳** | 改"8 仓全 0 + sibling 已知例外登记"；未跟踪件不再算"已排除=通过" |
| 验收 #3 | `status -sb` 无 ahead 时恒空过 | **采纳** | 改 `git rev-list --count @{u}..HEAD` 精确取数 + `ls-remote` 对远端 |
| 验收 #2 | `-List`/profile 数会假阴假阳 | **采纳** | 改：显式 `-Snapshot` 校验 `created_at` + profile 名单逐个比对 + 跑一次 `restore` DryRun 看计划渲染 |
| 验收 #5 | §8 三门槛口号式 | **采纳** | 改为 3 条可执行检查（见 §4.4） |
| 删项 | `dsh-superagent-0.1.0.tgz` 已不存在 | **驳回** | 实测仍存在（`Test-Path` True）。结论不变：靠 `JunkPatterns` + `.gitignore` 排除，不靠人记 |

## 2. 定稿后的方案（P0-P4）

### P0 恢复点（沙箱内即可，已完成一次）

```powershell
pwsh -NoProfile -File D:\src\dsh\dsh-config-pack\scripts\dsh-backup.ps1 `
  backup -AllProfiles -Dest D:\src\dsh\.ptc\backups -AllowPrivateToDest
```

产物落在 `.ptc\backups\dsh-backup-*`（`.ptc/` 已 gitignore，不进仓库）。恢复时必须显式 `-Snapshot` 指向它。

### P0' 收口（沙箱外一次性，必须人工在场）

```powershell
pwsh -NoProfile -File D:\src\dsh\.ptc\run-closing-backup.ps1
```

四道门全部在脚本内：备份未通过校验直接 exit 3；只提交已跟踪改动；子仓 push 全成才推 root；跑完读回执复核。
**不再传 `-IncludeUntracked`**（要入库的未跟踪件由人显式 `git add` 后再跑）。

### P1 sibling 远端对齐（独立任务，不在本轮）

1. `git -C D:\src\dsh-superagent fetch https://github.com/Robert-Wang-08/dsh-superagent-prototype.git main`
2. `git -C D:\src\dsh-superagent merge FETCH_HEAD` —— 把 `c0b7df4` 的 reply-fix 线并进 `8c32a9d` 线；冲突人工决策；**禁 force**
3. 合并完成后再 `origin`→`upstream`、`origin`=fork、确认 `branch.main` 上游指向 fork
4. 之前，sibling 一律不进收口推送路径

### P2 未跟踪件（P0' 之前落定）

| 文件 | 处置 |
|---|---|
| `a-prime-demo.txt`（22B "hello from local fork"） | 已进 `.gitignore` |
| `*.tgz` 等二进制 | 已进 `.gitignore` + `JunkPatterns` |
| `docs/ops/feishu-channel-outage-20261113.md` | 该入库；跑 P0' 前手工 `git add` |
| `docs/design/session-aggregation/evidence/fix-preview/`（3 文件） | 该入库；同上 |
| `dsh-wechat-hitl` 三个脚本（`tools/feishu-reply-health.mjs` 是运行工具、两个 `test-*.ps1` 是回归件） | 疑似该入库；需人确认后再 `git add` |

### P3 防复发（本轮已做 / 保留）

1. **已做**：收口门禁（F1/F4）沉淀进脚本，任何调用路径都受约束。
2. **已做**：`-Status`/`-DryRun` 仍可只读盘点，用于事前评审。
3. **已做**：watchdog 的 `backupStale` 已在岗（零容差 + 回执），不做阈值改造。
4. **保留未做**：`-Status` 增加"兄弟检出：已纳入/未纳入"提示行 —— 本轮 `-IncludeSiblingRepos` 明确不用于推送，提示行留到 P1 完成后再加。

### P4 跨设备口径（AGENTS.md §8 三门槛）

- 代码：`dsh-commit-backup.ps1` v1.4.1 随根仓库 Git 走。
- 配置：本方案**不改任何 profile 配置**，无需共享盘动作。
- 安装性：无新增依赖/插件；恢复路径仍是 `dsh-restore.ps1` + 装机引导。

## 3. 验收清单（可执行）

1. **8 仓对齐**：逐仓 `git rev-list --count @{u}..HEAD` = 0 且 `git rev-list --count HEAD..@{u}` = 0。
2. **远端一致**：逐仓 `git ls-remote origin <branch>` 的 SHA == 本地 `git rev-parse HEAD`（沙箱内可跑）。
3. **恢复点**：`bundle.json` 的 `created_at` 晚于本次改动，且 `profiles[]` 名单与 `~/.dsh/profiles` 下带 `package.json` 的目录**逐个比对一致**（实测 10 个；不数个数、不写死）。
4. **恢复可用性**：对新 bundle 跑一次 `dsh-restore.ps1 -Snapshot <dir>`（DryRun，只出计划），确认计划渲染出 9 个 profile 且 `link:` 体检有输出。
5. **§8 三门槛可执行化**：①`git -C D:\src\dsh status -sb` 无 ahead；②`git diff --stat` 里不含 `~/.dsh` 路径；③`pwsh -File dsh-restore.ps1 -List` 能看到新 bundle。
6. **脚本自检**：`dsh-commit-backup.ps1 -Status` exit 0，且 `Parser::ParseFile` 无错误。

## 4. 残余风险与已知例外

| 项 | 状态 |
|---|---|
| `D:\src\dsh-superagent` 6 改 1 未跟踪 | **已知例外**，P1 完成后才纳入；watchdog 会报 dirty |
| `focus-hub` 领先 77 未推 | 已知例外（`-IncludeFocusHub` 才纳入） |
| bundle 是 partial | 未做隔离安装演练；跨机写回必须 `-AllowPartial` 并补跑 `pnpm install`/`verify-install` |
| 沙箱外执行窗口 | 只能人工触发；本轮不自动化（评审一致口径） |
| 收口会把 `dsh-wechat-hitl` 2 个在飞改动一并提交 | 已登记；否决就 `-Only` 排除 wechat-hitl 后重跑 |
