# DSH Web 左侧栏「会话 / 插件区」高度可调 · 分析

> 状态：分析稿（未改代码）。回答「插件区能不能折叠、高度能不能调、怎么调」。
>
> - 运行版：`@deepseek-ai/dsh` **0.2.1-rc.5**（`C:\nvm4w\nodejs` 是指向 `C:\Users\wwm_1\AppData\Local\nvm\v24.18.0` 的符号链接；`--profile web`，3080 端口）。
> - 本地 DSH 源码：`D:\src\deepseek-harness` = **0.1.6-alpha.2**（最后提交 2026-10-06），比运行版旧，不含 0.2.1 才有的「更多 / Pin」逻辑。
> - 侧栏实际内容由 `web` profile 的第三方插件共同决定：`dsh-dashboard`、`dsh-ui-progress`、`dsh-recent-sessions`、`dsh-plugin-sidebar-visibility` 等。
> - 方法：静态阅读运行版编译包（`...dsh-client-ui-sidebar/lib/client.js`，含内嵌 CSS）、本地 0.1.6 源码、profile 的插件注册与入口元数据；**未在浏览器中截图/DOM 实测**（3080 需要本地 token）。行高/行数结论来自代码与注册项，实际像素以你的窗口为准。

## 0. 结论（先看这一段）

1. **现象成立，而且比「不好调」更糟：目前完全没有入口。** 左侧栏里插件贡献的入口是 `flex: none` 的固定行列表，每行 36px、没有最大高度、没有内部滚动；会话区是 `flex: 1`。插件入口越多，会话列表就越矮，甚至可以被压到接近 0，侧栏列再按 `overflow: hidden` 把底部裁掉。
2. **现有「更多」菜单和 Pin 机制不能替代。** 0.2.1 的 `sidebar.panellist.actions` 菜单在默认组合里只提供「浏览更多插件 / 创建你的插件」两行，不列面板、**没有 Pin 控件**；`panel-pins` 只是内存状态，插件重载即重置（包 README 明说）。用户今天没有任何办法把某个插件入口藏起来，更没法调高度。
3. **推荐交互：在「插件入口列表」和「会话列表」之间加一条可拖拽分隔条 + 一键折叠。** 拖拽决定插件区高度（超出内部滚动），拖到最小/双击折叠；高度与折叠态存 `localStorage`，刷新后保持；折叠后保留「插件」固定行 + 展开箭头，面板选中态不受影响。默认建议「展开 + 限高 40%（最多约 5 行）」，用户可自行折叠。
4. **交付路径需要你先定：**
   - **A. 改核心 `ui-sidebar`（体验最好、最稳）**：从 0.2.1-rc.5 对应源码改，本机用「备份 + apply/revert 补丁脚本」安装，另提 upstream PR。缺点是要维护补丁，DSH 升级后需重放。
   - **B. 做成侧栏插件（改动留在 `dsh-ynm3000` 仓库、可逆）**：用 DOM/CSS 注入实现折叠与拖拽。快、可回滚，但依赖 `_panelList` / `_regionArea` 这类会被构建哈希改写的 DOM 结构，DSH 升级时要适配。
   - 只改编译产物 `lib/client.js` 的补丁也能做，但 CSS 是内嵌字符串，维护性最差，不建议作为长期方案。

## 1. 现状

### 1.1 侧栏的 DOM / 布局结构

以本机 0.2.1-rc.5 的编译包为准（`...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar\lib\client.js`；0.1.6 源码结构一致，只是没有「更多/Pin」，见 `D:\src\deepseek-harness\packages\client\ui-sidebar\src\client\SidebarRoot.tsx`）。

```
┌──────────────────────────────────────┐
│ 品牌行 / 收起按钮            logoRow    │  60px + 8px
├──────────────────────────────────────┤
│ 新会话                      newSession  │  38px + 12px
├──────────────────────────────────────┤
│ 仪表盘                              │
│ 插件（固定显示）                     │  panelList：flex:none
│ 自动化任务                          │  每行 min-height 36px，gap 2px
│ 进度看板                            │  margin-bottom 8px
│ 最近会话                            │  无 max-height、无 overflow
│ 更多                                │
├──────────────────────────────────────┤  ← 目前没有分隔条 / 折叠控件
│ 搜索 / 视图 / 会话树 …       regionArea │  flex:1; min-height:0
│ （sidebar.workspaces 占用者）          │  overflow:hidden
├──────────────────────────────────────┤
│ 页脚动作 / 设置              footArea   │  flex:none
└──────────────────────────────────────┘
```

