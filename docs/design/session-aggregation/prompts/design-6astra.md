# 任务：设计「多 Agent 会话自动聚合与统一任务登记」方案（6astra 主笔）

你是系统架构主笔。只做设计，不写代码、不调用工具、不臆造本机事实。输出中文 Markdown，5,000–7,000 字，信息密度优先。凡是推断/未验证必须显式标注。

## 用户原话（保持原意，含口语）

> 创建一个 harness会话自动聚合登记 方案，dsh为主 但支持codex opencode cursor claude等的会话聚合；
> 6astra设计， opus5和kimi k3挑战， 目的是自动读取会话，识别任务，按任务聚合，更新进度，登记到统一的登记表中；包括目标、方案、成果物、裁决、洞察、总体计划和待办。
> 并不好实现 先细化设计

## 一、必须解决的问题

1. 自动读取多 Agent 的本机会话：DSH 为主，Codex、OpenCode、Cursor、Claude Code 为扩展；后续还能加别的 Agent。
2. 从会话中识别「任务」，按任务聚合：同一任务可能跨会话、跨 Agent；同一会话也可能包含多个任务。
3. 自动更新进度：进度必须可核对、可纠正，不能由模型自报或「助手说完成」直接销项。
4. 登记到统一登记表：每条任务卡至少包含「目标、方案、成果物、裁决、洞察、总体计划、待办」七类内容，并能追溯证据。
5. 这是设计任务，不是实现任务：用户明确说「并不好实现 先细化设计」。要给可落地的 MVP、分期、验收与不要做清单。

## 二、已实测的本机事实（详见随附盘点，不要改写为其他事实）

- DSH：`~/.dsh/sessions/<encoded-cwd>/<session-dir>/session.v4.jsonl.zstd`；多帧 zstd JSONL；首记录 `type=session` 有 id/createdAt/cwd/agentPreset；后续记录 `type/seq/time/data`；关键类型 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`job/registered|settled`、`session/title`、`turn/start`、`step/end`。本机 1,424 个会话文件。`todo/write` 是结构化 todo 快照；superagent worker 的 `agent/inbox/spliced` 带 ticket_id/trigger_id。
- Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；记录 `session_meta/event_msg/response_item/turn_context/token_usage_record`；`~/.codex/sqlite/codex.db` 的 `local_thread_catalog` 有 242 行标题/cwd；归档 `archived_sessions/*.jsonl.zst` 25 个。
- Claude Code：`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`；记录含 `sessionId/cwd/uuid/parentUuid/timestamp/isSidechain`；`~/.claude/tasks/<session>/<taskId>.json` 是结构化任务（subject/description/status/blocks/blockedBy）；主会话 54 个，子代理另有 JSONL。
- Cursor：CLI 转录 `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`（114 个，role=user/assistant/turn_ended；用户内容包 `<user_query>`；assistant 有 text/tool_use）；CLI 聊天 `~/.cursor/chats/<ws>/<chat>/{meta.json,prompt_history.json,store.db}`，store.db 根 blob 实测为密文、叶子 blob 明文，meta 含 blobEncryptionKey；IDE `workspaceStorage/*/state.vscdb` 的 composerHeaders 抽查为 0 行，未验证其他写入路径。**Cursor 完整还原尚未验证，不能写成已支持。**
- OpenCode：`~/.local/share/opencode/opencode.db`（1.83GB + 79MB WAL）；表 `session/session_v2/message/part/todo/project/event`；302 sessions、10,313 messages、43,028 parts、218 todos（completed 191 / in_progress 10 / pending 17）；part.data 的 type 含 text/tool/reasoning/step-start/step-finish/patch/file；按 time_updated 增量查询，避免全表扫描。
- 已有系统：DSH taskboard（`~/.dsh/dsh-taskboard.json`）、DSH superagent ticket、PTC registry、session-summary M1–M5（已有会话摘要/目标聚合/纠正链/六状态待办）、focus-hub/track、`~/.dsh/storages/dsh_dashboard.json`。**不能另造与它们冲突的第二真相。**
- 安全：会话可能含客户数据、凭据、私聊；默认本地处理；外发模型需按来源授权、脱敏、可审计。

