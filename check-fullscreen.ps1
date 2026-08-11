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

if ($r.Left -le 0 -and $r.Top -le 0 -and $r.Right -ge $sw -and $r.Bottom -ge $sh) {
    Write-Output "FULLSCREEN"
} else {
    Write-Output "WINDOWED"
}
