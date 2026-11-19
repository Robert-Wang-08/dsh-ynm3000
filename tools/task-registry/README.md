# tools/task-registry — 会话总结任务打标与近期任务表

给 `SUMMARY_*.md` 会话总结自动打任务标签，并维护 vault 里的一张「近期任务表」（多级列表、稳定 ID、可拖拽）。

- **不改**历史总结正文，不改汇总命名与 `SUMMARY_INDEX.md` 水位。
- **唯一权威**是 `近期任务表/近期任务表.md`；`_registry/tasks.json` 只是编译投影。
- **飞书**是镜像形态，scope 批准前不建档、不伪造链接。

## 目录

```text
<vault>/近期任务表/
  近期任务表.md                  # 人工维护：一层/二层任务、状态、可拖动
  _registry/
    tasks.json                  # 编译产物（只读消费，不要手改）
    rules.json                  # 打标规则（工作区/关键词/排除词）
    summary-links.json          # 总结→任务关联（只追加/更新，不复制正文）
    feishu.md                   # 飞书文档的 Markdown 等效副本
```

## 用法

```powershell
$cli = "$repo\tools\task-registry\cli.mjs"
$vault = "C:\syncJIANGUO\1.logseq"

node $cli init    --vault $vault --apply     # 首次建表（已存在则拒绝）
node $cli compile --vault $vault --apply     # 解析 MD → tasks.json（并回填日期/篇数）
node $cli doctor  --vault $vault --strict    # 校验树、JSON、关联
node $cli label   --summary <file> --vault $vault --apply   # 给新总结加 tasks/primary_task/task_labeling
node $cli scan    --vault $vault --since-days 30 --apply    # 兜底：近 30 天未登记总结只读补关联
node $cli check   --vault $vault             # 有未关联/非法 ID 时退出 2
node $cli unlabel --summary <file> --vault $vault --apply   # 只撤工具加的键
node $cli feishu export --vault $vault --apply              # 生成 feishu.md（本地等效副本）
node $cli feishu preflight --vault $vault                   # 探测 lark-cli 与飞书 scope
```

默认是 DryRun；只有带 `--apply` 才写文件。退出码：`0` 正常（含 unchanged），`2` 待人工，`3` 配置/结构错误，`4` 外部不可用（如飞书 scope）。

## 任务表格式

```markdown
- `T-NCBS-CR` ncbs-cr ｜在办｜2026-11-19｜3 篇
  - `T-NCBS-CR-ROOTWORD` 数据词根统一 ｜在办｜2026-11-17｜2 篇
- `T-INBOX` 待分类 ｜待人工
```

- ID：`T-` + 大写字母/数字/连字符，全表唯一，**改名和拖动都不变**。
- 两个空格一级缩进，最多三级；`## 近期` / `## 历史` 分区。
- 日期/篇数是派生态，`compile --apply` 会按 `summary-links.json` 回填。

## 打标规则

`_registry/rules.json` 每条任务可选：`workspaces`（dsh / ncbs / logseq）、`keywords_all`、`keywords_any`、`exclude`、`aliases`。
一个事项必须同时满足「工作区命中 + 关键词 + 有证据（路径/提交/报告/cwd）」才会命中；**没有证据不贴**。全篇都不命中时落 `T-INBOX`，`review: manual`。

## 隐私与边界

- `summary-links.json` 只存总结文件名、哈希、窗口和任务 ID；不复制正文、不存绝对用户路径。
- 生成的 `feishu.md` 只含任务名/ID/状态/日期，不含总结内容。
- 本工具不读取 `orchestrator.sqlite`，不重复 `设备-agent-任务清单` 的 ticket 级登记。

## 回滚

- 任务表/JSON：写前自动 `.bak-before-compile-*`；也可用坚果云版本历史。
- 总结：`unlabel --summary <file> --apply` 只删 `tasks/primary_task/task_labeling`；`.bak-before-tasklabel-*` 保留最近 5 份。
- 计划任务：`scripts/task-registry/install.ps1 -Uninstall`。
