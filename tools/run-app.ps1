# tools/run-app.ps1 - launch StoryForge (Electron) for N seconds and capture logs.
# powershell -File tools\run-app.ps1 -Seconds 12
# Exit codes: 0 - no crash signs; 1 - crash-like lines found in logs; 2 - electron.exe missing.
# NOTE: keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

param(
    [int]$Seconds = 12,
    [int]$Tail = 60
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot   # parent of tools/ = project root
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $Electron)) {
    Write-Host "electron.exe not found: $Electron"
    exit 2
}

# Clean logs of previous runs
Get-ChildItem -Path $PSScriptRoot -Filter 'run-*.log' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $PSScriptRoot "run-$stamp.out.log"
$errLog = Join-Path $PSScriptRoot "run-$stamp.err.log"

Write-Host "Starting Electron (${Seconds}s) ... logs: tools\run-$stamp.{out,err}.log"
# --enable-logging is rejected by Electron's embedded Node CLI ("bad option"),
# so renderer/main console logs are enabled via the environment variable instead.
$env:ELECTRON_ENABLE_LOGGING = '1'
$proc = Start-Process -FilePath $Electron `
    -ArgumentList '.' `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

Start-Sleep -Seconds $Seconds
$exited = $proc.HasExited
if (-not $exited) {
    Write-Host "Process still alive (PID $($proc.Id)) - stopping."
    & taskkill /PID $proc.Id /T /F | Out-Null
    Start-Sleep -Milliseconds 500
}
else {
    Write-Host "Process exited on its own: code $($proc.ExitCode)."
}

function Show-Tail([string]$logPath, [string]$label, [int]$n) {
    if (-not (Test-Path $logPath)) { Write-Host "`n--- $label (no file) ---"; return }
    $lines = Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
    if (-not $lines) { Write-Host "`n--- $label (empty) ---"; return }
    Write-Host "`n--- $label (last $n of $($lines.Count) lines) ---"
    $lines | Select-Object -Last $n | ForEach-Object { Write-Host $_ }
}
Show-Tail $outLog 'stdout' $Tail
Show-Tail $errLog 'stderr' $Tail

# Look for crash-like lines
$pattern = 'Uncaught|Failed to load|Cannot find module|ReferenceError|TypeError|SyntaxError|Error:|ERR_'
$hits = @()
foreach ($lp in @($outLog, $errLog)) {
    if (-not (Test-Path $lp)) { continue }
    foreach ($line in (Get-Content -LiteralPath $lp -ErrorAction SilentlyContinue)) {
        # Chromium noise like [pid:1234:ERROR:file.cc(56)] is not an app crash
        if ($line -match $pattern -and $line -notmatch '\[\d+:\d+:ERROR:.*\.cc') {
            $hits += "[$([IO.Path]::GetFileName($lp))] $line"
        }
    }
}

if ($hits.Count -gt 0) {
    Write-Host "`n=== CRASH-LIKE LINES FOUND ($($hits.Count)) ==="
    $hits | Select-Object -First 40 | ForEach-Object { Write-Host $_ }
    exit 1
}
Write-Host "`nNo crash-like lines found in logs."
exit 0
