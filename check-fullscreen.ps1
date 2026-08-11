Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ | Out-Null

$fw = [WAPI]::GetForegroundWindow()
$r = New-Object WAPI+RECT
[WAPI]::GetWindowRect($fw, [ref]$r) | Out-Null

Add-Type -AssemblyName System.Windows.Forms | Out-Null
$sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$sh = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height

$tolerance = 8  # 容忍 8px 偏差(浏览器全屏视频可能有微小边框)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($r.Left -le $tolerance -and $r.Top -le $tolerance -and $w -ge ($sw - $tolerance) -and $h -ge ($sh - $tolerance)) {
    Write-Output "FULLSCREEN"
} else {
    Write-Output "WINDOWED"
}
