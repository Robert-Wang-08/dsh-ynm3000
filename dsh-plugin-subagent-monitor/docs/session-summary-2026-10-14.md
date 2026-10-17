# Session Summary — 2026-10-14（DSH Web 子代理可见性 · 交接）

根任务：`task-20261014T032847618470Z-05c5f3f9373f`（PTC 账本 `<workspace>/.ptc/registry.jsonl`，状态 done）
工作区：`<workspace>`；宿主：DSH `0.2.0-rc.2`；活动 GUI：`http://127.0.0.1:3080`；profile：`<DSH_HOME>/profiles/web`

## Topics Covered

- 会话头部「子代理 / 后台任务」面板：类型、状态、keepalive、可展开输出
- provider badge 改为 provider → model 向右级联选择器
- 「打开子会话」导航修复（dsh-resource 地址 vs 官方 uiWorkspace）
- 前台 one-shot 专用工具的本地持久化、token 显示口径、一次性 vs 可续接的视觉区分
- 后台调用能否显示具体执行者的边界核查
- Kimi 生成工作简报 + DS4.1 Flash 独立核查

## Questions & Conclusions

### Q1：子代理面板是由哪个插件实现的？
**结论**：`dsh-plugin-subagent-monitor`，注册在 `conversation.session.header.actions`；代码 `D:\src\dsh\dsh-plugin-subagent-monitor\client.js`。类型徽标走三级证据链：`tool/call` 参数里的显式 `provider/model/reasoning_effort` > 子会话持久化 `modelSelection.lastUsed` > 派发工具名兜底；tooltip 写明「实际路由：X（provider / model）· 驱动 工具名」。

### Q2：为什么列表里看不到刚用过的子代理（如 Kimi / DS4.1）？
**结论**：`subagent_kimi_docs`、`subagent_opencode_dsv41`、`subagent_codex*`、`subagent_claude_opus*_plan`、`subagent_cursor_grok` 是**前台 ACP one-shot  worker**，只返回 `{kind:"foreground", runId, output}`，**不创建 child session**，因此不在 `subagentCatalog`；父会话事件窗口是带 `hasMore` 的尾部窗口，裁剪后行即消失。已用 `localStorage`（键 `dsh-subagent-monitor:v1:<sessionId>`，上限 80 行）持久化，实时行优先、被裁剪的行以 `archived:true` 历史行补回。

### Q3：token 消耗怎么显示？
**结论**：只显示**真实测量值**——子会话行的 `tokenUsage.val.totals.{outputTokens,uncachedInputTokens,cacheReadTokens}` 与 `contextPressure.val.{surfaceTokens,contextWindow}`；job 行仅在与 child 关联后复制。**前台 one-shot 没有子会话，按用户决定一律不显示 token，禁止按文本长度估算**（源码有断言禁止出现“估算/≈”）。

### Q4：「打开子会话」为何打不开，如何修？
**结论**：原先调用 `window.open("dsh-resource://subagentchat/...")`，浏览器无法解析该内部协议。官方 `@deepseek-ai/dsh-client-ui-subagent` 的 `openChild` 实际是 `ctx.uiWorkspace.openSession(address)`；`dsh-resource://` 只用于 `ctx.sidebarRight.openResource`。已改为命令按钮 + `uiWorkspace.openSession`，地址优先取 `sessions.subagentAddress(childId)`，缺失时安全构造；`uiWorkspace` 不可用则不渲染按钮。用户已确认可用。

### Q5：后台调用（如 `job_output(subagent-6)`）能否看到具体执行者？
**结论**：**面板里能，正文工具卡片不能**。宿主 `dsh-jobs/lib/types/view.d.ts:55-94` 的 `JobView` 只有 `id/kind/label/owner/status/progress/detail/startedAt/finishedAt/output`，**没有任何 provider/model/executor 字段**，所以官方卡片在数据上就拿不到执行者。面板侧能看到，并且已补齐：归档行此前会把 `route` 丢成 `null`，现在 `snapshotRow/restoreRow` 保留 `{provider,model,reasoningEffort}`，历史行仍按实际路由显示。

### Q6：模型选择为什么是两级列表？
**结论**：`dsh-plugin-provider-badge` 已改为 provider → model 向右级联：一级只显示 provider，二级始终向右展开模型，支持悬停、方向键、首字母、pending/错误态与窄屏夹取；提交复用官方共享目录的 `ModelDirectory.select`。用户已确认可展开并选择。

