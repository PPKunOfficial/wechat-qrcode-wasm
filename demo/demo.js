/**
 * Demo UI for the WeChat QRCode wasm build.
 *
 * Everything QR-related lives in ../web/scanner.js; this file is just camera plumbing,
 * overlay drawing and result bookkeeping.
 */

import { createScanner } from '../web/scanner.js';

const els = {
  video: document.getElementById('video'),
  snapshot: document.getElementById('snapshot'),
  overlay: document.getElementById('overlay'),
  viewport: document.getElementById('viewport'),
  viewportEmpty: document.getElementById('viewport-empty'),
  fpsBadge: document.getElementById('fps-badge'),
  btnCamera: document.getElementById('btn-camera'),
  btnTorch: document.getElementById('btn-torch'),
  btnClear: document.getElementById('btn-clear'),
  fileInput: document.getElementById('file-input'),
  scale: document.getElementById('scale'),
  scaleValue: document.getElementById('scale-value'),
  autoScale: document.getElementById('auto-scale'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  statLatency: document.getElementById('stat-latency'),
  statFps: document.getElementById('stat-fps'),
  statCount: document.getElementById('stat-count'),
  statModels: document.getElementById('stat-models'),
  resultList: document.getElementById('result-list'),
  resultEmpty: document.getElementById('result-empty'),
  meta: document.getElementById('meta'),
};

const MODEL_URLS = {
  // Models are served from the repository's models/ directory (see README).
  detectModel: new URL('../models/detect.onnx', import.meta.url).href,
  srModel: new URL('../models/sr.onnx', import.meta.url).href,
};

const state = {
  scanner: null,
  stream: null,
  rafId: 0,
  scanning: false,
  lastScanAt: 0,
  scanIntervalMs: 70,
  latencyMs: 0,
  fps: 0,
  fpsWindow: [],
  torchOn: false,
  torchSupported: false,
  seen: new Set(),
  staticImage: null,
  audioCtx: null,
};

// ---------------------------------------------------------------------------
// helpers

function setStatus(text, kind = 'ready') {
  els.statusText.textContent = text;
  els.status.dataset.state = kind;
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function beep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    state.audioCtx = state.audioCtx || new AudioCtx();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1180;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {
    /* audio is best-effort */
  }
}

function vibrate(pattern = 40) {
  navigator.vibrate?.(pattern);
}

// ---------------------------------------------------------------------------
// overlay

function resizeOverlay() {
  const rect = els.viewport.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
  els.overlay.style.width = `${rect.width}px`;
  els.overlay.style.height = `${rect.height}px`;
  return { width: rect.width, height: rect.height, dpr };
}

/** Maps source pixel coords (video/image) to overlay coords for object-fit: contain. */
function makeMapper(srcWidth, srcHeight, viewWidth, viewHeight, dpr) {
  const scale = Math.min(viewWidth / srcWidth, viewHeight / srcHeight);
  const offsetX = (viewWidth - srcWidth * scale) / 2;
  const offsetY = (viewHeight - srcHeight * scale) / 2;
  return (x, y) => [(offsetX + x * scale) * dpr, (offsetY + y * scale) * dpr];
}

function drawQuads(quads, srcWidth, srcHeight) {
  const { width, height, dpr } = resizeOverlay();
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!srcWidth || !srcHeight) return;
  const map = makeMapper(srcWidth, srcHeight, width, height, dpr);

  for (const quad of quads) {
    if (!quad || quad.length !== 4) continue;
    const pts = quad.map(([x, y]) => map(x, y));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();

    // Glow + crisp outline.
    ctx.shadowColor = 'rgba(61, 220, 151, 0.85)';
    ctx.shadowBlur = 18 * dpr;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = '#3ddc97';
    ctx.stroke();
    ctx.shadowBlur = 0;

    const gradient = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[2][0], pts[2][1]);
    gradient.addColorStop(0, 'rgba(61, 220, 151, 0.22)');
    gradient.addColorStop(1, 'rgba(90, 169, 255, 0.22)');
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

function clearOverlay() {
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

// ---------------------------------------------------------------------------
// results

function addResults(results, elapsedMs, source) {
  let added = 0;
  for (const result of results) {
    const key = result.text;
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    added++;
    const li = document.createElement('li');
    const payload = document.createElement('div');
    payload.className = 'payload';
    payload.textContent = result.text;

    const meta = document.createElement('div');
    meta.className = 'meta-line';
    const stamp = new Date().toLocaleTimeString();
    meta.innerHTML = `<span>${source} · ${stamp}</span><span>${fmtMs(elapsedMs)}</span>`;

    const copy = document.createElement('button');
    copy.className = 'btn ghost small copy';
    copy.textContent = '复制';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(result.text);
        copy.textContent = '已复制';
        setTimeout(() => (copy.textContent = '复制'), 1200);
      } catch {
        copy.textContent = '复制失败';
      }
    });

    li.append(payload, meta, copy);
    els.resultList.prepend(li);
  }
  if (added) {
    els.resultEmpty.hidden = true;
    els.statCount.textContent = String(state.seen.size);
    beep();
    vibrate();
  }
  return added;
}

