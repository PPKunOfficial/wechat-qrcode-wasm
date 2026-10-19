# 上游来源与差异

本目录是 opencv_contrib 5.x `modules/wechat_qrcode` 的副本，供本仓库用 Emscripten 交叉编译。

## 来源

- 仓库：<https://github.com/opencv/opencv_contrib>
- 分支：`5.x`
- 迁入时的 commit：`eca97a4adb2fa32afc82478947d7f049fce57ee1`（2026-10-09）
- 目录：`modules/wechat_qrcode`
- 许可：Apache-2.0（Tencent 版权 + ZXing 归属，见本目录 `LICENSE`）

## 本仓库的修改

只改了 **`CMakeLists.txt`**，`src/`、`include/`、`test/`、`perf/`、`samples/` 保持上游原样：

1. 依赖列表去掉未使用的 `opencv_objdetect`（`src/` 里没有任何代码用它，上游只是声明了依赖）。
2. 去掉 `WRAP java objc python js`：本仓库用 `src/wq_wasm.cpp` 的 C API 对外，不需要语言绑定。
3. 删掉 configure 阶段下载 caffe 模型（`detect.caffemodel` / `sr.caffemodel` 等）的代码块：5.x 的 `SSDDetector` / `SuperScale` 已改为 `dnn::readNetFromONNX()`，那些文件已经失效。

## 模型

上游 `test/test_qrcode.cpp` 引用的 `dnn/wechat_2021-01/detect.onnx`、`sr.onnx` 即本仓库 `models/` 下的模型。`models/detect.onnx` 与上游逐字节相同；`models/sr.onnx` 由 `tools/patch_sr_model.py` 打过动态尺寸补丁（原文件见 `models/upstream/sr.onnx`），原因见 [docs/architecture.md](../../../docs/architecture.md)。

## 同步上游

重新同步时不要直接覆盖 `CMakeLists.txt`，把上面三处改动重新应用一遍，然后跑 `npm run build` 与 `npm test` 验证。
