# DSH 默认启动配置

本机 Windows 登录后由 Startup 文件夹中的 `DSH-Default-Startup.cmd` 打开一个独立 Windows Terminal，执行 `dsh-default-startup.ps1`。

## 启动顺序

1. 启动 Super agent 服务（3082）。
2. 启动 sa-local 服务（3083）。
3. 启动 sa-local 飞书通知器。
4. 如果 3080 已监听，跳过重复启动 web profile；否则通过 `webprofile.sh` 调用 `dsh-permission-compat/tools/dsh-web-safe.ps1` 启动 web profile。

服务脚本本身是幂等的；已经运行时会直接返回。启动编排日志写入 `%USERPROFILE%/.dsh/logs/dsh-default-startup-*.log`。

## 文件

- `webprofile.sh`：web profile 的 Git Bash 包装器。
- `dsh-default-startup.ps1`：启动编排和 3080 幂等检查。
- `dsh-default-startup.cmd`：生成 Windows Terminal 窗口的入口模板。
- `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/DSH-Default-Startup.cmd`：当前用户的实际登录启动项。

## 手动验证

```powershell
pwsh -NoProfile -File .\dsh-superagent-service.ps1 status
pwsh -NoProfile -File .\dsh-sa-local-service.ps1 status
pwsh -NoProfile -File .\dsh-sa-local-notify.ps1 status
Get-NetTCPConnection -LocalPort 3080,3082,3083 -State Listen
```

## 回滚

删除当前用户 Startup 目录中的 `DSH-Default-Startup.cmd` 即可取消登录自启；备份位于 `.ptc/backups/startup-before-dsh-default-*`。
