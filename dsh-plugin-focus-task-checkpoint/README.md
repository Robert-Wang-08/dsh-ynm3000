# dsh-plugin-focus-task-checkpoint

DSH 宿主钩子插件：在一轮结束（`turn/end`）且动作清单（`todo/write`）相对上次成功提交有变化时，
把差异组装成一条 Focus Hub 检查点，调用 skill `focus-task` 的 `scripts/submit.mjs` 提交。

配套 skill 是 `focus-task`（SkillHub 注册，供人工/任意 agent 按里程碑显式提交）；本插件只负责
DSH 会话的自动提交，不创建任务，也不代表人工验收。

## 行为

| 条件 | 行为 |
| --- | --- |
| `turn/end` 且清单指纹与上次成功提交不同 | 生成检查点并提交；成功后记录 revision、指纹与事件序号 |
| 子代理会话（`origin=subagent` 或 `delegationDepth>0`） | 跳过 |
| 工作目录没有 `.focus-hub.json` 的非空 `projectId` | 跳过（只记 info 日志） |
| 清单未变化 | 不新增建议（避免重复） |
| Focus Hub API 不可达 | 由 `submit.mjs` 写入 `~/.focus-hub/outbox/<sessionId>.ndjson`，插件不另写队列 |
| 提交脚本找不到 | 插件只告警一次并跳过；不会伪造提交 |

提交者固定为 `agent:dsh-hook`，检查点 `track` 仍由 `submit.mjs` 写成 `agent-claimed`。

## 安装

插件本体在本仓库，skill 本体在 SkillHub store。先部署 skill，再登记插件：

```powershell
# 1) skill 部署到 DSH 用户级 skill 根（插件默认从 ~/.dsh/skills/focus-task/scripts/submit.mjs 解析提交脚本）
skillhub deploy focus-task --to dsh

# 2) 插件登记到 profile（补丁层排在最后，按 AGENTS.md 的安装闸门执行）
dsh plugin --profile <profile> add D:\src\dsh\dsh-plugin-focus-task-checkpoint
```

包内补丁会插入：

```yaml
- insert:
    - id: focus-task-checkpoint
      name: '@local/dsh-plugin-focus-task-checkpoint'
      config: {}
```

替换已安装的 JavaScript 需要重启对应 DSH profile 后才会加载新模块；有活动会话时先征得同意再重启。

## 配置

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `FOCUS_HUB_BASE_URL` | `http://127.0.0.1:8770` | Focus Hub API 地址 |
| `FOCUS_HUB_SUBMIT_SCRIPT` | 空 | 提交脚本绝对路径；优先于默认解析 |
| `FOCUS_HUB_STATE_DIR` | `%USERPROFILE%\.focus-hub` | 指纹/序号状态目录 |
| 插件配置 `submitScript` | 空 | 与 `FOCUS_HUB_SUBMIT_SCRIPT` 同义，优先级最高 |

提交脚本解析顺序：

1. 插件配置 `submitScript`；
2. `FOCUS_HUB_SUBMIT_SCRIPT`；
3. `~/.dsh/skills/focus-task/scripts/submit.mjs`（`skillhub deploy focus-task --to dsh` 的落点）；
4. `../scripts/submit.mjs`（旧版「插件放在 skill 目录 `dsh/` 下」的布局，仅兼容）。

## 测试

```powershell
node test/submit-script.mjs
```

## 验收

1. 在含 `.focus-hub.json` 的仓库里跑一轮会改动作清单的 DSH 会话。
2. 该轮 `turn/end` 后，`GET <base-url>/api/suggestions?status=pending` 增加一条 `proposer=agent:dsh-hook`。
3. 同一清单再结束一轮，不新增建议。
4. 子代理会话不新增建议。

## 已知限制

- Focus Hub API 需在本机运行（默认 8770）；不可达时只落 outbox，不重试投递。
- 插件只提交「清单差异」，不做语义判断；检查点始终是 agent 声称、待人工审阅的证据。
