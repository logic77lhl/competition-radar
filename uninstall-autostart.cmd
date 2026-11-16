@echo off
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\competition-radar.lnk"

if exist "%LNK%" ( del /q "%LNK%" & echo Removed startup shortcut ) else ( echo No startup shortcut found )
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n=-join([char]0x53C2,[char]0x8D5B,[char]0x96F7,[char]0x8FBE); $dsk=[Environment]::GetFolderPath('Desktop'); foreach ($f in @((Join-Path $dsk ($n+'.lnk')), (Join-Path $dsk 'competition-radar.lnk'))) { if (Test-Path $f) { Remove-Item $f -Force; Write-Host ('Removed desktop shortcut: '+$f) } }"

echo.
echo Autostart removed. A running panel keeps running (it only reads state/).
pause
