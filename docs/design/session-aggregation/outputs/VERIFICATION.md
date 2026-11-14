# 设计包自检（2026-11-13，v1.2）

> 范围：只检查设计交付物的一致性、可回链与自述边界；**没有实现、没有部署、没有修改任何 Agent 的源存储**。本文件不替代用户评审。

## 1. 交付物

| 文件 | 作用 | 状态 |
|---|---|---|
| `outputs/design-v1.0.md`（内容 v1.2） | 设计正文：目标/架构/适配器/洞察/任务/进度/登记表/自动化/隐私/边界/分期/裁决/洞察模型/Focus Hub 集成 | 已自检 |
| `outputs/focus-hub-audit.md` | Focus Hub 既有设计与已实现内容核对（模块/API/数据/测试/接缝/未实现） | 已核实 |
| `outputs/adjudication.md` | 6astra、Opus 5、Kimi K3 挑战的逐条裁决 | 已自检 |
| `outputs/astra-design-v0.1.md` | 6astra 主设计稿 | 已归档 |
| `outputs/opus5-challenge.md` | Opus 5 独立挑战（v1.0 设计） | 已归档 |
| `outputs/kimi-k3-challenge.md` | Kimi K3 独立挑战（v1.0 设计） | 已归档 |
| `evidence/source-inventory.md` | 5 个来源的本机实测盘点 | 已核实 |
| `outputs/self-card-example.md` | 本设计任务的七节登记卡示例 | 示例，非真实登记 |
| `outputs/receipts/*.json` | 模型/提示词/输出哈希与用量 | 3 份 |

## 2. 机器检查

- **本地链接**：28 个 Markdown 相对链接全部可解析（0 missing；最终计数见第 7 节）。
- **模型输出**：3 份非空（6astra 11,126 字；Opus 9,968 字；Kimi 6,366 字）；回执含 prompt/output sha256 与 usage。
- **来源盘点**：DSH 1,424 会话、Codex 235 活跃 + 25 归档、Claude 54 主会话、Cursor 114 转录、OpenCode 302 会话/10,313 消息/43,028 parts/218 todos；与探测脚本输出一致。
- **Focus Hub 实现核对**：`node --test mvp/test/*.test.mjs` **325/325**；`node mvp/tests/server-regression.mjs` **19/19**；当前 216 活跃对象/28 SESSION（均有 cursors）/95 创建/17 活跃洞察/2 rules/16 任务/6 项目/20 建议（9 采纳/11 驳回）/58 关联/1 acceptance/1 stage override；与只读统计一致。
- **P0 新发现（2026-11-13）**：`dsh-source.firstFrameText` 对 >1MiB 文件只取 1MiB 解首帧；1,384 个 v4 文件中 191 个 ≥1MiB，191/191 全部 `zstd-decode`；完整 buffer 可正常解。**当前 325+19 测试未覆盖此夹具；修复预览（流式 header）已 191/191 通过，但补丁未应用到 Focus Hub。**
- **只读探测**：`probe*.py` 对 DSH/Codex/Claude/Cursor/OpenCode 使用只读文件/`mode=ro`；Focus Hub 核对只读文件/测试临时目录；未执行源写入。

## 3. 结构检查

- 设计含：第〇节 v1.2 核对、〇.1 需求收敛、一至十六节、附录；七节登记卡示例；D1–D24 裁决表；待验证清单。
- 来源-结论对应：Cursor 加密根 blob → transcript-only/unsupported；DSH 多帧 → **复用 `dsh-source` 逐帧**（不是自写/CLI）；OpenCode WAL → 只读/在线备份；Claude 子代理 → 待验证去重；Codex 归档 → 待验证完整性；Focus Hub V2 → 仅设计，不是已实现。
- 无“已自动完成/已部署”的表述；所有“已支持”以实测盘点与 Focus Hub 实现核对为限。

## 4. 自检发现并已修正

1. 设计早期遗漏 `## 七、统一登记表`、`## 九、隐私、安全与不可信输入`、`## 六、进度、证据与验收` 三个标题（编辑时误替换），已补。
2. D1–D10 与新增 D17–D24 的引用不一致，已统一为 D1–D24。
3. 任务卡示例仍是 v1.0 口径，已改为 v1.2（洞察/Focus Hub/DSH 复用）。
4. Opus 非流式请求两次 524，改用流式客户端；首次流式输出被 ISO-8859-1 误解码，已改为 UTF-8 并重跑。
5. **v1.2 核对修正**：v1.1 误以为 DSH 多帧需自写/CLI；实际 Focus Hub `dsh-source` 已逐帧实现（19 测试）。v1.1 误以为 Focus Hub 只有对象模型；实际已有完整对象/建议/任务/验收 API 与 344 项测试。v1.1 误以为 V2 洞察已可用；实际是设计/离线评测。

## 5. 未验证/未完成（不要当成已完成）

- 模型挑战基于 **v1.0 通用任务登记**；v1.1/v1.2 的洞察专项（洞察去重、新颖性、执行门、改进闭环）由主控按 Focus Hub V2 设计与既有裁决补审，**不是模型已评审**。
- Focus Hub V2 洞察未实现；多源（Codex/Claude/Cursor/OpenCode）、全 workspace 摄取、跨源 dedupe、V2 元数据兼容均未实现/未验证。
- **已定位的 P0 阻断**：`dsh-source.firstFrameText` 1MiB 上限导致 191/1,384 长会话失败；修好前不能宣称 DSH 覆盖完整。
- Cursor 根 blob 解密、Claude 子代理去重、Codex 归档完整性、OpenCode 时间水位、Focus Hub 多进程/7801 双端边界：仍是待验证项。
- 没有实现代码、没有原型、没有真实任务卡、没有安装/部署。
- 没有提交或推送 git；本副本在 `D:\src\dsh\docs\design\session-aggregation\`，工作副本在 ticket 目录。

## 6. 下一动作

1. 用户已确认 **D1 模式 B**（2026-11-13）；其余 D2/D4/D17/D21/D22/D24 待裁决。
2. P0 复用验证：先修 `firstFrameText` 1MiB 首帧并加 >1MiB 回归；再跑 `dsh-source` 只读重放、`/api/dsh/workspaces` + 3–5 workspace benchmark、Focus Hub 325+19 回归、V2 元数据兼容 95 创建/17 活跃旧洞察。
3. P0 产出 companion 契约（suggestions/objects/tasks/acceptance）与独立 ingest cursor；通过后再进入 P1（DSH 全 workspace + 复用主链）。

## 7. 最终链接检查

28 个 Markdown 相对链接，0 missing（2026-11-13 本机检查；设计/审计/裁决/盘点/回执）。
