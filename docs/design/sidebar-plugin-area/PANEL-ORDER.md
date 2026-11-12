# 左侧栏插件入口顺序：机制与调整方法

> 问题：插件入口的顺序是怎么定的？想把「最近会话」「进度看板」放最上面、「仪表盘」放最下面，怎么实现？
>
> 适用：本机 DSH 0.2.1-rc.5，`web`(3080) / `superagent`(3082) / `plugtest`(3081) 三个 profile；入口由各插件注册的 `sidebar.panellist` 决定。

## 1. 顺序由 `order` 决定

每个插件在 `sidebar.panellist` 注册时给一个 `order`：

```ts
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'recent-sessions',
  order: 40,                  // ← 排序键
  label: '最近会话',
}, RecentGlyph))
```

官方 `ui-sidebar` 的 `syncPanels`（`...\dsh-client-ui-sidebar\lib\client.js:567-575`）把当前注册项映射成 `{ id, order: options.order ?? 0, label }`，然后：

```js
.sort((a, b) => a.order - b.order)
```

- **升序**：`order` 越小越靠上。
- **相同 order**：JS 的 `Array.prototype.sort` 在现代引擎里是稳定排序，保留注册先后（后注册的排后）。
- 未写 `order` 时按 `0`。
- 排序后，`SidebarRoot` 依次渲染每个 panel row；**「更多」行不参与排序**，固定追加在所有 panel 行之后（`SidebarRoot.tsx` 的 `panels.map(...)` 之后渲染 `PanelMoreMenu`）。
- `id === 'plugins'` 只表示「永不隐藏」，不表示「永远第一」；它也有自己的 `order`（当前是 0）。

> 另：`sidebar.panellist` 的注册项也可能被用户在「更多」菜单里 Unpin（0.2.1 的 `panel-pins`，当前默认 UI 没有提供操作入口）；那只是过滤显示，不影响 order。

## 2. 你当前的实际顺序

按本机已注册的 `order` 从小到大：

| 顺序 | 入口 | 注册方 | order |
| --- | --- | --- | --- |
| 1 | 仪表盘 | `@weibaohui/dsh-dashboard` | **-100** |
| 2 | 插件 | `@deepseek-ai/dsh-client-ui-plugin-manager` | 0（固定显示） |
| 3 | 自动化任务 | `@deepseek-ai/dsh-client-ui-schedule` | 10 |
| 4 | 进度看板 | `dsh-ui-progress` | 20 |
| 5 | 最近会话 | `dsh-recent-sessions` | 40 |
| 6 | 更多 | `dsh-client-ui-entry-customization` + `SidebarRoot` | 不参与排序，固定最后 |

## 3. 目标顺序与具体改法

目标：最近会话、进度看板在最上；仪表盘在最下。其余（插件 / 自动化任务）相对位置未指定，下面假设保留在中间。

一个直接可用的 `order` 方案：

| 入口 | 现在 | 改成 |
| --- | --- | --- |
| 最近会话 | 40 | **-200** |
| 进度看板 | 20 | **-190** |
| 插件 | 0 | 0（不动） |
| 自动化任务 | 10 | 10（不动） |
| 仪表盘 | -100 | **1000** |

得到：最近会话 → 进度看板 → 插件 → 自动化任务 → 仪表盘 → 更多。

> 注意：「更多」始终追加在最后。若你要「仪表盘在更多下面」，`order` 做不到；需要把更多行也纳入排序（改核心）或把更多行移到别处。

### 方案 A：改注册方 `order`（干净、长期）

对每个插件源/产物改 `order`，重建/重装后重启 profile。

- **`dsh-recent-sessions`**（GitHub 包，手写 bundle）：
  - 改 `...\profiles\<p>\node_modules\dsh-recent-sessions\lib\client.js` 里的 `order: 40` → `-200`（该包没有源码构建链，产物即源）。
- **`dsh-ui-progress`**（npm 包）：
  - 改源码 `order: 20` → `-190` 后 `pnpm run build`；或直接改 `lib/client.js` 的 `order: 20`。
- **`@weibaohui/dsh-dashboard`**（npm 包）：
  - 改源码 `order: -100` → `1000` 后构建；或改其 `dsh.client` 指向的客户端产物。
- 重启 `web`/`superagent` 对应进程（或至少刷新页面；生产建议重启），确认顺序。

**持久化问题**：直接改 `node_modules` 在 `pnpm install` / 插件升级后会被覆盖。两个稳妥做法：

1. **pnpm patch**：在 profile 的 `pnpm-workspace.yaml` 增加 `patchedDependencies`，把改动存成 `patches/<pkg>@<ver>.patch`（本机 web profile 已有先例：`patches/@deepseek-ai__dsh-subagent-claude-code@0.2.1-rc.5.patch`）。升级 DSH/插件后更新 patch。
2. **fork / 本地 link**：把这三个插件 fork 到 `D:\src\dsh` 下改 order，再用 `link:` 依赖接入；维护成本最高，但最可控。

### 方案 B：侧栏插件里做顺序覆盖（快、不动第三方包）

在已有的 `dsh-plugin-sidebar-panel-area`（或新 sibling 插件）里加一个「顺序偏好」：

- **只改视觉顺序（CSS）**：
  ```css
  nav[class*="_panelList"] > button[aria-label="最近会话"] { order: -200; }
  nav[class*="_panelList"] > button[aria-label="进度看板"] { order: -190; }
  nav[class*="_panelList"] > button[aria-label="仪表盘"]   { order: 1000; }
  nav[class*="_panelList"] > [class*="_moreAnchor"]        { order: 1100; }
  ```
  `nav` 是 `flex-direction: column`，`order` 会改视觉顺序。**但 DOM / Tab / 读屏顺序不变**；纯视觉需求够用。
- **改真实顺序（DOM 重排）**：按 `aria-label` 找到这些 row，`nav.append(...)` / `insertBefore` 按目标顺序重排；用 `MutationObserver` 在 React 重渲染后重放。键盘/读屏顺序随 DOM 改变，但依赖 label/class 结构，升级易碎。
- 偏好可存 `localStorage`（例如 `dsh.sidebar-panel-order.v1`），或先硬编码这三项；后续想支持拖拽排序再扩展。
- 优点：一次装到 web/superagent/plugtest，三个 profile 都生效；不用改 npm 包；插件升级不覆盖。
- 缺点：DOM 耦合；label 作为键，多语言/改名要同步；CSS 方案不改善 a11y。

## 4. 建议

- 如果这三个入口的顺序长期固定，且你愿意维护补丁/分支：走 **A**（`order` 是官方唯一正确语义，干净）。
- 如果只想本机立刻生效、不想动第三方包：走 **B**，把排序做进已有的 `dsh-plugin-sidebar-panel-area`；这和折叠/高度是同一层 DOM 增强，风险一致。
- 若希望「任意插件可配置顺序」成为产品能力：应改 `ui-sidebar`，把 order 变成可保存的偏好（或由 profile 配置覆盖），这是核心改动，不适合插件硬改。

## 5. 待确认

1. 「仪表盘放最下方」是指 panel 行最后（在「更多」上面），还是连「更多」也要在它上面？
2. 中间三项（插件 / 自动化任务）保持现在的相对位置吗？
3. 要 A（改 order + patch/重启）还是 B（插件 DOM/CSS）？要 B 的话我可以直接扩到现有插件并在三个 profile 验证。
