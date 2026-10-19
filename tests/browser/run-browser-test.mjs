#!/usr/bin/env node
/**
 * Headless-browser verification of the wasm build.
 *
 * Starts scripts/serve.mjs (or reuses --url), opens tests/browser/ in a real Chrome via
 * puppeteer-core, waits for the page to finish the corpus run, and prints the result.
 *
 * Usage:
 *   node tests/browser/run-browser-test.mjs [--browser <path>] [--url http://127.0.0.1:5173]
 *                                           [--screenshot build/browser-tests.png]
 *
 * Exits non-zero when any asset fails to decode in the browser.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { repoRoot } from '../_harness.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const browserPath =
  flag('--browser') ||
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = Number(flag('--port', '5199'));
const url = flag('--url', `http://127.0.0.1:${port}/tests/browser/`);
const screenshot = flag('--screenshot', join(repoRoot, 'build', 'browser-tests.png'));

const serverScript = join(repoRoot, 'scripts', 'serve.mjs');

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('static server did not start in time')), 15000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('demo:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`static server exited early (${code})`)));
  });
}

async function main() {
  let server = null;
  // Assume a server is already running when --url points at a custom host.
  if (!args.includes('--url')) {
    server = spawn(process.execPath, [serverScript, '--port', String(port)], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(server);
    console.log(`static server on http://127.0.0.1:${port}`);
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    page.on('console', (msg) => console.log(`[page] ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`[page error] ${err.message}`));

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('globalThis.__browserTest && globalThis.__browserTest.done', {
      timeout: 180000,
      polling: 250,
    });
    const report = await page.evaluate(() => globalThis.__browserTest);

    console.log('');
    for (const row of report.results) {
      console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id.padEnd(28)} ${Math.round(row.ms)} ms`);
    }
    console.log('');
    console.log(`browser: decoded ${report.pass}/${report.total}`);

    if (screenshot) {
      await mkdir(dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot });
      console.log(`screenshot: ${screenshot}`);
    }

    if (report.pass !== report.total) process.exitCode = 1;
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
