# Git 巡检自动化（git-watchdog）

## 1 这是什么

从设备 gitsync 清单检查本机全部仓库的未提交内容和领先/落后状态；仅为干净且允许的仓库快进更新，其他情况提醒管理人，并检查 DSH 一键备份是否滞留。

上游部署文档（006-deployment.md） 要求巡检放在常用环境、superagent 服务停机也要能跑。因此它是独立 Windows 计划任务，不是 superagent profile 内部功能，不依赖 DSH Web 或 superagent 进程。

## 2 快速上手

在本仓库根目录运行（PowerShell 7、Git）：

```powershell
# 手动预览：离线，不 fetch/拉取/通知，报告照写
pwsh -NoProfile -File .\dsh-git-watchdog.ps1 -DryRun -Json
# 真实巡检，不弹通知（也不调用 wxHitl）
pwsh -NoProfile -File .\dsh-git-watchdog.ps1 -NoToast
# 看计划，再注册；默认下一整点起每 60 分钟运行
pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -DryRun
pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -IntervalMinutes 60
Start-ScheduledTask -TaskName 'DSH-Git-Watchdog'
# 移除，不删除脚本、设备配置和报告
pwsh -NoProfile -File .\dsh-git-watchdog-register.ps1 -Remove
```

任务使用当前用户 Interactive 身份，仅登录时运行以保留网络凭据；错过触发后补跑、重复实例忽略、允许电池运行、执行上限 30 分钟。重复触发持续 8760 小时，约一年后应重新注册；同名注册会覆盖旧任务。无需安装插件，也无需启动 superagent。

## 3 行为与决策表

| 组/状态 | 行为 |
| --- | --- |
| work | 只读本地 status 与离线 upstream ahead/behind，强制不 fetch、不拉取、不推送；需要处理就提醒 |
| personal / thirdparty，干净且只落后 | 本轮 fetch 成功、预检允许、清单 pull 不为 false 时 merge --ff-only upstream |
| 任意组有未提交内容 | 提醒管理人处理，不拉取；porcelain 每个非空记录计一处，包含子模块脏标记 |
| 本地领先或分叉 | 提醒管理人推送/处理；dsh 工作区通常走一键提交与备份，不自动合并分叉 |
| detached HEAD / 无 upstream | 标记并提醒，不自动拉取 |
| fetch 超时/失败或未成功 fetch | 记录错误/理由，不使用旧引用自动拉取 |
| stale=true / skipGroups（默认 excluded） | 保留报告条目及 skipReason，不检查；stale 单独计数 |
| 清单存在但磁盘缺失 | 提醒，不删除清单 |
| DryRun 或预检 drift/conflict | 完整离线巡检，不 fetch、不拉取；DryRun 还关闭全部通知 |

每条清单记录都会出现在报告 repos 中，包括跳过条目。work 即使误填入 fetchGroups/autoPullGroups 也会被强制排除。ahead/behind 的 rev-list 比较完全离线，work 数值只代表最后一次人工更新的远端跟踪引用。所有 Git 调用带 --no-optional-locks 和 core.quotepath=false。

## 4 一键备份滞留检查口径

