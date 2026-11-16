# 把 superagent 的 lark-cli 切回 `cli_aa79ee689678dd03`（x1t-superagent）

## 先看结论：本机没坏，也没丢数据（2026-11-16 取证修正）

**`~\.lark-cli-superagent-aa79ee689678dd03` 在 aero17 上从未存在过**，不是被删除，也不是持久化失效。它是 **x1t-wang 那台机器**的 bot（`x1t-superagent`）配置目录；服务脚本在 2026-11-11 那次提交（`2e49924`）里把「优先用 zz79ee」连同 x1t 的文档一起同步进来，于是在本机每次启动都命中不了首选、静默回退到本机自己的 bot `cli_aa67e4041a381c02`（`aero17superagent-飞书bot`）。

取证依据：回收站无记录；PowerShell / Bash 历史无该目录与任何删除命令；`.dsh/backups` 全部快照无该目录名；`.dsh/logs` 无 `aa79ee` 痕迹；本机编排器库里 `aa79ee` **只作为消息发送者**出现（另一台机器的 bot 发进群），不是本机身份；该文档头写明核实对象是 x1t-wang 机器（用户目录下的 `src\dsh`）。

因此：**在 aero17 上使用 `aa67` 是正确的**。只有当你确实想让这台机器以 `x1t-superagent` 身份发言时，才需要下面的重建步骤（不推荐：两台机器共用同一应用会争抢事件订阅）。

### 已做的机制修复

| 问题 | 修复 |
|---|---|
| 设备路径写死在共享脚本 | 新增 `dsh-superagent-lark-bot.ps1`，解析顺序 `-LarkDir` → 设备层 `~/.dsh/device/superagent-lark.json` → 候选探测（含 appId 自检） |
| 静默回退、无提示 | 启动时打印 `lark-cli config dir = ... [appId=... via device-pin\|detected]` 与 `why:`；候选 appId 不匹配会 WARN |
| 本机选择散落在 Git | 已 `pin` 本机 bot 到设备层；换机只改 `~/.dsh/device/superagent-lark.json`，不动仓库 |

~~~powershell
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-lark-bot.ps1 -Action status
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-lark-bot.ps1 -Action pin -Dir "<目录>"
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-lark-bot.ps1 -Action unpin
~~~

## 现状（2026-11-16 核实）

| 项 | 值 |
|---|---|
| 首选目录 `~\.lark-cli-superagent-aa79ee689678dd03` | **本机从未存在**（属 x1t-wang 机器；非删除、非持久化失效） |
| 服务脚本回退 | `~/.lark-cli-hitl-aa67e4041a381c02`（`cli_aa67e4041a381c02`，aero17superagent-飞书bot） |
| 3082 实际运行 | pid 42844，API 自报 `appId=cli_aa67e4041a381c02`、`name=aero17superagent-飞书bot` |
| 回退 bot 可见群 | 仅 `oc_05b3ec7aa3adada8df5a2f31ffc7339f` |
| 编排器 feishu 源 CLI | `C:/nvm4w/nodejs/node_modules/@larksuite/cli/bin/lark-cli.exe`（存在） |
| 编排器 feishu 源 chats | `oc_05b3ec7aa3adada8df5a2f31ffc7339f`（**本机正确**：正是本机 bot 所在的「双 bot 交互」群；仅当改用 x1t 身份时才需改） |

> 原始接入记录见 [superagent-restore-20261110.md](superagent-restore-20261110.md) §10–§11（**x1t-wang 机器**的记录）：botId `ou_f2df78a2ad3d1b07ddd63e9b54347039`，工作群 `oc_f7d94fe2ae435cc1ac8f4cfec93d2ab9`，操作者 `ou_0b4357ab56c3b297407cf22219e22cb3`。

## 必须由人做的一步：在正确目录里 init 新 bot

> **本节只适用于「让本机改用 x1t 身份」这一条件分支。** aero17 现状已是正确状态（用 aa67），不改也不会坏。

凭据不能由代理代填。请在**自己的终端**执行（secret 只在 stdin，不进历史、不进对话）：

~~~powershell
$dir = "$env:USERPROFILE\.lark-cli-superagent-aa79ee689678dd03"
New-Item -ItemType Directory -Force $dir | Out-Null
$env:LARKSUITE_CLI_CONFIG_DIR = $dir
lark-cli config init --app-id cli_aa79ee689678dd03 --app-secret-stdin --brand feishu --force-init
# 等提示后粘贴 App Secret 并回车
~~~

- `--force-init`：当前终端若带 `OPENCLAW_HOME` / `HERMES_HOME`，不带此参数会被拒绝；
- 没有 App Secret 时改用 `lark-cli config init --new`（浏览器扫码新建应用，会阻塞并打印验证 URL）；
- 若报 `invalid_client` / app 不存在，说明该应用已在飞书后台被删除，只能新建应用后同步改目录名与脚本。

### 紧接着设 strict mode（否则保存 CLI 时被 400 拒绝）

~~~powershell
lark-cli config strict-mode bot
lark-cli config strict-mode        # 期望 strict-mode: bot
~~~

### 自查

~~~powershell
lark-cli config show               # appId 必须等于 cli_aa79ee689678dd03
lark-cli im +chat-list --as bot --page-size 50   # 记下 x1t-superagent 实际所在的群 chat_id
~~~

## 代理可以接着做的两步

1. **改编排器 feishu 源的 chats**：把 `sources.feishu.config.chats` 从回退 bot 的群改成第 3 步查到的真实群（否则新 bot 监听一个自己不在的群）；
2. **重启 3082 让它继承新目录**：

~~~powershell
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-service.ps1 stop
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-service.ps1 start
~~~

前置条件：`running=0`（无执行中回合），且没有 `dsh plugin` / `pnpm` 正在改写该 profile。

## 验收

| 检查 | 期望 |
|---|---|
| `dsh-superagent-service.ps1 status` | `setup: ok`，`health` 无 error |
| `GET /orchestrator/api/state` | `setup.accounts.feishu.appId = cli_aa79ee689678dd03`、`name = x1t-superagent` |
| service 启动日志 | `lark-cli config dir = <用户目录>\.lark-cli-superagent-aa79ee689678dd03`，且方括号内 `appId=cli_aa79ee689678dd03` |
| health `feishu` | `ready  Listening for bot events` |
| 真实收发 | 在工作群发一句话，`/sources` 的 `feishu.stats.received` +1 |

## 回滚

~~~powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.lark-cli-superagent-aa79ee689678dd03" -Recurse -Force
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-service.ps1 stop
pwsh -NoProfile -File D:\src\dsh\dsh-superagent-service.ps1 start   # 自动回退到 aa67
~~~

## 注意

- 回退 bot 只在一个群里有成员资格，切回后 **HITL 通道不受影响**（它用第三个 bot `feishu2`）；
- 本机还有第三个候选 `.lark-cli-dsh-superagent-new`（`cli_aa66fc2125f9dc14`），不在服务脚本的优先级里，不要混用；
- 目录名、`LARKSUITE_CLI_CONFIG_DIR`、编排器 chats 三者必须指向同一只 bot，任何一处不一致都会表现为 `not_configured` 或「消息收得到、回不出」。