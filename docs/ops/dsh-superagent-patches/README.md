# dsh-superagent 本机补丁（单一事实源）

这些补丁让 **飞书通道** 在本机可用。它们改的是 `node_modules/dsh-superagent` 里的代码，
因此**升级 dsh-superagent 会整目录替换、补丁全部丢失**。本目录是补丁的唯一事实源，
`node_modules` 只是被改写的副本；升级后跑一次脚本即可复原。

## 一键操作

```powershell
pwsh -File docs\ops\patch-dsh-superagent.ps1                 # 校验（默认，只读）
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply     # 打上缺失的补丁（幂等）
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode restore   # 用 .prepatch-backup 回滚
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply -AllProfiles
```

打完补丁 **必须重启对应服务**（`dsh-superagent-service.ps1 stop` → `start`）。

## 补丁清单

| 文件 | id | 目标 | 修什么 |
|---|---|---|---|
| `feishu-probe.mjs` | `feishu-probe-no-msys-env` | `lib/poll-xx3wdCx6.js` | 部署检查经 MSYS `env` 执行 lark-cli，`env` 把 `/open-apis/...` 改写成 Windows 路径 → `404 page not found`（面板表现为「机器人的 lark-cli 不可用」） |
| `orchestrator-tools.mjs` | `orchestrator-tools-existing-only` | `lib/index.js` | `tools.restrict()` 写死 `bash`，Windows DSH 无此全局工具 → orchestrator 会话 resume 失败 → source 永远 `pending` |

## 机制

- 每个补丁是一个 `.mjs`，导出 `id`、`target`（包内相对路径）、`summary`、`applied(text)`、`apply(text)`；
- `runner.mjs` 遍历同目录补丁：`verify` 只判断、`apply` 幂等写入（写前留 `*.prepatch-backup`，写完 `node --check`，语法错自动回滚）、`restore` 用备份覆盖回去；
- 判断依据是**代码里是否已含补丁标记**，不依赖包版本，所以升级前后都能安全重复执行。

## 升级后自检（30 秒）

```powershell
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode verify      # 两行都应是 applied
# 若 missing：-Mode apply 然后重启 3082，再看
#   GET /orchestrator/api/state   应 setup.problem=none、health.feishu=ready
```

