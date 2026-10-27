@echo off
setlocal EnableExtensions
set "NIUMA_ACCEPTANCE_ROOT=%TEMP%\niuma-legacy-diag-%RANDOM%-%RANDOM%"
if exist "%NIUMA_ACCEPTANCE_ROOT%" exit /b 2
mkdir "%NIUMA_ACCEPTANCE_ROOT%" || exit /b 2
echo Isolated profile: %NIUMA_ACCEPTANCE_ROOT%
echo Failure log: %NIUMA_ACCEPTANCE_ROOT%\legacy-diagnostics\failures.jsonl
echo Confirm the ordinary development notice in the VM. No installation is performed.
pushd "%~dp0"
start "" /wait "%~dp0niuma-legacy-diagnostic.exe" --runtime-candidate
set "NIUMA_DIAG_EXIT=%ERRORLEVEL%"
popd
echo Diagnostic client exit code: %NIUMA_DIAG_EXIT%
endlocal & exit /b %NIUMA_DIAG_EXIT%

