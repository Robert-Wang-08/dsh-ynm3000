# dsh-plugin-eye-care-bg

DSH Web 面板的**护眼底色**插件：给面板注入一段 CSS，把页面基础底色换成护眼绿（默认 `#C7EDCC`）。

- 只改颜色，不注册端点、不发请求、不读会话内容、不持凭据。
- 覆盖的是主题设计令牌 `--dsw-alias-bg-base`（定义在 `body`），并同时设置 `html/body` 自身底色。
- 换色：改 `client.js` 顶部的 `BG` 常量，重启该 profile 的 dsh，浏览器硬刷新。

## 安装（只装到需要护眼的 profile）

```powershell
dsh plugin --profile superagent add "link:C:/Users/wang/src/dsh/dsh-plugin-eye-care-bg"
pwsh -File C:\Users\wang\src\dsh\dsh-superagent-service.ps1 stop
pwsh -File C:\Users\wang\src\dsh\dsh-superagent-service.ps1 start   # 打印新的带 token URL
```

## 验收

1. 启动日志无 `did not activate`；
2. `dsh --profile superagent --dump-config` 里出现 `eye-care-bg` 行；
3. 打开面板，页面底色应为 `#C7EDCC`（深色主题下也生效，因为令牌覆盖带 `!important`）。

## 卸载

```powershell
dsh plugin --profile superagent remove dsh-plugin-eye-care-bg
```
