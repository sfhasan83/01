# Creates "Crypto Movement Bot" shortcuts on the Desktop and in the Start menu.
# Run by setup.bat, or on its own through create-shortcut.bat.
$ErrorActionPreference = "Stop"
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $folder ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) { Write-Host "Run setup.bat first."; exit 1 }
$icon = Join-Path $folder "bot.ico"
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath("Desktop"), (Join-Path ([Environment]::GetFolderPath("Programs")) ""))
foreach ($place in $places) {
    $link = $shell.CreateShortcut((Join-Path $place "Crypto Movement Bot.lnk"))
    $link.TargetPath = $pythonw
    $link.Arguments = "-m btc_bot gui"
    $link.WorkingDirectory = $folder
    $link.IconLocation = "$icon,0"
    $link.Description = "BTC, ETH and SOL movement predictions (signals only)"
    $link.Save()
    Write-Host "Shortcut created in $place"
}
