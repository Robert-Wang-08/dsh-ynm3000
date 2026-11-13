# sa-local profile（本地 fork，与 web 同能力）

> 2026-11-05：把 web profile 的 **provider/模型** 与 **全部插件与配置** 复制进 `sa-local`，保留本地 fork `dsh-superagent`（`local-watch`）。
> 说明：`superagent`（3082）在更早已按同一来源完成同样集成，本次只是核对（见文末）。

## 1. 为什么有这个 profile

`sa-local` 是 A′ 验证环境（本地 fork：操作者在工作区主会话发需求 → Trigger → Ticket → Worker 执行）。之后按用户要求把它升级成**与 web 能力一致**的 profile：同样的模型 provider、同样的插件集、同样的设置，但**端口与状态目录独立**。

## 2. 本次复制了什么

| 来源 | 内容 |
| --- | --- |
| live `web` profile 的 `package.json` | 27 个依赖（含 `@local/*` link、`dshmarket`、`dsh-worktable` vendor tgz、`dsh-taskboard` 等） |
| 同上 `dsh.profile.bundles` | 26 个 bundle，按原顺序；末尾追加 fork 的 `dsh-superagent` |
| live `web` 的 `cordis.patch.yml` | 整份（provider 地图、默认模型、MCP、ACP 三档、PTC、director、palette、taskboard、embedded-browser、wechat-hitl 等） |
| live `web` 的 `vendor/`、`patches/`、`compatibility.json`、`pnpm-lock.yaml` | 安装输入，保证版本与 web 一致 |
| `web` 的 `node_modules/dsh-wechat-hitl` | 目录型插件（不在 package.json 里），复制后 patch 里那条 insert 才能解析 |

关于「前天的一键备份」：`~/.dsh/backups/dsh-backup-20261103-153841` 的 web 快照是 **live web 的严格子集**（依赖 26 vs 27、bundle 25 vs 26，唯一缺的是 `dsh-taskboard`）。所以本次以 **live web** 为准——用备份只会少一个插件；若确实要严格复刻备份，把 `dsh-taskboard` 从依赖与 bundle 里删掉即可。

## 3. 与 web / superagent 的差异

| 项 | web (3080) | superagent (3082) | sa-local (3083) |
| --- | --- | --- | --- |
| profile 用途 | 日常工作 | 上游 dsh-superagent 服务 | 本地 fork（操作者工作流） |
| 端口 | 3080 | 3082 | **3083** |
| 额外 bundle | — | 上游 `dsh-superagent` | fork `dsh-superagent`（含 `local-watch`） |
| stateDir | — | `~/.dsh/state/superagent` | `~/.dsh/state/sa-local` |
| 内嵌浏览器 Chrome 目录 | `embedded-browser/profile` | `profile-superagent` | `profile-sa-local` |
| wechat-hitl | 启用 | 关闭 | **关闭** |
| 默认模型 | `ais-2dsglm/deepseek-flash` | 同上 | 同上 |

## 4. 验证证据（2026-11-05）

- `dsh --profile sa-local --dump-config`：**exit 0，509 条目**，`port: 3083` 命中 1，`profileDir …/profile-sa-local` 生效，`wechat-hitl` 段 `disabled: true`，provider displayName **7 个**（AIS 2DSGLM / Codex Relay / Kimi Coding / OpenCode Go / Claudesubrouter / claudetokeniss / gpt（official））
- `GET /orchestrator/api/state`：**200**，`setup.problem = none`，health 全 ready（github/feishu/history 按设计 paused）
- `GET /orchestrator/api/sources`：`dsh:ready`（`received: 1`）、`feishu:paused`、`github:paused`
- `GET /orchestrator/api/master?workspace=0636fa95…`：200，`orchestrator-9ae3…`（A′ 用的那条主会话仍在）
- 启动日志无 `did not activate`；仅有继承自 web 的 `codegraph --mcp` 重复参数报错（已知，不影响）
- 凭据：`.credentials.yaml` 中 `AIS_2DSGLM_API_KEY` / `LLMKEY_KIMI` / `OPENCODE_API_KEY` / `CLAUDE_RELAY_TOKEN` 存在（只查名字，未读值）

## 5. 启停（官方入口：`dsh-sa-local-service.ps1`）

```powershell
pwsh -File dsh-sa-local-service.ps1 status   # pid / 端口 / 补丁 / URL / setup / sources
pwsh -File dsh-sa-local-service.ps1 start    # 注入飞书配置目录、清理残留锁、启动并等端口
pwsh -File dsh-sa-local-service.ps1 stop     # 停进程（按 pidfile，缺失时按端口找）+ 清锁
pwsh -File dsh-sa-local-service.ps1 url      # 只打印带 token 的面板地址
pwsh -File dsh-sa-local-service.ps1 logs     # 最近两份日志尾部
```

- 启动时会设 `LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli-dsh-superagent-feishu2`，飞书机器人身份来自这里；
- 启动时会检查 **win32 CLI 探测补丁**，缺失就提示先跑 `dsh-sa-local-feishu-patch.ps1`；
- 停止会清理 `~/.dsh/state/sa-local.lock`（proper-lockfile 的同步锁，不清理下次启动会报 `Lock file is already being held`）；
- `start` 会顺带拉起飞书推送器（`dsh-sa-local-notify.ps1 start`），`stop` 会先停它；`status` 里 `notify : pid …` 就是它。

面板 URL 在 `status` 里直接给出（服务启动日志的 `dsh web:` 行）。A′ 的入口是侧栏工作区行的「主会话」按钮（DOM 注入，自动化不可见，需人工点）。
## 6. 回滚

