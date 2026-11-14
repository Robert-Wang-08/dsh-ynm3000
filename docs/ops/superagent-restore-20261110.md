# superagent 备份恢复核实（2026-11-10）

> 核实对象：DSH 工作区 `C:\Users\wang\src\dsh` 下的 `dsh-superagent`（profile `superagent`，面板 `127.0.0.1:3082`）。
> 结论一句话：**插件本体与服务恢复了，superagent 自己的运行设置（GitHub 源、准入策略、执行目录）和飞书侧 CLI 根本没进过备份，所以看起来像"没恢复"。**

## 1. 判定依据

| 层 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- |
| profile 目录 | 有 `superagent` profile | `~/.dsh/profiles/superagent` 存在，含 `package.json`/`cordis.patch.yml`/`node_modules` | ✅ 已恢复 |
| 备份覆盖 | 备份里带 superagent profile | `dsh-backup-20261110-164007/profiles` = headless,packed,plugintest,**superagent**,web | ✅ 已进备份 |
| bundle 登记 | `dsh-superagent` 在 `dsh.profile.bundles` | 22 个 bundle，`dsh-superagent` 在 `dsh-config-pack` 之前 | ✅ |
| 服务进程 | 3082 在听 | pid 31984，端口 listening，`/orchestrator/api/state` 200 | ✅ |
| 运行补丁 | 三项 lib 补丁在位 | `runner.mjs --mode verify` → stateDir-windows-absolute / feishu-probe-no-msys-env / orchestrator-tools-existing-only 全 `applied` | ✅ |
| **superagent 设置** | GitHub 仓库、gh 路径、准入名单、执行目录 | `GET settings`：github source `repository:""`、`cli:""`；`policy.sources:{}`；`executor.directory:""` | ❌ **未恢复** |
| **飞书通道** | lark-cli + bot 配置目录 | `where.exe lark-cli` 找不到；`~/.lark-cli-hitl-aa67e4041a381c02`、`~/.lark-cli-dsh-superagent` 都不存在；无全局 `@larksuite/cli` | ❌ **本机完全缺失** |

## 2. 为什么"备份里没有"

- DSH 备份范围（工作区 `AGENTS.md` §5）：profiles 配置文件、`plugins/` 运行数据、`.agent-presets`、`device/`；**不含** `sessions/`、`attachments/`、`logs/`、`storages/`、`node_modules/`。
- 实测最新备份目录内容只有 `bundle.json` + `profiles/`，**没有 `state/`**。
- 而 dsh-superagent 的全部业务设置写在 `~/.dsh/state/superagent/orchestrator.sqlite`（经它自己的 `/orchestrator/api/settings` 读写），属于上面那个"不含"的区间。

所以：**superagent 的设置从来没被备份过，恢复备份也不会带回来**；只有 profile 与插件代码会被恢复。面板现在报 `setup.problem = github/repositoryUnset`（"The GitHub Source names no repository."），这是设置丢失的直接症状，不是插件故障。

## 3. 复现命令

```powershell
# 备份里有什么
Get-ChildItem "$env:USERPROFILE\.dsh\backups\dsh-backup-20261110-164007"

# 服务与设置现状（需要 x-orchestrator-request 头）
Invoke-WebRequest 'http://127.0.0.1:3082/orchestrator/api/state'    -Headers @{'x-orchestrator-request'='1'} -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:3082/orchestrator/api/settings' -Headers @{'x-orchestrator-request'='1'} -UseBasicParsing

# 补丁是否还在
node docs\ops\dsh-superagent-patches\runner.mjs --pkg C:\Users\wang\src\dsh\dsh-superagent --mode verify

# 飞书侧是否有东西
where.exe lark-cli
Test-Path "$env:USERPROFILE\.lark-cli-hitl-aa67e4041a381c02"
```

## 4. 三条要求的现状

