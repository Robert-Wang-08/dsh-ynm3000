# session-summary 收尾桥接（供评审的原文）

`scripts/task-registry/deploy-summary-bridge.ps1` 会在目标 `SKILL.md` 末尾追加下面这段，带固定标记，幂等；默认 DryRun，`-Apply` 前自动写 `.bak-before-taskbridge-*`。

```markdown
<!-- BEGIN task-registry bridge -->
## 12. 任务打标与近期任务表（task-registry，2026-11-19）

落盘汇总写完后，若工具可用，运行一次登记（失败不阻断报告）：

```powershell
node "<repo>\tools\task-registry\cli.mjs" label --summary "<总结文件绝对路径>" --vault "<vault>" --apply
```

- 只在**新总结首次发布前**追加 `tasks / primary_task / task_labeling` 三个 frontmatter 键；正文、命名、水位都不改。
- 规则匹配不到任务时落 `T-INBOX` 并标 `review: manual`，不要硬编一个不存在的 ID。
- 历史总结不批量改写；由 publisher 每 10 分钟 `scan` 只读补关联（`_registry/summary-links.json`）。
- 工具或 vault 不可用：跳过，并在报告里注明「分类登记待补」，不阻断总结发布。
<!-- END task-registry bridge -->
```

## 不采纳的做法

- 不把任务标签塞进 `设备-agent-任务清单/records/*.md`（tasklog 的 `FM_KEYS` 白名单会覆盖新增字段）。
- 不让本桥接自动改写历史 `SUMMARY_*`（只写 sidecar）。
- 不在 `SUMMARY_INDEX.md` 追加任何行（水位仍由 session-summary 自己维护）。
