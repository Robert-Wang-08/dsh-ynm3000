# dsh-hang-forensics — dsh web 卡死取证工具包

针对「dsh web 整页无响应、Ctrl+C 退不掉、只能重启」这一故障的取证与判读工具。
**本工具包只采集证据，永不自动重启或杀进程**——止血动作始终由人执行。

---

## 一、故障画像与已确认事实（2026-10-20）

**症状**：web 页面整页卡死（点击无反应、刷新连不上）；Windows Terminal 里 `Ctrl+C` 无法退出 `dsh web`；
只能关掉终端/杀进程，重启服务后恢复。

**从会话日志与系统状态能确认的事**：

| 结论 | 证据 |
| --- | --- |
| 是后端问题，不是前端问题 | 整页连不上 + 服务端 HTTP 无应答 |
| 进程是"活着但不干活"，不是崩溃 | `Ctrl+C` 无效（SIGINT 处理要回主线程才能执行）+ 无 BugCheck/无 WER/无 node dump |
| 两次故障时点：约 **13:42–13:43** 与 **14:19–14:22** | 两次都有多个会话的回合被同时标记 `interrupted`；`08abec00`、logseq `turn 20` 的回合直接悬空未闭合 |
| 两次的最后一条痕迹都是被截断的 projcache 写入 | 全库仅有两个 `.tmp` 残留：13:43:42 的 63 KB、14:28:58 的 0 字节；此后 20+ 分钟零写入 |
| 定性：资源饥饿（交换风暴）而非 JS 死循环 | 详见 [ANALYSIS-20261020.md](ANALYSIS-20261020.md)；机器只有约 16 GB 物理内存 + 27 GB 页面文件 |
| 现场已消失 | 当前实例 PID 起于 14:39:03；系统 14:34 重启，故障时点的进程状态未留存 |

**当时的环境压力**：16 逻辑核、约 16 GB 物理内存；5 个会话并行写盘；故障前 46 秒内派发 7 个
PTC worker；常态提交内存已达 18.7～19.4 GiB（超出物理内存，靠页面文件扛）。

**为什么现在补埋点**：主线程的 JS 调用栈/CPU 热点、以及故障瞬间的内存读数，是区分"内存饥饿"
与"I/O 卡死"的唯一直接证据，而普通 `dsh web` 不开放这层信息。下面第 4 节的启动方式把这条路打通。

---

## 二、根因分析

两次故障的完整证据链与处置建议见 **[ANALYSIS-20261020.md](ANALYSIS-20261020.md)**。一句话版本：
PTC 批量派发（46 秒内 7 个 worker）+ 4~5 个大会话把这台 **16 GB 内存**的机器顶进交换；
宿主进程被饿死 → 写不动盘、退不出、页面连不上。火绒/腾讯管家的文件过滤驱动、C: 盘 95% 满、
libuv 只有 4 个线程池线程，是三个放大器。

## 三、文件

| 文件 | 作用 |
| --- | --- |
| `Capture-Hang.ps1` | **一键取证**：探活、进程指标、CPU 采样、内存计数器、端口状态、进程树、活动会话尾巴、inspector 取证（可选 + minidump），落 `summary.md` |
| `Watch-DshWeb.ps1` | **只观察看门狗**：定期探活，连续失败即自动取证，不重启 |
| `Start-DshWeb-Inspect.ps1` | **带 `--inspect` 的启动包装**：解决"下次卡死拿不到 JS 栈"，并把控制台输出落文件 |
| `lib/cdp-profile.mjs` | 通过 CDP 采样卡死进程的 CPU profile，输出热点函数 Top 30 |
| `lib/session-tails.mjs` | 解码多帧 zstd 会话日志，列出最近活动会话、未闭合回合、最后几步动作 |
| `lib/window.mjs` | 复放某会话在指定时间窗的事件（卡死前主线程在忙什么） |
| `lib/bench-blockers.mjs` | 量化同/异步走树、大会话解码的可冻结时长 |
| `lib/bench-fsync.mjs` | 量化 open+write+fsync+rename 的磁盘延迟分布 |

---

## 四、推荐工作流

### 1. 下次重启时换成留痕的启动方式（一次性动作，你决定时机）

```powershell
# 1) 若旧实例还活着且已卡死：先取证
pwsh -File .\Capture-Hang.ps1

# 2) 止血（Ctrl+C 无效时这是唯一路径）
Stop-Process -Id <PID> -Force

# 3) 用带 inspector 的方式启动（等价于 dsh web --profile web，多了留痕）
pwsh -File .\Start-DshWeb-Inspect.ps1
```

先 `-DryRun` 可以看到它到底会执行什么：

