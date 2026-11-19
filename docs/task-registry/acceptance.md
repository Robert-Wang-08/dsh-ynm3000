# task-registry 验收

前置：`$repo` 为仓库根，`$vault = C:\syncJIANGUO\1.logseq`，`$cli = "$repo\tools\task-registry\cli.mjs"`。
所有 `--apply` 前先看 DryRun 输出；真实写入前会生成 `.bak-before-*`。

## P1 文件契约

```powershell
node $cli init --vault $vault --apply          # 首次；已存在应拒绝
node $cli compile --vault $vault --dry-run
node $cli compile --vault $vault --apply
node $cli compile --vault $vault --apply       # 第二次应为 unchanged
node $cli doctor --vault $vault --strict
```

通过标准：
- `doctor` 0 error / 0 warning；`tasks.json` 的 `source_hash` 与任务表一致。
- 重复 `compile --apply` 不刷新文件 mtime，不重复写 `.bak`。
- 人为制造重复 ID / 跳级缩进 / 丢父级 → `compile` 退出 3，旧 `tasks.json` 仍可读。

## P2 打标

```powershell
node $cli label --summary <新总结.md> --vault $vault --apply
node $cli scan  --vault $vault --since-days 30 --apply
node $cli scan  --vault $vault --since-days 30 --apply   # added=0 updated=0
node $cli check --vault $vault
```

通过标准：
- 新总结只多出 `tasks / primary_task / task_labeling`，正文哈希不变（工具会打印 `bodyHash`）。
- 不命中规则的总结落 `T-INBOX`，不得出现不存在的 ID。
- 近 30 天历史总结只增加 `summary-links.json` 条目；`SUMMARY_*` 与 `SUMMARY_INDEX.md` 哈希不变。
- 同一总结重复扫描不新增条目；`unlabel` 后只撤工具键，正文不变。

## P3 调度

```powershell
pwsh -File $repo\scripts\task-registry\install.ps1 -Vault $vault -WhatIf
pwsh -File $repo\scripts\task-registry\install.ps1 -Vault $vault
Get-ScheduledTask -TaskName TaskRegistry-Sync
node $cli doctor --vault $vault --strict
pwsh -File $repo\scripts\task-registry\install.ps1 -Vault $vault -Uninstall
```

通过标准：装一次只有一个任务、一个 action；重复安装不新增任务；日志在 `%LOCALAPPDATA%\task-registry\sync.log`；停用后任务消失、配置保留。

## P4 飞书（scope 批准后）

```powershell
node $cli feishu preflight --vault $vault
node $cli feishu export --vault $vault --apply
```

通过标准：
- scope 未批：退出 4，`feishu_state=pending_scope`、`url=null`，控制台链接指向 `cli_aa79ee689678dd03`。
- scope 批准后（另次实现）：bot 只在用户共享文件夹建档；用户本人能打开链接；拖一个子节点后 `reconcile --dry-run` 能识别差异；同时改同一父级退出 2 且不覆盖。

## 拖拽门禁（Obsidian）

1. 用 Outliner / Markmind 拖动一个二级节点到另一父级并保存。
2. `node $cli compile --vault $vault --apply`。
3. 通过标准：ID、标题、未知行不变；父子关系跟随缩进；`doctor` 0 error。
4. 任一插件丢失 ID 或格式：记录插件名，先只用文本缩进调整，不宣称思维导图拖拽可用。
