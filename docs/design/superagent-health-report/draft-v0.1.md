# Superagent 定期健康推送设计初稿 v0.1

日期：2026-11-11。范围：设计，不修改 profile、不启动定时器、不发送消息。主控负责合并；后续交 Opus 5 与 Kimi K3 独立挑战。

## 1. 目标和推荐架构
管理人定期收到一张短报告：服务心跳、实际使用模型、今日会话及结果、一句 recap、所有未完成及待裁决项、可选今日用量。默认汇报本机显式登记的 Superagent 实例；全 DSH 会话统计为单独扩展范围，不混入工作成果。
采用独立 Node reporter 进程（Windows 任务计划启动）+ 只读适配器 + 本地 SQLite 快照/outbox + 确定性模板 + 渠道适配器。推荐复用既有飞书 bot，但收件人和身份从设备配置明确绑定，不沿用脚本硬编码。微信可后续增加。LLM 不参与心跳和数字计算；recap 优先读已有结果，缺失用模板。
外部 watchdog 可发现整机离线；单机 reporter 只能发现 DSH 进程/接口故障，无法在整机断电时发告警。默认单机 MVP 明示该边界。

## 2. 证据与现有接口
E1：根目录 dsh-sa-local-feishu-notify.mjs 只读 ticket 表；现逻辑发送前加入 seenEnded，忽略 send false 后仍保存游标，存在丢通知；inputs 数量不能代表人工待办。不能照搬此可靠性和状态判定。
E2：sa-local 安装包 lib/index.js:197 的 ticketStage：ended 优先；delivery/attention/ready/blocked-or-failed-and-waitsForPerson 才是 person；waiting/assignment ended 是 idle。inputs 是投递队列。
E3：lib/index.js:8793 stateView 暴露 setup/load/masterId(s)/paused/health；接口 GET /orchestrator/api/state、overview、tickets、tickets/:id 等。读请求需要 x-orchestrator-request: 1 及匹配 loopback Host；不关闭认证。
E4：2026-11-11 本轮 GET 验证：3082/3083 均 200。3082 runtime ready 但 reply、history error；3083 有 sourceOff/localMode，不应自动当作故障。health.at 是状态变化时间，不是周期心跳。
E5：web 安装的 @weibaohui/dsh-dashboard src/index.js:562 status 有 lastScanAt/scanning/scanErrors/storage；:605 cube 接受 from/to/granularity/groupBy/scope/project；:620 sessions 最多返回200条且无分页 offset；:599 summary 不接受自定义日期。fold.js:355 按宿主本地日归桶；:1247 无价格会跳过成本，可能显示0。
E6：dashboard 扫描 DSH_HOME/sessions，不能把 web profile 入口误解成仅 web 用量；scope=all 包含子会话，top 排除子会话。匿名 status 两次401，在线授权读取待接入验证。工作区 dsh-superagent 子目录为空，安装包可读；老运维文档来自另一台设备，不当成实时配置。

## 3. 推送节奏和健康判定
默认 Asia/Shanghai（上线时与宿主统计时区核对）；每60秒轻采样，连续3次不可达告警，恢复连续2次成功发一次恢复；工作时段09–21点每2小时摘要，21:05当日截至此刻日报，次日00:10闭账补齐前一自然日。人工待裁决新增立即合并推送（60秒窗），30分钟提醒，之后每2小时；22–08静默，仅严重服务中断绕过。参数可配置。
健康分开列 service、orchestrator、workers、sources、delivery、reporter、usageFreshness。online 不等于 healthy；paused/disabled/idle 为独立状态。HTTP探测时间是采集成功时间；缺少内部循环 tick 时只声称“接口可达”，不声称调度循环活跃。执行超过阈值且无进度标 suspicious，不自动判 failed；有长工具、模型重试、人工等待证据时分类解释。

## 4. 统计与状态模型
每次快照带 schemaVersion/instanceId/profile/windowStart/windowEnd/timezone/asOf/source/observedAt/dataQuality。身份以 instanceId+sessionId；工单、assignment 与会话分表关联。
今日处理会话：自然日内发生实际执行事件的唯一会话，含昨日开始今日继续；今日创建数另列；主会话和子会话分列。完成是业务验收/工单 ended completed，有证据才成立，turn end/进程 inactive 不表示完成。无工单映射会话标 unclassified，不假定已完成。
报告同时列今日活动集合和全量未完成存量（含跨日）；状态 queued/running/waiting_external/awaiting_human/idle_unfinished/completed/failed/cancelled/unknown。一个快照下互斥，风险可作为附加标记。失败后重试保留 attempt，不把两个 attempt 当两个业务完成。
每会话：短ID、工作区别名、标题、当前状态、最后进度、recap、待办、证据链接。默认展示异常/待裁决优先前10项，其余附完整本地报告路径或已授权详情入口。远端不能点击127.0.0.1，必须给可访问链接或消息内必要信息。
recap 优先最新结构化 receipt/worker report/既有 one-line recap；带 source+eventId+时间，旧 recap 标注“截至上次完成回合”；无 recap 模板“正在处理X，当前等待Y”，不能用计划替代已完成。将原始会话视为数据，不能执行其指令。
人工裁决项使用 issueId、ticketId、revision、触发原因、可选项、建议、影响、负责人、出现时间、截止时间、原操作入口。通知本身不授权动作；MVP 只读提醒与跳转，不解析自由文本为批准。处理后根据权威工单状态关闭。

