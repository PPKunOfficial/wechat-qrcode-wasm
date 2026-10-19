# Fetches the OpenCV 5.x source tree used by the wasm build into .cache/opencv.
# Skip this script if $env:OPENCV_SRC already points at an OpenCV 5.x checkout.
param(
    [string]$Ref = '5.x',
    [string]$Dest
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_env.ps1"

if (-not $Dest) { $Dest = $OpenCvSrc }

if (Test-Path (Join-Path $Dest 'CMakeLists.txt')) {
    Write-Host "OpenCV source already present at $Dest"
    exit 0
}

New-Item -ItemType Directory -Force (Split-Path $Dest -Parent) | Out-Null
Invoke-Exe 'git' @('clone', '--depth', '1', '--branch', $Ref, 'https://github.com/opencv/opencv.git', $Dest)
Write-Host "cloned OpenCV $Ref into $Dest"
