/**
 * Shared helpers for the node-side wasm tests:
 *   - loading the Emscripten module
 *   - installing the two ONNX models into MEMFS and initializing the scanner
 *   - scanning raw RGBA buffers (raw C API, or through web/scanner.js)
 *   - reading the generated test corpus manifest
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const distDir = join(repoRoot, 'dist');
export const assetsDir = join(repoRoot, 'tests', 'assets');
export const modelsDir = join(repoRoot, 'models');

/** wq_scan() pixel formats, must match src/wq_wasm.cpp */
export const FORMAT_GRAY = 0;
export const FORMAT_RGB = 1;
export const FORMAT_RGBA = 2;
export const FORMAT_BGR = 3;

const quietPrint = () => {};
const quietPrintErr = () => {};

/** Dist entry file of the wasm module (dist/wq.js). */
export function moduleEntry() {
  return new URL('../dist/wq.js', import.meta.url).href;
}

async function loadModule({ verbose = false } = {}) {
  const factory = (await import(moduleEntry())).default;
  return factory({
    locateFile: (path) => join(distDir, basename(path)),
    print: verbose ? (msg) => console.log('[wasm]', msg) : quietPrint,
    printErr: verbose ? (msg) => console.error('[wasm]', msg) : quietPrintErr,
    noInitialRun: true,
  });
}

function writeModels(module) {
  try {
    module.FS.mkdir('/models');
  } catch (err) {
    if (!(err && err.errno === 20)) throw err; // EEXIST
  }
  module.FS.writeFile('/models/detect.onnx', new Uint8Array(readFileSync(join(modelsDir, 'detect.onnx'))));
  module.FS.writeFile('/models/sr.onnx', new Uint8Array(readFileSync(join(modelsDir, 'sr.onnx'))));
}

/** Loads the module and initializes wq_init() directly through the C API. */
export async function loadScanner({ verbose = false } = {}) {
  const module = await loadModule({ verbose });
  writeModels(module);
  const rc = withCString(module, '/models/detect.onnx', (detectPtr) =>
    withCString(module, '/models/sr.onnx', (srPtr) => module._wq_init(detectPtr, srPtr)),
  );
  if (rc !== 0) {
    throw new Error(`wq_init failed: ${module.UTF8ToString(module._wq_last_error())}`);
  }
  return module;
}

/**
 * Loads the production wrapper (web/scanner.js) on top of the same wasm build.
 * Used by the test runner/benchmark so the shipped JS path is exercised too.
 */
export async function loadWrapper({ verbose = false } = {}) {
  const { createScanner } = await import(new URL('../web/scanner.js', import.meta.url).href);
  const moduleFactory = (await import(moduleEntry())).default;
  return createScanner({
    detectModel: new Uint8Array(readFileSync(join(modelsDir, 'detect.onnx'))),
    srModel: new Uint8Array(readFileSync(join(modelsDir, 'sr.onnx'))),
    moduleFactory,
    locateFile: (path) => join(distDir, basename(path)),
    print: verbose ? (msg) => console.log('[wasm]', msg) : quietPrint,
    printErr: verbose ? (msg) => console.error('[wasm]', msg) : quietPrintErr,
  });
}

export function withCString(module, str, fn) {
  const size = module.lengthBytesUTF8(str) + 1;
  const ptr = module._malloc(size);
  try {
    module.stringToUTF8(str, ptr, size);
    return fn(ptr);
  } finally {
    module._free(ptr);
  }
}

/** Scans an RGBA buffer through the wrapper: opts = {scaleFactor, tiles, tileOverlap}. */
export function scanRgba(scanner, rgba, width, height, opts = {}) {
  const bytes = width * height * 4;
  if (rgba.length < bytes) throw new Error(`buffer too small: ${rgba.length} < ${bytes}`);
  return scanner.scan({ data: rgba, width, height, format: 'rgba' }, opts);
}

export async function loadManifest() {
  return JSON.parse(await readFile(join(assetsDir, 'manifest.json'), 'utf8'));
}

/** Formats a duration for the console tables. */
export function fmtMs(ms) {
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`;
}

/** Picks assets by id/tag substring (used by --filter of the test runner). */
export function filterAssets(assets, filter) {
  if (!filter) return assets;
  const hit = assets.filter((a) => a.id.includes(filter) || a.tags.includes(filter));
  if (!hit.length) throw new Error(`no assets match filter ${JSON.stringify(filter)}`);
  return hit;
}

/** Ground-truth payloads of an asset: multi-code scenes list several, single-code assets one. */
export function assetPayloads(asset) {
  return asset.payloads ?? [asset.payload];
}

/**
 * True when every expected payload was decoded, counting duplicates (a scene with the same
 * payload twice must produce two results, since upstream dedupe is spatial, not by text).
 */
export function resultsMatchAsset(results, asset) {
  const want = new Map();
  for (const payload of assetPayloads(asset)) want.set(payload, (want.get(payload) ?? 0) + 1);
  const got = new Map();
  for (const result of results) got.set(result.text, (got.get(result.text) ?? 0) + 1);
  for (const [payload, count] of want) {
    if ((got.get(payload) ?? 0) < count) return false;
  }
  return true;
}
