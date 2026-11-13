# Kimi K3 独立挑战报告（route=docs-kimi）

task_id=task-session-progress-20261102-adb5f8f7；subtask_id=kimi-challenge。
方法：静态审查 contract / inventory / opus-design / controller-challenge / interaction-spec / prototype.html；未运行 prototype，未读私人会话。以下每条给严重度、反例、最小修正、处置。

## 八项挑战

**C1 最长链被偷换为关键路径（高）**。Opus 以「未完成最长硬依赖链+3」作关键任务主信号。反例：6 跳链每跳 10 分钟得分高于 2 跳但含 14 天外部等待的验收门——拓扑深度不等于时间与风险。最小修正：改名「最深未完成链」，外部等待/截止日期单列权重；UI 标注「拓扑排序，非工期关键路径」。处置：保留信号、修名修权重，一期做。

**C2 六状态混淆验收态与等待原因（高）**。M5 六状态中「待人工/待决定」与「待上游/待外部」混在同一维度；两者下一步动作主体完全不同（用户拍板 vs 什么都不用做）。反例：等微信 HITL 回复与等上游任务闭环同标一色，用户无法 30 秒识别「该我动」。prototype 也只有 4 态，与设计六态已不一致。最小修正：status（验收生命周期）与 blocker_type（none/upstream/human/external）拆成两个正交属性，分两行渲染。处置：保留六态、补 blocker 维度，一期做。

**C3 轨道汇合按轨画线而非按真实依赖（高）**。Opus 自订「汇合只有真实硬依赖」，但 prototype `renderRail` 对每条 lane 无条件画曲线汇入 gate，与 lane 内是否有节点在 gate.deps 无关——这正是它声称杜绝的伪汇合。反例：deliver 线全部 done 且无 dep 入 gate，视觉上仍「汇合验收」。最小修正：汇合曲线只对「lane 内含 gate.deps 端点」的轨道绘制；其余轨道终点画截止符。处置：保留轨道稿、修汇合逻辑，一期做（属语义正确性，非美化）。

**C4 跨层边在下钻后消失（中高）**。设计承诺「外部依赖画端口」，但 prototype `renderDag` 对焦点外 dep 直接 `continue` 丢弃。反例：focus=recover 时 release→recover 的反向被依赖不可见，用户在 recover 内看不到「关上我会卡住总验收」。最小修正：当前层渲染时，焦点外上下游各画一个计数端口（「外部上游 N / 下游 M」），点击列出边 id。处置：一期做；主控约束#8 的出口计数已要求此事，设计稿未落实。

**C5 自报证据可闭环销项（中高）**。「L3 闭环且中强证据才记1」未规定证据出处；extract 摘要截断 500/1200 字，子代理退出 0 或助手尾部「已完成」措辞可能被评中强。主控#7 已警告监控器不当裁判，但 Opus 数据模型 evidence 字段无 origin。最小修正：evidence 必带 origin（human/tool/self-report），self-report 永不自动销项，置「待确认」。处置：一期做，成本仅一个枚举字段。

**C6 归并 med 规则会误合并（中）**。med=关键词相同+时间连续自动归并。反例：上午聊 config-pack 回滚、下午聊 failover 回滚，关键词与时间连续均满足，实为两目标。最小修正：仅 high（同 cwd 且同 task_id/contract）自动归并；med 降级进待归并；override JSON 增「拆分」操作而非仅改归属。处置：保留 high、med 降级，一期做。

**C7 1500 行/80KB 对 MVP 过重（中）**。模板 1500 行 vs renderer 仅 200 行的不对称，说明三视图全进一期的概率高；300 个 L3 × 证据串 ≈ 75KB，已顶格 80KB。最小修正：一期只做 B（看板+列表，交互稿自定为默认稿）+ 钻取 + 证据栏 + override 导出，预算 600 行；A/C 用同一 progress.json 契约二期补。处置：删减一期范围，A/C 明确二期。

**C8 monitor 的无损游标解析过早（中）**。inventory 已证实现有 extract 是整文件解压+截断 digest；「前置无损游标解析」是新子系统。在「用户是否需要 30 分钟水位刷新」未验证前就立项，违反增量原则。最小修正：monitor v0 用整文件 extract + 变更哈希去重，低频跑；无损游标解析推迟到有实测触发条件（单文件 >50MB 或轮询成本超标）。处置：二期再评估，解析器本身三期。

## 对主控的两点挑战

- 主控#8「≤4 轨」与 Opus「≤6 轨」直接矛盾，方案文档必须裁决一个数；我建议 ≤4，因 C3 修正后轨道越多伪汇合面越大。
- 主控#9「按已解码 event id/seq 去重」预设了尚不存在的逐事件解码能力（见 C8），应改写为「按变更文件哈希去重」。

## prototype.html 静态观察（未运行）

除 C3/C4 外：键盘 Enter 只选中不下钻，与 interaction-spec「点击或 Enter 下钻」不符；stateNames 仅 4 态与六态模型脱节（见 C2）；`?selftest` 自检覆盖钻取与不可变性，值得保留进一期验收。

## 最小实施范围与验收

一期 = progress.json 契约（含 evidence.origin、blocker_type、外部端口计数）+ B 视图 + 钻取/面包屑 + 证据栏 + override 导出（含拆分）；A/C、monitor、worktable 全部二期后。验收改为可测口径：伪汇合=「无 dep 依据的汇合曲线条数=0」且每条曲线可点击列出 dep id；跨层边=「焦点外依赖计数与实际边数一致」；自报=「self-report 证据的节点不可能显示已验收」。以上均可静态断言，不依赖运行环境。
