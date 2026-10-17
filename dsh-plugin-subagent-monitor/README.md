# dsh-plugin-subagent-monitor

DSH Web 增强插件：在会话头部（`conversation.session.header.actions` 席位）新增
一个 `子代理 N` 小按钮，点击展开面板，集中查看**当前会话**的子代理与后台任务：

- 类型徽标**优先取实际路由**：派发参数里显式的 `provider` / `model`（等价于工具实例的 `agentOptions`，来源含 `tool/call` 与 `tool/ptc-dispatch`）> 子会话持久化的 `modelSelection.lastUsed`（`projectionsBySession[childId]`，仅本连接已加载投影基线的会话有值；宿主 `byId[*].projectionValues` 与之同源，故不设回退），由此推出 `DS4.1 / Kimi / Cursor / Codex-Relay / Codex / Opus` 等短名；两者都识别不出时才回落到工具名派生的**驱动名**（`typeOfTool`：spawn / fork / Codex…）。驱动名保留在徽标 tooltip，例如「实际路由：Codex-Relay（codex-relay / gpt-5.6-sol）· 驱动 spawn」——改成路由口径后不会丢 spawn / fork 这类驱动差异。颜色 swatch 与文字分离，名称行内可见，不依赖颜色辨识。
- 每行显示模式（后台 / 续接 / 前台）、状态与 keepalive。
- 点击行可展开实时输出尾部：后台 job 走 `ctx.jobs` 输出环，子会话走其
  `SessionBinding.eventSource` 事件流。
- 展开行尾部提供“打开子会话”命令按钮：经 `ctx.uiWorkspace.openSession(address)`
  在主工作区打开该子会话。address 优先取 `ctx.sessions.subagentAddress(childId)`
  的 direct-parent 结果，取不到时按 `{ parentSessionId, childSessionId, mode }`
  安全构造（mode ∈ `one-shot` / `continuable` / `unknown`）。导航成功后面板自动关闭；
  不再使用 `window.open`。

本插件是**只读可见性增强**：不写文件、不写 settings、不持凭据、不发变更类
请求、不修改任何官方宿主包，也不注册 Conversation Node/View。

## 安装

插件由主控创建（`package.json` / `cordis.patch.yml` / `index.js` 已就位）：

```powershell
dsh plugin --profile <profile> add D:\src\dsh\dsh-plugin-subagent-monitor
```

`index.js` 只是 host 半载体（挂载日志），全部能力在浏览器半 `client.js`，由
`package.json` 的 `dsh.client` 声明驱动。

## 行为

### 行集合与合并

header action 的贡献 `inject()` 不接收会话 id；插件从宿主提供的 `SessionStandardProps.sessionId` 建立父会话 eventSource。面板行集合 = 父会话 delegation ∪ 本会话 `subagentCatalog` 子会话 ∪ 本会话
`ctx.jobs` 中 `kind === 'subagent'` 的任务。关联成功不重复计数；无法关联时保留
独立行并明确“未关联”。

关联置信度：

- `continuable` 结果给出 `subagentId` → `exact`。
- `background` 结果只给 `jobId` → 对同父会话 child 按 `job.label === child.label`
  且 `child.createdAt >= job.startedAt - tolerance`（默认 30s）做一对一 assignment，
  取时间差最小者；多个同等候选 → `ambiguous`（不猜）。
- 前台 one-shot 仅在 label + 时间窗口唯一时标 `exact-by-unique-window`，否则未关联。

### 结果解析

`parseDispatch(text)` 覆盖：纯 JSON 对象、带前缀 JSON、JSON 数组、嵌套对象、
被再包一层引号的转义 JSON、以及 dsh-tool-subagent 的持久化 renderer 文本
（`started background subagent job <jobId>` / `started subagent <subagentId>`）。
解析顺序：JSON 候选做括号配平 + `JSON.parse` + 递归搜索；JSON 失败后匹配
renderer 文本；全部失败返回 `null`（前台 one-shot 事后无 runId → null）。

### 状态与 keepalive

每行状态优先级：`job.status`（有 jobId）> 子会话 `running` 与最近 `turn/end.reason`
> delegation 结果。

- job 行：`status === 'running'` 且 `observed[id].streaming` → `活跃 · 已运行 X`；
  有 `progress` 显示 progress；否则 `已运行 X`。
- 子会话行：最近活动取 `max(child eventSource 最新 event.time,
  subagentTiming.active.through, byId.updatedAt)`；`active.since` 给当前轮耗时，
  `settledMs` 给已结算耗时。
  `running === true` 且静默 > 120s → `运行中 · 已静默 X（UI 推断，非 ACP 真实心跳）`，
  **不得据此改判失败**。
