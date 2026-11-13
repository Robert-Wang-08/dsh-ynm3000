# 会话列表可见性：superagent worker 与 PTC subagent 会话

> 只读分析，未改动任何宿主/插件代码。基线：DSH `0.2.1-rc.5`，本机 DSH_HOME = `%USERPROFILE%\.dsh`。
> 取证时间：2026-11-12。相关：`docs/ops/superagent-profile.md`（superagent 宿主跑在 127.0.0.1:3082）。

## 1. 结论（先给答案）

1. **DSH 本体没有"显示/隐藏子智能体会话"的配置开关**，正反两个方向都没有。列表可见性由一条写死的判定决定：会话 header 的 `origin` 等于 `"subagent"` 就永不进列表。
2. 你在工作区列表里看到的 **superagent worker 是普通会话**（id 形如 `worker-<ticket>`），不是 `origin=subagent` 的子会话，所以默认一定显示；要它不显示，没有任何配置项可改。
3. PTC / `subagent_*` 派生的子会话是 **`origin=subagent` 的子会话**，被硬屏蔽在列表外，只能在父会话右上「子智能体」面板里以会话视图打开。想让它出现在列表里，只能改 DSH 本体。
4. 真正的"开关"只能落在**侧栏插件层**：`@local/dsh-plugin-sidebar-visibility` 已经独占会话树，在它的 `visibleSession()` 里加一条前缀/路径过滤 + 一个持久化勾选，就是可开关的实现（需重建产物 + 重启承载该 GUI 的 dsh 进程 + 刷浏览器）。

## 2. 机制：两条完全不同的"子智能体"路径

