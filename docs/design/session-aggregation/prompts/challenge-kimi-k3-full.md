# 任务：以 Kimi K3 角色独立挑战「多 Agent 会话自动聚合与统一任务登记」设计

你是独立落地挑战者。只审查，不写代码、不改文件、不替设计者辩护。你关心的是：这套东西在真实机器上能不能跑、会不会贵、会不会泄漏、用户会不会用两天就放弃。

## 输入

1. 6astra 主设计稿（下文）。
2. 本机实测盘点（下文）。
3. 主控约束（下文）。

## 主控约束

1. 会话不是任务：同一会话可含多任务，同一任务可跨会话/跨 Agent；任务必须有稳定 ID。
2. 身份优先于语义：只有外部任务号/PR/commit/native task 等硬锚点可自动合并；语义相似只作候选。
3. 进度不得伪精确：没有验收标准就不给百分比；不用消息数/工具数冒充完成度。
4. 自报不销项：助手说“完成”、子代理退出 0、测试通过，都不能单独把任务标 done。
5. 证据必须可回链：每条事实要有来源会话与事件；无来源事实不得入库。
6. 只读聚合：登记表不得双写 taskboard/PTC/superagent；同一事实只能有一个写权威。
7. 增量必须贴合真实格式：DSH 是整文件 zstd、OpenCode 是 1.8GB SQLite+WAL、Cursor 根 blob 加密；不要假设存在逐事件流。
8. 不扩成系统：第一期不做向量库、不做常驻大 Agent、不做自动写回、不做多租户。
9. 每阶段可验收：给可测试的通过标准；不要“大爆炸上线”。
10. 未验证项必须标注：Cursor 解密、DSH compaction、Claude 子代理去重、Codex 归档完整性都还没有定论。

## 你必须回答的问题

1. **真实体量**：DSH 1,424 个 zstd 会话、OpenCode 1.83GB DB + 79MB WAL、Cursor 114 个转录、Claude 54 个主会话。首建和增量各要多久？哪些操作会锁库/卡 UI/吃满 CPU？
2. **增量正确性**：整文件 zstd + seq 水位、OpenCode time_updated 水位 + 重叠、JSONL offset，分别在 compaction、WAL、时钟回拨、并发写、文件重写下会漏什么/重什么？给最小验证方法。
3. **Windows 运维**：DSH 插件 + 计划任务 + 单写者锁，实际装起来会有哪些坑（端口、权限、开机未登录、路径空格/中文、长路径）？
4. **成本**：按真实体量估算首建与日常 LLM token；什么情况下会从“便宜”变成“不可接受”？如何止损？
5. **隐私**：会话里有客户数据、凭据、私聊；本地抽取、脱敏外发、只存指针三条能否同时成立？哪些默认设置会让用户误以为安全？
6. **评估**：30 个金标够不够？怎么构造不泄漏、不偏置的评测集？precision/recall 之外还应看什么？
7. **用户工作流**：用户凭什么每天打开这个登记表？如果 review 队列积压、任务卡不准，用户会怎么放弃？
8. **失败恢复**：源文件被删、DB 损坏、插件升级、模型输出坏 JSON、账本写一半崩溃，分别怎么恢复？会不会静默丢数据？
9. **最可能失败的原因**：3 个，按概率排序；每个给早期信号和止损动作。
10. **如果只能做一件事**：第一期做哪一件、砍掉哪些？

## 输出格式（严格）

```
# Kimi K3 独立挑战：多 Agent 会话聚合与统一任务登记

## 结论（≤150 字）
## 挑战清单（C1..C10）
每条：
- **严重度**：高/中/低
- **主张**：一句话
- **反例/实测风险**：具体场景、量级或失败路径
- **最小修正**：改哪个字段/规则/阶段
- **一期还是后置**
## 应从 MVP 删掉的 3 项
## 设计未回答的 3 个问题
## 用户会在第几天放弃，为什么
## 对主控约束的反挑战（如有）
```

要求：
- 用具体数字/路径/命令说话，不要泛泛而谈。
- 不要重复设计稿原文；直接指出哪里不可行、怎么改。
- 不要客套；不要给“整体很好”的评价。
- 中文输出，2,500–4,000 字。