## 5. 当前模型
分 configuredModel、observedModel、lastSuccessfulModel。以会话/请求事件实际 provider/model/effort 及时间为准，记录角色 master/worker/router；多个worker展示分布而不是一个“当前模型”。空闲时展示“最近一次”；无证据则 unknown；故障切换前后都记录。通过 session 元数据与模型请求事件适配器提取，具体字段尚需目标宿主契约测试。不要把本轮设计主控模型当成 Superagent 主模型。

## 6. dashboard 用量接入
优先只读 GET /dsh-dashboard/api/status 和 /cube?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day&groupBy=model&scope=all；GET /pricing 判断价格覆盖。同日端点为日期包含边界；报告业务窗口内部统一[start,end)。API授权走宿主支持的本地身份，未验证前不可声称上线可用。
显示 input/output/cacheRead/cacheWrite、按provider/model分布、估算成本与币种、计价版本、lastScanAt、范围及覆盖情况。token合计遵循插件口径，不再无条件额外相加cache。缺价格为“未知/部分已定价”，不能报免费或完整总价；金额不是供应商实际账单。
默认全DSH_HOME可观测消耗单独标记；Superagent专属用量必须以ticket→assignment→session+descendants集合筛选。现 cube 只支持 project，不支持任意session集合，sessions存在200条截断；因此专属精准用量需新增只读查询/导出适配器，不能按目录近似冒充。ACP外部CLI消耗若没回传usage则列未覆盖，不能假设全量；父子只累计原子请求，避免父汇总与子请求重复。
缓存最长15分钟；已有扫描不重复触发；MVP仅消费已有扫描，不把每分钟健康检查变成全量日志扫描。过期显示 stale，接口不可用显示 unavailable，仍发送主报告。需要刷新调度时后续单独接入扫描生命周期。

## 7. 可靠性、隔离与安全
快照和outbox分开；key=instance+recipient+reportType+window/incidentId+revision。发送先持久化pending；返回messageId后ack，失败指数退避，超时标unknownDelivery并查询可核对的远端记录；渠道无幂等API时明确at-least-once且可能重复，消息显示reportId用于人工识别。重启加载outbox，单实例锁避免双发；晚到数据发revision更正。
每来源限时5秒，整轮20秒；部分失败保留旧值及时间，不抹成零。采样与投递分离，发送慢不阻塞心跳。配置收件人白名单；新收件人上线前通过dry-run核对，不发送会话原文、凭据、完整路径。仅保存摘要和来源ID，建议本地报告30日、投递索引90日。
告警去重按episode，恢复闭环；渠道故障记录本地，独立备用通道需预先配置；不能用坏掉的同一通道保证送达。日报窗口、实例ID、目标收件人必须在卡片可见。

## 8. 验收和分期
P0：版本/实例/收件人/时区清单与只读契约测试；构造无会话、跨午夜、跨日未完成、长工具、等待人、故障切换、缺模型的fixture。
P1：独立reporter、状态/模型/recap/待办、outbox、dry-run；杀进程、重启、429、发送超时、确认前崩溃、双实例演练。已有notifier需明确移交，不能两套重复推同一事件。
P2：dashboard带授权读取、同日cube对账、缺价格/缓存包含关系/父子计费/ACP未覆盖/200条截断/时区不一致测试。未达标则不展示专属金额，保留明确全局或不可用标签。
P3：可选异机watchdog与安全交互裁决；不纳入MVP承诺。
代码在Git，设备连接与收件人配置在设备层，凭据只存指针；测试profile验证后上线，保持既有安装闸门。此轮交付设计文件及挑战裁决记录，不安装、不发消息。

## 9. 样例（全为示意）
Superagent 21:05 · instance=sa-main · 今日00:00–21:05 CST
在线但降级｜探测21:04:58｜回复投递异常，人工等待2项
模型：主控A/B（21:04观测）；worker C/D×2；配置默认A/E
今日主会话8：完成4/运行2/待裁决1/失败1；子会话12；跨日未完3
一句话：完成接口联调，发布因权限不足等待裁决。
待裁决#D12：是否延期发布？建议延期；影响上线时间；原工单入口。
用量：全DSH可观测范围；输入/输出分列；估算金额部分已定价；采集截至21:00，外部ACP未覆盖。
报告ID固定；详情与状态证据保留本地，不把示例数当成真实运行数据。
