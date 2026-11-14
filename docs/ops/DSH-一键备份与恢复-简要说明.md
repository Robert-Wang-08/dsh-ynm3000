# DSH 一键备份与恢复 · 简要说明

> 更新：2026-11-14 · 基线：DSH `0.2.1-rc.5`、config-pack `v0.11.7`、收口备份 `v1.4.1`
> 完整参数与已知限制见 [一键提交与备份](一键提交与备份.md)；换机步骤见 [新设备装机引导](../bootstrap/PROMPT-新设备装机-引导.md)。

## 1. 一句话

「DSH 收口备份」用一条命令完成两件事：把工作区（根仓库 + 全部子仓库）的本地改动按显式路径提交，并把**全部 profile** 的配置与插件数据打成一份可跨机恢复的 bundle；换机后用一条 `dsh-restore.ps1` 命令恢复。

v1.4.0 起，工作区之外的兄弟检出（`D:\src\dsh-superagent`，其子模块工作树为空）用 `-IncludeSiblingRepos` 一并收口；`focus-hub` 仍需 `-IncludeFocusHub`。
v1.4.1 起加两道门禁：备份没通过校验就不提交不推送；子仓库推送失败就不推根仓库（防远端子模块指针断链）。

## 2. 已有插件（备份覆盖的这套环境）

版本以根 `README.md` 的「插件与 Bundle 登记」表为准（2026-11-10 基线）。备份覆盖的是这些插件写入 profile 的配置与运行数据，**不是**插件源码；源码随各自 Git 仓库走。

| 组件 | 作用 |
| --- | --- |
| `dsh-config-pack` 0.11.7 | 通用配置包：四档故障转移路由、PTC bundle、MCP 开关、agent 预设、密钥指针 |
| `dsh-deepseek-keypool`（仓库 `dsh-provider-failover`） 3.8.3 | provider 故障转移：QUOTA / AUTH / 限流 / 传输错误自动切下一档 |
| `dsh-archived-sessions` 0.4.4 | 会话归档列表、查看器、删除 |
| `dsh-plugin-sidebar-visibility` 0.0.7 | Web 侧栏隐藏/折叠/排序、会话重命名/分叉、运行中转圈等九项增强 |
| `dsh-plugin-provider-badge` 0.4.0 | 模型选择器前的 provider 徽标与额度入口 |
| `dsh-plugin-subagent-monitor` 0.1.0 | 子代理面板：实际路由、keepalive、后台输出环 |
| `dsh-plugin-subagent-director` 0.6.0-beta.2 | 子代理按角色/参数选 provider/model |
| `dsh-plugin-new-session` 0.2.0 | 会话内一句话新建独立顶层会话 |
| `dsh-plugin-ptc-switches` 0.2.0 | PTC 模式热切换 UI |
| `@local/dsh-subagent-acp-resilient` 0.2.3 | ACP 子代理的替换实现（分级超时、诊断回传） |
| `@local/dsh-ptc-multi-agent-mode` 0.3.0 | 可移植 PTC 多代理预设与跨 CLI 路由 |
| `@local/dsh-preset-failover-tiers` 0.1.0 | 便携档位表（模型族对齐 tier） |
| `dsh-codex-cred-sync` 1.0.0 | 同步 pi-ai provider 与 Codex 登录凭据的过期时间 |
| `dsh-permission-compat` 0.1.0 | 宿主权限行为补丁工具（带外 apply/verify/revert） |
| `dsh-wechat-hitl` | 微信人工确认回环（插件 + 网关 + CLI） |
| `dsh-superagent` | 独立服务（profile `superagent`，端口 3082），非插件 |

可选三方组（默认装，`-SkipOptional` 跳过）：`recent-sessions`、`dshmarket`、`subagent-director`、`palette`。`dsh-embedded-browser` 当前 profile 未启用。

## 3. 功能亮点

