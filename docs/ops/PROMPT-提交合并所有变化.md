# Prompt：提交并合并 DSH 工作区所有变化

> 用途：把下面「复制区」整段交给另一个 agent（同机，或另一台已克隆 `D:\src\dsh` 的机器）。
> 源设备当前状态（2026-11-10 22:20）：根仓库 `main` 领先 `origin/main` 4 个提交（含本地收口与上游合并），`dsh-config-pack` 领先 2 个；`dsh-provider-failover`（4 文件）、`dsh-wechat-hitl`（6 改 + 6 未跟踪）仍未提交；根目录有 533 项未跟踪产物；`engine-preflight` 为 `drift`（`register-scan-task.ps1` 与 skill 版不同）。
> 使用前按实际授权修改第 7 步「推送」。

## 复制区

你在 Windows 上维护 DSH 工作区 `D:\src\dsh`（根仓库 `dsh-ynm3000` + 子模块）。任务：**安全地提交所有本地改动，并把 `origin/main` 合并进来**，最后给出可验收报告；未经用户明确同意不要 push。

0. **先读**：`AGENTS.md`、`docs/ops/一键提交与备份.md`、SkillHub 片段 `git-work-repo-isolation`（本机 `D:\src\ynm3000\skillhub\store\agent_instructions\fragments\git-work-repo-isolation.md`；其他设备按实际 SkillHub 根替换）。
1. **安全备份**：在 `%USERPROFILE%\.dsh\backups\premerge-<时间戳>\` 下，对根仓库与 `dsh-config-pack` 各做 `git bundle create <文件> --all`、`git stash create` + `git update-ref refs/backup/premerge-<时间戳>`，并保存 `git status -uall` 与 `git diff` 输出。已有 `premerge-20261110` 备份可复用核对。
2. **引擎预检**：`pwsh -NoProfile -File "$env:USERPROFILE\.agents\skills\local-git-sync\scripts\engine-preflight.ps1"`。`conflict` → 停止；`drift` → 先对比差异：若只是 `register-scan-task.ps1` 的 `LOCALAPPDATA` / `USERPROFILE` 兜底（skill 版更新），备份后 `bootstrap.ps1 -AcceptDrift` 采用 skill 版再继续；其他差异停下报告。
3. **盘点**：`pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Status`。逐仓库确认改动；只暂存显式路径，不执行 `git add .` / `git add -A`。排除：凭据（`.credentials.yaml`、`.env`、`*.key`、`*.pem`）、`.ptc/`、`.tmp-*`、`downloads/`、`.archify/`、`.dsh-progress/`、`*.bak-*`、`.wip-backup-*`、浏览器 profile 缓存。
4. **提交**：根仓库与每个有改动的子仓库分别提交。`dsh-provider-failover`、`dsh-wechat-hitl` 的未提交改动纳入；未跟踪的产品文档/脚本/测试逐个人工确认后纳入（不要整目录盲加）；`.wip-backup-*`、`.archify/`、`.dsh-progress/`、`downloads/` 不纳入。提交信息写清主题；禁止 force push、禁止改写已推送历史。
5. **合并**：先子仓库、后根仓库。`git fetch origin` 后 `git merge origin/main`。冲突处理原则：`dsh-config-pack` 的 USERPROFILE/node 兜底修复（`$UserHome` 回退、`$NodeExe`、始终 `--dsh-home $DshRoot`）必须保留；上游新功能（`-RehearseOnline`、provider 迁移等）按上游；其余文件取上游。合并完成后更新根仓库的子模块指针并提交。
6. **验证**：`dsh-commit-backup.ps1 -Status` 各仓库 clean（未跟踪产物除外）；`dsh-restore.ps1 -List` 正常；对 `dsh-commit-backup.ps1`、`dsh-restore.ps1`、`scripts/config-snapshot.ps1` 与 `dsh-config-pack` 的 5 个备份脚本做 PowerShell Parser 检查（0 错误）；README 与文档链接无断链。
7. **推送（仅当用户明确要求）**：根仓库、每个有提交的子仓库、`dsh-config-pack` 分别 `git push`；推送后核对 `origin/main` 与本地一致，并在报告里给出每个仓库的 commit 哈希。未获授权就保持「本地已提交未推送」。
8. **报告**：逐仓库列出提交哈希、文件数、合并/冲突处理、验证命令与结果、未处理项与风险。不要声称已推送，除非真的推送成功。

## 使用提示

- 只想本地提交合并：保留第 7 步的「不推送」。
- 在另一台设备执行：先 `git clone --recurse-submodules https://github.com/Robert-Wang-08/dsh-ynm3000.git <路径>`，把提示里的 `D:\src\dsh` 换成实际路径。
- 现有安全备份：`%USERPROFILE%\.dsh\backups\premerge-20261110\`（root/config-pack bundle、tracked patch、status 清单、`refs/backup/premerge-20261110`）。
