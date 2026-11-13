---
origin: self
owner: wang
author: wang
created: 2026-10-20
updated: 2026-11-06
version: 0.3.1
asset-type: prompt
source: dsh-ynm3000
skillhub-source: not-managed
---

# 引导 prompt：新设备下载 DSH 仓库群并一键恢复配置

> 用法：在新设备的 AI 代理（任意有 shell 权限的 CLI 代理）里整段粘贴下面的 prompt。
> 它覆盖：装依赖 → 装 DSH → 克隆本总仓库（仓库群）→ 从共享盘一键恢复 → 验收。
> 没有共享盘的设备不用本 prompt，改让 AI 读 `dsh-config-pack/docs/AI-DEVICE-SETUP.md`。

## 可直接执行的 prompt

# 任务：新设备从零安装 DSH 并跨设备还原配置（前导同步）

你在一台新的 Windows 设备上工作。这台设备**还没有安装 DSH**。你的职责：装好依赖与 DSH，
把插件/配置源码同步下来，然后从共享盘答案完成一键还原，最后按清单验收。
逐步执行，每步先检查是否已完成（幂等），完成一项报告一项再进行下一项。

## 背景（渠道纪律，必须遵守）

- 通用配置唯一发布源：Git `Robert-Wang-08/dsh-config-pack`（tag 发布，当前 v0.10.4）。
- 设备个人答案的**参考位置**在云盘（如坚果云）的 `dsh-device\device.env`（只有变量名/路由名，**没有密钥值**）。
  若你自己另有个人数据同步盘，请按同样的命名放置：`dsh-device\device.env`，可选同目录
  `device-answers.json` / `route-config.json`——`setup.ps1` 按此约定读取，不硬编码盘符。
- 密钥只进用户环境变量；**绝不**把密钥写进 device.env、route-config.json、任何文件或 Git。
- `.credentials.yaml` 不跨设备，不从共享盘找它；密钥在 setup 交互时输入。
- 全程不要 `git push`，不要手改 profile 的 `package.json`，插件增删只用 `dsh plugin` 命令。

## 路径约定（隐私：先替换再执行）

下文出现的 `D:\src\dsh`（仓库根）与 `D:\nutstore\Skill+Tool\skillhub`（云盘根）只是**源设备的安装实例（示例）**，不是规定位置，也不要原样照抄进本机或报告。执行前先确定本机实际路径并全程替换：

- `<仓库根>` = 第 4 步 clone 本总仓库的目标目录（安装实例：`D:\src\dsh`）；
- `<云盘根>` = 第 3 步定位到的云盘同步根（安装实例：`D:\nutstore\Skill+Tool\skillhub`）。

## 步骤

1. **前置检查**（缺什么装什么）：
   - `git --version`；`pwsh --version`（需 PowerShell 7，缺则 `winget install Microsoft.PowerShell`）；
   - `node --version`（建议 nvm-windows + v24.18.0，与源设备一致）；
   - `pnpm --version`（缺则 `npm i -g pnpm`）。
2. **安装 DSH（钉版本）**：`npm install -g @deepseek-ai/dsh@0.2.1-rc.5`，然后 `dsh --version` 确认。
   （npm `latest`/`next` 当前即此版；另有 `alpha` 频道的 `0.2.2-alpha.*`，本流程不跟 alpha。）
3. **定位云盘**：找到云盘（如坚果云）同步根下含 `dsh-device\device.env` 的目录，记为 `<云盘根>`
   （源设备安装实例：`D:\nutstore\Skill+Tool\skillhub`，本机盘符可能不同）。
   若云盘未登录或该目录不存在，**停下来问用户**，不要猜路径。