### Q7：工作简报由谁生成、如何核查？
**结论**：`subagent_kimi_docs` 生成，`subagent_opencode_dsv41`（`ais1dsglm/deepseek-v4.1-flash`）独立核查源码/probe/profile/账本。核查后收紧两处证据口径：`dump-config` 只证明配置组合含插件、不能单独证明浏览器已加载；Cursor 失败按账本原文写「编辑前退出」，不额外强化未登记的分类标签。

## Key Decisions

- **不改官方 DSH 包**：全部实现为独立客户端插件，安装进既有 `web` profile（`link:` 本地依赖）。
- **类型徽标以实际路由为准**，工具名降级为「驱动」并写入 tooltip，避免把 `subagent_codex_relay` 说成 `subagent_codex`。
- **keepalive 明确标注为 UI 推断**，非 ACP 真实心跳；静默不改判状态。
- **token 只用真实投影**；前台 one-shot 不显示 token，不做估算（用户明确要求）。
- **无证据就显示通用名**，不猜执行者；关联不确定时标 `未关联`/`ambiguous`。
- **持久化仅本地浏览器**，实时行永远优先于历史快照；历史行不恢复运行时资源。
- **前台 one-shot 与可续接子智能体视觉可分**：11.5px 斜体 + 虚线左边框 + `一次性` chip；12.5px 半粗 + 实线左边框 + `可续接` chip；历史行 0.72 透明度 + `历史` chip。

## Created Files

- `D:\src\dsh\dsh-plugin-subagent-monitor\client.js` — 面板实现：类型/状态/keepalive/输出、持久化、token、视觉区分、`uiWorkspace` 导航
- `D:\src\dsh\dsh-plugin-subagent-monitor\probe/smoke-client.mjs` — 门禁，194 项全绿
- `D:\src\dsh\dsh-plugin-subagent-monitor\README.md` — 行为、安装、验证清单、限制
- `D:\src\dsh\dsh-plugin-provider-badge\client.js`、`probe/smoke-client.mjs`、`README.md` — 级联选择器，139 项全绿
- `.ptc/specs/subagent-monitor.spec.md`（增补 §9 v2）、`.ptc/specs/provider-badge-cascade.spec.md`
- `.ptc/verify-mon-11.mjs` — 主控独立验收脚本，63 项全绿
- `.ptc/receipt-st-*.json` — 各子任务 receipt（设计/复核/实现/验证/运行时/简报/面板扩展）
- `<DSH_HOME>/profiles/web\package.json` — 两个插件的依赖与 bundle 声明

## 验证基线（交接时）

- `node probe/smoke-client.mjs`（monitor）：`ALL PASSED (194 checks)`
- `node probe/smoke-client.mjs`（provider badge）：`ALL PASSED (139 checks)`
- `node .ptc/verify-mon-11.mjs`（主控独立验收）：`PASSED (63 checks)`
- `node --check client.js` / `index.js`：退出 0；`dsh --profile web --dump-config` 同时含两个插件
- PTC：`python ptc_task_control.py verify` → `ok: true`

## 注意事项 / 已知限制

- 改动需要**正常重启 DSH 并刷新**才会加载新 client bundle；不要用后台脚本强杀进程（历史上有过误关 GUI 的记录）。
- 持久化只在本地浏览器，清站点数据即丢失；历史行不可恢复运行时资源。
- 前台 one-shot 行永久无 token（无子会话，按决定不估算）。
- 同一插件在本次会话期间还被另一个会话（`session-bdc9c7d2`，任务 `task-20261014T054151359614Z-6c7d28538a7f`）并行改动过 `package.json`/probe/spec；合并后的状态已由双门禁复验。
- 若要**正文工具卡片**也显示执行者，需要新增 `conversation.chat.node` 席位装饰器（该席位存在），目前**未实现**。

## 交接：下一步唯一动作

正常重启 DSH → 打开 `子代理` 面板 → 核对三项：(1) 后台行徽标显示具体执行者；(2) 一次性行与可续接行视觉不同；(3) 只有子会话行显示 token。
若还需要正文卡片显示执行者，则下一轮唯一动作是：为 `conversation.chat.node` 注册装饰器，把 `subagent-N` 反查为执行者徽标。

---

## 追加：独立会话 `session-205744b7…`（2026-10-14 14:1x–15:0x）

> 本节由后续独立会话追加，只记增量；上文 Q1–Q7、Key Decisions、验证基线**未被改写**。
> 该会话不是本任务的 PTC 主控，只写本文件，未写 `.ptc/registry.jsonl`。