- 终态优先读最近 `turn/end.reason`：`completed→已完成`，`aborted/interrupted→已停止`，
  `error/blocked/max-tokens→已失败`。

### 输出面板

- job 行展开：`ctx.jobs.observe(sessionId, jobId)`，渲染 `observed[jobId].text`
  尾部（等宽、固定高度滚动）；`gapBefore` 时提示“更早输出已丢弃”；收起时 `stop()`。
- 子会话行展开：先 `subagentAddress(childId)` 后
  `ctx.sessions.retain(target, { source: "controllerOperation" })`，await `ready`
  并订阅 `eventSource`；处理 `assistant/live-chunk`（text/reasoning/tool-call delta）、
  durable `assistant/message` settlement、`tool/call`、`tool/result`、`turn/end`，
  裁剪为最近 200 行 / 64 KiB；收起或卸载时 `release()`；`hasMore` 时提示“更早输出未加载”。
- 读不到时显示 `暂无可用输出（子代理尚未产生文本）`，**不得抛错**。

### 弹层与触发器

- 触发器：header actions 里的小按钮，显示 `子代理 N`（进行中数/总数）；无任何子代理
  且无 subagent job 时**不渲染**（零占用）。
- 弹层：fixed 定位，优先按钮下方，空间不足翻上方，水平/垂直夹取在视口内；点外部或
  `Escape` 关闭。
- 列表按 `startedAt` 倒序；空态为 `本会话还没有子代理或后台任务`。

### 前台 one-shot 专用工具行

前台 one-shot 专用工具（只读的一次性转发等）没有可续接的子会话，其行来自父会话
transcript 的 `tool/call`（name 以 `subagent` 开头）与配对 `tool/result`，以及
`tool/ptc-dispatch` 记录（PTC 主控把子代理调用放进 `run_code` 程序执行时只留后者，
该记录自带 arguments 与 content，无需配对）；`resultText`
里没有 `kind` 信息时按 `foreground` 处理（`runId` 取 callId）。这类行：

- 一律标记为**一次性**：`row.oneShot === true`，行 chip 显示「一次性」，名称斜体、
  字号略小（`rowFontSize`），左侧框线为**虚线**。
- **不显示任何 token 数字**：token 只来自被关联子会话的真实投影；一次性专用工具行
  没有子会话，`tokens` 保持 `null`，`tokensLabel` 返回空串。绝不按文本长度推算，
  源码中不出现 `≈` 或估算字样。
- 若没有 `childId`，不渲染“打开子会话”按钮，并在 meta 标注「一次性 · 无独立子会话」。

### token 归集

`buildRows` 接收 `tokensOf(childId)`（与 `timingOf` / `modelSelectionOf` 同形），由组件
传入 `tokensOfProjection(该 childId 的 projections 值)`：

- child 行：`row.tokens = tokensOf(childId)`（仅真实投影，缺项为 `null`）。
- job 行：与 child 关联成功后复制该 child 的 `tokens`，否则保持 `null`。
- delegation 行：默认 `null`，仅在关联到 child 时复制。

`tokensLabel(row)` 把 `{ output, input, context, contextWindow }` 渲染为
`生成 1.2k · 输入 1k · 上下文 4k/200k`；无真实 tokens 时不渲染 token 区。

### 可续接 / 一次性的视觉区分

- 左侧框线：一次性 = `3px dashed <类型色>`，其余 = `3px solid <类型色>`。
- 名称：字号 `rowFontSize(row)`；一次性斜体，可续接 `fontWeight:600`。
- 行内 chip（`data-subagent-chip`）与 token 行（`data-subagent-tokens`）；行根带
  `data-subagent-oneshot="true|false"`。
- 面板顶部图例：`可续接（可继续对话） · 一次性（专用工具，只读记录）`。

### 本地持久化（浏览器 localStorage）

面板把当前会话的行快照写入浏览器本地存储，使父会话 transcript 窗口裁剪后仍能显示
**历史行**。纯函数（可在 `probe` 中独立断言）：

- 键与常量：`PERSIST_KEY_PREFIX = "dsh-subagent-monitor:v1:"`（`persistKey(sessionId)`
  按会话隔离）、`PERSIST_VERSION = 1`、`PERSIST_MAX_ROWS = 80`、`PERSIST_MAX_TEXT = 400`。
- `snapshotRow(row, now)`：只存 `{ key, kind, childId, jobId, runId, toolName, label,
  mode, oneShot, startedAt, savedAt, tokens, modelSelection, statusText, preview }`。
- `savePersisted(storage, sessionId, rows)`：按 `startedAt` 倒序、截断 80 行后写入
  `{ version, savedAt, rows }`；失败返回 `false` 且不抛。
- `loadPersisted(storage, sessionId)`：无 storage / 无键 / JSON 损坏 → `[]`，并只保留
  `key` 为字符串的元素。