| 维度 | superagent worker | PTC / `subagent` 子会话 |
| --- | --- | --- |
| 会话 id | `worker-<ticketId>` | 独立 child session id |
| 创建方式 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` | 子代理运行时创建 child session |
| header.origin | 未设置（普通会话） | `"subagent"`（唯一允许值） |
| 所属工作区 | 每个 ticket 一个 workspace | 不注册进 workspace 列表 |
| 会话列表可见 | **是**（无开关可关） | **否**（无开关可开） |
| 查看入口 | 侧栏会话行本身 | 父会话头部「子智能体」面板 → 右侧子会话 chat 标签 |

## 3. 源码取证

会话列表可见性判定（官方侧栏）：

- `dsh-client-ui-workspace/lib/client.js:964` `sessionVisible()`：`if (session.origin === "subagent") return false;`；blank 会话只留当前一个；归档走 `archivedFilter`。
- 侧栏插件同规则：`dsh-plugin-sidebar-visibility/src/client/WorkspaceTree.tsx:223-230` `visibleSession()`：`if (!s || archivedSet.has(id) || s.origin === "subagent") return null`。这是**唯一过滤点**，改一处即可全局生效。

子会话的 origin 限制：

- `dsh-session/lib/index.js:1053`：`if (record.origin !== void 0 && record.origin !== "subagent") throw ...` —— 只有两种会话。
- `dsh-subagent/lib/index.js:354`：子代理创建 child session 时写 `origin: "subagent"`。

superagent worker 的创建路径：

- `dsh-superagent/src/executor/dsh.ts:24` `workerSessionId()` → `worker-<ticketId>`。
- `dsh-superagent/src/app/sessions.ts:138-155` `ensure()`：`workspaceRegistry.create(cwd)` + `sessionController.create({ sessionId, workspaceId, agentPreset })` + `rename(title)`，**不写 origin**。

无开关的证据（穷举 grep，命中 0）：

- DSH 全部包：`showSubagent` / `includeSubagent` / `subagentSessions` / `hideSubagent` / `sessionVisibility` → 0 命中；只有 `archivedFilter`（default/show/only）。
- `dsh-superagent`：无 archive / hide / visibility 相关设置项。

## 4. 为什么 3080 的 GUI 能看到 3082 宿主建的 worker

`DSH_HOME` 下 `sessions/`、`storages/workspace.json` 是**全局共享**的，不按 profile 隔离：

- `storages/workspace.json` 实测 34 个工作区，其中 **22 个**位于 `%USERPROFILE%\.dsh\state\superagent\work\<ticket>`，每个各含 1 个 `worker-*` 会话（例：`skill-qa-cli-bd2de043b805`）。
- superagent 只在 `superagent` / `sa-local` 两个 profile 的 bundle 里；`web` profile 没有 `dsh-superagent`，却照样列出这些会话行——因为注册表是同一份。

## 5. 可选"关掉"方案（按成本排序）

| 方案 | 做法 | 成本/重启 | 副作用 |
| --- | --- | --- | --- |
| A. 归档单个会话 | 会话行「归档」，写 `archivedSessionIds` | 零成本、热生效 | 每个新 ticket 仍会新建 workspace + 会话，要反复归档 |
| B. 隐藏工作区 | sidebar-visibility 的「隐藏」按钮（localStorage） | 零成本、热生效 | 22 个 work 目录 = 22 个分组，需逐个隐藏；「目录树视图」只在父目录已被登记为工作区时才嵌套，不虚构未登记目录 |
| C. 让 superagent 不再建 worker | 停 3082 宿主 / 从 profile 移除 `dsh-superagent` bundle | 改 profile 需停宿主（避免 pnpm 打断在跑会话），改完重启 | 功能本身消失，不是"隐藏" |
| D. 插件层加开关（推荐） | `WorkspaceTree.tsx` `visibleSession()` 加 `worker-` 前缀或 `<DSH_HOME>\state\superagent\work` 路径判定 + 一个持久化勾选（沿用 `dsh.sidebar-visibility.v1` 键） | `pnpm run bundle` → 重启 dsh（web 与 superagent 两个宿主都要）→ 刷浏览器 | 只影响显示，会话照常运行；两个 profile 都挂了这个插件，一次改两处生效 |
| E. 改 DSH 本体 | 在 `dsh-client-ui-workspace` 的 `sessionVisible()` 加配置项 | 改 node_modules 安装、升级即覆盖 | 违反本工作区「本体改动走 checkout 并明确说明」约定，不建议 |

## 6. "打开"方向（让 subagent 会话进列表）

唯一可行的是改 DSH 本体 `sessionVisible()` 放开 `origin === "subagent"`。不建议：会话树分组是按 `workspace.sessionIds` 派生的，子会话不在任何 workspace 的成员里，放开过滤也只会掉进「未分组」，且子会话的 delivery 走 subagent 路由，普通 RPC 会拒绝（`dsh-api-session-controller`：`session/agent-busy` / `use subagent delivery`）。

正确姿势仍是现有能力：在父会话头部「子智能体」面板点开子会话，右侧栏以会话视图显示（`dsh-client-ui-subagent` 的 `sidebar.right.pane.tab` + `openSession(childSessionId)`）。

## 7. 验证方法（改完后）

1. `dsh --profile web --dump-config` 退出 0，无 `did not activate`。
2. 起宿主后新开浏览器页：worker 行消失、普通会话行与「仅收藏 / 归档过滤」不受影响。
3. 反向验证：关掉勾选后 worker 行立即回来（纯客户端派生，不需要重启）。

## 8. 限制

- 过滤是客户端派生视图，Host 数据（`workspace.json` / `archivedSessionIds`）不变；换 GUI 或换插件列表模式仍旧可见（官方 WorkspaceBrowser 也照旧过滤 subagent，但会显示 worker）。
- 本机同时存在 3080（web）与 3082（superagent）两个宿主，任一宿主的改动只对该宿主的页面生效，要两边都刷。

## 9. 实现（2026-11-13，方案 D 落地）

已在插件 `dsh-plugin-sidebar-visibility` 落地「隐藏任务」开关（commit `7944884`，`main`）：

- `src/client/superagent-filter.ts`：新增纯函数 `isSuperagentWorkPath` / `isWorkerSessionId` / `isSuperagentTaskSession`，只认 `/.dsh/state/superagent/work` 路径段（Windows 反斜杠、大小写不敏感、目录边界匹配），不依赖用户名或盘符。
- `src/client/visibility-store.ts`：偏好新增 `hideSuperagentTasks`（默认 false，沿用 `dsh.sidebar-visibility.v1` 单键）。
- `src/client/WorkspaceTree.tsx`：树顶「隐藏任务」勾选框；打开后 `visibleSession()` 过滤 `worker-*` 会话，`visibleWorkspaces` 过滤 work 工作区，分组 / 目录树 / 平铺 / 检索 / 置顶区一致生效；关闭立即恢复。
- 测试：`node scripts/test-superagent-filter.mjs`（13 项）、`test-hierarchy.mjs`（26 项）、`test-bundle.mjs` 全过；`pnpm run bundle` 产物已入库。

本机实测（web profile，1440×2600 同视口、同一浏览器会话；会话标题已模糊）：勾选前 36 个工作区分组（其中 22 个 `.dsh/state/superagent/work/*`），勾选后 14 组，`worker-*` 会话与 work 工作区全部消失；取消勾选立即恢复（DOM 计数 36 ↔ 14）。

- [勾选前：36 组，worker 会话与任务工作区可见](../screenshots/superagent-task-filter/before-worker-visible.png)
- [勾选后：14 组，superagent 任务整体退出列表](../screenshots/superagent-task-filter/after-tasks-hidden.png)

生效条件与限制：改动只影响插件增强树；官方「原始列表」模式仍显示 worker（与方案 D 的说明一致）。两个宿主（3080 web / 3082 superagent）都要重启 `dsh` 并刷新浏览器才会加载新 client bundle；本次未重启宿主。