```powershell
Stop-Process -Id <pid> -Force
# 本次同步前的备份：
Get-ChildItem "$env:USERPROFILE\.dsh\backups\salocal-pre-web-integration-*" | Sort-Object Name -Descending | Select-Object -First 1
# 用备份里的 profiles/sa-local/* 覆盖回 profile 目录，再在 profile 内 pnpm install
```

## 7. 已知风险

1. **共享存储**：`dsh-taskboard`、`dsh-provider-failover` 的 settings/数据在 `~/.dsh` 下共享，3080/3082/3083 三个进程同时写同一份文件存在竞争可能（taskboard 按工作区存，风险低但不为零）。
2. **同一模型配额**：三个 profile 默认走 `ais-2dsglm/deepseek-flash`，并发时会抢同一路 key。
3. **第三方研究分支**：fork（0 star）在该 profile 内以 danger-full-access 运行，不要并入生产 profile；升级要重新取 tgz 并重跑安装。
4. 本 profile 未装 `dsh-plugin-superagent-appearance`（护眼绿只属于 3082），需要时按 `dsh-plugin-superagent-appearance` 的说明挂载。

## 8. 飞书渠道（2026-11-05 打通，端到端已验证）

| 项 | 值 |
| --- | --- |
| 应用 | `cli_aa66f315697adc03`（机器人「robert的飞书 CLI」），在**飞书账号**下创建 |
| bot open_id | `ou_28a5c26fc02a1102603903062ba238fc` |
| 配置目录 | `C:\Users\wwm_1\.lark-cli-dsh-superagent-feishu2`（strict-mode `bot`） |
| Source | `settings/source:feishu` 的 `cli` 指向原生 `C:\nvm4w\nodejs\node_modules\@larksuite\cli\bin\lark-cli.exe`；私聊开启、群聊仅 @ |
| 白名单 | `policy.sources.feishu.allowed` 含操作者 `ou_394e…b298` |

端到端证据：飞书私聊「在这条工作区新建文件 feishu-demo.txt，内容是 hello feishu」→ trigger（09:49:40）→ decision accept → ticket `76353487e99f…`（assignment ended）→ outbox 确认+回信均 `sent` → 文件 `stateDir/work/add-feishu-demo-file-76353487e99f/feishu-demo.txt`（13 字节，`hello feishu`）。

### 两个必须记住的坑

1. **不要用豆包账号建应用**：`open.feishu.cn` 里用豆包账号创建的应用会带「正式应用@豆包账号」标记，IM/Bot API 一律返回 `21001 policy/access_denied`（scope 全开、版本已发布也没用）。必须用**飞书账号**登录再建。
2. **Windows 上上游的 CLI 探测走 POSIX `env`**：`workerProbe` 会拼 `env PATH=... env VAR=... cli ...`，Windows 没有可用的 POSIX env（Git 的 `env.exe` 又不认 Windows 路径），setup 必然报 `env: 'env': No such file or directory`。已在安装产物里打补丁（见下）。

### 已打的本地补丁（重装后需重打）

文件：`~/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/poll-*.js`

- `workerProbe`：`process.platform === 'win32'` 时直接 `runAsWorker(subprocess, argv, …)`，不加 `env PATH=` 前缀；
- `resolveFeishuBot` 的 `run`：win32 时直接 `probe([cli, ...args])`，并把 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER/NO_SKILLS_NOTIFIER` 写进 `process.env`。

重装 fork（换 tgz）会覆盖这两处，需要按同样思路重打；长期方案是给 fork 提交一个平台判断补丁并重新 `pnpm pack`。

## 9. 飞书通知推送（工单完成 / 结束 / 需要人处理）

飞书回信只在「请求来自飞书」时到原会话；本机来源的工单以前没有任何外部提示。为此加了一个独立的推送器：

| 文件 | 作用 |
| --- | --- |
| `dsh-sa-local-feishu-notify.mjs` | 轮询 `orchestrator.sqlite`（只读），按规则推送到飞书私聊 |
| `dsh-sa-local-notify.ps1` | `start/stop/status/logs`，pidfile 与日志在 profile 的 `.artifacts/` |

判定规则（只读数据库，不改任何数据）：

| 信号 | 触发条件 | 文案 |
| --- | --- | --- |
| 工单完成 | `ticket.ended.outcome === 'completed'` 且此前未推过 | `✅ 工单完成：<标题> [<id8>]` + 结果/耗时/目录 |
| 结束但非完成 | `ticket.ended` 且 outcome 非 completed | `❌ 工单结束：…` |
| 需要人处理 | 未结束且 `inputs` 数量增加（消息在等执行器） | `⚠️ 需要你处理：…有 N 条消息等待执行器` |

机制：

- 首次启动**只记基线不推送**（避免把历史工单全推一遍）；
- 游标 `~/.dsh/state/sa-local/notify-cursor.json` 记录已推过的 ticket id 与 inputs 计数，重复启动不会重复推；
- 发送走 `lark-cli im +messages-send --as bot`，配置目录与机器人配置同源（strict-mode bot）；
- `--dry-run` 只打印不发送；`--test` 发一条自检消息；`--once` 单轮。

```powershell
pwsh -File dsh-sa-local-notify.ps1 status
pwsh -File dsh-sa-local-notify.ps1 start    # 当前 pid 11368
pwsh -File dsh-sa-local-notify.ps1 stop
node dsh-sa-local-feishu-notify.mjs --once --dry-run   # 看一眼会推什么
```

限制：

- 「需要审批」目前是用 `inputs` 待处理近似的，不是飞书审批流；要真正接审批，应改成读 assignment 报告或接 DSH 的 approval 事件；
- 只覆盖 sa-local（3083）；3082（上游）仍受 GitHub 前置限制；
- 推送器已挂进 `dsh-sa-local-service.ps1` 的 start/stop；单独调试时也可以直接 `notify.ps1 start|stop|status`。