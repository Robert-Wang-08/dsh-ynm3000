# Superagent 定期健康报告：运行、绑定与回滚

实现位于 [服务目录](../../tools/superagent_health/)。这是仓库脚本服务，不是新DSH插件，不需要改profile或重启宿主。当前实现版本：5（2026-11-17）。

## 已实现行为

- 只读GET Superagent state、open/ended工单及详情；基于权威stage列出未完成与person人工事项。输入队列数量不会被误当成待人工。
- 读取明确关联的master/worker会话事件；事件响应source区分实际provider/model与请求别名。未匹配持久步骤只标候选，不伪称worker仍在线。
- 以自然日执行事件统计关联会话，以工单终态统计完成工单；两者分开。子代理/外部CLI覆盖未证实，显示为明确范围，不冒充全DSH统计。
- 每工单复用report.summary、report.at和assignment ID形成可追溯recap，标注它是否早于最新工单更新。worker自报不等于独立业务验收。
- 结束工单在报告窗口内记入「任务投入」并按运行时长降序：输入轮次为去重后的trigger输入（含建单触发；resumed重复不计），交手为assignment数，运行时长为建单到权威结束（含等待人工输入）；token为该工单worker会话全时用量（输入/输出/缓存，无usage记未知不填0，部分响应缺usage标“部分”），不含主控/子代理/外部ACP。只列前10项并标注未列数量，另给本窗口结束任务合计token；详情读不到时标“缺少可核验投入数据”，不填0。
- 每分钟采样；09/11/13/15/17/19简报，21:05未闭账日报；次日生成前一自然日执行窗口闭账并在09:00后投递。历史闭账里的工单当前状态仍标本次采集时间，不声称复原历史状态。
- 连续3次不可采集后告警；组件error需同一错误签名连续3次采样后才告警，避免单次抖动或组件轮询瞬时失败变成事故。连续3次采样正常后恢复；已投递的同一实例告警在15分钟内不重复（防抖冷却），告警投递前已恢复的，队列中的异常消息直接作废、不再补发恢复消息（避免22–08静默期积压后早上连发一对照）。正常sourceOff/localMode不算宕机。
- 异常与恢复是精简消息：只列异常组件/采集失败代码、最近错误、恢复时点与原因（此前异常组件、起始时间、连续成功次数），不再重复会话、工单、已结束会话与任务投入；完整清单见每两小时整点的「健康报告」。单条通常一页以内。
- 新人工事项在工单静默 `attention_settle_seconds`（默认900秒，即15分钟）后通知：工单在等待期内有任何更新（包括人在原线程回复）就重新计时，问题已闭环或工单已继续推进则不发，避免人正在回复时通知先弹出来；同一待办问题的工单更新不重复通知。渠道首次接受30分钟后提醒，之后2小时，最多3次/自然日工作时段。完成的权威工单不因旧ready报告重新变待办。
- 报告正文按 Markdown 渲染（标题、列表、加粗、分段），通过 `lark-cli im +messages-send --markdown` 转为飞书富文本 post；定期报告、异常/恢复、待人工事项/提醒共用同一套渲染管线。异常/恢复与待人工事项/提醒只列本次要报的内容，不再重复整份健康报告，并在末尾用一行提示完整报告的位置：完整待人工事项快照 `%USERPROFILE%\.dsh\state\superagent-health\latest-attention.md`，飞书全量报告见每两小时整点的「健康报告」消息（同内容）。
- SQLite outbox持久化；整份多页报告一次事务入队，避免崩溃后只排入半份报告；唯一key去重、90秒发送租约、超时/崩溃后unknown_delivery、失败退避。消息含report ID，CLI传同一idempotency key。渠道接受凭message_id确认，不声称已读或exactly-once。超过6小时或永久权限错误停留needs_attention，不悄悄丢弃。
- 22–08普通消息静默，重试也遵守静默；严重接口失联可绕过。独立采集步骤写私有快照，发送不会写业务状态。

## 必要依赖与跨设备入口

需要Python3.10+、zstd CLI，以及已安装的session-summary技能。事件解压复用该技能extract.py，不复制技能本体。默认路径为用户目录下.agents/skills/session-summary/scripts/extract.py；不同部署可在设备配置设extractor_path。zstd按PTC_ZSTD/PATH/conda环境定位。发送额外需要lark-cli，其help必须支持--idempotency-key。

先读本说明；然后在新设备仓库根运行：


~~~powershell
pwsh tools/superagent_health/manage.ps1 init
~~~

这一步只建新设备配置；已存在则拒绝覆盖。配置路径默认是用户目录下.dsh/device/superagent-health/config.json；操作系统路径、实例端口、收件人等只放设备层，不进Git。Python/CLI/技能未找到时，先装齐这些依赖再验证。现有样例中的3082/3083是可改的参考实例，不代表其他机器的真实部署。

## Dry-run 与检查


~~~powershell
python -m unittest discover -s tools/superagent_health -p test_health.py -v
node "$env:DSH_PROGRESS_CLI" run --task health-dry-run -- python tools/superagent_health/service.py dry-run --config "$env:USERPROFILE/.dsh/device/superagent-health/config.json"
~~~

单次dry-run只生成本地快照，不排队、不发送消息。运行数据默认放用户目录下.dsh/state/superagent-health，包括health.sqlite、latest.json、latest.md、heartbeat.json。包含工单标题/摘要和本地缓存路径，属于私有运行数据，不提交、不公开分享。基础脱敏覆盖常见key/ID/路径格式，不是通用敏感信息检测器；只有核实授权的管理人可收报告。

