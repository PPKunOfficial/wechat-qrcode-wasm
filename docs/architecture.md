# 架构

## 总览

```
                    ┌──────────────────────────────────────────────┐
  浏览器/Worker/Node │  web/scanner.js  (ESM 封装)                   │
                    │  · 加载 dist/wq.js，把 .onnx 写进 MEMFS       │
                    │  · 像素归一化 → malloc 帧缓冲 → _wq_scan      │
                    │  · JSON 解析结果；可选重叠切图兜底            │
                    └───────────────┬──────────────────────────────┘
                                    │ wasm 边界（C ABI）
                    ┌───────────────▼──────────────────────────────┐
                    │  src/wq_wasm.cpp                             │
                    │  wq_init / wq_scan / wq_result_json / …      │
                    └───────────────┬──────────────────────────────┘
                                    │ C++ 静态链接
   ┌────────────────────────────────▼───────────────────────────────────┐
   │  wechat_qrcode（opencv_contrib 5.x，原样迁入）                      │
   │    ① SSDDetector：dnn 跑 detect.onnx（单通道 384×384 输入）        │
   │    ② Align：按 10% padding 裁剪候选框                               │
   │    ③ 多个 scale（1.0 / 2.0 / 0.5）依次尝试                          │
   │    ④ SuperScale：dnn 跑 sr.onnx（2× 超分，仅裁剪图 < 160px 时）      │
   │    ⑤ zxing 解码器组：4 种二值化器轮询 + Reed-Solomon              │
   │    ⑥ 角点回投（warpBack）、按 10px 去重                             │
   └────────────────────────────────┬───────────────────────────────────┘
                                    │
   OpenCV 5.x wasm 静态库：dnn(protobuf ONNX 解析) / geometry / imgproc / flann / core
```

C++ 侧一行代码都没改算法：`third_party/opencv_modules/wechat_qrcode/src` 就是 opencv_contrib 5.x 的副本，只有模块的 `CMakeLists.txt` 和两个 ONNX 模型做了适配（见后）。

## 调用链

```js
scanner.scan(canvas)
  → toPixels()            // 归一化成 {data, width, height, format, stride}
  → scanPixels()
      → ensureFrameBuffer()  // 堆缓冲，容量够就复用
      → _wq_scan(ptr, w, h, stride, format, scaleFactor)
            → cv::Mat(gray/rgb/rgba/bgr) 包装同一块内存（零拷贝）
            → cvtColor(..., COLOR_x2GRAY)（灰度输入跳过）
            → WeChatQRCode::detectAndDecode(gray, quads)
            → 结果写成 JSON 到静态 std::string
      → UTF8ToString(_wq_result_json()) + JSON.parse
  → （可选）scanTiles()   // 整图无结果时，2×2 重叠块重扫
```

`wq_scan` 返回 JSON 长度（或 -1），结果字符串通过 `wq_result_json()` 再取一次；这样 JS 侧不需要预分配输出缓冲，也不依赖 Emscripten 的绑定生成器。

## C API（`src/wq_wasm.cpp`）

| 导出 | 说明 |
| --- | --- |
| `int wq_init(const char* detectPath, const char* srPath)` | 构造 `WeChatQRCode`；`srPath` 传空串则关闭超分。返回 0 / -1 |
| `int wq_scan(const uint8_t* data, int w, int h, int stride, int format, float scaleFactor)` | 扫描；`format`：0=GRAY 1=RGB 2=RGBA 3=BGR；返回 JSON 字节数 / -1 |
| `const char* wq_result_json()` | 最近一次成功结果：`{"ok":true,"width":..,"height":..,"ms":..,"count":N,"results":[{"text":"...","points":[[x,y]×4]}]}` |
| `const char* wq_last_error()` | 最近一次异常文本 |
| `void wq_reset()` | 销毁扫描器、释放模型 |
| `const char* wq_opencv_version()` | 编译进 wasm 的 `CV_VERSION` |

异常处理：`wq_init`/`wq_scan` 内部 `try/catch` 住 `cv::Exception` 与 `std::exception`，所以 wasm 不会 trap（Emscripten 用 `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0`，异常能正常穿过 C++ 层）。

## 关键适配

### 1. 为什么不用 opencv.js

官方 `opencv.js` 的模块集合固定，**不含 `wechat_qrcode`**，也不含它的依赖链（`geometry`、`dnn` 的 ONNX 导入器常被裁掉）。如果基于 opencv.js，要么重编整份 opencv.js（体积 8 MB+ 且带一堆用不到的模块），要么自己写绑定。这里改为：`BUILD_LIST` 只留 `core,imgproc,flann,geometry,dnn,wechat_qrcode`，再用 ~200 行 C API 替代 JS 绑定层，最终 7.4 MB wasm（其中 dnn 的 protobuf 解析器占大头）。

### 2. 模块 CMakeLists 的改动

`third_party/opencv_modules/wechat_qrcode/CMakeLists.txt`：

- 去掉 `opencv_objdetect` 依赖。上游声明了它，但 `src/` 里没有任何 `#include <opencv2/objdetect*>`，去掉可省一整个模块。
- 去掉 `WRAP java objc python js`（用自写 C API）。
- 去掉 5.x 里已经失效的 caffe 模型下载（5.x 的 `SSDDetector::init` / `SuperScale::init` 只读 ONNX，`dnn_read.cpp` 里 Caffe importer 已被移除）。

### 3. 模型：detect 不用改，sr 必须打补丁

