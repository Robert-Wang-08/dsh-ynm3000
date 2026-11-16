# DSH 后台任务治理：落地说明（2026-11-16）

> 本文是可执行落地页：做了什么、现在跑着什么、怎么装、怎么验、怎么回滚、还剩什么。
> 配套细节：[飞书心跳监督](feishu-supervisor-20261116.md) · [定时任务弹窗排查](scheduled-task-popup-20261116.md) · [后台任务清单](dsh-background-inventory-20261116.md)。

## 1. 本次落地范围

| 编号 | 变更 | 结果 |
|---|---|---|
| L1 | 飞书 daemon 五分钟死亡确认与自愈监督 | 已安装为计划任务 `DSH-Feishu-Supervisor` |
| L2 | 监督告警链路（首次 / 15 分钟合并 / 恢复） | 独立 CLI 出口，持久重试，已实测送达 |
| L3 | 定时任务控制台闪窗修复 | `DSH-Superagent-Health`、`DSH-Feishu-Supervisor` 改为隐藏启动 |
| L4 | 后台任务全量盘点 | 6 个计划任务、3 个登录自启项、6 个常驻进程，无 Windows 服务 |
| L5 | bot 选择从脚本搬到设备层 | 新增 `dsh-superagent-lark-bot.ps1`；本机已 pin `aa67`；启动时打印 appId/来源/原因 |
| L6 | 跨机器文档纠偏 | 修正「aa79ee 目录消失」误判：它属 x1t，本机从未存在 |

**约束（全程遵守）**：未停止、未重启 DSH web、superagent 或飞书 daemon；未改凭据；未改业务数据。

## 2. 现状清单

### 2.1 计划任务

| 任务 | 频率 | 内容 | 启动方式 |
|---|---|---|---|
| DSH-Superagent-Health | 每 1 分钟 | superagent 健康采集与可选推送 | wscript → 隐藏 VBS |
| AgentTaskLog-Superagent | 每 1 分钟 | agent 任务日志同步 | wscript → 隐藏 VBS |
| DSH-Feishu-Supervisor | 每 5 分钟 + 登录 | 飞书 daemon 死亡确认、修复、告警 | wscript → 隐藏 VBS |
| DSH-Git-Watchdog | 每 1 小时 | 仓库巡检与备份滞留提醒 | wscript → 隐藏 VBS |
| DSH-Bilibili-Nightly | 每日 02:00 | B 站收藏解析 | pwsh（**仍是直启，夜间可能闪窗**） |
| DSH-GitSync-Scan | 每周一 09:30 | 仓库清单保鲜 | wscript → 隐藏 VBS |

### 2.2 登录自启

| 项 | 作用 |
|---|---|
| `DSH-Default-Startup.cmd` | 启动 superagent(3082)、sa-local(3083)、sa-local 飞书通知器；3080 未监听时启动 web |
| `OpenClaw-Gateway.cmd` | 重放微信入站游标补丁后启动 OpenClaw 网关(18789) |
| `订阅用量小工具.lnk` | wscript 启动订阅用量小组件 |

### 2.3 常驻进程（采集时刻）

| 组件 | PID | 端口 |
|---|---|---|
| DSH web | 1684 | 3080 |
| superagent | 30000 | 3082 |
| sa-local | 20944 | 3083 |
| sa-local 飞书通知器 | 5924 | — |
| 飞书 HITL daemon | 29888 | — |
| OpenClaw 网关 | 30148 | 18789 |

另有 ticktick / codegraph / questionnaire-confirm 三个 MCP 服务按宿主拉起，以及随回合生灭的子代理与工具执行器。

## 3. 飞书监督：行为与安全边界

**只有同时满足**下列条件才会自动拉起 daemon：

1. 进程枚举成功（失败即 unknown，绝不启动）；
2. 目标入口 `feishu/feishu-daemon.mjs` 的进程数为 0；
3. 心跳已超过 30 秒；
4. 6 秒后二次观察仍判定为「确认死亡」；
5. 启动脚本自身再枚举一次、再由 daemon 目录锁复核。

以下情况**只告警、不修复**：进程活着但心跳停滞、PID 与创建时间不匹配、入站子进程缺失、superagent 3082 未就绪、时钟倒退、通道处于 paused/stopped、任何 unknown。

告警：incident 首次即发；同一 incident 每 15 分钟合并提醒；层级恢复为 ready 后才发恢复通知（unknown 不算恢复）。发送失败进持久队列，每轮最多补 3 条。

