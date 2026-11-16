# DSH 统一运维入口（桌面「DSH 运维台」）

## 为什么需要

在 2026-11-16 之前，人工起停分散在 5 个地方：登录启动 `DSH-Default-Startup.cmd`、`dsh-superagent-service.ps1`、`dsh-sa-local-service.ps1`、1 分钟健康任务、5 分钟飞书监督，外加随手开的终端。
当天出现「在另一个终端重启 superagent」与「同 profile 正在 `dsh plugin add`」叠加，说明缺少一个**人用的统一判断点**。

## 入口

桌面快捷方式 `DSH 运维台.lnk` → `D:\src\dsh\dsh-ops-gate.ps1`。

| 参数 | 行为 |
|---|---|
| 无参数（桌面双击） | 检查 → 只补起没在监听的服务 → 打印表格 → 打开 3080 |
| `-CheckOnly` | 只看不改 |
| `-NoPause` | 不等待回车（供脚本/任务调用） |
| `-NoOpen` | 不打开浏览器 |

## 检查项

1. DSH web（3080）
2. superagent（3082）
3. sa-local（3083）
4. 飞书 HITL daemon（心跳 age ≤ 30s、inbound=running、pid 存活）
5. 计划任务 `DSH-Feishu-Supervisor` / `DSH-Superagent-Health` / `DSH-Git-Watchdog` 状态与 LastTaskResult

## 安全规则

- **只补起缺失项**：已在监听的服务一律不重启、不打断回合；
- **维护守卫**：检测到 `dsh plugin` / `pnpm add|install|remove` 正在改写 profile 时，整轮拒绝拉起并标注 BLOCKED；
- **单实例**：全局内核互斥，双击两次不会并发拉起；
- **飞书 daemon 不在此处盲启**：降级时只报告，交由 5 分钟监督任务按「死亡确认」规则处置；
- 全程写日志 `%USERPROFILE%\.dsh\logs\dsh-ops-gate-*.log`。

## 与自动监督的分工

| 场景 | 负责方 |
|---|---|
| 无人值守时 daemon 死亡 | `DSH-Feishu-Supervisor`（5 分钟，死亡确认后补起 + 告警） |
| 无人值守时 superagent 健康采集 | `DSH-Superagent-Health`（1 分钟，采集/告警，不自愈） |
| 人主动「看一眼并补起来」 | 桌面「DSH 运维台」 |
| 开机 | `DSH-Default-Startup.cmd`（登录后按顺序拉起三件套） |

桌面入口**不替代**计划任务：否则无人值守时就没有任何自愈能力。