关键事实（`SidebarRoot.tsx` / `SidebarRoot.module.css`，0.1.6 源码行号；0.2.1 编译包同构）：

- 外壳是 `display:flex; flex-direction:column; height:100%`（`.root`，`SidebarRoot.module.css:9-23`）。
- 插件入口列表 = `<nav class="panelList">`（`SidebarRoot.tsx:253-267`）；CSS 为 `flex:none` + `gap` + `margin-bottom`，**没有 `max-height` / `overflow`**（`SidebarRoot.module.css:429-435`，0.2.1 里 gap 是 2px、margin-bottom 8px）。
- 会话区 = `.regionArea`：`flex:1; min-height:0; overflow:hidden`（`SidebarRoot.module.css:499-511`）。
- 侧栏列由布局提供：`.sidebarCol { min-width:0; overflow:hidden; ... }`（`packages/client/ui-layout/src/client/AppFrame.module.css:65-72`），所以固定行超出后不会把列撑开，而是裁剪。
- 侧栏展开宽度 280px，可拖拽 264–420px（`ui-layout/src/client/columns.ts:13-17`），拖拽手柄是 8px 透明条、pointer capture + rAF 节流（`AppFrame.tsx:58-…`；`ui-layout/lib/client.js` 里 `DragHandle` / `setSidebar` 同一套）。**高度方向没有对应实现。**

### 1.2 你这台机器上实际有哪几行

`web`（3080）与 `superagent`（3082）两个 profile 用的是**同一份** `ui-sidebar`；入口集合各自不同，但布局结构与根因完全一样。下面以入口更丰富的 `web` profile 为例：

`sidebar.panellist` 的注册来自：

| 来源 | 入口 | order |
| --- | --- | --- |
| `@weibaohui/dsh-dashboard` | 仪表盘 | -100 |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 插件（固定行，永远显示） | 0 |
| `@deepseek-ai/dsh-client-ui-schedule` | 自动化任务 | 10 |
| `dsh-ui-progress` | 进度看板 | 20 |
| `dsh-recent-sessions` | 最近会话 | 40 |
| `@deepseek-ai/dsh-client-ui-entry-customization` | 更多（触发 `sidebar.panellist.actions` 菜单） | — |

6 行 × 36px + 5 × 2px gap + 8px margin ≈ **234px**（入口是否显示由各插件的配置/启停决定，实际行数可能略有出入）。在 900px 高的窗口里约占 26%；再叠加会话区自己的搜索/视图头，会话行能看到的数量很有限。若再装几个带入口的插件，234px 会继续线性增长。

> 这 5 个面板入口 + 「更多」应该就是你说的「插件区域」。如果你指的是别的位置（例如插件管理页里的分组、或右侧栏的插件 tab），下面方案的目标会不同，先告诉我。

### 1.3 为什么「更多」和 Pin 救不了

- 「更多」菜单的内容来自 `sidebar.panellist.actions` 注册项。本机唯一注册者是 `dsh-client-ui-entry-customization`，它渲染的是：
  - 浏览更多插件（`pluginNavigation.openList()`）
  - 创建你的插件（新会话 + `cordis` preset）
  - 不渲染 `entries`，也没有 Pin 操作（`...dsh-client-ui-entry-customization\lib\client.js:102-146`）。
- `panel-pins` 的 `unpinned` 只是 `createSnapshotStore` 的内存数组（`...ui-sidebar\lib\client.js:12-30`）；`SidebarRoot` 只在渲染时过滤 `id === "plugins" || !unpinned.includes(id)`（同上 `:468-501`）。没有 UI 能把某个 id 放进 `unpinned`；即便有，插件重载也会重置。README 原文也写了「其他注册项仍可调用 Pin 回调，但插件重新加载时选择重置，不读取旧 localStorage 值」。
- 侧栏整体收起是 56px 轨道（`collapsed`），它连会话区一起隐藏，和「在展开状态里重新分配上下空间」不是一回事。

### 1.4 根因

