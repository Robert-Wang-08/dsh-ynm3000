# superagent 外部信息接入：通用方案

> 目标：让 dsh-superagent 从「只接 GitHub / 飞书」扩展到邮件、微信、QQ 等渠道，且满足两个硬需求——长上下文、文件双向转发。
> 本文先给结论，再给依据（读代码/读文档得到的事实，带文件行号），最后给分阶段落地。

## 1. 结论先行

1. **不要为每个渠道写一个 Source。** 用一个统一的 `bridge` Source + 每个渠道一个薄的适配器进程；适配器只做鉴权/拉取/发送/附件搬运，领域语义（Thread/Trigger/Policy/Eval）留在 superagent。
2. **渠道排序：邮件 > 飞书 > Telegram/Slack > 企业微信 > QQ > 微信个人号。** 邮件是唯一「原生支持长文本 + 任意附件 + 天然线程（Message-ID/References）」的通用渠道；微信个人号只能做通知/审批，做不了工单入口。
3. **长上下文靠三个动作：** 线程分页读（已有）+ 原始线程落盘为文件 + Eval 只吃摘要。不要指望把整封邮件线程塞进 Prompt。
4. **文件转发必须两段式：** 入站「下载到 inbox 目录 → 用环境变量把路径交给执行器」；出站「执行器写到 deliver 目录 → 适配器上传」。核心现在**没有**附件字段，需要小而明确的扩展（见 §6）。

## 2. 现状与缺口（读代码的事实）

| 事实 | 位置 | 对方案的影响 |
| --- | --- | --- |
| 域模型是 Source → Trigger → Thread → Eval → Ticket → Executor → Channel | `docs/001-domain.md` | 接入点只有一个：新 Source kind；不要改 Eval/Ticket |
| `Trigger` 只有 `text` + `meta` + `channel`，无附件字段 | `src/core/model.ts`（Trigger 23-39 行） | 附件走 `meta`（不违约定）或扩展字段 |
| `OutboundMessage` 只有 `text` | `src/core/ports.ts:72` | **出站文件目前无处可放**，必须扩展或由适配器扫描目录 |
| Source 可以按需把消息里的图片作为附件交给 Agent | `src/sources/kind.ts:70-83`（`ThreadContext.images/image`） | 证明「运行时下载 + 作为附件交模型」这条路是现成模式 |
| Source kind 可以注册执行器环境变量 | `src/sources/kind.ts:112`（`environment.variables/values`） | 附件路径有正规通道：`DSH_SUPERAGENT_*` |
| 执行器环境已有 `DSH_SUPERAGENT_DIR/NAME/TICKET/BLOCKED_COMMANDS` | `src/app/execution-environment.ts` | 每个 Ticket 有独立目录，天然适合放附件 |
| 已有 GitHub / 飞书两个 Source，飞书含频道/群/机器人 | `src/sources/` | 飞书是现成的「好渠道」样板 |
| 微信已有独立 HITL 网关（DSH 插件 + OpenClaw `dsh-bridge`） | `D:\src\dsh\dsh-wechat-hitl` | 复用它做审批/通知，不要重造 |
| 上下文读取受 `admissionContextMaxPages`（默认 10 页）限制 | `docs/006-deployment.md` machine 配置 | 长线程必须配合落盘摘要 |

## 3. 通用架构（三层）

```text
┌──────────────┐   ┌───────────────┐   ┌──────────────────┐
│ 渠道适配器     │   │ 统一 Ingress   │   │ dsh-superagent    │
│ (每渠道一个)   │──▶│ 契约 JSONL/HTTP│──▶│ bridge Source     │
│ 鉴权/拉取/发送 │   │ 规范化事件      │   │ Trigger/Policy/   │
│ 附件上下行     │◀──│ 出站队列        │◀──│ Outbox/Channel    │
└──────────────┘   └───────────────┘   └──────────────────┘
```

