# 会话总结自动打标 + 近期任务表（设计）

> 合并定稿来源：2026-11-19 用户确认 `1A 2A 3A 4A 5A 6A`（6.1sol 设计 + opus5 挑战 + deepseek4fl 合并）。
> 本文件只记录实现口径；完整评审稿在用户的 vault `设备-agent-任务清单/_review/design-final-20261119.md`。

## 1. 目标

1. 每份新会话总结自动带上「属于哪些任务」的标签，不靠临时口头提醒。
2. 全库只维护一张「近期任务表」：一级/二级、稳定 ID、可拖拽、Markdown。
3. 飞书文档作为登记形态（scope 批准后），本地保留 md 等效副本。

## 2. 非目标

- 不改历史 SUMMARY 正文、命名或 `SUMMARY_INDEX.md` 水位。
- 不新建第四套执行台账；ticket 级事实仍在 `设备-agent-任务清单/records/`，待办仍在 `todos.jsonl`，N/U 编号不动。
- 不自动判定业务完成：`ended` / 测试通过 ≠ 业务闭环。
- 不在 scope 缺失时假造飞书链接。

## 3. 权威与派生

| 形态 | 位置 | 权限 |
|---|---|---|
| 任务表（权威） | `<vault>/近期任务表/近期任务表.md` | 人/agent 编辑；compile 回填日期/篇数 |
| 编译投影 | `_registry/tasks.json` | 只由 compile 写；禁止手改 |
| 关联索引 | `_registry/summary-links.json` | 只由 label/scan 追加或更新 |
| 本地等效副本 | `_registry/feishu.md` | 由 feishu export 生成 |
| 飞书文档 | 用户共享文件夹内 docx | 默认单向镜像；人工修改走 reconcile（P4） |

## 4. 已确认的 6 项口径

1. **任务范围**：`ncbs-cr`、`dsh工具管理` 两棵进近期；2026-10-27 旧 7 个一级任务放「历史」保留，不合并、不删除。
2. **ID**：可读、不可变短 ID，如 `T-NCBS-CR-DATASTD`；改名/拖动不改 ID。
3. **近期**：30 天内有活动或置顶；最多三级。
4. **飞书**：默认本地→飞书单向；用户在飞书改过后跑 `feishu reconcile` 看差异再回写。
5. **历史总结**：最近 30 天只读 sidecar 补关联，不改原文件。
6. **scope**：现在申请 `docx:document`、`docx:document:create`、`drive:drive`、`drive:file`；批前本地形态照常。

## 5. 打标流程

1. 写总结的环节（session-summary 收尾桥接）调用 `label --summary <file> --apply`。
2. `label` 用规则做确定性匹配：工作区 + `keywords_all/any` + 证据 + `exclude`；模型已写的 `tasks` 通过 ID 与证据校验。
3. 不命中 → `T-INBOX` + `review: manual`；不硬贴。
4. 兜底：publisher 每 10 分钟 `scan --since-days 30 --apply`，只写 `summary-links.json`，不改总结。
5. 幂等键：总结文件名 + 文件哈希 + 规则版本；重复运行结果不变。

## 6. 飞书（P4，scope 后）

- 建 docx「近期任务表」于用户共享文件夹；`docs +create --doc-format markdown --parent-token <folder>`。
- 更新用 `docs +fetch --detail with-ids` + `docs +update`（`str_replace`/`block_*`/`append`，带 `--revision-id`），不整篇 overwrite。
- 回读校验可见 `[T-ID]` 与层级；不保真立即停止自动写、降级只读。
- 未授权：`feishu_state=pending_scope`、`feishu_url=null`，但 `feishu.md` 照常生成。

## 7. 跨设备

- publisher（默认 x1t）写 `tasks.json` / `summary-links.json`；producer（第二台）只给自己的新总结打标，不写全局产物。
- 设备配置为本机 `%LOCALAPPDATA%\task-registry\config.json`；路径/角色可放共享盘 `dsh-device/task-registry/<device>.json`。
- 坚果云不是分布式锁：出现冲突副本或任务表哈希在提交前改变，停止该轮并保留双方版本。

## 8. 验收

见 `acceptance.md`；回滚见 `rollback.md`。
