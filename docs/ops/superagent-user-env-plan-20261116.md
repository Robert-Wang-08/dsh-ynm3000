# superagent 自动化启动时读取 Windows 用户环境变量：方案分析（2026-11-16）

## 0. 一句话结论

DSH 的启动环境是**启动瞬间的冻结快照**（`process` / `project-env` / `user-env` 三层），**从不读 Windows 注册表**；
superagent 的 worker 又是宿主进程内的 DSH Session，所以「宿主启动时 env 里没有 CRS_OAI_KEY」就会一路缺到底。
根治方案是在 DSH 启动环境里补一个 **Windows 用户环境层（HKCU\Environment）**，让监控、计划任务、登录启动、网关拉起等所有入口
都不再依赖「启动者当时的终端环境」；在此之前，用凭据库写入 `CRS_OAI_KEY` 可立即恢复 codex-relay，无需重启宿主。

## 1. 问题

- 现象：`CRS_OAI_KEY` 已存在于用户级环境变量，但 superagent（3082，profile `superagent`）里 `codex-relay` 路由报凭据缺失/不可用；
  新顶层会话选 `codex-relay/gpt-6.1-sol` 不能用。
- 用户诉求：**通过监控或其他方式（而非手动开新终端）启动的 superagent，也要能读到用户环境变量**。
- 约束：密钥只放用户环境变量（`~/.dsh/device/device.env` 的注释明确「密钥值不写在这里，密钥仍用用户环境变量」），
  不把密钥复制进仓库、共享盘或日志。

## 2. 机制与证据

### 2.1 环境如何到达 worker

```
Windows 登录/终端/网关/计划任务
        │  继承启动者的 process.env（快照 A）
        ▼
DSH 宿主：node @deepseek-ai/dsh/lib/bin.js --profile superagent
        │  bin.js → loadLayeredEnv() 生成冻结快照 B = A + <cwd>/.env + $DSH_HOME/.env
        ▼
dsh-superagent 插件：worker 会话是宿主进程内的 DSH Session（src/executor/dsh.ts 中 host.sessions.ensure）
        │  共享宿主 process.env；没有按会话重建 env
        ▼
worker 的 pwsh/git/gh 子进程：scrubbedParentEnv() 再按名字过滤（见 2.4）
```

结论：**worker 的环境 = 宿主进程的环境**；要让 worker 拿到用户变量，必须让宿主在启动时拿到，或让读取方在运行时重取。

### 2.2 DSH 只认启动快照，不读注册表

源码事实（全局包 `@deepseek-ai/dsh` 0.2.1-rc.5）：

- `lib/bin.js` → `loadLayeredEnv("dsh")`；
- `@deepseek-ai/dsh-app-boot/lib/index.js` `loadLayeredEnv()`（约 3736 行）：
  - 层序：`inherited process.env`（process）→ `<cwd>/.env`（project-env）→ `$DSH_HOME/.env`（user-env）；
  - `.env` 值只**补缺失**（`if (process.env[name] === void 0)`），不覆盖已继承的值；
  - 返回 `createLaunchEnvironmentSnapshot()` 的**不可变快照**，挂到 `ctx.launchEnvironment`，之后不再刷新；
  - `BOOTSTRAP_NAMES` 禁止 `.env` 设置 PATH/HOME/PROXY 等启动期变量。
- `@deepseek-ai/dsh-launch-environment/lib/index.js`：快照 `get/getFrom` 按固定层序解析，进程启动后再改注册表不会回流。

**没有任何一层读 Windows 注册表**。因此「用户级环境变量」对 DSH 来说并不自动可见，取决于启动者当时的 `process.env`。

### 2.3 凭据解析顺序

`@deepseek-ai/dsh-credentials-local/lib/index.js`：

```
$DSH_HOME/.credentials.yaml   （受管库，Web「设置→模型」写入，watcher 热加载）
> 继承的 process 层             （启动快照；不读注册表）
> <cwd>/.env → $DSH_HOME/.env  （dotenv 兜底）
```

`codex-relay` 的 `apiKeyEnv: CRS_OAI_KEY`（`~/.dsh/profiles/superagent/cordis.patch.yml` 246-250 行）经
`dsh-llm-pi-ai` → `ctx.credentials.resolve("CRS_OAI_KEY")` 解析；两处都没有就抛 `MISSING_CREDENTIAL`，界面显示「API 密钥缺失」/路由不可用。

本机现状（2026-11-16）：