4. **克隆总仓库**（仓库群入口，含全部插件子仓库与本引导文件），目标目录记为 `<仓库根>`：
   ```powershell
   git clone --recurse-submodules https://github.com/Robert-Wang-08/dsh-ynm3000.git <仓库根>
   git -C <仓库根> submodule status   # dsh-config-pack 应在 v0.10.4 对应提交或更新
   ```
   输出里应含 7 个 submodule：`dsh-archived-sessions`、`dsh-config-pack`、`dsh-permission-compat`、
   `dsh-plugin-provider-badge`、`dsh-plugin-sidebar-visibility`、`dsh-provider-failover`、
   `dsh-wechat-hitl`。行首是 `-` 表示未初始化（补 `git -C <仓库根> submodule update --init <path>`），
   `+` 表示工作区与记录不一致。
   （源设备安装实例：`<仓库根>` = `D:\src\dsh`。）
   注意：不要去找源设备 `D:\src\ynm3000` 下的旧路径——那里的残留与本安装无关，插件的权威副本在本总仓库里。
5. **一键还原**（读共享盘答案 → 设 DSHPACK_* 用户环境变量 → 写路由 → 装包进 profile `packed`
   → 默认补装可选三方插件组）：
   ```powershell
   pwsh -File <仓库根>\dsh-config-pack\scripts\setup.ps1 `
        -SharedRoot <云盘根>
   ```
   - 不传 `-Source` 即自动取远端最新 tag（install.ps1 内置解析）；只有要钉死版本时才显式传
     `-Source 'github:Robert-Wang-08/dsh-config-pack#vX.Y.Z'`。
   - 可选三方插件组（`dsh-recent-sessions`、`dshmarket`、`dsh-plugin-subagent-director`、
     `dsh-palette`）**默认安装**；用户明确不要时加 `-SkipOptional` 整组跳过。
   - 提示 `DSHPACK_KEY_*` 时输入真实密钥（直接回车=跳过，之后可手动补用户环境变量）。
   - **provider 配置自动迁移**：setup/install/update 会调 `migrate-providers.ps1`，把旧 `DSHPACK_BASE_*`/`DSHPACK_KEY_*`、
     共享盘 `device-answers.json` 的 `providers` 与 `cordis.local.yml` 合成**完整** `llm-pi-ai` 字面量配置写入 profile 补丁
     （写前备份 `cordis.patch.yml.bak-before-provider-migration-<时间戳>`）。`apiKeyEnv` 只写变量名；形似密钥的值会被拒绝。
     验收：`pwsh <仓库根>\dsh-config-pack\scripts\migrate-providers.ps1 -ProfileName <profile> -Check`；
     回退：停掉 DSH，恢复同一时间点的 `cordis.patch.yml` 与 `.provider-migration.json` 备份。
     装的是仓库源码（`link:`/junction）时，先在该仓库根 `npm install`（迁移脚本依赖 `yaml`，tag 安装由 pnpm 自动装）。
   - 若报 `ERR_PNPM_EXOTIC_SUBDEP` / `ERR_PNPM_IGNORED_BUILDS`：install.ps1 会自愈重试；
     仍失败时把完整报错给用户，不要手改配置硬闯。
   - **总仓库里的本地插件不随 `setup.ps1` 自动登记**（config-pack 只管它自己那套 bundle），
     需在还原之后逐个 `dsh plugin add`，源码直接来自本仓库、代码不复制：
     ```powershell
     dsh plugin --profile <profile> add <仓库根>\dsh-subagent-acp-resilient
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-ptc-switches
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-subagent-monitor
     dsh plugin --profile <profile> add <仓库根>\dsh-plugin-new-session
     ```
     逐个 add：参数顺序即 bundle 顺序，不要与 config-pack 混在同一次调用里。
     登记后 `git -C <仓库根> pull` 即更新这些插件，**不需要重新 add**。
     确认方法：`dsh plugin --profile <profile> list` 里能看到它们，且
     `dsh --profile <profile> --dump-config` 无 `patch: entry ... not found`。
    - **可选：内嵌浏览器（会话界面右侧栏的浏览器 tab）**——`dsh-embedded-browser` 0.3.0，装的是 npm 包，不是本仓库子模块。
     Chromium 跑在 DSH 宿主里，每个会话一个标签页；AI 用 `browser_embedded_*` 经 CDP 驱动，人在右侧栏同一个标签页接管（登录/扫码/短信码/CAPTCHA）。
     Windows 上下面两步都不能省，缺任一项装了也不工作：
     ```powershell
     dsh plugin --profile <profile> add dsh-embedded-browser
     ```
     再在该 profile 的 `cordis.patch.yml` 末尾追加（`config` 是整键覆盖，只写要改的字段即可）：
     ```yaml
     - id: embedded-browser
     config:
       browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'   # 上游只探测 Linux 名字与 ~/.cache，Windows 必填
       lazyTools: false                                   # 没装 browser-use 技能时门闸不会开，工具永远不发布
     ```
     验收：`dsh --profile <profile> --dump-config` 里出现 `- id: embedded-browser` 且带 `lazyTools: false`；
     重启 DSH 后 `GET http://127.0.0.1:3080/api/dsh-embedded-browser/health` 返回 `{"ok":true,"version":"0.3.0",...}`；
     新开会话让 AI 调 `browser_embedded_navigate`，右侧栏会自己弹出该会话的 Browser tab。
     回退：`dsh plugin --profile <profile> remove dsh-embedded-browser`（`%USERPROFILE%\.dsh\embedded-browser\profile` 保留，登录态不丢）。
    - **远程访问 `ds-harness-remote`：2026-11-12 已登记「不再使用」，不要装**。本机实测结论：它以 Host 身份把本机会话/工作区开放给云端账号下的其他设备（第三方控制面 `dsh.r2049.cn` + Noise 端到端数据面），默认 `terminal`/`remoteTools`/`hostControl`/`codex`/`acp` 全开，**配对一台设备等于交出 Host 全权**（含远程终端、文件上传、代签审批、可把沙箱切到 `danger-full-access`）。若确需重装：按 §4.7 先测试 profile 后生产 profile、先停宿主再 `add`，并在 `cordis.patch.yml` 里把这些能力显式关到最小；卸载后还要删 `%USERPROFILE%\.dsh\ds-harness-remote`（设备私钥与服务器凭据）并在账号侧吊销设备。
   - **`dsh-wechat-hitl`（微信人工确认回环）不走 `dsh plugin add`**：源码在
     `<仓库根>\dsh-wechat-hitl\pkg\dsh-wechat-hitl`，运行时必须是 profile `node_modules` 下的
     **目录副本**，再由该 profile 的 `cordis.patch.yml` 挂载：
     ```powershell
     $src = '<仓库根>\dsh-wechat-hitl\pkg\dsh-wechat-hitl'
     $dst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-wechat-hitl"
     New-Item -ItemType Directory -Force -Path $dst | Out-Null
     Copy-Item "$src\*" $dst -Recurse -Force
     node <仓库根>\dsh-wechat-hitl\tools\switch-hitl.mjs --state running --profiles <profile>
     ```
     - `switch-hitl.mjs` 的 patch 路径跟随 `DSH_HOME`（缺省 `~/.dsh`），**换设备不用改代码**；写前自动留 `.bak-before-switch-<ts>`。
     - 只装 DSH 侧插件时**不要**跑网关脚本（`tools/restart-gateway.ps1`、`tools/apply-*.ps1` 属 OpenClaw 网关侧，见 `dsh-wechat-hitl/AGENT-USAGE.md`）。
     - 验收：`node <仓库根>\dsh-wechat-hitl\tools\switch-hitl.mjs --show` 的 `patchMounted` 各 profile 均 `present: true`（重复跑 `--state running` 应为 `action: unchanged`）；`dsh --profile <profile> --dump-config` 含 `- id: wechat-hitl` 且无 `patch: entry ... not found` / `did not activate`。
     - 回滚：`node <仓库根>\dsh-wechat-hitl\tools\switch-hitl.mjs --state stopped`（摘挂载 + 留备份），或直接删掉 profile `node_modules` 下该目录。
     - **已知设备字面量（换设备必须改）**：`lib/hitl-store.js` 的 `PROD_STATE_DIR`（捕获包副本回落用的规范绝对路径，源设备 `D:\src\dsh\dsh-wechat-hitl\state`）、`PATHS.workdir`（源设备 `D:\nutstore\1.logseq`）、`workspaceKey`、`PATHS.node`（源设备 `C:\openclaw-runtime\node.exe`）。日常可先用 `DSH_WECHAT_HITL_STATE` 整体覆盖状态目录，不必改代码。改完跑 `node <仓库根>\dsh-wechat-hitl\test\switch.test.mjs`（期望 15 pass / 0 fail）。
