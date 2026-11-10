# TickTick MCP 接入与代理旁路（设备运维）

> 本文只讲「DSH 如何连上 TickTick MCP」这一层：配置位置、凭据落点、代理旁路、验收与回滚。
> 任务登记/命名/标签/会话登记/反查的业务规范见 `docs/ops/ticktick-task-conventions.md`。

## 1. 组装位置（profile 层，不进 Git）

`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- id: mcp-ticktick
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: ticktick
    transport: stdio
    command: 'C:\nvm4w\nodejs\node.exe'
    args: [ 'D:\nutstore\Skill+Tool\ticktick-mcp\dist\index.js' ]
```

同一片段里还有 `mcp-codegraph`、`mcp-tencent-docs` 等；`@deepseek-ai/dsh-mcp-client` 的子进程环境来自「主进程环境（凭据型变量已擦除）+ 配置里的 `env`」。

## 2. 凭据与令牌（%APPDATA%，不进 Git）

| 文件 | 内容 | 是否含密 |
| --- | --- | --- |
| `%APPDATA%\ticktick-mcp\config.json` | clientId、clientSecret、redirectUri、defaultProjectId/Name | 含密 |
| `%APPDATA%\ticktick-mcp\tokens.json` | accessToken（scope `tasks:read tasks:write`） | 含密 |

- 环境变量 `TICKTICK_*` 一个都不需要；本机就是靠上面两个文件。
- `defaultProjectId` 决定「不带 project 的写入落到哪个清单」——改它等于改业务默认值，属于规范范畴。

## 3. 代理旁路（本机 2026-11-06 实测）

本机走 Clash：`HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7890`。DSH 的 `dsh-http-proxy` 会给 Node 子进程叠加 `NODE_USE_ENV_PROXY=1`，因此 MCP 子进程也会走这个代理；代理抖动时任务调用报 `{"code":"ticktick_mcp_error","message":"fetch failed"}`（MCP 侧没有重试）。

`api.ticktick.com` 直连与走代理都可达，所以让 TickTick 流量直接绕过代理、减少一个故障点：

```powershell
# 用户级，持久化
$v = 'localhost,127.0.0.1,::1,[::1],ticktick.com,api.ticktick.com'
[Environment]::SetEnvironmentVariable('NO_PROXY', $v, 'User')
```

- 旁路条目按「host 及其子域」匹配（`ticktick.com` 已覆盖 `api.ticktick.com`），逗号/空格分隔，`*` 表示全部旁路。
- DSH 只在**启动时**解析一次代理策略，并把解析后的旁路表传给子进程 —— 改完必须**重启 DSH 并新开会话**才生效。
- 回滚：`[Environment]::SetEnvironmentVariable('NO_PROXY', $null, 'User')`（或恢复上一条值）。

## 4. 验收（改完必须跑）

```powershell
# 4.1 旁路确实生效：把代理指向一个死端口，仍能拿到 401（说明走了直连）
$env:HTTPS_PROXY='http://127.0.0.1:9'; $env:NO_PROXY='localhost,127.0.0.1,::1,[::1],ticktick.com,api.ticktick.com'; $env:NODE_USE_ENV_PROXY='1'
node -e "fetch('https://api.ticktick.com/open/v1/project',{signal:AbortSignal.timeout(12000)}).then(r=>console.log(r.status)).catch(e=>console.log(e.message))"
# 期望 401；对照组（NO_PROXY 去掉 ticktick 条目）应打印 fetch failed
```

4.2 在 DSH 新会话里调 `ticktick_list_projects` → 返回清单；`ticktick_add_todo` → 返回带 `id`/`etag` 的任务；`ticktick_complete_todo` → `{"completed":true}`。

## 5. 已验证的行为事实（2026-11-06 实测，供规范引用）

| 事实 | 结论 |
| --- | --- |
| `content` 往返 8000 字符 | 不截断，原样回读 |
| 标签 `Harness-DSH` + `harness-dsh` | 服务端**转小写并去重** → `harness-dsh` |
| 标签顺序 | **不保证保持**，回读顺序与写入不同 |
| `update_todo` 的 `patch.tags` | **整体替换**，不是合并 |
| `list_todos` | 只返回**未完成**任务；已完成任务不可查 |
| `list_todos` 上限 | `limit` ≤ 200，**无 offset**，多于 200 条的清单无法全量拉取 |
| 无删除/无 reopen/无跨清单或按标签搜索 | 反查只能在客户端做 |