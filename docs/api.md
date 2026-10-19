# API

`web/scanner.js` 是唯一的公开入口（ESM）。它负责加载 wasm、把 `.onnx` 模型写进 Emscripten 的内存文件系统、把像素拷进堆、调用 C 导出函数、把 JSON 解析成 JS 对象。

## `createScanner(options) → Promise<Scanner>`

| 选项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `detectModel` | `string \| URL \| Uint8Array \| ArrayBuffer \| Blob` | 是 | 检测模型 `detect.onnx`；字符串按 URL `fetch` |
| `srModel` | 同上 | 否 | 超分辨率模型 `sr.onnx`；不传则关闭神经网络超分（退化为三次插值放大） |
| `moduleFactory` | `Function` | 否 | 自己已经 `import` 的 `dist/wq.js` 工厂函数，用于打包时指定路径 |
| `locateFile` | `(path) => string` | 否 | 只在 wasm 不在 `dist/` 同目录时才需要；默认由 Emscripten 按 `wq.js` 的 `import.meta.url` 解析 |
| `print` / `printErr` | `(msg) => void` | 否 | Emscripten stdout/stderr |

## Scanner 对象

```ts
interface ScanResult {
  ok: boolean;
  count: number;
  results: Array<{ text: string; points: [[number, number], [number, number], [number, number], [number, number]] }>;
  ms: number;          // C++ 侧耗时（毫秒），不含 JS 拷贝
  width: number;
  height: number;
  tiles?: number;      // 切图兜底实际扫描的块数（0 = 没触发）
  error?: string;      // ok=false 时的原生异常信息
}
```

| 成员 | 说明 |
| --- | --- |
| `scan(input, opts?)` | 扫任意支持的输入，返回 `Promise`-free 的 `ScanResult` |
| `scanGray(gray, width, height, opts?)` | 扫 8 位灰度像素（`Uint8Array`/`Uint8ClampedArray`），无 RGB 转换开销 |
| `scanImageURL(url, opts?)` | `fetch` 图片 → `createImageBitmap` → `scan` |
| `destroy()` | 释放 C++ 对象和帧缓冲；之后对象不可再用 |
| `module` | 原始 Emscripten 模块（需要直接调 C 函数时用） |
| `loadMs` | 加载 + 初始化模型耗时 |
| `modelInfo` | `{ detectBytes, srBytes }` |
| `opencvVersion` | 例如 `5.1.0-dev`（来自 `CV_VERSION`） |
| `formatBytes(n)` | 工具函数 |
| `frameCapacity` | 当前复用的堆缓冲字节数 |

### 支持的输入

- `ImageData`（`canvas.getImageData()` 的结果）
- 普通对象 `{ data, width, height, format?, stride? }`，`format` 为 `'rgba' | 'rgb' | 'gray' | 'bgr'`（默认 `'rgba'`）
- `HTMLCanvasElement` / `OffscreenCanvas`
- `HTMLVideoElement` / `ImageBitmap` / `HTMLImageElement`（内部 drawImage 到复用的 canvas）
- 其他带 `width`/`height`/`data` 的对象

`stride` 是每行字节数（默认 `width × 每像素字节数`），用于裁剪后的子图（例如摄像头一帧的 ROI）。

### 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `scaleFactor` | `-1` | 传给 `WeChatQRCode::setScaleFactor`，取值 `(0, 1]`；`-1` 表示自动（整图缩到约 400×400 再送检测网络）。调试时可固定 |
| `tiles` | `0` | `≥2` 时启用重叠切图兜底：整图扫不到才把图切成 `tiles × tiles` 块（默认 20% 重叠）再扫 |
| `tileOverlap` | `0.2` | 切图重叠比例 |

`tiles` 是针对"大图里的小码"的补充：检测网络把整帧缩到 ~400×400，远处二维码可能只剩十几个像素；切块后同样的码在块里相对变大，检测器才能命中。代价是最坏情况多 4~9 次推理（1600×1200 分 4 块约 +300 ms），所以默认关闭，实时预览建议不开、拍照/上传建议开 `tiles: 2`。

## 示例

### 摄像头实时预览

```js
import { createScanner } from './web/scanner.js';

const scanner = await createScanner({
  detectModel: '/models/detect.onnx',
  srModel: '/models/sr.onnx',
});
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function loop(video) {
  if (video.readyState >= 2) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const { results } = scanner.scan(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (results.length) console.log(results[0].text, results[0].points);
  }
  requestAnimationFrame(() => loop(video));
}
```

### Web Worker

`dist/wq.js` 的 `-sENVIRONMENT=web,worker,node` 允许在 Worker 里直接 `import`。把 `createScanner` + 扫描循环放进 Worker，主线程只传 `ImageData`/`ImageBitmap`，可以避免 60 ms 级别的主线程卡顿：

```js
// worker.js
import { createScanner } from '../web/scanner.js';
const scanner = await createScanner({ detectModel: '/models/detect.onnx', srModel: '/models/sr.onnx' });
self.onmessage = ({ data }) => self.postMessage(scanner.scan(data));
```

### Node

Node 下不需要 DOM；用 `tests/run-tests.mjs` 的方式读原始 RGBA：

```js
import createWeChatQRCodeModule from './dist/wq.js';
const module = await createWeChatQRCodeModule({ locateFile: (p) => new URL(`./dist/${p}`, import.meta.url).pathname });
```

`web/scanner.js` 在 Node 里同样可用（`scan({data, width, height})`）；`scanImageURL` 需要 `createImageBitmap`，Node 18+ 的 globals 里没有，需自行解码图片后传 RGBA。

## 错误处理

- `createScanner` 抛异常：模型 URL 取不到、wasm 加载失败、`wq_init` 返回 -1（错误信息在 message 里，例如模型文件损坏）。
- `scan` 返回 `{ ok: false, error }`：C++ 侧抛了 `cv::Exception`（例如缩放参数非法）。正常"没扫到"是 `{ ok: true, count: 0, results: [] }`，不是错误。
- 宽或高 ≤ 20 像素的图直接返回空结果（上游 `detectAndDecode` 的限制）。