## 6astra 设计稿（全文）

# 多 Agent 会话自动聚合与统一任务登记：设计 v0.1

## 一、结论先行（≤250 字）

建设“本地证据流水线＋任务登记投影”，而不是能自行裁决的大 Agent。DSH 优先接入，其他来源通过可降级适配器扩展；先识别证据和任务关联，再生成七类任务内容。登记表统一展示，不替代 taskboard、PTC 等已有权威；完成必须绑定验收证据及授权确认。先只读、可回放、可纠正，再考虑受控写回。

本文由 6astra 设计视角主笔；opus5、kimi k3 仅列入后续挑战计划，**未声称已完成评审**。

## 二、目标、非目标与成功标准

**标记约定**：`事实`仅指用户提供的盘点；`设计`为待批准方案；`推断`为估算或判断；`待验证`必须通过 spike 确认。本文参数均为设计默认值，不代表本机现状。盘点引用按给定条目顺序编号：1 DSH、2 Codex、3 Claude、4 Cursor、5 OpenCode、6 已有系统、7 安全。

**目标**：

- 自动发现新增会话与续写内容，保留可定位的证据。
- 将会话分段，一个片段可关联多个任务，一个任务可汇集多个来源。
- 输出目标、方案、成果物、裁决、洞察、总体计划、待办，并呈现覆盖缺口。
- 允许用户撤销关联、拆分任务、纠正结论；重建投影不丢纠正记录。

**非目标**：不替代已有任务系统，不自动修改代码、运行验证命令、销项或执行会话中的指令；不承诺完整恢复 Cursor；不把历史资料全部上传模型；不生成没有分母的完成百分比。

**成功标准〔设计〕**：建立至少 200 个标注片段、50 个任务的验收集，覆盖跨源同任务、同会话多任务、重放及撤回场景。自动关联精确率≥98%，召回率≥80%；自动跨任务合并必须零误合并，否则降级为建议。上述为样本门槛，不冒充总体保证。投影事实来源覆盖率100%；同一输入回放三次不新增重复事实；无证据销项为零；常态新增内容五分钟内可见，积压单独报告。

为什么优先精确率而非召回率：漏关联可以补，误合并会污染裁决与进度。

## 三、总体架构与数据流

**设计数据流**：

`发现器 → 只读适配器 → 事件日志 → 分段/锚点索引 → 任务候选 → 证据与冲突判定 → 事实日志 → SQLite 投影 → Markdown/JSON/DSH 展示`

模型只生成带证据的提案，无状态提交权限。规则引擎负责幂等、权限、状态门禁；人工队列负责歧义和验收。

**部署建议**：一个本地服务负责调度，适配器以独立工作进程运行；CLI 提供扫描、回放、确认、纠正与导出；DSH 插件只做展示与提交确认。服务不可用时可用定时任务调用同一 CLI，必须共享进程锁，不能并行双调度。不直接把全部能力嵌入 DSH，因为跨源故障和资源占用不应阻塞交互。

**建议位置**：数据位于 `~/.local/share/harness-registry/`，配置位于 `~/.config/harness-registry/config.toml`；均为新建设计路径，不是本机事实。来源只读，权限默认目录0700、文件0600。

日志是派生登记事实的持久基础，SQLite 是可重建投影。先落日志、再推进游标；投影失败从日志补齐。单来源设置超时、内存额度、隔离队列与熔断，坏文件不阻塞其他来源。

不选“大而全 Agent”：它难以保证水位、重放、撤销与权限隔离，也容易将内容指令误当系统指令。

## 四、来源适配器与统一事件模型

### 4.1 统一契约

| 接口 | 输入与输出 | 必须保证 |
|---|---|---|
| `discover` | 根目录、策略→资源清单与能力声明 | 不越过白名单；报告不可读资源 |
| `parse` | 资源、游标、预算→完整记录与诊断 | 半条记录不消费；原始字段保留 |
| `normalize` | 记录→统一事件 | 不把不同来源状态强行等同 |
| `cursor` | 已持久化批次→可恢复水位 | 带解析器版本、文件代次或数据库水位 |

