# Configures the OpenCV 5.x static build for wasm32 with Emscripten.
#
# Result: build/opencv-wasm (Ninja), containing static libs for
#   core, imgproc, flann, geometry, dnn + the vendored wechat_qrcode module.
#
# Only the modules needed by the WeChat QRCode pipeline are built: everything else
# (objdetect/calib3d/features2d/highgui/videoio/imgcodecs/ml/...) is left out to keep
# the wasm binary small.
param(
    [string]$OpenCVSrc = $env:OPENCV_SRC,
    [string]$BuildDir,
    [switch]$Reconfigure,
    # Minimal-size profile (used for the release `wq.min.*` artifact): compile with -Os and
    # put every function/data in its own section, so the wasm link (-Wl,--gc-sections) can
    # drop the OpenCV dnn layers and core helpers that the QRCode pipeline never calls.
    [switch]$MinSize
)

$ErrorActionPreference = 'Stop'
# Capture the explicit parameter before dot-sourcing: PowerShell variable names are
# case-insensitive, so _env.ps1's $script:OpenCvSrc would clobber $OpenCVSrc otherwise.
$paramOpenCVSrc = $OpenCVSrc
$paramBuildDir = $BuildDir
. "$PSScriptRoot\_env.ps1"
if ($paramOpenCVSrc) { $OpenCVSrc = $paramOpenCVSrc } else { $OpenCVSrc = $script:OpenCvSrc }
if ($paramBuildDir) { $BuildDir = $paramBuildDir } else { $BuildDir = $script:OpenCvBuild }

if (-not (Test-Path (Join-Path $OpenCVSrc 'CMakeLists.txt'))) {
    throw "OpenCV source not found at '$OpenCVSrc'. Set OPENCV_SRC or run scripts/fetch-opencv.ps1."
}