| # | 要求 | 现状 | 缺口 |
| --- | --- | --- | --- |
| 1 | 恢复"护眼/背景色"浏览器底色 | DSH 客户端主题是**浏览器本地存储**（按 origin+端口区分），3082 是独立 origin；备份与恢复都碰不到它 | 需要确认颜色与施加方式（主题设置 vs 客户端插件 vs 浏览器侧） |
| 2 | 用飞书通讯 | Feishu source 在 bundle 里默认 `disabled: true`，profile patch 未启用；本机无 lark-cli、无 bot 配置目录 | 需装 lark-cli + 建/复用飞书应用凭证（只能操作者本人做）+ 启用 source + 填准入 open_id |
| 3 | GitHub 用 ynm3000 仓库 | github source 在，但 `repository` 为空；`gh` 2.96.0 已登录 `Robert-Wang-08` | 仓库名二选一：`Robert-Wang-08/dsh-ynm3000`（PUBLIC，历史打通记录用的就是它）或 `Robert-Wang-08/ynm3000`（PRIVATE） |

历史打通参数（机器人 app、chat_id、open_id、gh 路径）见 [superagent-feishu.md](superagent-feishu.md)，本文不重复抄写。

## 5. 下一步（等一次选择后一次执行）

1. 背景色：确认是"护眼底色（如豆沙绿 #C7EDCC）"还是 DSH 浅色/深色主题，以及允许的施加方式。
2. 飞书：`npm i -g @larksuite/cli` → `lark-cli config init --app-id ... --app-secret-stdin`（独立配置目录）→ 启用 `dsh-superagent-feishu` → 填 `policy.sources.feishu.allowed`。
3. GitHub：定仓库后 `PUT /orchestrator/api/settings/source:github`（`repository` + `cli`），随后 `POST /orchestrator/api/setup/check` 并读回 `state.setup.problem`。

> 本文事实来源：2026-11-10 本机实测（备份目录、`GET state`/`GET settings`、`runner.mjs --mode verify`、`where.exe`、`gh auth status`）。

## 6. 本次已落地的改动（同日 18:00–18:30）

| # | 改动 | 证据 |
| --- | --- | --- |
| 1 | GitHub 源：`repository = Robert-Wang-08/dsh-ynm3000`、`cli = C:/Program Files/GitHub CLI/gh.exe` | `PUT /settings/source:github` → `{"saved":true,"revision":1,"restarting":true}`；复读 `GET settings` 一致；`GET state` → `setup.problem = null`，`accounts = {"repository":"Robert-Wang-08/dsh-ynm3000","agent":"Robert-Wang-08"}`，`health.github = ready` |
| 2 | 准入名单：`policy.sources.github.allowed = [{"id":"Robert-Wang-08"}]` | `PUT /settings/policy` → `revision 1, policy_changed=true`；复读一致 |
| 3 | 护眼底色插件 `dsh-plugin-eye-care-bg` 0.1.0（纯客户端 CSS，覆盖 `--dsw-alias-bg-base` 与 `html/body` 底色为 `#C7EDCC`） | 装进 `superagent` profile（bundle #22，`dsh-config-pack` 仍最后）；`--dump-config` exit 0 含 `eye-care-bg`；重启后启动日志无 `did not activate`；`/plugins` 响应内含 `dsh-plugin-eye-care-bg` 与 `C7EDCC` |
| 4 | 飞书 CLI：`@larksuite/cli` 1.0.99 全局安装 | `lark-cli --version` → `1.0.99`；入口 `C:\Users\wang\AppData\Roaming\npm\lark-cli.cmd` |

两点实测提醒：

- `repositoryUnreadable`（`Get "https://api.github.com/repos/...": EOF`）是**代理抖动**，不是权限问题：同一仓库用 `gh api` 连测 3 次都正常，重跑 `POST /setup/check` 3 次即 `problem=null`。本机带 `HTTP_PROXY=http://127.0.0.1:7890`。
- 本版 policy schema 的 `allowed` 行**只接受 `id`**；写 `{"id":..,"name":..}` 会 400（`Unrecognized key: "name"`，见 `superagent-feishu.md` 旧记录里的写法已过期）。

## 7. 飞书：多机能否复用同一个 bot

- **凭证层可以复用**：`app_id`/`app_secret` 是租户级应用凭证，多台机器各自 `config init` 到独立配置目录没有冲突。
- **事件消费层不能复用**：superagent 用长连接消费 `im.message.receive_v1`（`src/sources/feishu-loops.ts` → `lark-cli event consume`）；同一个 app 的两条消费连接会**分走**消息，工单可能落到另一台机器上。

结论：**只有一台机器跑飞书时复用旧 bot（`cli_aa67e4041a381c02`）；两台都跑就必须新建 bot**，并把新 app_id 告诉我。