资源记录包含 `resource_id/native_session_id/generation/fingerprint/capabilities`。能力分为 `full/partial/unsupported`，细到文本、工具、任务、父子关系，不使用笼统“已支持”。

统一事件字段：

`event_id, source, resource_id, native_session_id, native_event_id, parent_id, seq, occurred_at, observed_at, kind, actor, cwd, project_hint, payload, evidence_ref, sensitivity, parser_version, generation`。

`evidence_ref` 包含来源路径或库表、行主键、解压后记录序号、字段路径、内容摘要和可选脱敏摘录。事件 ID 优先由来源原生 ID 生成；否则使用资源代次、记录位置与摘要。不能只按文本摘要去重，否则重复执行的同一命令会被吃掉。

### 4.2 来源规则

- **DSH〔事实：见盘点第1节〕**：按会话头和 `seq` 归一化消息、工具、todo 与 job；`todo/write` 作为快照，不当作逐项新增。`ticket_id/trigger_id` 是显式关联锚点，不自动代表任务已完成。多帧 zstd 保存“解压记录水位＋源文件指纹”；仅在验证帧边界后优化续读，不假设任意压缩偏移可解码。
- **Codex〔事实：见盘点第2节〕**：会话记录为主要证据，`local_thread_catalog` 只补标题和 cwd。跨记录类型可能重复表达同一交互，先保留来源身份，再按已验证规则折叠。归档与活动文件建立资源别名，不凭同名直接认定完整一致。
- **Claude〔事实：见盘点第3节〕**：利用 `uuid/parentUuid/isSidechain` 建关系图；结构化任务文件按内容摘要检测变化。原生 `status` 仅映射为报告状态，不能直接销项。父子代理复制内容的去重待验证。
- **Cursor〔事实：见盘点第4节〕**：首期仅接入可解析 CLI 转录，标记覆盖为 partial。`store.db` 根 blob 为密文、叶子明文，不能因此承诺完整还原；不记录或外发 `blobEncryptionKey`。IDE 零行抽查不等于没有会话，界面必须显示“其他路径未验证”。
- **OpenCode〔事实：见盘点第5节〕**：使用只读、短事务查询；按各表 `time_updated` 加稳定主键复合水位推进，主键及索引先验证。默认重叠回看十分钟，再按实体版本去重；若时间不单调，需分区审计补漏。避免全表轮询，也不能只复制主库而忽略 WAL。

文件缩短、替换或指纹改变时增加 `generation` 并重扫对应资源；不覆盖旧证据。追加文件只消费完整记录，损坏压缩尾帧留待下轮。压缩归档设置解压大小上限。并发写数据库通过读事务获得批次一致性，不长期持有快照。

## 五、任务识别与聚合

### 5.1 分段和锚点

硬边界是显式“开始新任务”、原生任务切换、已有任务引用；软边界是目标或成果物变化。工具调用与结果保持同段，worker 回传保留父关系。默认候选段不超过8,000 token；超限沿 turn 切开并继承上下文引用，不只靠时间间隔分段。

锚点优先级：

1. 带命名空间的外部任务 ID、PTC ID、superagent ticket及人工映射。
2. 明确任务 URL、原生 task/todo ID；原生 ID 必须带来源与会话作用域。
3. 仓库身份＋PR，或 commit 与明确目标共同出现。
4. 项目、cwd、成果物路径、验收条件。
5. 标题、关键词、语义相似度。

PR、commit 可能服务多个任务，不能单独作为合并许可；cwd 与标题只缩小检索范围。

先按强锚点、项目与路径召回候选，再做语义补充，每段最多20个候选。无候选时生成“待确认任务”，保留原始意图，而非强配最近任务。

### 5.2 关联与实体解析

模型输出 `candidate_id/relation/evidence_refs/reasons/counterevidence`，关系包括 `same_task/subtask/depends_on/related/unrelated`。没有证据指针的输出拒收。

置信度是规则特征与标注集校准后的分数，不采用模型自报概率：

