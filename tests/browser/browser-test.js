/**
 * Browser-side verification: runs the shared test corpus through the wasm module inside
 * a real browser (canvas -> ImageData -> web/scanner.js), then prints a pass/fail table.
 *
 * Open http://127.0.0.1:5173/tests/browser/ with scripts/serve.mjs running.
 * Add ?variant=min to run the minimal-size build (dist/wq.min.js) instead.
 */

import { createScanner } from '../../web/scanner.js';

const statusEl = document.getElementById('status');
const rowsEl = document.getElementById('rows');
const summaryEl = document.getElementById('summary');

const variant = new URLSearchParams(location.search).get('variant') === 'min' ? 'min' : 'default';

/** Picks a representative subset so the page stays fast. */
const WANTED = [
  'url_clean',
  'text_zh_clean',
  'url_small',
  'url_blur_heavy',
  'text_zh_dark',
  'long_rot45',
  'hard_url_far',
  'hard_url_far_blur',
  'hard_text_zh_defocus',
  'hard_long_night',
  'hard_wifi_rotated',
  'vcard_downscale',
  'multi_two',
  'multi_three',
];

/** Multi-code aware ground-truth check (same rule as tests/_harness.mjs#resultsMatchAsset). */
function matchesAsset(asset, results) {
  const want = new Map();
  for (const payload of asset.payloads ?? [asset.payload]) want.set(payload, (want.get(payload) ?? 0) + 1);
  const got = new Map();
  for (const result of results) got.set(result.text, (got.get(result.text) ?? 0) + 1);
  for (const [payload, count] of want) if ((got.get(payload) ?? 0) < count) return false;
  return true;
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}

/** Per-asset outcome, exported for the puppeteer runner. */
const results = [];

async function loadPixels(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function main() {
  const t0 = performance.now();
  const manifest = await (await fetch('../assets/manifest.json')).json();
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const assets = WANTED.map((id) => byId.get(id)).filter(Boolean);

  const scanner = await createScanner({
    detectModel: '../../models/detect.onnx',
    srModel: '../../models/sr.onnx',
    moduleFactory:
      variant === 'min' ? (await import('../../dist/wq.min.js')).default : undefined,
    print: () => {},
    printErr: (msg) => console.warn('[wasm]', msg),
  });
  setStatus(
    `ready · ${variant} build · OpenCV ${scanner.opencvVersion} · module+models ${Math.round(performance.now() - t0)} ms · ` +
      `detect ${scanner.formatBytes(scanner.modelInfo.detectBytes)} / sr ${scanner.formatBytes(scanner.modelInfo.srBytes)}`,
  );

  let pass = 0;
  for (const asset of assets) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${asset.id}</td><td>${asset.tags.join(', ')}</td>` +
      `<td>${asset.width}×${asset.height}</td><td class="pending">…</td><td class="payload"></td><td></td>`;
    rowsEl.appendChild(tr);
    const cells = tr.children;

    try {
      const imageData = await loadPixels(`../assets/${asset.png}`);
      console.log(`[browser-test] scanning ${asset.id} ${imageData.width}x${imageData.height}`);
      const t1 = performance.now();
      const result = scanner.scan(imageData, { tiles: 2 });
      console.log(
        `[browser-test] ${asset.id} -> count=${result.count} ms=${result.ms} wall=${Math.round(performance.now() - t1)}`,
      );
      const hit = matchesAsset(asset, result.results);
      cells[3].textContent = hit ? 'PASS' : 'FAIL';
      cells[3].className = hit ? 'pass' : 'fail';
      const texts = result.results.map((r) => r.text);
      cells[4].textContent = (texts.length > 1 ? texts.join(' | ') : (texts[0] ?? '')).slice(0, 46);
      cells[4].className = 'payload';
      cells[5].textContent = `${Math.round(result.ms)} ms${result.tiles ? ` · ${result.tiles} tiles` : ''}`;
      if (hit) pass++;
      results.push({ id: asset.id, ok: Boolean(hit), ms: result.ms, tiles: result.tiles ?? 0 });
    } catch (err) {
      cells[3].textContent = 'ERROR';
      cells[3].className = 'fail';
      cells[4].textContent = String(err?.message ?? err);
      cells[4].className = 'payload';
    }
  }

  const total = assets.length;
  summaryEl.textContent = `decoded ${pass}/${total} browser assets · total ${Math.round(performance.now() - t0)} ms`;
  summaryEl.style.color = pass === total ? '#5fd39b' : '#ffd166';
  setStatus(`done · decoded ${pass}/${total}`, pass === total ? 'ok' : 'err');
  scanner.destroy();
  document.title = `wechat_qrcode wasm · browser tests ${pass}/${total}`;
  // picked up by tests/browser/run-browser-test.mjs (puppeteer runner)
  globalThis.__browserTest = { done: true, pass, total, results };
}

main().catch((err) => {
  console.error(err);
  setStatus(`error: ${err?.message ?? err}`, 'err');
});
