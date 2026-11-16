# 定时 PowerShell 窗口闪现排查（2026-11-16）

## 现象与原因

用户报告 Windows 每隔约 1–2 分钟冒出一个 PowerShell 控制台窗口。

排查结论：不是飞书 daemon 或心跳判定逻辑在弹窗，而是两个计划任务把控制台子系统的 `pwsh.exe` 直接当作任务动作，每次触发都会创建可见控制台：

| 任务 | 频率 | 原动作 |
|---|---|---|
| `DSH-Superagent-Health` | 每 1 分钟 | `pwsh.exe -NoProfile -NonInteractive ...`（主因，与“1–2 分钟”吻合） |
| `DSH-Feishu-Supervisor` | 每 5 分钟 | `pwsh.exe -NoProfile -NonInteractive -File ...`（本次新建，同样漏了无窗口启动） |

`-WindowStyle Hidden` 在任务计划调用下并不保证完全不闪现；本机既有的 `DSH-Git-Watchdog` 用 GUI 子系统的 `wscript.exe` 启动隐藏 VBS，才是已验证不弹窗的写法。

## 修复

两个任务改为：

1. 任务动作 = `wscript.exe //B //Nologo "<launcher>.vbs"`；
2. VBS 用 `WScript.Shell.Run(cmd, 0, True)`：`0` = 隐藏窗口，`True` = 等待，退出码经 `WScript.Quit` 回传，`LastTaskResult` 仍然有效；
3. 内层 pwsh 参数追加 `-WindowStyle Hidden`；
4. 触发器、Principal、Settings 在修改前后逐项 XML 比对一致，未改变频率与登录要求。

启动器位置：`D:\src\dsh\dsh-wechat-hitl\state\feishu-supervisor-task.vbs`、`C:\Users\wwm_1\.dsh\device\superagent-health\superagent-health-task.vbs`。

改前任务 XML 与安装器源码备份在 `D:\src\dsh\.ptc\backups\pwsh-popup-20261116\`。

## 验证

- 两个任务手动各触发一次：`LastTaskResult=0`，下次运行时间未变。
- 隔离测试 `Run(..., 0, True)` + `WScript.Quit`：子进程退出码 7 正确回传，隐藏参数为 0；两处安装器分别 PASS。
- Feishu 监督器回归 25/25 通过，监督结果仍为 ready/action=none。
- 服务未重启：飞书 daemon PID 29888、superagent PID 21544 创建时间不变。

## 回滚

从备份目录取同名 `.xml`，用 `Register-ScheduledTask -Xml (Get-Content <file> -Raw) -TaskName <name> -Force` 恢复。

## 限制

VBS 启动器成为任务动作的一部分；若被删除，任务失败但不弹窗（失败可在 `LastTaskResult` 看到）。不要为省事把任务动作改回 `pwsh.exe`，那会重现弹窗。