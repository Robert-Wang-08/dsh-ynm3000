# dsh-plugin-new-session

在 **DSH 会话内**用一句话创建**独立顶层会话**（等价于 Web GUI 的「新建会话」按钮），
而不是 `subagent_*` 那种挂在本会话下、结果必须回流到本会话的子会话。

> 自写资产标记：`origin: self` / author: wang / created: 2026-10-20 / version: 0.1.0

## 它解决的到底是什么问题

DSH 0.2.0-rc.2 里，agent 可见的工具集中**没有**创建顶层会话的能力：

| 能力 | 归属 | 现状 |
| --- | --- | --- |
| 顶层会话创建 | RPC `@deepseek-ai/dsh-api-session-controller#session/create`（GUI 新建按钮） | 存在，但**未暴露为 agent 工具** |
| 子会话 | `subagent` / `subagent_fork` / `workflow` | 有工具，但产出 `origin: 'subagent'`、带 `parentSession`，不算独立会话 |
| 实验性队友会话 | `dsh-experimental-tool-agent-team` 的 `spawn_teammate` | 未在 web profile 启用 |

本插件把第一行补成 agent 工具：`new_session`。

`create()` 内部调用 `agents.ensureSession(id, cwd, ...)`，新会话 header **不带**
`parentSession`、**不带** `origin: 'subagent'`，因此是普通顶层会话，会出现在 GUI
侧边栏会话列表里，并且在本对话结束后继续存在。

## 安装（标准插件登记）

```powershell
dsh plugin --profile web add D:\src\dsh\dsh-plugin-new-session
```

然后重启 `dsh web` 并**新开一个会话**（工具表在会话启动时生成，旧会话看不到新工具）。

登记形式是 `link:` 依赖，指向本仓库的插件目录、不复制代码，所以：

- `git -C D:\src\dsh pull` 之后重启即得新版，**不需要重新 add**；
- 换设备 clone 本仓库后，执行一次同样的 add 即可，之后同样随 pull 自动更新。

> 曾评估过另一条路：在 profile 补丁层挂本地入口（`name: D:/.../index.js`，cordis 会把
> 绝对路径规范化为 `file:` URL，确实可以完全不用 add）。**未采用**，因为那行配置在
> `~/.dsh` 里、还硬编码仓库路径，换设备要手改，比 `plugin add` 更难搬，也与
> `dsh plugin list` 的可见性脱节。

## 工具签名

```text
new_session(
  title?:        string   新会话标题，便于在侧边栏辨认
  firstMessage?: string   创建后立即发送的首条用户消息
  cwd?:          string   显式改到别的目录/工作区；省略则继承当前会话的工作区
  agentPreset?:  string   Agent 预设 id，默认部署预设
) -> {
  sessionId:    string
  cwd:          string
  workspaceId?: string   归属的工作区（省略表示未归入任何工作区）
  title?:       string
  prompted:     boolean
  warnings:     string[]
}
```

行为边界：

- **工作区归属（默认行为）**：不传 `cwd` 时，新会话加入当前会话所在的同一个
  Workspace —— GUI 侧边栏的同一个目录分组，而不是只把 cwd 设成一样。
  解析顺序：
  1. 当前 Session id 出现在某 Workspace 的 `sessionIds` 里 → 用该工作区；
  2. 否则按目录比对，`canonicalPath(当前会话 cwd) === canonicalPath(workspace.path)`；
  3. 都没有 → 退回只传 `cwd`（与旧行为一致），`workspaceId` 不出现在输出里。
  传了 `cwd` 时：若它正好等于某个工作区目录，就归入该工作区；否则按纯目录处理，
  不会强行把会话塞进不相关的工作区。
  `create()` 的 `workspaceId` 与 `cwd` **互斥**，插件保证只发其中一个。
- `title` 依赖宿主的 `sessionTitle` 服务；缺失时降级为 warning，会话仍创建成功。
- `firstMessage` 的失败**按类别处理**：
  - `session/model-unavailable`（新会话还没解析出可用模型）→ 降级为 warning，
    会话保留，用户在 GUI 里选模型后继续；
  - **其它任何错误 → 直接抛出**，消息里带上已建好的 `sessionId`。这样参数漏传、
    宿主契约变化这类缺陷会立刻暴露，而不是伪装成“会话建好了”。
- 插件不切换浏览器当前页面。新会话出现在侧边栏，点击进入。

## 实现要点

- 纯 host 半、**零外部依赖**：只用 `node:crypto` / `node:fs` / `node:path` 内置模块。
  本插件以 `link:` 登记，自身目录没有 `node_modules`，import 官方包会解析失败，
  因此按 `ToolDefinition` 的固定形状手写工具定义
  （`{ name, description, parameters, output: { schema, render }, execute }`）。
- `inject = ['tools', 'sessionController']`：任一服务缺失则不激活，headless 等
  没有 Web 会话控制器的 profile 不会被误加载。
- `workspaceRegistry` 是**可选**服务，运行时用 `ctx.get('workspaceRegistry')` 取；
  拿不到就跳过工作区归属，不会因为 profile 未挂工作区而让插件整体不激活。

## 验收

重启后新会话里：

1. 工具表中应出现 `new_session`；
2. 调用一次 `new_session({ title: 'smoke', firstMessage: '回复 OK' })`；
3. 期望：返回 `sessionId` 形如 `session-<uuid>`、`workspaceId` 等于当前会话所在
   工作区的 id、`prompted: true`；
4. GUI 侧边栏里，新会话应出现在**与当前会话同一个工作区分组**下，且其中有一条用户消息；
5. 检查 `~/.dsh/logs/` 无 `did not activate`、无 `patch: entry ... not found`。

## 回滚

```powershell
dsh plugin --profile web remove dsh-plugin-new-session
```

重启 DSH。插件目录可保留，删除 `D:\src\dsh\dsh-plugin-new-session` 即可彻底清理。

## 限制

- 目前只覆盖「创建 / 标题 / 首条消息」，不覆盖跨会话切换、队列编辑、附件上传。
- 若宿主未来把 `sessionController.create` 改为需要浏览器 peer 上下文，本插件会以
  `gateway/*` 错误暴露，届时需要改为经 `connection` 通道转发。
