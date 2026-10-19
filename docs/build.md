# 构建说明

本仓库把 OpenCV 5.x 的 `core / imgproc / flann / geometry / dnn` 与 `wechat_qrcode` 模块交叉编译成 wasm32 静态库，再用一个精简 C API（`src/wq_wasm.cpp`）链接成 `dist/wq.js` + `dist/wq.wasm`。

产物已经在 `dist/` 里，只想用的话不需要构建；需要重新构建（换 OpenCV 版本、改 `src/wq_wasm.cpp`、调优化级别）时按下面步骤来。

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | `scripts/serve.mjs`、测试/基准脚本 |
| Python 3 | `tools/*.py`（仅重新生成模型/测试集时需要，装 `onnx`、`numpy`、`pillow`、`segno`） |
| CMake ≥ 3.5 + Ninja | OpenCV 的构建系统 |
| [emsdk](https://github.com/emscripten-core/emsdk) 6.x | 实际使用 6.0.12-git 验证 |
| OpenCV 5.x 源码 | 默认读 `.cache/opencv`，可用 `OPENCV_SRC` 覆盖 |

脚本用 PowerShell 7（`pwsh`）编写，路径都用 Windows 形式。`scripts/_env.ps1` 是公共环境：定位 `emcc.exe`、生成 `.emscripten` 配置、把 emsdk 的 `upstream/emscripten`、`upstream/bin`、node、python 放到 `PATH` 最前。

```powershell
# emsdk 不在仓库同级的 ../emsdk 时，显式指定
$env:EMSDK_DIR = 'C:\dev\emsdk'
# OpenCV 源码已有 checkout 时（否则 fetch-opencv.ps1 会 clone 到 .cache/opencv）
$env:OPENCV_SRC = 'C:\dev\opencv'
```

## 步骤

```powershell
# 1) 取 OpenCV 5.x 源码（已有则跳过，用 .cache/opencv）
.\scripts\fetch-opencv.ps1

# 2) 配置（生成 build/opencv-wasm）
.\scripts\configure-opencv.ps1
#    改了 BUILD_LIST / 模块集合 / 关键 cache 变量后必须重新配置，且要用干净目录：
#    .\scripts\configure-opencv.ps1 -Reconfigure

# 3) 编译 + 安装（产出 build/opencv-wasm/install）
.\scripts\build-opencv.ps1            # 需要时加 -Jobs 20

# 4) 链接 wasm（产出 dist/wq.js、dist/wq.wasm）
.\scripts\build-wasm.ps1
```

耗时参考（24 核机器）：配置约 5 分钟，OpenCV 编译+安装约 2 分钟（626 个 target），链接约 30 秒。

也可以用 npm 脚本：`npm run build:opencv`、`npm run build:wasm`。

## 构建配置要点

`scripts/configure-opencv.ps1` 里的 `BUILD_LIST` 只包含必要模块：

```
core,imgproc,flann,geometry,dnn,wechat_qrcode
```

其余模块（`objdetect/calib3d/features2d/highgui/videoio/imgcodecs/...`）全部不编译。`wechat_qrcode` 的上游 CMakeLists 声明了 `opencv_objdetect` 依赖，但源码里并没有用到；`third_party/opencv_modules/wechat_qrcode/CMakeLists.txt` 已把这个依赖去掉（见 [architecture.md](architecture.md#1-为什么不用-opencvjs)）。

关键 flag：

| Flag | 原因 |
| --- | --- |
| `-DBUILD_LIST=...` | 只编译依赖链上的模块，控制体积 |
| `-DOPENCV_EXTRA_MODULES_PATH=<repo>/third_party/opencv_modules` | 让 OpenCV 构建系统发现迁入的 `wechat_qrcode` |
| `-DBUILD_PROTOBUF=ON -DPROTOBUF_UPDATE_FILES=OFF` | dnn 的 ONNX 解析需要 protobuf；预生成的 `opencv-onnx.pb.*` 已随源码提供，**不需要宿主机的 protoc** |
| `-DCMAKE_C_FLAGS/-DCMAKE_CXX_FLAGS=-O2 -DOPENCV_HAVE_FILESYSTEM_SUPPORT=1` | 见下 |
| `-DCV_ENABLE_INTRINSICS=OFF -DCPU_BASELINE= -DCPU_DISPATCH=` | wasm 没有 OpenCV 的 universal-intrinsics 后端；开 SIMD 只会抬高浏览器要求 |
| `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` | OpenCV 5.x 的 3rdparty CMake 脚本对 CMake 4.x 有旧 policy 兼容问题 |
| `-DOPENCV_WECHAT_QRCODE_URL=` | 5.x 已经不用 caffe 模型，关闭配置期的模型下载 |

### 为什么必须 `OPENCV_HAVE_FILESYSTEM_SUPPORT=1`

`modules/core/include/opencv2/core/utils/filesystem.private.hpp` 在 `__EMSCRIPTEN__` 下把 `OPENCV_HAVE_FILESYSTEM_SUPPORT` 写死为 0，于是 `cv::utils::fs::exists()` 等函数是抛 `StsNotImplemented` 的桩。而 `WeChatQRCode` 构造函数第一件事就是：

```cpp
CV_Assert(utils::fs::exists(detector_model_path));
```

不打开文件系统就会在 `wq_init` 直接抛异常。Emscripten 的 libc 提供 `stat()/mkdir()` 覆盖 MEMFS，所以把宏强制设为 1 后 POSIX 实现可用，JS 侧把 `.onnx` 写入 MEMFS `/models/` 即可按路径加载。

注意：该宏在头文件里被 `#ifndef` 保护，命令行 `-D` 定义的优先。

### `build-wasm.ps1` 的链接参数

- 安装目录布局（OpenCV 5.x 与 4.x 不同）：头文件在 `install/include/opencv5/opencv2/...`；模块库在 `install/lib/libopencv_*.a`；第三方静态库在 `install/lib/opencv5/3rdparty/`，且名字带双 `lib` 前缀（`liblibprotobuf.a`、`libzlib.a`、`liblibharfbuzz.a`）。
- 静态库用 `-Wl,--start-group ... -Wl,--end-group` 包住，避免循环依赖。
- Emscripten 关键 flag：`-fexceptions -sDISABLE_EXCEPTION_CATCHING=0`（OpenCV 用 `cv::Exception`，必须让异常穿过 wasm 边界）、`-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWeChatQRCodeModule`、`-sFORCE_FILESYSTEM=1`、`-sALLOW_MEMORY_GROWTH=1`、`-sINITIAL_MEMORY=67108864`、`-sSTACK_SIZE=5242880`、`-sENVIRONMENT=web,worker,node`。
- 链接完成后 `dist/wq.wasm` 约 7.4 MB（gzip 1.65 MB），`dist/wq.js` 约 70 KB。

### 最小体积构建（min profile）

`dist/wq.min.*` 是用同一份源码、换成"体积优先"的编译/链接参数产出的，API 和准确率与标准版完全一致，单帧耗时约 +45%：

```powershell
.\scripts\build-opencv.ps1 -MinSize   # 配置到 build/opencv-wasm-min，-Os + 符号分段
.\scripts\build-wasm.ps1 -MinSize     # 产物 dist/wq.min.js + dist/wq.min.wasm
# 或：npm run build:min
```

| 环节 | 标准版 | 最小体积版 | 作用 |
| --- | --- | --- | --- |
| OpenCV 编译 | `-O2` | `-Os -DNDEBUG -ffunction-sections -fdata-sections` | 每个函数/数据单独成段，给下一步的裁剪提供粒度 |
| wasm 链接 | `-O3` | `-Oz` + `-Wl,--gc-sections` | 丢掉扫码路径调用不到的 OpenCV dnn 层/工具函数（最大的一笔收益） |
| 内存分配器 | 默认 dlmalloc | `-sMALLOC=emmalloc` | 更小的分配器实现 |
| JS 胶水 | 原样 | `--closure 1` | `wq.js` 71 KB → 35 KB（gzip 19 KB → 13 KB） |

实测（24 核机器，同一台）：`wq.wasm` 7,803,995 → 5,942,478 字节（−24%），gzip 1,730,016 → 1,374,364（−21%）；29 张测试集准确率不变（默认 27/29，`tiles: 2` 时 28/29）。不要手工在 Emscripten 产物上再跑 `wasm-opt`：需要精确的 feature 集合（bulk-memory、exception-handling 等），猜错会生成 ID 非法的模块、浏览器直接 `CompileError`；`-Oz` 已经让 Emscripten 用正确的参数调过 binaryen 了。

注意：最小版把 OpenCV 编译到单独的 `build/opencv-wasm-min/`，不会覆盖标准版的 `build/opencv-wasm/`，两套产物可以并存。

## 常见坑

1. **改了 `BUILD_LIST` 或模块集合后必须清空 build 目录。** CMake 的 `option(BUILD_opencv_<module>)` 会把第一次配置的结果存进 cache，重新配置时沿用旧值。第一次配置失败（例如源码是 sparse checkout 缺少 `include/doc/docs_sphinx` 子目录）也会留下 `BUILD_opencv_dnn=OFF` 之类的缓存，表现为 whitelist 正确但 `Disabled: dnn imgproc wechat_qrcode`。用 `-Reconfigure`（会删 `build/opencv-wasm`）重来。
2. **OpenCV 源码不能是 sparse checkout。** 顶层 `CMakeLists.txt` 会 `add_subdirectory(include/doc/docs_sphinx)`，缺目录会直接报 `add_subdirectory given source "include" which is not an existing directory`。
3. **PowerShell 变量名不区分大小写。** `scripts/_env.ps1` 被 dot-source 后，它定义的 `$script:OpenCvSrc` / `$script:OpenCvBuild` 会覆盖同名脚本参数（`$OpenCVSrc`）。各脚本在 dot-source 前先把参数存到 `$paramXxx`，之后再恢复。
4. **emsdk 的 `emsdk install latest` 在本机不可用**（python 下载卡在 0 字节）。手工方案：curl 下载
   `https://storage.googleapis.com/webassembly/emscripten-releases-builds/win/<hash>/wasm-binaries.zip`（约 700 MB），解压后的 `install/` 目录改名为 `upstream/`，再手写 `D:\projects\emsdk\.emscripten`：

   ```python
   LLVM_ROOT = '$CFGDIR/upstream/bin'
   BINARYEN_ROOT = '$CFGDIR/upstream'
   NODE_JS = '$CFGDIR/node/24.19.0_64bit/node.exe'
   ```

   写文件时注意 PowerShell here-string：`@"..."@` 会把 `$CFGDIR` 展开成空串，必须用 `@'...'@`（单引号）。
5. **模型**：`models/detect.onnx` 用官方文件；`models/sr.onnx` 必须是由 `tools/patch_sr_model.py` 生成的动态尺寸版本，用原始 sr 模型会在非 224 尺寸的裁剪图上因 `Slice`/`ConvTranspose` 形状不一致而抛异常。

## 重新生成测试资产

```bash
npm run assets            # 需要 python + segno + pillow + numpy
node tests/run-tests.mjs  # Node 冒烟 + 准确率
node tests/benchmark.mjs  # 与 zxing-wasm / jsQR 对比
npm run test:browser      # 真实 Chrome 自动化（puppeteer-core）
```

测试图会写到 `tests/assets/`（png + 原始 RGBA + `manifest.json`），体积约 94 MB，已被 `.gitignore` 忽略；`manifest.json` 里带每张图的 payload 和标签，`tests/_harness.mjs` 负责加载。跑最小体积版用 `node tests/run-tests.mjs --variant min`（或 `npm run test:min`）。
