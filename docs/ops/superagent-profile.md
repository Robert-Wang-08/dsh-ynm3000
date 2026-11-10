# superagent profile 运维文档（DSH 工作区）

本文记录把 `dsh-superagent` 作为 DSH 工作区子模块纳入、并通过复制 web profile 创建独立 superagent profile、在 `127.0.0.1:3082` 跑起来的全过程与运维要点。适用 profile：`superagent`（`C:\Users\wang\.dsh\profiles\superagent`）。全部事实来自 2026-11-10 本机 Windows 实测。

## 1. 结果

- `dsh-superagent` 已作为子模块登记进 `C:\Users\wang\src\dsh`（gitlink 提交 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`）。
- `superagent` profile 已创建（复制自 web profile），服务已在 `127.0.0.1:3082` 启动。
- 启动日志无 `did not activate`；`/orchestrator/api/state` 返回 HTTP 200，进程与面板正常。

## 2. 前置事实

### 2.1 仓库与基线

- DSH 工作区根：`C:\Users\wang\src\dsh`（git 仓库，origin = `dsh-ynm3000`，分支 `main`）。
- 上游仓库：`https://github.com/deepseek-ai/dsh-superagent-prototype.git`（包名 `dsh-superagent` 0.1.0，`private: true`）。
- 子模块路径：`C:\Users\wang\src\dsh\dsh-superagent`，分支 `main`。
- 本机版本：dsh `0.2.1-rc.5`；node `v22.22.0`；pnpm `v11.9.0`（子模块内 install 时看到 `v11.7.0`）。
- 包要求 engines：node `^22.19.0 || >=24.0.0`，dsh `^0.2.1-alpha.2`（`rc.5` 满足）。
- 旧独立检出 `C:\Users\wang\src\dsh-superagent` 保留未动：同一内容，HEAD `6337fc8`，与上游 main 逐文件一致（`examples/profile.cordis.patch.yml`、`docs/006-deployment.md`、`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`README.md`、`SETUP.md` 的 SHA256 全同）。
- `lib/` 与 `node_modules/` 都在子模块的 `.gitignore` 里（`lib/` 由 `pnpm build` 用 tsdown 生成）。补丁改 `lib/` 不会让子模块变脏（实测 `git status --porcelain` 0 行）。

### 2.2 两个 Windows 坑（本次实测撞到）

1. **`git submodule add` 在本机失败**：报 `sh.exe: fatal error - couldn't create signal pipe, Win32 error 5`（DSH 沙箱禁止命名管道，git 的 submodule helper 要 spawn sh）。绕过方式：先 `git clone` 到目标路径，再用 `git config -f .gitmodules submodule.dsh-superagent.path/url/branch` 写登记项，`git add .gitmodules dsh-superagent` 记录 gitlink（会提示 adding embedded git repository，属预期），最后手工把 `dsh-superagent/.git` 移到 `.git/modules/dsh-superagent` 并写 `gitdir: ../.git/modules/dsh-superagent` 与 `core.worktree`（代替同样被 sh 拦住的 `git submodule absorbgitdirs`）。
2. **`dsh-superagent` 的 `stateDir` 只接受 POSIX 绝对路径**：原样启动报
   `dsh: warning: 2 entries did not activate` +
   `dsh-superagent (dsh-superagent): ValidationError: invalid config: - $.stateDir expect string to match regexp /^\// (at stateDir)`，
   `dsh-superagent-github` 停在 `pending (waiting for service: orchestrator)`。根因是 `src/deployment.ts` 里 `absolute()` 把绝对路径写死成 `/^\//`。修法是补丁 3（放宽成接受 `C:\` 与 `C:/`），见 `docs/ops/dsh-superagent-patches/`。

## 3. 子模块纳入

因第 2.2 节的坑 1，登记流程为：

```powershell
# 1) 克隆到目标路径（代替 git submodule add）
git clone https://github.com/deepseek-ai/dsh-superagent-prototype.git C:\Users\wang\src\dsh\dsh-superagent

# 2) 写 .gitmodules 登记项
git config -f .gitmodules submodule.dsh-superagent.path dsh-superagent
git config -f .gitmodules submodule.dsh-superagent.url https://github.com/deepseek-ai/dsh-superagent-prototype.git
git config -f .gitmodules submodule.dsh-superagent.branch main

# 3) 记录 gitlink（提示 adding embedded git repository 属预期）
git add .gitmodules dsh-superagent

# 4) 手工吸收 .git（代替 git submodule absorbgitdirs）
#    把 dsh-superagent\.git 移到 .git\modules\dsh-superagent，
#    并在 dsh-superagent\.git 文件写 gitdir: ../.git/modules/dsh-superagent，
#    模块 config 里写 core.worktree
```

### 3.1 子模块构建（新设备必做）

```powershell
cd C:\Users\wang\src\dsh\dsh-superagent
pnpm install --node-linker=hoisted   # 默认 isolated 下 pnpm build 会报 Cannot find package 'ansis'（tsdown 依赖解析失败），hoisted 后 build 通过
pnpm build                            # tsdown，产物 lib/ 12 个文件，lib/index.js ≈ 450KB
```

## 4. profile 创建：复制 web，不新建模板

web profile 基线 `C:\Users\wang\.dsh\profiles\web` 被复制的文件：`package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.npmrc`、`patches/`。`package.json` 的 `name` 改为 `dsh-profile-superagent`（原 `dsh-profile-web`）。不复制 `node_modules`。

然后在 superagent 的 `cordis.patch.yml` **末尾追加**（保留 web 原有全部内容）：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: 'C:\Users\wang\.dsh\state\superagent'
```

