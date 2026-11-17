#Requires -Version 7.0
<#
.SYNOPSIS
    把当前 Windows 用户的注册表环境变量补进当前进程；只补缺失、不覆盖，也不打印任何值。

.DESCRIPTION
    DSH 的启动环境是启动瞬间的冻结快照（process / 项目 .env / 用户 .env），不读 Windows 注册表；
    从旧终端、登录期启动项或计划任务拉起的进程，会一直带着旧环境。
    本脚本用 CreateEnvironmentBlock 重建「一个新进程会拿到的用户环境」（HKCU + HKLM 合并、REG_EXPAND_SZ 已展开），
    把当前进程里尚不存在的名字补进来，供 superagent 启停脚本在启动 DSH 前调用。

    约束：
    - 只补缺失，已有值（含空串）一律不覆盖；
    - 读取失败只告警，不阻断启动；
    - 不输出变量值，只输出补齐的个数。

.EXAMPLE
    & .\dsh-user-env.ps1
    在启动 superagent 前调用；-Quiet 只静默成功、仍保留告警。
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

if (-not ('DshUserEnvironment' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshUserEnvironment
{
    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint TOKEN_QUERY = 0x0008;

    // 返回当前进程 token 对应用户的环境块（与新建进程拿到的用户环境一致）。
    public static Dictionary<string, string> Read()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");
        }

        IntPtr block;
        if (!CreateEnvironmentBlock(out block, token, false))
        {
            int code = Marshal.GetLastWin32Error();
            CloseHandle(token);
            throw new System.ComponentModel.Win32Exception(code, "CreateEnvironmentBlock failed");
        }

        try
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            IntPtr cursor = block;
            while (true)
            {
                string entry = Marshal.PtrToStringUni(cursor);
                if (string.IsNullOrEmpty(entry))
                {
                    break;
                }

                int separator = entry.IndexOf('=');
                if (separator > 0)
                {
                    string name = entry.Substring(0, separator);
                    string value = entry.Substring(separator + 1);
                    values[name] = System.Environment.ExpandEnvironmentVariables(value);
                }

                cursor = (IntPtr)((long)cursor + (entry.Length + 1) * 2);
            }

            return values;
        }
        finally
        {
            DestroyEnvironmentBlock(block);
            CloseHandle(token);
        }
    }
}
'@ -ErrorAction Stop
}

try {
    $values = [DshUserEnvironment]::Read()
} catch {
    Write-Warning ('user env unavailable: ' + $_.Exception.Message)
    return
}

$added = 0
foreach ($pair in $values.GetEnumerator()) {
    if ($pair.Key.StartsWith('=')) { continue }
    if ($null -ne [Environment]::GetEnvironmentVariable($pair.Key, 'Process')) { continue }
    [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process')
    $added++
}

if (-not $Quiet) {
    Write-Host ('user env: added ' + $added + ' missing variable(s) from the user profile')
}
