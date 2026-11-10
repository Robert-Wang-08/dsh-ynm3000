# dsh-superagent 本机补丁（单一事实源）

这些补丁让 dsh-superagent 在 **Windows + 本机 DSH** 上能跑：其中 `stateDir-windows-absolute` 是**启动必需**（缺了插件根本不激活），另外两条分别修飞书通道与 orchestrator 工具白名单。它们改的是 dsh-superagent 副本里的构建产物，
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

> 子模块里**重新 `pnpm build` 会覆盖 `lib/`**，补丁全部丢失，必须重跑一次 `-Mode apply`。

## 补丁清单

> **2026-11-10 起：下表两项修复已下沉到源码**（`D:\src\dsh-superagent`，就是 3082 profile 的 `link:` 目标，它的 `node_modules/dsh-superagent` 指的就是这个目录）。
> 因此 `pnpm build` 重建 `lib/*` 不会再丢这两项；同时 `lib` 里的分块文件名会变（`poll-xx3wdCx6.js` → `poll-CWrf6vkn.js` 等），
> 本目录的 **lib 级补丁视为已废止**，只在 `verify` 报 `target missing` 时按源码位置核对：
> - 飞书探测的 `env` 前缀 → `src/deployment.ts` 的 `workerProbe` / `resolveFeishuBot`；
> - 主会话 `tools.restrict` 的 `bash` → `src/app/sessions.ts` 的 `masterTools`。

| 文件 | id | 目标 | 修什么 |
|---|---|---|---|
| `feishu-probe.mjs` | `feishu-probe-no-msys-env` | `lib/poll-*.js` | 部署检查经 MSYS `env` 执行 lark-cli，`env` 把 `/open-apis/...` 改写成 Windows 路径 → `404 page not found`（面板表现为「机器人的 lark-cli 不可用」） |
| `orchestrator-tools.mjs` | `orchestrator-tools-existing-only` | `lib/index.js` | `tools.restrict()` 写死 `bash`，Windows DSH 无此全局工具 → orchestrator 会话 resume 失败 → source 永远 `pending` |
| `stateDir-windows.mjs` | `stateDir-windows-absolute` | `lib/poll-*.js` | `absolute()` 把绝对路径写死成 `/^\//`，Windows 的 `C:\...` 被判非法 → `did not activate`（2 条），orchestrator 永不就绪、任何工单都不产生 |

## 机制

- 每个补丁是一个 `.mjs`，导出 `id`、`target`（包内相对路径，**支持 `*` 通配**）、`summary`、`applied(text)`、`apply(text)`；
- 必须用通配的原因：tsdown 把共享 chunk 打成带内容哈希的文件名（`poll-xx3wdCx6.js` → `poll-Dh7J1cdM.js`），写死文件名会在每次重新构建/升级后变成 `target-missing`；
- 2026-11-10 起 profile 用 `link:` 指向仓库内的子模块 `dsh-superagent`，`--pkg` 也可直接给该子模块目录（`lib/`、`node_modules/` 都在其 `.gitignore` 里，所以打补丁**不会**让子模块变脏）；
- `runner.mjs` 遍历同目录补丁：`verify` 只判断、`apply` 幂等写入（写前留 `*.prepatch-backup`，写完 `node --check`，语法错自动回滚）、`restore` 用备份覆盖回去；
- 判断依据是**代码里是否已含补丁标记**，不依赖包版本，所以升级前后都能安全重复执行。

## 升级后自检（30 秒）

```powershell
pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode verify      # 三行都应是 applied
# 若 missing：-Mode apply 然后重启 3082，再看
#   GET /orchestrator/api/state   应 setup.problem=none、health.feishu=ready
```