-**L1 适配器**：进程/脚本，负责平台鉴权（OAuth、应用密码、Bot token、OneBot），拉取新消息，发送回复，下载/上传附件。它**不认识** Ticket，只认识「会话/线程/消息/发送者/附件」。
- **L2 Ingress 契约**：适配器把消息写成一个稳定格式（本地 JSONL spool 或 loopback HTTP），字段固定：`id/thread/conversation/sender{id,name,bot}/text/addressed/at/attachments[]`。
- **L3 bridge Source**：读 spool，产出 `Trigger`（`text` = 正文；`meta.attachments` = 附件清单；`channel.address` = 回信地址），实现 `threadContext`（分页读）、`channel.send`（写回出站队列）、`environment`（暴露附件目录）。

为什么不是「每渠道一个 Source」：Source 契约里 `schema/fields/policy/channel/threadContext/find` 五件事每渠道都要重写一遍，而差异其实只在协议层。一个 bridge Source 配 N 个适配器，领域侧只写一次。

## 4. 渠道矩阵

| 渠道 | 接入方式 | 长文本 | 文件 | 稳定性 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **邮件** | IMAP 拉取 + SMTP 发送；Thread = `Message-ID`/`References` | 极好（无实际长度限制） | 极好（附件任意格式/大小，受邮箱限制） | 高（协议标准化） | **P0，首选** |
| **飞书** | 已有原生 Source（机器人 + 群 + 文件 API） | 好（卡片/分块） | 好（文件消息） | 高（官方 API） | **P0，最省事** |
| Telegram Bot | Bot API（getUpdates / webhook） | 中（4096 字/条，可分段） | 好（Bot API 20MB，本地 Bot API 2GB） | 高 | P1 |
| Slack / Teams / Discord | Webhook + 文件 API | 好 | 好 | 高 | P1（团队场景） |
| 企业微信 | 群机器人（只能发）、企业应用回调（能收） | 中 | 中 | 高 | P1 |
| 通用 webhook / 目录 spool | 任意系统写 JSONL | 取决于对方 | 取决于对方 | 高 | P1，兜底通道 |
| **QQ** | 官方 Bot API（频道/群限制多）；个人号需 NapCat/OneBot v11 等第三方协议端 | 中 | 中 | 第三方协议端有封号/稳定性风险 | P2，仅自担风险 |
| **微信个人号** | 无官方 API；现有 `dsh-wechat-hitl` + OpenClaw 网关 | 差（易折叠、无富文本） | 差（文件收发受限） | 灰色，靠 Hook | **只做通知/审批**，不做工单入口 |

> 对「微信交互不友好」的判断：正确。个人微信没有机器人群、没有线程、消息易被折叠、文件转发依赖 UI 动作、登录态易掉。把微信降级为「审批按钮 + 结果推送」是它唯一稳的用法。

## 5. 长上下文方案

1. **线程分页读**（已有）：`threadContext.read(part, cursor)` 按页返回 `ContextMessage[]`，每页大小由 `admissionContextMaxPages`（默认 10）控制。
2. **原始线程落盘**：Eval 开始时把整段线程写成 `<stateDir>/threads/<threadKey>/<triggerId>.md`（含附件清单与时间线），正文只放「摘要 + 文件路径 + 未读页的 cursor」。这样模型需要细节时用文件工具读，不需要就不进 token。
3. **摘要优先**：Eval 输入 = 最近 N 条原文 + 前文摘要 + Ticket 现状；摘要由适配器或 Eval 前的确定性规则生成（标题/参与人/时间跨度/关键结论），不要用另一个模型逐条摘要（成本与漂移）。
4. **邮件线程天然可重建**：`References` 链就是 Thread，别用「主题去重」；正文里保留原始 `Message-ID`，回信时写 `In-Reply-To`，双方都能挂到同一线程。
5. **附件不进 Prompt**：只放路径 + 类型 + 大小；执行器需要时自己读（文本/CSV/图片走对应工具）。

## 6. 文件双向转发协议（建议的最小扩展）

### 入站

```text
<stateDir>/inbox/<source>/<triggerId>/
  0001-<safe-name>.<ext>
  0001-<safe-name>.json        # mime、大小、原始 URL、sha256
```

- 适配器下载后写 `meta.attachments = [{index,name,mime,bytes,path}]`；
- bridge Source 用 `environment.values()` 暴露 `DSH_SUPERAGENT_ATTACHMENTS=<上述目录>`，执行器/预处理命令直接读目录；
- 每个 Ticket 目录里再 `cp -r` 一份（或硬链接），避免 Ticket 重跑时 inbox 已被清理。

