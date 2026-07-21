@echo off
setlocal
set "APP=%~dp0豆包的豆脑.exe"
if not exist "%APP%" (
  echo Program file not found.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\豆包的豆脑.lnk'); $s.TargetPath='%APP%'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo Desktop shortcut created.
pause
