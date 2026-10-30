---
origin: self
owner: wang
author: claude-dsh-agent
created: 2026-10-30
updated: 2026-10-30
version: 0.1.0
asset-type: verification-record
source: dsh-ynm3000
skillhub-source: not-managed
---

# 验证记录：右侧栏内嵌浏览器 dsh-embedded-browser 0.3.0（Windows / DSH 0.2.0-rc.2）

> 任务：在 `web` profile 安装右侧栏内嵌浏览器，使 AI 与人在同一个浏览器标签页上双向互动。
> 结论：**已安装、配置组合与宿主挂载均已验证通过；尚差一次 DSH 重启**（插件行属启动期组合变更，工具表随会话冻结）。

## 1. 安装

```powershell
dsh plugin --profile web add dsh-embedded-browser   # -> dsh-embedded-browser@0.3.0
```

- 依赖已写入 `%USERPROFILE%\.dsh\profiles\web\package.json`，`dsh.profile.bundles` 末尾新增 `dsh-embedded-browser`；
- 安装前已备份 4 个 profile 配置文件（`*.bak-before-embedded-browser-20261030041924`）。

## 2. 本机配置（profile `cordis.patch.yml`，整键覆盖）

```yaml
- id: embedded-browser
  config:
    browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    lazyTools: false
```

原因（两条都是上游在 Windows 上的硬缺口，不是偏好）：

1. `lib/browser.js` 的 `resolveBrowserPath()` 只沿 `PATH` 找 `google-chrome-stable|google-chrome|chromium|chromium-browser|chrome`，再用 `:` 切分 `PATH`（Linux 语义），缓存只查 `~/.cache/{ms-playwright,puppeteer}` 与 macOS 路径 —— Windows 上必然抛 `no Chrome/Chromium binary found`。
2. `lib/lazy.js` 的 `SKILL_NAME = 'browser-use'` 是门闸：默认 `lazyTools: true` 时 10 个 `browser_embedded_*` 工具只有在该技能被成功调用后才发布；本机 `~/.agents/skills` 与 skillhub store 都没有这个技能，门闸永不打开。

## 3. 证据

| 检查 | 结果 |
|---|---|
| `dsh plugin --profile web list` | 含 `dsh-embedded-browser@0.3.0`（22 packages） |
| `dsh --profile web --dump-config` | 出现 `- id: embedded-browser` + `browserPath` + `lazyTools: false`；无 `patch: entry ... not found`、无 `did not activate` |
| Chrome 冷启动（与插件完全相同的参数） | `Chrome/156.0.8078.48`，`GET /json/version` 200，`--headless=new` + 持久 profile 正常 |
| 隔离宿主实测（临时 `DSH_HOME`，仅含 base + web-app + 本插件） | 宿主正常引导；`GET /api/dsh-embedded-browser/health` → `{"ok":true,"version":"0.3.0","running":false,"sessions":0,"profileDir":"...\\embedded-browser\\profile"}`；`/sessions`、`/state` 同源 200 |
| 客户端半边 | 宿主首页 HTML（34984 B）含 `embedded-browser`，说明右侧栏 client 插件已随 GUI 打包下发 |
| 无鉴权访问 | `/api/dsh-embedded-browser/*` 返回 401（路由存在且与 Web UI 同一套会话认证），不是 404 |

隔离宿主做法：`<临时home>\profiles\web` 用 junction 指向本机真实 profile 的 `node_modules`，只声明 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-embedded-browser` 三个 bundle，端口 3099，`--no-open`；探针结束后已杀掉进程并删除临时目录。

## 4. 尚未验证（需重启后）

- 右侧栏是否真的弹出 Browser tab（依赖本会话所在宿主进程重启后加载新插件行）；
- `browser_embedded_navigate` 等 10 个工具是否出现在工具表（`lazyTools: false` 应加载即注册）；
- 真实页面推流与人工接管流程（登录态写入 `$DSH_HOME/embedded-browser/profile`）。

## 5. 回退

```powershell
dsh plugin --profile web remove dsh-embedded-browser
```

profile 目录保留，登录态不丢；彻底清理由 `Remove-Item $env:USERPROFILE\.dsh\embedded-browser -Recurse` 完成。