- ≥0.98且具备命名空间一致的强锚点、无冲突：自动关联片段。
- 0.75–0.98：进入人工确认队列。
- <0.75：保持独立；语义相似只能建立 related 建议。

已有两个任务的实体合并比片段关联更危险：除相同权威 ID 外，首期均需人工。目标互斥、客户域不同、明确拒绝合并构成硬否决；人工否决生成 `do_not_merge` 约束，避免下次重复建议。

稳定 ID 使用本地生成的 `task_id`，不由标题或路径派生。外部 ID 存入 `task_alias`；合并保留旧 ID 重定向及撤销事件，拆分创建新 ID 并逐条重分配事实，不删除原任务历史。项目搬家通过确认别名连接，不能把同 basename 目录当同项目。

为什么不选“聚类后直接登记”：语义接近经常只是同一项目中的不同目标，错误会沿总结链放大。

## 六、进度、证据与验收

**设计状态**：`待确认、待开始、进行中、受阻、待验收、已验收、已取消`。这是本登记投影词表，与 session-summary 既有六状态的映射待核实，不宣称一一对应。

每条状态候选包含 `from/to、依据、适用范围、提出者、确认者、有效时间`。证据不能简单排一条高低序列：

| 类型 | 可证明 | 不能证明 |
|---|---|---|
| human | 授权者确认目标、裁决或验收 | 没有授权者身份就不算权威 |
| tool | 特定工具曾执行及其返回 | 退出码0不等于目标满足 |
| commit | 某仓库提交存在、变更范围 | 已部署、正确或客户接受 |
| test | 指定版本、环境下的用例结果 | 未覆盖要求均已满足 |
| agent-report | 助手的声明或计划 | 实际完成与验收 |

工具结果必须带工具名、输入摘要、输出摘要、时间与任务范围；测试还需命令、版本、退出码、用例摘要。会话里的测试日志是“记录到的结果”，不是系统重新独立验证；独立核验能力首期不执行命令。

**自动推进边界**：确认任务存在后，可由明确工作证据从待开始推进到进行中；明确失败可提出受阻。只有已定义验收条件全部具备对应证据时才可进入待验收。已验收、已取消、变更验收范围必须由授权人工或既有权威系统事件确认。

`todo=completed`、`job=settled`、助手“已完成”只记作报告。无验收条件时只能展示“成果候选已出现”，不能自动待验收。

冲突不按最后写入覆盖：并存保存，标记 `conflicted`，暂停推进。纠正追加 `supersedes` 关系；已验收后出现反证，展示“验收受质疑”并请求重开，不悄悄改历史。默认七天无证据标 stale，三十天要求复核，但不据此倒退状态。用“已验收条目/明确验收条目”表达局部计数，不输出伪百分比。

## 七、统一登记表（schema + 存储 + 示例 + 目录）

### 7.1 数据结构

任务卡外层包含 `task_id/aliases/title/project/authority/status/revision/coverage/conflicts`。七类内容均为条目数组，而非不可追溯的大段摘要：

| 字段 | 条目专有字段 |
|---|---|
| `goals` | objective、scope、non_goals、acceptance_ids |
| `approaches` | option、steps、constraints、selected_by |
| `artifacts` | uri、kind、digest、revision、verification |
| `decisions` | question、options、outcome、decider、authority |
| `insights` | statement、applicability、confidence、counterevidence |
| `plan` | milestone_id、dependency_ids、exit_criteria、order |
| `todos` | action、owner、state、blocked_by、acceptance_ids |

共同信封为 `fact_id/evidence_refs/asserted_by/recorded_at/valid_at/revision/supersedes/verification`。模型提炼属于派生主张，`asserted_by` 必须指明模型与提案版本；未知字段写 null 或空数组，不补造内容。

SQLite 建议表：`source_resource、ingest_cursor、event、segment、task、task_alias、task_fact、evidence、task_relation、review_queue、projection_checkpoint、outbox`。唯一索引保护事件身份和 alias 命名空间；索引覆盖项目、状态、更新时间、外部 ID。FTS 仅索引获准摘要；向量索引后置，因为强锚点检索更可解释。

### 7.2 JSON 示例