5b. **多 profile 全量还原（可选）**：`setup.ps1` 只建/装**一个** profile（默认 `packed`）。
    若要把源设备的**整套** profile（`web`、`superagent`、`plugtest`、`sa-local`、`web-restore`、
    `acp`、`headless`、`focushub-dev`、`packed`）一起搬过来，用配置包的多 profile bundle（v0.11.7 起）：

    ```powershell
    # 源设备：全部 profile 打成一个 bundle → <源设备 ~/.dsh/backups/dsh-backup-<时间戳>>
    pwsh -File <源设备仓库根>\dsh-config-pack\scripts\dsh-backup.ps1 backup -AllProfiles

    # 目标设备：先出计划（不写），确认后再写回（逐 profile 先写 pre-restore-<时间戳>）
    pwsh -File <仓库根>\dsh-config-pack\scripts\dsh-backup.ps1 restore -AllProfiles `
         -Snapshot "<拷过来的 dsh-backup-<时间戳> 目录>"
    pwsh -File <仓库根>\dsh-config-pack\scripts\dsh-backup.ps1 restore -AllProfiles `
         -Snapshot "<同上>" -Apply -AllowPartial
    ```

    - **默认 profile 不变**：`bundle.json` 只记录 `default_profile`（源设备是 `web`），恢复后照旧
      `dsh web` 启动；不会把默认切到 `packed` 或别的 profile。
    - 每个 profile 仍是标准 `dsh-snapshot/v1`，可单独重放：`restore -Snapshot <bundle>\profiles\<profile>`。
    - `link:` 依赖仍指向源设备检出路径——目标设备仓库克隆路径必须一致，否则按第 5 步重新
      `dsh plugin add`（已知跨设备差异，不是快照缺陷）。
    - **写回前先停目标设备上正在跑的 `dsh web`**，避免热重载层栈打断正在进行的会话回合。
    - 仓库根目录的 `dsh-restore.ps1` 是上面两步的封装（自动取最新 bundle、写回前体检 `link:` 路径、
      写回后打印验收步骤），换机时推荐直接用它：
      ```powershell
      pwsh -File <仓库根>\dsh-restore.ps1 -Snapshot "<拷过来的 dsh-backup-<时间戳> 目录>"
      pwsh -File <仓库根>\dsh-restore.ps1 -Snapshot "<同上>" -Apply -AllowPartial
      ```
