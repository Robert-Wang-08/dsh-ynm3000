# 多 Agent 会话源实测盘点（2026-11-12，本机只读探测）

> 目的：为「会话自动聚合与统一任务登记」设计提供可核对的事实底座。以下除注明「未验证」外，均为本机实测；探测脚本在 ticket 工作目录 `evidence/probe*.py`，只读打开各存储，未修改任何源文件。

## 0. 实测环境

- Windows，用户目录 `C:\Users\wwm_1`；DSH 安装版 Node v24.18.0；DSH 会话由本机 DSH 进程写入。
- 各 Agent 均为本机安装并实际产生过会话；不是按官方文档推测的格式。
- 未读取云端会话、未调用任何 Agent 的在线 API 来取会话内容。

## 1. 五个来源的存储与格式

| 来源 | 权威存储 | 格式与关键记录 | 本机规模（实测） | 稳定标识 | 增量/变更 |
|---|---|---|---|---|---|
| DSH | `~/.dsh/sessions/<encoded-cwd>/<session-dir>/session.v4.jsonl.zstd` | 多帧 zstd 压缩的 JSONL。首记录 `type=session`，含 `id/createdAt/cwd/agentPreset/delegationDepth`；后续记录统一 `type/seq/time/data`。关键类型：`user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`job/registered|settled`、`session/title`、`turn/start`、`step/end`、`model/selection`、`agent/inbox/spliced` | 1,424 个会话文件；单文件数十 KB–数 MB；实测 689,420 字节的 zstd 解出 276 字节首帧（多帧） | `session.id` + 记录 `seq` | 整文件解压后按 `seq` 水位；文件可能被重写/压缩，需前缀哈希校验；**Node v24 内置 zstd 同步/流 API 只解首帧，必须逐帧迭代或调用 zstd CLI** |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；归档 `~/.codex/archived_sessions/*.jsonl.zst`；索引 `~/.codex/sqlite/codex.db` | JSONL：`session_meta`（session_id/cwd/model_provider/originator）、`event_msg`（task_started/agent_message/user_message/token_count 等）、`response_item`（message/function_call/function_call_output/reasoning）、`turn_context`、`token_usage_record`；`local_thread_catalog` 有 242 行标题/cwd/来源 | 235 个活跃 rollout + 25 个归档 .zst | session_id + `ordinal`；turn_id/root_turn_id | 追加 JSONL；归档为 zst，需单独枚举 |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`；子代理 `<uuid>/subagents/agent-*.jsonl`；结构化任务 `~/.claude/tasks/<session-uuid>/<taskId>.json` | JSONL：`user/assistant/system/attachment/summary/mode/queue-operation/last-prompt`；每条含 `sessionId/cwd/uuid/parentUuid/timestamp/isSidechain`；assistant content 有 text/tool_use/thinking；任务 JSON 有 `id/subject/description/activeForm/status/blocks/blockedBy` | 54 个主会话 JSONL；任务目录示例含 pending/in_progress/completed | `sessionId` + `uuid`；任务 `id` | 追加 JSONL；子代理另文件，需防重复计数 |
| Cursor | CLI 转录 `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`；CLI 聊天 `~/.cursor/chats/<workspaceId>/<chatId>/{meta.json,prompt_history.json,store.db}`；IDE `AppData/Roaming/Cursor/User/workspaceStorage/*/state.vscdb` | 转录 JSONL：`role=user/assistant/turn_ended`，用户内容包在 `<user_query>`，assistant 有 text/tool_use；`store.db` 为 `blobs(id,data)` + `meta(key,value)`，blob 内容地址化，叶子 blob 是明文 JSON，根 blob 实测为密文，`meta` 含 `blobEncryptionKey`；IDE DB 的 `composerHeaders` 在抽查库中为 0 行（未验证是否仍有其他写入路径） | 114 个 agent-transcript JSONL；CLI chat store 数 MB 级；workspaceStorage DB 最大约 43MB | transcript uuid；blob hash；sessionId | 转录追加；store.db 按 mtime/大小；加密根 blob 需解密或授权导出 |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite，含 WAL） | 表：`session/session_v2`（id/project_id/directory/title/model/time_created/time_updated/parent_id）、`message`（id/session_id/data JSON role）、`part`（id/message_id/session_id/data JSON type=text/tool/reasoning/step-start/step-finish/patch/file）、`todo`（session_id/content/status/priority/position）、`project`、`event` | 1.83GB DB + 79MB WAL；302 sessions、10,313 messages、43,028 parts、218 todos（completed 191 / in_progress 10 / pending 17） | session id、message id、part id；todo 无独立 id | 按 `time_updated` 水位增量查询，需重叠窗口去重；避免全表扫描 |

## 2. 已有结构化任务痕迹（先收，不要先让模型猜）

- **Claude Code**：`~/.claude/tasks/<session>/<taskId>.json` 直接给出 subject/description/status/blocks/blockedBy，等价于一份会话内任务清单。
- **OpenCode**：`todo` 表 + `session.title`，可直接还原每个会话的待办及状态。
- **DSH**：`todo/write` 事件是结构化 todo 快照；`session/title` 是会话标题；superagent worker 会话在 `agent/inbox/spliced` 中带 ticket_id/trigger_id。
- **Codex**：`local_thread_catalog` 给出线程标题/cwd/来源；rollout 内 `task_started`/`turn_context` 可还原轮次边界。
- **Cursor**：`meta.json` 有 title/cwd/createdAt/lastUsedModel；transcript 的 user query 可作任务锚点。

结论：五个来源里至少四个已有「任务/待办」结构化痕迹；设计应**锚点优先、LLM 补盲**，而不是从原始聊天全量猜任务。

## 3. 存量系统（不能造第二真相）

- DSH taskboard：`~/.dsh/dsh-taskboard.json`；有任务/项目/状态，是人机混合的现有任务面。
- DSH superagent：ticket/trigger/state/assignment/report，本会话即由它驱动。
- PTC：`D:\src\ynm3000\.ptc\registry.jsonl` 根任务/子任务/receipt，主控写账本。
- session-summary skill：M1–M5 已有会话摘要、目标聚合、纠正链、六状态待办；`extract.py` 是现有 DSH 会话摘要的只读提取器。
- focus-hub / track / worktable：已有项目/进度视图与只读投影。
- `~/.dsh/storages/dsh_dashboard.json`：约 27MB，按 session 记录 topic/tokens/turns 等事实，可作为 DSH 会话索引旁证。

### 3.1 Focus Hub 对象模型（v1.1 对齐依据）

- 对象库 `D:\src\dsh\focus-hub\mvp\data\objects.jsonl`：`object_id/object_kind/subkind/title/summary/status/project_id/source_ref/source_hash/canonical_body_location/cursors/provenance/revision/privacy_scope/sync_mode`；对象类型含 `SESSION / ARTIFACT(kind=summary|insight|report|file) / RULE / PROCESS`。
- 任务树 `project.json`：`tasks[]` 有 `id/parent/title/status/criterion/output/evidence/projectId`；`parked[]` 旁支；`insights`/`logs`/`commits`/`projects`。
- 读点：`SESSION.cursors[task_id] = {offset, read_at, scanner_version}`，同一会话给两个任务各记各的。
- 两道门：阅读/引用门默认开；执行门（RULE/PROCESS、拿洞察改任务/约束）需确认并记录主体/时间。
- 阶段：需求确认 → 方案 → 实现 → 验收，按证据识别 + `stageBasis`，人工可纠正；轨道=一级目标；会话归轨道，洞察/约束/成果物记最后关联轨道；无归属进 `orphans/materials/externalGroups`。
- 洞察设计：`docs/superpowers/specs/2026-10-25-long-conversation-insight-v2-design.md`；洞察登记样例 I01–I14：`docs/session-summary-2026-10-20-focus-hub-insights.md`；双模型挑战/裁决：`docs/superpowers/reports/2026-10-25-insight-challenge-adjudication.md`。
- **实现核对（2026-11-13）**：Focus Hub 已有 `dsh-source/flow-runner/analysis-adapter/obj-store/obj-api/suggestions` 等实现；当前 325 模块 + 19 服务端测试通过；216 活跃对象、28 SESSION（均有 cursors）、95 创建/17 活跃洞察、16 任务、6 项目、20 建议；详见 `outputs/focus-hub-audit.md`。
- **P0 阻断（2026-11-13）**：`dsh-source.firstFrameText` 只取 1MiB 解首帧；1,384 个 v4 文件中 191 个 ≥1MiB，191/191 失败；完整 buffer 可解；修复前不能宣称 DSH 覆盖完整。
- **待验证**：全 workspace 摄取、V2 元数据兼容、多源 SESSION dedupe、8770/7801 双端边界；本设计只提议按 A 方案接入，不声称已实现。

## 4. 关键边界与未验证项

1. Cursor `store.db` 根 blob 的加密算法/密钥派生未验证；叶子 blob 明文说明并非全库加密，但完整还原需要解密或官方导出。**不能在设计里写成已支持。**
2. DSH 会话文件是否会在 compaction 后重写前缀、`seq` 是否单调跨文件重建，需在实现期用真实文件验证；当前只按「解压整文件 + seq 水位」设计保守路径。
3. Claude 子代理 JSONL 与主会话可能共享 sessionId，需按 `isSidechain`/路径去重，否则任务量会虚高。
4. Codex `archived_sessions` 的 .zst 是否覆盖全部历史、`local_thread_catalog` 与本地 rollout 的对应关系，未完全核对。
5. 跨来源同一任务没有全局 ID；只能靠外部任务号、PR/commit、cwd/项目、文件路径、标题/语义候选，且必须允许「不合并」。
6. 所有会话都可能含客户数据、凭据、私聊；默认本地处理，外发模型必须按来源授权与脱敏。