- 布局层面：插件区 `flex:none` 且无高度上限，会话区 `flex:1`；两者之间没有可调的分隔。
- 状态层面：没有「插件区高度 / 折叠」偏好；侧栏宽度偏好本身也标注为 *Transient layout preferences*（`ui-layout/src/client/stores.ts:12-15`），刷新回默认 280，说明现有布局状态并不承诺持久化。
- 交互层面：没有手柄、没有折叠按钮，也没有可发现的 affordance。
- 版本层面：本地源码是 0.1.6，运行版是 0.2.1；0.1.6 的 `SidebarRoot.tsx` 里没有 0.2.1 的 `panel-pins` / `More` 逻辑，**不能直接拿本地 fork 当实施基线**。

## 2. 需求理解与边界

**目标**

- 在左侧栏内部，把垂直空间在「插件入口区」和「会话区」之间做可调分配。
- 插件区可折叠；展开时高度可拖拽；刷新后保持。
- 不改变 `sidebar.panellist` 的注册协议；不改主面板、选中态、会话数据。
- 折叠/调高后，所有面板仍可达（至少保留一个展开入口）。

**非目标**

- 不隐藏/卸载插件，不改插件管理页。
- 不改变侧栏整体 56px 收起行为，不动右侧栏。
- 不引入横向布局或拖拽排序（那是另一件事）。

**默认值建议**

- 默认展开；高度 = `min(内容高度, 侧栏内高的 40%)`，且至少 1 行。
- 用户拖拽后以 px 记忆；窗口变小时按当前可用空间 clamp，**不覆写**偏好值。
- 折叠态 = 插件区收成 36px 的一条（保留「插件」入口 + 展开箭头），或完全收起只留一条 12px 恢复条（二选一，见 §4.3）。

## 3. 方案对比

### 3.1 交互方案

| 方案 | 交互 | 改动面 | 体验 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 拖拽分隔条 + 一键折叠** | 插件区与会话区之间 8px 横条；拖动改高度；双击折叠/恢复；插件区内部滚动 | 中（核心 shell 一处状态 + CSS + 手柄） | 最贴近「高度可调」，空间利用最灵活 | **推荐** |
| B. 只做一键折叠 | 一个 chevron/按钮整体收起插件区，再点展开 | 小 | 解决「会话看得少」，但没有「高度可调」 | 可作为 A 的子集先上线 |
| C. 复用 More/Pin + 持久化 | 把面板逐个 Pin/Unpin，收进 More 菜单 | 小 | 操作繁琐，不是高度控制；默认 More 菜单还要重做 | 不单独采用 |
| D. 侧栏整体收起 | 现有 56px 轨道 | 0 | 连会话一起没了 | 与需求正交 |

建议做 **A**，把 **B** 作为 A 的一个手势（拖到最小 / 双击 = 折叠）；**C** 只在折叠态需要「把隐藏入口放进 More 菜单」时作为配套。

### 3.2 交付路径

| 路径 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **1. 核心 `ui-sidebar` 改动** | 从 0.2.1-rc.5 对应源码改 `SidebarRoot.tsx` / `.module.css` / `locales.ts`，构建；本机用 apply/revert 补丁脚本装到全局 `dsh` 包；同时提 upstream PR | 体验、无障碍、与设计系统一致；不依赖 DOM 哈希 | 需要维护补丁；DSH 升级要重放；本地源码落后，要先取对版本 |
| **2. 侧栏插件（DOM/CSS 注入）** | 新插件或扩展 `dsh-plugin-sidebar-visibility`：注入 `<style>`，在 `[class*="_panelList"]` 与 `[class*="_regionArea"]` 之间做手柄/折叠，`localStorage` 记状态 | 改动留在 `dsh-ynm3000` 仓库，可热拔；不碰 node_modules | 依赖构建哈希类名（`_panelList`/`_regionArea` 后缀）、React 重渲染要重新挂载；无障碍要手写；升级易碎 |
| **3. 只改编译产物 `lib/client.js`** | 直接字符串替换已安装 bundle（CSS 是内嵌一行） | 最快 | 可读性/可维护性最差，不建议 |

**建议**：如果这是长期要用的产品能力，走 **1**；如果近期就要在你这台机器上用、且希望改动可回滚并落在运维仓库，走 **2** 做原型，验证交互后再决定是否上游。两条路可以并存：先用 2 验证，再提交 1。

## 4. 推荐规格（按核心改动写，插件路线可裁剪）

### 4.1 布局与几何

