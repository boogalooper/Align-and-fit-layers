@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "INSTALLER_VERSION=11"
set "RUNTIME=%LOCALAPPDATA%\JazzyScripts\AlignFitRuntime"
set "UV_DIR=%RUNTIME%\uv"
set "UV_STAGE=%RUNTIME%\uv.new"
set "UV=%UV_DIR%\uv.exe"
set "PYTHON_DIR=%RUNTIME%\python"
set "VENV=%RUNTIME%\venv"
set "CACHE=%RUNTIME%\cache"
set "PY=%VENV%\Scripts\python.exe"
set "MODELS=%VENV%\models"
set "HUMAN_OUT=%MODELS%\human.onnx"
set "FACE_OUT=%MODELS%\face.onnx"

set "PY_VERSION=3.11.16"
set "NUMPY_VERSION=2.2.6"
set "OPENCV_VERSION=4.12.0.88"
set "UV_VERSION=0.12.19"
set "PIP_INSECURE=0"

set "UV_SHA256=6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0"
set "HUMAN_SHA256=552d8a984054e59b5d773d24b9b12022b22046ceb2bbc4c9aaeaceb36a9ddf24"
set "FACE_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

set "UV_URL=https://releases.astral.sh/github/uv/releases/download/%UV_VERSION%/uv-x86_64-pc-windows-msvc.zip"
set "UV_URL2=https://github.com/astral-sh/uv/releases/download/%UV_VERSION%/uv-x86_64-pc-windows-msvc.zip"
set "HUMAN_URL=https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/human_segmentation_pphumanseg/human_segmentation_pphumanseg_2023mar.onnx"
set "HUMAN_URL2=https://huggingface.co/opencv/opencv_zoo/resolve/main/models/human_segmentation_pphumanseg/human_segmentation_pphumanseg_2023mar.onnx"
set "FACE_URL=https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
set "FACE_URL2=https://huggingface.co/opencv/opencv_zoo/resolve/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

set "DOWNLOAD_DIR=%TEMP%\AlignFitRuntimeDownloads"
set "UV_ZIP_TMP=%DOWNLOAD_DIR%\uv-x86_64-pc-windows-msvc.zip"
set "HUMAN_TMP=%DOWNLOAD_DIR%\human.onnx.download"
set "FACE_TMP=%DOWNLOAD_DIR%\face.onnx.download"
set "LAUNCHER_TMP=%RUNTIME%\launcher.vbs.new"
set "VERSION_TMP=%RUNTIME%\runtime_version.txt.new"

set "CURL=%SystemRoot%\System32\curl.exe"
if not exist "%CURL%" set "CURL=curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%TAR%" set "TAR=tar.exe"

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "UV_PYTHON_INSTALL_DIR=%PYTHON_DIR%"
set "UV_CACHE_DIR=%CACHE%"
set "UV_MANAGED_PYTHON=1"
set "UV_NO_MODIFY_PATH=1"
set "UV_PYTHON_INSTALL_BIN=0"

echo ==============================================
echo Align and fit layers - private Python runtime
echo Installer revision: %INSTALLER_VERSION%
echo Runtime: %RUNTIME%
echo CPython: %PY_VERSION% x64 via uv
echo NumPy: %NUMPY_VERSION%
echo OpenCV: %OPENCV_VERSION%
echo ==============================================
echo.

call :preflight
if errorlevel 1 goto :failed

echo Connection mode for Python packages:
echo   [1] Normal secure mode ^(recommended^)
echo   [2] Kaspersky compatibility for official PyPI hosts
echo   [3] Cancel
echo.
choice /C 123 /N /M "Choose 1, 2 or 3: "
if errorlevel 3 goto :failed
if errorlevel 2 set "PIP_INSECURE=1"

echo.
echo Preparing runtime folders...
if not exist "%RUNTIME%" mkdir "%RUNTIME%" >nul 2>&1
if not exist "%PYTHON_DIR%" mkdir "%PYTHON_DIR%" >nul 2>&1
if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%" >nul 2>&1
if not exist "%RUNTIME%" (
    echo [ERROR] Cannot create runtime folder: "%RUNTIME%".
    goto :failed
)

call :ensure_uv
if errorlevel 1 goto :failed

