# AGENTS.md — DSH 工作区约束

> 本文件是 `D:\src\dsh` 工作区的代理行为约束。在此工作区内工作时必须遵守。
> Self-authored AI assets are stamped with `origin: self`, owner, dates, version, and SkillHub source metadata; preserve these fields when copying or syncing.

## 1. 工作区定位

- 本工作区是 **DSH 插件与配置包开发区**：`dsh-config-pack`（通用配置 Git 包）、`dsh-provider-failover`（keypool/failover 插件）及多个本地插件都从这里以 `link:` 方式登记进 DSH profile。
- 基线：DSH `0.2.1-rc.5`；`DSH_HOME = %USERPROFILE%\.dsh`；主 profile `web`（另有 `focushub-dev`、`headless`、`web-restore`）。
- 本目录同时是 DSH 本体源码检出（harness checkout 在 `C:\Users\wwm_1\AppData\Local\nvm\v24.18.0\node_modules\@deepseek-ai\dsh`），不要把两者混淆：改插件/配置在本工作区，改 DSH 本体须走 checkout 并明确说明。

## 2. 工作区地图与插件登记状态

| 目录 | 性质 | web profile 登记状态 |
| --- | --- | --- |
| `dsh-config-pack` | 通用配置 Git 包（发布源 `github:Robert-Wang-08/dsh-config-pack`） | 本体走 Git tag 发布；其 PTC bundle 以 `@local/dsh-ptc-multi-agent-mode` link 登记 |
| `dsh-provider-failover` | keypool/failover 插件（`dsh-deepseek-keypool`） | `link:` 已登记 |
| `dsh-archived-sessions` | 会话归档插件 | `link:` 已登记 |
| `dsh-plugin-sidebar-visibility` | UI 插件 | `link:` 已登记 |
| `dsh-plugin-provider-badge` | UI 插件 | `link:` 已登记 |
| `dsh-plugin-ptc-switches` | UI 插件 | `link:` 已登记 |
| `dsh-plugin-subagent-monitor` | 监控插件 | `link:` 已登记 |
| `dsh-subagent-acp-resilient` | 子代理插件 | `link:` 已登记 |
| `dsh-plugin-new-session` | 会话内创建独立顶层会话的工具插件（配套 skill `new-session`） | `link:` 已登记 |
| `dsh-permission-compat` | 插件 | **未在 web profile 依赖中——改动前先核查是否需要登记/清理** |
| `dsh-wechat-hitl` | 微信人工确认回环：DSH 侧插件 + OpenClaw 网关插件 + CLI + 单测（2026-10-28 从 logseq 库 `70-WorkSpace/wechat-hitl-20261026` 迁入，旧路径保留 junction） | 以目录形式装入 `profiles/{web,headless}/node_modules/dsh-wechat-hitl`，`cordis.patch.yml` 里 `- insert: wechat-hitl` 挂载；未走 `dsh plugin add` |
| `focus-hub` | 独立应用（对应 profile `focushub-dev`） | 非 DSH 插件 |

登记状态以 `~/.dsh/profiles/<profile>/package.json` + cordis 配置的 bundles 顺序为准，**不要凭记忆断言**；核查命令：`dsh plugin --profile web list`。

## 3. DSH 运维 skill 索引（遇到对应任务必须先加载对应 skill）

| 任务 | Skill |
| --- | --- |
| 备份/恢复 DSH 插件与配置；隐私文件备份、找回、初始化 | `dsh-backup-restore` |
| 通用配置 Git 包的定位/安装/升级/回滚、个性化模板、旧 bundle 遗留项 | `dsh-preset-pack` |
| provider 与子代理路由的交互式配置 | `ptc-route-setup` |
| 外部聊天记录转 dsh-chat-import interchange v1 | `dsh-chat-import-convert`（dsh-chat-import 插件内置） |
| Windows 下 DSH sandbox 意外访问拒绝的 ACL 诊断修复 | `diagnose-windows-sandbox-acl`（宿主自带） |
| 本机 git 仓库全量拉取/推送、仓库清单保鲜（新增/消失扫描） | `local-git-sync`（自写，实体在 SkillHub store） |

