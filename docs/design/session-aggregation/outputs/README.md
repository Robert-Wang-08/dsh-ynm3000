# 阅读顺序：多 Agent 会话的洞察任务聚合与追踪（Focus Hub 式）

> 2026-11-12 · 设计交付，未实现。v1.2 已按 2026-11-13 的 Focus Hub 实现核对更新：复用 Focus Hub 已有 DSH 摄取/对象/分析/建议箱，本项目做多源 + V2 洞察 + 全局摄取。本副本目录：`D:\src\dsh\docs\design\session-aggregation\outputs\`；工作副本：`C:\Users\wwm_1\.dsh\state\superagent\work\session-aggregation-design-da9baec1170c\outputs\`。

## 先读哪一篇

1. **[design-v1.0.md](design-v1.0.md)** — 最终设计（文件名沿用 v1.0，内容已是 v1.2）。先看第〇节 v1.2 实现核对、第一节结论、第十六节集成契约；再看第十三节 D1–D24 与第十一节分期。
2. **[focus-hub-audit.md](focus-hub-audit.md)** — Focus Hub 既有设计与已实现内容核对：模块/API/数据/测试/接缝/未实现项。
3. **[adjudication.md](adjudication.md)** — 主控对 6astra/Opus/Kimi 挑战的逐条裁决；想知道“为什么这样定”看这里。
4. **[source-inventory.md](../evidence/source-inventory.md)** — 本机 5 个来源的实测路径/格式/规模/风险；所有“已支持/未验证”的依据。
5. **[VERIFICATION.md](VERIFICATION.md)** — 自检：链接、模型回执、未验证项与下一动作。
6. **[self-card-example.md](self-card-example.md)** — 如果登记表已经可用，本次设计任务会是什么样的一张七节卡。

## 过程稿（按时间）

| 文件 | 内容 | 状态 |
|---|---|---|
| [astra-design-v0.1.md](astra-design-v0.1.md) | 6astra 主设计稿（11,126 字） | 已归档，非最终 |
| [kimi-k3-challenge.md](kimi-k3-challenge.md) | Kimi K3 独立挑战（10 条） | 已归档 |
| [opus5-challenge.md](opus5-challenge.md) | Opus 5 独立挑战（v1.0 设计；流式补跑成功） | 已归档 |
| [focus-hub-audit.md](focus-hub-audit.md) | Focus Hub 既有设计与已实现内容核对（325+19 测试、当前数据、接缝、未实现项） | 2026-11-13 |
| [receipts/](receipts/) | 模型/提示词/输出哈希与用量回执 | 已生成/补齐中 |

## 一句话结论

这不是“解析聊天记录”的项目，而是“洞察/任务身份 + 证据裁决 + 验收/执行权 + 改进闭环”的项目。建议先做 **复用 Focus Hub 的 DSH 全 workspace 摄取 + 建议/对象** 的 P0/P1（约 12–18 人日），验证 SESSION 去重/游标/建议不污染真实任务后，再接 Codex/Claude 与 V2 洞察，最后 Cursor/OpenCode。

## 需要你拍板的事

- **D1 已确认（2026-11-13）**：模式 B——已映射任务只读上游，未映射任务有登记权威（非执行/验收），不写回。
- 其余 D2–D24：首期来源、模型位置/外发、`done` 判定、存储、UI、粒度、Cursor、保留期、调度、自动关联、写回、部署、任务 ID、回填、Focus Hub 集成（D17）、洞察执行门（D18）、SOP 升级（D19）、权威冲突（D20）、合并形态（D21）、DSH 复用（D22）、V2 元数据（D23）、全局摄取游标（D24）。
- 如果只回答三个：**D2（首期只做 DSH 是否接受）、D4（完成是否必须人工/上游确认）、D17+D21（是否按“同一产品、两个组件”并入 Focus Hub）**。

## Focus Hub 合并结论

**能合并，建议按“同一产品、两个组件”合并**：Focus Hub 是工作台/对象/任务/阶段/验收权威；本项目是它的会话摄取与洞察提炼适配器，通过对象 API/outbox 提交，不直接改 `objects.jsonl`。P0 先修 `firstFrameText` 1MiB 首帧、验证对象/建议 API 与 `dsh-source` 复用；P1 后把 adapter 作为 Focus Hub 仓库内的模块（L2）；单进程/单存储合并（L3）暂不做。详见设计 15.7.1/16。

## 边界声明

- 本设计没有实现、没有部署、没有修改任何 Agent 的源存储；探测脚本只读。
- Cursor 完整还原、DSH compaction、Claude 子代理去重、Codex 归档完整性仍未验证，文中已逐项标注。
- 模型回执只能证明“调用返回了非空输出”，不证明模型身份由 provider 独立背书。
- Focus Hub 集成是方案 A，不是已实现；本次只读核对了 325+19 测试、216 活跃对象/28 会话/95 创建/17 活跃洞察/16 任务；全 workspace、V2 元数据、多源 dedupe 仍需 P0 验证。
- **P0 新发现**：`dsh-source.firstFrameText` 只取 1MiB 解首帧，1,384 个 v4 文件中 191 个 ≥1MiB，191/191 失败；修复预览用流式 header 已 **191/191** 通过，但补丁尚未应用到 Focus Hub。
- P0 修复预览：`evidence/fix-preview/firstframe-1mib.patch` + `verify.mjs`（未应用；应用前需补回归/测试）。

