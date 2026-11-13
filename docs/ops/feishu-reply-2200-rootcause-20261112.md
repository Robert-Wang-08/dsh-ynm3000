# 飞书回信 2200 根因定位（2026-11-12）

根任务：task-20261111T110410363150Z-5091ff9c44c9　主控实测模型：ais-2dsglm/deepseek-flash
现象：Super Agent 飞书通道"任务跑完不回信，要人再问一句"。

## 1. 结论

**回信通道本身是通的；失败的是其中一类消息**：当用户那条消息带 `sync_to_chat_info`（同步到话题）时，
原生发送器无条件加 `--reply-in-thread`，飞书对该组合返回 `server_error 2200`；
去掉该参数，同一条消息立刻送达。代码没有任何 2200 / 同步话题处理，重试永不成功。

## 2. 证据链

### 2.1 通道整体正常，不是全量故障
orchestrator.sqlite `outbox` 表 147 条飞书回执：**135+2 条 sent，12 条 pending**。
按 `trigger.at` 关联，最后成功回信是 **2026-11-12T05:27:04Z 与 05:29:14Z**（本地 13:27/13:29），
即当前时刻仍在正常发送。故上一轮"出站全部失败"的判断不成立。

### 2.2 12 条卡死条目的共同特征
| 目标消息 | 触发时间 | `thread_id`(顶层) | `sync_to_chat_info` |
|---|---|---|---|
| om_x100b603f78a5a8a8cd15dc7516153ee | 2026-11-08T17:37Z | null | **有**（omt_1995c66da1cfda45, type=1） |
| om_x100b6018d6f3d88cb09e33b2decf59b | 2026-11-10T07:36Z | null | **有**（omt_19974c2f950f5b7f, type=1） |
| om_x100b600a01afa138b4ce35aa302b8da | 2026-11-11T03:45Z | null | **有**（omt_19966b7337d51b45, type=1） |
| om_x100b6060a46a08a8cd04d423595c3e6（成功） | 2026-11-12T05:29Z | omt_1990c6635e4f9b7c | 无 |
| om_x100b6060ac4cd8a4ce44b8930b0acee（成功） | 2026-11-12T05:27Z | omt_1990c6e1334f5b48 | 无 |

卡住的 12 条全部命中"带 sync_to_chat_info"，成功的都不带。

### 2.3 实测复现（3/3）
```
lark-cli im +messages-reply --message-id <卡住目标> --text 'diagnostic' --reply-in-thread --as bot
→ ok:false  subtype:server_error  code:2200  retryable:true
   log_id 20261112135734C3DB867DB2E094282A11 / 20261112135735D05FA950ADE5CA4CAE7C / 20261112135648EE1980C0C333DE2B2EFB
```

### 2.4 单变量对照（决定性）
| 变体 | 结果 |
|---|---|
| 同一目标 + `--markdown` + `--reply-in-thread` + `--idempotency-key` | ok:false **2200** |
| 同一目标 + `--markdown` + `--idempotency-key`（**去掉 reply-in-thread**） | **ok:true**，message_id om_x100b60611c745c68dd14d7b6cf77d36（13:56:59） |
| 全新消息 + `--reply-in-thread` | **ok:true**（13:57:14），说明该参数本身可用，失效只针对"已同步到话题"的消息 |

### 2.5 代码位置（无任何兜底）
- `D:\src\dsh-superagent\src\sources\feishu-channel.ts:23` 固定拼接 `--reply-in-thread`；
- 构建产物 `lib/feishu-C-9qeu4m.js:535` 同；
- 全包 grep `sync_to_chat_info` / `2200` 无命中 → 没有降级分支；
- `src/app/effects.ts:7` FAILURES_BEFORE_ERROR=3 只影响健康状态；`retry: [5000, 300_000]` 意味着
  失败条目以 5 分钟封顶无限重试（实测 attempts 已达 230–866 次），既不成功也不丢弃。

## 3. 建议修复（未实施，需授权）

在 `sendFeishu` 中：捕获 `code 2200 / server_error` 时**去掉 `--reply-in-thread` 重发一次**；
更稳的做法是先读目标消息 `sync_to_chat_info`，有则直接不带该参数。
落点是仓库子模块 `D:\src\dsh-superagent`（3082 的 `node_modules/dsh-superagent` 是指向它的 junction），
改完 `pnpm build` + 重启 3082 生效，走 git 即可跨设备。

## 4. 先决副作用（必须交代）

本轮为定位根因，对 `oc_eae25b93a93612f82042deb68704e2af` 实际发送了 3 条消息：
1. 13:56:59 一条**历史卡住回信**（"收到：Kimi 已登录…"）——去掉话题参数后送达；
2. 13:57:12 「【通道诊断 2026-11-12】验证话题回复，可忽略。」
3. 13:57:14 对第 2 条的话题回复「【通道诊断】这是对新消息的话题回复测试。」

数据库里那 12 条 receipt 仍是 pending，修复后会自动补发旧内容，其中第 1 条会**重复**一次。

## 5. 未完成

- 未修改任何源码（旧契约明确排除 dsh-superagent 本体，且属新范围，需另立根任务）。
- 未清理 12 条 pending receipt，未重启 3082。
- 群聊 `oc_05b3ec7a…` 的 `230027 access denied` 是另一个独立问题（history 读取），未处理。