需要操作者本人执行（secret 不进对话、不落仓库）：

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-hitl-aa67e4041a381c02"
lark-cli config init --app-id cli_aa67e4041a381c02 --app-secret-stdin
lark-cli config strict-mode bot --global
Remove-Item Env:LARKSUITE_CLI_CONFIG_DIR
lark-cli auth status      # 看到 identities.bot.status = ready 即可
```

之后由主控接续（不需要再动手）：启用 `dsh-superagent-feishu`（profile patch `disabled: false`）→ `cli` 指向 `lark-cli.exe` 实体 → 重启 3082 → `POST /setup/check` → 查 chat id 与操作者 `open_id` → 写 `policy.sources.feishu.allowed`。

## 8. 风险与待决

- **agent 以 `@Robert-Wang-08` 动作**：`gh` 登录的是操作者账号，上游建议的是专用账号；要换成专用账号需另建账号 + `GH_CONFIG_DIR` 包装脚本，再改 GitHub 源的 `cli`。
- **主控模型越档**：本会话主控为 `ais-2dsglm/deepseek-flash`，不在 PTC 期望的 `codex-relay`/`openai-codex` 列表内（已登记 risk 事件）。
- **备份仍不含 superagent 设置**：`~/.dsh/state/` 不在 `dsh-backup.ps1` 范围内，下次恢复还会丢；如需保留，应另加一条把 `state/superagent/orchestrator.sqlite` 拷到 `private/` 的手工步骤（待定）。

## 9. 飞书来源已加入 Sources（2026-11-10 21:55）

做法：bundle 里 `dsh-superagent-feishu` 默认 `disabled: true`，在 profile patch 末尾显式打开（**只动 patch，不改 bundle**，升级 bundle 不丢）：

```yaml
- id: dsh-superagent-feishu
  disabled: false
```

- 改动前备份：`cordis.patch.yml.bak-before-feishu-source-20261110T184500`。
- 组合校验：`dsh --profile superagent --dump-config` exit 0，且该行显示
  `# == dsh-superagent, patched by ...\cordis.patch.yml` / `disabled: false`。
- 重启后 `GET /sources`：飞书 `installed=true, enabled=true, state=paused`，
  health `feishuCliUnset`（"The Source is on, and its bot lark-cli is not set"）+ `feishuBotMissing`；GitHub 仍 `ready`、按 60s 轮询。
- `setup.problem=null`、`setup.feishuProblem=null`：`cli` 为空时 `resolveFeishuBot` 直接返回 `undefined`，**不记问题、不影响 GitHub 源与 `paused()` 判定**（`paused() = !setup.configured() || settings.paused`，feishu 解析失败不会让 `configured()` 变假）。

飞书源的完整配置面（`GET settings` → `source:feishu`）：

| 字段 | 当前值 | 说明 |
| --- | --- | --- |
| `cli` | `""` | 智能体飞书 CLI；填 `C:/Users/wang/AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe` 后才会去探测 bot |
| `chats` | `[]` | 允许的群（空 = 不限定） |
| `directMessages` | `true` | 是否接收单聊 |
| `otherChats` | `none` | 其它群策略 |
| `readPageSize` / `linkTimeoutMs` | `20` / `5000` | 读历史与取链接 |

下一步只剩：操作者 `lark-cli config init` 输入 app secret → 主控把 `cli` 填上、`POST /setup/check`、写 `policy.sources.feishu.allowed`。

## 10. 换新 bot：`cli_aa79ee689678dd03`（2026-11-11 01:30）

操作者新建了飞书应用 `cli_aa79ee689678dd03`（旧 `cli_aa67e4041a381c02` 弃用）。本机已做的接线：

- 新建 bot 专用配置目录：`%USERPROFILE%\.lark-cli-superagent-aa79ee689678dd03`（当前为空，`config show` → `not_configured`）。
- `dsh-superagent-service.ps1` 的配置目录优先级改为：新目录 → `~/.lark-cli-hitl-aa67e4041a381c02` → `~/.lark-cli-dsh-superagent`（仍可用 `-LarkDir` 覆盖）。3082 已按新目录重启，`setup.problem=null`、`github=ready`、`feishu=paused`。

**飞书源「智能体的飞书 CLI」字段填什么**

```
C:/Users/wang/AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe
```

