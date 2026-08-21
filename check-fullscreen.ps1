# 全屏检测脚本(独立测试/调试用)
# 注意:运行时实际执行的是 main.js 内嵌的 FS_CHECK_SCRIPT 副本(打包后 asar 内的 .ps1
# 无法被 powershell -File 读取执行)。改动此文件时请同步更新 main.js 中的内嵌脚本。
# 输出:FULLSCREEN / WINDOWED;DS_FG_MODE=1 时追加进程名(FULLSCREEN|chrome / WINDOWED|Code)
# 前台感知开关关闭时(DS_FG_MODE≠1)不读取任何前台信息(隐私门控)
# 判定要点:窗口铺满屏幕 **且非最大化**(最大化窗口也铺满屏幕,但不是全屏,不应隐藏桌宠)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WAPI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ | Out-Null

if (-not ('WAPI' -as [type])) { Write-Output "WINDOWED"; exit 0 }

# 让本进程 DPI aware,使 GetWindowRect(物理像素)与 Screen.Bounds 单位一致,避免缩放后误判
[WAPI]::SetProcessDPIAware() | Out-Null

$fw = [WAPI]::GetForegroundWindow()
$r = New-Object WAPI+RECT
[WAPI]::GetWindowRect($fw, [ref]$r) | Out-Null

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$tolerance = 8  # 容忍 8px 偏差(浏览器全屏视频可能有微小边框)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$full = $false
# 遍历所有显示器:前台窗口覆盖任一屏幕即判定铺满(支持副屏)
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($r.Left -le ($b.Left + $tolerance) -and $r.Top -le ($b.Top + $tolerance) -and
        $r.Right -ge ($b.Right - $tolerance) -and $r.Bottom -ge ($b.Bottom - $tolerance)) {
        $full = $true
        break
    }
}
# 排除"最大化/普通窗口":最大化窗口也铺满屏幕,但带标题栏(WS_CAPTION),不是全屏
# 真全屏窗口(浏览器 F11/视频全屏/游戏)通常无标题栏;Chromium 全屏虽带 WS_MAXIMIZE,
# 但无 WS_CAPTION,所以用标题栏判据(比 WS_MAXIMIZE 更准)
$style = [WAPI]::GetWindowLong($fw, -16)
$hasCaption = ($style -band 0x00C00000) -ne 0
# 前台感知:仅 DS_FG_MODE=1 时读取前台进程名(隐私门控);默认只输出全屏标志
$suffix = ""
if ($env:DS_FG_MODE -eq "1") {
    $fwPid = 0
    [WAPI]::GetWindowThreadProcessId($fw, [ref]$fwPid) | Out-Null
    try {
        $proc = Get-Process -Id $fwPid -ErrorAction Stop
        $suffix = "|" + $proc.ProcessName
    } catch {
        $suffix = "|unknown"
    }
}
if ($full -and -not $hasCaption) { Write-Output ("FULLSCREEN" + $suffix) } else { Write-Output ("WINDOWED" + $suffix) }