```powershell
pwsh -File .\Start-DshWeb-Inspect.ps1 -DryRun
```

### 2. 再开一个窗口常驻观察（可选，但强烈建议）

```powershell
pwsh -File .\Watch-DshWeb.ps1
```

它每 15 秒探一次活；连续 3 次拿不到任何 HTTP 响应就自动跑一次 `Capture-Hang.ps1`，
打印醒目告警后继续观察（一次卡死只取一份证据，不会刷屏）。**它不会重启服务。**

### 3. 下次卡死时看什么

```text
%USERPROFILE%\.dsh\logs\hang-<时间戳>\summary.md        ← 一页结论，先看这个
%USERPROFILE%\.dsh\logs\hang-<时间戳>\inspector\cpu-profile-top.txt   ← 凶手函数（需 --inspect 启动）
%USERPROFILE%\.dsh\logs\hang-<时间戳>\active-sessions.txt              ← 当时哪个会话在飞
```

---

## 五、判读表

| 探活 | 进程 CPU（单核%） | 判读 | 下一步 |
| --- | --- | --- | --- |
| 无响应（timeout） | ≥ 60% | 主线程**同步忙等**：死循环、超大同步循环、大对象同步解析 | 看 `cpu-profile-top.txt` 的第一个非 `(idle)/(program)` 帧，即嫌疑插件 |
| 无响应（timeout） | < 20% | 主线程阻塞在**非 CPU 路径**：同步 I/O、锁竞争、GC、`await` 悬挂 | 重点查文件监视类插件与 `patchReload: live`；需要 JS 栈才能进一步定 |
| 无响应（refused） | — | 进程已不在（可能是被 OOM/系统杀掉） | 查事件查看器与 `CrashDumps` |
| HTTP 200/401 | 任意 | 服务活着（401 = 需要 token，属正常） | 不是本类故障，往单回合/模型流方向查 |

补充判据：`Ctrl+C` 无效本身就是"主线程被同步段占住"的直接指纹，与上表第一/第二行互证。

---

## 六、开销与安全边界

- `--inspect=127.0.0.1:<port>` 只绑回环地址，外部不可达；**没有调试器连接时开销可忽略**。
- **但 inspector 等价于"能在宿主机上执行任意代码"**：只在本机、只在排障期开着，用完就换回普通启动。
- CPU profile 采样 1ms 间隔、窗口 5 秒，对卡死进程无副作用（它本来就不干活）。
- `-WithDump` 才会生成 minidump 与堆快照，体积大（几十 MB 到 GB），非必要别开；
  minidump 依赖管理员权限，失败属预期。
- 所有脚本对每一项都做了独立 try/catch：单项取不到（权限/沙箱）只降级记录，不中断整体取证。
- **访问令牌脱敏**：`dsh web` 启动时会把 `http://127.0.0.1:3080/?token=<凭据>` 打到 stdout，
  该令牌足以驱动你本机的 GUI。`Start-DshWeb-Inspect.ps1` 落盘前会把 `token=` 之后的值替换成
  `***REDACTED***`；但仍然**不要把终端输出、截图、日志原样贴进工单或聊天**。

### 附：本机两个容易被误判的启动项

- `[dsh-permission-compat] redundant escalation normalized: …` —— 这个**不是插件**。
  `D:\src\dsh\dsh-permission-compat` 的 `package.json` 里是 `apply / verify / revert`
  三个脚本（`tools/*.mjs`），它改的是 DSH 安装本体。所以「web profile 依赖里没有它」是对的，
  但**补丁确实生效了**。后果：升级 DSH 后必须重新 `apply`（`dsh-upgrade.ps1` 里已有这一步），
  否则权限归一化行为会静默变化。
- 同一份 profile patch 里给 `subagent-claude-code` / `subagent-codex` 设了
  `bypassPermissions` / `dangerously-bypass-approvals-and-sandbox` —— 这两个外部子代理是**不沙箱**运行的。
  排查卡死时它们既是最重的负载，也是最不受约束的进程。

---

## 七、已知局限

1. **只有换成 `Start-DshWeb-Inspect.ps1` 启动之后**，下一次卡死才能拿到 JS 热点函数；
   在那之前，工具只能给出"忙等 vs 阻塞"这一层判别。
2. 在 DSH 沙箱内运行 `Capture-Hang.ps1` 时，部分进程字段（私有内存/线程数/句柄数）会被隐藏为 0，
   进程树也取不到；在普通 Windows Terminal 里运行则是完整数据。
3. 取证是"现场快照"，不做时间序列；若要追内存增长趋势，需要另配周期采样。

