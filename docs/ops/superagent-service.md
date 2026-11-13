# superagent 独立服务（profile `superagent`，端口 3082）

> 状态（2026-11-05）：已完成 web profile 插件与配置集成，服务已在 `127.0.0.1:3082` 独立运行。
> 管理入口：根目录 `dsh-superagent-service.ps1`（启停/状态）；同步入口：`dsh-superagent-profile-sync.ps1`。

## 1. 这个服务是什么

`dsh-superagent` 是「一个 GitHub 仓库的主动型编码代理」以 DSH bundle 形式提供的服务：监听 GitHub（可选飞书）请求，按 Policy 判定后开 Ticket，每个 Ticket 在自己的 DSH 会话与目录里执行。它自带两个专用 agent 预设（`dsh-superagent-worker` / `dsh-superagent-router`），面板走 `/orchestrator/api`。

它必须**独立于日常工作的 profile**运行：插件会改进程级 PATH 与 git 配置，且需要单独重启、单独升级。本机因此使用 `superagent` profile + 端口 3082 + 独立 stateDir，与 3080 的 `web` 实例完全隔离（互不重启、互不共享进程）。

## 2. 集成范围（本机决定）

superagent 官方要求它是 Web profile 的副本。本机在此之上让它**继承 web profile 的全部插件与个性化配置**，使它和 3080 实例拥有同一套能力面：

| 层 | 内容 | 来源 |
| --- | --- | --- |
| bundles | web 的 26 个 bundle + `dsh-superagent`（共 27） | web `package.json` 的 `dsh.profile.bundles`，按原顺序，`dsh-superagent` 收尾 |
| dependencies | web 的 27 个依赖 + `dsh-superagent`（`link:D:/src/dsh-superagent`，共 28） | 同上 |
| 模型 provider | `ais-2dsglm` / `codex-relay` / `kimi-coding` / `opencode-go` / `anthropic-relay` / `tokeniss` / `claudetokeniss25` 与默认模型 | web `cordis.patch.yml`（整份复制） |
| MCP / PTC / 子代理 | codegraph、ticktick、ACP 三档、PTC bundle、subagent-director、taskboard、task-supervisor、dashboard、ui-progress、provider-badge、sidebars 等 | 同上 |
| 安装输入 | `vendor/dsh-worktable-0.5.0.tgz`、`patches/`（claude-code 补丁）、`compatibility.json`、`pnpm-lock.yaml` | 从 web profile 复制 |

自有覆盖只有 4 处（写在 `cordis.patch.yml` 末尾，按 id 覆盖、config 整体替换）：

| 条目 | 覆盖 | 原因 |
| --- | --- | --- |
| `webserver` | `host 127.0.0.1` / `port 3082` | 与 3080 的 web 实例分开 |
| `dsh-superagent` | `stateDir: C:/Users/wwm_1/.dsh/state/superagent` | 插件强制要求绝对路径；数据库/锁/worker-bin 都在这里 |
| `embedded-browser` | `profileDir: .../embedded-browser/profile-superagent` | 两个实例不共用 Chrome user-data-dir，避免争用 |
| `wechat-hitl` | `disabled: true` | 两个实例同用一份微信网关队列，避免重复应答；要启用就改这一行 |

web profile 本身**没有被修改**（只读取）。

## 3. 日常操作

```powershell
# 状态（pid / 端口 / 面板 URL / 队列 / 健康）
pwsh -File dsh-superagent-service.ps1 status

# 启动（已在跑则直接返回；日志写 profiles/superagent/.artifacts/service-<ts>.{out,err}.log）
pwsh -File dsh-superagent-service.ps1 start

# 停止（结束该 node 进程；正在跑的 Executor 回合会被中断）
pwsh -File dsh-superagent-service.ps1 stop

# 只打印面板 URL（带 token，日志里能查到）
pwsh -File dsh-superagent-service.ps1 url
pwsh -File dsh-superagent-service.ps1 logs
```

面板 URL 形如 `http://127.0.0.1:3082/?token=<一次性 token>`：服务启动时打印在 `.artifacts/service-*.out.log` 的 `dsh web:` 行。裸 `GET /` 返回 401 属正常——必须先带 token 建立 cookie，之后同浏览器即可直达。

**状态锁**：dsh-superagent 用 `proper-lockfile` 同步锁住 stateDir（`~/.dsh/state/superagent.lock`），且没有重试。硬停会留下这个锁目录，导致下次启动报 `dsh-superagent: Error: Lock file is already being held`、`orchestrator` 不激活、API 404。`dsh-superagent-service.ps1` 的 `stop` 与 `start` 都会在确认无监听后清理该锁；手工重启失败时先删掉 `superagent.lock` 再启动。

