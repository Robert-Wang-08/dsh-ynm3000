---
name: new-session
description: 在 DSH 会话中创建独立顶层会话（不是子代理）。触发词："开个新会话"、"新建会话"、"另起一个会话"、"开个干净的会话"、"start a new session"、"new session"。依赖 dsh-plugin-new-session 提供的 new_session 工具。
origin: self
author: wang
created: 2026-10-20
updated: 2026-10-20
version: 0.2.0
managed-by: skillhub
source: skillhub
asset-type: skill
---

# new-session — 用一句话开独立会话

## 何时用

用户想**离开当前这轮上下文**、开一段干净或并行的对话时：

- 「开个新会话，专门查 X」
- 「另起一个会话做 Y，别污染这里」
- 「新建会话，标题叫 Z」

不适用：

- 用户只是要一个**有界子任务**、结果必须回到本会话 → 用 `subagent_*`；
- 用户要「临时聊两句、关闭即消失」→ 那类一次性会话属于 ephemeral 方案，不是本技能。

## 动作

调用 `new_session` 工具，把用户意图映射成参数：

| 用户说了什么 | 传什么 |
| --- | --- |
| 指定了用途/标题 | `title`（短标题，便于侧边栏辨认） |
| 给了要立即开始的任务 | `firstMessage`（原样作为首条用户消息） |
| 要放到**别的项目/目录** | `cwd`（绝对路径）；不说就不要传 |
| 指定了预设 | `agentPreset` |
| 只想建会话、不想立刻发消息 | 省略 `firstMessage` |

**工作区**：不传 `cwd` 时，新会话自动加入**当前会话所在的工作区**（GUI 侧边栏同一目录分组）。
只有用户明确说「放到 X 项目」「换个目录」时才传 `cwd`。

范例：

```text
用户：开个新会话，标题「插件清单核对」，让它先查一下 web profile 装了哪些插件。
调用：new_session({
  title: "插件清单核对",
  firstMessage: "查一下 DSH web profile 当前登记了哪些插件，按 bundles 顺序列出。"
})
```

## 返回后怎么回话

拿到 `sessionId` 后，用一句话告诉用户：会话已建、标题、所在**工作区**、是否已发出首条消息，
并说明**需要到 GUI 侧边栏点击该会话**才能看到（插件不会切换浏览器当前页面）。
如果返回里没有 `workspaceId`，说明当前会话没挂在任何工作区上，新会话只共享了目录。

## 失败处理

| 现象 | 处置 |
| --- | --- |
| 工具不存在（`new_session` 不在工具表） | 说明 `dsh-plugin-new-session` 未登记或**当前会话早于插件加载**；提示改用 GUI 新建会话，或重启 DSH 后新开会话再试 |
| 返回 `prompted: false` 且 warning 含 `session/model-unavailable` | 会话已建好，只是新会话还没可用模型；请用户进 GUI 选模型后再发消息 |
| 抛「会话已创建（session-…），但首条消息发送失败：…」 | 会话**已经建好**，是发消息这一步真故障；把 sessionId 与错误码原样转述，不要重试刷屏 |
| 返回 warning 含标题设置失败 | 会话已建好，标题未生效；可在 GUI 里重命名 |
| 直接抛「创建会话失败」 | 原样转述错误码，不要重试刷屏 |

## 注意

- `new_session` 创建的是**顶层会话**，新会话里没有本会话的历史；不要把需要本会话上下文的
  任务丢过去，除非用户明确要求「全新上下文」。
- 一次用户请求只调用一次；不要为了「更保险」重复创建。