- 在 `nav.panelList` 与 `div.regionArea` 之间插入 `div.panelResizeHandle`（8px 命中带，视觉上 1px hover 线或完全不可见，与 `AppFrame` 的 handle 语言一致）。
- `panelList` 进入「受控高度」模式：
  - `height: <px>`（用户拖动值）或 `auto`（未拖动时按内容）；
  - `max-height: <可用上限>`；
  - `overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;`
  - 内容不足时 `height: auto` 自然收缩，不预留空白。
- 会话区保持 `flex:1; min-height:0`，**给会话区一个最小高度**（建议 180–220px，含其头部），保证不会被压没；上限不足时手柄不可再往上拖。
- 折叠态：`panelList` 高度 0（或 36px 只留固定行）+ 一条可点击的恢复条；会话区自然占满。
- 56px rail（侧栏整体收起）下不显示手柄、不应用高度（导航行本来就是 36px 图标）；从 rail 展开时恢复之前的比例/px。
- Windows titlebar / macOS 顶部条不参与这个上下分配（它们是固定 chrome）。

### 4.2 拖拽

- 指针：`pointerdown` + `setPointerCapture`；拖动按 rAF 节流写高度，`pointerup` 才落盘。
- `cursor: row-resize; touch-action: none;`；拖动期间禁用侧栏收起动画/过渡。
- 拖动方向：向下拖 = 插件区变高（会话区变小）；向上拖 = 插件区变矮。
- 双击手柄 = 折叠/恢复；折叠态下双击恢复条 = 展开。
- 拖动到 < 1 行阈值 → 吸附折叠；从折叠态向下拖 → 以默认高度展开。

### 4.3 折叠态的入口

推荐 **方案 1**：折叠时保留 36px 的「插件」行（`id === "plugins"` 固定可见）+ 一个展开箭头；其他面板入口通过「更多」菜单或展开后可达。这样折叠后仍能直达插件管理，不会出现「入口全消失、只能凭记忆拖回来」的情况。记得在无障碍树里给它 `aria-expanded` / `aria-controls`。

备选 **方案 2**：完全收起，只留 12–16px 恢复条；实现最简单，但会多一次点击。除非你明确喜欢极简，否则不推荐。

可选增强：折叠时把被隐藏的面板入口列入「更多」菜单（复用 `sidebar.panellist.actions` 的 `entries` 注入面，增加默认的「面板列表 + Pin」内容），这样任意面板在折叠态也能一键到达。这需要改 `entry-customization` 或新增一个 actions 注册项，属于二期。

### 4.4 持久化

- `localStorage` 单键，建议 `dsh.sidebar.panel-area.v1`，值：
  ```json
  { "collapsed": false, "height": null }
  ```
  `height: null` 表示「按内容/默认比例」；`height: number` 是用户拖出的 px。
- 初始化：读 → 校验 → 按当前视口 clamp（不改写存储值）。写：仅 `pointerup`、折叠切换、双击复位时写。
- 损坏/未知字段回落默认；`localStorage` 不可用（隐私模式）时退化为内存态。
- 已知代价：同一个浏览器 origin 下多账号共享这一条偏好（与 `dsh.sidebar-visibility.v1` 的现状一致）；如需按账号隔离，后续再加 account key。

### 4.5 键盘与无障碍

- 手柄：`role="separator"`, `aria-orientation="horizontal"`, `aria-label`（如「调整插件区高度」）, `aria-valuemin/max/now`, `tabIndex=0`。
- `ArrowUp/Down` ±16px，`PageUp/Down` ±64px，`Home` = 最小，`End` = 最大，`Enter/Space` = 折叠/恢复。
- 折叠按钮/恢复条：`aria-expanded`、`aria-controls` 指向 `nav`，可见焦点环（沿用 `--dsw-focus-ring-*`）。
- 减少动态效果（`prefers-reduced-motion`）下不要做高度过渡动画。

### 4.6 i18n / 文案

- 新增 locale key（`ui-sidebar` 的 `locales.ts`，中英各一条）：
  - `panels.resize`（调整插件区高度）
  - `panels.collapse` / `panels.expand`（收起/展开插件区）
- 文案进入 0.2.1 的 `sidebar` 字典；不要在组件里写死中文。

### 4.7 边界情况

