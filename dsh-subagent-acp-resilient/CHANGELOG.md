# 版本变更记录

## 0.2.2 - 2026-10-22

**把上游失败原因透传到调用方（诊断可用性修复）。**

此前适配器只输出固定 facts（`stage` / `category` / `exit code`），原始失败原因仅挂在 `Error.cause`
链上、从不渲染。后果：上游返回 `HTTP 403 预扣费额度失败（余额不足）` 时，调用方只看到
`category: invalid-result`，无法判断"为什么失败"，只能绕过适配器用 CLI 直测才查得到根因。

改动：

- 新增 `causeDetail(cause)`：从 `Error` / `AggregateError` / `cause` 链提取文本，去重、压成单行、上限 2000 字符。
- 新增 `withCauseDetail(facts, cause)`：把明细挂到 `facts.detail`。
- `failureDiagnostic(facts)`：存在明细时追加一行 `cause: <明细>`；服务层仍按其 4096 字节上限二次截断。
- `AcpRunFailure` 构造器合并明细；`diagnosticText(facts, permission, cause)` 接受 cause；进程退出与 catch 路径把 error 明细带进诊断。

边界：只透传错误文本（上游错误文本本身不含密钥），不涉及请求体；「错误原因不进产品 logger」的既有断言仍然通过。

验证：`test/resilience.test.mjs` 11/11 通过；DSH 侧另有用例直接加载安装产物，确认 403 原文上抛、成功路径不受影响、明细长度受控。

兼容性：无配置变更、无新增环境变量；`diagnostic` 语义不变（固定行之后多一行 `cause:`）。

## 0.2.1

修正类型声明的 `name` 与运行时一致，补安装与发布说明。

## 0.2.0

首个可用版本：分级超时阶梯、动态活动检测、结果回传、超时后保护成果、非阻塞调度。
