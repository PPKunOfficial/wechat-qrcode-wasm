#!/usr/bin/env node
/**
 * One-shot build: OpenCV wasm static libs -> dist/wq.js + dist/wq.wasm.
 *
 * Runs the PowerShell scripts in order so they share the same environment setup:
 *   1. scripts/configure-opencv.ps1   (skipped when build/opencv-wasm already configured)
 *   2. scripts/build-opencv.ps1       (cmake --build + install)
 *   3. scripts/build-wasm.ps1         (link dist/wq.js / dist/wq.wasm)
 *
 * Usage: node scripts/build-all.mjs [--reconfigure] [--jobs N]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const reconfigure = args.includes('--reconfigure');
const jobsIndex = args.indexOf('--jobs');
const jobs = jobsIndex >= 0 ? args[jobsIndex + 1] : undefined;

const buildDir = path.join(repoRoot, 'build', 'opencv-wasm');
const configured = existsSync(path.join(buildDir, 'build.ninja'));
const pwsh = process.platform === 'win32' ? 'pwsh' : 'pwsh';

function run(script, extra = []) {
  const file = path.join(repoRoot, 'scripts', script);
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', file, ...extra], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status}`);
  }
}

if (reconfigure || !configured) {
  run('configure-opencv.ps1', reconfigure ? ['-Reconfigure'] : []);
} else {
  console.log('build/opencv-wasm already configured; pass --reconfigure to start over.');
}

run('build-opencv.ps1', jobs ? ['-Jobs', String(jobs)] : []);
run('build-wasm.ps1');