工作区仓库是清单中位于脚本根目录之下的条目，包含根仓库本身，以目录边界比较，不误纳同前缀相邻目录。最近实质变化取以下最大时间：这些仓库最新提交时间；根目录 dsh-commit-backup.ps1、dsh-restore.ps1、dsh-config-pack/scripts/dsh-backup.ps1、dsh-config-pack/scripts/snapshot.mjs 的修改时间；DSH_HOME/profiles/* 下 profileExts 列出的配置文件修改时间（默认 cordis.yml、cordis.patch.yml、package.json、pnpm-workspace.yaml）。DSH_HOME 缺省为用户目录下 .dsh。

在 backupsDir 中按 dsh-backup-* 目录名倒序选择首个有 bundle.json 的目录，读取 created_at。没有 bundle，或最近变化晚于 created_at（零容差），即 stale。另按名称倒序读取 .ptc/reports/commit-backup-*.json，跳过 backup=null 的盘点回执；最近真实备份 status 非 ok 或回执不可读也加入 reasons。字段 latestBundle、latestBundleAt、lastMaterialChangeAt、stale、reasons 始终存在；关闭检查时保留空值及 stale=false。

提醒管理人运行：

```powershell
pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Push -Message 'chore: 收口备份'
```

巡检本身不会调用收口命令。未提交源码若不在上述脚本/配置范围，不会单凭修改时间判定备份滞留，但仍会产生 dirty 提醒。

## 5 配置

配置解析顺序：-ConfigPath → DSH_GIT_WATCHDOG_CONFIG → ~/.dsh/device/git-watchdog.json → 内置默认。选定配置文件不存在即默认，不算错误。配置仅覆盖提供的字段，嵌套对象合并；非法 JSON/结构/数值是配置损坏，退出 2。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| gitsyncHome | null | 显式清单目录；否则 GITSYNC_HOME → ~/.dsh/device/gitsync.json 的 home → 仓库父目录下 gitsync（本机即 D:\src\gitsync）→ ~/src/gitsync |
| autoPullGroups | personal, thirdparty | 可自动快进的组；work 强制排除 |
| fetchGroups | personal, thirdparty | 可 fetch 的组；work 强制排除 |
| skipGroups | excluded | 完整跳过的组 |
| fetchTimeoutSeconds | 90 | fetch 与 ff-only 子进程上限，1..3600 秒 |
| backupCheck.enabled | true | 是否检查一键备份 |
| backupCheck.backupsDir | null | 默认 %USERPROFILE%/.dsh/backups |
| backupCheck.profileExts | 四个配置文件名 | cordis.yml、cordis.patch.yml、package.json、pnpm-workspace.yaml；字段名历史为 Exts，实际是完整文件名，不允许目录路径 |
| notify.toast | true | 有 issue 时尽力发送 Windows Toast |
| notify.wxHitl.enabled | false | 可选命令通知开关 |
| notify.wxHitl.command | null | 可信 PowerShell 表达式；%MESSAGE% 会替换成安全单引号字符串，不要再给占位符加引号 |
| reportDir | null | 默认脚本根目录 .ptc/reports |
| keepReports | 20 | JSON 和日志各自保留最新 N 份，1..3600；只清理 git-watchdog 前缀 |

完整示例（按需省略任何字段；不写凭据）：

```json
{
  "gitsyncHome": null,
  "autoPullGroups": ["personal", "thirdparty"],
  "fetchGroups": ["personal", "thirdparty"],
  "skipGroups": ["excluded"],
  "fetchTimeoutSeconds": 90,
  "backupCheck": {
    "enabled": true,
    "backupsDir": null,
    "profileExts": ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]
  },
  "notify": {
    "toast": true,
    "wxHitl": { "enabled": false, "command": null }
  },
  "reportDir": null,
  "keepReports": 20
}
```

## 6 提醒渠道

Windows WinRT Toast 尽力而为：通知权限、无人值守会话或未注册应用标识都可能导致不展示。toastError 记录异常但不改变巡检退出码。权威产物是 .ptc/reports/git-watchdog-*.json 和 .ptc/logs/git-watchdog-*.log；秒级时间戳另带毫秒防止连续验收覆盖。

wxHitl 为可选、自行配置的本机命令，默认关闭。示例 command 为 wx-hitl notify --message %MESSAGE%（先自行核实本机 CLI 参数）。命令有 30 秒上限，失败写 wxHitlError。仅在有 issue、非 DryRun、非 NoToast 时调用。不要把 API key 或凭据写入 command。-Json 的 stdout 只输出完整报告 JSON，包含全部 repos，不混入人读日志。

## 7 引擎预检门槛

使用 ~/.agents/skills/local-git-sync/scripts/engine-preflight.ps1 -Target <gitsyncHome> -Json -NoState，以 System.Diagnostics.Process 执行、超时 120 秒。-NoState 确保不改设备判决文件。

in-sync/fresh 允许受限同步；脚本缺失为 unavailable，记录 warning；预检存在但执行/解析失败按 conflict 安全阻断。drift/conflict 时完整 report-only，跳过 fetch 和自动拉取，仍产出全部状态、提醒和报告，退出 3。

当前本机已核实为 drift：register-scan-task.ps1 设备版与 skill 版内容不同，待管理人决定采用哪一版。巡检不会代为接受漂移、覆盖引擎或恢复。

## 8 跨设备复用

代码与本文随 Git 更新即可取得；设备差异放 ~/.dsh/device/git-watchdog.json（或显式配置路径），不进 Git。清单仍由本机 gitsync 管理，不复制别的设备绝对路径。没有清单时应先由管理人初始化本机 gitsync；巡检不会生成/改写清单。

装机按[引导文档第 6 步](../bootstrap/PROMPT-新设备装机-引导.md)注册。每台设备分别注册自己的任务；更新脚本无需重新注册，改变安装目录或续期重复触发时重跑注册。移除任务是安装回滚入口。

## 9 验收清单与退出码

- PowerShell Parser 解析两个脚本，错误数为 0；两个脚本为 UTF-8 无 BOM。
- 注册脚本 -DryRun 打印动作、身份、下一整点和周期，退出 0，无系统改动。
- 巡检 -DryRun -Json 可解析，repos 覆盖整个清单，dryRun=true、pulled 全 false，报告日志均生成。
- 当前 drift 环境实际跑 -NoToast，退出 3、preflight.state=drift、summary.pulled=0、issues 非空。
- 检查 backupCheck 的 latestBundleAt、lastMaterialChangeAt、stale。
- 管理人实际注册后用 Start-ScheduledTask 验证，读取最新回执与 Get-ScheduledTaskInfo；本次交付验证只运行注册 DryRun。

| 退出码 | 意义 |
| --- | --- |
| 0 | 无 issue |
| 1 | 有 issue，已记录（通知可被关闭或失败） |
| 2 | 配置/清单损坏或报告落盘失败 |
| 3 | 预检 drift/conflict，report-only；优先于普通 issue |

## 10 限制与红线

不 force、不 reset、不 clean、不 checkout、不提交、不推送，不对 work 做任何网络或内容修改。仅自动快进，不替管理人 stash/合并分叉。自动拉取要求本轮成功 fetch；清单 pull=false 永远不自动拉取。网络 fetch 有超时且禁止交互式凭据输入，失败交给管理人。巡检记录本地状态而非远程服务的实时证明；离线时不能发现尚未 fetch 的新远端提交。

计划任务依赖 Windows 当前用户登录，不保证机器关机/用户登出时执行。Toast 不是可靠送达渠道；请以报告为准。现有环境 drift 阻止了自动拉取路径，本次未实际修改任何仓库来测试拉取成功；解除 drift 后应先人工复核允许组策略，再观察首轮运行。