以下完全为**虚构设计示例**，路径、任务与成果不代表本机事实；公共信封仅展开一项：

```json
{
  "task_id": "tsk_demo_01",
  "aliases": [],
  "title": "修复导出重复行",
  "authority": null,
  "status": "进行中",
  "revision": 3,
  "coverage": {"dsh": "partial"},
  "goals": [{
    "fact_id": "f_goal_1",
    "objective": "重复输入不产生重复导出行",
    "scope": "CSV 导出",
    "non_goals": ["历史文件清洗"],
    "acceptance_ids": ["acc_dedup"],
    "evidence_refs": ["ev_user_1"],
    "asserted_by": "source:user",
    "recorded_at": "2026-01-01T10:00:00Z",
    "valid_at": null,
    "revision": 1,
    "supersedes": [],
    "verification": "source_observed"
  }],
  "approaches": [{
    "option": "按业务键去重",
    "selected_by": null,
    "evidence_refs": ["ev_assistant_1"]
  }],
  "artifacts": [{
    "uri": "repo://demo/export.csv",
    "verification": "agent_report_only",
    "evidence_refs": ["ev_assistant_2"]
  }],
  "decisions": [],
  "insights": [],
  "plan": [{"milestone_id": "m1", "exit_criteria": ["acc_dedup"]}],
  "todos": [{"action": "补充重复输入测试", "state": "待开始"}],
  "conflicts": [],
  "evidence": [{
    "id": "ev_user_1",
    "source": "dsh",
    "resource_id": "demo_session",
    "record_ordinal": 12,
    "field_path": "data",
    "content_digest": "sha256:DEMO"
  }]
}
```

生产 schema 要求每个条目带共同信封；示例省略处不得在实现中省略。

```text
~/.local/share/harness-registry/
├── logs/events/2026-01.jsonl
├── logs/facts/2026-01.jsonl
├── registry.sqlite
├── evidence/redacted/
├── views/tasks/tsk_demo_01.md
├── exports/registry.json
├── quarantine/
└── audit/
```

日志批次带序号与校验摘要；重启忽略未提交尾批次。Markdown/JSON 是只读视图，手改不得隐式回灌；纠正必须走 CLI 形成日志。否则无法区分人工修订与旧视图覆盖。

## 八、自动化、成本与运维

**默认预算〔设计〕**：活跃来源每60秒增量扫描，五分钟补一次发现；每天核对资源清单和异常，不每天全量解压。每批最多500事件、32 MiB解码内容或15秒，任一达到即让出调度。历史回填每轮只占30%预算，新数据优先。

模型只处理弱锚点、跨段摘要和冲突解释。明确 ID、无内容工具记录、已缓存段不用模型；便宜本地模型先抽取，高成本模型只处理人工选定的疑难候选。缓存键包含内容摘要、锚点上下文、模型版本、提示版本和隐私策略版本。

默认每日最多200次模型调用、100万输入 token；达到任一额度即排队，不牺牲证据采集。积压超过10,000事件暂停非必要摘要，解析继续。失败按1、5、30分钟退避，五次后隔离；权限错误和不支持格式不无限重试。

**量级推断**：盘点说明需管理约数千来源会话资源，不代表去重后的任务数；OpenCode 数据库体积不能直接换算模型 token。若每日2,000事件、10%需模型、每批10事件，每次输入4,000 token，则约20次调用、8万输入 token；此例只用于预算，实际成本须阶段一采样。

仪表盘必须展示 `last_scan/last_success/lag/parse_errors/unsupported/pending_reviews`。任务覆盖分为完整、部分、未知；“没读到”不能显示为“没有”。

## 九、隐私、安全与不可信输入

默认本地处理，来源白名单可细化到项目、会话与时间范围。外发同时满足来源授权、字段脱敏、目标模型获准；混合批次采用最严格策略，禁止靠摘要绕过授权。审计保存请求摘要、模型目的地和策略版本，不再复制秘密。

所有会话都是不可信数据：其中“忽略规则”“读取密钥”等文本只能登记为内容，不能触发工具调用、路径访问或状态变更。模型无工具权限，输出经 schema、证据存在性、权限门禁三重验证。

