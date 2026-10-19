/**
 * High-level wrapper around the WebAssembly build of OpenCV 5.x `wechat_qrcode`.
 *
 * The C++ side (src/wq_wasm.cpp) keeps the original WeChat pipeline:
 *   1. SSD QR detector (ONNX, CNN) finds candidate quads,
 *   2. each crop is upscaled (ONNX super-resolution) when small,
 *   3. a zxing-derived decoder with several binarizers extracts the payload.
 *
 * Usage (ESM):
 *   import { createScanner } from './scanner.js';
 *   const scanner = await createScanner({
 *     detectModel: '/models/detect.onnx',
 *     srModel: '/models/sr.onnx',
 *   });
 *   const { count, results, ms } = scanner.scan(imageData);
 *
 * The module is single-threaded on purpose: no SharedArrayBuffer / COOP+COEP headers
 * are required, so it works on any static host and inside web workers.
 */

// The Emscripten module factory (dist/wq.js) is imported lazily so that callers can
// pass their own already-loaded factory (e.g. when bundling with a custom locateFile).
let defaultModuleFactory = null;
async function loadDefaultModuleFactory() {
  if (!defaultModuleFactory) {
    defaultModuleFactory = (await import('../dist/wq.js')).default;
  }
  return defaultModuleFactory;
}

const FORMAT_GRAY = 0;
const FORMAT_RGB = 1;
const FORMAT_RGBA = 2;
const FORMAT_BGR = 3;

const FORMAT_BY_NAME = {
  gray: FORMAT_GRAY,
  grey: FORMAT_GRAY,
  rgb: FORMAT_RGB,
  rgba: FORMAT_RGBA,
  bgr: FORMAT_BGR,
};

const CHANNELS = { [FORMAT_GRAY]: 1, [FORMAT_RGB]: 3, [FORMAT_RGBA]: 4, [FORMAT_BGR]: 3 };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @typedef {Object} ScanResult
 * @property {boolean} ok
 * @property {Array<{text: string, points: number[][]}>} results  decoded payloads + 4 corners
 * @property {number} count
 * @property {number} ms      detector+decoder time measured inside wasm
 * @property {number} width   processed width (image pixels)
 * @property {number} height  processed height
 * @property {number} [tiles] number of tiles scanned by the tiled fallback
 * @property {string} [error]
 */

/**
 * Creates a scanner instance. The returned object owns a wasm heap buffer that grows
 * to fit the largest frame scanned.
 *
 * @param {Object} options
 * @param {string|Uint8Array} options.detectModel  detector ONNX model (URL or bytes)
 * @param {string|Uint8Array|null} [options.srModel]  super-resolution ONNX model
 * @param {Function} [options.moduleFactory] Emscripten factory from dist/wq.js
 * @param {Function} [options.locateFile]    custom wasm/js locator for the factory
 * @param {Function} [options.print]         log sink (defaults to console.log)
 * @param {Function} [options.printErr]      error sink (defaults to console.warn)
 */
