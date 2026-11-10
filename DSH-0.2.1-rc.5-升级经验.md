# DSH 0.2.1-rc.5 升级经验

> 记录时间：2026-11-03  
> 范围：全局宿主 `@deepseek-ai/dsh@0.2.1-rc.5` + 本工作区插件 / `dsh-config-pack` 适配  
> 前一基线：`0.2.0-rc.2`

本文是本机实装复盘，供下一台设备或下次小版本升级对照。命令在 Windows PowerShell 下执行。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 全局宿主 | `npm i -g @deepseek-ai/dsh@0.2.1-rc.5` → `dsh --version` = `0.2.1-rc.5` |
| 最大变化 | **peer 精确版本门闸**：插件 `peerDependencies` / 依赖里的 `@deepseek-ai/*` 必须与宿主同号，否则激活失败 |
| 重启后两处硬伤 | ① `subagent-director` 缺 `settleRun` → 升到 `0.6.0-beta.2`；② persona 里 `{{cwd}}` 未知插值 → 从配置包去掉 |
| 配置包 | `dsh-config-pack` **v0.11.2**（钉 peer + 去 `{{cwd}}`） |
| 本地插件发版 | `archived-sessions` **v0.4.3**；`acp-resilient` **v0.2.3**；`permission-compat` 钉脚与 diagnostic SKIP |
| 升级前备份 | `%USERPROFILE%\.dsh\_snapshots\bak-before-upgrade-0.2.1-rc.5-20261103-141501\` |

npm 频道备注：`latest` / `next` 当时即 `0.2.1-rc.5`；另有 `alpha` 线 `0.2.2-alpha.*`，本流程不跟 alpha。

---

## 2. 推荐升级顺序

按依赖从外到内，避免「半新宿主 + 旧 peer」卡死 profile：

1. **备份** profile 与关键状态（本机用既有 snapshot / backup 流程）。
2. **装全局宿主**：`npm i -g @deepseek-ai/dsh@0.2.1-rc.5`，确认 `dsh --version`。
3. **先改带精确 peer 的插件**（见 §3），提交 / 打 tag / 推送，再让 config-pack 依赖指向新 tag。
4. **改 `dsh-permission-compat` 钉脚**（`tools/install-dsh-plugins.mjs`），重跑 compat / `dsh-web-safe`。
5. **最后处理 `dsh-config-pack`**（bundles 里通常靠后；合并 origin 时注意 `package.json` 冲突）。
6. **profile 侧重装 / 重链**：`link:` 与 `github:#tag` 对齐；config-pack 相关操作放最后。
7. **重启 web**，用真实 UI 冒烟（dump-config 通过 ≠ UI 全过）。
8. **收口文档**：`AGENTS.md`、装机 Prompt、各插件 README / changelog。

---

## 3. Peer 精确门闸（必踩点）

### 现象

插件激活被拒，日志大意是 peer / 版本与宿主不匹配（`dsh plugin allow-version` 一类硬闸）。本机首轮被挡的包括：

- `dsh-archived-sessions`
- `@local/dsh-subagent-acp-resilient`
- `dsh-config-pack`（及其声明的 `@deepseek-ai/dsh-base` / `dsh-web-app` peer）

无 peer 钉死 `@deepseek-ai/*` 的纯 UI / 工具插件，多数可直接沿用。

### 处理

把相关 `dependencies` / `peerDependencies` / `devDependencies` 中的 `@deepseek-ai/*` **整组钉到 `0.2.1-rc.5`**（不要留 `0.2.0-rc.2`）。

本机已发版对照：

| 制品 | 版本 / 提交 | 远端 |
| --- | --- | --- |
| `dsh-archived-sessions` | `v0.4.3` | GitHub tag |
| `dsh-subagent-acp-resilient` | `v0.2.3` | 独立仓 tag（工作区目录同步改 `package.json`） |
| `dsh-config-pack` | `v0.11.2` | 依赖指向上述 tag + 官方插件 `0.2.1-rc.5` |
| `dsh-permission-compat` | `a8e7e8b` | 官方子代理 / mcp-client 钉脚 → `0.2.1-rc.5` |

跨设备：只改本地 `link:` 不够，**github 依赖必须推到带 tag 的提交**，否则另一台仍解析旧 peer。

---

## 4. 重启后故障与修复

### 4.1 `settleRun is not a function`（subagent-director）

| | |
| --- | --- |
| **现象** | 重启后子代理编排报错，调用不存在的 `settleRun` |
| **原因** | 宿主 API 迁移：旧 director（如 `0.5.6`）仍调 `settleRun`；新宿主走 `startActivation` |
| **修复** | 将 `dsh-plugin-subagent-director` 升到 **`0.6.0-beta.2`**（或当时与宿主匹配的新版） |
| **经验** | 升级宿主后，把「编排类 / director 类」插件单独对一下 changelog，API 改名比 peer 更难从安装日志里一眼看出 |

### 4.2 `Unknown template variable: cwd`

| | |
| --- | --- |
| **现象** | 会话 / persona 渲染报未知插值 `{{cwd}}` |
| **原因** | 系统提示模板变量收缩：可用插值以文档为准（当时主要是 provider / model 一类）；`{{cwd}}` 已失效 |
| **修复** | 从 `dsh-config-pack` 的 persona 尾缀去掉 `Your working directory is {{cwd}}.`（含 PTC bundle / companion 模板中的副本） |
| **经验** | 升级后全文搜 `{{cwd}}` / 其它自定义 `{{...}}`；以宿主 system-prompt 文档白名单为准，不要假设旧插值仍可用 |

