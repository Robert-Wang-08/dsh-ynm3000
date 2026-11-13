# 飞书出站静默：结果不回推的根因与修复（2026-11-11）

> **复核更正（2026-11-12）：本文混淆了 HITL 通知桥与 Super Agent 原生飞书通道，不能作为原生通道问题的已确认根因或部署依据。暂缓据此重启 OpenClaw。最新实测及补丁风险见 [独立复核](./feishu-outbound-review-20261112.md)。下文保留为历史记录，不代表已验收结论。

> 现象：Super Agent 通过飞书交互能正常执行任务，但**处理完不回信**，必须人主动再问一句。
> 本文件记录已核实的根因链、代码加固和部署步骤。结论全部来自本机实测，不是推测。

## 1. 现象与影响面

- 入站正常：飞书发消息 → OpenClaw 网关 → `dsh-bridge` → DSH 会话，任务能跑完。
- 出站失败：回合结束/审批/失败通知写进发件箱后，**每一次发送都失败**，重试 5 次后条目被删除。
- 用户侧观感：任务跑完没有回信；再发一句「好了吗」，下一轮才拿到结果。

## 2. 根因链（逐条证据）

1. **出站唯一出口是 OpenClaw 网关进程**
   `dsh-bridge` 的 outbox pump 每 2 秒 `drainOutbox()`（`gateway/dsh-bridge/index.js:116-142`）；
   DSH 侧插件只轮询注入答复，不排空发件箱（`pkg/dsh-wechat-hitl/index.js:203-213`）。
   证据：`~/.openclaw/state/dsh-bridge-debug.log` 里 `{"outbox":"draining","queueLength":1}` 每 2 秒一条，`ticks` 已到 94891。

2. **该网关进程自 2026-11-09 14:05 起没有重启**
   证据：同一日志最后一条 `{"boot":"dsh-bridge 0.4.1"}` = `2026-11-09T06:05:54Z`（本地 14:05:54）。

3. **进程内存里是旧版 `hitl-store.js`（无环境清洗）**
   证据：插件捕获包副本
   `~/.openclaw/tmp/plugin-captures/d3f9bc77-…/node_modules/dsh-wechat-hitl/lib/hitl-store.js`
   lastWrite = `2026-11-09 14:05:54`，且**不含** `larkCliEnv` / `resolveFeishuConfigDir`；
   仓库现行 `lib/hitl-store.js` 两者都有。旧版把 `process.env`（含 `OPENCLAW_*` 上下文）直接交给 lark-cli。

4. **lark-cli 1.0.99 见到 OpenClaw 上下文但没 bind，直接拒发**
   证据：`state/hitl.log` 中每次发送都是
   `{"op":"feishu-send","ok":false,"code":3,"output":"…openclaw context detected but lark-cli is not bound to it…"}`。

5. **失败被当成瞬时错误，5 次后静默丢弃**
   证据：同一条目反复 `outbox-failed attempts:1→5`（60 秒退避），到 5 次从 `pending.json` 删除；
   11-11 19:07:49 的 `out-1794395023169-2b897e`、19:09:16 的 `out-1794395108572-e26185` 都是这样丢的。

6. **同一份现行代码在干净环境里是好的（反证）**
   - `node` 直接调用仓库 `feishuSend()`：`ok:true`，`message_id=om_x100b6070f2d710a4c062febdb91cc40`（2026-11-11 19:04:33，落点 `oc_3c60d05…`）。
   - 同一入口用假 chat_id 探针：返回 API `230001 invalid receive_id`，**不是** `type=config`，说明 `larkCliEnv` 清洗确实生效。
   - `lark-cli config show` 在清洗环境下正常输出 appId `cli_aa66f315697adc03`。

结论：**代码已修好，但跑着的是 11-09 的旧模块。** 只要网关进程不重启，出站就永远失败。

## 3. 与守护进程心跳无关

`state/feishu-daemon.json` 显示 `inbound: spawn-failed`（pid 33744，tick 停在 11-10 22:16），
这是**入站事件长连接**的守护进程，已退出；本故障的出站路径完全不经过它。
出站失败在 11-10 到 11-11 全程持续，与 daemon 死活无关。

## 4. 已合入的代码加固（`dsh-wechat-hitl/lib/hitl-store.js`）

