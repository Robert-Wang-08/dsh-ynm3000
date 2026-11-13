# Opus 5.5 设计结果（主控归档，内容摘要）

执行工具：subagent_claude_opus55_plan；子代理ID 6ae6e694-123a-4c0e-bcf2-04abd4fd2b95。执行模型自报 unverified，未将工具标签当作provider回显。完整原答保留在本会话工具结果。

## 核心设计
M6作为M3聚合后的只读投影，生成progress.json与内联数据的离线HTML，不替代Supervisor。节点包含id/level/parent/kind/title/status/basis/evidence/last_at/stale/corrections/merge/sources。parent归属、deps硬依赖、tracks排版完全分开。L1目标、L2里程碑、L3工作单元；会话是source而非节点，一个会话可分段关联多任务。技术验收本身是目标时归tech-goal，否则detail，未知标待核实。

## 三视图
- DAG：最长路径分层，两轮重心排序；聚合边带条数；外部依赖画端口，聚焦高亮上下游。
- 看板+树：左树右看板，L1泳道、M5六状态加待归并列，卡片可展开孩子；关键之外折叠为+N。
- 轨道：L1线路、L2站点，终点为验收Boss站，列车停在最后有证据闭环站。汇合只有真实硬依赖或共享里程碑；相邻不等于依赖。<=6轨全排列减交叉，仍交叉用双端换乘标记；标记超过边30%或单站入轨>3时推荐DAG。
- 三稿共用焦点/层级/选中，URL hash保存；点击或Enter下钻，面包屑上钻，右栏证据、纠正、归并理由。

## 关键任务与证据
未完成最长硬依赖链+3；下游阻塞>=2个+2；待人工/待决定且有下游+2；过期且有下游+1；本窗纠正+1。最多高亮5项，其他35%不透明。归并low不参与。
L3闭环且中强证据才记1，L2显示证据子项数，L1过里程碑数，不给伪百分比。父验收独立。证据等级沿用原skill。在办72h/待外部7天无新证据标stale不改状态；保留改口链与作废理由。
归并high=同cwd且同task_id/contract；med=关键词相同时间连续；low=仅标题相似，放待归并不计进度。跨工作区不自动归并。HTML归属修正只导出override JSON，由用户复制后下轮应用。

## 同步与预算
MVP：M3/M5→progress.json→render_progress.py→单HTML；PTC主控可在milestone message写goal/parent/dep标签。monitor二期用/loop 30m从水位读extract，写独立输出、不写账本，新增证据待主控确认；前置无损游标解析。worktable嵌入等兼容解决。
模板<=1500行/80KB；renderer<=200行；SKILL增量<=120行；无第三方依赖。单文件<=12个L1/60个L2/300个L3。

## 验收与限制
同数据三视图、L1/L2/L3双向钻取、伪汇合0、非平面降级、关键<=5、过期/自报/纠正/low可见、离线不联网、override回环。只读设计，无文件改动。示例建议3目标9里程碑16单元，含跨目标依赖压力案例。

## Receipt验收
worker返回validation为object，不符合schema要求的string[]。主控将原始项目逐条转为字符串后入账，保留此缺陷说明，不声称原receipt直接通过。model=unverified，executor按真实调用工具登记，provider回显待核实。
