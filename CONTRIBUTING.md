# 贡献指南

## 可以改哪里

- `src/wq_wasm.cpp`：C ABI（`wq_init` / `wq_scan` / `wq_result_json` / …）。改导出函数后要同步 `scripts/build-wasm.ps1` 的 `-sEXPORTED_FUNCTIONS`。
- `web/scanner.js`：对外 ESM API（`createScanner`、切图兜底、输入格式归一化、结果解析）。
- `scripts/`、`tools/`、`tests/`、`demo/`、`docs/`：构建/测试/文档。

## 不要改哪里

- `third_party/opencv_modules/wechat_qrcode/src/`：这是 opencv_contrib 5.x 的副本，保持与上游一致。要修行为优先在 JS 层或模型层解决；**确需改源码时**必须在 `third_party/opencv_modules/wechat_qrcode/UPSTREAM.md` 记录原因，并考虑直接向上游提 PR。
- `models/detect.onnx` 必须保持官方原文件（`tools/fetch_models.py` 有 sha1 校验）。`models/sr.onnx` 是 `tools/patch_sr_model.py` 生成的，不要换成原始模型。

## 提交前必跑

```bash
npm install
npm run assets        # 只在测试集有变化时需要
npm test              # 期望 27/29、clean 5/5、hard 8/10、multi 4/4
node tests/benchmark.mjs --tiles 2   # 期望 wechat_qrcode 28/29，并更新 BENCHMARK.md
npm run test:browser  # 期望 14/14
```

改了 wasm 导出或 C++ 代码要重新 `npm run build` 再跑上面三项，并提交 `dist/` 的新产物。

`hard_text_zh_recompressed` 是刻意保留的"不可解码"用例，不要为了让基准变绿去调参。

## 报告问题

请附上：浏览器 / Node 版本、使用的 `scaleFactor` / `tiles`、可复现的图片、以及 `npm test` 的输出。涉及准确率的问题最好说明它和 zxing-wasm / jsQR 的对比结果。

## 许可

贡献即表示同意以 Apache-2.0 授权（见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。