call :ensure_python
if errorlevel 1 goto :failed

call :check_server_not_running
if errorlevel 1 goto :failed

call :ensure_packages
if errorlevel 1 goto :failed

call :ensure_models
if errorlevel 1 goto :failed

call :create_launcher
if errorlevel 1 goto :failed

call :self_test
if errorlevel 1 goto :failed

> "%VERSION_TMP%" echo %INSTALLER_VERSION%
move /y "%VERSION_TMP%" "%RUNTIME%\runtime_version.txt" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Cannot write runtime_version.txt.
    goto :failed
)

call :cleanup

echo.
echo ==============================================
echo Installation complete.
echo ==============================================
echo Runtime: %RUNTIME%
echo.
echo Photoshop folder should contain only:
echo   Align and fit layers.jsx
echo   lib\align-fit-api.pyw
echo.
echo Models are stored in:
echo   %MODELS%
echo.
echo Copy "Photoshop files\Align and fit layers.jsx" and the "lib" folder
echo into the Photoshop Scripts folder if you have not done so yet.
echo.
pause
exit /b 0

:preflight
if not defined LOCALAPPDATA (
    echo [ERROR] LOCALAPPDATA is not defined.
    exit /b 1
)
if not defined TEMP (
    echo [ERROR] TEMP is not defined.
    exit /b 1
)
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto :preflight_arch_ok
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto :preflight_arch_ok
echo [ERROR] This installer requires 64-bit x86 Windows.
exit /b 1
:preflight_arch_ok
where certutil.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] certutil.exe is required for SHA-256 verification.
    exit /b 1
)
"%TAR%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] tar.exe was not found. Modern Windows 10/11 includes it.
    exit /b 1
)
exit /b 0

:ensure_uv
set "UV_OK=0"
if exist "%UV%" (
    "%UV%" --version 2>nul | findstr /I /C:"uv %UV_VERSION%" >nul
    if not errorlevel 1 set "UV_OK=1"
)
if "%UV_OK%"=="1" (
    echo Existing uv %UV_VERSION% OK.
    exit /b 0
)

echo.
echo Installing verified uv %UV_VERSION%...
if exist "%UV_STAGE%" rmdir /s /q "%UV_STAGE%" >nul 2>&1
mkdir "%UV_STAGE%" >nul 2>&1
if not exist "%UV_STAGE%" (
    echo [ERROR] Cannot create temporary uv folder.
    exit /b 1
)

call :download_verified "%UV_URL%" "%UV_URL2%" "%UV_ZIP_TMP%" "%UV_SHA256%" "uv"
if errorlevel 1 exit /b 1

"%TAR%" -xf "%UV_ZIP_TMP%" -C "%UV_STAGE%"
if errorlevel 1 (
    echo [ERROR] Failed to extract uv archive.
    exit /b 1
)
if not exist "%UV_STAGE%\uv.exe" (
    echo [ERROR] uv.exe was not found after extraction.
    exit /b 1
)
"%UV_STAGE%\uv.exe" --version 2>nul | findstr /I /C:"uv %UV_VERSION%" >nul
if errorlevel 1 (
    echo [ERROR] Extracted uv has an unexpected version.
    exit /b 1
)
if exist "%UV_DIR%" rmdir /s /q "%UV_DIR%" >nul 2>&1
if exist "%UV_DIR%" (
    echo [ERROR] Cannot replace the old uv folder.
    exit /b 1
)
move "%UV_STAGE%" "%UV_DIR%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Cannot activate the new uv folder.
    exit /b 1
)
if not exist "%UV%" (
    echo [ERROR] uv.exe is missing after installation.
    exit /b 1
)
exit /b 0

:ensure_python
set "RECREATE_VENV=0"
if exist "%PY%" (
    "%PY%" -c "import sys,struct; raise SystemExit(0 if sys.version_info[:3]==(3,11,16) and struct.calcsize('P')==8 else 1)"
    if errorlevel 1 set "RECREATE_VENV=1"
)
if "%RECREATE_VENV%"=="1" (
    call :check_server_not_running
    if errorlevel 1 exit /b 1
    echo.
    echo Existing venv is incompatible. Recreating it...
    rmdir /s /q "%VENV%" >nul 2>&1
    if exist "%VENV%" (
        echo [ERROR] Cannot replace the existing venv. Close Photoshop and any AlignFit Python process, then run the installer again.
        exit /b 1
    )
)

