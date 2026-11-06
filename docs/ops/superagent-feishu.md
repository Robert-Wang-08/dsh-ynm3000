# superagent 飞书通道：打通记录与验证手册

> 2026-11-06 实测打通并跑出第一张真实工单（PR #1）。本文件只记录**已验证事实**与可复现命令。

## 1. 现状（已验证）

| 项 | 值 |
|---|---|
| 机器人 | 「superagent-飞书bot」/ app `cli_aa67e4041a381c02` |
| 配置目录 | `~/.lark-cli-hitl-aa67e4041a381c02`（`strict-mode: bot`） |
| 私聊 chat_id | `oc_eae25b93a93612f82042deb68704e2af` |
| 操作者 open_id（app3 范围内） | `ou_fa4d5d4e4194d4708fcd2768052436e7` |
| 服务 | `dsh-superagent-service.ps1`，profile `superagent`，端口 3082 |
| Source 状态 | `feishu: ready` / `history: ready` / `github: off` |
| 仓库（deployment 检查硬要求） | `Robert-Wang-08/dsh-ynm3000`，`gh` CLI `C:/Program Files/GitHub CLI/gh.exe` |
| 默认模型 | `ais-2dsglm / deepseek-flash`（`agent-default-model`）；eval/executor 均为 `null` 继承它 |

## 2. 打通过程中修掉的四个真实缺陷（都由本机实测确认，不是推测）

1. **面板探针经 MSYS `env` 执行 CLI**：`env` 把参数 `/open-apis/bot/v3/info` 当 POSIX 路径改写 → `404 page not found`。
   - 修：`lib/poll-xx3wdCx6.js` 里 feishu 检查的 `run()` 去掉 `"env"` 前缀。
2. **GitHub Source 是硬要求**：`resolveDeployment` 无 catch（feishu 才有），仓库空即 `repositoryUnset`，把来源开关关掉也照样报。
   - 修：填仓库 + `gh` 路径（settings `source:github`）。
3. **orchestrator 会话 resume 失败**：`tools.restrict()` 名字里有 `bash`，本机 DSH 无 `bash` 全局工具 → `unknown global tool "bash"`，orchestrator 起不来，两个 source 永远 `pending`。
   - 修：`lib/index.js` 的 allow 列表按“工具实际存在”过滤。
4. **准入名单为空**：所有消息被判 `not_a_member` 静默丢弃。
   - 修：`policy.sources.feishu.allowed = [{ id: <操作者 open_id>, name: "Robert" }]`。

以上 1/3 是对 `node_modules/dsh-superagent` 的改写，**升级 dsh-superagent 会整目录替换、补丁丢失**。

补丁本体已收进仓库（唯一事实源，不放 node_modules）：

```powershell
pwsh -File docs\ops\patch-dsh-superagent.ps1                 # 校验（只读）
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply     # 打上缺失的补丁（幂等）
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode restore   # 回滚
```

详见 `docs/ops/dsh-superagent-patches/README.md`；打完要重启 3082。

## 3. 怎么验（关键教训：回信在**话题回复**里，不在私聊顶层）

`GET /open-apis/im/v1/messages` 用 `container_id_type=chat` **查不到话题回复**，必须用**线程 id**：

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-hitl-aa67e4041a381c02"
$exe = "C:\nvm4w\nodejs\node_modules\@larksuite\cli\bin\lark-cli.exe"
# 顶层私聊消息（只有用户消息）
& $exe api GET /open-apis/im/v1/messages --params '{"container_id_type":"chat","container_id":"oc_eae25b93a93612f82042deb68704e2af","page_size":20,"sort_type":"ByCreateTimeDesc"}'
# 话题回复（机器人的两条真在这里；thread_id 来自用户消息的 thread_id 字段）
& $exe api GET /open-apis/im/v1/messages --params '{"container_id_type":"thread","container_id":"omt_198816b45f0e5b43","page_size":20,"sort_type":"ByCreateTimeAsc"}'
```

实测结果（第一张工单 `<ticket-id>`）：

| 时间 | 来源 | message_id | 内容 |
|---|---|---|---|
| 17:31:41 | user | `om_x100b61eda91a1cb4cef47fa54643eb8` | 需求原文 |
| 17:31:51 | app | `om_x100b61eda6b7ccaccec910bbb5d58ac` | 「正在把 README.md 首行的…」 |
| 17:34:22 | app | `om_x100b61edbf2f64a0b098367ee18bbf3` | 完成 + PR #1 链接 + 需人工合并 |

## 4. 编排 API 速查（都需 `x-orchestrator-request: 1` 头，loopback）

```text
GET  /orchestrator/api/state         # setup.problem / health.*（runtime, feishu, history…）
GET  /orchestrator/api/sources       # enabled / state / stats.received
GET  /orchestrator/api/tickets       # 工单列表
GET  /orchestrator/api/tickets/:id   # 单个工单（summary / assignments / threads / directory）
GET  /orchestrator/api/decisions?window=1d&limit=5   # 为什么接/不接（reason.code = not_a_member / admission_ignored…）
GET  /orchestrator/api/models        # catalog.default 与角色模型
PUT  /orchestrator/api/settings/<block>  body={value, revision}   # block: policy / eval / executor / source:feishu / source:github
PUT  /orchestrator/api/prompts       body={config, baseRevision}
POST /orchestrator/api/setup/check   # 触发部署检查（会标 restarting）
```

## 5. 仍未完成

- PR #1 仍是 `OPEN`（`MERGEABLE`，+1/-1），等人工合并；github source 关闭时不侦测合并事件。
- 准入策略只有 `copy` / `visual` 两条规则，其它类型需求一律静默不接（设计如此）。
- `dsh-superagent` 升级会覆盖第 2 节的两处补丁，需重打或等上游修（MSYS env 路径改写 / `bash` 工具名）。
