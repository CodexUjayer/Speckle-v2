@echo off
setlocal
title Speckle launcher

rem ===== paste the base64 blob of your .env between the quotes (see README note); leave as-is to use an existing .env =====
set "SPK=DQoNCkVBUlRIREFUQV9VU0VSTkFNRSA9ICJsb2x0b3VjaG15ZGloIg0KRUFSVEhEQVRBX1BBU1NXT1JEID0gImxvbHRvdWNobXlkaWgjUDEiDQoNCg0KU1VQQUJBU0VfVVJMPSJodHRwczovL2ZnYWptbHNhcHZtd3Fzanlmc2JoLnN1cGFiYXNlLmNvIg0KU1VQQUJBU0VfU0VSVklDRV9LRVk9ImV5SmhiR2NpT2lKSVV6STFOaUlzSW5SNWNDSTZJa3BYVkNKOS5leUpwYzNNaU9pSnpkWEJoWW1GelpTSXNJbkpsWmlJNkltWm5ZV3B0YkhOaGNIWnRkM0Z6YW5sbWMySm9JaXdpY205c1pTSTZJbk5sY25acFkyVmZjbTlzWlNJc0ltbGhkQ0k2TVRjM01URTBOVE01TlN3aVpYaHdJam95TURnMk56SXhNemsxZlEuakZqZ1lvVlpPOE01RFhDdmxzbjU3dDE0TmNWTFh6b3VFUkJhc19UY0sxQSINCg0KTklTQVJfRU5BQkxFX1NDQU5TPTENCiMgRXh0cmEgQ09SUyBvcmlnaW5zIGFsbG93ZWQgdG8gY2FsbCB0aGlzIGVuZ2luZSAoY29tbWEtc2VwYXJhdGVkLCBleGFjdCBzY2hlbWUraG9zdCtwb3J0KS4NCiMgVGhlIHR3byBsb2NhbGhvc3Q6MzAwMCBkZXYgb3JpZ2lucyBhcmUgYWx3YXlzIGFsbG93ZWQuIE5vIHdpbGRjYXJkOiBwdXQgYXV0aCBpbiBmcm9udCBvZg0KIyBQT1NUIC9hcGkvc2NhbnMgYmVmb3JlIGV4cG9zaW5nIHRoZSBlbmdpbmUgcHVibGljbHkuDQpOSVNBUl9VSV9PUklHSU5TPTENCg0KTklTQVJfRU5BQkxFX1NDQU5TPTENCk5JU0FSX1VJX09SSUdJTlM9MQ0KTklTQVJfQkFDS0dST1VORF9UT0tFTj1kZXYNCg0KIyAtLS0gc2NhbiB2aXNpYmlsaXR5IC8gdGltZW91dHMgKGFkZGVkKSAtLS0NCiMgTklTQVJfTE9HX0xFVkVMPUlORk8gICAgICAgICAgICAjIElORk8gc2hvd3Mgc3RlcCBzdGFydC9lbmQsIEFTRiBzZWFyY2ggdGltaW5nIGFuZCBhIE1CLW9uLXdpcmUgaGVhcnRiZWF0IGV2ZXJ5IH42IHMNCiMgTklTQVJfU0VBUkNIX1RJTUVPVVRfUz05MCAgICAgICAjIHN0b3Agd2FpdGluZyBmb3Igb25lIEFTRiBzZWFyY2ggYWZ0ZXIgdGhpcyBsb25nICgwID0gd2FpdCBmb3JldmVyKQ0KIyBOSVNBUl9ORVRfU1RBTExfVElNRU9VVF9TPTI1ICAgICMgbm8gYnl0ZXMgZm9yIHRoaXMgbG9uZyA9PiBhIHJhbmdlIHJlYWQgaXMgcmV0cmllZA0KIyBOSVNBUl9ORVRfQ09OQ1VSUkVOQ1k9MjQgICAgICAgICMgbG93ZXIgKGUuZy4gOCkgb24gYSBzbG93IC8gaGlnaC1sYXRlbmN5IGxpbmsNCiMgTklTQVJfU0VBUkNIX1JFVFJZX0lOQ09NUExFVEU9MSAgICMgcmUtYXNrIEFTRiB0aGlzIG1hbnkgdGltZXMgd2hlbiBDTVIgcmVwb3J0cyBhIHNob3J0IHBhZ2U7IGEgc3RpbGwtc2hvcnQgbGlzdGluZyBpcyBmbGFnZ2VkIGFuZCBOT1QgY2FjaGVkDQojIE5JU0FSX0FTRl9MT0dfTEVWRUw9V0FSTklORyAgICAgICAjIElORgpOSVNBUl9FTkFCTEVfU0NBTlM9MQo="
rem =====================================================================================================================

rem --- prerequisites ---
where git >nul 2>nul    || (echo [!] Git is not installed: https://git-scm.com/download/win & pause & exit /b 1)
where python >nul 2>nul || (echo [!] Python 3.11+ is not installed: https://www.python.org/downloads/ & pause & exit /b 1)
where node >nul 2>nul   || (echo [!] Node 20+ is not installed: https://nodejs.org/ & pause & exit /b 1)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" || (echo [!] Python 3.11 or newer is required & pause & exit /b 1)

rem --- get the repo (skip if this file already sits inside it) ---
cd /d "%~dp0"
if not exist "requirements.txt" (
    if not exist "Speckle\requirements.txt" git clone https://github.com/Tech-Doomsday/Speckle || (echo [!] git clone failed & pause & exit /b 1)
    cd Speckle
)

rem --- python env + dependencies (first run only) ---
if not exist ".venv\Scripts\python.exe" python -m venv .venv || (echo [!] venv creation failed & pause & exit /b 1)
if not exist ".venv\.deps_installed" (
    ".venv\Scripts\python.exe" -m pip install -U pip -q
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo [!] pip install failed & pause & exit /b 1)
    echo ok> ".venv\.deps_installed"
)

rem --- write .env from the blob (scans enabled is already inside the blob) ---
if not "%SPK%"=="PASTE_BLOB_HERE" (
    powershell -NoProfile -Command "[IO.File]::WriteAllText('.env',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SPK)))"
)
if not exist ".env" echo [!] No .env found - the engine will start but scans need Earthdata credentials.

rem --- start engine + UI in their own windows ---
start "Speckle Engine" cmd /k ".venv\Scripts\python.exe -m uvicorn engine.api.main:app --port 8900"
start "Speckle UI" /d "%CD%\app-ui" cmd /k "npm install && npm run dev"

rem --- open the browser once the UI answers ---
echo Waiting for http://localhost:3000 (first run takes a minute or two)...
powershell -NoProfile -Command "while(-not (Test-NetConnection localhost -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue)){Start-Sleep 3}; Start-Process 'http://localhost:3000'"

echo.
echo Running. Close the "Speckle Engine" and "Speckle UI" windows to stop.
pause