## 三、设计要求（必须逐项回答）

1. **目标与非目标**：这个系统到底解决什么问题？成功标准是什么？明确不做什么（例如不替代 taskboard/PTC、不自动修改代码、不自动销项）。
2. **总体架构**：给出组件、数据流、部署形态（DSH 插件 / 本地服务 / CLI / 定时任务）、存储位置、故障隔离。要说明为什么不是一个大而全的 Agent。
3. **来源适配器契约**：每个来源的 discovery/parse/normalize/cursor 接口；如何增量、去重、处理截断/压缩/归档/加密/并发写；Cursor 和 OpenCode 的特殊风险怎么写进契约。给出统一事件模型字段。
4. **任务识别**：先锚点（外部任务号、PR/commit、native todo/task、cwd/项目、会话标题），再 LLM 补盲。给出锚点优先级、分段规则、候选生成、置信度、证据要求。
5. **任务聚合/实体解析**：同一任务跨会话/跨 Agent 的判定规则；允许合并、拆分、拒绝合并；人工确认队列；稳定任务 ID 与 alias；如何避免「语义相似就合并」的灾难。
6. **进度更新**：状态词表、证据类型与来源等级（human/tool/commit/test/agent-report）、什么能自动推进、什么必须人工、冲突/纠正/过期怎么处理；禁止伪百分比与自报销项。
7. **统一登记表**：给出任务卡 schema（七类内容各自的数据结构）、存储组合（append-only 事实日志 + SQLite 投影 + Markdown/JSON 视图）、每条事实的来源指针、版本/替代关系、索引与检索；给一个具体 JSON 示例和文件目录树。
8. **自动化与成本**：扫描频率、增量水位、批处理上限、LLM 调用策略（何时用便宜模型、何时不用模型）、缓存、背压、失败重试、覆盖缺口展示；给出量级估算。
9. **隐私与安全**：本地优先、脱敏、来源白名单、外发策略、prompt injection（会话内容是不可信数据）、凭据发现、删除/保留、审计。
10. **与存量系统的关系**：taskboard/PTC/superagent/session-summary/focus-hub 各自权威是什么；登记表是只读投影还是新权威；写回边界；如何避免双写。
11. **分期落地**：0–3 个月，按「可验证的最小增量」分 3–4 期；每期交付物、验收口径（可测试）、投入（人日）、进入下一期的条件；明确哪些必须后置。
12. **关键洞察与反模式**：5–8 条反常识判断；最容易失败的 3 个原因；哪些看似合理但应明确禁止。
13. **裁决候选**：列出 6–10 个必须由用户拍板的设计决策（含默认建议与备选），不要替用户静默决定。
14. **待验证清单**：把本机未验证项（Cursor 加密、DSH compaction、Claude 子代理去重、Codex 归档完整性、跨源身份）写成实现前必须做的 spike。

## 四、输出格式（严格）

```
# 多 Agent 会话自动聚合与统一任务登记：设计 v0.1

## 一、结论先行（≤250 字）
## 二、目标、非目标与成功标准
## 三、总体架构与数据流
## 四、来源适配器与统一事件模型
## 五、任务识别与聚合
## 六、进度、证据与验收
## 七、统一登记表（schema + 存储 + 示例 + 目录）
## 八、自动化、成本与运维
## 九、隐私、安全与不可信输入
## 十、与存量系统的边界
## 十一、分期落地（阶段/交付/验收/投入）
## 十二、关键洞察、反模式与不要做
## 十三、裁决候选（需用户拍板）
## 十四、待验证清单
```

要求：
- 每个关键取舍写「为什么不选另一个」。
- 给具体文件名、表名、字段名、阈值、状态词；不要只写原则。
- 明确标「事实 / 推断 / 待验证」；不要编造本机没有的格式或数量。
- 不要客套，不要重复盘点原文；需要引用时写「见盘点第 N 节」。
- 设计要能被一个工程师按阶段实现，而不是概念图。
