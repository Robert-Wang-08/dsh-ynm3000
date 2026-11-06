# Windows 上 env.exe：根因、处置与回滚

- 日期：2026-11-06
- 根任务：task-20261106T065318245305Z-58c366332c6f
- 目标：解释并修正 nvm4w 目录中 Git/MSYS env.exe 的不可用问题；不改 nvm4w 其它文件，不中断 HITL/app2 与 3082/app3。

## 1. 结论

原先复制过去的 GNU env.exe 漏了传递依赖：msys-intl-8.dll 还导入 msys-iconv-2.dll。只补 msys-2.0.dll、msys-intl-8.dll 仍缺第三份 DLL，因此是 Windows 加载器的 0xC0000135，而非必须安装在 Git prefix 中。

**不把 env.exe 放回 C:\nvm4w\nodejs 是正确的默认处置。** 它是 Git for Windows 的 GNU/MSYS 工具，不是 Node/nvm4w 的运行时组件。当前需求直接使用 Git 完整安装中的 env.exe，用户级 PATH 已有 Git usr/bin，无需再复制或改注册表。

两个不同故障不要混为一谈：

| 表现 | 阶段 | 处理 |
| --- | --- | --- |
| 0xC0000135 (-1073741515) | Windows PE 加载，main 之前 | 补齐传递依赖，或直接使用 Git 原位置 |
| env: 'env': No such file or directory，exit 127 | 外层 env 已运行，找不到内层命令 | 检查传给外层 env 的 PATH 值、格式与 worker 隔离环境 |
| 0xC0000142 + couldn't create signal pipe, Win32 error 5 | MSYS 初始化受 Low 完整性沙箱限制 | 在正常 Medium 完整性环境复测，不要继续盲目补 DLL |

## 2. 已知现象与取证

用户已确认 nvm4w 副本与 Git 原件字节相同；本次核验 Git 原件：44,180 bytes，SHA256：

~~~text
B5D80F13E6B4B422A8C22D32BE9CC1F5FD9B482FC60008ED80E513A2FA938CDC
~~~

没有在 nvm4w 中复建失败副本。本次所有复制实验只写入独立测试目录。

### 2.1 PE 导入表（包含传递依赖）

用仓库内临时 PE 解析器读取 IMAGE_IMPORT_DESCRIPTOR；x64 / PE32+，相关文件未发现 delay imports：

~~~text
env.exe
  msys-intl-8.dll
    msys-iconv-2.dll
      msys-2.0.dll
      kernel32.dll
    msys-2.0.dll
    kernel32.dll
  msys-2.0.dll
    kernel32.dll
    ntdll.dll
  kernel32.dll
~~~

因此，本机这版 env 的非系统依赖闭包为三个 DLL，而不是两个。

### 2.2 单变量对照：消除 PATH 对 DLL 搜索的帮助

在 Medium 完整性进程运行；三个目录互相隔离；各子进程 PATH 均限定为 Windows System32：

| 测试目录文件集 | 实际退出码 | 结果 |
| --- | --- | --- |
| A：env.exe | -1073741515 / 0xC0000135 | 加载失败 |
| B：env.exe + msys-2.0.dll + msys-intl-8.dll | -1073741515 / 0xC0000135 | 仍加载失败 |
| C：B + msys-iconv-2.dll | 0 | env (GNU coreutils) 8.32 |

B→C 只增加 msys-iconv-2.dll，失败消失。这与 msys-intl-8.dll 的导入表相互印证，是根因证据，不是 prefix 猜测。

另一个独立对照：只复制 env.exe 到非 Git 目录，给该子进程 PATH 加 Git usr/bin，运行 --version 也 exit 0，说明依赖可由 PATH 搜索获得。

### 2.3 DLL 搜索顺序与 SafeDllSearchMode

普通未打包 Windows 程序的默认 DLL 搜索在处理 API set、SxS、已加载模块、KnownDLL 等因素后，会考虑应用目录、系统目录、Windows 目录、当前目录和 PATH。SafeDllSearchMode 主要改变当前目录与系统目录的相对优先级；它不会替你递归扫描 Git 安装目录，也不会忽略间接导入。

