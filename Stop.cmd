@echo off
rem Stops Agentville: closes the app (which stops a server it started), then anything still listening on its port.
taskkill /im Agentville.exe /t >nul 2>&1
timeout /t 3 /nobreak >nul
set "P=%AGENTVILLE_PORT%"
if "%P%"=="" set "P=5275"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%P% .*LISTENING"') do (
  echo Stopping the server on port %P% ^(pid %%a^)
  taskkill /pid %%a /t /f >nul 2>&1
)
