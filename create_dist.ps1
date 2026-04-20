$sourcePath = "c:\Users\userv\Downloads\Bot\sui-clmm-bot-dashboard"
$destPath = "c:\Users\userv\Downloads\Bot\sui-bot-dist.zip"

Write-Host "Generating distribution ZIP..."

$tempFolder = "$env:TEMP\sui-bot-dist"
if (Test-Path $tempFolder) { Remove-Item -Recurse -Force $tempFolder }
New-Item -ItemType Directory -Path $tempFolder | Out-Null

$roboArgs = @(
    $sourcePath,
    $tempFolder,
    "/E", 
    "/NJH", "/NJS", "/NDL", "/NC", "/NS",
    "/XD", ".git", "node_modules", "dist", "bot", "scratch", ".fly", "backups", ".qoder",
    "/XF", ".env", "*.zip", "*.ps1", "session_state_*.json", "tracker_*.json", "pnl_data.json"
)

& robocopy $roboArgs | Out-Null

if ($LASTEXITCODE -ge 8) {
    Write-Host "Robocopy failed with exit code $LASTEXITCODE"
} else {
    Write-Host "Copy complete. Compressing..."
    if (Test-Path $destPath) { Remove-Item -Force $destPath }
    Compress-Archive -Path "$tempFolder\*" -DestinationPath $destPath -Force
    Write-Host "Success! Created $destPath"
}