本机查询 Session Manager 下 SafeDllSearchMode 未找到显式值；本任务没有改该设置。没有抓取原 nvm4w 副本的 Procmon/Loader Snaps 轨迹，故不宣称已逐项观测其所有搜索路径。**本结论依赖导入表与受控文件集实验，不依赖猜测或禁用 SafeDllSearchMode。**

参考入口：[Microsoft DLL search order](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order)。本次网络抓取失败，以上本机实验是直接证据。

### 2.4 MSYS prefix 假设的边界

四文件独立目录已经能运行 --version，所以“必须留在原 Git prefix，否则 env 无法启动”被反证。

早期 cygpath 子进程实验在独立目录下报告不同的 / 根；但子进程加载位置与继承的 MSYS 环境也会影响结果，不能据此认定原始 0xC0000135 的原因。依赖完整不等于任意 MSYS 程序/locale/挂载功能都能脱离完整安装；本任务只验证 env 启动和包装 native Node。

## 3. nvm4w 目录为什么会有它

GNU coreutils/MSYS env 不承担 Node.exe、npm 或 nvm4w 的正常运行职责；没有业务理由要求它位于 Node 的切换目录。nvm4w 的版本切换也不应承担维护额外 MSYS DLL 的责任。

同字节证明是 Git 原件的复制品或同发行版本文件，**不能证明是谁、何时、用什么命令放进去的**。可能来源包括手工复制、自动化修复脚本、为了让 POSIX 前缀命令出现在 PATH 上而做的临时补救。本工作区旧实验脚本确有向 Windows 系统目录复制 Git env 的尝试，但不是复制到 nvm4w 的直接证据，不能追认为来源。

结论：保留“已删除，不放回去”。不重装 Node，不往 System32 放副本，不改 nvm4w 其它文件。

## 4. 推荐修法：PATH 指向完整 Git 安装

当前 HKCU Environment 的 Path 为 REG_SZ，994 字符，末尾已有 C:\Program Files\Git\usr\bin；Machine+User 合成长度 1748，不是 2047 截断问题。服务启动脚本也已前置该目录（任务开始前存在，本任务未修改）。

**本次没有持久化改 PATH、没有向 nvm4w 复制文件、没有修改/重启服务。** 不需要额外 shim。

如果另一台机器缺此 PATH 项，先备份，再追加（下面仅是安装操作说明，未在本机执行）：

~~~powershell
$backup = Join-Path $env:USERPROFILE ('env-path-before-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.clixml')
$key = Get-Item 'HKCU:\Environment'
[pscustomobject]@{
  Path = [Environment]::GetEnvironmentVariable('Path','User')
  Kind = $key.GetValueKind('Path').ToString()
} | Export-Clixml -LiteralPath $backup
$git = 'C:\Program Files\Git\usr\bin'
if (-not (Test-Path -LiteralPath (Join-Path $git 'env.exe'))) { throw 'Git env.exe missing' }
$before = [Environment]::GetEnvironmentVariable('Path','User')
if (($before -split ';') -notcontains $git) {
  [Environment]::SetEnvironmentVariable('Path', $before.TrimEnd(';') + ';' + $git, 'User')
}
# 注销并重新登录后开 pwsh，避免旧终端/Explorer 保留旧环境。
~~~

不建议全局前置整个 Git usr/bin：其中 whoami.exe、find.exe 等会遮蔽 Windows 同名程序。服务私有 PATH 前置是已有行为；验收脚本使用 System32 下 whoami.exe 的绝对路径，避免歧义。

### 4.1 备选：独立四文件目录

确实不能把 Git usr/bin 放入 PATH 时，本次已证明独立目录只需这四个同一 Git 版本的文件即可满足 --version：env.exe、msys-2.0.dll、msys-intl-8.dll、msys-iconv-2.dll。验证脚本 -DependencyExperiment 会在唯一临时目录创建 A/B/C 对照，不改 PATH 或服务。

