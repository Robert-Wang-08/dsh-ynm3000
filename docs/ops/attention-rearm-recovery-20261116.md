# 健康报告通知修复：成果接收与应用记录

## 问题与裁决

PR #7 缩小了人工事项 revision 的计算范围，升级前入队的通知可能在 dispatch 被标记 superseded；plan 仍保留非空 sentKey，导致该事项无法重新通知或提醒。另有 updatedAt 缺失或不可解析时，静默等待窗口每轮重置、永久无法满足的问题。

经 codex-relay/gpt-6.1-sol（high）复核，选择 A：追加最小修复，不接受永久静默；不改写既有提交。修复来源：本地分支 fix/attention-rearm，提交 a5bb5cc5b7f6388f689cbbe66f546ceb3af9bf25。该提交已保存在本工作区对象库，无需依赖误建工作副本。

## 应用前状态

2026-11-16 本次开始时：修复提交已保存，但尚未应用到本工作树。
目标分支保持 agent/rich-notify-and-filter-4d0a038ba5ff；工作树包含其他会话的 staged/unstaged 修改。
应用前在 tools/superagent_health 执行 `python -B -m unittest test_health -v`，结果 **43 tests，OK**（0.740 s）。
历史误建副本中的 46 tests OK 仅是历史证据，不代替本目标环境验证。

## 允许的应用范围

仅从 a5bb5cc 提取增量，应用于：
- [service.py](../../tools/superagent_health/service.py)：重臂 superseded/missing sentKey、增加 episode 以避免幂等键碰撞；无法解析 updatedAt 时退回即时通知。
- [store.py](../../tools/superagent_health/store.py)：只读查询 outbox 状态。
- [test_health.py](../../tools/superagent_health/test_health.py)：三项回归（superseded 重臂、dispatch→plan 升级路径、缺失 updatedAt）。

禁止切换整体分支、改动暂存区、提交/推送其他会话修改、删除误建副本、重启或更改生产服务配置。测试使用隔离临时数据库与模拟发送器，不主动发送真实消息。

## 当前状态

**2026-11-16 已应用到本工作树，未提交、未推送。** 本节更新不改写上面的“应用前尚未应用”历史状态。

- 从本工作区对象库提取 `git diff a5bb5cc^ a5bb5cc -- tools/superagent_health/service.py tools/superagent_health/store.py tools/superagent_health/test_health.py`；先执行 `git apply --check` 通过，再执行普通 `git apply`（不带 --index）。
- 应用后在目标目录执行 `python -B -m unittest test_health -v`：**46 tests，OK**（0.820 s）。新增三项回归均通过；既有 accepted 通知不重复、提醒触发测试继续通过。
- 三个目标文件与 a5bb5cc 对应文件内容一致（忽略 CRLF/LF 差异）；`git diff --check -- <三个目标文件>` 退出 0。
- HEAD 仍为 c810e98cb91763a5dbc5889aede086af85eca80e；分支未变；应用前后 Git index 的 SHA-256 一致；另外记录的 81 个已有变动文件哈希均未变化。其他会话的 staged/unstaged 改动保留。
- 本次未切分支、未 add/commit/push、未操作远端归档状态、未删除误建副本、未重启服务、未接触生产通知数据库或触发真实发送。

### 回退与运行时边界

应用前的三文件逐字节副本和检查记录临时保存在工作区 `.ptc/attention-rearm-apply-20261116-2110/`。若要回退，只能在先核对这三个文件没有后续修改后，恢复对应三份副本；不要 reset/stash 整个工作区，不要覆盖其他会话改动。临时备份可清理，本说明及本地 fix/attention-rearm 分支才是成果留存入口。

**源码已应用不等同于运行中的守护进程已重新加载。** 本次没有操作该进程；如需验证实际进程采用新版，应另行确认其运行方式与启动时间，再在维护窗口进行，不承诺“下个 tick 自动生效”。
