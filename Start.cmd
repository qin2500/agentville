@echo off
rem Opens Agentville: the built app if there is one, else the app from this checkout.
cd /d "%~dp0"
if exist "dist-app\win-unpacked\Agentville.exe" (
  start "" "dist-app\win-unpacked\Agentville.exe"
) else (
  call npm run app
)