1. **一条命令收口**：盘点 → 备份 → 提交 → 可选推送；先子仓库、根仓库最后，子模块指针不悬空。
2. **全 profile bundle**：默认把 `~/.dsh/profiles` 下每个 profile 各打一份 `dsh-snapshot/v1`，装入 `dsh-backup-<时间戳>\profiles\<profile>\`，根目录 `bundle.json`（`schema=dsh-backup-bundle/v1`）。
3. **默认 profile 不变**：仍是 `web`，恢复完照旧 `dsh web` 启动，不写任何“默认 profile 指针”。
4. **恢复默认只出计划**：`dsh-restore.ps1` 不带 `-Apply` 只打印；写回前每个 profile 先写 `pre-restore-<时间戳>` 安全快照。
5. **partial 门禁**：未做隔离安装演练的备份是 partial，写回必须显式 `-AllowPartial`，避免把半成品当完整恢复点。
6. **引擎一致性门槛**：`engine-preflight` 为 `conflict` 时恢复硬阻断；`drift` 需人工确认后加 `-AcceptEngineDrift`。
7. **演练可选**：`-Rehearse` 走离线安装演练；store 缺 git-hosted tarball 时用 `-RehearseOnline` 在线演练。
8. **可审计完成判据**：退出码 0 **且** 回执 `.ptc\reports\commit-backup-<UTC>.json` 的 `backup.status=ok`（bundle.json 可读、`failed=0`）。
9. **精细留档补充**：`scripts/config-snapshot.ps1` 钉住 10 个关键文件（两个 profile 的 cordis patch/package、workspace、AGENTS、PTC bundle 源），带 SHA256 与 DryRun 回滚。
10. **安全纪律**：凭据值、`.ptc/`、`.tmp-*`、`downloads/` 等永不入库；只按显式路径暂存；从不 force push。

## 4. 下载

```powershell
git clone --recurse-submodules https://github.com/Robert-Wang-08/dsh-ynm3000.git D:\src\dsh
```

- 备份/恢复入口在根仓库：`dsh-commit-backup.ps1`、`dsh-restore.ps1`；快照引擎在 `dsh-config-pack\scripts\`（随 submodule 一起克隆）。
- 配置包发布源：[github.com/Robert-Wang-08/dsh-config-pack](https://github.com/Robert-Wang-08/dsh-config-pack)，最新 tag `v0.11.7`；仓库 `main` 含 tag 之后的修复（provider 迁移、`-RehearseOnline`）。
- 环境要求：PowerShell 7+、Node.js 20+、Git、pnpm（装插件时）。

## 5. 配置（首次）

```powershell
# 新设备：读共享盘答案 → 写 DSHPACK_* → 装包进 profile
pwsh -File dsh-config-pack\scripts\setup.ps1 -Source 'github:Robert-Wang-08/dsh-config-pack#v0.11.7'

# 已装设备：同步到最新发布版
pwsh -File dsh-config-pack\scripts\update.ps1 -ProfileName <你的profile>

# 只装包、不写设备答案
pwsh -File dsh-config-pack\scripts\install.ps1 -ProfileName <你的profile>
```

- 共享盘答案约定：`<云盘根>\dsh-device\device.env`、`route-config.json`；没有共享盘时用包内模板或让 AI 读 `dsh-config-pack/docs/AI-DEVICE-SETUP.md`。
- 密钥只写指针：`DSHPACK_KEY_*` 存环境变量名，真实值放在用户环境变量，不进 Git、不进备份。
- 日常 profile 是 `web`；`superagent` 是独立服务（3082），用 `dsh-superagent-service.ps1` 启停。
- 装完必须重启 DSH 并新开会话（工具表在会话启动时生成）。

## 6. 日常备份与恢复

```powershell
# 收口备份（一句话）：全 profile bundle + 提交 + 推送
pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Push -Message "chore: 收口备份"

# 只盘点 / 只备份当前 profile
pwsh -NoProfile -File .\dsh-commit-backup.ps1 -Status
pwsh -NoProfile -File .\dsh-commit-backup.ps1 -SingleProfile -Message "chore: 单 profile 备份"

# 换机恢复：列 bundle → 看计划 → 写回
pwsh -NoProfile -File .\dsh-restore.ps1 -List
pwsh -NoProfile -File .\dsh-restore.ps1 -Snapshot <bundle 目录>
pwsh -NoProfile -File .\dsh-restore.ps1 -Snapshot <bundle 目录> -Apply -AllowPartial
```

配置包单入口（不依赖根仓库脚本）同样可用：

```powershell
pwsh -NoProfile -File .\dsh-config-pack\scripts\dsh-backup.ps1 backup -AllProfiles
pwsh -NoProfile -File .\dsh-config-pack\scripts\dsh-backup.ps1 restore -AllProfiles -Snapshot <bundle 目录> -Apply -AllowPartial
```

## 7. 边界与注意

- 这是**配置与插件数据**的备份，不是整机镜像：不含会话、附件、日志、`node_modules`、CLI/OAuth 登录态和凭据值。
- 未加 `-Rehearse` 的备份是 partial，只能作为“尽力恢复”输入；跨机完整恢复前先看 `bundle.json` 的 `completeness`。
- `link:` 依赖指向本机仓库路径；目标机需要同路径克隆（或先改 profile 里的 link 目标），`dsh-restore.ps1` 会在写回前体检。
- 引擎预检 `drift` 时必须人工决策（采用 skill 引擎会先备份）；`conflict` 不得恢复。
- 恢复后重启 DSH、新开会话，再按装机引导跑 `verify-install` 验收。

## 8. 相关文档

- [一键提交与备份（v1.3.0，完整参数与版本历史）](一键提交与备份.md)
- [新设备装机引导](../bootstrap/PROMPT-新设备装机-引导.md)
- [保存边界表 v3](../../dsh-config-pack/docs/storage-boundaries-v3.md)
- [备份恢复审计](../../dsh-config-pack/docs/backup-restore-audit.md)
