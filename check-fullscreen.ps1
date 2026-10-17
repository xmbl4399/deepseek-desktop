# 全屏检测脚本(独立测试/调试用)
# 注意:运行时实际执行的是 main.js 内嵌的 FS_CHECK_SCRIPT 副本(打包后 asar 内的 .ps1
# 无法被 powershell -File 读取执行)。改动此文件时请同步更新 main.js 中的内嵌脚本。
# 输出:FULLSCREEN / WINDOWED;DS_FG_MODE=1 时追加进程名(FULLSCREEN|chrome / WINDOWED|Code)
# 前台感知开关关闭时(DS_FG_MODE≠1)不读取任何前台信息(隐私门控)
#
# 判定要点(2026-10 加固,原判据"铺满屏幕且无标题栏"误判频发,实测抓到
# explorer/Progman 与 TextInputHost/Windows.UI.Core.CoreWindow 都是 2560x1440 无标题栏):
#   1. 铺满屏幕**且非最大化**,最大化窗口也铺满屏幕但不是全屏
#   2. 窗口类名不在**外壳黑名单**里(桌面/任务栏/输入法宿主/窗口框架代理)
#   3. 高度必须超过**工作区高度**:最大化窗口贴着工作区(扣掉任务栏),真全屏占满整屏
#      ——这条是无边框窗口(WS_POPUP)与最大化窗口的关键分水岭
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WAPI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
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
$full = $false
$workH = 0
# 遍历所有显示器:前台窗口覆盖任一屏幕即判定铺满(支持副屏)
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($r.Left -le ($b.Left + $tolerance) -and $r.Top -le ($b.Top + $tolerance) -and
        $r.Right -ge ($b.Right - $tolerance) -and $r.Bottom -ge ($b.Bottom - $tolerance)) {
        $full = $true
        $workH = $s.WorkingArea.Height
        break
    }
}
# 排除"最大化/普通窗口":最大化窗口也铺满屏幕,但带标题栏(WS_CAPTION),不是全屏
# 真全屏窗口(浏览器 F11/视频全屏/游戏)通常无标题栏;Chromium 全屏虽带 WS_MAXIMIZE,
# 但无 WS_CAPTION,所以用标题栏判据(比 WS_MAXIMIZE 更准)
$style = [WAPI]::GetWindowLong($fw, -16)
$hasCaption = ($style -band 0x00C00000) -ne 0
$isMax = [WAPI]::IsZoomed($fw)

# 外壳窗口黑名单:桌面/任务栏/输入法候选窗/窗口框架代理。它们本就铺满屏幕且无标题栏,
# 一旦成为前台就会被误判成全屏(实测 Progman 与 Windows.UI.Core.CoreWindow 均中招)。
# 类名是 Win32 窗口类(区分大小写,统一转小写比较)
$cls = New-Object System.Text.StringBuilder 256
[WAPI]::GetClassName($fw, $cls, 256) | Out-Null
$clsName = $cls.ToString()
$shellClasses = @(
    'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
    'Windows.UI.Core.CoreWindow', 'ApplicationFrameHost',
    'MultitaskingViewFrame', 'ForegroundStaging', 'XamlExplorerHostIslandWindow',
    'Windows.Internal.Shell.TabProxyWindow', 'TaskListThumbnailWnd'
)
$isShell = $false
foreach ($c in $shellClasses) { if ($clsName -ieq $c) { $isShell = $true; break } }

# 工作区分水岭:最大化窗口高度 == 工作区高度(任务栏被扣掉);真全屏 == 整屏高度 > 工作区。
# 只在任务栏确实占用空间时(整屏高出工作区)才启用该判据,任务栏隐藏/自动隐藏时不误杀。
$screenH = $r.Bottom - $r.Top
$beatsWorkArea = $false
if ($workH -gt 0) { $beatsWorkArea = ($screenH -gt ($workH + $tolerance)) }
# 任务栏被自动隐藏时整屏高度也可能等于工作区,此时退回"非最大化"判据
$notMaxed = -not $isMax

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
# 判定链:铺满 → 无标题栏 → 非外壳窗口 → (高度超过工作区 或 非最大化)
$isFullscreen = $false
if ($full -and -not $hasCaption -and -not $isShell) {
    if ($beatsWorkArea) { $isFullscreen = $true }
    elseif ($notMaxed) { $isFullscreen = $true }
}
if ($isFullscreen) { Write-Output ("FULLSCREEN" + $suffix) } else { Write-Output ("WINDOWED" + $suffix) }