// ---------------------------------------------------------------------------
// scanning

function currentScale() {
  if (els.autoScale.checked) return -1;
  return Number(els.scale.value);
}

function updateScaleLabel() {
  const auto = els.autoScale.checked;
  els.scale.disabled = auto;
  els.scaleValue.textContent = auto ? 'auto' : Number(els.scale.value).toFixed(2);
}

function scanFrame(now) {
  state.rafId = requestAnimationFrame(scanFrame);
  if (!state.scanner || !state.stream) return;

  // Throttle: decoding is the expensive part, not the camera.
  if (now - state.lastScanAt < state.scanIntervalMs) return;
  state.lastScanAt = now;

  const video = els.video;
  if (!video.videoWidth || video.readyState < 2) return;

  const t0 = performance.now();
  let outcome;
  try {
    outcome = state.scanner.scan(video, { scaleFactor: currentScale() });
  } catch (err) {
    console.error(err);
    setStatus(`扫描失败: ${err.message}`, 'error');
    return;
  }
  const wallMs = performance.now() - t0;
  state.latencyMs = outcome.ok ? outcome.ms : 0;
  els.statLatency.textContent = fmtMs(outcome.ok ? outcome.ms : wallMs);

  // Rolling fps of actual scans.
  state.fpsWindow.push(now);
  while (state.fpsWindow.length && now - state.fpsWindow[0] > 1000) state.fpsWindow.shift();
  state.fps = state.fpsWindow.length;
  els.statFps.textContent = String(state.fps);
  els.fpsBadge.hidden = false;
  els.fpsBadge.textContent = `${state.fps} fps · ${fmtMs(outcome.ok ? outcome.ms : wallMs)}`;

  drawQuads(outcome.results.map((r) => r.points), video.videoWidth, video.videoHeight);
  if (outcome.results.length) {
    addResults(outcome.results, outcome.ms, '相机');
  }
}

async function startCamera() {
  if (!state.scanner) return;
  try {
    setStatus('请求相机权限…', 'loading');
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.viewportEmpty.hidden = true;
    els.snapshot.hidden = true;
    els.btnCamera.textContent = '停止相机';
    els.btnTorch.disabled = false;
    setStatus('相机已就绪', 'ready');

    const track = state.stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    state.torchSupported = !!caps.torch;
    els.btnTorch.disabled = !state.torchSupported;
    els.meta.textContent = `${track.label || 'camera'} · ${els.video.videoWidth}×${els.video.videoHeight}`;

    state.lastScanAt = 0;
    state.scanning = true;
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(scanFrame);
  } catch (err) {
    console.error(err);
    setStatus(`无法启动相机: ${err.message}`, 'error');
  }
}