- 必须是**真 exe**：全局 `lark-cli.cmd` 在原生 spawn（无 shell）下起不来，裸 `lark-cli` 是 sh 脚本，两者都不能填。
- 光填路径还不够：CLI 读哪个 bot 由 `LARKSUITE_CLI_CONFIG_DIR` 决定，已由服务脚本钉到上面新目录；换 bot 只改这一处。
- 这台机器**还没有新 bot 的凭证**（旧目录里只有 `update-state.json`），所以必须先在新目录 init，否则填了也只有 `feishuNoApp`。

新 bot 还需要在开发者后台完成两项（否则连接能起、消息收不到）：

1. **事件订阅**改「使用长连接接收事件」，并订阅 `im.message.receive_v1`；
2. **权限**至少 `im:message`（读单聊/群消息）与 `im:message:send_as_bot`（以机器人身份发消息），改完**发布版本**；
3. 把机器人拉进要工作的群（或直接单聊它）。

## 11. 飞书通道打通（2026-11-11 03:0x，`cli_aa79ee689678dd03`）

最终生效配置（全部经 `GET /settings` 读回）：

| 项 | 值 |
| --- | --- |
| `source:feishu.cli` | `C:/Users/wang/AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe`（rev 1） |
| bot | `appId=cli_aa79ee689678dd03`、`botId=ou_f2df78a2ad3d1b07ddd63e9b54347039`、`name=x1t-superagent` |
| 操作者 | `ou_0b4357ab56c3b297407cf22219e22cb3`（robert） |
| `policy.sources.feishu.allowed` | `[{"id":"ou_0b4357ab56c3b297407cf22219e22cb3"}]`（policy rev 2） |
| 健康 | `runtime/relay/…/github/feishu/history` 全 `ready`；`setup.problem = null`、`feishuProblem = null` |
| 消费进程 | `lark-cli.exe event consume im.message.receive_v1 --as bot`（父进程 = 3082 service） |

### 两个必须记住的坑

1. **`strict mode` 必须是 bot**。只 `config init` 不够：保存 `cli` 时若 strict mode 为 `off`，面板直接 400 拒绝，
   `{"error":"The bot lark-cli allows user identities (strict mode off); give the bot its own lark-cli configuration in strict mode bot …","setup":{"place":"feishu","code":"feishuUserIdentity","values":{"mode":"off"}}}`。
   修法：`lark-cli config strict-mode bot --global`（view: `lark-cli config strict-mode` → `strict-mode: bot (source: global)`）。
2. **init 与运行的目录必须是同一个**。CLI 读哪个 bot 只由 `LARKSUITE_CLI_CONFIG_DIR` 决定；
   本机钉在 `%USERPROFILE%\.lark-cli-superagent-aa79ee689678dd03`，由 service 脚本注入子进程。
   目录不一致的表现就是一直 `not_configured` 或 `invalid_client`。

### 端到端验收结果（2026-11-11 03:22）

操作者在飞书群 `oc_f7d94fe2ae435cc1ac8f4cfec93d2ab9` 发了一句「是否在运行」，全链路跑通：

| 环节 | 观测值 |
| --- | --- |
| 来源接收 | `GET /sources` → `feishu.stats = {received:1, filtered:0, lastAt:2026-11-10T19:22:31.152Z}`；health `feishu:ready "Listening for bot events"`、`history:ready "Configured groups and known direct chats recovered"` |
| 漏斗 | `GET /overview` → `flow = {received:1, filtered:0, triggers:1, judged:1, accepted:0, evaluating:0, dropped:0}` |
| 判定 | `GET /decisions?window=24h` → `kind=ignore, reason.code=said, values.text="状态询问（是否在运行），不涉及具体改动请求，无需建工单。"`，thread `feishu:oc_f7d94…:om_x100…`，threadTitle「是否在运行」 |
| 工单 | `GET /tickets?state=all` → `0`（符合策略：只观察、不建单、不回话） |

结论：**入站链路（长连接 → 触发 → 判定）已验证**，策略按设计把纯状态询问判为 `ignore`。
要看到「工单 → 执行器 → PR」的完整闭环，需要发一条**明确的改动请求**（例：`把 README 里 XX 这段的错别字改一下` 或 `给 docs/ops 加一份 foo.md 说明`）。

