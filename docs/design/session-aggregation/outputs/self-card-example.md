# 本设计任务的洞察/任务登记卡（示例）

> 这张卡是“如果登记表已经可用，本次设计任务会被登记成什么样”的示例，不是已生成的真实登记项。状态为 `in_review`，等待用户裁决。

```yaml
id: T-DESIGN-SESSION-AGGREGATION
title: 细化多 Agent 会话的洞察任务聚合与追踪（Focus Hub 式）
status: in_review
project: C:\Users\wwm_1\.dsh\state\superagent\work\session-aggregation-design-da9baec1170c
sources:
  - feishu:oc_eae25b93a93612f82042deb68704e2af:om_x100b606803f770a8b089054195f711c
  - dsh:worker-da9baec1170cd5b78589165bb3ae8d56
updatedAt: 2026-11-12T22:00:00+08:00
confidence: high
```

## 目标

- 细化“自动读取多 Agent 会话 → 识别任务/洞察 → 按任务聚合 → 更新进度 → 登记到统一登记表 → 去重与提升”的方案，先设计不实现。来源：飞书原话与 2026-11-12 补充。
- 验收：七节齐全；每个关键结论有实测或挑战依据；给出 MVP、裁决项和待验证项。

## 方案

- 采用“只读适配器 → 统一事件 → 洞察/任务聚合 → 追加式登记账本 → 可重建投影”的方案，并对齐 Focus Hub 的对象/阶段/执行门。
- 备选“单一全能 Agent 每轮重读全部历史”被否决：不可审计、成本高、无法处理身份与验收权；备选“独立第五个视图”被否决：重复建设，优先作为 Focus Hub 摄取适配器。
- 备选“直接双写 taskboard/PTC”被否决：制造第二真相，违反同一事实单一写权威。

## 成果物

- `design-v1.0.md`（本文）— state=proposed，待用户评审。
- `evidence/source-inventory.md`（5 来源实测盘点）— state=verified（本机只读探测）。
- `astra-design-v0.1.md`（6astra 设计稿）— state=verified（模型回执可查）。
- `opus5-challenge.md` / `kimi-k3-challenge.md` — state=verified（模型回执可查）。
- `adjudication.md`（主控裁决）— state=proposed，待用户确认。

## 裁决

- **用户已确认（2026-11-13）**：D1 模式 B——已映射任务只读上游；未映射任务有登记权威（非执行/验收）；不写回。
- 设计默认：P1 复用 DSH + 全 workspace；P2 接 Codex/Claude + V2 洞察；P3 接 Cursor/OpenCode。状态：待用户确认（D2）。
- 设计默认：`done` 仅人工/上游权威；工具证据最高到 `verified`；洞察阅读不审批、执行才确认。状态：待用户确认（D4/D18）。
- 设计建议：Focus Hub 按“同一产品、两个组件”合并（D17/D21）；复用 `dsh-source/flow-runner/analysis-adapter`（D22）；V2 元数据先增量写 `derived_from`（D23）；全局摄取独立 cursor（D24）。

## 洞察

- 会话不是任务；洞察/任务身份、证据裁决、验收/执行权、改进闭环是真难点，解析不是。
- **Focus Hub 已有可运行的 DSH 摄取/对象/分析/建议箱**（325+19 测试、216 活跃对象/28 会话/95 创建/17 活跃洞察）；本项目应复用而不是重写。
- 四个来源已有结构化任务痕迹；LLM 应补盲而非从零理解；摘要≠洞察，去重看“主张+条件+结果”。
- 只读聚合 + 人工裁决比自动写回更可持续；跨 Agent 去重先看产物。

## 总体计划

- P0 复用核对/契约 + 1MiB 首帧修复（4–6 人日）→ P1 DSH 全 workspace + 复用主链（8–12）→ P2 Codex/Claude + V2 洞察/去重（15–20）→ P3 Cursor/OpenCode + 提升闭环（10–15）→ P4 可选写回提议。
- 当前阶段：设计评审（P0 前），下一步是用户裁决 D2–D24。
- Focus Hub 合并：L1 产品层（工作台 + 适配器）→ L2 仓库/启动链路 → L3 单进程（暂不做）。

## 待办

- [ ] 用户确认第十三节 D2–D24（重点 D2/D4/D17/D18/D21/D22/D24）。
- [ ] 做 Cursor 根 blob 解密/导出 spike。
- [ ] 验证 Focus Hub `dsh-source` 对 28 会话/50 cursor 的只读重放；不重写解码。
- [ ] 测 `/api/dsh/workspaces` + 3–5 个 workspace 的扫描耗时/覆盖；独立 ingest cursor 不污染真实任务。
- [ ] 构造 30 个会话的任务身份金标，再扩到 50 任务/200 段 + 100 对硬负例。
- [ ] P0 修 `dsh-source.firstFrameText` 1MiB 上限（191/1,384 长会话失败；流式预览已 191/191，待应用补丁+回归）；验证 suggestions/objects/tasks API；V2 元数据兼容 95 创建/17 活跃旧洞察。

## 证据与来源

- 飞书原始消息：`om_x100b606803f770a8b089054195f711c`（2026-11-12 13:53 UTC）。
- DSH 会话：`worker-da9baec1170cd5b78589165bb3ae8d56`。
- 实测盘点：`evidence/source-inventory.md`；Focus Hub 实现核对：`outputs/focus-hub-audit.md`（325+19 测试、216 活跃对象/28 会话/95 创建/17 活跃洞察/16 任务）。
