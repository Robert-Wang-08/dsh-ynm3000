# 双模型挑战与主控裁决

初稿先落盘，再并行派发；主控负责核验和定稿。模型自述不作为身份依据。

## 实际路由

| 角色 | 路由与证据 | 处理 |
|---|---|---|
| 主控 | codex-relay/gpt-6-astra；check-model实测 | 主控设计、裁决、收口 |
| 首次Opus专用工具 | subagent_claude_opus5_plan；回执自报“Claude 3.5 Opus”，无法验证 | 不作为指定Opus5验收；保留风险，显式重审 |
| Opus 5正式挑战 | anthropic-relay/claude-opus-5，high；子会话663597d8-9904-4263-aec7-a3df1deabdb8的modelSelection.lastUsed | 路由标签design-opus55为历史enum，真实模型是Opus5 |
| Kimi K3挑战 | kimi-coding/k3-256k，high；子会话06825f19-6621-46f2-99c2-dc500c39938d的modelSelection.lastUsed | route=docs-kimi；收到v1、v2及勘误，按最后补充裁决 |

PTC路由器首条命中R4；用户明确指定Opus5与KimiK3覆盖默认评审首选。两位正式评审都自报unverified，主控用运行时元数据补证后登记。Opus回执的validation/risks误用对象数组，主控规范化为schema要求的字符串数组，内容评价和路由证据分开记录。

## Kimi K3：8项挑战及补充

| 编号 | 挑战 | 主控裁决与定稿位置 |
|---|---|---|
| K1 | 21:05和次日闭账数字可能冲突 | 采纳。第3节区分未闭账快照和自然日闭账，09:00合并差异，不在静默期重复推送 |
| K2 | 用量范围与session过滤不支持专属归因；worker目录可能被排除 | 采纳并强化。主控已实际列表确认worker-目录；第7节明确“扫描集合、不含worker”，禁止全局总账表述 |
| K3 | 采样频率与端点负载、错误误判 | 部分采纳。state每60秒轻探，工单增量/有界扫描；不能把待人工刷新降成2小时，相关事项目标下一成功采集可见 |
| K4 | ended+历史ready可能漏待验收 | 不采纳自动复活。ended是权威终态；无独立未关闭裁决证据不新造待办。Kimi补充接受该收窄；第5节明确 |
| K5 | recap模板会编造X/Y | 采纳。无来源就显示暂无摘要，保留旧摘要时间，第6节 |
| K6 | 管理者首屏过载 | 采纳。首屏5行，模型/逐会话recap/用量后续分段，第9节 |
| K7 | 无周期scan导致永久陈旧 | 采纳。基础报告只读；可选用量模块需独立分析缓存刷新任务及认证验收，未接通就stale/unavailable，第7节 |
| K8 | 时区与旧notifier移交 | 采纳时区自检和切换水位；拒绝“旧脚本正在跑”的无证据断言；拒绝把seen游标当成功发送，按权威状态与渠道对账，第10节 |

Kimi建议删除outbox/锁/重试以简化MVP：拒绝。现有通知器恰有失败后游标推进的问题，删除持久投递会保留该缺陷。建议简化显示维度：采纳到界面，不删内部证据维度。异机watchdog、微信、LLM生成摘要推迟：采纳。

## Opus 5：6项正式挑战

| 编号 | 挑战 | 主控裁决与定稿位置 |
|---|---|---|
| O1 | 采样与发送隔离、扫描压力 | 采纳隔离与扫描预算；拒绝“初稿每60秒全量scan”“POST scan无互斥”的断言。初稿原本禁止高频扫描；源码runScan开头有scanning锁。无需新增scan-cache端点，复用现有status/scan，第2/7/8节 |
| O2 | 工单终态和会话状态混淆 | 采纳。工单/会话/未完成存量三套计数，明示映射优先级，第5节 |
| O3 | 实际模型采集缺契约 | 采纳。configured/inFlight/latestAttempt/lastSuccessful分开，P0事件与元数据契约验证；不把模型配置当执行，第6/10节 |
| O4 | 专属session集合查询缺失 | 采纳；“全局范围”标签仍不够准确，改成明确扫描集合且worker排除，第二阶段补覆盖与归因，第7节 |
| O5 | 人工事项去重与闭环 | 采纳stableIssueId/revision与权威源重算；不采纳小于5秒轮询及revision相同永不提醒，采用有上限提醒，第3/5/8节 |
| O6 | 时区和日期边界 | 采纳。固定报告时区、UTC时刻与自然日窗口同时保存；时区不一致时用量降级，第3/7节 |

Opus提出“分类准确度≥99%”“模型可用≥90%”“cache命中≥95%”没有样本分母或测量依据，不作为验收标准；改为确定性场景逐项通过。不得将人工等待误判容忍成1%的常规误差。

首次专用Opus的建议仅作补充，不计指定模型验收：状态映射、投递确认、人工项同步有价值；“sessions无日期过滤”“跨日活动同一会话不能出现在两天”错误，拒绝；无幂等渠道也不能验收“绝不重复”，改为有界重复与可追溯reportId。

## 合并后的核心决定

独立reporter；可靠outbox；不依赖LLM心跳；工单与会话口径分开；证据不足显示未知；人工通知不代替批准；扫描集合用量可选，专属金额必须过覆盖门槛。收件人、实例清单、时区和认证是部署输入，设计阶段不发消息。

[最终方案](<D:/src/dsh/docs/design/superagent-health-report/design-v1.0.md>) · [证据](<D:/src/dsh/docs/design/superagent-health-report/evidence.md>) · [Kimi验收回执](<D:/src/dsh/docs/design/superagent-health-report/receipt-kimi.json>) · [Opus验收回执](<D:/src/dsh/docs/design/superagent-health-report/receipt-opus.json>)。
