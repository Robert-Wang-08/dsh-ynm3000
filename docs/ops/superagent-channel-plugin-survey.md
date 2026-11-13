# superagent 渠道插件盘点（bridge / 配置管理）

> 2026-11-05 检索自插件市场索引 `https://awesome-dsh-plugin.com/plugins.json`（8,879 条），关键词：bridge / email / wechat / qq / telegram / slack / discord / dingtalk / feishu / lark / webhook / notify / gateway / channel / hitl。
> 结论先给：**有大量「渠道 ↔ DSH 会话」的 bridge 插件，且多数自带设置页；但没有一个是「superagent Source 级」的桥**——它们直接驱动 DSH 会话，不产出 superagent 的 Trigger/Ticket。

## 1. 渠道类（IM 桥 + 配置管理）

| 插件 | 渠道 | 配置管理 | 备注 |
| --- | --- | --- | --- |
| `@xmanrui/dsh-im`（3118★） | 飞书、微信、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix | **Settings → IM Bot**，扫码 / App Manifest / 凭据；每 bot 独立开关；Telegram 私聊 allowlist；语音转写 | 单插件覆盖最广，配置面最完整；QQ 走官方 bot（AppID/AppSecret），不比个人号风险 |
| `@michengai/dsh-im-connect`（118★） | 微信、企微、钉钉、飞书/Lark、QQ、Telegram | 每个 IM 聊天 = 一条独立工作区频道 | 适合「一聊天一会话」的隔离 |
| `github:zhuiyueya/dsh-im-gateway`（59★） | 20+ 平台 | `allowedUserIds` 白名单配置；统一会话、远程审批、交互提问 | 默认放行所有人，必须自己收紧 |
| `dsh-lark`（59★） | 飞书/Lark | 卡片内审批/提问/计划审阅；`/cd` `/model` `/new` | 多机器人独立、同群交接 |
| `dsh-lark-link`（44★） | 飞书/Lark | 扫码一键认证、`/doctor`、会话日志 ZIP | at-least-once 出站队列、多媒体双向 |
| `dsh-lark-bot`（41★） | 飞书/Lark | 扫码绑定、流式卡片、worktree 工作区 | 崩后仍有安全网守护 |
| `dsh-wechat`（腾讯 iLink） | 微信 | 扫码绑机器人；每联系人独立会话 | 入站文本/图片/文件，整轮显示「正在输入」 |
| `@zaofan/dsh-qqbot`（213★） | QQ 官方机器人 | 群/私聊、群管理、远程审批、悬浮球 Web UI | 官方 API，风险低于第三方协议端 |
| `dsh-qq-link`（157★） | QQ（NapCat HTTP） | 双向打通：会话说什么发到 QQ | 第三方协议端 |
| `@wenbin_wb/dsh-bridge`（238★） | 微信/QQ/飞书/Telegram + 远程接入 | 局域网扫码、Cloudflare/自建隧道、ACL | 名字与本地 OpenClaw 的 `dsh-bridge` 网关**不是同一个东西** |
| `dsh-bridge`（baixianger，5★） | 本地跨会话 | 会话发现、冷会话唤醒投递、可审计 | 进程内会话间转发，不是 IM |

## 2. 邮件类（正好是你要的长文本 + 附件）

| 插件 | 能力 | 配置管理 |
| --- | --- | --- |
| `dsh-email`（30★） | 10 个工具：`email_watch`（增量新邮件）、`email_mark`、`email_reply`（回复/全部/转发，自动线程头 + 引文）、附件 | Web 设置页；内置 QQ/163/126/新浪/阿里/Gmail/Outlook/iCloud 预设；多账号；发信审批门；Outlook OAuth2 设备码 |
| `@eduwork/dsh-mail`（291★） | 只读 IMAP 检索 + 取附件；按权限发 SMTP | 独立收发开关 + 凭据设置页 |
| `@ethanyoq/dsh-invoice-downloader`（536★） | 专用场景：IMAP 发票下载 / OCR / 报销汇总 | 本地配置 |

## 3. 通知 / 审批 / 远程

| 插件 | 用途 | 配置 |
| --- | --- | --- |
| `dsh-notifier`（a23842） | 出站通知：企微应用/企微机器人/钉钉/飞书/邮件(SMTP/Resend)/NotifyX + `send_notification` 工具 | 设置页；运行结束/阻塞/目标完成自动推送 |
| `dsh-plugin-mobile-gateway`（135★） | iOS 客户端网关：会话、实时事件、任务、Goal、**审批**、命令、**文件传输** | 二维码配对、设备撤销 |
| `dsh-remote-web`（54★） | 手机浏览器远程控制，E2EE，云端/自建/微信机器人三个 tab | 设置页「远程控制」面板 |
| `dsh-notification` / `dsh-session-notification` / `dsh-suite/plugin-notify` | 回合完成、待审批等桌面/IM webhook 推送 | 插件配置 |
| `mirage#dsh`（3762★） | 把 Gmail / Slack / Notion / S3 等挂成文件系统，Agent 按需读 | 挂载点级读写执行模式 |

