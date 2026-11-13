# 存量能力盘点（2026-11-04，本机文档与命令核实）

范围：能力与接缝盘点，不是安装态端到端验收；未读取原始私人会话。

|资产|已有能力|本次可复用 / 缺口|证据|
|---|---|---|---|
|session-summary M1–M5|单/多会话、按目标聚合、证据纠正链、六状态待办、时间水位|复用目标聚合与证据；没有层级任务图、三视图、实时同步协议|[SKILL](<D:/nutstore/Skill+Tool/skillhub/store/installed/session-summary/SKILL.md>)|
|extract.py|多帧zstd解压；cwd、标题、人类消息、worker深度、工具计数、最后助手摘要|离线初筛，不是无损增量事件解析；消息截断500字、最后助手1200字，关键状态仍需定点精读；不能把该digest当完整事实|[extract:113–199](<D:/nutstore/Skill+Tool/skillhub/store/installed/session-summary/scripts/extract.py#L113-L199>)|
|PTC|冻结目标/contract、根任务/子任务、receipt、追加账本、证据门槛|有执行事实，无通用业务L1/L2/L3层次与依赖模型；账本仅主控写|[控制skill](<D:/src/dsh/dsh-config-pack/packages/dsh-ptc-multi-agent-mode/SKILL.md>)|
|subagent-monitor|当前会话子代理/job运行、实际路由、输出尾部、打开子会话|只能表示执行活动，不能等同业务验收或跨会话目标；可复用入口模式|[README](<D:/src/dsh/dsh-plugin-subagent-monitor/README.md#L3-L17>)|
|dsh-task-progress 0.3.0|文件上报、悬浮窗/右栏、进度CLI、job镜像|命令执行进度，不等同目标达成；保留原通道，不复制成业务百分比|[README](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/dsh-task-progress/README.zh.md#L67-L82>)|
|dsh-task-supervisor 0.1.9（README部分仍写0.1.8）|单个显式Task的DAG、审查、返工、进度、侧栏|若来源已有Task则只读投影，不能再造审批器；非全部普通历史会话都具备Task|[README](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/dsh-task-supervisor/README.zh.md#L51-L93>)|
|dsh-worktable 0.5.0|控制室卡片、项目绑定、HTML自定义窗、会话状态订阅|可作为未来可选容器，不作为必要依赖；当前CLI明确报rc.5兼容门禁未豁免，不能声称当前可用|[README](<C:/Users/wwm_1/.dsh/profiles/web/node_modules/dsh-worktable/README.md#L5-L36>)|

## 安装态观测
`dsh plugin --profile web list` 返回26个包，含上述插件与 dsh-ui-progress、dashboard。只确认包登记，不据此推断它们全部激活，也不猜后两者详细功能。worktable 警告：仅支持 0.2.0-rc.2 / 0.2.1-rc.3，当前0.2.1-rc.5，exact-version exemption未启用；本轮不绕过门禁。

## 设计约束
同一目标可跨会话；同一会话可含多个目标；worker并回所属任务。树表示归属，DAG只表示硬依赖，轨道表示推进线，三者不能混为一条边。技术工作按验收目的归类，不能仅按术语隐藏。优先独立离线HTML+skill扩展规范，不建设任务系统。
