# 飞书不回信分析：独立复核（2026-11-12）

根任务：task-20261111T110410363150Z-5091ff9c44c9；沿用既有契约，本次只复核，不扩展为原生插件实施修复。
复核者：openai-codex/gpt-6.1-sol（check-model.py 实测）。上一轮分析者为 opencode-go/deepseek-v4.1-flash。本次无子代理、无服务重启、无飞书消息发送、无业务源码修改。

## 结论：上一轮分析不可作为 Super Agent 原生通道的根因结论

上一轮证明了 HITL 通知桥曾有出站故障，但没有证明用户所说的 Super Agent 使用该链路；把桥的 code 3 故障等同于 Super Agent 原生回信故障，是关键归因错误。暂缓按旧报告重启 OpenClaw 来解决原生通道问题。

## 最新只读证据

2026-11-12 02:59Z 左右，GET http://127.0.0.1:3082/orchestrator/api/state（x-orchestrator-request: 1）返回：
- appId=cli_aa67e4041a381c02，机器人 superagent-飞书bot；stateDir=~/.dsh/state/superagent。
- health.feishu.state=ready，detail=Listening for bot events。
- health.reply.state=error，detail=12 waiting since 2026-11-08T17:37:48.558Z; the last failure: Error: Something went wrong. Please contact technical support ... (2200)。
- health.history.state=error：某群 access denied for this bot operation (230027)。此为历史读取错误，不能直接等同为发送错误。
- 3083 则 feishu=paused/sourceOff、tickets=[]。不能把 3083 与 3082 的状态混用。

原生安装源码与构建产物一致：
- ~/.dsh/profiles/superagent/node_modules/dsh-superagent/src/sources/feishu-channel.ts:19-29 使用 im +messages-reply --message-id --markdown --reply-in-thread --idempotency-key，经 host.commands.lark 发送，不经 HITL drainOutbox。
- 同目录 lib/feishu-C-9qeu4m.js:525-545 有相同调用。
- src/app/outbox.ts:23-50 把 reply effects 持久化、退避重试并结算 receipt；不是 HITL 的五次后删除策略。
- 工作区 dsh-sa-local-feishu-notify.mjs:28-32 已明确写了原生 app3 与 HITL app/chat 的分离。

据此可确认原生回信投递存在实际故障；尚不能从 2200 泛化错误断定是权限、目标消息、消息内容、线程模式还是 CLI 编码问题。12 条积压也还未逐条关联到用户描述的具体工单。

## 上一轮哪些证据成立、哪些不成立

- HITL 日志里的 code 3 与 config bind 拒绝是真实的另一条链路故障证据。
- HITL 直发成功只验证 app aa66 -> chat oc_3c60...，不能验证原生 app aa67 的 threaded reply，更不能证明任务完成自动回信闭环。
- “出站唯一出口=OpenClaw”不成立：HITL 自己的 feishu/feishu-daemon.mjs:299-308 也调用 drainOutbox；原生 Super Agent 又有独立发送器。
- “入站经过 OpenClaw”与原生 feishu-loops.ts 的 lark-cli event consume 代码不符。必须先辨别机器人再作结论。
- “网关未重启”有日志时间和旧捕获副本的间接支持，但没有当前进程导入 URL/模块版本的直接证据；不能据此断言重启一定修好。
- “用户再问就收到”未做同任务事件/投递回执关联，上一轮没解释这个差异。

## 新增 HITL 补丁本身仍有风险

1. lib/hitl-store.js:2871-2872、3008-3009：appendDeadLetter 返回 false（死信落盘失败）时仍删除队列条目。因此“先留完整副本才丢弃”并不成立。
2. lib/hitl-store.js:2827-2828 清除 blocked 时写 blockedAt=0；2982 用 ?? 不会替换 0；212-216 以 0 计算已阻塞时间，会立即判定超过 24h。无发送纯函数复算已运行：blockedAtZero=drop-blocked-expired；blockedAtNow=hold-blocked，退出码 0。
3. 新测试覆盖的是 HITL 发送器替身与状态函数，不覆盖 app aa67 的原生线程回复，更没有复现用户具体任务完成不回信的端到端场景。通过测试不能作为原问题已修复的证据。

## 下一步唯一动作

在原生 3082 中选取一条未送达 receipt，关联 ticket、trigger、channel.address.messageId 与 reply effect 的完整错误（仅只读）；据此收窄 2200 的根因。原生插件修改属于旧契约明确排除范围，如需实施，应另立修复任务并先获得确认。

限制：本轮不重启、不补发、不改 profile、不改业务源码；未宣称完成修复。原根任务仍为 review，不应标 done。