## 4. superagent 相关的四个插件（都不是渠道）

| 插件 | 与 superagent 的关系 |
| --- | --- |
| `dsh-superagent-local` | 上游 dsh-superagent 的本地变体（每工作区一个主会话 + 工单）。**不能与本机上游版共存**：包名与插件 id 相同 |
| `dsh-plugin-superagent` | 项目控制台（持久化任务、执行会话、项目卡片） |
| `dsh-session-superagent` | 会话级：盯 GitHub 仓库，issue/PR 变化唤醒当前会话（走 gh CLI） |
| `dsh-superagent-power` | Windows 全局「Sup」开关，启停独立 superagent 进程，并给独立 profile 注册 `bridge.js` |

## 5. 关键结论：它们解决不了 superagent 的接入

上面所有渠道插件的工作方式是：**渠道消息 ↔ DSH 会话**（把聊天当用户回合投进某个会话）。而 superagent 的入口是 **Source → Trigger → Thread → Eval → Ticket**，授权在 Policy、上下文在 Thread、执行在 Executor 会话。两者不重叠：

- 插件不会产出 `Trigger`，也不会写 Policy 的 allowed 列表；
- superagent 的 Ticket 只认自己的 Source（GitHub/飞书），面板也没有「IM 来源」配置；
- 因此「装个 dsh-im 就能让 superagent 收微信工单」**不成立**。

## 6. 两条真正可用的接线（按投入排序）

**A. 主会话驱动（最省事，今天可试）**
在 `superagent` profile 里装一个 IM 插件（推荐 `@xmanrui/dsh-im`），把聊天投递到 superagent 的**主会话**（router，`masterId`）。主会话持有 `orchestrator_route` / `orchestrator_eval` / `orchestrator_reply` 等工具（`src/app/tools/main.ts`），可以自己把消息路由成 Ticket。
代价：授权门禁从 Policy 前移到了插件的 allowlist（如 Telegram 私聊白名单、`allowedUserIds`），Policy 的 allowed 列表不再独占入口；且多一层模型判断（主会话要决定接不接）。需要先在 3082 上实测 `orchestrator_route` 的行为。

**B. 按设计文档做 bridge Source（正统，投入大）**
见 [superagent-external-integration.md](superagent-external-integration.md)：一个 `bridge` Source + 每渠道适配器。授权仍在 Policy，Ticket/Eval 语义完整，附件双向有明确协议。代价是要改 dsh-superagent 源码（新 Source kind，P1 还要给 `OutboundMessage` 加附件字段）。

## 7. 推荐组合（如果目标是「邮件 + 微信 + QQ 都能收活」）

| 需求 | 现在就能用 | 长期正确 |
| --- | --- | --- |
| 邮件收发（长文本 + 附件 + 线程） | `dsh-email`（工具层，配好 QQ/163 预设即可） | bridge Source 的 email 适配器 |
| 飞书 | superagent **原生 Source**，不用装插件 | 同上 |
| 微信 | `dsh-im` 的微信通道（iLink 机器人，扫码）或 `dsh-wechat`；个人号仅审批 | 微信只做通知/审批（复用 `dsh-wechat-hitl`） |
| QQ | `@zaofan/dsh-qqbot`（官方 bot）> `dsh-qq-link`（NapCat） | 视风险决定 |
| 手机审批 / 传文件 | `dsh-plugin-mobile-gateway` 或 `dsh-remote-web` | 保持 |
| 结果推送 | `dsh-notifier`（企微/钉钉/飞书/邮件） | 保持 |

## 8. 安装前提醒

- 所有插件都跑在你的权限下：市场页面明确写着「tool approvals don't sandbox it」，第三方插件能读文件、用凭据、联网。
- GitHub 源安装需要 `allowBuilds` 放行；npm 包优先。
- 与本机冲突：`dsh-superagent-local` 与本机上游 `dsh-superagent` 包名/id 相同，**不要装**；`@wenbin_wb/dsh-bridge` 与本地 OpenClaw 的 `dsh-bridge` 网关同名不同物。

## 9. 追记（2026-11-05 核实，修正 §6 的方案 A 判断）

**§6 的方案 A 不成立**，以下是核实依据：

1. superagent 的入口只有一个：`Source.receive(trigger)`（`src/core/engine.ts:48`，调用方只有 `src/sources/*` 与 `src/app/passes.ts`）。没有任何工具能把一段会话文本变成 Trigger。
2. `orchestrator_*` 工具是**决策工具**，不是入口：`orchestrator_route` 接收的是已存在的 `trigger_id`（`src/app/tools/main.ts:125-140`），`orchestrator_eval*` 处理已有候选。
3. 工具只装饰两类会话：`Sessions.tools(agent, ticket)` 只给主会话（`ticket === undefined`）和 Ticket 执行会话注册工具（`src/app/sessions.ts:37-38`、`ROUTER_PRESET/WORKER_PRESET`）。IM 插件按自己的逻辑**新建**会话（dsh-im README：每机器人独立工作区、每聊天一条会话、Agent Preset 可选），这类会话不被装饰，**连 orchestrator 工具都没有**。
4. 因此「装 dsh-im/微信桥 → 聊天 → Ticket」在 upstream 上做不到。能做的是 **A′：换成本地 fork `dsh-superagent-local`**——它的 `local-watch` Source 专门把「本机主会话的需求」变成 Trigger（包内 `lib/local-watch.js`），代价是 ①顶替上游（见附录 B1）②必须另开 profile。