## 4. 验收（改完/重启后按顺序跑）

```powershell
pwsh -File dsh-superagent-service.ps1 status      # port listening + health 无 error 条目
node <dsh>/lib/bin.js --profile superagent --dump-config > /dev/null   # 组合层可解析
Invoke-WebRequest "http://127.0.0.1:3082/orchestrator/api/state" -Headers @{'x-orchestrator-request'='1'}  # 200
```

本次落地证据（2026-11-05）：

- `dump-config`：exit 0，508 个条目，`port: 3082` 与 `stateDir` 各命中 1 次，stderr 为空
- `/orchestrator/api/state`：200；`health` 无 error 条目；`load.maxWorkers=3`；`setup.problem=github/repositoryUnset`（尚未配置仓库，属预期）
- 进程：`pid 29892`，端口 3082 监听；3080 的 web 实例不受影响（仍 401/正常服务）

## 5. 同步 web 的新插件/新配置

web profile 以后新增插件或改模型配置时，superagent 不会自动跟随。重跑同步脚本即可（幂等，先备份）：

```powershell
pwsh -File dsh-superagent-profile-sync.ps1
# 然后重启 superagent 服务加载新工具表
pwsh -File dsh-superagent-service.ps1 stop
pwsh -File dsh-superagent-service.ps1 start
```

脚本做的事：备份 → 复制 `vendor/ patches/ compatibility.json pnpm-lock.yaml` → 由 web 的 `package.json` 生成依赖与 bundle 顺序（`dsh-superagent` 收尾）→ 由 web 的 `pnpm-workspace.yaml` 生成安装规则 → `cordis.patch.yml = web 全量 patch + 上述 4 处覆盖` → `pnpm install` → `--dump-config` 校验。

注意：

- 覆盖段落由脚本整段重写，不要在 `cordis.patch.yml` 里手工加东西（会被覆盖）；要长期追加请改脚本里的 `$own`。
- `dsh-superagent` 用 `link:` 指向 `D:/src/dsh-superagent`，改源码后需要在该仓库 `pnpm build`（bundle 读 `lib/`）。
- 每次同步都留一份 `%USERPROFILE%\.dsh\backups\superagent-pre-web-integration-<UTC>\`（含 `MANIFEST.json` 与 web 侧文件哈希）。

## 6. 与 3080 web 实例的差异

| 项 | web（3080） | superagent（3082） |
| --- | --- | --- |
| profile | `web` | `superagent` |
| 端口 | 3080（默认） | 3082（patch 覆盖） |
| 额外 bundle | — | `dsh-superagent`（+2 个专用 preset） |
| stateDir | — | `~/.dsh/state/superagent`（sqlite + worker-bin + work） |
| 内嵌浏览器 Chrome profile | `~/.dsh/embedded-browser/profile` | `~/.dsh/embedded-browser/profile-superagent` |
| wechat-hitl | 启用 | 关闭 |
| 会话/工具表 | 各自独立 | 各自独立 |

## 7. 已知限制与风险

1. **未配置 GitHub 仓库/执行器**：`setup.problem=github/repositoryUnset`，`runtime` 处于 `paused`，此时不会轮询、不会干活。按 `dsh-superagent/docs/006-deployment.md` 的 Settings 一节在面板里配 Source / Policy / Execution / Prompts。
2. **codegraph MCP 启动报错**：`err.log` 有 `error: the argument '--mcp' cannot be used multiple times`（codegraph 二进制自己已加 `--mcp`）。这是从 web 继承的同一份配置，web 侧同样如此，不是本次引入；修法是从 `mcp-codegraph` 的 `args` 去掉 `--mcp`。
3. **面板需要 token**：`GET /` 无 cookie 一律 401；用 `status`/日志给出的带 token URL 打开一次即可。
4. **停止是硬停**：Windows 无 SIGTERM，`stop` 用 `Stop-Process -Force`，正在执行的 Ticket 会中断（重启后由 dsh-superagent 的重启恢复语义兜底）。
5. **微信回环关闭**：需要 superagent 也走微信审批时，把 `cordis.patch.yml` 里的 `wechat-hitl.disabled` 改成 `false` 并重启（注意两个实例共用同一网关队列的重复应答风险）。
6. **依赖安装需要网络**：`dshmarket`（codeload tar）与 `dsh-recent-sessions`（github:）走外网；离线环境同步会失败，会保留旧 `node_modules` 并报错退出。
7. **每小时巡检不在本 profile**：`docs/006-deployment.md` 要求把巡检放在日常 profile（web），不放在 superagent。本机尚未创建该巡检。
8. **superagent 数据库版本**：`stateDir/orchestrator.sqlite` 由 `0.1.0` 建立；升级/回滚按官方文档先备份该文件。
9. **部署检查报「机器人的 lark-cli 不可用」+ `env: 'env': No such file or directory`（2026-11-10 修好）**：上游 `workerProbe` 把 PATH 拼成 argv 前缀 `env PATH=…`，飞书检查再套一层 `env VAR=…`；Windows 没有 POSIX `env`，Git for Windows 的 MSYS `env` 又无法用 Windows 风格 PATH 解析内层命令，于是内层 `env` 找不到自己 → exit 127。修法（源码级，重建不丢）：`src/deployment.ts` 去掉 `env` 前缀，PATH 与 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER`/`…_SKILLS_NOTIFIER` 改由子进程 env 字典传递（显式 env 会合并到运行时已脱敏的环境）。验收：`health.feishu=ready`、`settings.sources[feishu].problem=null`。**仍会报的残留**：`health.reply=error … (2200)` —— 机器人已换成 `cli_aa67e4041a381c02`，而排队待发的回复指向旧机器人建的 p2p 会话 `oc_eae25b93a93612f82042deb68704e2af`（该会话 `bot_count=0`），新机器人不在其中发不进去；需先用新机器人（`superagent-飞书bot`）聊一次建立新会话，旧队列另行清理。
10. **重建插件可能让编排面整体消失（`tools.restrict` + Windows 没有 `bash`）**：症状是 `status` 打印 `state : ERR ... 404`、面板打不开、err.log 出现 `dsh: warning: 3 entries did not activate` 与 `dsh-superagent (...) RemoteError: resume failed for session "orchestrator-..." ... tools.restrict() names unknown global tool "bash"`，`/orchestrator/api/*` 全 404（而 `sa-local` 3083 同为 200，可作对照）。原因：`src/app/sessions.ts` 主会话工具白名单把 `bash` 写死，而 Windows 上预设把 `tool-bash` 设为 `disabled`，`restrict()` 拒绝未知工具名 → 插件 apply 失败 → `/orchestrator` 前缀路由根本没注册，进程只是「Web 壳还活着」。修法（2026-11-10 已打）：把该数组改成按宿主实际存在的工具过滤 `['skill','bash','read','read_image','job_output','job_list','job_kill'].filter(name => agent.ctx.tools.get(name))`，然后 `pnpm typecheck && pnpm build` + `dsh-superagent-service.ps1 stop/start`；验收看 `/orchestrator/api/state` 返回 200、`health.runtime=ready`。注意该补丁只在本机工作树里（未提交上游 `deepseek-ai/dsh-superagent-prototype`），`git checkout` 会丢掉；另见 `lib/index.js.bak-before-bashfix-*` 备份。

