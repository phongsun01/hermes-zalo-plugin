# start-bridge.ps1 — Runs the Zalo bridge and restarts it on crash.
# Usage: .\start-bridge.ps1
# Keep this terminal open; Ctrl+C to stop.

$env:ZALO_PLUGIN_HOST = "0.0.0.0"
# Thư mục lưu ảnh tải từ group (mặc định D:\ZaloImages\<groupId>)
# Thay đổi đường dẫn tại đây nếu muốn lưu sang ổ khác.
$env:ZALO_IMAGE_SAVE_PATH = "D:\ZaloImages"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$attempt = 0

while ($true) {
    $attempt++
    Write-Host "[watchdog] Starting bridge (attempt $attempt)..." -ForegroundColor Cyan
    
    $proc = Start-Process -NoNewWindow -PassThru -FilePath "node" `
        -ArgumentList "server.js" `
        -WorkingDirectory $ScriptDir
    
    Write-Host "[watchdog] Bridge PID $($proc.Id) started" -ForegroundColor Green
    $proc.WaitForExit()
    $code = $proc.ExitCode
    Write-Host "[watchdog] Bridge exited with code $code. Restarting in 3s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}