- `detect.onnx`：官方文件原样使用。它内部有固化的 `Reshape` 形状（`[1,6912]`、`[1,13824]` …），但 OpenCV 5.x 的 `Reshape2` 有旧模型兼容逻辑（2 维形状且与输入元素数不符时退化为 `(1, total)`），所以模块用任意尺寸（`min(1, 400/hypot(w,h))` 缩放后）喂它都能跑。`PriorBox` / `DetectionOutput` 两个自定义层也早已改成动态推导形状。
- `sr.onnx`：必须换成 `tools/patch_sr_model.py` 生成的版本。Caffe 的 `Crop` 层在转 ONNX 时被固化成 `Slice(ends=[447,447])`，只在 224×224 输入时成立；而模块会把任意大小的二维码裁剪图喂进来（`SuperScale::processImageScale` 用 `Size(src.cols, src.rows)` 做 blob）。补丁把 `ends` 改成 `[-1,-1]`（ONNX 负索引 = `dim-1`，正好等于反卷积分支输出 `2H-1`），输入输出维度改成符号维度。补丁后 224 输入与原始模型逐位一致。

脚本可重复生成，`models/upstream/` 保留原始文件以便对比。

### 4. Emscripten 文件系统

`WeChatQRCode` 构造函数用 `CV_Assert(utils::fs::exists(path))` 校验模型路径。OpenCV 在 `__EMSCRIPTEN__` 下默认关闭文件系统支持（`filesystem.private.hpp` 写死为 0 → `fs::exists` 是抛异常的桩），所以构建时加 `-DOPENCV_HAVE_FILESYSTEM_SUPPORT=1`，让 POSIX 实现编译进来去 `stat()` MEMFS。JS 侧 `FS.writeFile('/models/detect.onnx', bytes)` 之后按路径传参即可——不需要改模块源码，也不需要把模型编进二进制（模型独立 fetch，可缓存、可替换）。

### 4.5 多码识别

`SSDDetector::forward` 解析 `DetectionOutput` 的每一行候选框（`keep_top_k = 100`），`Impl::decode` 再对每个候选框裁剪、多尺度解码，所以"一帧多码"是上游本来的能力，`detectAndDecode` 返回的 `vector<string>` / 角点本来就是多结果的。C API 只是把数组完整塞进 JSON：

```json
{"ok":true,"count":3,"results":[{"text":"...","points":[[x,y],...]}, ...]}
```

本仓库没有改这段逻辑，只补了回归覆盖（2 码 / 3 码 / 同码重复 / 3×3 九宫格）与文档。注意上游去重按角点距离 10px，同内容的两张码会保留两条结果。

### 5. 切图兜底（JS 层，不改算法）

检测网络先把整帧缩到约 400×400（`targetArea = 400*400`）再推理。1920×1080 的一帧里，远处的二维码可能只剩 10~20 像素，检测器直接漏掉。`scan(..., {tiles: 2})` 在整图无结果时把原图切成 2×2、20% 重叠的块分别送进同一条 C++ 管线，再把块内坐标加回全图坐标。因为没有任何阈值改动、模型也没变，它只是把"同一个算法"作用在更有利的尺度上；不开启时行为与上游完全一致。

这也是基准里 `hard_url_far*` 能解出的原因。默认关闭以保持实时性能。

### 6. 单线程

构建不启用 pthread（`-pthread`/`SharedArrayBuffer` 都不需要），所以可以在任何静态托管上跑、也不需要 COOP/COEP 响应头。OpenCV 的 `Parallel framework: none`。代价是 `dnn::forward` 单线程执行，一帧 60~70 ms。

如果要更快：`-msimd128`（需要较新浏览器）、`-O3 -flto`、或把预览分辨率降到 640×480。`scripts/build-wasm.ps1 -Optimization -Os` 可以换体积优化，代价是速度。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/wq_wasm.cpp` | C ABI 包装：生命周期、像素格式、JSON 输出 |
| `web/scanner.js` | 浏览器侧封装：模型注入、帧缓冲、输入归一化、切图、结果解析 |
| `third_party/opencv_modules/wechat_qrcode` | 上游模块源码（含 zxing 移植），仅改 `CMakeLists.txt` |
| `models/` | ONNX 模型（detect 官方、sr 修补版）+ 原始文件 + license |
| `scripts/` | 取源码、配置/编译 OpenCV、链接 wasm、静态服务器、一键构建 |
| `tools/` | 模型下载/修补、测试集生成（Python） |
| `tests/` | Node 冒烟/准确率/基准、浏览器自动化、生成的测试图 |
| `demo/` | 摄像头扫码页面（真实浏览器验证过） |
| `docs/` | 构建、API、架构文档 |

## 与上游的差异一览

| 项 | 上游 opencv_contrib 5.x | 本仓库 |
| --- | --- | --- |
| 平台 | 桌面/移动原生 | wasm32（浏览器/Worker/Node） |
| 模块依赖 | 声明 objdetect | 去掉（源码未使用） |
| 语言绑定 | java/objc/python/js | 自写 C API + ESM 封装 |
| 模型 | 运行时传 caffe→ONNX 路径 | 官方 ONNX 随仓库分发；sr 打动态尺寸补丁 |
| 文件系统 | 桌面 stat | 打开 `OPENCV_HAVE_FILESYSTEM_SUPPORT` + MEMFS |
| 小码检测 | 仅整图缩放 | 额外提供 JS 切图兜底（可选） |
| 线程 | 可用 | 单线程 |
