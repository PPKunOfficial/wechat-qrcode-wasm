# Links src/wq_wasm.cpp against the OpenCV wasm static libraries and produces
#   dist/wq.js   (ES module factory, MODULARIZE + EXPORT_ES6)
#   dist/wq.wasm
# With -MinSize it instead links the build/opencv-wasm-min libraries (-Os objects,
# one section per symbol + --gc-sections, emmalloc, closure-minified JS, wasm-opt -Oz)
# and writes dist/wq.min.js + dist/wq.min.wasm.
#
# Requires build/opencv-wasm/install (run scripts/build-opencv.ps1 first; -MinSize needs
# `scripts/build-opencv.ps1 -MinSize`).
param(
    [string]$OpenCvBuild,
    [string]$OutDir,
    [ValidateSet('Debug', 'Release', 'MinSize')]
    [string]$Mode = 'Release',
    # Minimal-size variant: same API/behaviour, smaller wasm at the cost of some speed.
    [switch]$MinSize,
    [string]$Optimization
)

$ErrorActionPreference = 'Stop'
# _env.ps1 defines $script:RepoRoot/$script:OpenCvBuild/$script:DistDir in this same
# script scope, so snapshot the parameters first (case-insensitive names would be
# overwritten by the dot-source) and restore them afterwards.
$paramOpenCvBuild = $OpenCvBuild
$paramOutDir = $OutDir
. "$PSScriptRoot\_env.ps1"
if ($MinSize) { $Mode = 'MinSize' }
if ($paramOpenCvBuild) {
    $OpenCvBuild = $paramOpenCvBuild
} elseif ($MinSize) {
    $OpenCvBuild = Join-Path $script:BuildRoot 'opencv-wasm-min'
} else {
    $OpenCvBuild = $script:OpenCvBuild
}
if ($paramOutDir) { $OutDir = $paramOutDir } else { $OutDir = $script:DistDir }
if (-not $Optimization) { $Optimization = if ($MinSize) { '-Os' } else { '-O3' } }
$baseName = if ($MinSize) { 'wq.min' } else { 'wq' }

$installDir = Join-Path $OpenCvBuild 'install'
$libDir = Join-Path $installDir 'lib'
# OpenCV 5.x installs headers under include/opencv5 and third-party static libs under
# lib/opencv5/3rdparty (with the historical `liblib<name>.a` double prefix).
$includeDir = Join-Path $installDir 'include\opencv5'
$thirdPartyDir = Join-Path $libDir 'opencv5\3rdparty'
if (-not (Test-Path $libDir)) {
    throw "OpenCV wasm install dir not found: $libDir. Run scripts/build-opencv.ps1 first."
}
if (-not (Test-Path $includeDir)) { throw "OpenCV wasm headers not found: $includeDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$linkLibs = @(
    'libopencv_wechat_qrcode.a'
    'libopencv_dnn.a'
    'libopencv_geometry.a'
    'libopencv_imgproc.a'
    'libopencv_flann.a'
    'libopencv_core.a'
) | ForEach-Object { Join-Path $libDir $_ }

# dnn needs protobuf (ONNX parser) and zlib; imgproc's text drawing links harfbuzz.
$thirdPartyLibs = @(
    'liblibprotobuf.a'
    'libzlib.a'
    'liblibharfbuzz.a'
) | ForEach-Object { Join-Path $thirdPartyDir $_ } | Where-Object { Test-Path $_ }

foreach ($lib in ($linkLibs + $thirdPartyLibs)) {
    if (-not (Test-Path $lib)) { throw "missing static library: $lib" }
}

$exportedFunctions = @(
    '_malloc'
    '_free'
    '_wq_init'
    '_wq_scan'
    '_wq_result_json'
    '_wq_last_error'
    '_wq_reset'
    '_wq_opencv_version'
) -join ','

$exportedRuntimeMethods = @(
    'FS'
    'UTF8ToString'
    'stringToUTF8'
    'lengthBytesUTF8'
    'getValue'
    'HEAPU8'
) -join ','

$flags = @(
    $Optimization
    '-std=c++17'
    '--no-entry'
    '-fexceptions'
    '-sDISABLE_EXCEPTION_CATCHING=0'
    '-sMODULARIZE=1'
    '-sEXPORT_ES6=1'
    '-sEXPORT_NAME=createWeChatQRCodeModule'
    '-sALLOW_MEMORY_GROWTH=1'
    '-sINITIAL_MEMORY=67108864'
    '-sMAXIMUM_MEMORY=2147483648'
    '-sSTACK_SIZE=5242880'
    '-sFORCE_FILESYSTEM=1'
    '-sENVIRONMENT=web,worker,node'
    "-sEXPORTED_FUNCTIONS=$exportedFunctions"
    "-sEXPORTED_RUNTIME_METHODS=$exportedRuntimeMethods"
    '-sASSERTIONS=0'
)
if ($Mode -eq 'Debug') {
    $flags += @('-sASSERTIONS=1', '-g', '-sSAFE_HEAP=1')
}
if ($Mode -eq 'MinSize') {
    # --gc-sections only pays off because the OpenCV libs were compiled with
    # -ffunction-sections/-fdata-sections (scripts/configure-opencv.ps1 -MinSize).
    $flags += @('-Wl,--gc-sections', '-sMALLOC=emmalloc', '--closure', '1')
}

$src = Join-Path $RepoRoot 'src\wq_wasm.cpp'
if (-not (Test-Path $src)) { throw "missing wrapper source: $src" }

$outFile = Join-Path $OutDir "$baseName.js"
$wasmFile = Join-Path $OutDir "$baseName.wasm"

Push-Location $RepoRoot
try {
    $emxx = 'em++.exe'
    $cmd = @($src) + @('-I', $includeDir) + @(
        '-Wl,--start-group'
    ) + $linkLibs + $thirdPartyLibs + @(
        '-Wl,--end-group'
    ) + $flags + @('-o', $outFile)
    Write-Host "Linking wasm module ($Mode)"
    Invoke-Exe $emxx $cmd

    if (-not (Test-Path $wasmFile)) { throw "expected $wasmFile to be produced" }

    # Note: Emscripten already runs binaryen (wasm-opt) with the right feature flags for
    # -Oz/-Os; running wasm-opt by hand needs the exact feature set (bulk-memory, EH, ...)
    # and produces an invalid module when guessed wrong, so we don't post-process here.

    Write-Host ("Built {0} ({1:N0} bytes) and {2} ({3:N0} bytes)" -f `
        (Split-Path $wasmFile -Leaf), (Get-Item $wasmFile).Length, (Split-Path $outFile -Leaf), (Get-Item $outFile).Length)
} finally {
    Pop-Location
}
