# P0 契约验证结论

日期：2026-11-12；目标为只读数据契约验证及本地dry-run，未部署通知服务。

## 结论

P0调查与样报已完成，核心报告实现仍需补数据契约。不能直接进入生产定时发送。

| 字段 | 验证结果 | 可承诺范围 |
|---|---|---|
| 心跳/健康 | 3082、3083 GET state/overview返回200；3082 reply/history异常 | 接口可达与组件状态，不证明调度循环活跃 |
| 未完成及人工工单 | tickets支持open/person/working/idle/ended、offset/limit、next_offset；已完整读取本次open和ended页 | 权威工单分类，不把inputs数量当裁决数量；动态分页非原子 |
| 今日处理会话 | ticket关联sessionId可用，createdAt/updatedAt可见 | 缺执行事件契约，今日活动会话数未知，不能用工单更新/目录数量替代 |
| 当前模型 | 主控/关联worker的modelSelection.lastUsed可读 | 仅证明最近选择；in-flight/请求成功/回显模型未验证；metadataMtime不是模型事件发生时间 |
| recap | 部分未结束工单提供summary字段 | list摘要缺来源eventId/时间，P0不作为当前可追溯摘要；原文未导出 |
| 人工裁决 | stage=person及action字段有契约；本次未观察到person工单 | 不宣称所有业务决策为零；decisions是决策历史，不能把最近24小时37条历史都算待裁决 |
| 模型消耗 | 当前3080/3083 dashboard status均401 | usage/cost/扫描新鲜度未知；不读取凭据、不绕过认证、不启动scan |
| 覆盖 | 当前存储目录含38个worker-目录；其他941个非session-/worker-目录仅做目录计数 | 目录不是活动或可计费会话；既有dashboard源码session-过滤意味着worker遗漏，其他目录是否会话尚未核验 |

## 实际采集与变化

初次探测3082有1个未结束工单，后续快照2个：宿主仍在处理工作，说明必须保留采样时间及非原子一致性声明，不能假设多次请求同一快照。最新样报及JSON包含本次对应时间。3083的github/feishu/history处于配置关闭状态，本轮不把它们算宕机。

最近选择模型：3082主控openai-codex/gpt-6.1-sol，未完成worker可见ais-2dsglm/deepseek-flash；3083主控元数据可见deepseek-official/deepseek-flash，存在历史记录，不能称其现在正在推理。

## 可重复运行

在仓库根运行（需Python3，无新增依赖）：

```powershell
node "$env:DSH_PROGRESS_CLI" run --task superagent-health-p0 -- python scripts/superagent-health-p0.py --output-dir docs/design/superagent-health-report
```

以上命令中的进度包装由DSH提供；非DSH环境可直接运行python命令。工具只发GET、读取关联会话元数据、列两层目录并写本地脱敏报告；不包含发送函数、POST扫描、任务计划或配置修改。

检查：python scripts/superagent-health-p0-check.py。8项检查已通过：时区边界、无效日期、授权失败与零数据区分、真实空页、分页完整、分页不前进、最近选择解析、模型缺失。

端点目前作为本机P0目标固定为3082/3083，dashboard为3080/3083；进入正式实现应改为设备配置输入并锁定实例身份。相同日期重复执行会刷新同日样报；这些是最新快照，不是追加审计日志。

## 收口与下一步

主控路由实测codex-relay/gpt-6.1-sol；PTC R1选择controller-codex，本轮未派发子代理、无模型降级。沿用已完成设计的Opus5/KimiK3结论，无需再次花费双模型评审。

下一步唯一动作：补齐只读事件/报告来源适配层（执行事件、请求/响应模型、report.at与来源ID），保持dry-run，优先使六项必需字段有真实证据；dashboard作为可选模块继续隔离。

本轮没有发消息、读取凭据、修改profile、安装插件、停服或修改模型路由；不以P0完成表示六项核心采集均可直接上线。