## 8. 回滚

```powershell
# 1) 停服务
pwsh -File dsh-superagent-service.ps1 stop
# 2) 取最近一次同步前备份
Get-ChildItem "$env:USERPROFILE\.dsh\backups\superagent-pre-web-integration-*" | Sort-Object Name -Descending | Select-Object -First 1
# 3) 把备份里的 profiles/superagent/* 覆盖回 $env:USERPROFILE\.dsh\profiles\superagent\
# 4) 重新安装依赖（快路径）
Push-Location "$env:USERPROFILE\.dsh\profiles\superagent"; pnpm install; Pop-Location
# 5) 重新按第 4 节验收
```

## 9. 下一步唯一动作

在浏览器打开 `dsh-superagent-service.ps1 status` 打印的 3082 URL，进入 **Superagent** 侧栏，按 `docs/006-deployment.md` 的 Settings 配置 GitHub Source（仓库 `owner/name` + 代理账号 CLI）与 Execution（目录 + prepare 命令）。配置前 `runtime` 会一直显示 `setupPending`，这是预期行为。

## 附录 A：浅色护眼绿外观

superagent profile 额外挂载本机插件 `dsh-plugin-superagent-appearance`（源码 `D:/src/dsh/dsh-plugin-superagent-appearance`，`link:` 登记），只在 **浅色主题** 生效：

- 实现：host 侧监听 `webserver/index-inject`，向页面 `head` 追加一条 `<style>`，用 `body:not([data-ds-dark-theme])` 限定作用域覆盖设计令牌。不改任何官方包。
- 预设（profile patch 的 `config.preset`）：

| preset | 画布 | 说明 |
| --- | --- | --- |
| `soft`（默认） | `#eaf6ea` | 浅薄荷绿，最淡，长时间阅读首选 |
| `classic` | `#c7edcc` | 经典豆沙绿 RGB(199,237,204)，民间最流行的护眼色，偏深 |
| `paper` | `#e3edcd` | 青草绿，常见护眼配色清单里的黄绿变体 |

