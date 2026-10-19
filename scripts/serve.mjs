#!/usr/bin/env node
/**
 * Minimal static file server for the demo and the browser benchmark page.
 *
 * Emscripten's ES modules must be served over HTTP (not file://) and the wasm MIME
 * type must be application/wasm for instantiateStreaming to work.
 *
 * Usage:
 *   node scripts/serve.mjs [--port 5173] [--root .]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const port = Number(argValue('--port', process.env.PORT || 5173));
const root = resolve(argValue('--root', repoRoot));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(base, relative);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = safeJoin(root, pathname);
    if (!filePath) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    const target = info?.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      // Keep the door open for a pthread build later; harmless otherwise.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    } else {
      console.error(err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('server error');
    }
  }
});

server.listen(port, () => {
  console.log(`serving ${root}`);
  console.log(`  demo:      http://127.0.0.1:${port}/demo/`);
  console.log(`  benchmark: http://127.0.0.1:${port}/tests/browser/`);
});