目标：同类故障不再"静默丢"，而是"保留 + 可见 + 可补发"。

| 改动 | 作用 |
| --- | --- |
| `classifyOutboxFailure(output)` | 把失败分成 `config` / `context` / `timeout` / `transient`，不再一律当瞬时错误 |
| `config` 类失败 → `blocked="config"` | **不消耗 attempts、不被 5 次上限丢弃**，5 分钟节流后自动重试；出口修好即自动补发 |
| `outboxEntryDisposition()` 新增 `hold-blocked` / `drop-blocked-expired` | 阻塞条目按 24h 窗口保留，不被 30 分钟 TTL 抢先判死 |
| `appendDeadLetter()` + `state/outbox-dead-letter.jsonl` | 任何真正丢弃（TTL / attempts 耗尽 / 阻塞超期）都先留完整正文副本，可人工补发 |
| `describeResultPush()` | `/who` 直接显示「出站积压 N 条，其中 M 条被出站配置阻塞」，不再只在日志里 |
| `releaseContextHold()` | 用户入站时顺带解锁 blocked 条目，修好出口后发一句话就能立刻补发 |

日志新增可定位事件：`outbox-blocked-config`、`outbox-dead-lettered`（`outbox-dropped` 增加 `deadLettered` 字段）。

回归测试：`test/outbox-blocked.test.mjs`（5 条），全套 9 文件通过，入口：

```powershell
pwsh -NoProfile -File D:/src/dsh/dsh-wechat-hitl/test/run-tests.ps1
```

## 5. 部署：重启 OpenClaw 网关（必须，沙箱外执行）

DSH 工具进程内无法结束/拉起网关（`Win32_Process Create` 拒绝、`Start-Process` 子进程被回收），
请在**普通 PowerShell**里执行：

```powershell
# 1) 先看清目标进程（命令行含 openclaw，确认后再停）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'openclaw' } |
  Select-Object ProcessId, CommandLine

# 2) 结束网关（把 <pid> 换成上一步确认的进程号）
Stop-Process -Id <pid> -Force

# 3) 用既有入口重新拉起
& C:\openclaw-runtime\run-gateway-hidden.cmd
```

重启期间飞书入站会中断约 10–30 秒，属预期。

### 验收

```powershell
# a) 新 boot 行的时间必须晚于本次操作
Select-String "$env:USERPROFILE\.openclaw\state\dsh-bridge-debug.log" -Pattern '"boot"' | Select-Object -Last 1

# b) 出站日志出现 ok:true（在此之前全是 ok:false code:3）
Get-Content D:/src/dsh/dsh-wechat-hitl/state/hitl.log -Tail 50 | Select-String 'feishu-send'
```

再在飞书发一条消息驱动任一会话，回合结束后应直接收到【回合结束】摘要，无需追问。

## 6. 备选（不重启网关，不推荐）

`lark-cli config bind` 能让旧进程也发得出去，但会把 lark-cli 绑定到 OpenClaw 的 agent 身份，
改变 `X-Agent-Trace` / profile 隔离语义，且与"清洗环境变量"这条正路冲突。只有在无法重启网关时才用。

## 7. 防复发

1. 网关/宿主**改完 `dsh-wechat-hitl` 代码必须重启**——Node ESM 不会热更新已加载模块。
2. 排查出站先看两条：`hitl.log` 的 `feishu-send` 是否 `ok:true`；`dsh-bridge-debug.log` 的 `boot` 时间是否早于代码修改时间。
3. `/who` 现在会直接报积压与阻塞条数；发现"积压但没阻塞"说明是网络类瞬时失败。
4. 死信文件 `state/outbox-dead-letter.jsonl` 是补发来源，不要清空。

## 8. 回滚

代码改动只涉及 `lib/hitl-store.js`、新增 `test/outbox-blocked.test.mjs`、`test/run-tests.ps1` 一行登记：

```powershell
git -C D:/src/dsh checkout -- dsh-wechat-hitl/lib/hitl-store.js dsh-wechat-hitl/test/run-tests.ps1
Remove-Item D:/src/dsh/dsh-wechat-hitl/test/outbox-blocked.test.mjs
```

回滚后同样要重启网关才生效；不要动 `state/` 与认证配置。