测试覆盖65个证据/投递/调度场景（含任务投入统计与排序、投入缺失不填0、窗口外结束任务不混入、worker会话全时token与缺usage不填0、部分usage标注、富文本渲染、待人工短通知与完整待人工快照、人工事项静默等待与回复重新计时、默认15分钟窗口、同一问题不重复通知、旧状态升级不重复通知、新问题仍会通知、提醒仍在接受后触发、多页事务回滚、事项旧版本作废、采集失败不误销项、相同收件人换bot拒发、静默期重试、前日闭账时间、组件error确认与抖动不告警、长时间降级后首个正常采样不触发恢复、精简异常/恢复不含会话与投入、投递前恢复作废队列告警、15分钟告警冷却）：跨午夜、未来事件排除、请求别名与响应模型、缺usage不算免费、recap来源、认证失败与零数据区分、分页漂移、重复enqueue、双执行者租约、ack前崩溃、发送超时、永久错误、CLI未返回message_id、静默期与重复tick。

## 收件人绑定（真实发送前）

必须核实以下三项：目标私聊或群、以哪个bot身份发送、允许发送的内容是脱敏健康报告。现有旧脚本及包装器指向不同渠道，不能根据默认chat_id猜哪个是管理人。先完成可审查样报，再让管理人明确选择已有渠道或指定新渠道。

设备配置delivery.enabled与binding_confirmed只有核实后才设true。identity保持bot，content_policy保持redacted_health_report_v1；配置本身不保存appSecret或token。相邻的binding.env.json只允许四个非秘密键：

~~~json
{
  "DSH_HEALTH_CHAT_ID": "oc_由管理人确认的目标",
  "DSH_HEALTH_LARK_CLI": "本机真实lark-cli.exe绝对路径",
  "DSH_HEALTH_LARK_CONFIG_DIR": "现有bot登录配置目录，不复制凭据",
  "PTC_ZSTD": "可选，本机zstd绝对路径"
}
~~~

binding.env.json留本机或设备共享配置层，不进Git。run.ps1只加载这些键到本进程；真实凭据仍由CLI自己的安全配置管理。若发送命令返回高风险确认门禁或缺权限，保留needs_attention并处理实际授权，不能自动加绕过参数。

## 定时执行、停用与回滚

安装采集任务（发送关闭）：

~~~powershell
pwsh tools/superagent_health/manage.ps1 install
pwsh tools/superagent_health/manage.ps1 start
pwsh tools/superagent_health/manage.ps1 status
~~~

安装后每分钟单次运行；任务经`wscript.exe`启动隐藏窗口VBS运行（2026-11-16修复每次启动闪现pwsh控制台），保留子进程退出码供LastTaskResult。任务计划的IgnoreNew和进程文件锁共同防止重叠。任务已存在时拒绝自动替换。查看heartbeat时间、最新报告和任务LastTaskResult；单机任务失败不能保证发出自身失联告警，需要异机watchdog才能检测整机离线。

已完成绑定及内容确认后，先执行一次真实投递验证，再启用发送任务：

~~~powershell
pwsh tools/superagent_health/run.ps1 -Config "$env:USERPROFILE/.dsh/device/superagent-health/config.json" -AllowSend
# 如已有采集任务，先显式停用、注销；保留本地outbox：
pwsh tools/superagent_health/manage.ps1 stop
pwsh tools/superagent_health/manage.ps1 uninstall
pwsh tools/superagent_health/manage.ps1 install -AllowSend
pwsh tools/superagent_health/manage.ps1 start
~~~

CLI通过stdin接收报告Markdown，以`--markdown`发送富文本post，避免正文出现在进程命令行；仅message_id确认后才记channel_accepted。不得把排队成功当送达成功。历史未知投递使用相同key有限重试；服务器幂等有效期受渠道约束，因此不能承诺无限期去重。

停用或回滚：

~~~powershell
pwsh tools/superagent_health/manage.ps1 stop
pwsh tools/superagent_health/manage.ps1 uninstall
~~~

可只读检查运行状态：

~~~powershell
python tools/superagent_health/service.py status --config "$env:USERPROFILE/.dsh/device/superagent-health/config.json"
~~~

status不采集、不发送、不创建数据库；回显心跳、队列计数及设备发送开关。

不删除health.sqlite；它包含去重、水位和未知投递证据。恢复服务时沿用同一state_dir及绑定；换收件人后旧队列会因bindingHash不符进入needs_attention，不能直接把旧正文重发给新人。旧notifier是否停用需另做事件范围对账，本服务不会擅自终止旧进程。

源码在仓库原位运行，更新代码无需重装插件；涉及Python/CLI安装、设备绑定和任务计划时按本说明重建。设备配置与凭据按各自渠道管理，不复制别台机器的绝对路径或登录态。

## 当前用量限制与数据边界

当前dashboard接口受宿主认证保护（本机匿名GET为401），服务显示unavailable，不读取凭据绕过认证，也不会发POST scan。已有dashboard扫描器排除worker-目录并缺任意session集合过滤；获得认证也不代表拿到Superagent总账。关联会话事件中的usage可作为局部观测，不额外把cache字段重复相加，不提供未定价币种金额。

原始会话仅为本机事件解析读取，临时解压由extract.py清理，不进入报告库。日志超过64MiB压缩预算、无法定位唯一存储目录或技能缺失时显式降级；没有证据不会给假模型或零消耗。快照不是跨接口事务，采样期间工单可变化。

首版范围：已关联master与工单worker；嵌套子会话/外部ACP不声称完整覆盖。正式需要全量专属成本时需补子会话关联、扫描覆盖和计价契约。没有异机watchdog时无法告警整机断电。