改预设只动 `dsh-superagent-profile-sync.ps1` 的 `$own` 里那一行 `preset:`，重跑同步脚本并重启服务。

参考依据（2026-11 联网核对）：

- 豆沙绿 `#C7EDCC` = RGB(199,237,204)，色调 85 / 饱和度 123 / 亮度 205，[腾讯云开发者社区](https://cloud.tencent.cn/developer/article/1392514)；[维基百科「豆沙绿」](https://zh.wikipedia.org/zh-cn/%E8%B1%86%E6%B2%99%E7%BB%BF) 同时注明「有利于保护视力」的说法未获科学证实。
- 常见护眼配色清单（青草绿 `#E3EDCD`、杏仁黄 `#FAF9DE`、海天蓝 `#DCE2F1`、葛巾紫 `#E9EBFE`、极光灰 `#EAEAEF`）见[技术栈文章](https://jishuzhan.net/article/1812461396407881730)。
- 浅绿背景对 VDT 阅读绩效的正向影响：[Frontiers in Psychology 2025, Li/Guan/Wu/Bai](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1627013/full)（标题即结论；具体色值与效应量需读全文）。
- 对比度实测（主文字 `#0f1115` / 次要 `#61666b`）：`#c7edcc` 14.77 / 4.53，`#eaf6ea` 16.98 / 5.21，`#f2f9f1` 17.63 / 5.41 —— 越浅对比越高，次要文字的可读性也更好。

验证证据（2026-11-05，preset=soft）：带 token 的面板 HTML 中注入样式位于 boot 样式之后，含 `#eaf6ea` 与 `body:not([data-ds-dark-theme])`，旧的 `#c7edcc` 已不再出现；深色主题未被覆盖。

**关于 bar 图片**：官方 `ui-brand-official` 只提供侧栏品牌 slot，且没有图片配置面（README 明确「这里不存在任何品牌配置面」），换图需要另写一个占据 `sidebar.brand.mark` / `sidebar.brand.name` slot 的浏览器侧插件；本机尚未实现。

## 附录 B：两个命名坑的处置

### B1 `dsh-superagent-local` 会顶替上游

- 实测身份：GitHub 发布包 `dsh-superagent-0.2.1.tgz` 的 **package.json 里 name 就是 `dsh-superagent`**（`author: DeepSeek Harness Team (upstream), local fork maintained by mengzhongjie`），bundle 内的插件 id 同为 `dsh-superagent`。
- 后果：装它等于把 `link:D:/src/dsh-superagent` 换成本地 fork，且两条 bundle 的 `dsh-superagent` 行 id 冲突 → 挂载失败。
- 补充：`dsh-superagent` **不在 npm 上**（`npm view dsh-superagent` → 404），所以只可能来自 `link:` 或 tgz，辨别成本很低。
- 处置（已进同步脚本第 8 步）：
  1. `package.json` 的 dependencies 出现 `dsh-superagent-local` → 直接 throw；
  2. `dsh.profile.bundles` 出现 `dsh-superagent-local` → 直接 throw；
  3. `node_modules/dsh-superagent/package.json` 的 author 含 `local fork` → 直接 throw；
  4. 链接目标必须指向 `D:/src/dsh-superagent`，否则 throw。
- 已经装错时：`rm -r node_modules/dsh-superagent` → 重跑 `dsh-superagent-profile-sync.ps1`。

### B2 `dsh-bridge` 同名不同物

| 实体 | 身份 | 位置 | 作用 |
| --- | --- | --- | --- |
| 本地网关 | OpenClaw 扩展 `dsh-bridge@0.4.1`（`openclaw.extensions`，**没有 dsh 字段**） | `D:/src/dsh/dsh-wechat-hitl/gateway/dsh-bridge`（junction 到 `C:/openclaw-runtime/plugins/dsh-bridge`） | 微信 HITL 的 OpenClaw 侧网关 |
| npm 插件 | `@wenbin_wb/dsh-bridge@2.17.8`（scoped DSH 插件） | npm | DSH 远程控制：手机扫码 + 隧道 + 微信/QQ/飞书/Telegram bot |

- 两者**不会在 npm 层冲突**（一个不在 npm，一个是 scoped 名），冲突只发生在「口头简称」和 `dsh plugin add` 的参数上。
- 处置：装 npm 那个必须写全 `@wenbin_wb/dsh-bridge`；同步脚本第 8 步对未限定 scope 的 `dsh-bridge` 直接 throw。改本地网关名字会打断 OpenClaw 的 junction 与 `dsh-wechat-hitl` 约定，不做重命名。