- `~/.dsh/.credentials.yaml` 的 `refs` 有 OPENCODE_API_KEY、AIS_2DSGLM_API_KEY、LLMKEY_KIMI、DEEPSEEK_API_KEY、
  CLAUDE_RELAY_TOKEN、TOKENISS_API_KEY、CLAUDETOKENISS25_API_KEY，**没有 CRS_OAI_KEY**；
- `~/.dsh/.env`、`D:\src\dsh\.env` 均不存在。

### 2.4 工具子进程会按名字过滤（重要，别用 `$env:` 当证据）

`@deepseek-ai/dsh-subprocess/lib/index.js`：

```js
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
// scrubbedParentEnv(): 剔除名字命中该正则的变量和所有 DSH_*，再交给子进程
```

所以 worker 的 pwsh 里 `$env:CRS_OAI_KEY` 为空**并不能证明宿主没有该变量**。11-13 的诊断文档用「pwsh 环境比对」推断宿主环境，
方法有缺陷（14 个缺失项恰好全是密钥名，正是过滤特征）；但「宿主缺少该 key」的结论仍成立，依据应是
**宿主侧凭据解析失败（MISSING_CREDENTIAL）/ 用户观察到的路由不可用**，而不是子进程 dump。

### 2.5 本机可观测事实（2026-11-16）

- 开机 16:21:12，登录 16:21:38，explorer 16:22:22；
- 网关进程 `openclaw gateway run`（pid 27956）16:22:59 启动；
- superagent 宿主（pid 27312，`dsh --profile superagent`）16:23:01 启动，日志
  `.artifacts/service-20261116T162301.out.log`，`service.pid` = 27312；
- 注册表 `HKCU\Environment` 最后写入时间 **2026-11-12 19:22:41**；用 `CreateEnvironmentBlock` 现场重建用户环境块：
  **84 项，CRS_OAI_KEY / DSHPACK_KEY_CODEX_RELAY / TENCENT_DOCS_TOKEN 均在位**；
- 因此：**注册表侧没有问题，一个新建进程能拿到密钥**；如果宿主仍报凭据缺失，原因只能落在「宿主启动时的快照/启动链」一侧，
  而不在系统设置。宿主进程 env 无法从 worker shell 可靠观测（见 2.4），本文不把子进程 dump 当作宿主证据。

### 2.6 worker 是宿主内会话

`dsh-superagent/src/executor/dsh.ts`（约 440 行）用 `host.sessions.ensure(sessionId, …)` 在宿主进程内建 worker Session，
没有独立子进程、没有独立 env。改 superagent 的启动链 = 改所有 worker 的可见环境。

## 3. 为什么「重启一次」不是方案

本机当前没有「监控进程主动拉起 superagent」的独立组件：自动拉起发生在**登录 Startup 脚本**
（`DSH-Default-Startup.cmd` → `dsh-default-startup.ps1` → `dsh-superagent-service.ps1`）与**网关**；
`DSH-Superagent-Health` 只探活/报告。下文把这些统一称为「非手动启动」。

| 启动方式 | env 来源 | 失效原因 |
| --- | --- | --- |
| 手动开新终端跑 `launch-superagent.cmd` | 新终端的 process env | 只有这次有效，下次换回旧终端依旧 |
| 登录启动 `DSH-Default-Startup.cmd`（Startup 文件夹） | 登录时环境块 | setx 改在登录之后 → 一直拿旧值，直到重新登录/重启 |
| `OpenClaw-Gateway.cmd` 拉起的网关再拉 DSH | 网关进程 env | 网关是长驻进程；openclaw 托管子进程还可能带裁剪过的 env |
| 计划任务 / 监控 | 任务启动时的 token 环境 | 取决于任务创建与登录上下文；无重新解析 |
| 任何入口启动后的长驻宿主 | 启动快照 | 注册表再改也不会回流（快照不可变） |

健康检查 `DSH-Superagent-Health`（`tools/superagent_health`）目前只探活/报告，**不重启、不比对 env**，不构成兜底。

## 4. 方案候选

### A. DSH 启动环境新增 Windows 用户环境层（推荐，根治）

在 `loadLayeredEnv()` 里、`.env` 之后，增加最低信任的 **registry 层**：读 `HKCU\Environment`（可选再读
`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`），只补齐 `process.env` 仍缺失的名字，
并把该层放进快照（新 source，如 `user-registry`）。

