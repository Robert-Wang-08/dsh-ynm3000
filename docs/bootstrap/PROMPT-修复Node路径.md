# Prompt：修复 DSH 的 Node.js PATH

请在 Windows PowerShell 中执行工作区脚本：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ".\tools\repair-node-path.ps1"
```

执行要求：

1. 工作目录为 DSH 工作区根（含 `tools\repair-node-path.ps1` 与 `AGENTS.md`）；先读脚本再执行。
2. 只修改当前用户的 PATH 和 `DSHPACK_NODE` 用户环境变量，不修改系统 PATH，不修改项目源码，不读取或输出任何密钥。
3. 脚本会自动备份原用户 PATH 到 `%USERPROFILE%\.dsh\device\node-path-backups\`。
4. 脚本会优先探测常见 Node.js 安装位置，并移除失效的 `C:\nvm4w\nodejs` PATH 项。
5. 如果自动探测不到 Node，请停止并报告，不要下载安装包；可使用真实路径重试：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ".\tools\repair-node-path.ps1" -NodePath "C:\真实路径\node.exe"
```

脚本成功后关闭当前 PowerShell，重新打开一个 PowerShell，再验证：

```powershell
where.exe node
node --version
where.exe npm
npm --version
where.exe dsh
dsh --version
```

验收标准：

- `where.exe node` 不再指向 `C:\nvm4w\nodejs\node.exe`；
- `node --version` 和 `npm --version` 均正常返回；
- `dsh --version` 正常返回；
- 输出实际 Node 路径、验证结果和 PATH 备份文件路径；
- 如果仍失败，只报告具体失败命令和错误，不要删除 PATH 备份，也不要修改 ACL。