if not exist "%PY%" (
    echo.
    echo Installing private CPython %PY_VERSION%...
    "%UV%" python install %PY_VERSION% --managed-python --no-bin
    if errorlevel 1 (
        echo [ERROR] uv could not install CPython %PY_VERSION%.
        exit /b 1
    )

    echo.
    echo Creating isolated virtual environment...
    "%UV%" venv "%VENV%" --python %PY_VERSION% --managed-python
    if errorlevel 1 (
        echo [ERROR] Failed to create the private virtual environment.
        exit /b 1
    )
)

if not exist "%PY%" (
    echo [ERROR] Private Python was not created: "%PY%".
    exit /b 1
)
"%PY%" -c "import sys,struct; raise SystemExit(0 if sys.version_info[:3]==(3,11,16) and struct.calcsize('P')==8 else 1)"
if errorlevel 1 (
    echo [ERROR] Private Python validation failed.
    exit /b 1
)
exit /b 0

:check_server_not_running
"%PY%" -c "import socket; s=socket.socket(); s.settimeout(0.25); r=s.connect_ex(('127.0.0.1',6320)); s.close(); raise SystemExit(0 if r==0 else 1)" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [ERROR] TCP port 6320 is currently in use.
    echo The AlignFit Python server may still be running.
    echo Close Photoshop or wait for the server's 15-minute idle timeout, then run this installer again.
    exit /b 1
)
exit /b 0

:ensure_packages
"%PY%" -c "import importlib.metadata as m,sys; ok=(m.version('numpy')=='%NUMPY_VERSION%' and m.version('opencv-python')=='%OPENCV_VERSION%'); import numpy,cv2; ok=ok and hasattr(cv2,'FaceDetectorYN') and hasattr(cv2,'dnn'); raise SystemExit(0 if ok else 1)" >nul 2>&1
if not errorlevel 1 (
    echo Existing Python packages OK.
    "%UV%" pip check --python "%PY%"
    if not errorlevel 1 exit /b 0
    echo Existing environment has dependency problems; repairing it...
)

:install_packages
echo.
echo Installing pinned binary packages into the private venv...
if "%PIP_INSECURE%"=="1" (
    "%UV%" pip install --python "%PY%" --upgrade --no-build "numpy==%NUMPY_VERSION%" "opencv-python==%OPENCV_VERSION%" --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org
) else (
    "%UV%" pip install --python "%PY%" --upgrade --no-build "numpy==%NUMPY_VERSION%" "opencv-python==%OPENCV_VERSION%"
)
if errorlevel 1 (
    if "%PIP_INSECURE%"=="1" (
        echo [ERROR] Python package installation failed.
        exit /b 1
    )
    echo.
    echo Package installation failed. If Kaspersky intercepts HTTPS, retry PyPI only without certificate verification.
    echo   [1] Retry in Kaspersky compatibility mode
    echo   [2] Cancel
    choice /C 12 /N /M "Choose 1 or 2: "
    if errorlevel 2 exit /b 1
    set "PIP_INSECURE=1"
    goto :install_packages
)

"%UV%" pip check --python "%PY%"
if errorlevel 1 (
    echo [ERROR] Installed Python packages have dependency conflicts.
    exit /b 1
)
"%PY%" -c "import importlib.metadata as m,sys,numpy,cv2; ok=(m.version('numpy')=='%NUMPY_VERSION%' and m.version('opencv-python')=='%OPENCV_VERSION%' and hasattr(cv2,'FaceDetectorYN') and hasattr(cv2,'dnn')); print('Python packages: NumPy',numpy.__version__,'| OpenCV',cv2.__version__); raise SystemExit(0 if ok else 1)"
if errorlevel 1 (
    echo [ERROR] Python package validation failed.
    exit /b 1
)
exit /b 0

:ensure_models
if not exist "%MODELS%" mkdir "%MODELS%" >nul 2>&1
if not exist "%MODELS%" (
    echo [ERROR] Cannot create model folder "%MODELS%".
    exit /b 1
)

