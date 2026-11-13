# tools/unify — 四源只读导出器

把本机四份互不相认的任务来源导出成 spec-track 可读的轨道数据，**只读，不写任何源**。

## 用法

```powershell
& $env:PTC_PYTHON tools/unify/export.py                 # 导出到 SkillHub .scratch/
& $env:PTC_PYTHON tools/unify/export.py --dry-run       # 只看摘要
& $env:PTC_PYTHON tools/unify/export.py --include-ptc   # 额外并入 PTC 根任务（默认关）
```

产出：`.scratch/unified-<source>/feature-track.json`（每条泳道一个 station，任务挂 `features`）
　　　`.scratch/unified-<source>/feature-track.history.jsonl`（每次导出追加一条 `export_snapshot`）
　　　`.scratch/unified-lanes-template.json`（六泳道模板，供渲染器使用）

查看（任务级）：
```powershell
& $env:PTC_PYTHON <skillhub>/tools/track/track_render.py show unified-focus-hub --model project \
    --template <skillhub>/.scratch/unified-lanes-template.json
```

## 五条约定（人与 agent 混合编排）

```
1. 每条任务只有一个写权威（source 字段）；导出层 0 写端点、永不写回。
2. 会话内 agent 只能推进到 in_review / awaiting-user，不得标 done 或验收。
3. 验收仅 human-confirm 一种：taskboard GUI done / supervisor 用户释放或终审 /
   focus-hub /api/acceptance，三选一；导出记录 acceptor 字段。
4. 跨源同一任务不合并；确需关联时人工登记 alias，导出只读。
5. parked/暂挂必须保留 from、reason、fromSession，与"作废"分开展示。
```

## 源与映射

| source | 文件 | 状态映射 |
|---|---|---|
| taskboard | `~/.dsh/dsh-taskboard.json` | backlog/todo→pending，in_progress→active，in_review→review，done→done |
| focus-hub | `focus-hub/mvp/data/project.json` | tasks[] 按 status；`parked[]` 一律进 parked 泳道 |
| ptc（可选） | `.ptc/registry.jsonl` | 只取根任务 id，状态 unknown（事件不是任务） |

supervisor **未接入**：其状态只存在于 DSH 运行时的 session 事件流与 `sessionProjections`，文件层读不到；需要时用 `/api/task-supervisor?sessionId=…` 取，属后续工作。

## 已知边界

- `track_render.py html` 是 **stage 级**渲染器，会丢掉 station 里的 `features`（任务名不出现）。任务级视图目前只能用 `show --model project`；要在网页看任务，需给 `track_html.py` 加一节渲染 features。
- `track_render.py show` 不认 `--template`，会退回默认 7 阶段模板；用 `--model project` + `--template` 才对得上六泳道。
- PTC 账本是事件流，695 行**不得**逐条成站；只导根任务，且默认关闭。
- 导出不触碰源文件；`.scratch/` 在 SkillHub 仓库内且已被 .gitignore 忽略。
