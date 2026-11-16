# DSH / superagent 后台与自启清单（2026-11-16）

采集方式：`Get-ScheduledTask`（非 Microsoft 路径）、注册表 Run/RunOnce、启动文件夹、`Win32_Process`、`netstat`。原始数据：`.ptc/reports/autostart-inventory-20261116.json`。

## A. Windows 计划任务（DSH 相关）

| 任务 | 频率 | 运行内容 | 状态 |
|---|---|---|---|
| DSH-Superagent-Health | 每 1 分钟 | wscript → 隐藏 VBS → `tools/superagent_health/run.ps1`（采集 + 可选发送） | Ready，lastResult=0 |
| AgentTaskLog-Superagent | 每 1 分钟 | wscript → `agent-tasklog\run-sync-hidden.vbs`（同步 agent 任务日志） | Ready，lastResult=0 |
| DSH-Feishu-Supervisor | 每 5 分钟 + 登录 | wscript → 隐藏 VBS → 飞书 daemon 死亡确认与修复、告警 | Ready，windowless=true |
| DSH-Git-Watchdog | 每 1 小时 | wscript → `run-git-watchdog-hidden.vbs`（仓库巡检） | Ready，lastResult=0 |
| DSH-Bilibili-Nightly | 每日 02:00 | pwsh（仍直接启动，仅在夜间跑一次） | Ready，lastResult=0 |
| DSH-GitSync-Scan | 每周一 09:30 | wscript → `run-gitsync-scan-hidden.vbs`（仓库清单保鲜） | Ready，lastResult=0 |

## B. 登录自启

| 位置 | 项 | 内容 |
|---|---|---|
| 启动文件夹 | `DSH-Default-Startup.cmd` | 依次启动 superagent(3082)、sa-local(3083)、sa-local 飞书通知器；3080 未监听时再启动 web |
| 启动文件夹 | `OpenClaw-Gateway.cmd` | 先重放微信入站游标补丁，再以最小化启动 `openclaw gateway run`（18789） |
| 启动文件夹 | `订阅用量小工具.lnk` | wscript → `subscription-usage-widget\launch.vbs` |
| 注册表 HKCU | Feishu / Nutstore / Weixin / Teams / OneDrive 等 | 桌面应用自启，与 DSH 无直接依赖 |

无 DSH 相关 Windows 服务（`Win32_Service` 中按 dsh/superagent/openclaw/lark/node 匹配为 0），全部是用户会话级进程。

## C. 常驻后台进程

| 组件 | PID | 端口 | 启动来源 |
|---|---|---|---|
| DSH web profile | 1684 | 3080（另有 tailscaled 在 100.67.22.127:3080 代理） | 启动文件夹 DSH-Default-Startup.cmd → webprofile.sh |
| superagent | 30000 | 3082 | dsh-superagent-service.ps1（pid 文件在 profiles/superagent/.artifacts） |
| sa-local | 20944 | 3083 | dsh-sa-local-service.ps1 |
| sa-local 飞书通知器 | 5924 | - | dsh-sa-local-notify.ps1（轮询 orchestrator.sqlite 推工单状态） |
| 飞书 HITL daemon | 29888 | - | restart-feishu-daemon.ps1（cmd 壳 9012 → node 29888） |
| OpenClaw 网关 | 30148 | 18789 | 启动文件夹 OpenClaw-Gateway.cmd |
| MCP 服务（每个宿主按需拉起） | 多个 | - | ticktick / codegraph / questionnaire-confirm |
| 工具执行器与子代理 | 瞬时 | - | `dsh-subprocess-local`、子代理 runner，随回合生灭 |

## D. 今天改动过的两项

`DSH-Superagent-Health`（主因，每 1 分钟）与 `DSH-Feishu-Supervisor`（每 5 分钟）已从「直接起 pwsh.exe」改为 `wscript.exe //B //Nologo` + 隐藏 VBS + `WScript.Quit` 回传退出码，消除控制台闪窗。详见 `docs/ops/scheduled-task-popup-20261116.md`。
