# Links src/wq_wasm.cpp against the OpenCV wasm static libraries and produces
#   dist/wq.js   (ES module factory, MODULARIZE + EXPORT_ES6)
#   dist/wq.wasm
#
# Requires build/opencv-wasm/install (run scripts/build-opencv.ps1 first).
param(
    [string]$OpenCvBuild,
    [string]$OutDir,
    [ValidateSet('Debug', 'Release')]
    [string]$Mode = 'Release',
    [string]$Optimization = '-O3'
)

$ErrorActionPreference = 'Stop'
# _env.ps1 defines $script:RepoRoot/$script:OpenCvBuild/$script:DistDir in this same
# script scope, so snapshot the parameters first (case-insensitive names would be
# overwritten by the dot-source) and restore them afterwards.
$paramOpenCvBuild = $OpenCvBuild
$paramOutDir = $OutDir
. "$PSScriptRoot\_env.ps1"
if ($paramOpenCvBuild) { $OpenCvBuild = $paramOpenCvBuild } else { $OpenCvBuild = $script:OpenCvBuild }
if ($paramOutDir) { $OutDir = $paramOutDir } else { $OutDir = $script:DistDir }

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

$src = Join-Path $RepoRoot 'src\wq_wasm.cpp'
if (-not (Test-Path $src)) { throw "missing wrapper source: $src" }

$outFile = Join-Path $OutDir 'wq.js'

Push-Location $RepoRoot
try {
    $emxx = 'em++.exe'
    $cmd = @($src) + @('-I', $includeDir) + @(
        '-Wl,--start-group'
    ) + $linkLibs + $thirdPartyLibs + @(
        '-Wl,--end-group'
    ) + $flags + @('-o', $outFile)
    Write-Host "Linking wasm module"
    Invoke-Exe $emxx $cmd

    $wasmFile = Join-Path $OutDir 'wq.wasm'
    if (-not (Test-Path $wasmFile)) { throw "expected $wasmFile to be produced" }
    Write-Host ("Built {0} ({1:N0} bytes) and {2} ({3:N0} bytes)" -f `
        'wq.wasm', (Get-Item $wasmFile).Length, 'wq.js', (Get-Item $outFile).Length)
} finally {
    Pop-Location
}