5c. **superagent profile（独立服务，端口 3082）**：它是**独立的 DSH profile + 独立端口**，与日常用的
    `web` 隔离，不影响 3080。要点（完整步骤与实测输出见 [docs/ops/superagent-profile.md](../ops/superagent-profile.md)）：
    - 子模块已登记：`dsh-superagent` 指向 `https://github.com/deepseek-ai/dsh-superagent-prototype.git`。
      新设备 `git submodule update --init dsh-superagent` 后**必须构建**：
      `pnpm install --node-linker=hoisted && pnpm build`（isolated linker 下 `pnpm build` 报
      `Cannot find package 'ansis'`；`lib/` 是 gitignored 产物）。
    - profile 是**从 `web` 复制**的（package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml /
      pnpm-lock.yaml / .npmrc / patches/），再在 `cordis.patch.yml` 末尾追加 `webserver`(3082) 与
      `dsh-superagent`(`stateDir`)；不要用 `--from-default-profile` 覆盖，那会丢掉本机层。
    - 登记：`dsh plugin --profile superagent install` → `dsh plugin --profile superagent add "link:<仓库根>/dsh-superagent"`，
      再把 `dsh-superagent` 移到 `dsh.profile.bundles` 里 `dsh-config-pack` **之前**。
    - **必须打补丁**：`pwsh -File docs\ops\patch-dsh-superagent.ps1 -Mode apply`（不打 `stateDir-windows-absolute`
      会 `did not activate`，服务壳在但 orchestrator 永不就绪）。
    - 启停：`pwsh -File dsh-superagent-service.ps1 start|stop|status`。验收：3082 监听 + `status` 显示
      `health : no error entries` + `GET /orchestrator/api/state`（带头 `x-orchestrator-request: 1`）返回 200；
      `setup : github/repositoryUnset` 属**首次启动的正常状态**，去面板填仓库与 gh CLI 后才开始轮询。