- `mergePersisted(liveRows, storedRows)`：按 `key` 去重（实时行优先），历史行
  `restoreRow` 后补在其后，整体按 `startedAt` 倒序。
- `restoreRow(snapshot)`：生成 `archived:true` 的历史行，`child/timing/job/observed`
  均为 `null`，`confidence="archived"`，并带 `archivedStatus`、`archivedPreview`、`archivedAt`。
- `rowsSignature(rows)`：由 `key`、`archived` 标记、`statusOf(row).text`、
  `tokensLabel(row)`、秒级 `startedAt` 组成稳定字符串；模块级 `Map` 记录每会话最近写入
  的签名，避免每帧重复写。

历史行整体降透明度（约 `0.72`），`statusOf` 返回「历史 · <快照状态>」，
`keepaliveOf` 返回「历史记录（父会话窗口已裁剪）」，`isActiveRow` 返回 `false`。

## 已核实的宿主 API（实现依据）

- 席位注册：`ctx.slots.inject("conversation.session.header.actions", () =>
  ctx.slots.register({ name, id, inject: (sessionId) => face }, Component), "desc")`。
- 会话数据：standard props 提供 `useSessions / useSession / useProjection / sessionId`；
  `useSessions().byId[id]` 与 `useSessions().projectionsBySession[id]`（含
  `subagentCatalog`、`subagentTiming`、`subagent`）。
- 父 transcript：`ctx.sessions.binding(sessionId)?.eventSource`
  （`ObservableSnapshot<SessionEventWindow>`）；`tool/call.data.callId` 与
  `tool/result.data.message.toolCallId` 配对。
- 后台任务：`ctx.jobs.state.getSnapshot() → { rows, observed }`、`subscribe`、
  `watchRows(sessionId)`、`observe(sessionId, jobId)`；`JobView` 字段见
  `@deepseek-ai/dsh-jobs/view`。subagent 类 job 输出环为空，故其输出走子会话 transcript。
- 子会话输出：`ctx.sessions.subagentAddress(childId)` →
  `ctx.sessions.retain(target, { source: "controllerOperation" })` → `{ binding, ready, release() }`。
- inject 清单：`["slots","sessions","jobs","remote","remote.session"]`（缺
  `remote` / `remote.session` 会静默降级）。

## 验证

```powershell
node probe\smoke-client.mjs   # 期望 ALL PASSED
node --check client.js
node --check index.js
```

`probe/smoke-client.mjs` 用 `vm` 沙箱 + 假 `react` + 假 `ctx` + 内存假 storage，覆盖
交付形状、`typeOfTool`、`parseDispatch`、`formatAge`、`keepaliveOf`、关联置信度、输出折叠、
token 归集（`formatTokens` / `tokensOfProjection` / `tokensLabel`）、本地持久化
（`persistKey` / `savePersisted` / `loadPersisted` / `mergePersisted` / `rowsSignature`）、
历史行与行视觉（chip / oneShot / 图例 / 一次性无 token）以及全部降级路径；退出码 0 / 1。

## 限制

- 父会话 transcript 窗口被截断时保留“历史不完整”降级，不自动拉完整历史。
- `keepalive` 的“静默”是 UI 基于最近活动时间的推断，非 ACP 真实心跳；仅提示，不
  改判状态。
- 子会话事件窗口仅在展开行时 `retain` 并订阅；收起即 `release()`。若 header 会话
  未被 shell retain 导致 `binding` 暂不可得，输出区退化为空窗口，待后续重渲染恢复。
- 前台 one-shot 若只留下 output、事后无 runId，则无法与其 child 唯一关联，落入
  “未关联”独立行。
- “打开子会话”依赖宿主 `uiWorkspace.openSession`；服务不可用时命令按钮不渲染，调用抛错时保持当前页面。
- 父会话位于 session-scoped header，已由 Conversation shell retain；插件通过 `sessions.binding(sessionId)` 借用并由 `useSyncExternalStore` 成对退订，不额外延长父会话生命周期。
- 持久化仅存**本地浏览器**（localStorage，按会话键隔离）：不写文件、不上传、不跨设备
  同步，清除浏览器存储即丢失；历史行只还原展示所需字段，不含运行时资源。
- **前台运行无 token 数据**：前台 one-shot 专用工具没有子会话，不显示 token；
  token 只来自子会话真实投影（`tokenUsage` / `contextPressure`），不做任何文本长度推算。

## 文件

- `client.js` — 浏览器半（classic script，CJS 包装，`require` 白名单仅 `react`）。
- `probe/smoke-client.mjs` — 门禁冒烟。
- `index.js` / `package.json` / `cordis.patch.yml` — 由主控创建，本插件不修改其语义。
