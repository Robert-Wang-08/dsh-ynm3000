# 新设备：任务目录（task-registry）一键接入

> 给 AI 代理的可粘贴说明。目标：在第二台设备上只读/生产自己的会话总结，不抢全局写权。

## 0. 前提

- 坚果云已把 `1.logseq` 同步到本机；能看到 `近期任务表/近期任务表.md`。
- Node 22+（DSH 已依赖）、PowerShell 7、`gh` 可选。
- 不要复制另一台设备的 `%LOCALAPPDATA%\task-registry\config.json`（设备身份必须本机生成）。

## 1. 拉代码

```powershell
git clone https://github.com/Robert-Wang-08/dsh-ynm3000.git <repo>
# 或已有仓库：git -C <repo> pull --ff-only
```

## 2. 校验任务表

```powershell
node <repo>\tools\task-registry\cli.mjs doctor --vault <vault> --strict
```

通过：0 error / 0 warning。失败先别安装，保留原文件并报告错误。

## 3. 安装（本机配置 + 计划任务）

```powershell
pwsh -File <repo>\scripts\task-registry\install.ps1 -Vault <vault> -WhatIf
pwsh -File <repo>\scripts\task-registry\install.ps1 -Vault <vault>
Get-ScheduledTask -TaskName TaskRegistry-Sync
```

- 只有**一台**设备作为 publisher 注册扫描任务；其他设备用 `-Role producer`（只给自己的新总结打标，不写 `tasks.json`）。
- 重复安装不会新增第二个任务；`-Uninstall` 只停任务、留数据。

## 4. 给新总结打标

session-summary 的收尾桥接默认 DryRun：

```powershell
pwsh -File <repo>\scripts\task-registry\deploy-summary-bridge.ps1 -WhatIf
pwsh -File <repo>\scripts\task-registry\deploy-summary-bridge.ps1 -Apply
```

桥接只在 `SKILL.md` 末尾加一段带标记的说明；已有 `.bak-before-taskbridge-*`，`-Uninstall` 可撤。

## 5. 验收

```powershell
node <repo>\tools\task-registry\cli.mjs compile --vault <vault> --apply
node <repo>\tools\task-registry\cli.mjs compile --vault <vault> --apply   # 应 unchanged
node <repo>\tools\task-registry\cli.mjs check   --vault <vault>
```

双设备：两台各产生一份新总结 → publisher 跑 `scan --apply` → 任务表篇数各 +1；重复跑不增加。

## 6. 回滚

```powershell
pwsh -File <repo>\scripts\task-registry\install.ps1 -Uninstall
pwsh -File <repo>\scripts\task-registry\deploy-summary-bridge.ps1 -Apply -Uninstall
```

数据恢复见 `docs/task-registry/rollback.md`。不要删除 `records/`，不要改历史 SUMMARY。