6. **注册 git 巡检自动化（推荐）**：确认脚本已随本仓库 git pull 就位后，先看计划，再去掉 -DryRun 注册；巡检独立于 superagent，服务停机也可运行：
   ```powershell
   pwsh -NoProfile -File <仓库根>\dsh-git-watchdog-register.ps1 -DryRun
   pwsh -NoProfile -File <仓库根>\dsh-git-watchdog-register.ps1
   ```
   验收：Start-ScheduledTask -TaskName 'DSH-Git-Watchdog' 后看 <仓库根>\.ptc\reports\git-watchdog-*.json；移除用同一脚本 -Remove。配置与铁律见 [git 巡检运维说明](../ops/git-watchdog.md)。
7. **安装后偏差比较验收**（install.ps1 第 4.6 步已自动跑过一次；手动复核用同一条命令）：
   ```powershell
   node <仓库根>\dsh-config-pack\scripts\verify-install.mjs --profile packed
   # 可选：对拍另一台设备的观察基线（逐包版本 + 采样文件 SHA256）
   node <仓库根>\dsh-config-pack\scripts\verify-install.mjs --profile packed `
        --baseline <仓库根>\docs\verification\new-device-packed-observed-20261020.json
   ```
   预期：核心件全 ok、可选组默认已装、bundle 登记齐全、composed 0 dangling、
   无 `did not activate` / `patch entry not found`。
   判读：missing(核心件) 必须处理；optional missing 若因 -SkipOptional 属预期；
   shadowing / 设备字面量 / 偏好差异属已知设备差异，不算失败。
   **若 `dsh plugin` 报 `ERR_PNPM_UNEXPECTED_STORE` 或 `ERR_PNPM_PREPARE_PACKAGE`**：
   这是 pnpm store 与本机 profile 的 `.modules.yaml` 记录不一致，按
   `docs/bootstrap/pnpm-store-与重链.md` 先统一 store 再重链该 profile，然后回到本步骤。
8. **生效**：关掉 DSH 重新打开（首次直接 `dsh web` 启动，默认 http://127.0.0.1:3080），
   **新开一个会话**（工具表在会话启动时冻结，旧会话看不到新工具），
   在新会话里实际派发一次子代理验证路由可用。
9. **报告**：列出实际使用的共享盘路径、profile 名、config-pack tag、可选组安装结果、
   验收三项输出摘要；如有跳过的密钥项，单独提醒用户补。

## 范围外（不要主动做）

- SkillHub skills 跨设备同步（junction/`sync publish`）不在本次范围，用户提出再说；
- 不装 dsh-backup-restore 的本机快照（那是源设备同机恢复用的，与跨设备无关）；
- 不改 DSH 本体、不动 `C:\Users\<用户>\.dsh` 里本任务未涉及的文件；
- 只读审计类任务（对照基线核对偏差）另有专门 prompt：
  `docs/verification/PROMPT-另一设备核对DSH同步偏差.md`。