$modulesPath = Join-Path $RepoRoot 'third_party\opencv_modules'
if ($Reconfigure -and (Test-Path $BuildDir)) {
    Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Force $BuildDir | Out-Null

# Release (default): -O2, faster decode. MinSize: -Os + one section per symbol; the linker
# then garbage-collects unused code, which is where most of the size win comes from.
if ($MinSize) {
    $buildType = 'MinSizeRel'
    $optimizationFlags = '-Os -DNDEBUG -ffunction-sections -fdata-sections'
} else {
    $buildType = 'Release'
    $optimizationFlags = '-O2'
}
$cFlags = "$optimizationFlags -DOPENCV_HAVE_FILESYSTEM_SUPPORT=1"

# Keep this list in sync with docs/build.md.
$cmakeArgs = @(
    '-G', 'Ninja'
    '-S', $OpenCVSrc
    '-B', $BuildDir
    '-DCMAKE_BUILD_TYPE=' + $buildType
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'
    '-DCMAKE_INSTALL_PREFIX=' + (Join-Path $BuildDir 'install')
    # C++17 is required by OpenCV 5.x; emscripten's default is fine but pin it for clarity.
    '-DCMAKE_CXX_STANDARD=17'
    '-DCMAKE_CXX_STANDARD_REQUIRED=ON'
    '-DOPENCV_EXTRA_MODULES_PATH=' + $modulesPath
    '-DBUILD_LIST=core,imgproc,flann,geometry,dnn,wechat_qrcode'
    '-DBUILD_SHARED_LIBS=OFF'
    '-DBUILD_opencv_world=OFF'
    '-DBUILD_opencv_apps=OFF'
    '-DBUILD_opencv_js=OFF'
    '-DBUILD_opencv_python2=OFF'
    '-DBUILD_opencv_python3=OFF'
    '-DBUILD_JAVA=OFF'
    '-DBUILD_OBJC=OFF'
    '-DBUILD_TESTS=OFF'
    '-DBUILD_PERF_TESTS=OFF'
    '-DBUILD_EXAMPLES=OFF'
    '-DBUILD_DOCS=OFF'
    '-DBUILD_PACKAGE=OFF'
    '-DBUILD_PROTOBUF=ON'
    '-DPROTOBUF_UPDATE_FILES=OFF'
    '-DWITH_PROTOBUF=ON'
    '-DBUILD_ZLIB=ON'
    '-DWITH_ZLIB=ON'
    # third-party backends & platform integrations: all off for wasm
    '-DWITH_1394=OFF'
    '-DWITH_ADE=OFF'
    '-DWITH_VTK=OFF'
    '-DWITH_EIGEN=OFF'
    '-DWITH_FFMPEG=OFF'
    '-DWITH_GSTREAMER=OFF'
    '-DWITH_GTK=OFF'
    '-DWITH_GTK_2_X=OFF'
    '-DWITH_IPP=OFF'
    '-DWITH_AVIF=OFF'
    '-DWITH_JASPER=OFF'
    '-DWITH_JPEG=OFF'
    '-DWITH_WEBP=OFF'
    '-DWITH_OPENEXR=OFF'
    '-DWITH_OPENJPEG=OFF'
    '-DWITH_PNG=OFF'
    '-DWITH_TIFF=OFF'
    '-DWITH_OPENCL=OFF'
    '-DWITH_OPENCL_SVM=OFF'
    '-DWITH_OPENCLAMDFFT=OFF'
    '-DWITH_OPENCLAMDBLAS=OFF'
    '-DWITH_OPENGL=OFF'
    '-DWITH_OPENNI=OFF'
    '-DWITH_OPENNI2=OFF'
    '-DWITH_V4L=OFF'
    '-DWITH_GPHOTO2=OFF'
    '-DWITH_LAPACK=OFF'
    '-DWITH_ITT=OFF'
    '-DWITH_TBB=OFF'
    '-DWITH_OPENMP=OFF'
    '-DWITH_PTHREADS_PF=OFF'
    '-DWITH_MSMF=OFF'
    '-DWITH_DSHOW=OFF'
    '-DWITH_QUIRC=OFF'
    '-DWITH_OPENVX=OFF'
    '-DWITH_VA=OFF'
    '-DWITH_VA_INTEL=OFF'
    '-DWITH_DIRECTX=OFF'
    '-DWITH_WIN32UI=OFF'
    '-DWITH_VULKAN=OFF'
    '-DWITH_OPENCL_D3D11_NV=OFF'
    '-DWITH_ENGINE=OFF'
    '-DWITH_WEBNN=OFF'
    '-DWITH_CANN=OFF'
    # WeChat QRCode: 5.x loads ONNX models at runtime, models are shipped by this repo.
    '-DOPENCV_WECHAT_QRCODE_URL='
    # wasm: no CPU dispatch/SIMD baseline (wasm SIMD would raise the browser requirement)
    '-DCV_ENABLE_INTRINSICS=OFF'
    '-DCPU_BASELINE='
    '-DCPU_DISPATCH='
    # OpenCV's filesystem.private.hpp hard-codes OPENCV_HAVE_FILESYSTEM_SUPPORT=0 under
    # __EMSCRIPTEN__, which turns cv::utils::fs::* into throwing stubs. The wechat_qrcode
    # constructor validates its model paths with utils::fs::exists(), so we opt the POSIX
    # implementation back in: Emscripten's libc exposes stat()/mkdir() over the MEMFS/IDBFS
    # filesystems, which is exactly where our JS glue writes the .onnx models.
    '-DCMAKE_C_FLAGS=' + $cFlags
    '-DCMAKE_CXX_FLAGS=' + $cFlags
    '-DCMAKE_EXE_LINKER_FLAGS='
)

Write-Host "Configuring OpenCV wasm build"
Write-Host "  source : $OpenCVSrc"
Write-Host "  build  : $BuildDir"
Write-Host "  modules: $modulesPath"

& emcmake.exe cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) {
    throw "OpenCV wasm configure failed (exit ${LASTEXITCODE})"
}
Write-Host "Configure OK -> $BuildDir"
