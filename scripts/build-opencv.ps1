# Builds (and installs) the OpenCV 5.x wasm static libraries.
#
# Output: build/opencv-wasm/install/{include,lib}
#   lib/libopencv_core.a, libopencv_imgproc.a, libopencv_flann.a,
#   lib/libopencv_geometry.a, lib/libopencv_dnn.a, lib/libopencv_wechat_qrcode.a
#   + lib/libprotobuf.a, lib/libzlib.a (3rdparty) copied by the install step.
#
# Unless -FullDnn is given, modules/dnn/src/init.cpp is first trimmed to the layer
# registrations the bundled WeChat models need (tools/trim_dnn_registry.py). The dnn
# registry keeps every layer implementation reachable through a function pointer, so
# without the trim the wasm binary carries ~3.4 MB of layers this scan never uses.
param(
    [int]$Jobs = 0,
    [switch]$SkipConfigure,
    [switch]$Reconfigure,
    # Keep the complete dnn layer registry (supports arbitrary ONNX models, ~7.8 MB wasm).
    [switch]$FullDnn,
    [string]$OpenCVSrc = $env:OPENCV_SRC,
    [string]$BuildDir
)

$ErrorActionPreference = 'Stop'
# _env.ps1 writes $script:RepoRoot/$script:OpenCvBuild into this same script scope, and
# PowerShell variable names are case-insensitive, so snapshot the parameters first.
$paramOpenCVSrc = $OpenCVSrc
$paramBuildDir = $BuildDir
. "$PSScriptRoot\_env.ps1"
if ($paramOpenCVSrc) { $OpenCVSrc = $paramOpenCVSrc } else { $OpenCVSrc = $script:OpenCvSrc }
if ($paramBuildDir) {
    $BuildDir = $paramBuildDir
} else {
    $BuildDir = $script:OpenCvBuild
}
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }

if (-not $FullDnn) {
    $trimScript = Join-Path $script:RepoRoot 'tools\trim_dnn_registry.py'
    if (-not (Test-Path $trimScript)) { throw "trim script not found: $trimScript" }
    Write-Host "Trimming unused dnn layer registrations (use -FullDnn to keep all of them)"
    & python $trimScript --opencv $OpenCVSrc
    if ($LASTEXITCODE -ne 0) { throw "dnn registry trim failed (exit $LASTEXITCODE)" }
}

if (-not $SkipConfigure -or $Reconfigure) {
    & "$PSScriptRoot\configure-opencv.ps1" -OpenCVSrc $OpenCVSrc -BuildDir $BuildDir -Reconfigure:$Reconfigure
} elseif (-not (Test-Path (Join-Path $BuildDir 'build.ninja'))) {
    & "$PSScriptRoot\configure-opencv.ps1" -OpenCVSrc $OpenCVSrc -BuildDir $BuildDir
}

if (-not (Get-Command ninja.exe -ErrorAction SilentlyContinue)) {
    $ninja = (& python -c "import shutil,sys; p=shutil.which('ninja'); sys.stdout.write(p or '')").Trim()
    if (-not $ninja) { throw "ninja not found. Install it: python -m pip install ninja" }
}

Write-Host "Building OpenCV wasm (jobs=$Jobs) -> $BuildDir"
& cmake.exe --build $BuildDir --parallel $Jobs
if ($LASTEXITCODE -ne 0) {
    throw "OpenCV wasm build failed (exit $LASTEXITCODE)"
}

Write-Host "Installing OpenCV wasm headers + libs"
& cmake.exe --build $BuildDir --target install
if ($LASTEXITCODE -ne 0) {
    throw "OpenCV wasm install failed (exit $LASTEXITCODE)"
}

$libDir = Join-Path $BuildDir 'install\lib'
if (-not (Test-Path $libDir)) { throw "install/lib not found after install: $libDir" }
Get-ChildItem $libDir -Filter *.a | ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length/1KB,1)) KB" }
Write-Host "OpenCV wasm libs ready in $libDir"