function stopCamera() {
  state.scanning = false;
  cancelAnimationFrame(state.rafId);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  els.video.srcObject = null;
  els.btnCamera.textContent = '启动相机';
  els.btnTorch.disabled = true;
  els.fpsBadge.hidden = true;
  els.viewportEmpty.hidden = !state.staticImage;
  clearOverlay();
  setStatus('相机已停止', 'ready');
}

async function toggleTorch() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    state.torchOn = !state.torchOn;
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    els.btnTorch.textContent = state.torchOn ? '关闭补光' : '补光灯';
  } catch (err) {
    console.warn('torch failed', err);
    els.btnTorch.disabled = true;
  }
}

async function scanUploadedFile(file) {
  if (!state.scanner) return;
  try {
    setStatus('解码图片…', 'loading');
    stopCamera();
    els.snapshot.hidden = false;
    const bitmap = await createImageBitmap(file);
    const blobUrl = URL.createObjectURL(file);
    els.snapshot.src = blobUrl;
    await els.snapshot.decode?.();
    els.viewportEmpty.hidden = true;
    state.staticImage = file;

    const t0 = performance.now();
    const outcome = state.scanner.scan(bitmap, { scaleFactor: currentScale() });
    const wallMs = performance.now() - t0;
    bitmap.close?.();
    await new Promise((resolve) => requestAnimationFrame(resolve)); // let <img> layout settle
    drawQuads(outcome.results.map((r) => r.points), els.snapshot.naturalWidth, els.snapshot.naturalHeight);
    els.statLatency.textContent = fmtMs(outcome.ok ? outcome.ms : wallMs);
    const added = addResults(outcome.results, outcome.ms, '图片');
    if (!added && outcome.results.length) {
      setStatus(`已识别 ${outcome.results.length} 个（内容与历史重复）`, 'ready');
    } else if (!outcome.results.length) {
      setStatus('这张图片里没找到二维码', 'error');
    } else {
      setStatus(`识别成功 · ${outcome.results.length} 个二维码`, 'ready');
    }
    els.meta.textContent = `${file.name} · ${els.snapshot.naturalWidth}×${els.snapshot.naturalHeight}`;
  } catch (err) {
    console.error(err);
    setStatus(`图片解码失败: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// boot

async function boot() {
  updateScaleLabel();
  els.scale.addEventListener('input', updateScaleLabel);
  els.autoScale.addEventListener('change', updateScaleLabel);

  setStatus('下载模型…', 'loading');
  try {
    state.scanner = await createScanner({
      ...MODEL_URLS,
      printErr: (msg) => console.warn('[wasm]', msg),
      // Let the module build a tiny bit faster: no run dependency needed.
    });
  } catch (err) {
    console.error(err);
    setStatus(`WASM 加载失败: ${err.message}`, 'error');
    return;
  }

  els.statModels.textContent = `${state.scanner.opencvVersion}`;
  els.meta.textContent = `OpenCV ${state.scanner.opencvVersion} · detect ${(
    state.scanner.modelInfo.detectBytes / 1024
  ).toFixed(0)} KB · sr ${(state.scanner.modelInfo.srBytes / 1024).toFixed(0)} KB`;
  setStatus('就绪', 'ready');
  els.btnCamera.disabled = false;

  els.btnCamera.addEventListener('click', () => {
    if (state.stream) stopCamera();
    else startCamera();
  });
  els.btnTorch.addEventListener('click', toggleTorch);
  els.btnClear.addEventListener('click', () => {
    state.seen.clear();
    els.resultList.innerHTML = '';
    els.resultEmpty.hidden = false;
    els.statCount.textContent = '0';
  });
  els.fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) scanUploadedFile(file);
    event.target.value = '';
  });
  window.addEventListener('resize', () => {
    if (state.staticImage && els.snapshot.hidden === false) {
      drawQuads([], 0, 0);
    }
  });
}

boot();