A 与 B 的真实差别对照：

| 维度 | A（IM 插件驱动会话） | B（bridge Source） |
| --- | --- | --- |
| 入口 | DSH 会话（模型上下文） | `Source.receive(Trigger)` |
| 产出 Ticket | **否**（会话无 orchestrator 工具） | 是 |
| 授权 | 插件 allowlist（Telegram 私聊白名单 / `allowedUserIds`），Policy 不参与 | Policy allowed + Eval 门 |
| 上下文 | 会话历史，长文本会撞上下文上限 | Thread + `threadContext` 分页 + 落盘摘要 |
| 附件 | 插件自带（图片入站、文件回传） | 自建 inbox/deliver 协议 |
| 配置管理 | 现成（Settings → IM Bot、扫码、每 bot 工作区/模型/preset） | 自建 schema + fields + 设置页 |
| 改动量 | 装插件（拿不到票） / 换 fork（拿到票） | 新 Source + 适配器（P1 再改附件字段） |
| 维护 | 跟随第三方 | 自维护 |
## 10. A′ 端到端实测（sa-local profile + local fork，2026-11-05，**通过**）

### 环境

| 项 | 值 |
| --- | --- |
| profile | `sa-local`，由 shipped web 模板创建（base + web-app + fork） |
| 安装 | `dsh plugin --profile sa-local add file:D:/src/dsh/.ptc/tmp/sa-local.tgz`（fork v0.2.1） |
| 端口 / stateDir | `127.0.0.1:3083` / `C:/Users/wwm_1/.dsh/state/sa-local` |
| 组合 | `--dump-config` exit 0，349 条目，`dsh-superagent-dsh` = `dsh-superagent/local-watch` |
| 运行 | pid 3760，`/orchestrator/api/state` 200，`setup.problem = null`（无 GitHub 仓库也 ready） |
| 主会话 | `GET /orchestrator/api/master?workspace=0636fa95-01e2-43d0-8099-82773a8050b3` → 200，masterId `orchestrator-9ae3…` |

### 操作与结果

操作者**在主会话里**发一句：`在这条工作区新建文件 a-prime-demo.txt，内容是 hello from local fork`。

链路（全部由 fork 落库，`~/.dsh/state/sa-local/orchestrator.sqlite`）：

| 表 | 条数 | 关键内容 |
| --- | --- | --- |
| `trigger` | 1 | `source: dsh`、`actor: operator`、`addressed: direct`、`meta.workspace: D:\\src\\dsh`、原文一字不差 |
| `decision` | 1 | `kind: accept`、`reason: explicitRouted`、`ticketId: 5e5244…` |
| `ticket` | 1 | 标题「新建 a-prime-demo.txt 演示文件」，assignment `state: ended` |
| `outbox` | 2 | `acknowledgement`「好的：将在工作区新建…」+ `reply`「已完成：…该文件目前是未跟踪状态」，均 `status: sent` |

落地物：`D:\src\dsh\a-prime-demo.txt`，22 字节，`Created 2026-11-05 14:29:48`，内容 `hello from local fork`。

结论：**A′ 全链路成立**——本机操作者消息 → Trigger（source `dsh`）→ Eval/Decision（explicitRouted）→ Ticket → Worker 执行 → 回复回到同一会话。

### 这条实测改变了什么

1. **A′ 可用，但它是「人在电脑前」的产品**：不需要 GitHub 账号、不需要 IM 机器人；代价是换掉上游 `dsh-superagent`（包名与插件 id 冲突，见附录 B1），且必须独立 profile。
2. **A′ 仍不是外部渠道的答案**：fork 的 `local-watch` 只认「工作区主会话里的用户消息」，微信/邮件消息要进来，仍然需要一个把消息投进那条主会话的适配器——和 B 的工作量同源，而且会绕开 Policy 的 allowed 列表（fork 的闸口是 `actor: operator`）。
3. **B 仍是通用解**：渠道接入、长上下文、附件协议、授权都在 Policy 里；A′ 适合「只想让本机工作流自动化」的人。

### 环境处置

`sa-local` 是丢弃式验证环境，进程 pid 3760 仍在跑（可直接当本机「需求→工单」工作流用）。不再需要时：`Stop-Process -Id 3760`，再删 `~/.dsh/profiles/sa-local` 与 `~/.dsh/state/sa-local`；对 `web`(3080) / `superagent`(3082) 无影响。

补充：fork 的侧栏「主会话」按钮是 DOM 注入（`data-main-session-entry`），在自动化视角下不可见/不可点——这是 UI 层实现方式，不影响上面已验证的领域链路。