如生产使用，必须自行维护 Git 更新后的同版本配套 DLL、完整包装执行验收与回滚；不混用多个 MSYS 发行版的 DLL，不把这套文件装进 nvm4w。本机不采纳该备选，因此没有安装新的永久 shim 目录。

## 5. 验证命令与实测输出

验证脚本：[verify-windows-env.ps1](<verify-windows-env.ps1>)。

### 5.1 不依赖当前进程临时 PATH 的新 pwsh

~~~powershell
pwsh -NoProfile -File D:\src\dsh\docs\ops\verify-windows-env.ps1 -PersistedEnvironment -DependencyExperiment
~~~

-PersistedEnvironment 启动一个新的 -NoProfile pwsh，直接用注册表中的 Machine+User PATH 填入**子进程环境块**；不是把 Git 路径临时硬编码加进当前会话，不写注册表。这样能剥离旧 DSH/旧终端继承环境的影响，但不证明仍在运行的 Windows Terminal/Explorer 已自动刷新。

2026-11-06 实测（Medium 完整性，总退出码 0）：

~~~text
env resolved: C:\Program Files\Git\usr\bin\env.exe
cmd /c env --version: exit=0
env (GNU coreutils) 8.32
env NODE_X=42 node probe.mjs alpha beta: exit=0
NODE_X=42
argv=["alpha","beta"]
env node --help: exit=0; first line=Usage: node [options] [ script.js ] [arguments]
nested env converted POSIX PATH: exit=0
NODE_X=nested
argv=["nested"]
dependency case A: exit=-1073741515
dependency case B: exit=-1073741515
dependency case C: exit=0
PASS
~~~

脚本实际调用 env.exe 包装解析出的 node.exe 绝对路径，运行临时生成的 probe.mjs，检查 NODE_X=42 和两个 argv，非只检查 --version。

原始安全输出：[windows-env-validation.txt](<../../.ptc/tmp/windows-env-validation.txt>)。临时 probe 与 A/B/C 文件集位置由输出末行给出。

### 5.2 自然打开终端的验收边界

用户第一次从旧终端启动的新 pwsh：PATH 不含 Git，cmd /c env --version 失败。第二次用户临时前置 Git 后重跑：--version、Node 包装、Git 包装、嵌套 env 与 lark-cli --version 均 exit 0。

第二次临时前置 PATH 的结果不作为“持久化 PATH 自然生效”的证据。随后用户在独立终端 `PS C:\Users\wwm_1>` 执行以下版本命令并回传成功输出：env (GNU coreutils) 8.32。该用户实测补齐了最后的自然终端验收；结合 5.1 的 Node 包装和 DLL 对照，验收通过。复核命令：

~~~powershell
cmd /c env --version
pwsh -NoProfile -File D:\src\dsh\docs\ops\verify-windows-env.ps1
~~~

## 6. 3082 嵌套 env 与链路保护

受控复现（正确拆分 argv，而不是拼错的一整条字符串）：

~~~text
env PATH=<Machine+User Windows-style PATH> env NODE_X=nested node probe.mjs
  Git appended: exit 127, env: 'env': No such file or directory
  Git prepended: exit 127, env: 'env': No such file or directory
env PATH=<cygpath -p -u 转换后的 POSIX PATH> env NODE_X=nested node probe.mjs
  exit 0, NODE_X=nested, argv=["nested"]
~~~

因此：PATH 指向 Git **足够解决普通 env 调用与 DLL 依赖**，但不保证上游把 Windows PATH 再作为 env 的 PATH=赋值传进去时的嵌套调用可靠。用户手工环境中嵌套曾成功，说明不能宣称“Windows PATH 一定不能工作”；以真实 argv、PATH 值与子进程上下文为准。

长期 Windows 兼容方向是 subprocess.spawn 的 argv 直接传 native CLI，PATH 和 notifier 变量放 env 字典，不依赖嵌套 POSIX env。另一个兼容方向是显式转换 PATH，但必须验证业务隔离语义。**本次用户选择暂不改补丁/不重启 3082。** 未通过生产部署检查的端到端重跑，不声称已修复飞书面板全部问题，也不把一个未经验证的 .bak 文件自动当成可恢复补丁。