- 覆盖所有入口：手动、登录启动、计划任务、监控、网关代拉，只要最终跑 `dsh --profile superagent` 就生效；
- 与现有安全模型一致：`.env` 只能补缺失、不能覆盖继承值；registry 层同理，且本层不补 `BOOTSTRAP_NAMES`；
- 唯一需要同步改的消费方：`dsh-credentials-local` 的 dotenv 兜底（`getFrom(ref, ["project-env","user-env"])`）
  要加入 `user-registry`，否则 provider key 仍解析不到；
- Windows-only，其他平台 no-op；读取失败（权限/键不存在）**必须静默降级**，不能阻断启动。

代价：改的是全局安装的 DSH 包（`C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh`），升级会被覆盖，需要版本化 patch/上游 PR。

### B. 启动器统一刷新用户环境（过渡/兜底，不改 DSH 本体）

写一个 `Resolve-UserEnvironment` 帮助函数（`CreateEnvironmentBlock` 或 `reg query`），在以下入口启动前把
缺失的用户变量补进当前 PowerShell 进程，再启动 DSH：

- `dsh-superagent-service.ps1` 的 `start`（唯一官方 superagent 启停入口）；
- `dsh-default-startup.ps1` / `dsh-default-startup.cmd`（登录启动）；
- 网关的启动脚本（`OpenClaw-Gateway.cmd` 或改成包装脚本），保证网关及其代拉的 DSH 也带新环境。

优点：不动 DSH、当天可落地、对非 DSH 子进程也有效。
缺点：**每个入口都要接**，漏一个就漏一类；未来新增的启动方式会重新踩坑；无法修复已经跑着的宿主。

### C. 凭据库 / DSH `.env`（立即恢复，不动代码）

- **C1 凭据库**：把 `CRS_OAI_KEY` 写入 `~/.dsh/.credentials.yaml` 的 `refs`（Web「设置→模型→Codex Relay→编辑」），
  watcher 热加载，**无需重启**，优先级最高。适合只解决 model 凭据、且要立刻可用。
- **C2 `$DSH_HOME/.env`**：写 `CRS_OAI_KEY=...`，每次 DSH 启动都会读，与启动方式无关；但密钥在注册表和文件两处，
  轮换要改两处，且违背 `device.env` 「密钥只放用户环境变量」的既有约定。

### D. 监控加「env 漂移」检测与自动重启（兜底）

在 `DSH-Superagent-Health` 里增加：记录宿主启动时间 + 启动时的 env 指纹（只存名字集合或加盐哈希，不存值），
定期与 `CreateEnvironmentBlock` 的结果比对；漂移时告警，或按 `-RespectStop` 语义调用
`dsh-superagent-service.ps1 restart`。这只能让系统**尽快收敛**，不能替代 A/B。

### E. 不推荐

- 让 superagent 自己每次启动到注册表读 key（重复实现环境解析、绕开 DSH 分层模型，其他 profile 仍旧坏）；
- 把密钥写进 `D:\src\dsh\.env`（project-env 会随仓库分发）；
- 把密钥写进计划任务参数或脚本（落盘、可被任意读取）。

## 5. 推荐路线

> 2026-11-16 20:15 更新：用户选择**轻量路线**（只改启动方式，不动 DSH 本体），已实施，见第 10 节；下面 P1（DSH 补丁）暂缓。

**P0 立即恢复（今天）**：C1 写凭据库 → 新顶层会话选 `codex-relay/gpt-6.1-sol` 验证。
不重启、不打断当前会话；写入前备份 `.credentials.yaml`，全过程不打印密钥。

**P1 根治（方案 A）**：给 DSH 启动环境加 registry 层 + 凭据兜底同步；单测 + 从「旧环境终端」启动宿主的集成验证。
落地后重启一次 superagent（`dsh-superagent-service.ps1 restart`，会中断在跑回合），此后任意入口启动都自带用户环境。

**P2 兜底（方案 D）**：健康检查加 env 指纹/漂移重启；顺带把 B 的解析函数复用到服务脚本，作为 DSH 升级被覆盖时的降级路径。

**可选 B**：若 P1 因 DSH 包升级策略暂缓，先做 B 覆盖服务脚本与登录启动两个入口（当天可验证），并明确「网关代拉」仍是缺口。

## 6. 方案 A 实施细则

### 6.1 改动点

1. `@deepseek-ai/dsh-app-boot` `loadLayeredEnv()`：
   - 新增 `readWindowsEnvironment(warn)`：仅 win32；读 HKCU + HKLM，合并（同名时 HKCU 优先），返回 `Record<string,string>`；
   - 在 `.env` 层之后按「仅补缺失」写入 `process.env`；
   - 快照新增一层 `{ source: "user-registry", values }`（`SOURCE_ORDER` 追加在末尾）；
   - 失败（键不存在/读取异常）只 `warn` 一次，继续启动。
