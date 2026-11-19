# task-registry 回滚

## 本地数据

- `compile` / `scan` / `label` 写前都在同目录保留 `.bak-before-<tag>-<时间戳>`（每类保留最近 5 份）。
- 恢复任务表：把对应 `.bak-before-compile-*` 复制回 `近期任务表.md`，再 `compile --apply`。
- 恢复关联：用坚果云版本历史恢复 `summary-links.json`；或删除该总结条目后重扫。
- 恢复总结：`node tools/task-registry/cli.mjs unlabel --summary <file> --apply`；需要字节级恢复时用 `.bak-before-tasklabel-*`。

## 计划任务

```powershell
pwsh -File scripts/task-registry/install.ps1 -Uninstall
```

只删计划任务，保留 `%LOCALAPPDATA%\task-registry\config.json` 与 `sync.log`；需要彻底清理时手动删该目录。

## session-summary 桥接

```powershell
pwsh -File scripts/task-registry/deploy-summary-bridge.ps1 -Apply -Uninstall
```

只移除 `<!-- BEGIN/END task-registry bridge -->` 标记块；部署前有 `.bak-before-taskbridge-*`。

## 飞书（P4 后）

- 未建档：无操作。
- 已建档：先 `feishu reconcile --dry-run` 备份当前块内容；只做受控块逆向，不删除文档、不撤销共享。
- 撤销共享前先列影响人；不自动删除飞书文档或文件夹。

## 边界

- 不删除 DSH ticket、不改 `设备-agent-任务清单/records`、不改历史 SUMMARY。
- 不回滚 Git 之外的东西时，不要把 `git revert` 当作云端数据回滚。
