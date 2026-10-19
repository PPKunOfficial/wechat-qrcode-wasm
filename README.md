# wechat_qrcode · WebAssembly

把 **OpenCV 5.x 的 `wechat_qrcode` 模块**（微信扫码同款算法：SSD 神经网络检测 + 超分辨率 + zxing 多二值化解码）完整编译成 WebAssembly，供前端在浏览器 / Web Worker / Node 中调用。没有原生插件、没有 ONNX Runtime：推理跑在 OpenCV 自己的 `dnn` 模块里，纯 WASM。

- 上游代码路径保持原样（`third_party/opencv_modules/wechat_qrcode` 是从 opencv_contrib 5.x 迁入的副本，只改 CMakeLists 与一个模型补丁，见 [与上游的差异](#与上游的差异)）。
- 官方 ONNX 模型随仓库提供：`models/detect.onnx`（985 KB）+ `models/sr.onnx`（26 KB）。
- 单线程构建：不需要 `SharedArrayBuffer`、不需要 COOP/COEP 响应头，任何静态托管都能跑，也能放进 Worker。
- 提供 demo 摄像头扫码页、Node 准确率基准（对比 zxing-wasm / jsQR）、浏览器端自动化验证。

> 本仓库不是 opencv.js 的封装。opencv.js 不包含 `wechat_qrcode`，而这里编译了它依赖的 `core/imgproc/flann/geometry/dnn` 与模块本体，并用一份精简的 C API（`src/wq_wasm.cpp`）替代 opencv.js 的绑定层。

## 效果

同一份测试集（`tests/assets`，29 张，含干净参考集 + 刻意刁钻的 hard 档：远景小码、失焦、夜景、眩光、强透视、二次压缩），三个解码器吃完全相同的 RGBA 像素：

| 解码器 | 总体 | 干净集 | hard 档 | 平均耗时（Node） |
| --- | --- | --- | --- | --- |
| **本仓库 wechat_qrcode（tiles=2）** | **28/29 (97%)** | **5/5** | **9/10** | 95 ms |
| 本仓库 wechat_qrcode（默认，不切图） | 27/29 (93%) | 5/5 | 8/10 | 78 ms |
| zxing-wasm（tryHarder + tryRotate + tryDownscale） | 25/29 (86%) | 5/5 | 6/10 | 4.0 ms |
| jsQR | 25/29 (86%) | 5/5 | 6/10 | 83 ms |

完整逐图结果见 [BENCHMARK.md](BENCHMARK.md)（`npm run bench` 可复现）。

要点：

- **hard 档差距即微信算法价值所在**：`hard_url_far_blur`（50px 小码 + 模糊）、`hard_text_zh_defocus`（失焦 2.8）、`hard_long_night`（亮度 ×0.22 + 噪声）这三种图 zxing/jsQR 全灭，wechat_qrcode 全部解出。
- 唯一三边都没解出的是 `hard_text_zh_recompressed`（先缩到 0.35 再模糊再加噪声，已超出可恢复信息量），保留在基准里作为"极限"参照。
- 浏览器端自动化验证（真实 Chrome，`npm run test:browser`）：**12/12** 通过，单帧 58–67 ms（`hard_url_far` 走 4 块切图兜底，283 ms）。
- 产物体积：`wq.wasm` 7.44 MB（gzip 1.63 MB）+ `wq.js` 70 KB + 两个模型共 1 MB。

![demo 页面](docs/demo.png)

## 快速开始

```bash
npm install          # 仅测试/基准需要（puppeteer-core、zxing-wasm、jsqr）
npm run serve        # http://127.0.0.1:5173/demo/
```

打开 <http://127.0.0.1:5173/demo/> 点「启动相机」，或「上传图片」传一张二维码照片。摄像头需要 HTTPS 或 localhost。

`dist/` 里已带好构建产物（`wq.js` / `wq.wasm`），克隆即可用；重新构建见 [docs/build.md](docs/build.md)。

### 作为库使用

```js
import { createScanner } from './web/scanner.js';

const scanner = await createScanner({
  detectModel: '/models/detect.onnx',
  srModel: '/models/sr.onnx',       // 可省略：省略则关闭神经网络超分辨率
});

// ImageData / {data,width,height,format} / canvas / video / ImageBitmap / <img> 均可
const { count, results, ms } = scanner.scan(imageData, { tiles: 2 });
for (const { text, points } of results) {
  console.log(text, points);        // points = 4 个角点 [[x,y],...]
}
scanner.destroy();
```

`tiles: 2` 打开重叠切图兜底：整图先扫一次，扫不到才把图切成 2×2 重叠块再扫（并回填坐标）。手机的远距离小码场景用它；实时预览建议保持默认（不切图，单帧 ~60 ms）。

API 细节（`scan` / `scanGray` / `scanImageURL` / 输入格式 / `scaleFactor`）见 [docs/api.md](docs/api.md)。

## 仓库结构

```
src/wq_wasm.cpp                 C API：wq_init / wq_scan / wq_result_json / …
web/scanner.js                  ESM 封装（模型注入 MEMFS、扫描、切图兜底、结果解析）
dist/wq.js, dist/wq.wasm        预编译产物
models/detect.onnx              官方检测模型（未修改）
models/sr.onnx                  官方超分模型（修正了动态尺寸裁剪，见 tools/patch_sr_model.py）
third_party/opencv_modules/     从 opencv_contrib 5.x 迁入的 wechat_qrcode 源码
scripts/                        取源码 / 配置 / 编译 OpenCV 与 wasm / 静态服务器
demo/                           摄像头扫码 demo
tests/                          Node 测试、基准、浏览器自动化验证、生成的测试图
tools/                          模型下载、SR 模型修补、测试集生成
docs/                           构建、架构、API 文档
```

## 自己构建

需要：Node ≥ 18、Python 3、CMake ≥ 3.5、Ninja、[emsdk](https://github.com/emscripten-core/emsdk)（Emscripten 6.x）、OpenCV 5.x 源码。

```powershell
# 1. 准备 OpenCV 5.x 源码（或设 $env:OPENCV_SRC 指向已有 checkout）
.\scripts\fetch-opencv.ps1

# 2. 用 emscripten 交叉编译 OpenCV 静态库（core/imgproc/flann/geometry/dnn/wechat_qrcode）
.\scripts\configure-opencv.ps1
.\scripts\build-opencv.ps1

# 3. 链接 wasm 模块
.\scripts\build-wasm.ps1
```

细节、耗时、坑（模块白名单缓存、`opencv5` 安装目录、`liblibprotobuf.a`、ONNX 模型动态尺寸）见 [docs/build.md](docs/build.md)。

## 与上游的差异

1. **CMakeLists**：去掉未使用的 `opencv_objdetect` 依赖和 `WRAP java objc python js`，去掉 5.x 里已经失效的 caffe 模型下载块（5.x 只读 ONNX）。
2. **`models/sr.onnx` 打了动态尺寸补丁**：原模型把 Caffe `Crop` 层固化成 `Slice(ends=[447,447])`，只在 224×224 输入时成立；本模块会喂任意大小的二维码裁剪图。补丁把 `ends` 改成 `[-1,-1]`、输入输出维度改成符号维度（`tools/patch_sr_model.py`，可重复生成）。`models/detect.onnx` 未修改——OpenCV 5.x 的 `Reshape2` 已有旧模型兼容逻辑，能跑动态尺寸。
3. **OpenCV 以 `-DOPENCV_HAVE_FILESYSTEM_SUPPORT=1` 编译**：Emscripten 下 OpenCV 默认关闭文件系统，而 `WeChatQRCode` 构造函数会 `CV_Assert(utils::fs::exists(model_path))`。打开后模型通过 Emscripten MEMFS 按路径加载。
4. **JS 侧切图兜底**：检测网络总是把整帧缩放到 ~400×400，大图里的小码会小到检测不到；`scanner.scan(..., { tiles: 2 })` 用重叠切图恢复小码的相对尺寸。这是对上游能力的补充，默认关闭，不影响原算法路径。
5. 不编译 `objdetect/calib3d/features2d/highgui/videoio/imgcodecs`，以控制 wasm 体积。

## 已知限制

- 单线程：一帧约 60–70 ms（640×480–1280×720），适合 10–15 fps 的扫码预览；需要更高帧率时应在 Worker 里跑，并把画面降到 640×480。
- 可选切图兜底会使最坏耗时到 ~300 ms（1600×1200 分 4 块），适合拍照/上传，不适合实时视频。
- wasm 未启用 SIMD（浏览器覆盖率考虑），开 `-msimd128` 可再快一些，但会要求较新的浏览器。
- 5.x 分支是开发版（`OpenCV 5.1.0-dev`）；上游若改动了 ONNX 导入器行为需重新验证。
- 极低信息量的图（如二次压缩 + 强噪声）任何解码器都无解，属正常。

## 许可

Apache-2.0（同 OpenCV / opencv_contrib）。`third_party/opencv_modules/wechat_qrcode` 来自 opencv_contrib，`models/` 下的模型来自 OpenCV 测试模型仓库，见 [models/LICENSE](models/LICENSE) 与 [third_party/opencv_modules/wechat_qrcode/LICENSE](third_party/opencv_modules/wechat_qrcode/LICENSE)。