### A1：类型徽标「路由优先」口径的实现明细

**结论**：上文 Q1 描述的三级证据链由本会话实现；与并行会话的持久化/token/视觉改动合并后，门禁复验为 `ALL PASSED (194 checks)`（含本会话新增断言）。变更后 `client.js` 2082 行、`probe/smoke-client.mjs` 721 行。

落地细节（供日后改动对齐）：

- 新增纯函数 `routeOfDispatchArgs`（只认非空字符串 `provider`/`model`/`reasoning_effort`，等价工具实例的 `agentOptions`）、`typeOfRoute`（dispatch → selection，返回 `{label,color,source,route}`）、`routeTarget`、`selectedRouteOf`、`badgeTitle`。
- `rowType` 改为返回 `{label,color,via,driver,route}`，`via ∈ route|tool|fallback`；工具名派生结果**始终**保留在 `driver`，所以改成路由口径后不丢 spawn / fork 差异。tooltip 形如「实际路由：Codex-Relay（codex-relay / gpt-5.6-sol）· 驱动 spawn」。
- `collectDelegations` 解析 `tool/call` arguments 里的路由字段，并在 `buildRows` 的 continuable child / background job / 前台 one-shot 三处传播 `route`；徽标渲染新增 `data-subagent-type-via`。
- probe 新增 13 项断言，并**反转** 3 处旧「工具名优先」断言（旧口径已被取代）。`.ptc/specs/subagent-monitor.spec.md` §2 已改写为路由优先口径并标注该口径变更日期。

### A2：①（派发参数显式路由）此前为空的原因与打开方式

**结论**：① 只在 Host 偏好 `subagent-model-selection-settings` 具有**已记录的非空精确路由白名单**时才会出现。工具侧开关（profile patch 的 `tool-subagent` → `modelSelectionSettings: true`）一直是开的，缺的只是这份策略；因此 `subagent` 工具此前只暴露 `prompt`/`description`/`run_in_background`。

已于 15:02 打开：在 `<DSH_HOME>/profiles/web\cordis.patch.yml` 末尾追加顶层条目

```yaml
- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
  config:
    enabled: true
    allowedModels: [ais-2dsglm/deepseek-v4.1-flash, codex-relay/gpt-5.6-sol,
                    codex-relay/gpt-5.6, anthropic-relay/claude-opus-4-8,
                    anthropic-relay/claude-opus-5, anthropic-relay/claude-sonnet-5]
```

依据：`dsh-settings` README 明确「更改通过当前 profile 的 Cordis patch 持久化」，GUI「侧栏 → 插件 → 官方 → 子智能体 → 模型选择」保存时写的是同一落点。备份：`cordis.patch.yml.bak-before-subagent-model-selection-20261014-150218`。校验：`dsh --profile web --dump-config` 前后 diff **只有这一处新增**。

**生效边界**：只对保存之后**新建的顶层会话**生效；已有/恢复会话保持禁用（含显式为空的恢复），所以改动发生时正在运行的面板不会因此出现 ① 数据。
**未验证**：`patchReload: live` 是否已让运行中的宿主热加载该改动（GUI 端点需鉴权，实测 401/404，无法在线核对）。需在新会话里实测：若新会话的 `subagent` 工具仍无 `provider`/`model` 字段、也没有 `list_subagent_models`，则重启 DSH 后再试。
**代价**：开启后每个请求的 schema 多三个参数并多一个共享工具（`list_subagent_models`）；`allowedModels` 是白名单，模型只能在其中选。

### A3：该策略目前只在本机 patch 里（跨设备/发布待办）

**结论**：A2 的条目只存在于本机 profile patch，属设备本地渲染层，**不会随公开发布或换设备自动带走**。按既有渠道边界（见 `D:\src\dsh\dsh-config-pack\docs\ptc-public-companion.md` 与 skill `dsh-preset-pack`），应把 `enabled: true` 与去隐私的通用路由白名单上提到 Git 包（`config/40-models.yml` 或 `config/10-subagents.yml` 一类），个人/设备差异（route 偏好、绝对路径、凭据指针名）留在 SkillHub 私密侧与 `templates/device-config.env.example` 的环境变量；凭据值、会话历史、账本、个人路径一律不入 Git。