## 4. 插件登记与变更约束

1. **改动前先备份**：任何 profile 配置（`cordis.yml` / `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml`）或插件清单变更前，先跑 `dsh-backup-restore` 的 `backup`（或至少对单文件做 `.bak-before-<主题>-<时间戳>` 副本，这是本机既有惯例）。
2. **登记入口唯一**：插件增删一律用 `dsh plugin --profile <p> add/remove ...`，不要手改 `package.json` 后指望生效（`reconcile` 只激活新出现的依赖；手改+安装不会登记 bundle）。
3. **三条硬约束**（git 宿主依赖安装时）：
   - profile 的 `pnpm-workspace.yaml` 需有 `blockExoticSubdeps: false`，否则 `ERR_PNPM_EXOTIC_SUBDEP`；
   - `allowBuilds` 按 pnpm 报错的精确 key 放行（本机曾见：`koffi`、`node-pty`、`@deepseek-ai/dsh-subprocess-local`、`@google/genai`、`protobufjs`、`dshmarket@https://...`）；
   - `dsh plugin add` 的参数顺序即 bundles 顺序：**补丁层/配置包必须排最后**，web app 必须显式 add；首次 add 失败后依赖已进 `package.json` 时，必须 `remove` 后重新 `add`。
4. **改完必须验收**：启动无 `did not activate`、无 `patch: entry ... not found`；配置包场景跑 `verify.mjs --composed <dump>` 须 0 dangling；`--dump-config` 回显的是未求值的 `!!js` 源，exit 0 不代表表达式正确。
5. **生效条件**：工具表在会话启动时生成——插件变更后必须重启 DSH 并新开会话，旧会话看不到新工具。
6. **主控会话不能热切换 provider**：失败后必须新建会话按链重选；host failover 不重派子代理（`subagent_codex` 挂了不会自动变 `subagent_codex_relay`）。
7. **插件安装闸门（2026-11-06 事故后新增，硬性）**：
   - **先测试 profile，后生产 profile**：第三方/实验插件一律先装进测试 profile（约定 `plugtest`，端口 3081；未建立时按 live `web` 的 `dependencies`、`dsh.profile.bundles`、`cordis.patch.yml`、`vendor/`、`patches/`、`compatibility.json`、`pnpm-lock.yaml` 复制建立），在那边跑通「启动无 `did not activate`、`--dump-config` 0 dangling、界面入口出现、工具表在新会话里可见」之后，才允许进 `web`。
   - **禁止在活动 profile 上直接改**：`dsh plugin add/remove` 会在该 profile 内跑 `pnpm install` 并改写 `package.json`/bundles，运行中的宿主随之热重载层栈，**会打断该宿主上所有正在跑的会话回合**。改任何有活动会话的 profile 前，先停它的 `dsh web` 进程，改完再起。
   - **安装前先看 `engines.dsh`**：声明范围不含当前 dsh 版本时（现例：`dsh-worktable@0.5.0` 要求 `0.2.0-rc.2 || 0.2.1-rc.3`，当前 `0.2.1-rc.5`），要么升级插件，要么 `dsh plugin allow-version` 显式豁免；否则启动即被 deny，并可能在后续安装中被连带清掉。
   - **装完核对实际版本**：新版本冷却策略会把「最新」降到更旧版本（2026-11-06 实测 `dsh-plugin-sessivra` 想要 `0.3.0-dev.26`，实装 `0.3.0-dev.25`），以 profile `package.json` 落盘值为准，别按 registry `latest` 汇报。
   - **事故留档**：2026-11-06 10:54 在 live `web`（3080）直接 `add dsh-plugin-sessivra` / `add dsh-split-view`，11:11 与 11:21 另有四次非本会话发起的 pnpm 操作，11:35 宿主重启，全部在跑会话中断。证据：`profiles/web/.plugin-manager/logs/operation-*`、`~/.dsh/backups/dsh-backup-20261106-105349`（安装前）、`dsh-backup-20261106-112138-500`（清理后，仍含 `dsh-taskboard`/`dsh-worktable`）。

## 5. 备份与恢复约束（用 `dsh-backup-restore` skill）

