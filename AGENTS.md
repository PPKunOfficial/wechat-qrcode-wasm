# AGENTS.md

面向在这个仓库里继续工作的 agent。人看的说明在 [README.md](README.md)，构建细节在 [docs/build.md](docs/build.md)，架构/适配决策在 [docs/architecture.md](docs/architecture.md)。

## 这个项目是什么

把 opencv_contrib 5.x 的 `wechat_qrcode` 模块（微信扫码算法：SSD 检测 + 超分 + zxing 解码）编译成 wasm，前端可直接用。算法代码保持上游原样，改动只在：模块 CMakeLists、sr 模型补丁、`src/wq_wasm.cpp` C API、`web/scanner.js` 封装。

## 常用命令

```bash
npm install              # 测试/基准依赖
npm run serve            # http://127.0.0.1:5173/demo/（加 ?variant=min 用最小体积版）
npm test                 # Node 冒烟 + 准确率（29 张单码 + 4 张多码场景）
npm run test:min         # 同一套语料跑 dist/wq.min.js（最小体积版）
npm run bench            # 对比 zxing-wasm / jsQR，写 BENCHMARK.md
npm run test:browser     # 真实 Chrome（puppeteer-core）跑 14 张图（含多码）
npm run assets           # 重新生成测试集（python + segno/pillow/numpy）
npm run build            # 全量重建（OpenCV 源码在 .cache/opencv 或 $env:OPENCV_SRC）
npm run build:min        # 重建最小体积版：dist/wq.min.js + dist/wq.min.wasm
```

产物：标准版 `dist/wq.js` + `dist/wq.wasm`（7.44 MB），最小体积版 `dist/wq.min.js` + `dist/wq.min.wasm`（5.67 MB），都已提交，可省略构建。模型在 `models/`。

## 硬性约束

- **不要动 `third_party/opencv_modules/wechat_qrcode/src/` 下的算法代码**。它是 opencv_contrib 5.x 的副本；要修行为优先改 JS 层或模型。若确需改源码，同步更新 `third_party/opencv_modules/wechat_qrcode/UPSTREAM.md`（若不存在则新建，记录上游 commit 与补丁理由）。
- `models/detect.onnx` 必须保持官方原文件（sha1 校验在 `tools/fetch_models.py`）。`models/sr.onnx` 是由 `tools/patch_sr_model.py` 生成的补丁版本，不要用原始 sr 模型替换。
- OpenCV 构建必须带 `-DOPENCV_HAVE_FILESYSTEM_SUPPORT=1`，否则 `wq_init` 在 `CV_Assert(utils::fs::exists())` 抛 `StsNotImplemented`。
- 改 `BUILD_LIST` / 模块集合后必须用 `configure-opencv.ps1 -Reconfigure`（清 build 目录），否则 CMake cache 里的 `BUILD_opencv_*=OFF` 会让模块静默消失。
- 不要引入 pthread：单线程是"任意静态托管可用、无需 COOP/COEP"的前提。
- 不要把 `tests/assets/`（约 94 MB 生成物：PNG + 原始 RGBA）提交进仓库。
- `dist/wq.min.*` 只能由 `-MinSize` 构建产生（`build/opencv-wasm-min`，OpenCV 编译参数 `-Os -ffunction-sections -fdata-sections`，链接 `-Oz -Wl,--gc-sections -sMALLOC=emmalloc --closure 1`）；不要手工在 wasm 上再跑 `wasm-opt`（feature 集合不对会生成 ID 非法的模块）。
- 标准版与最小版的 API/准确率必须保持一致；改 `src/wq_wasm.cpp` 或 `web/scanner.js` 后两套产物都要重新构建、重跑测试。

## 验证要求（改完必须跑）

1. `npm test` → 期望 `decoded 27/29 assets`、`clean reference set: 5/5`、`hard tier: 8/10`（不开切图），且 multi-code 段 4/4 PASS（2 码、3 码、同码重复、3×3 九宫格）。
2. `npm run bench`（= `node tests/benchmark.mjs --tiles 2 --min --md BENCHMARK.md`）→ 期望 wechat_qrcode 28/29、min 行 28/29，且 BENCHMARK.md 被更新。
3. `npm run test:browser` → 期望 `browser: decoded 14/14`，退出码 0。它需要本机 Chrome（puppeteer-core 通过 `CHROME_PATH` 或默认路径找）。
4. `npm run test:min` → 最小体积版同一准确率：`decoded 27/29`、`hard tier: 8/10`（`--tiles 2` 时 28/29 / 9/10，但会更慢）；`node tests/browser/run-browser-test.mjs --variant min` 期望 `14/14`。
5. 改了 JNI/wasm 导出 → 先 `npm run build`（和/或 `npm run build:min`）再跑上面几项。

已知唯一"该失败"的用例：`hard_text_zh_recompressed`（信息量已被破坏），任何解码器都解不出，别试图调参让它通过。

## 环境事实（这台机器上踩过的坑）

- emsdk 在 `D:\projects\emsdk`，`emsdk install latest` 在本机不可用；现有工具链是手工解包的 `upstream/` + 手写 `.emscripten`（`scripts/_env.ps1` 会在缺失时自动生成）。
- PowerShell 变量名大小写不敏感：`_env.ps1` dot-source 时定义的 `$script:OpenCvSrc` 会覆盖同名参数，脚本里都先快照 `$paramXxx`。
- OpenCV 5.x 安装布局与 4.x 不同：头文件 `install/include/opencv5/opencv2/`、第三方库 `install/lib/opencv5/3rdparty/liblibprotobuf.a`。
- 浏览器自动化必须用 puppeteer-core 控制真实 Chrome；`chrome --headless --screenshot` 的 `--virtual-time-budget` 会让 `createImageBitmap` 之类的异步任务挂住。

## 目录速查

- `src/wq_wasm.cpp` — C ABI（`wq_init/wq_scan/wq_result_json/wq_last_error/wq_reset/wq_opencv_version`）
- `web/scanner.js` — 公开 API（`createScanner`，`scan/scanGray/scanImageURL`，`tiles` 兜底）
- `scripts/` — `_env.ps1`、`fetch-opencv`、`configure-opencv`、`build-opencv`、`build-wasm`、`build-all.mjs`、`serve.mjs`
- `tools/` — `fetch_models.py`、`patch_sr_model.py`、`gen_test_assets.py`
- `tests/` — `_harness.mjs`、`run-tests.mjs`、`benchmark.mjs`、`browser/`
- `demo/` — 摄像头扫码页
