@echo off
setlocal
cd /d "%~dp0"
REM Daily entry: start the panel hidden if it is not running, then open the browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; $c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',7865); $ok=$true } catch { } ; $c.Close(); if (-not $ok) { Start-Process wscript.exe -ArgumentList '\"%~dp0launch-hidden.vbs\"' -WindowStyle Hidden; for ($i=0; $i -lt 25; $i++) { Start-Sleep -Milliseconds 300; $d=New-Object Net.Sockets.TcpClient; try { $d.Connect('127.0.0.1',7865); $ok=$true; $d.Close(); break } catch { } } } ; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [x] Panel did not start. See state\panel.log
  pause
  exit /b 1
)
start "" "http://127.0.0.1:7865/"
exit /b 0