- **什么必须备份**：改 profile 配置/插件清单之前；升级 config-pack 或 failover 之前；达到一个"验证通过"的稳定状态之后（留档）。
- **一键入口**：`dsh-config-pack/scripts/dsh-backup.ps1`。`backup` 把当前 profile 写成 `%USERPROFILE%\.dsh\backups\dsh-backup-<时间戳>`；`restore` 默认只打印计划，`-Apply` 前自动写 `pre-restore-<时间戳>`。partial 快照写回要加 `-AllowPartial`。
- **改完配置的一键留档**：`scripts/config-snapshot.ps1`（backup/verify/restore/list）。它只钉住 10 个关键文件（web/plugtest 的 `cordis.patch.yml`+`package.json`、`pnpm-workspace.yaml`、`AGENTS.md`、PTC 的 bundle patch / `public-runtime-config.json` / `SKILL.md` / `ptc_route.py`），带 SHA256 manifest 与 DryRun 回滚，快照写 `~/.dsh/backups/ptc-config-<UTC>`；与上面的整 profile 快照互补，不替代。
- **恢复协议**：先 `restore`（默认 DryRun）给用户看计划 → `-Apply` 时脚本自动先做 `pre-restore` 安全备份 → 重启 DSH 新开会话 → 按第 4 条验收。
- **恢复插件**：配置文件恢复后优先 `pnpm install`（快路径，脚本已为每个 profile 生成 `reinstall-plugins.ps1`）；逐个 `dsh plugin add` 是稳路径，须遵守第 4 条三约束。
- **备份范围**：仅配置与插件数据（profiles 的配置文件、`plugins/` 运行数据、`.agent-presets`、`device/`）；`sessions/`、`attachments/`、`logs/`、`storages/`、`node_modules/` 不备份（会话归档由 `dsh-archived-sessions` 插件管）。

## 6. 隐私与渠道纪律

