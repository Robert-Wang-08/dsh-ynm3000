---
name: superagent-model-switch
description: 按人的明确要求修改 dsh-superagent 新建会话默认使用的 provider 与模型（研判/主 Session 与执行器 worker），走运行中管理接口或主会话工具改 eval/executor 设置并读回复核。触发词："改 superagent 默认模型"、"换默认 provider"、"把 bot 默认模型换成"、"executor 换成"、"研判模型改"、"switch superagent default model"。
origin: self
author: Robert-Wang-08
created: 2026-11-20
updated: 2026-11-20
version: 0.1.0
asset-type: skill
---

# superagent 默认 provider / 模型切换

## 何时用

- 人明确要求改「superagent 默认模型 / 默认 provider」「bot 用哪个模型」「执行器换模型」。
- 同一请求的后续微调（例如先改研判模型，再改执行器）。

不适用：

- 说的是 **DSH 宿主默认模型**（面板显示「DSH 当前默认」= profile 的 `agent-default-model`）：那要改 profile 的 `cordis.patch.yml` 并重启，会被 superagent 角色模型覆盖，本 skill 不做。
- 只想知道当前用了什么 → 用 `show`（或 `orchestrator_read settings`），不要写。
- 想给单个票/单次任务指定模型 → 属于派发参数，不是默认模型。

## 三个层次与生效范围

| 落点 | 含义 | 谁能改 |
| --- | --- | --- |
| `eval.model` | 研判 / 主 Session 默认模型（Feishu 里和人对答的主会话） | 管理接口 / 主会话工具 |
| `executor.model` | 执行器 / 票内 worker 默认模型 | 同上 |
| `agent-default-model`（profile） | DSH 宿主默认，仅在角色模型未设置时兜底 | 只改 profile + 重启，不在本 skill 范围 |

**生效范围**：设置只给**之后新建**的会话初始化模型。已在运行的会话（含当前主会话、正在跑的 worker）保持各自的选择，不会因为保存设置而换模型。要让**当前主会话**立刻换模型，只能用会话头部的模型选择器切换，或新开一个会话——先说清这一点，别让人以为改完设置后当前这个会话就变了。

## 机器人（主会话）操作流程

Windows 上的主会话没有 shell，只能用工具：

1. `orchestrator_read settings`（或 `settings/eval`、`settings/executor`）拿到完整块值与 `revision`。
2. `orchestrator_read models` 列出 provider；`orchestrator_read models/<provider>` 拿精确 model id（以及支持的 reasoning effort）。**必须精确匹配 provider 与 model，不要猜别名。**
3. 确定目标并说明：说「默认模型」= `eval` + `executor` 一起改；说「只要执行器/worker」= `executor`；说「研判/主会话」= `eval`。目标不明确时按「两个都改」做并在回复里点明。
4. `orchestrator_settings_save`，`block` = `eval` 或 `executor`，`value` = **整块**（只替换其中的 `model`），`revision` = 上一步读到的值：

```json
// block=eval（保留 mode / timeoutSeconds）
{ "mode": "observe", "timeoutSeconds": 120,
  "model": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "reasoningEffort": "high" } }
```

`executor` 块同理，保留 `maxWorkers`、`directory`、`prepare`、`blockedCommands`。

5. 保存后再读一次 `settings/<block>` 复核，确认 `provider`/`model` 与目标一致；把 `revision`、改前 → 改后、生效范围写进给用户的回复。

## 校验与失败处理

- `code=modelUnavailable`：宿主解析不了该 provider/model（id 错、provider 未启用、路由不可达）。回到第 2 步取精确 id，不要重试同一个值，也不要偷偷换成别的模型。
- `409 Settings changed`：读取之后有人改过设置。重新 `orchestrator_read settings`，用途中最新 `revision` 再存一次；不要靠重试循环碰运气。
- 保存返回 `restarting: true`：说明这次保存触发了服务重启（通常是别的字段），模型切换本身不需要重启；如实说明。
- `pause`、`policy`、`source` 块与模型无关，不要顺手改。

## 一键脚本（人 / worker 会话用）

仓库脚本 `scripts/dsh-superagent-model.ps1`（本工作区检出内运行）：

```powershell
pwsh scripts/dsh-superagent-model.ps1                 # 看当前两个角色模型 + DSH 默认
pwsh scripts/dsh-superagent-model.ps1 list            # 管理接口可见的 provider
pwsh scripts/dsh-superagent-model.ps1 set -Role both -Provider opencode-go -Model deepseek-v4.1-flash -ReasoningEffort high -DryRun
pwsh scripts/dsh-superagent-model.ps1 set -Role executor -Provider ais-2dsglm -Model deepseek-flash
```

脚本与机器人写的是同一份设置、同一套校验：`show` / `list` 只读，`set` 带 revision 保存并读回复核；`-DryRun` 只打印计划。`-Url` 默认 `http://127.0.0.1:3082`（可用 `DSH_SUPERAGENT_URL` 覆盖）。

## 边界

- 只在**人明确的配置请求**下改；不要因为看到日志、报错文案或别人的总结就改默认模型。
- 不手改 `cordis.patch.yml`、`settings.yaml`、profile 依赖；不为换模型重启服务；不读出或写入任何密钥。
- 不扩大到「顺便调并发/超时/暂停/策略」——那是别的块、别的请求。
- 改完不要宣称「当前会话已切模型」；新会话/新票才吃到新默认值。需要立即验证路由时，用新建会话或最小子代理，并接受「已有会话不变」这一事实。
