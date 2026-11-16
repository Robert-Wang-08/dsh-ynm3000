# Feishu daemon 心跳监督（2026-11-16）

本轮任务：task-20261115T173545641230Z-4395edd7d95d。主控 codex-relay/gpt-6.1-sol；路由器 R1 / controller-codex，未派 worker。

## 行为

- Windows 用户任务 DSH-Feishu-Supervisor：经 `wscript.exe //B //Nologo` 启动无窗口 VBS，再由它在隐藏窗口里运行 PowerShell；每5分钟一次，加用户登录触发、StartWhenAvailable、IgnoreNew、最长4分钟，允许电池运行。2026-11-16 修复：最初直接以 `pwsh.exe` 作任务动作会闪现控制台窗口，现改为隐藏启动器并保留子进程退出码。
- 30秒心跳阈值，采样相隔6秒；核对入口完整路径、PID、创建时间（允许 JS 启动时间落后 OS 创建时间10秒）、seq/tick推进、入站子进程与父进程。
- 只有心跳过阈值、进程完整枚举成功且确无目标 daemon，才有资格 Repair；启动前再次观察，start 脚本再次枚举。全程没有 stop/restart 调用。
- stale但进程活着、CIM拒绝、心跳损坏/缺失、PID身份不匹配、其它入口 daemon、时钟倒退、暂停/停止通道或任意 unknown，均不拉起。
- 入站子进程断开、3082不ready只告警，不重启活服务；既有 daemon 自带的子进程重连继续负责入站恢复。
- 监督与 start 各有按 stateDir 区分的全局内核 mutex；崩溃自动释放。既有 daemon 目录锁仍为第二道门，不在监督器中删除。
- incident首次告警、15分钟合并提醒、层级明确恢复后恢复通知。unknown不等于恢复；未发送通知在独立持久队列中重试，最多每轮3条。日志/状态原子写入。
- 独立飞书出口直接用现有CLI配置，不经过 daemon 或共享 pending/outbox；仍遵守飞书总开关。Windows toast是第二出口；API成功/失败回执落日志，不声称用户已读。

## 新设备安装、检查、回滚

在实际 HITL 仓库根目录执行（路径由脚本自身位置解析；需已有本机 channel/target/lark-cli 配置）。不安装插件、不修改 profile/bundle，也不要求重启 DSH。

~~~powershell
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Install -Mode Repair
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Verify
Start-ScheduledTask -TaskName DSH-Feishu-Supervisor
Get-ScheduledTaskInfo -TaskName DSH-Feishu-Supervisor
Get-Content ./state/feishu-supervisor-latest.json -Raw
~~~

默认Repair；只观察可在首次安装时改为 -Mode Monitor。已存在任务拒绝覆盖；模式变更先显式Uninstall，再Install。回滚：

~~~powershell
pwsh -NoProfile -File ./tools/register-feishu-supervisor.ps1 -Action Uninstall
~~~

这仅删除监督任务，不停止daemon/DSH。正在执行的监督轮次会自行有界结束。若正在维护daemon，先撤销监督任务，避免正常计划停止被当成故障。运行数据位于本机state，不能复制凭据、历史或运行状态到另一设备。

## 验证证据

- node --test test/feishu-supervisor.test.mjs：25/25通过。覆盖daemon死亡、入站子进程断开、3082不ready、恢复成功，以及身份/unknown/节流/持久化。隔离runner用fixture，唯一实际被杀的是测试自己启动的临时node进程；未杀生产daemon。
- 生产Monitor和计划任务执行均ready/action=none；第一次计划执行LastTaskResult=0（2026-11-16 09:22）。真实daemon PID29888、创建时间2026-11-16 00:26:10仍保持；superagent PID21544保持。
- 独立飞书验收通知message_id：om_x100b6091e3d1c8bcc132804a1737f2d，出口code=0。
- 新代码只在新监督进程及未来启动调用中生效；本轮未重载daemon模块、未修改其代码。

## 限制

1. 本轮按用户要求不关闭/重启任何现有服务；生产“杀daemon后拉起”未演练，仅隔离故障与判定/runner持久化测试，不将其声称为生产自愈验收。
2. Interactive登录身份不需要保存密码，但只有用户已登录才执行；锁屏可运行，关机/注销不能运行。未承诺未登录启动或整机断电告警。
3. 飞书API/网络也坏时同通道远程告警会失败；持久重试及toast可提供本机证据，不能保证远程送达。未新开备用渠道。
4. 保守策略不会自动解决活着但卡死的daemon或未知状态，这些会告警等待诊断。既有单实例目录锁owner不明时启动也可能被拒，必须人工核实，绝不盲删。
5. 交付当前本地工作树；未提交/推送或合并PR，另一设备必须先取得这批源码，再按上述入口安装任务。
6. PTC生命周期：当前会话已绑定早先的通道改绑根任务，新根session-start因重复session_id被拒。本轮未伪造会话或重写绑定；实现任务独立登记。全账本verify仍报告7条历史坏事件，未清理历史。