set "WRITE_TEST=%MODELS%\.__alignfit_write_test.tmp"
> "%WRITE_TEST%" echo AlignFit write test
if errorlevel 1 (
    echo [ERROR] Cannot write to model folder: %MODELS%
    echo Check folder permissions or antivirus protection.
    exit /b 1
)
del /f /q "%WRITE_TEST%" >nul 2>&1

echo.
echo Installing/verifying neural models by SHA-256...
call :verify_hash "%HUMAN_OUT%" "%HUMAN_SHA256%"
if errorlevel 1 (
    echo Downloading human.onnx...
    call :download_verified "%HUMAN_URL%" "%HUMAN_URL2%" "%HUMAN_TMP%" "%HUMAN_SHA256%" "human.onnx"
    if errorlevel 1 exit /b 1
    copy /y "%HUMAN_TMP%" "%HUMAN_OUT%" >nul
    if errorlevel 1 (
        echo [ERROR] Cannot install human.onnx.
        exit /b 1
    )
) else (
    echo Existing model OK: human.onnx
)

call :verify_hash "%FACE_OUT%" "%FACE_SHA256%"
if errorlevel 1 (
    echo Downloading face.onnx...
    call :download_verified "%FACE_URL%" "%FACE_URL2%" "%FACE_TMP%" "%FACE_SHA256%" "face.onnx"
    if errorlevel 1 exit /b 1
    copy /y "%FACE_TMP%" "%FACE_OUT%" >nul
    if errorlevel 1 (
        echo [ERROR] Cannot install face.onnx.
        exit /b 1
    )
) else (
    echo Existing model OK: face.onnx
)

call :verify_hash "%HUMAN_OUT%" "%HUMAN_SHA256%"
if errorlevel 1 (
    echo [ERROR] Installed human.onnx failed SHA-256 verification.
    exit /b 1
)
call :verify_hash "%FACE_OUT%" "%FACE_SHA256%"
if errorlevel 1 (
    echo [ERROR] Installed face.onnx failed SHA-256 verification.
    exit /b 1
)
exit /b 0

:create_launcher
echo.
echo Creating runtime launcher...
del /f /q "%LAUNCHER_TMP%" >nul 2>&1
> "%LAUNCHER_TMP%" echo Option Explicit
>>"%LAUNCHER_TMP%" echo On Error Resume Next
>>"%LAUNCHER_TMP%" echo.
>>"%LAUNCHER_TMP%" echo Dim sh, fso, root, py, server, cmd
>>"%LAUNCHER_TMP%" echo Set sh = CreateObject("WScript.Shell")
>>"%LAUNCHER_TMP%" echo Set fso = CreateObject("Scripting.FileSystemObject")
>>"%LAUNCHER_TMP%" echo root = sh.ExpandEnvironmentStrings("%%LOCALAPPDATA%%") ^& "\JazzyScripts\AlignFitRuntime"
>>"%LAUNCHER_TMP%" echo py = root ^& "\venv\Scripts\pythonw.exe"
>>"%LAUNCHER_TMP%" echo server = sh.Environment("PROCESS")("ALIGN_FIT_SERVER")
>>"%LAUNCHER_TMP%" echo If Len(server) = 0 Then WScript.Quit 2
>>"%LAUNCHER_TMP%" echo If Not fso.FileExists(py) Then WScript.Quit 3
>>"%LAUNCHER_TMP%" echo If Not fso.FileExists(server) Then WScript.Quit 4
>>"%LAUNCHER_TMP%" echo cmd = Chr(34) ^& py ^& Chr(34) ^& " " ^& Chr(34) ^& server ^& Chr(34)
>>"%LAUNCHER_TMP%" echo sh.Run cmd, 0, False
>>"%LAUNCHER_TMP%" echo WScript.Quit 0
if not exist "%LAUNCHER_TMP%" (
    echo [ERROR] Temporary launcher was not created.
    exit /b 1
)
move /y "%LAUNCHER_TMP%" "%RUNTIME%\launcher.vbs" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] launcher.vbs could not be activated.
    exit /b 1
)
exit /b 0