- **绝不进入 Git 或公共共享载荷**：`~/.dsh/.credentials.yaml`、任何 API key 原值、会话历史、CLI 登录态。对话中也不要回显密钥值。
- **凭据指针模式**：配置里只写环境变量指针名（`requires_env` / `DSHPACK_*`），真实值在用户级环境变量或 `.credentials.yaml`。
- **渠道判定**：通用配置/预设/档位表 → Git `dsh-config-pack`；设备绝对路径、key 指针名、个人路由偏好 → 共享盘 `dsh-device\` 或本机 `~/.dsh/device\`；凭据值 → 哪都不进。
- 隐私文件备份只放 `dsh-backup-restore` 的本机 `private/`；`-Dest` 到用户目录之外需显式 `-AllowPrivateToDest`。

## 7. skill 资产治理（共享盘 store 与项目本体，2026-10-20 拍板）

- **非项目 skill**：统一安装到 `D:\nutstore\Skill+Tool\skillhub\store\installed\<id>`，该位置是唯一物理本体；不安装到 `D:\src\ynm3000\skillhub\store`（dev store）。IDE 入口按需使用 junction / symlink 指向共享盘 store 本体。
- **项目 skill**：权威本体留在所属项目本地目录，由项目维护；不搬入共享盘 store 或 dev store。共享盘 SkillHub store 只保留索引元数据（项目、版本、权威路径、用途、登记时间与背景），不复制技能正文、脚本或资产，不分发本体。
- **PTC 是本项目 skill**：`ptc-multi-agent-control` 的唯一本体为 `D:\src\dsh\dsh-config-pack\packages\dsh-ptc-multi-agent-mode`；由本项目 Git 配置包维护。`%USERPROFILE%\.agents\skills\ptc-multi-agent-control` 如需保留，只能链接到此项目本体。
- PTC 在 `D:\nutstore\Skill+Tool\skillhub\store\installed\ptc-multi-agent-control` 仅保留项目索引，不保留可安装的 `SKILL.md`、`skill.json` 或运行脚本；同时登记到共享盘 store 的 `PROJECT_SKILLS_REGISTRY.md`，从全局安装 `registry.json` 移除并显式设为 `index_only` / `pointer_only`，防止精选或收藏重新启用本体同步。
- 自写资产继续保留 skill-stamp 的出处、owner、创建/更新时间与版本；项目级只改变落点和分发策略，不把自写 provenance 改成第三方。
- 一个 id 只允许一份有效本体。处理旧副本前先比较并备份独有内容，再替换入口或移出安装目录；归档不参与安装、发现或同步。
- 本规则替代此前“自写/内部 skill 统一落 dev store”的约束。其他 skill 的既有落点迁移需单独盘点，不因修改本规则批量移动无关资产。

## 8. 跨设备可更新约束（每次改动都要满足，2026-10-21 拍板）

任何改动合入前先自问一句：**换一台设备，能不能一键拿到这次更新？** 三条硬门槛：

1. **代码类 → Git 更新即生效**：源码进本仓库或对应子仓库并推送。以 `link:` 登记的插件，对方 `git pull` 后重启即得新版，**不得**要求“重新 add”才能拿到代码。禁止把生效必需的东西写进 `~/.dsh` 却指望跨设备自动——那类配置换设备必须手改，等于没交付。
2. **配置类 → 共享盘更新即生效**：设备相关配置（绝对路径、路由偏好、key 指针名）只放共享盘 `dsh-device\`（或本机 `~/.dsh/device\`），不进 Git；通用配置走 `dsh-config-pack` 的 Git tag。改了任何一层配置，都要确认对方设备下一次运行能自动读到，不靠口头同步。
3. **安装性变更 → 必须留一键路径**：凡需要新增/升级/重装依赖、登记新插件、跑迁移或补丁脚本的改动，必须同时交付其一：
   - **一键脚本**（如 `dsh-config-pack/scripts/install.ps1`、批量 `dsh plugin add` 命令）；
   - **说明文档**（`docs/bootstrap/PROMPT-*.md`、`README.md`）写清命令、顺序、回滚与验收，
     使**跨设备的 AI 代理照文档即可完成**，不需要人类补充口头上下文。

判定口径：

- 只改本仓库内代码 → 满足第 1 条即可（`git pull` + 重启）；
- 改 profile 配置 / 插件清单 / 依赖 → 必须同步更新 `README.md` 与
  `docs/bootstrap/PROMPT-新设备装机-引导.md`（或新增等价说明），否则视为未完成；
- 拿不准能否自动时，**按“需要安装性变更”处理**（补脚本或文档），不要赌对方环境。
- 实例（2026-10-21）：`dsh-plugin-new-session` 采用 `dsh plugin add` + README + 装机引导，
  放弃补丁层 `file:` 直挂——后者配置在 `~/.dsh` 且硬编码仓库路径，换设备要手改，不满足第 1 条。

## 9. Git 操作纪律：工作仓库隔离（铁律）

<!-- BEGIN LOCAL:git-work-repo-isolation-pointer -->
<!-- origin: user-request; author: wang; created: 2026-11-04; 说明：本地指针；正文唯一来源是 SkillHub 片段 git-work-repo-isolation -->

**正文唯一来源**：SkillHub agents 片段 `git-work-repo-isolation`

- 片段路径：`<SkillHub 根>/store/agent_instructions/fragments/git-work-repo-isolation.md`
- 本机 SkillHub 根：`D:\src\ynm3000\skillhub`；其他设备按 `SKILLHUB_ROOT` 或该设备 skillhub 根解析，不要硬编码本机路径。

执行任何 git 同步 / 恢复之前，先读该片段全文；本文件只保留指针与下面两条即时常量，不复制正文（避免多处副本漂移）。

- 没有明确语义指示，**不拉取、不推送 `work` 组仓库**；定向刷新只用 `-Group personal` / `-Group thirdparty`，或对 `D:\src\dsh` 逐仓 `git fetch` + `git merge --ff-only`。
- 引擎一致性门槛：`engine-preflight.ps1` 报 `drift` → 停下等人工决策（`bootstrap.ps1 -AcceptDrift` 先备份）；`conflict` → 无法支持，不覆盖、不同步、**不得一键恢复**。
<!-- END LOCAL:git-work-repo-isolation-pointer -->