export async function createScanner(options = {}) {
  const {
    detectModel,
    srModel = null,
    moduleFactory,
    locateFile,
    print = (msg) => console.log('[wechat-qrcode]', msg),
    printErr = (msg) => console.warn('[wechat-qrcode]', msg),
  } = options;

  if (!detectModel) {
    throw new Error('createScanner: options.detectModel is required (URL or Uint8Array)');
  }

  const factory = moduleFactory || (await loadDefaultModuleFactory());
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const module = await factory({
    // Emscripten resolves wq.wasm relative to dist/wq.js (its own import.meta.url), so
    // only inject locateFile when the caller needs a non-standard layout.
    locateFile,
    print,
    printErr,
    noInitialRun: true,
  });
  const loadMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;

  // Make sure MEMFS exists and write the models where C++ can open them by path.
  const modelDir = '/models';
  try {
    module.FS.mkdir(modelDir);
  } catch (e) {
    if (!(e && e.errno === 20 /* EEXIST */)) throw e;
  }

  async function toBytes(source, label) {
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (typeof source === 'string' || source instanceof URL) {
      const response = await fetch(String(source));
      if (!response.ok) {
        throw new Error(`createScanner: failed to fetch ${label} (${response.status} ${response.statusText})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    if (source && typeof source.arrayBuffer === 'function') {
      return new Uint8Array(await source.arrayBuffer());
    }
    throw new Error(`createScanner: unsupported ${label} source (expected URL, Uint8Array or ArrayBuffer)`);
  }

  const detectBytes = await toBytes(detectModel, 'detectModel');
  const srBytes = srModel ? await toBytes(srModel, 'srModel') : null;

  const detectPath = `${modelDir}/detect.onnx`;
  const srPath = srBytes ? `${modelDir}/sr.onnx` : '';
  module.FS.writeFile(detectPath, detectBytes);
  if (srBytes) module.FS.writeFile(srPath, srBytes);

  // Owned heap buffer used for incoming frames.
  let framePtr = 0;
  let frameCap = 0;
  function ensureFrameBuffer(bytes) {
    if (bytes > frameCap) {
      if (framePtr) module._free(framePtr);
      framePtr = module._malloc(bytes);
      frameCap = bytes;
    }
    return framePtr;
  }

  function withCString(str, fn) {
    const size = module.lengthBytesUTF8(str) + 1;
    const ptr = module._malloc(size);
    try {
      module.stringToUTF8(str, ptr, size);
      return fn(ptr);
    } finally {
      module._free(ptr);
    }
  }

  const rc = withCString(detectPath, (detectC) =>
    withCString(srPath, (srC) => module._wq_init(detectC, srC)),
  );
  if (rc !== 0) {
    const message = module.UTF8ToString(module._wq_last_error()) || `wq_init failed (code ${rc})`;
    throw new Error(`createScanner: ${message}`);
  }

  function lastError() {
    return module.UTF8ToString(module._wq_last_error()) || 'unknown wasm error';
  }

  function runScan(ptr, width, height, stride, format, scaleFactor) {
    const rcScan = module._wq_scan(ptr, width, height, stride, format, scaleFactor);
    if (rcScan < 0) {
      return { ok: false, count: 0, results: [], ms: 0, width, height, error: lastError() };
    }
    const json = module.UTF8ToString(module._wq_result_json());
    const parsed = JSON.parse(json);
    if (!parsed.ok && !parsed.error) parsed.error = 'unknown wasm error';
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // pixel plumbing
  // ---------------------------------------------------------------------------

  /** Copies a pixel buffer into the wasm heap and scans it. */
  function scanPixels(pixels, scaleFactor) {
    const { data, width, height, format } = pixels;
    const stride = pixels.stride || width * (CHANNELS[format] ?? 4);
    const required = stride * height;
    if (data.length < required) {
      throw new RangeError(`scan: pixel buffer too small (${data.length} < ${required})`);
    }
    const ptr = ensureFrameBuffer(required);
    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, required);
      module.HEAPU8.set(bytes, ptr);
    } else {
      throw new TypeError('scan: unsupported pixel buffer type');
    }
    return runScan(ptr, width, height, stride, format, scaleFactor);
  }

  let scratchCanvas = null;
  let scratchCtx = null;
  function getScratchCanvas(width, height) {
    const creator = typeof OffscreenCanvas !== 'undefined'
      ? (w, h) => new OffscreenCanvas(w, h)
      : (w, h) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          return c;
        };
    if (!scratchCanvas) {
      scratchCanvas = creator(width, height);
      scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    } else if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
      scratchCanvas.width = width;
      scratchCanvas.height = height;
    }
    return scratchCanvas;
  }

  function imageDataToPixels(imageData) {
    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
      format: FORMAT_RGBA,
      stride: imageData.width * 4,
    };
  }

  function mediaToPixels(source, width, height) {
    const canvas = getScratchCanvas(width, height);
    scratchCtx.drawImage(source, 0, 0, width, height);
    return imageDataToPixels(scratchCtx.getImageData(0, 0, width, height));
  }

  /** Normalizes any supported scan input into a pixel descriptor. */
  function toPixels(input) {
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
      return imageDataToPixels(input);
    }
    if (input && input.data && Number.isFinite(input.width) && Number.isFinite(input.height)) {
      const format = typeof input.format === 'string'
        ? (FORMAT_BY_NAME[input.format.toLowerCase()] ?? FORMAT_RGBA)
        : (input.format ?? FORMAT_RGBA);
      const channels = CHANNELS[format] ?? 4;
      return {
        data: input.data,
        width: input.width,
        height: input.height,
        format,
        stride: input.stride || input.width * channels,
      };
    }
    if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) {
      const ctx = input.getContext('2d', { willReadFrequently: true });
      return imageDataToPixels(ctx.getImageData(0, 0, input.width, input.height));
    }
    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
      const ctx = input.getContext('2d', { willReadFrequently: true });
      return imageDataToPixels(ctx.getImageData(0, 0, input.width, input.height));
    }
    if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) {
      if (!input.videoWidth || !input.videoHeight) throw new Error('scan: video has no frame yet');
      return mediaToPixels(input, input.videoWidth, input.videoHeight);
    }
    if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
      return mediaToPixels(input, input.width, input.height);
    }
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
      return mediaToPixels(input, input.naturalWidth || input.width, input.naturalHeight || input.height);
    }
    throw new TypeError('scan: unsupported input (expected ImageData, canvas, video, ImageBitmap or {data,width,height})');
  }

  /** Copies a rectangle out of a pixel buffer (used by the tiled fallback). */
  function cropPixels(pixels, x0, y0, width, height) {
    const channels = CHANNELS[pixels.format] ?? 4;
    const srcStride = pixels.stride || pixels.width * channels;
    const rowBytes = width * channels;
    const out = new Uint8Array(rowBytes * height);
    const src = pixels.data;
    for (let row = 0; row < height; row++) {
      const srcStart = (y0 + row) * srcStride + x0 * channels;
      out.set(src.subarray(srcStart, srcStart + rowBytes), row * rowBytes);
    }
    return { data: out, width, height, format: pixels.format, stride: rowBytes };
  }

  // ---------------------------------------------------------------------------
  // tiled fallback: the detector always normalizes the frame to a ~400x400 target
  // area, so a code that occupies a tiny fraction of a big photo can be invisible to
  // it. Scanning overlapping crops restores the code's relative size; it is only used
  // when the full-frame pass finds nothing, so live scanning stays single-pass.
  // ---------------------------------------------------------------------------

  function scanTiles(pixels, grid, overlap, scaleFactor) {
    const { width, height } = pixels;
    const denom = grid - (grid - 1) * overlap;
    const tileW = Math.ceil(width / denom);
    const tileH = Math.ceil(height / denom);
    if (tileW < 40 || tileH < 40) return { results: [], ms: 0, tiles: 0 };

    const stepX = Math.max(1, Math.floor(tileW * (1 - overlap)));
    const stepY = Math.max(1, Math.floor(tileH * (1 - overlap)));
    const xs = [];
    const ys = [];
    for (let x = 0; x < width; x += stepX) {
      xs.push(Math.min(x, width - tileW));
      if (x + tileW >= width) break;
    }
    for (let y = 0; y < height; y += stepY) {
      ys.push(Math.min(y, height - tileH));
      if (y + tileH >= height) break;
    }

    const results = [];
    const texts = new Set();
    let ms = 0;
    let tiles = 0;
    for (const y0 of ys) {
      for (const x0 of xs) {
        // A tile with no room left on the right/bottom is skipped rather than shrunk.
        const w = Math.min(tileW, width - x0);
        const h = Math.min(tileH, height - y0);
        if (w < 40 || h < 40) continue;
        const tile = cropPixels(pixels, x0, y0, w, h);
        const res = scanPixels(tile, scaleFactor);
        tiles++;
        ms += res.ms || 0;
        for (const item of res.results || []) {
          if (texts.has(item.text)) continue;
          texts.add(item.text);
          results.push({
            text: item.text,
            points: (item.points || []).map(([x, y]) => [x + x0, y + y0]),
          });
        }
      }
    }
    return { results, ms, tiles };
  }

  /**
   * Scans raw grayscale pixels (one byte per pixel).
   * @param {Uint8Array|Uint8ClampedArray} gray
   */
  function scanGray(gray, width, height, opts = {}) {
    if (!(gray instanceof Uint8Array || gray instanceof Uint8ClampedArray)) {
      throw new TypeError('scanGray: expected Uint8Array/Uint8ClampedArray');
    }
    const stride = opts.stride || width;
    if (gray.length < stride * height) {
      throw new RangeError(`scanGray: buffer too small (${gray.length} < ${stride * height})`);
    }
    const pixels = { data: gray, width, height, format: FORMAT_GRAY, stride };
    return scanPixelsWithTiles(pixels, opts);
  }

  function scanPixelsWithTiles(pixels, opts) {
    const scaleFactor = opts.scaleFactor ?? -1;
    const primary = scanPixels(pixels, scaleFactor);
    const grid = opts.tiles ?? 0;
    if (primary.count > 0 || grid < 2) return primary;

    const extra = scanTiles(pixels, grid, opts.tileOverlap ?? 0.2, scaleFactor);
    if (!extra.tiles) return primary;
    const results = [];
    const texts = new Set();
    for (const item of primary.results || []) {
      if (texts.has(item.text)) continue;
      texts.add(item.text);
      results.push(item);
    }
    for (const item of extra.results) {
      if (texts.has(item.text)) continue;
      texts.add(item.text);
      results.push(item);
    }
    return {
      ok: true,
      width: pixels.width,
      height: pixels.height,
      count: results.length,
      results,
      ms: (primary.ms || 0) + extra.ms,
      tiles: extra.tiles,
    };
  }

  /**
   * Scans any supported image source.
   *
   * Accepted inputs:
   *   - ImageData
   *   - { data: Uint8Array|Uint8ClampedArray, width, height, format?: 'rgba'|'rgb'|'gray'|'bgr', stride? }
   *   - HTMLCanvasElement / OffscreenCanvas
   *   - HTMLVideoElement / ImageBitmap / HTMLImageElement (drawn to an internal canvas)
   *
   * Options:
   *   - scaleFactor: detector scale (default -1 = automatic, images are fitted to 400x400)
   *   - tiles: >1 enables the overlapping-tile fallback for far/small codes
   *   - tileOverlap: tile overlap fraction (default 0.2)
   *
   * @returns {ScanResult}
   */
  function scan(input, opts = {}) {
    return scanPixelsWithTiles(toPixels(input), opts);
  }

  /** Decodes a QR code from an image URL (fetch + createImageBitmap). */
  async function scanImageURL(url, opts = {}) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`scanImageURL: fetch failed (${response.status})`);
    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      try {
        return scan(bitmap, opts);
      } finally {
        bitmap.close?.();
      }
    }
    throw new Error('scanImageURL: createImageBitmap is not available in this environment');
  }

  function destroy() {
    module._wq_reset();
    if (framePtr) {
      module._free(framePtr);
      framePtr = 0;
      frameCap = 0;
    }
  }

  return {
    scan,
    scanGray,
    scanImageURL,
    destroy,
    module,
    loadMs,
    modelInfo: {
      detectBytes: detectBytes.length,
      srBytes: srBytes ? srBytes.length : 0,
    },
    opencvVersion: module.UTF8ToString(module._wq_opencv_version()),
    formatBytes,
    get frameCapacity() {
      return frameCap;
    },
  };
}

export default createScanner;
