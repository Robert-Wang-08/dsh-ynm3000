# 设计证据与验证边界

核查时间：2026-11-11，Windows 本地时区 +08:00。只读核查，无消息发送、无配置更改。

| ID | 已验证事实 | 证据 |
|---|---|---|
| E1 | 旧推送器先标seenEnded，再send，失败后仍持久化；inputs数量用于人工提示不可靠 | [通知器](<D:/src/dsh/dsh-sa-local-feishu-notify.mjs#L83>) |
| E2 | 权威工单分类顺序：ended优先，person再分delivery/answer/review/blocked/failed；waiting是idle | [Superagent状态分类](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/index.js#L197>) |
| E3 | state包含setup/load/masterId(s)/paused/health；同源管理头适用于GET | [状态视图](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/index.js#L8793>)、[请求校验](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/index.js#L9042>) |
| E4 | 3082/3083加x-orchestrator-request:1后GET state均200。3082 runtime ready但reply/history error；3083存在预期关闭source。只说明观测瞬间 | 本轮pwsh只读GET；未将私聊ID、错误全文或原会话写入交付 |
| E5 | dashboard status/cube/pricing接口存在；sessions上限200且无offset；summary不收from/to | [dashboard接口](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/index.js#L562>) |
| E6 | 本地自然日归桶；缺价格跳过；缓存分项参与估价；assistant/message.message.source.model为模型分组键 | [日期](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/fold.js#L355>)、[费用](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/fold.js#L1231>)、[usage](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/fold.js#L821>) |
| E7 | dashboard只发现session-目录；Superagent worker ID为worker-；实际仅列目录名已确认worker-目录存在 | [发现器](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/index.js#L50>)、[worker ID](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/index.js#L5175>)。未读取原始会话 |
| E8 | dashboard host启动3秒后scan；另可POST scan。无host周期scan | [启动扫描](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/src/index.js#L435>)。浏览器触发不构成无人值守刷新保证 |
| E9 | ticket视图有sessionId、summary、updatedAt；Assignment含report.state/summary/at，不能假设assignment直接有sessionId | [工单视图](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/index.js#L3387>)、[类型](<C:/Users/wwm_1/.dsh/profiles/sa-local/node_modules/dsh-superagent/lib/intake-Bv3NycQr.d.ts#L333>) |
| E10 | 当前dashboard安装版本0.2.1；匿名status重复401 | [包信息](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/@weibaohui/dsh-dashboard/package.json>)；需受支持的无人值守认证接入，未绕过 |
| E11 | 主控实际codex-relay/gpt-6-astra；Kimi实际kimi-coding/k3-256k high；显式Opus实际anthropic-relay/claude-opus-5 high | 主控check-model输出；两子会话projcache的modelSelection.lastUsed。这里只保留路由元数据 |

初稿 SHA256：E62FA33E07E2E171A973C32BA3D0CE6CECCAD39E8B93E70D58559823D4605E83。
dashboard host源码 SHA256：BFCB32603EE9920C9A5783FF465B11BC0D2F850AA2DE5A6CAF680D0587AC1557。

账本验收：本任务的三个派发记录均有回执（首次Opus尝试标partial并被正式复审替代），正式两位评审及两份主交付物已登记。全局verify仍报告2026-11-03既有7条无效事件及其他任务缺回执；未修改共享历史，不能宣称全局账本验证通过。

这些是设计依据，不是新reporter通过运行测试的证据。本轮未实施；未验证定时触发、真实收件人、投递、扫码/交互裁决、专属用量金额或账单一致性。源码来自本机安装包，目标部署版本必须再次锁定与做契约测试。未断言旧notifier当前正在运行。
