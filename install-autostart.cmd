@echo off
setlocal
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "VBS=%APP%\launch-hidden.vbs"
set "OPEN=%APP%\open.cmd"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\competition-radar.lnk"
set "DESK=%USERPROFILE%\Desktop\competition-radar.lnk"

if not exist "%VBS%" (
  echo [x] launch-hidden.vbs not found
  pause
  exit /b 1
)

echo [1/4] Create startup shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath='wscript.exe'; $s.Arguments='\"'+$env:VBS+'\"'; $s.WorkingDirectory=$env:APP; $s.WindowStyle=7; $s.Description='competition-radar dashboard'; $s.Save()"
if errorlevel 1 (
  echo [x] Failed to create startup shortcut
  pause
  exit /b 1
)

echo [2/4] Start in background ^(no window^)
wscript.exe "%VBS%"

echo [3/4] Wait for the service
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 300; $c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',7865); $ok=$true; $c.Close(); break } catch { } } ; if ($ok) { Write-Host '      OK  http://127.0.0.1:7865/' } else { Write-Host '      [!] Not running, see state\panel.log'; exit 1 }"
if errorlevel 1 (
  pause
  exit /b 1
)

echo [4/4] Create desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n=-join([char]0x53C2,[char]0x8D5B,[char]0x96F7,[char]0x8FBE); $dsk=[Environment]::GetFolderPath('Desktop'); $d=Join-Path $dsk ($n+'.lnk'); $old=Join-Path $dsk 'competition-radar.lnk'; if (Test-Path $old) { Remove-Item $old -Force }; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($d); $s.TargetPath='cmd.exe'; $s.Arguments='/c \"'+$env:OPEN+'\"'; $s.WorkingDirectory=$env:APP; $s.WindowStyle=7; $s.Description='competition-radar dashboard'; $s.Save(); Write-Host ('      '+$d)"

echo.
echo Done. It now starts silently at logon.
echo   Open       open.cmd   or   http://127.0.0.1:7865/
echo   Foreground start.cmd   (console, for debugging)
echo   Remove     uninstall-autostart.cmd
echo.
pause