2. `@deepseek-ai/dsh-launch-environment`：`SOURCE_ORDER` 增加 `"user-registry"`（最低信任）。
3. `@deepseek-ai/dsh-credentials-local`：`dotenvFallback` 的 source 列表加 `"user-registry"`。

### 6.2 读取实现（二选一）

- **FFI（推荐）**：`@deepseek-ai/dsh-win32-process` 已依赖 koffi；`OpenProcessToken(GetCurrentProcess())` +
  `CreateEnvironmentBlock` + `DestroyEnvironmentBlock`，UTF-16 双 NUL 解析。语义与 Windows 给新进程的环境一致，
  自动包含系统变量；本机已用它做过只读验证（84 项）。
- **`reg query`**：同步 `spawnSync('reg', ['query','HKCU\\Environment'])`，解析 `NAME    REG_SZ    VALUE`；
  需处理 `REG_EXPAND_SZ` 展开与值中空格，脆一些但无原生依赖。

### 6.3 语义

- 只补 `process.env[name] === undefined`；已存在（包括空串）不覆盖——与 `.env` 层一致；
- win32 名字大小写不敏感（快照 `lookupKey` 已处理）；
- 本层不补 `BOOTSTRAP_NAMES`（PATH/HOME/PROXY/NODE_OPTIONS 等）中的名字，避免注册表意外改写启动期行为；
  这些名字通常已由继承层提供；
- 不打印值；调试日志只输出「materialized N names from user registry」。

### 6.4 测试

- 单测（注入假 registry reader）：层序（process > project > user .env > registry）、仅补缺失、win32 大小写、
  bootstrap 名拒绝、读取异常降级；
- 集成：用一个「故意清空密钥类变量」的旧环境启动 `dsh --profile superagent`，断言 launch 快照
  `getFrom("CRS_OAI_KEY", ["user-registry"])` 有值，且 `credentials.resolve` 能取到；
- 回归：`--dump-config` 正常、无新增启动告警、`.env` 层既有行为不变。

### 6.5 分发

- 短期：对本机全局包打版本化 patch（类似 `profiles/*/patches` + `patchedDependencies` 的既有做法），记录 DSH 版本号，
  升级脚本里检查 patch 是否存在；被覆盖时 P2 的启动器兜底仍可工作。
- 长期：向 DSH 上游提 PR（`dsh-app-boot` + `dsh-launch-environment` + `dsh-credentials-local` 三处小改），
  Windows 用户环境属于通用需求，值得进本体。

## 7. 方案 B 实施细则（若先走过渡）

1. `dsh-superagent-service.ps1` 顶部增加 `Import-UserEnvironment`（幂等：仅补缺失），在 `start/restart` 分支最先调用；
2. `dsh-default-startup.ps1` 同样调用（登录启动链路）；
3. 网关启动：`OpenClaw-Gateway.cmd` 改为先 `pwsh -File tools/apply-user-env.ps1` 再 start，或把网关纳入
   `dsh-superagent-service.ps1` 式的包装脚本；
4. 验收：任意入口启动后，用「宿主侧」判据验证（codex-relay 可用 / `--dump-config` 的 `!!js process.env.CRS_OAI_KEY` 非空），
   **不要**用 worker 的 pwsh `$env:`。

## 8. 风险与边界

- **快照过期**：A 只在启动时补；宿主长驻期间注册表变化仍需重启/凭据库热加载。P2 的漂移检测负责提示与收敛。
- **安全**：注册表用户变量进入宿主进程，与写入 `~/.dsh/.env` 等价；worker 的工具子进程仍按名字过滤，不会默认外泄。
- **升级覆盖**：全局 DSH 包升级会冲掉 patch，需要版本化并检查；P2/B 是降级路径。
- **多用户/服务账户**：`HKCU` 读的是「当前进程 token 的用户」。计划任务若以另一账户运行，读到的是该账户的环境，
  必要时用 HKLM 或任务账户的 user hive。
- **读取语义**：`CreateEnvironmentBlock` 与 `reg query` 对 `REG_EXPAND_SZ` 的处理不同，实施时要与「新进程实际获得的 env」对齐。
- **未验证**：openclaw 对托管子进程是否做了 env 裁剪尚不能从本会话证实（worker shell 的缺失项可由 DSH 自身过滤解释）；
  但无论是否裁剪，A 都不依赖继承，因此结论不受影响。