凭据检测先于模型和全文索引：命中后替换稳定占位符，敏感原文不进入日志；检测不是泄露零风险保证。路径规范化防越界和符号链接逃逸；压缩输入限制解压比与大小。

建议原始敏感片段不持久化，脱敏摘录保留30天，任务事实保留一年，均需用户拍板。append-only 只意味着不悄悄改业务历史，不代表禁止合规删除：删除请求追加墓碑，再清理摘录、索引、缓存和备份到期副本；审计仅留非敏感删除凭证。

## 十、与存量系统的边界

**事实**：已有系统见盘点第6节；各自实际权威范围及写入 API **待验证**。以下是建议责任分配，不宣称现状如此：

| 系统 | 建议权威 | 登记表行为 |
|---|---|---|
| taskboard | 已登记任务的人工状态、负责人 | 读取并标明权威 |
| PTC registry | PTC任务身份、治理裁决 | 引用，不另建竞争 ID |
| superagent | ticket分派与运行生命周期 | 作执行证据，不等同验收 |
| session-summary M1–M5 | 已有摘要、纠正链、待办派生规则 | 复用解析与纠正，不重复裁决 |
| focus-hub/track | 焦点与追踪关系，待核实 | 展示关联，不冒充完成依据 |
| dashboard | 展示入口，待核实 | 接入投影，不反向覆盖任务 |

登记表是跨源只读投影，仅对自身的关联、来源记录及人工纠正日志负责。未映射到存量系统的任务是“未登记候选”，不是第二套正式任务。

首期禁止写回。后期只向选定权威发幂等命令：outbox 保存请求，成功后等待读取权威事件再更新投影；不能同时写本地最终状态和远端状态。若 taskboard 与 PTC 对同字段都声称权威，阻断并请用户裁决。

## 十一、分期落地（阶段/交付/验收/投入）

以下投入为**单工程师估算**，不含等待评审时间，合计约43–59人日，按0–3个月安排。

| 阶段 | 交付 | 验收与晋级条件 | 投入 |
|---|---|---|---|
| 0：第1–2周 | 格式 spike、权威矩阵、脱敏样本集、schema | 验证重点路径；未验证能力显式降级；权威边界获确认 | 6–8人日 |
| 1：第3–5周 | DSH只读MVP、日志/投影、七类卡片、人工关联与纠正CLI | 半写、截断、多帧、重复回放测试通过；每条事实可定位；无写回 | 12–16人日 |
| 2：第6–9周 | Codex、Claude、OpenCode；Cursor转录实验接入；规则关联与人工队列 | 标注集达到精确率门槛；并发写与归档重复测试通过；删除后不残留索引 | 15–20人日 |
| 3：第10–12周 | 可选模型补盲、资源预算、故障恢复、DSH展示 | 两周影子运行无伪销项；重建投影一致；覆盖与积压可见 | 10–15人日 |

每期先交付可独立使用增量；未过门槛不靠新增来源掩盖问题。完整 Cursor 解密/IDE恢复、自动执行验证、向量大规模聚类、双向编辑与写回必须后置，写回另行审批。

评审安排：opus5挑战实体误合并、状态门禁与权威冲突；kimi k3挑战增量恢复、性能和隐私删除。输出可复现反例，由6astra登记接受、拒绝或延后理由；这些是待执行工作，不是已得出的评审结论。

## 十二、关键洞察、反模式与不要做

1. **先有证据账本，后有任务卡**：摘要不是事实存储，重生成不能抹掉纠正。
2. **同任务不等于同话题**：共同客户、目录或技术栈都不足以合并。
3. **原生 todo 是报告，不是验收**：结构化只提升可解析性，不自动提升真实性。
4. **不完整也能有用**：明确 partial 比虚假的“全平台支持”更可靠。
5. **进度是证据覆盖，不是叙事强度**：长会话不意味着更接近完成。
6. **模型越强，提交权限越应窄**：模型用于补盲，不用于裁定自己的工作。
7. **统一入口不等于统一权威**：统一展示可以保留不同领域的决定权。