- **面板增删/插件启停**：高度 px 保持；内容少时 `auto` 收缩；内容多时内部滚动。不要因为列表变化重置用户高度。
- **窗口缩放**：`ResizeObserver` 重算 max；若当前 px > max 则视觉 clamp，但不要覆写存储值（用户放大窗口后应恢复原高度）。
- **侧栏宽度拖拽**：宽度变化不影响高度偏好；手柄位置随列宽自然变化。
- **切换面板**：选中态逻辑不变；折叠时选中的面板仍然渲染在主区。
- **rail / 桌面标题栏**：手柄不渲染；不要把固定行算进高度。
- **「更多」菜单**：菜单是 portal；打开菜单时手柄仍在，滚动列表不会导致菜单错位（菜单本身随滚动/缩放重定位，现有 `Menu` 已处理）。

## 5. 核心改动点清单（路径 1）

以 0.2.1-rc.5 的源码为目标（本地 fork 0.1.6 需先同步；见 §6）：

1. `packages/client/ui-sidebar/src/client/SidebarRoot.tsx`
   - 新增 `usePanelAreaLayout()`（或直接在同文件内）：读 `localStorage`、折叠/高度状态、clamp、`ResizeObserver`。
   - 在 `nav` 与 `regionArea` 之间渲染手柄（宽/rail 条件渲染）。
   - `nav` 加受控 style；折叠时加 class 或条件渲染。
   - 保留现有 `PanelRow` / `PanelMoreMenu` / `sidebar.panellist` 逻辑不动。
