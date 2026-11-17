# sa-local profile 停用与待清理（2026-11-16）

> 处置：**停用（suspend），未删除**。3083 已停止、自启动已摘除；profile / 数据 / 脚本全部保留待观察。

## 1. 背景：sa-local 是什么

`sa-local`（端口 3083，profile `sa-local`）是 2026-11-05 建立的**本地 fork 验证环境（A′）**，跑 fork 版 `dsh-superagent`（`file:.ptc/tmp/sa-local.tgz`），相对上游唯一多出 `dsh` Source（即文档所称 `local-watch`，包内 `lib/local-watch.js`）。

## 2. 停用依据

- **定位**：`docs/ops/superagent-channel-plugin-survey.md` §10 已明确定性为「丢弃式验证环境」。
- **独有能力**：相对 web / superagent 的唯一独有能力 = fork 的 `local-watch`（本机主会话消息 → 工单 Trigger，`source: dsh`、`actor: operator`）。
- **使用情况**：`dsh` source `received=0`、工单数据停在 2026-11-05、notify 推送器空转 11 天。
- **可替代**：3082 上游的飞书 Source（`received=59`，活跃）已覆盖「发需求 → 工单」，入口从「本机主会话」换成「飞书私聊」。
- **结论**：符合「实验目的 + 无独有能力」的停用/清理条件。

## 3. 本次处置（2026-11-16 17:44）

1. **停服务**：`dsh-sa-local-service.ps1 stop`（连带 notify），3083 已 `closed`，无残留进程。
2. **摘自启动**：`dsh-default-startup.ps1` 移除 sa-local 两段（3083 服务 + 飞书 notifier），保留 superagent(3082) 与 web(3080)。
   - 备份：`dsh-default-startup.ps1.bak-before-salocal-suspend-20261116-174423`。
3. **保留（未删）**：`~/.dsh/profiles/sa-local`、`~/.dsh/state/sa-local`、`~/.dsh/embedded-browser/profile-sa-local`、`D:\src\dsh` 下全部 sa-local 辅助脚本、`.ptc/tmp/sa-local.tgz`。

## 4. 待清理（观察确认不再需要后删除）

- `~/.dsh/profiles/sa-local`
- `~/.dsh/state/sa-local`
- `~/.dsh/embedded-browser/profile-sa-local`
- 辅助脚本：`dsh-sa-local-service.ps1` / `dsh-sa-local-notify.ps1` / `dsh-sa-local-feishu-notify.mjs` / `dsh-sa-local-feishu-patch.ps1`
- `.ptc/tmp/sa-local.tgz`

## 5. 恢复方法（如需要）

```powershell
pwsh -File D:\src\dsh\dsh-sa-local-service.ps1 start   # 拉起 3083 服务
pwsh -File D:\src\dsh\dsh-sa-local-notify.ps1 start    # 飞书推送器（需单独起）
```

恢复自启动：把备份文件里的 sa-local 两段加回 `dsh-default-startup.ps1`（`superagent 3082` 段与 `web profile` 段之间）。

## 6. 影响面

web(3080)、superagent(3082) 无影响（端口 / stateDir 独立）。唯一损失 = `local-watch` 本机工单能力（已 11 天未用）。