### 出站

现状：`OutboundMessage.text` 只有文本（`src/core/ports.ts:72`）。两条路：

1. **显式扩展（推荐）**：`OutboundMessage` 增加可选 `attachments?: { path: string; name: string; mime?: string }[]`；`Outbox` 存路径；各 `SourceChannel.send` 按需上传。改动点：`src/core/ports.ts`、`src/app/` 的发件循环、`src/sources/feishu.ts` / `github.ts` 的 send。
2. **目录约定（零核心改动）**：执行器把要交付的文件写到 `<ticketDir>/deliver/`，适配器在回信时扫描该目录上传。缺点：不可归档、不可审计、易误发。

建议 P0 先用路线 2 跑通链路（不动核心），P1 再切路线 1（显式、可审计）。**不要**把 base64 塞进 `text`。

## 7. 权限与安全

- **Policy 的 allowed 列表按渠道原生身份**：邮箱地址、飞书 open_id、Telegram user id、QQ uin、微信 wxid。永远不要用昵称。
- **邮件必须防伪造**：网关层校验 SPF/DKIM/DMARC 通过后再交给 superagent；只接受白名单 From；忽略 `Reply-To` 与 From 不一致的请求（或降级为「未获授权」记录）。
- **附件白名单**：类型（可执行文件拒绝）、单文件大小、单 Trigger 总大小；`.exe/.bat/.ps1/.js` 默认拒收。
- **凭据不进配置**：沿用仓库约定（`requires_env` 命名 + CLI wrapper），真实值只在用户环境变量或 `.credentials.yaml`。
- **回复也要防注入**：外部正文是 untrusted data（`Trigger.text/meta` 的注释就写明），适配器不要把平台元数据拼成「指令」。

## 8. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | `bridge` Source（spool JSONL）+ 邮件适配器（IMAP 轮询/IDLE + SMTP 回信 + 附件下载） | 给 agent 邮箱发一封带 2 个附件的邮件 → 面板出现 Ticket，回信带附件 |
| P1 | 文件协议进核心（`OutboundMessage.attachments` + `SourceKind.environment` 附件目录）+ Telegram/飞书群适配器 | 执行器产出的文件能作为附件回到原会话；`deliver/` 目录被归档 |
| P2 | 微信只做「审批 + 结果推送」（复用 `dsh-wechat-hitl`/`dsh-bridge`）；QQ 视风险接入 | 微信侧点按钮能批/拒；superagent 结果推送成功 |

## 9. 改动落点（供实施时对照）

| 文件 | 改动 |
| --- | --- |
| `src/sources/bridge.ts`（新增） | Source kind：schema/fields/scope/channel/threadContext/environment |
| `src/sources/index.ts` / cordis patch 的 bundle | 注册新 kind（照 `github`/`feishu` 的 insert 行） |
| `src/core/ports.ts` | （P1）`OutboundMessage.attachments?` |
| `src/app/`（发件循环） | （P1）把附件传给 `SourceChannel.send` |
| `src/app/execution-environment.ts` | 新 Source 的变量已由 `SourceKind.environment` 自动注册，无需改；若要核心级 `DSH_SUPERAGENT_ATTACHMENTS` 再加一行 |
| 适配器进程（仓库外，建议 `D:\src\dsh-superagent-adapters`） | 每渠道一个：`email/`、`telegram/`、`qq/`；只依赖标准库 + 平台 SDK |

## 10. 不推荐的做法

- 用模型读整段邮件再摘要（成本高、易漂移）→ 先落盘再按需读；
- 把微信当主入口（无群、无线程、无可靠文件）→ 只做通知/审批；
- 每个渠道写一个 Source（五套 schema/fields/policy/channel/threadContext）→ 用 bridge + 适配器；
- 把附件 base64 塞进 `text`（爆 token、不可审计、不可重放）。

## 11. 参考

- dsh-superagent 文档：`docs/001-domain.md`、`002-authorization.md`、`003-execution.md`、`006-deployment.md`、`008-cookbook.md`
- 代码：`src/core/model.ts`、`src/core/ports.ts`、`src/sources/kind.ts`、`src/app/execution-environment.ts`
- 微信回环：`D:\src\dsh\dsh-wechat-hitl\AGENT-USAGE.md`

