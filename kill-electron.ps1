$procs = Get-Process electron -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    Stop-Process -Id $p.Id -Force
    Write-Host "Killed: $($p.Id)"
}
Write-Host "Done: $($procs.Count) processes"
