# Superagent 默认模型切换（2026-11-20）

目标：一条命令（或飞书里一句话）把 dsh-superagent **新建会话**默认使用的 provider / 模型切过去，不改 profile、不重启服务。

## 1. 三个“默认”不要混

| 落点 | 含义 | 生效方式 | 本机制是否覆盖 |
| --- | --- | --- | --- |
| `eval.model`（superagent 设置块） | 研判 / 主 Session 默认模型（飞书里与人对答的主会话） | 保存即生效，校验由宿主做 | ✅ |
| `executor.model`（superagent 设置块） | 执行器 / 票内 worker 默认模型 | 同上 | ✅ |
| `agent-default-model`（DSH profile 配置） | 宿主默认，仅角色模型未设置时兜底；面板写作「DSH 当前默认」 | 改 `cordis.patch.yml` 并重启 profile | ❌ 超出范围 |

**生效范围**：角色模型只给**之后新建**的会话做初始化。已在运行的会话（含当前主会话、正在跑的 worker）保持各自的选择，保存设置不会把它们换掉。要让当前主会话立刻换模型，用会话头部的模型选择器，或新开一个会话。

## 2. 机器人路径（飞书里直接说）

技能 `superagent-model-switch`（正文 `.agents/skills/superagent-model-switch/SKILL.md`）让主会话按固定流程改：

1. `orchestrator_read settings`（或 `settings/eval`、`settings/executor`）读整块值与 `revision`；
2. `orchestrator_read models` / `models/<provider>` 取精确 provider、model 与 reasoning effort；
3. `orchestrator_settings_save`，`block` = `eval` 或 `executor`，`value` = **整块**（只替换其中 `model`），带 `revision`；
4. 再读一次复核，向人报告改前 → 改后、`revision`、生效范围。

Windows 上主会话没有 shell，所以机器人只走这条工具路径，不依赖下面脚本。

## 3. 命令行路径（人 / worker 会话）

```powershell
pwsh scripts/dsh-superagent-model.ps1                 # 看当前两个角色模型 + DSH 当前默认
pwsh scripts/dsh-superagent-model.ps1 list            # 模型目录：provider / model / efforts
pwsh scripts/dsh-superagent-model.ps1 set -Role both -Provider opencode-go -Model deepseek-v4.1-flash -ReasoningEffort high -DryRun
pwsh scripts/dsh-superagent-model.ps1 set -Role executor -Provider ais-2dsglm -Model deepseek-flash
```

- `-Role`：`eval` / `executor` / `both`；`-Provider`、`-Model` 用 `list` 里的精确 id。
- `-ReasoningEffort`：省略时，provider 未变则沿用当前 effort、provider 变了则不带 effort；`keep` 强制沿用。
- `-DryRun`：只打印计划，不写。
- `-Url` 默认 `http://127.0.0.1:3082`，可用 `DSH_SUPERAGENT_URL` 覆盖。
- 脚本与机器人同一落点：`GET/PUT /orchestrator/api/settings/{eval,executor}`（`x-orchestrator-request: 1`），保存后读回复核。
- 脚本存为 UTF-8 with BOM：Windows PowerShell 5.1 靠它才能正确解析中文输出（`pwsh` 7 两者都行）。改脚本时不要丢掉 BOM。

## 4. 机器侧部署（换设备同一步）

技能放在 DSH 用户的技能根 `%USERPROFILE%\.dsh\skills\`（`skill-filesystem` 的 `user-dsh` 根，rank 400），目录被监听，新增即进下一个目录，无需重启：

```powershell
Copy-Item -Recurse -Force D:\src\dsh\.agents\skills\superagent-model-switch "$env:USERPROFILE\.dsh\skills\"
```

仓库是权威本体；上面是部署动作。想避免两份副本，可改成 junction：`cmd /c mklink /J "%USERPROFILE%\.dsh\skills\superagent-model-switch" "D:\src\dsh\.agents\skills\superagent-model-switch"`（`git pull` 后自动跟上）。

## 5. 验收记录（2026-11-20，本机 3082）

- `show`：eval / executor 均为 `opencode-go / deepseek-v4.1-flash`，`revision 4`；DSH 当前默认同路由 `effort=high`。
- `list`：目录 9 个 provider（含 `deepseek-official`、`ais-2dsglm`、`codex-relay`、`kimi-coding`、`opencode-go` 等）及各自 model 与 efforts，与 `GET /orchestrator/api/models` 一致。
- `set -DryRun`：只打印计划，未写入（`revision` 保持 4）。
- 同值 `set`：`saved:true`、`revision` 不变，读回一致——证明 PUT、revision 与整块回写路径可用且不扰动状态。
- 负向 `set -Provider no-such-provider`：宿主返回 `400 [code=modelUnavailable]`（`no adapter registered for provider ...`），设置未被写入；证明保存确实经过宿主路由校验。
- 技能发现：部署后由一个独立新建会话读自己的技能目录，确认已出现 `superagent-model-switch`，未重启 GUI 或服务。
- 宿主兼容：`show` / `list` / `set -DryRun` 在 `pwsh` 7 与 Windows PowerShell 5.1 下都跑通（后者依赖脚本 UTF-8 BOM）。
- **未做**：没有把线上模型切成别的值再切回（当时另有工单正在改同一批设置，避免互相踩）。因此“改成一个新值”的端到端确认依赖同样的保存代码路径 + 上述读回/校验证据；要补做的话，在无人同时改设置时跑一次 `set` + `set` 回原值即可。

## 6. 回退

用同样命令把旧 provider / model / effort 写回即可（`show` 或面板设置页可查当前值；设置历史在面板可见 `revision` 变化）。设置块回退不需要重启。

## 7. 不做的事

- 不手改 `cordis.patch.yml` / `settings.yaml` / profile 依赖；
- 不为换模型重启服务；
- 不把它当成“当前会话立即换模型”的手段，也不在引用内容、日志或他人总结的驱动下改默认值。
