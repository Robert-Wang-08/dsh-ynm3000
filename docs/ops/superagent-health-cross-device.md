# Superagent 健康报告：换一台设备部署

本文只讲一件事：**另一台设备怎样把这套「Superagent 定期健康报告」独立跑起来**。报告的行为、参数细节和已有部署的回滚见 [健康报告操作手册](superagent-health-report.md)。

## 这套机制是什么

- 它是本仓库里的**脚本服务**（`tools/superagent_health/`），不是 DSH 插件：不改 profile、不重启宿主。
- 每台设备读取**本机**的 superagent 管理接口和本机 DSH 会话事件，生成健康报告。
- 需要发送时，通过**本机** `lark-cli` 的 bot 身份投递。
- 采集由**本机 Windows 计划任务**每分钟触发一次。

所以换设备不是“把一份配置同步过去”，而是**在新设备上独立初始化一套**：代码从 Git 拿，其余都在本机生成。

## 每台设备各管各的

| 内容 | 位置 | 是否跨设备同步 |
|---|---|---|
| 服务代码 | 本仓库 `tools/superagent_health/` | 是，更新仓库即得 |
| 设备配置 | `%USERPROFILE%\.dsh\device\superagent-health\config.json` | 否 |
| 收件人与 CLI 指针 | 同目录 `binding.env.json`（仅发送需要） | 否 |
| 运行状态 | 设备配置的 `state_dir`；默认 `%USERPROFILE%\.dsh\state\superagent-health\`（`health.sqlite`、`latest.md`、`heartbeat.json`），可指向同步盘的 `个人数据\superagent-health\<设备名>` | 按配置：默认否；指向同步盘时有云端副本，但仍只归该设备使用 |
| 计划任务 | `DSH-Superagent-Health` | 否 |

不要把另一台设备的绝对路径、`binding.env.json`、`health.sqlite` 或 lark-cli 登录态拷过来：绑定哈希和去重水位都对不上。两台设备也不得共用同一 `state_dir`（即使指向同一同步盘）；要换目录用 `migrate-state`，不要手工搬库。

## 前提

先在仓库根目录确认（示例路径按本机实际替换）：

```powershell
git -C D:\src\dsh pull --ff-only          # 或按本机 gitsync 流程快进到最新 main
Test-Path D:\src\dsh\tools\superagent_health\manage.ps1   # 必须为 True
python --version                          # 3.10+
zstd --version                            # 或在下一步用 PTC_ZSTD 指定绝对路径
```

还需要：

- `session-summary` 技能已安装。默认读取 `%USERPROFILE%\.agents\skills\session-summary\scripts\extract.py`；不在默认位置时，在 `config.json` 里设 `extractor_path`。
- 只有需要**自动发送**时才要 `lark-cli`：本机已用目标 bot 身份登录，且 `lark-cli im +messages-send --help` 支持 `--idempotency-key`。

## 第一步：生成本机配置

在仓库根目录执行：

```powershell
pwsh tools/superagent_health/manage.ps1 init
```

它把 `config.example.json` 复制成 `%USERPROFILE%\.dsh\device\superagent-health\config.json`，发送默认关闭。配置已存在时**拒绝覆盖**，这是有意的。

打开配置，重点核对下面几项（`delivery` 块保持 init 生成的原样，到发送那一步再改）：

```json
{
  "instances": [
    { "id": "superagent", "url": "http://127.0.0.1:3082" }
  ],
  "dashboard_urls": ["http://127.0.0.1:3083"],
  "schedule_hours": [9, 11, 13, 15, 17, 19],
  "daily_time": "21:05",
  "quiet_hours": [22, 8],
  "interval_seconds": 60,
  "attention_settle_seconds": 900,
  "delivery": {
    "enabled": false,
    "identity": "bot",
    "recipient_env": "DSH_HEALTH_CHAT_ID",
    "cli_env": "DSH_HEALTH_LARK_CLI",
    "config_dir_env": "DSH_HEALTH_LARK_CONFIG_DIR",
    "binding_confirmed": false,
    "content_policy": "redacted_health_report_v1"
  }
}
```

- `instances` 必填，`id` 不能重复，`url` 只接受本机回环 HTTP 地址；实例名、端口按本机 superagent 实际部署写。
- 样例配置默认带 `superagent:3082` 和 `sa-local:3083` 两个**参考实例**。本机没有的实例要删掉或改成本机真实端口，否则报告会一直显示不存在的实例不可采集。
- `dashboard_urls` 可选；本机没有对应 dashboard 就删掉或改地址。拿不到认证时会显式降级，不会伪造金额。
- 设备相关路径可用 `home`、`state_dir`、`extractor_path` 覆盖；不写就取默认值。
- 这份配置是**设备层**数据，不进 Git，也不要写任何密钥。

## 第二步：跑一次 dry-run

```powershell
cd D:\src\dsh
python -m unittest discover -s tools/superagent_health -p test_health.py -v
python tools/superagent_health/service.py dry-run --config "$env:USERPROFILE\.dsh\device\superagent-health\config.json"
```

dry-run 只生成本地快照，不排队、不发消息。检查：

```powershell
Get-Content "$env:USERPROFILE\.dsh\state\superagent-health\latest.md" -TotalCount 30
Get-Content "$env:USERPROFILE\.dsh\state\superagent-health\heartbeat.json" -Raw
```

`latest.md` 应包含本机实例和采集时间；`heartbeat.json` 的 `mode` 为 `dry-run`。如果接口暂时不可达，报告会明确显示不可采集，但这一步仍能证明采集链路已经跑通。

> 上面的检查命令写的是默认状态目录；配置里改过 `state_dir`（例如迁到同步盘）就换成该目录，下文同类命令同理。

> 手动直接跑 `service.py` 时，`binding.env.json` 不会自动加载；如果 zstd 不在 `PATH`，先设 `$env:PTC_ZSTD`。走 `run.ps1` 或计划任务时才会读取绑定文件。

## 第三步：安装采集任务（先不发送）

```powershell
pwsh tools/superagent_health/manage.ps1 install
pwsh tools/superagent_health/manage.ps1 start
pwsh tools/superagent_health/manage.ps1 status
```

`install` 注册计划任务 `DSH-Superagent-Health`，每分钟一次，经隐藏窗口启动，`IgnoreNew` 与进程文件锁共同防重叠；同名任务已存在时拒绝替换。`status` 看 `State` 和 `LastTaskResult`。

要把运行状态放在同步盘（本机目录重建后仍保留去重水位和投递证据），用迁移命令，不要手工复制 SQLite 文件：

~~~powershell
pwsh tools/superagent_health/manage.ps1 migrate-state -TargetStateDir "D:\nutstore\Skill+Tool\skillhub\个人数据\superagent-health\AERO17"
~~~

它先停采集任务，用 SQLite backup API 取一致快照，复制并校验其余快照文件与 outbox 计数，改写设备配置 `state_dir`，旧目录改名留档，最后恢复任务；失败时旧目录、配置与任务状态不动。目录名带本设备名，另一台设备用各自的子目录。`state_dir` 仍是设备层配置，不进 Git。

约两分钟后验证：

```powershell
Get-Content "$env:USERPROFILE\.dsh\state\superagent-health\heartbeat.json" -Raw
python tools/superagent_health/service.py status --config "$env:USERPROFILE\.dsh\device\superagent-health\config.json"
```

此时 `heartbeat.at` 应在两分钟以内，`mode` 为 `dry-run`，`configSendingEnabled` 和 `bindingConfirmed` 都应为 `false`，outbox 为空。

## 第四步（可选）：绑定收件人并启用发送

发送前必须先向管理人核实三件事：**目标私聊/群、用哪个 bot 身份、允许发送的内容是脱敏健康报告**。核实后：

1. 在配置同目录新建 `binding.env.json`，只允许以下四个键（`PTC_ZSTD` 可省略）：

```json
{
  "DSH_HEALTH_CHAT_ID": "oc_由管理人确认的目标",
  "DSH_HEALTH_LARK_CLI": "本机 lark-cli.exe 的绝对路径",
  "DSH_HEALTH_LARK_CONFIG_DIR": "现有 bot 登录配置目录，不要复制凭据",
  "PTC_ZSTD": "可选，本机 zstd 绝对路径"
}
```

2. 把 `config.json` 的 `delivery.enabled` 和 `delivery.binding_confirmed` 改为 `true`，保持 `identity: "bot"` 与 `content_policy: "redacted_health_report_v1"` 不变。

3. 先做一次真实投递验证：

```powershell
pwsh tools/superagent_health/run.ps1 -Config "$env:USERPROFILE\.dsh\device\superagent-health\config.json" -AllowSend
```

确认管理人收到、内容符合预期后，把计划任务换成发送模式：

```powershell
pwsh tools/superagent_health/manage.ps1 stop
pwsh tools/superagent_health/manage.ps1 uninstall
pwsh tools/superagent_health/manage.ps1 install -AllowSend
pwsh tools/superagent_health/manage.ps1 start
```

`manage.ps1 install -AllowSend` 只有在 `delivery.enabled` 与 `binding_confirmed` 都为 `true` 时才允许执行。切换后验证 `heartbeat.json` 的 `mode` 为 `send_enabled`，确认刚才的样报在 outbox 已记为 `channel_accepted`；再等到下一个简报时点（9/11/13/15/17/19 点）或 21:05 日报，确认定时任务正常投递。

> 发送走 `lark-cli im +messages-send --markdown`，正文经 stdin 传入。只有拿到 `message_id` 才算渠道接受，排队成功不等于送达。深夜静默期（默认 22–08 点）不投递普通消息，严重失联告警可绕过。

## 验收清单

- [ ] `manage.ps1 status` 显示 `DSH-Superagent-Health` 为 `Ready`，`LastTaskResult` 为 0。
- [ ] `heartbeat.json` 的 `at` 在两分钟以内，模式与本阶段一致（`dry-run` 或 `send_enabled`）。
- [ ] `latest.md` 包含本机目标实例、采集时间，以及明确的缺失项标注。
- [ ] 不发送阶段 outbox 为空；发送阶段简报后出现 `channel_accepted`。
- [ ] 启用发送前，管理人已确认收件人、bot 身份和脱敏内容，并实际收到一条样报。
- [ ] 次日 09:00 后能收到前一自然日闭账（或 outbox 明确显示待投递）。
- [ ] `config.json`、`binding.env.json` 和 Git 变更里都没有凭据。
- [ ] 状态目录指到同步盘时带本设备名子目录，没有第二台设备共用同一 `state_dir`；`status` 读到的 outbox 计数在迁移前后一致。

## 停用与回滚

```powershell
pwsh tools/superagent_health/manage.ps1 stop
pwsh tools/superagent_health/manage.ps1 uninstall
```

停止并注销任务即可，不删除 `health.sqlite`：它保存去重、水位和未知投递证据。换收件人后要重新核实并让旧绑定失效，旧队列会因绑定哈希不符进入 `needs_attention`，不能把旧正文直接重发给新收件人。

## 已知边界

- 单机任务无法在整机断电/离线时发出自身失联告警；要检测整机离线，需要另一台设备做外部 watchdog。
- dashboard 用量仍可能因认证或数据契约缺失显示 `unavailable`；不读取凭据绕过，也不填零。
- 会话事件覆盖限于已关联的 master/工单 worker；嵌套子会话和外部 ACP 不宣称完整覆盖。
- 报告和快照包含工单标题/摘要及本地缓存路径，属于私有运行数据；只发给已核实的收件人，不提交、不公开分享。

## 相关文件

- [健康报告操作手册](superagent-health-report.md)：已实现行为、绑定细节、定时与回滚。
- [服务入口](../../tools/superagent_health/service.py)、[任务管理](../../tools/superagent_health/manage.ps1)、[配置样例](../../tools/superagent_health/config.example.json)。
- [README 的健康报告一节](../../README.md#superagent-定期健康报告)。