理由：端口与 web（3080）分开；`stateDir` 是插件必填项；web 的 patch 层另有 MCP / pwsh-sandbox / llm-deepseek / agent-default-model（ais-2dsglm / deepseek-flash）等本机值，必须一并继承。

### 4.1 装包与登记

```powershell
dsh plugin --profile superagent install                                   # 用复制来的 lockfile，7.6s 复用 store
dsh plugin --profile superagent add "link:C:/Users/wang/src/dsh/dsh-superagent"
```

`add` 会把 `dsh-superagent` 追加到 `package.json` 的 `dsh.profile.bundles` **末尾**（在 `dsh-config-pack` 之后）。按本工作区约定“补丁层/配置包必须排最后”，事后把 `dsh-superagent` 移到 `dsh-config-pack` 之前，共 22 个 bundle。

校验：

```powershell
dsh --profile superagent --dump-config
```

退出 0（2588 行），合成树里出现 `port: 3082`、`stateDir: C:\Users\wang\.dsh\state\superagent`、preset `dsh-superagent-worker` / `dsh-superagent-router`，没有 `did not activate` / `not found`。

## 5. 补丁（docs/ops/dsh-superagent-patches/）

| id | target | 修什么 |
| --- | --- | --- |
| `stateDir-windows-absolute` | `lib/poll-*.js` | stateDir 接受 Windows 绝对路径（本次新增，缺了插件不激活） |
| `feishu-probe-no-msys-env` | `lib/poll-*.js` | 飞书检查去掉 MSYS env 前缀（原写死 `lib/poll-xx3wdCx6.js`，本次改为通配） |
| `orchestrator-tools-existing-only` | `lib/index.js` | orchestrator 工具白名单跳过本机不存在的 bash 工具 |

`runner.mjs` 本次加了 target 通配：tsdown 共享 chunk 名字带内容哈希，逐版本改名，写死文件名会 target-missing。

用法：

```powershell
node docs/ops/dsh-superagent-patches/runner.mjs --pkg C:\Users\wang\src\dsh\dsh-superagent --mode verify
node docs/ops/dsh-superagent-patches/runner.mjs --pkg C:\Users\wang\src\dsh\dsh-superagent --mode apply
node docs/ops/dsh-superagent-patches/runner.mjs --pkg C:\Users\wang\src\dsh\dsh-superagent --mode restore
```

注意：**重新 `pnpm build` 会覆盖 `lib/`，必须重跑 apply**；因为 profile 用 `link:` 指向子模块，补丁直接改子模块的 `lib/`，而 `lib/` 是 gitignored，所以子模块不会变脏。

## 6. 启动与验收

服务脚本：

```powershell
pwsh -File dsh-superagent-service.ps1 start    # start|stop|status|url|logs
```

Windows 没有 tmux，用 node 直起 `node <dsh>/lib/bin.js --profile superagent`，端口 3082，state 锁在 `~/.dsh/state/superagent.lock`，日志在 profile 的 `.artifacts/`。

status 实测输出：

```text
pid      : 31984
port 3082 : listening
url      : http://127.0.0.1:3082/?token=...
setup    : github/repositoryUnset
health   : no error entries
load     : running=0 queued=0 maxWorkers=3 paused=False
```

`GET /orchestrator/api/state`（需头 `x-orchestrator-request: 1`）返回 HTTP 200：

- `setup.problem` = `github` / `repositoryUnset` / `"The GitHub Source names no repository."`
- `health.runtime.state` = `paused`（code `setupPending`，Waiting for the deployment check），其余 `relay` / `notice` / `launch` / `delivery` = `ready`
- `load` = running 0 / queued 0 / maxWorkers 3

结论：这是**首次启动的可接受状态**——进程与面板正常，两个 source 等面板里配置 GitHub 仓库（和 gh CLI）后才开始轮询；不是故障。

err 日志只剩 `UNDICI-EHPA` 代理实验性警告与 `SQLite is an experimental feature`，没有 `did not activate`。

## 7. 影响面与回滚

- 不影响正在用的 web profile：web 与 superagent 目录隔离，3080 实测仍监听，复制的 web 文件未被改写。
- 回滚步骤：
  1. `pwsh -File dsh-superagent-service.ps1 stop`
  2. 删 `C:\Users\wang\.dsh\profiles\superagent`（含 `.artifacts`）与 `~/.dsh/state/superagent`
  3. 父仓库 `git rm --cached dsh-superagent` 并还原 `.gitmodules`
- 本次未 commit / 未 push：父仓库里 `.gitmodules` 与 `dsh-superagent` 的 gitlink 已 staged，补丁脚本改动是未暂存状态。

## 8. 仍需人工在面板完成的事

- Sources 里填 GitHub 仓库（owner/name）与 agent 的 gh CLI 路径；Policy 里加允许提单的账号（空名单时所有请求静默丢弃）。
- Feishu source 在本 profile 里保持未启用（bundle 默认 `disabled: true`），本机也没有 lark-cli 配置目录。
- 面板 URL 带 token，重启会变。

> 本文事实来源：2026-11-10 本机实测，命令与输出见正文。
