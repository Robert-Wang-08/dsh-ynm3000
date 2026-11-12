# @local/dsh-plugin-sidebar-panel-area

DSH Web 左侧栏增强插件：把「全局面板入口」和「会话区」之间的固定分配变成可拖拽、可折叠的布局，并把偏好记在浏览器里。

```
┌──────────────────────────┐
│ 品牌 / 新建会话            │
├──────────────────────────┤
│ 仪表盘                    │
│ 插件                      │
│ 自动化任务                │   ← 可拖拽高度、内部滚动
│ 进度看板                  │
│ 最近会话                  │
│ 更多                      │
├──────────────────────────┤   ← 16px 分隔条（悬停/聚焦时出现手柄）
│ 搜索 / 视图 / 会话树 …     │
├──────────────────────────┤
│ 页脚动作 / 设置            │
└──────────────────────────┘
```

## 行为

- **拖拽**：拖动分隔条上下移动，变更插件入口区的可视高度；内容超出时列表内部滚动，且**默认锚定底部**（顶部入口滚出、尾部入口保持可见），会话区随之伸缩。
- **折叠（上推式）**：双击分隔条，或点分隔条右侧的箭头，列表收缩到**最后 3 行**（当前为「进度看板 / 最近会话 / 更多」），隐藏的是**上方**入口；注册顺序完全不变。折叠后分隔条保留「展开」按钮，展开恢复原高度；也可以用滚轮向上查看被折叠的上方入口。
- **记忆**：`{ height, collapsed }` 存在 `localStorage` 的 `dsh.sidebar-panel-area.v1`，刷新/重启浏览器后保持；折叠状态记住的是展开高度，不会覆盖它。
- **键盘**：分隔条可聚焦；`↑/↓` ±16px，`PageUp/PageDown` ±64px，`Home/End` 最小/最大，`Enter/Space` 折叠/展开。
- **边界**：侧栏收起为 56px 轨道时自动停用（不渲染调整条、不写高度）；展开后恢复。会话区保留至少约 180px。默认高度上限约侧栏高的 40%；用户拖拽后以 px 记忆。
- **无核心改动**：只操作官方 `ui-sidebar` 的 DOM（`nav[class*="_panelList"]` 与随后的 `[class*="_regionArea"]`），不改 DSH 安装包；不改变任何插件的 `order`。

## 构建

```powershell
cd D:\src\dsh\dsh-plugin-sidebar-panel-area
pnpm install
pnpm run bundle
```

产物：`lib/index.js`（宿主半）、`lib/client.js`（浏览器半，已套 `window.__ModuleLoader__.load` 包装）、`lib/*.d.ts`。`pnpm run verify` 做产物契约校验。

## 挂到 plugtest profile

1. `C:\Users\wwm_1\.dsh\profiles\plugtest\package.json`：
   - `dependencies` 加 `"@local/dsh-plugin-sidebar-panel-area": "link:D:/src/dsh/dsh-plugin-sidebar-panel-area"`；
   - `dsh.profile.bundles` 加 `"@local/dsh-plugin-sidebar-panel-area"`。
2. 建立 profile 侧 junction：
   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\plugtest\node_modules\@local\dsh-plugin-sidebar-panel-area" `
     -Target "D:\src\dsh\dsh-plugin-sidebar-panel-area"
   ```
3. 重启 plugtest（当前测试实例：3081）：
   ```powershell
   dsh --profile plugtest --port 3081 --no-open
   ```
   启动日志第一行的 `dsh web: http://127.0.0.1:3081/?token=…` 就是登录 URL。
4. 打开页面后，插件入口区下方应出现一条带短线的分隔条；拖动/双击即可验证。

## 端到端测试

```powershell
$env:DSH_TEST_URL = 'http://127.0.0.1:3081/?token=…'
node scripts/e2e.mjs
```

脚本用本机 Edge + Playwright 验证：分隔条挂载、拖拽增高、localStorage、刷新恢复、上推式折叠（保留最后 3 行、上方行滚出、顺序不变）、折叠刷新、展开恢复、键盘 ±16、rail 隐藏与恢复；截图写到 `D:\src\dsh\.ptc\panel-area-shots*`。

## 已知限制

- **DOM 结构依赖**：选择器依赖官方 CSS Module 的 `_panelList` / `_regionArea` 后缀（哈希前缀可忽略）。DSH 若改类名或层级，需要同步适配；找不到结构时插件静默不动，不报错。
- **localStorage 是 per-origin**：不跨设备、多账号共享同一条偏好（与 `dsh.sidebar-visibility.v1` 的现状一致）。
- **折叠只保留最后 3 行**：默认是「进度看板 / 最近会话 / 更多」这三行；上方入口通过向上滚动或展开查看。若你的最后几行不是想要的，需要调整插件常量 `COLLAPSED_ROWS` 或入口顺序（order）。
- **不改变「更多」菜单**：折叠时不会把上方入口塞进官方「更多」菜单（那需要改 `entry-customization`，属二期）。
- **多个侧栏实例**：插件只接管第一个可见的 `_panelList`；当前 DSH 只有一个左侧栏，够用。
- **样式**：分隔条是自绘 DOM，不参与 React 组件树；React 重渲染若移除它，`MutationObserver` 会自动补回。

## 卸载

从 plugtest 的 `package.json` 删除 dependency 与 bundles 行、删除 junction，重启即可；本地目录可保留。