本次收尾只读核验：

- 3082 API 可达，FeishuProblem=null，health error entries=0；总 setup 仍为 github/repositoryUnset，这是既有 GitHub 未配置，不是 env DLL 故障。
- HITL daemon pid=41292 存活，inbound=running，心跳更新；lastError 字段内容为连接信息“feishu-websocket: connected”，不是本次启动失败。
- 未更改 app2 cli_aa66f315697adc03 / app3 cli_aa67e4041a381c02 的配置、凭据、profile 或进程；未发送测试消息。本次不以进程存活替代完整飞书 HITL 闭环验收。

## 7. 回滚

### 7.1 本次改动

本次交付只有本文档、验证脚本、任务账本/临时实验文件；没有 PATH/系统目录/服务持久化改动可回滚。验证脚本被修正前副本保存在：[verify-windows-env.before-retry.ps1](<../../.ptc/tmp/verify-windows-env.before-retry.ps1>)。

~~~powershell
# 仅回滚验证脚本，不影响业务链路：
Copy-Item -LiteralPath D:\src\dsh\.ptc\tmp\verify-windows-env.before-retry.ps1 -Destination D:\src\dsh\docs\ops\verify-windows-env.ps1
~~~

测试脚本只创建唯一临时目录，不自动删除以保留证据。清理时先检查输出的完整目录（必须是当前用户 Temp 下 dsh-env-test-开头的本次目录），列出确认后再执行：

~~~powershell
$testDir = 'C:\Users\wwm_1\AppData\Local\Temp\dsh-env-test-8dcb84f509814aaba1eb4ae7f7b2061f'
Get-Item -LiteralPath $testDir
Get-ChildItem -LiteralPath $testDir -Recurse
# 确认确属本次实验后：
Remove-Item -LiteralPath $testDir -Recurse
~~~

不删除共享 .ptc/tmp 整目录，不改写/删除任务账本历史。

### 7.2 未来 PATH 修改的精确恢复

如果执行过第 4 节的追加操作，用该操作**之前**生成的 clixml 备份恢复；先备份当前值，避免覆盖后续其它人的修改：

~~~powershell
$backup = 'C:\Users\wwm_1\env-path-before-YYYYMMDD-HHmmss.clixml'
$old = Import-Clixml -LiteralPath $backup
$now = [Environment]::GetEnvironmentVariable('Path','User')
$now | Set-Content (Join-Path $env:USERPROFILE ('env-path-pre-rollback-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.txt'))
$kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$old.Kind)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $key.SetValue('Path',[string]$old.Path,$kind) } finally { $key.Dispose() }
# 注销并登录，使新进程取得恢复后的 PATH。
~~~

任务开始前用户追加 Git 的旧 PATH 没有在本任务中取得事前快照，不能声称能精确恢复其历史字节。若只想撤销那一项，先按第 4 节保存当前值，再只删除完全匹配的 Git usr/bin 项，保留其余项；可能令其它依赖 env 的程序失效，勿在业务运行中盲目执行：

~~~powershell
$u = [Environment]::GetEnvironmentVariable('Path','User')
$kept = @($u -split ';' | Where-Object { $_ -ine 'C:\Program Files\Git\usr\bin' }) -join ';'
[Environment]::SetEnvironmentVariable('Path',$kept,'User')
~~~

不把失败的 env.exe 放回 nvm4w 作为“回滚”。

## 8. 限制与下一步

- 不确定原始复制者或复制命令；不声称完成取证溯源。
- 自然终端验收已由用户回传成功的 cmd /c env --version 输出补齐；本根任务验收完成。旧 DSH 宿主仍可能继承旧 PATH，无需为此中断现有服务。
- 若 3082 再报嵌套 env 错误，另择维护窗口审查 native env 字典补丁，先备份并跑测试 profile，再考虑生产重启；本次没有授权重启。
- 旧实验曾因参数拼接错误意外输出环境变量；未将该输出保存进本文或验证证据文件。后续只使用修正版，不运行不带命令的 env，勿把环境转储加入版本库。
