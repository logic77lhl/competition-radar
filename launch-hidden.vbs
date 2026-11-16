' competition-radar dashboard - start with no console window.
' Installed into the Startup folder by install-autostart.cmd.
' If the port is already taken, server.mjs exits quietly by itself.
Option Explicit

Dim fso, sh, appDir, logFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir
' Do not steal focus by opening a browser on hidden start.
sh.Environment("PROCESS")("NO_OPEN") = "1"

logFile = appDir & "\state\panel.log"
If Not fso.FolderExists(appDir & "\state") Then fso.CreateFolder appDir & "\state"
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 1048576 Then fso.DeleteFile logFile, True
End If

cmd = "cmd /c node """ & appDir & "\panel\server.mjs"" >> """ & logFile & """ 2>&1"
sh.Run cmd, 0, False