### 4.3 `ERR_PNPM_UNUSED_PATCH`（claude-code）

| | |
| --- | --- |
| **现象** | profile 安装时报对 `@deepseek-ai/dsh-subagent-claude-code@0.2.0-rc.2` 的 patch 未使用 |
| **原因** | 钉到 `0.2.1-rc.5` 后，旧 `patchedDependencies` 条目悬空 |
| **修复** | 去掉针对 `0.2.0-rc.2` 的 patch 声明 |
| **遗留** | 若仍需要 `causeDetail` 一类诊断补丁，须按 **0.2.1-rc.5** 包形状重新制作 pnpm patch（本轮未重做） |

### 4.4 diagnostic compat：`in-process-driver` 消失

| | |
| --- | --- |
| **现象** | `apply-dsh-subagent-diagnostic-compat.mjs` 在新宿主上找不到模块 |
| **原因** | `0.2.1+` 退役 `dsh-subagent-in-process-driver`，改由 fork / spawn 包承担 |
| **修复** | 目标文件不存在时 **SKIP**（成功路径），不再当失败；README 同步说明 |
| **经验** | compat 脚本要按宿主模块清单演进；「补丁打不上」有时是上游已删模块，而非路径写错 |

其它 compat（session-format / permission / length-recovery / context-recovery）在本轮 `0.2.1-rc.5` 上仍可应用。

---

## 5. 配置包合并注意

本地曾在 origin `0.11.1`（仍钉 `0.2.0-rc.2`）之上叠 peer / `{{cwd}}` 改动：

1. 先 `git pull` / 与 `origin/main` 对齐。
2. 用 stash 带回本地修复时，**`package.json` 易 UU 冲突**：保留上游结构与更高版本号，**依赖与 peer 取本机的 `0.2.1-rc.5`**，版本号再抬一档（本机 → `0.11.2`）。
3. 同步改 `CHANGELOG.md`；确认四处 cordis / presets 已无 `{{cwd}}`。
4. 打 tag `v0.11.2` 并推送；父仓 `dsh-ynm3000` 更新子模块指针。

---

## 6. 验收清单（本机用过）

- [ ] `dsh --version` → `0.2.1-rc.5`
- [ ] `dsh plugin --profile web list`：无 peer 拒绝 / 未激活项
- [ ] dump-config / compat 脚本：EXIT=0；diagnostic 允许 SKIP
- [ ] 重启 web UI：无 `settleRun`、无 `{{cwd}}` 报错
- [ ] 子代理（含 ACP / director）能起一轮并正常结束
- [ ] config-pack / archived / acp-resilient 远端 tag 与 profile 引用一致
- [ ] `AGENTS.md`、装机 Prompt 基线已改为 `0.2.1-rc.5`

---

## 7. 版本矩阵（收口时）

| 组件 | 收口版本 |
| --- | --- |
| `@deepseek-ai/dsh`（全局） | `0.2.1-rc.5` |
| `dsh-config-pack` | `0.11.2` / tag `v0.11.2` |
| `dsh-archived-sessions` | `0.4.3` / tag `v0.4.3` |
| `dsh-subagent-acp-resilient` | `0.2.3` / tag `v0.2.3` |
| `dsh-plugin-subagent-director` | `0.6.0-beta.2`（解决 settleRun） |
| `dsh-permission-compat` | 钉脚 `0.2.1-rc.5` + diagnostic SKIP |
| 父仓 `dsh-ynm3000` | 含上述子模块指针与文档的提交（例：`e85d3e3`） |

---

## 8. 已知遗留（未在本轮做完）

1. **claude-code@0.2.1-rc.5** 的诊断类 pnpm patch 未按新包重做。  
2. 部分 ynm3000 历史 `link:` 是否一律改指 `src/dsh` 工作区，可按设备再收一次。  
3. `dsh-wechat-hitl` 子模块在部分检出上可能为空目录，与本次宿主升级无关，装机时需 `submodule update --init`。  
4. npm / GitHub 上其它市场插件的可选升级（如 dshmarket）可另开一轮，不阻塞本基线。

---

## 9. 可复用口诀

1. **先备份，再升宿主，再钉 peer，最后动 config-pack。**  
2. **peer 看门闸；director 看 API 改名；persona 看插值白名单。**  
3. **compat 模块消失 → SKIP，不要硬打补丁。**  
4. **`link:` 只救本机；跨设备必须 tag。**  
5. **dump-config 绿了仍要重启 UI 冒烟。**

---

## 10. 相关路径

| 路径 | 用途 |
| --- | --- |
| `AGENTS.md` | 工作区基线声明 |
| `docs/bootstrap/PROMPT-新设备装机-引导.md` | 新设备钉版本安装 |
| `docs/bootstrap/PROMPT-修复Node路径.md` | Node PATH / `DSHPACK_NODE` |
| `dsh-config-pack/CHANGELOG.md` | `0.11.2` 条目 |
| `dsh-permission-compat/tools/install-dsh-plugins.mjs` | 官方插件钉脚 |
| `dsh-permission-compat/tools/apply-dsh-subagent-diagnostic-compat.mjs` | 退役模块 SKIP |