## 9. 待用户决定

> 2026-11-16 20:15：第 2 项已有结论——**不做 DSH 本体补丁**，改走启动器侧（第 10 节，已实施）。第 1、3 项仍待定。

1. 立即恢复是否走 C1（写凭据库、不重启），还是等一次重启让 P0 与 P1 一起生效？
2. ~~P1 是否接受「给全局 DSH 包打本地 patch」~~ → 已否决，改走第 10 节轻量路线。
3. P2 漂移时默认「只告警」还是「自动重启（遵守手动 stop 标记）」？

## 10. 轻量路线（已实施，2026-11-16 20:15）

用户决定不走 DSH 本体补丁，只改启动方式。已按下面最小改动落地：

- 新增 `D:\src\dsh\dsh-user-env.ps1`：用 `CreateEnvironmentBlock`（当前用户 token）重建「新进程会拿到的用户环境」，
  对当前 PowerShell 进程**只补缺失的名字**，不覆盖已有值、不输出任何值；读取失败只告警，不阻断启动。
- `D:\src\dsh\dsh-superagent-service.ps1` 的 `start` 分支在 `Start-Process` 前调用它（`restart` 复用 `start`）。
- 这样覆盖 superagent 的全部自动启动入口：`launch-superagent.cmd`、登录 Startup（`DSH-Default-Startup.cmd` →
  `dsh-default-startup.ps1` → 本服务脚本）、手动 `start/restart`。手动在新终端跑 `dsh --profile superagent` 本身就是新环境，不受影响。
- 备份：`dsh-superagent-service.ps1.bak-before-user-env-20261116T2010`；回滚即恢复该文件并删除 `dsh-user-env.ps1`。
- 验证（未重启宿主，避免打断会话）：
  - 在「密钥名被 DSH 子进程过滤」的 pwsh 里执行 helper：补回 13 个缺失变量，`CRS_OAI_KEY`、`TENCENT_DOCS_TOKEN`、
    `DSHPACK_KEY_CODEX_RELAY`、`DSHPACK_KEY_AIS` 全部在位；
  - 两个脚本 `Parser.ParseFile` 通过；`dsh-superagent-service.ps1 status` 正常（pid 27312、端口 3082、health 无 error）。
- 端到端验证（2026-11-16 20:47）：20:34 已用改后服务脚本重启宿主（pid 11544）；再以 `codex-relay/gpt-6.1-sol`
  子代理实测返回 `OK`（首次 400 只是该模型不接受 reasoning effort `none`，不是凭据问题）→ 宿主已能读取 `CRS_OAI_KEY`，codex-relay 可用。
- 生效条件：**每次 `start`/`restart` 时补齐**；20:34 的重启已完成这一步，当前宿主（pid 11544）即带新环境；
  更早的宿主（16:23）不会热更新。
- 不覆盖：已经运行的宿主；绕过服务脚本、由其他程序直接 `dsh --profile superagent` 拉起的宿主（本机当前未见此路径），
  以及 openclaw 网关自身的 env（如网关模型也缺 key，需要时同样在网关启动脚本里调用本 helper）。

## 11. 证据索引

- 运行链路：`C:\Users\wwm_1\.dsh\profiles\superagent\.artifacts\service-20261116T162301.out.log`、`service.pid`
- 启动入口：`D:\src\dsh\dsh-superagent-service.ps1`（start 分支 `Start-Process` 157 行）、`D:\src\dsh\dsh-default-startup.ps1`、
  Startup 文件夹 `DSH-Default-Startup.cmd` / `OpenClaw-Gateway.cmd`
- 启动环境：`dsh-app-boot/lib/index.js` `loadLayeredEnv`（约 3736 行）；`dsh-launch-environment/lib/index.js`
- 凭据：`dsh-credentials-local/lib/index.js` `resolve`（480 行）；`~/.dsh/.credentials.yaml`
- 子进程过滤：`dsh-subprocess/lib/index.js` `SENSITIVE_ENV_PATTERN`（32 行）、`scrubbedParentEnv`
- 配置指针：`~/.dsh/profiles/superagent/cordis.patch.yml` 246-250 行（`apiKeyEnv: CRS_OAI_KEY`）
- 既有诊断：`docs/ops/codex-relay-credential-missing-20261113.md`（结论一致；其 3.4 节方法需按 2.4 修正）
- 健康检查：`tools/superagent_health/service.py`（只探活，不重启）