**已完成（2026-10-14 15:1x–15:4x）**：条目已上提到 `dsh-config-pack` —— `config/40-models.yml` 末尾新增该顶层条目（+32 行，含 6 条白名单：codex-relay/gpt-5.6-sol、openai-codex/gpt-5.6-sol、ais-2dsglm/deepseek-v4.1-flash、opencode-go/deepseek-v4.1-flash、anthropic-relay/claude-opus-5、claude-opus-4-8），`pack.manifest.yaml` 的 `owns` 补该 id（19 → 20），`npm run build` 重建 `cordis.patch.yml`，diff 确认**只多这一块**。
复验证据：`npm run verify` OK（20 owned id 各恰好一次）、`npm test` OK（68 assertions）、干净 profile `packverify2`（headless 模板 + web-app + subagent 包 + keypool，包排 bundles 末位）上 `verify.mjs --profile packverify2` 报 **no shadow**、`--dump-config` 报 **0 个 `patch: entry not found`、0 个 `did not activate`**、`verify.mjs --composed` 报 **21 tool row / 10 provider / 0 dangling**，组合结果 L525 处该行标记为 `# == @deepseek-ai/dsh-web-app, patched by dsh-config-pack`、`enabled: true` + 6 条白名单齐全。
**顺带修掉一个发布阻断**：公开模板里残留 `scripts/__pycache__/acp_smoke.cpython-312.pyc`，导致 `verify:ptc-public` 与 `npm test` 一直失败（模板 .gitignore 是 allowlist，已忽略故 git 不会漏，但门禁被蒙住）。删除后两门禁转绿。
**已发版（2026-10-14 15:28，提交 `227753d`）**：版本 `0.3.3` → **`0.4.0`**——`package.json` 与 `pack.manifest.yaml` 同步升级、`cordis.patch.yml` 头部随构建更新；`CHANGELOG.md` 的 `## Unreleased` 落成 `## 0.4.0`（并补本条目与 `__pycache__` 修复两条）；`README.md` 新增「子智能体逐次模型选择」一节、4 处 `#v0.3.3` 安装写法升为 `#v0.4.0`。提交 43 文件 / +6324 −32（**显式路径暂存，未用 `git add .`**），annotated tag `v0.4.0`，`git push --follow-tags` 已合并到 `origin/main`（本地与远端 0/0，远端 tag 对象 `daf3148`）。
**仍未做**：`public_companion.clean_profile_verified` 仍为 `false`——本次验的是**包**在干净 profile 的组合，不是公开 companion 的端到端验收；companion 的 clean-profile 端到端验收结论仍是 **not passed**，已在 CHANGELOG/README 如实标注。

---

## 追加：provider 徽标级联滚动缺陷（本会话 st-badge-12，用户已确认修复）

> 本节追加，不改写上文任何段落。

**现象**：模型列表很长时，鼠标滚轮与拖动滚动条都无法下滚。
**根因**：`D:\src\dsh\dsh-plugin-provider-badge\client.js` 用**捕获阶段**监听 window 的 `scroll` 关闭弹层；`scroll` 不冒泡，但会在捕获阶段自 window 下传到目标元素，因此在弹层内部滚动列表时同样命中监听，弹层被立即关闭。
**修复**：
- 新增纯函数 `shouldCloseOnScroll(target)`（`client.js:552`）：目标命中 `[data-provider-badge-cascade]` / `[data-provider-badge-root]` → 不关闭；`null`、无 `closest`（document/window）、`closest` 抛错 → 保守关闭。
- scroll 监听改为受其守卫（`client.js:783-788`）；`resize` 仍无条件关闭，保留防锚点漂移语义。
- `PANEL_BASE_STYLE` 增加 `overscrollBehavior: "contain"`（`client.js:695`），滚轮到列表末端不串联滚动页面（否则页面一滚又会关弹层）；`maxHeight` + `overflowY: auto` 保留，滚动条正常出现。

**副作用排查**：`dsh-plugin-subagent-monitor` 没有 window scroll 监听，不受影响。
**验证证据**：probe `ALL PASSED (147 checks)`（原 139 项全保 + 新增 8 项）；主控独立验收 `.ptc/verify-badge-12.mjs` `PASSED (10 checks)`；修复前该脚本在 `shouldCloseOnScroll` 处 FAIL（基线反证）；`node --check client.js` 退出 0；用户已确认修复。
**路由**：R7 → `continuous-cursor-grok`；Cursor 本会话连续 4 次失败（process-exit / 600s 超时），按候选链降级 `subagent_opencode_dsv41`（`ais1dsglm/deepseek-v4.1-flash`）。
**限制**：页面滚动与窗口 resize 仍会关闭弹层（刻意）；列表短于 340px 上限时滚轮会滚动页面并关闭弹层（预期）。