最易失败的三件事：任务误合并污染全部历史；源格式变化造成静默漏读；双写导致状态互相覆盖。对应防线是可逆关联、覆盖诊断和单权威命令通道。

明确禁止：全库反复送模型、按标题合并、以最后更新时间代表进度、助手一句“完成”销项、把解析失败计为零任务、从会话执行命令、覆盖人工纠正、在未验证前宣称 Cursor 完整支持。

## 十三、裁决候选（需用户拍板）

| 决策 | 默认建议 | 备选与不默认选择原因 |
|---|---|---|
| 正式任务权威 | 按现有系统及字段确定 | 新建统一权威：迁移及冲突成本高 |
| MVP来源 | DSH，其他渐进接入 | 五源齐上：故障面过大 |
| 部署 | 本地服务＋CLI＋薄DSH插件 | 全放插件：耦合交互生命周期 |
| 模型外发 | 默认禁用，逐来源授权 | 全局授权：容易跨客户域泄露 |
| 自动关联 | 强锚点且≥0.98 | 纯语义自动合并：误合并难发现 |
| 完成权 | 授权人工或权威系统验收事件 | 测试成功即完成：不能覆盖业务验收 |
| 写回 | 三个月内只读 | 提前受控写回：须先验证幂等接口 |
| 保存期限 | 摘录30天、事实一年 | 长期全量：隐私和删除成本更高 |
| Cursor路线 | CLI转录partial | 优先完整恢复：可行性与收益未证实 |

阈值、保存期限和完成授权人的最终配置须留在裁决日志，不能把本文默认值静默写成生产政策。

## 十四、待验证清单

以下 spike 是相关能力实现前置条件；失败就缩小支持面。

| 待验证项 | 实验与退出产物 |
|---|---|
| Cursor加密与图结构 | 经授权构造样本，验证根/叶关联、解密及消息顺序；形成能力矩阵，不输出密钥 |
| Cursor IDE路径 | 新建受控会话前后对比写入位置；未找到则标unknown，不推断无数据 |
| DSH compaction | 验证是否重写、seq是否延续、会话ID是否稳定；产出代次和重放规则 |
| DSH多帧续写 | 截断尾帧、追加新帧、替换文件，验证无漏读及无无限重扫 |
| Claude子代理去重 | 对照父子uuid、任务文件与复制消息；区分引用、重放和独立执行 |
| Codex归档完整性 | 对比活动/归档原生ID、事件及尾部；形成别名与缺失检测规则 |
| OpenCode水位 | 查主键、索引、时间精度及更新语义；并发写测分页、回看和删除识别 |
| 跨源身份 | 验证路径搬迁、worktree、同名仓库及远端别名；禁止仅凭cwd自动等同 |
| 存量权威与纠正链 | 阅读实际schema/API，确认六状态映射、人工纠正优先级及写回幂等能力 |

最终进入实现的条件不是“方案看起来完整”，而是：来源能力有证据、权威边界有人确认、失败与撤销路径可测试。

## 本机实测盘点（全文）

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

## 4. 关键边界与未验证项

1. Cursor `store.db` 根 blob 的加密算法/密钥派生未验证；叶子 blob 明文说明并非全库加密，但完整还原需要解密或官方导出。**不能在设计里写成已支持。**
2. DSH 会话文件是否会在 compaction 后重写前缀、`seq` 是否单调跨文件重建，需在实现期用真实文件验证；当前只按「解压整文件 + seq 水位」设计保守路径。
3. Claude 子代理 JSONL 与主会话可能共享 sessionId，需按 `isSidechain`/路径去重，否则任务量会虚高。
4. Codex `archived_sessions` 的 .zst 是否覆盖全部历史、`local_thread_catalog` 与本地 rollout 的对应关系，未完全核对。
5. 跨来源同一任务没有全局 ID；只能靠外部任务号、PR/commit、cwd/项目、文件路径、标题/语义候选，且必须允许「不合并」。
6. 所有会话都可能含客户数据、凭据、私聊；默认本地处理，外发模型必须按来源授权与脱敏。


## 现在输出你的挑战报告
按上面「输出格式」直接输出；不要复述设计稿，不要写客套话。