2. `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
   - `.panelArea`（可选容器）、`.panelList[data-resizable]`（height/overflow）、`.panelResizeHandle`、`.panelCollapsed`、过渡与 `prefers-reduced-motion`、rail 覆盖。
   - 视觉上沿用 `AppFrame` handle 的「8px 命中带、无可见 pill」约定；hover 可给 1px `--dsw-alias-border-l3` 线。
3. `packages/client/ui-sidebar/src/client/locales.ts`
   - 两条中英文案。
4. `contract/slots.ts`（可选）
   - 若希望把「插件区是否折叠」暴露给占用者（例如让 workspace 树知道），再加 owner props；v1 不需要，避免扩大契约。
5. 测试（`packages/client/ui-sidebar/tests/`）
   - `panel-area.client.spec.tsx`（新）：6 行入口时高度/滚动、拖拽、双击、键盘、折叠、持久化、rail 模式、reduced motion。
   - 更新 `sidebar-snapshot` 快照与 `panel-list`/`sidebar-root` 现有断言。
6. 文档
   - `README.zh.md` / `README.md` 的「全局面板入口」「折叠行为」两节补一段；README 是包契约，必须同步。

预计生产代码：约 120–200 行 TSX/TS + 60–100 行 CSS；测试 150–250 行。按熟悉 DSH 客户端的节奏约 **1.5–2.5 人日**（含两个窗口尺寸和 rail/titlebar 的手工验证）。

## 6. 交付路径细节与本机现状

### 6.1 版本前置（重要）

- 运行版 0.2.1-rc.5 的 `ui-sidebar` 才含「更多 / Pin」；`D:\src\deepseek-harness` 是 0.1.6-alpha.2，直接改它、构建、装回去会丢失 0.2.1 的既有行为，且与运行版不一致。
- 实施前先取 0.2.1-rc.5 对应的上游源码。上游有 tag `dsh-v0.2.1-rc.5`（commit `b830ec9`）：在独立 worktree 里 `git fetch origin tag dsh-v0.2.1-rc.5` 后改，不要用旧 fork 直接覆盖。
- 本机两个全局安装路径其实是同一个：`C:\nvm4w\nodejs` → `C:\Users\wwm_1\AppData\Local\nvm\v24.18.0`，补丁打一次即可；但如果以后用别的 Node 版本启动 DSH，要重新打。

### 6.2 本机安装方式（路径 1）

- 这台机器已有「安装后补丁」先例：`dsh-permission-compat/tools/apply-*.mjs` 会对全局包做「备份 → 改文件 → verify → 可 `--revert`」；`web` profile 也用了 `pnpm patchedDependencies`（`patches/@deepseek-ai__dsh-subagent-claude-code@0.2.1-rc.5.patch`）。
- 对 `ui-sidebar`，建议做成同款小工具（例如 `dsh-sidebar-compat/` 或并入现有工具集）：
  - `apply`：备份 `lib/client.js` → 校验版本/标记 → 替换成含新功能的 bundle（从源码构建，而不是手改压缩代码）→ `--verify`。
  - `--revert`：还原备份；DSH 升级后 `--revert` 旧补丁、重新构建/应用。
  - 失败即回滚，不留下半改状态。
- 不建议手改 `node_modules` 后不留备份；`dsh` 升级会直接覆盖。

### 6.3 插件路线（路径 2）的实现边界

如果决定不碰核心：

- 扩展 `D:\src\dsh\dsh-plugin-sidebar-visibility`（你已有的侧栏增强插件）或新建 `dsh-plugin-sidebar-*`。
- 需要的挂载点：
  - 侧栏根节点：`[data-sidebar-collapsed]` 下的 `[class*="_root"]`（或通过 `aside` 结构定位）；
  - 插件列表：`nav[class*="_panelList"]`（0.2.1 的 class 是 `hHd-Xa_panelList` 这类「哈希前缀 + 原名」形式）；
  - 会话区：`div[class*="_regionArea"]`。
- 用注入的 `<style>` + `data-*` 属性控制高度/折叠；手柄可以做成 `regionArea::before` 命中带（避免插入 React 不认识的兄弟节点），或插入节点后用 `MutationObserver` 恢复。
- 必须做的保护：找不到结构时 no-op；版本升级后不抛错；提供开关（页脚 action 或设置项）一键禁用。
- 这条路能做出看起来一样的效果，但**真正的「把插件区当成布局的一部分」只有核心改动能做到**（例如折叠后把入口收进 More 菜单、rail 模式下的联动）。

## 7. 测试与验收

**组件测试（核心路线）**

- 6 个 panel 注册项 + 200px 内容 → 展开态高度被限制、可内部滚动；会话区 ≥ 最小高度。
- 拖拽：`pointerdown`+`pointermove`+`pointerup` 写入高度；`pointerup` 才写 localStorage；rAF 合并。
- 双击手柄 → 折叠；再双击/点恢复条 → 展开；折叠态会话区占满。
- 键盘：Arrow/Page/Home/End/Enter 行为 + ARIA 值同步。
- 持久化：写入后重挂载恢复；损坏 JSON 回落默认；`height` 超出当前视口时 clamp。
- rail 模式：不渲染手柄、不应用高度；退出 rail 恢复。
- 现有行为：面板选中态、More 菜单、New Session、侧栏收起动画不受影响。
- 快照：`sidebar-snapshot` 更新。

**手工验收（本机）**

- 1440×900 与 1024×768 两个窗口；Windows 标题栏模式（当前桌面端有 `[data-windows-titlebar]`）。
- 多面板 / 少面板两种内容；中文与英文 locale；减少动态效果；键盘 only。
- 刷新浏览器（localStorage 恢复）；重启 `dsh web`（不应依赖内存）。
- 折叠后仍能打开「插件」面板与任意插件面板（入口可达性）。

## 8. 风险与开放问题

1. **术语确认**：本文按「插件区 = 侧栏顶部那排全局面板入口（仪表盘/插件/自动化任务/进度看板/最近会话/更多）」分析。如果你指的是别的位置，方案要重做。
2. **默认策略**：建议默认展开 + 限高 40%（最多约 5 行），用户可折叠；不是默认折叠。若你更想「一进来就只看会话」，把默认改成折叠即可。
3. **折叠后的入口**：建议只留「插件」固定行 + 展开箭头（§4.3 方案 1）；把全部入口收进 More 菜单是二期增强。
4. **持久化范围**：`localStorage` 是按浏览器 origin 的，不跨设备、多账号共享。若你要跨设备/多账号，需要走 Host settings（更大的改动）。
5. **升级维护**：核心补丁在 DSH 升级后要重放；插件 DOM 注入在 class 名变化时要适配。选择哪条路等于选择哪种维护成本。
6. **0.2.1 源码获取**：本地 fork 落后；实施第一步应是取对应版本源码并确认能在本机构建 `ui-sidebar`（tsdown client bundle + CSS 注入）。
7. **真实窗口高度未知**：分析里的 234px 是按 6 行算的；你的窗口实际高度会决定体感，验收时以实际截图/尺寸为准。

## 9. 建议的下一步

1. 你确认「插件区」所指，并（如无异议）采用建议默认：默认展开 + 限高 40%、折叠保留「插件」行；再选交付路径（核心补丁 vs 插件）。
2. 取 0.2.1-rc.5 对应源码，跑通 `ui-sidebar` 单包构建与本机安装（先不改功能，验证补丁链路）。
3. 实现 A 方案（拖拽 + 折叠 + 持久化 + 无障碍 + 测试），按 §7 验收。
4. 交互稳定后再决定是否提 upstream PR（同一份改动，长期最省维护）。