:self_test
echo.
echo Running runtime/model self-test...
"%PY%" -c "import os,sys,struct,importlib.metadata as m,cv2,numpy as np; assert sys.version_info[:3]==(3,11,16) and struct.calcsize('P')==8; assert m.version('numpy')=='%NUMPY_VERSION%'; assert m.version('opencv-python')=='%OPENCV_VERSION%'; model=os.path.join(sys.prefix,'models'); h=os.path.join(model,'human.onnx'); f=os.path.join(model,'face.onnx'); assert os.path.isfile(h) and os.path.isfile(f); net=cv2.dnn.readNet(h); det=cv2.FaceDetectorYN.create(f,'',(320,320),0.6,0.3,5000); assert net is not None and det is not None; print('OK | Python',sys.version.split()[0],'| OpenCV',cv2.__version__,'| NumPy',np.__version__,'| Models',model)"
if errorlevel 1 (
    echo [ERROR] Runtime/model self-test failed.
    exit /b 1
)
exit /b 0

:download_verified
set "DV_URL1=%~1"
set "DV_URL2=%~2"
set "DV_OUT=%~3"
set "DV_HASH=%~4"
set "DV_NAME=%~5"
del /f /q "%DV_OUT%" >nul 2>&1
call :download_one "%DV_URL1%" "%DV_OUT%"
if not errorlevel 1 (
    call :verify_hash "%DV_OUT%" "%DV_HASH%"
    if not errorlevel 1 exit /b 0
    echo [WARN] %DV_NAME% downloaded from primary source but failed SHA-256 verification.
)
del /f /q "%DV_OUT%" >nul 2>&1
if not "%DV_URL2%"=="" (
    echo Trying fallback source for %DV_NAME%...
    call :download_one "%DV_URL2%" "%DV_OUT%"
    if not errorlevel 1 (
        call :verify_hash "%DV_OUT%" "%DV_HASH%"
        if not errorlevel 1 exit /b 0
        echo [WARN] %DV_NAME% downloaded from fallback source but failed SHA-256 verification.
    )
)
del /f /q "%DV_OUT%" >nul 2>&1
echo [ERROR] Failed to download a verified copy of %DV_NAME%.
exit /b 1

:download_one
set "DO_URL=%~1"
set "DO_OUT=%~2"
"%CURL%" --version >nul 2>&1
if not errorlevel 1 (
    "%CURL%" -L --fail --silent --show-error --retry 4 --connect-timeout 20 --max-time 600 --output "%DO_OUT%" "%DO_URL%"
    if not errorlevel 1 exit /b 0
    del /f /q "%DO_OUT%" >nul 2>&1
)
rem certutil is a fallback for Windows installations without curl.
certutil -urlcache -split -f "%DO_URL%" "%DO_OUT%" >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "%DO_OUT%" exit /b 1
exit /b 0

:verify_hash
if not exist "%~1" exit /b 1
setlocal EnableDelayedExpansion
set "VH_ACTUAL="
for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "%~1" SHA256 2^>nul') do if not defined VH_ACTUAL set "VH_ACTUAL=%%H"
set "VH_ACTUAL=!VH_ACTUAL: =!"
if /I "!VH_ACTUAL!"=="%~2" (
    endlocal & exit /b 0
)
endlocal & exit /b 1

:cleanup
if exist "%CACHE%" rmdir /s /q "%CACHE%" >nul 2>&1
if exist "%UV_STAGE%" rmdir /s /q "%UV_STAGE%" >nul 2>&1
if exist "%UV_ZIP_TMP%" del /f /q "%UV_ZIP_TMP%" >nul 2>&1
if exist "%HUMAN_TMP%" del /f /q "%HUMAN_TMP%" >nul 2>&1
if exist "%FACE_TMP%" del /f /q "%FACE_TMP%" >nul 2>&1
if exist "%LAUNCHER_TMP%" del /f /q "%LAUNCHER_TMP%" >nul 2>&1
if exist "%VERSION_TMP%" del /f /q "%VERSION_TMP%" >nul 2>&1
exit /b 0

:failed
call :cleanup
echo.
echo ==============================================
echo Installation failed or was cancelled.
echo ==============================================
echo Existing verified models and runtime files were not deliberately removed.
echo If the message mentions port 6320, close Photoshop or wait for AlignFit's

echo Python server to exit and run the installer again.
echo.
pause
exit /b 1