**明确不做**：不强杀活进程、不重启 DSH、不接管 superagent 重启、不改 daemon 目录锁。

## 4. 安装 / 验收 / 回滚

### 4.1 安装（已执行，幂等需先卸载）

~~~powershell
cd D:\src\dsh\dsh-wechat-hitl
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Install -Mode Repair
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Verify
~~~

`-Mode Monitor` 为只观察不修复。任务已存在时脚本拒绝覆盖。

### 4.2 验收

~~~powershell
# 1) 任务定义：应为 wscript.exe + windowless=true + 5 分钟
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Verify

# 2) 判定核心单测（25 项）
node --test test/feishu-supervisor.test.mjs

# 3) 最近一次监督结果
Get-Content ./state/feishu-supervisor-latest.json -Raw

# 4) 服务未被重启
Get-Process -Id <daemonPid>,<superagentPid> | Select-Object Id,StartTime
~~~

### 4.3 回滚

~~~powershell
# 仅停用监督，不动任何服务
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Uninstall

# 恢复任务定义（含隐藏启动修复前状态）
Register-ScheduledTask -TaskName DSH-Superagent-Health -Xml (Get-Content D:\src\dsh\.ptc\backups\pwsh-popup-20261116\DSH-Superagent-Health.xml -Raw) -Force
Register-ScheduledTask -TaskName DSH-Feishu-Supervisor -Xml (Get-Content D:\src\dsh\.ptc\backups\pwsh-popup-20261116\DSH-Feishu-Supervisor.xml -Raw) -Force
~~~

## 5. 验收证据

| 项 | 证据 |
|---|---|
| 监督判定单测 | 25/25 通过，含死亡、入站断开、3082 未就绪、恢复、PID 复用、并发实例、内核互斥 |
| 既有健康探针回归 | 25/25 通过 |
| 真实计划任务执行 | `LastTaskResult=0`，`ready / action=none` |
| 独立告警出口 | 实测送达，message_id `om_x100b6091e3d1c8bcc132804a1737f2d` |
| 隐藏启动 | 两处安装器均验证「隐藏参数 0 + 退出码 7 正确回传」 |
| 服务连续性 | daemon 29888、superagent 21544 创建时间全程未变 |

## 6. 已知限制

1. **生产杀 daemon 自愈演练未做**：遵守「不关闭服务」要求，四类故障用隔离场景覆盖，未把隔离结果当作生产自愈验收。
2. **依赖登录用户**：任务为 Interactive 身份，锁屏可跑，注销/关机期间不运行。
3. **同通道告警的单点性**：飞书 API 或网络本身故障时，告警可能发不出；toast 与持久重试只提供本机证据。
4. **保守不处理卡死**：活着但卡死、或判定为 unknown 的 daemon 不会被自动重启，只告警等人判断。
5. **`DSH-Bilibili-Nightly` 仍直启 pwsh**：夜间 02:00 可能闪一次窗，尚未改。
6. **代码未提交**：改动在当前工作树，未 commit / push / 合并 PR；换设备需先取得这批源码。

## 7. 下一步（建议顺序）

1. 观察 24 小时内 `feishu-supervisor.log` 与 `LastTaskResult`，确认无反复 incident；
2. 决定是否把 `DSH-Bilibili-Nightly` 也改为隐藏启动；
3. 在可接受的维护窗口补一次**真实**「杀 daemon → 自动拉起 → 告警送达」演练，并记录 incidentId；
4. 把本批改动提交并推送，按仓库纪律更新 README 登记。

## 8. 相关路径

| 用途 | 路径 |
|---|---|
| 监督入口 | `dsh-wechat-hitl/tools/feishu-supervisor.ps1` |
| 判定核心 | `dsh-wechat-hitl/feishu/feishu-supervisor.mjs` |
| 告警出口 | `dsh-wechat-hitl/tools/feishu-supervisor-alert.mjs` |
| 注册器 | `dsh-wechat-hitl/tools/register-feishu-supervisor.ps1` |
| 运行状态 | `dsh-wechat-hitl/state/feishu-supervisor-state.json` / `-latest.json` / `.log` |
| 隐藏启动器 | `state/feishu-supervisor-task.vbs`、`~/.dsh/device/superagent-health/superagent-health-task.vbs` |
| 备份 | `.ptc/backups/pwsh-popup-20261116/` |
