#!/usr/bin/env node
/**
 * Node smoke test / accuracy check for the wasm build.
 *
 * Runs the generated test corpus (tests/assets/manifest.json) through the production
 * wrapper (web/scanner.js) and the wasm module, feeding raw RGBA bytes exactly like
 * the browser does.
 *
 * Usage:
 *   node tests/run-tests.mjs [--verbose] [--filter clean] [--tiles 2]
 *
 * Exit code is non-zero when an asset tagged "clean" fails to decode.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assetsDir,
  filterAssets,
  fmtMs,
  loadManifest,
  loadWrapper,
  scanRgba,
} from './_harness.mjs';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const filter = flag('--filter');
const tiles = Number(flag('--tiles', '0'));

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const assets = filterAssets((await loadManifest()).assets, filter);

  const scanner = await loadWrapper({ verbose });
  console.log(`OpenCV ${scanner.opencvVersion} | wasm module + models loaded in ${fmtMs(scanner.loadMs)}`);
  console.log(
    `detect.onnx ${scanner.formatBytes(scanner.modelInfo.detectBytes)} | ` +
      `sr.onnx ${scanner.formatBytes(scanner.modelInfo.srBytes)}` +
      (tiles > 1 ? ` | tiled fallback: ${tiles}x${tiles}` : ''),
  );
  console.log('');

  const opts = { tiles };
  let decoded = 0;
  let totalMs = 0;
  let cleanFailures = 0;
  let hardDecoded = 0;
  let hardTotal = 0;
  const rows = [];

  for (const asset of assets) {
    const rgba = await readFile(join(assetsDir, asset.raw));
    const result = scanRgba(scanner, rgba, asset.width, asset.height, opts);
    const payloadOk = result.results.some((r) => r.text === asset.payload);
    totalMs += result.ms;
    if (payloadOk) decoded++;
    if (!payloadOk && asset.tags.includes('clean')) cleanFailures++;
    if (asset.tags.includes('hard')) {
      hardTotal++;
      if (payloadOk) hardDecoded++;
    }
    rows.push({
      id: asset.id,
      tags: asset.tags.join(','),
      size: `${asset.width}x${asset.height}`,
      ms: result.ms,
      ok: payloadOk,
      count: result.count,
      fallback: result.tiles ? `${result.tiles} tiles` : '',
      preview: (result.results[0]?.text ?? '').slice(0, 40),
    });
  }

  console.log(
    `${pad('asset', 26)} ${pad('tags', 24)} ${pad('size', 11)} ${pad('time', 8)} ${pad('result', 7)} count`,
  );
  console.log('-'.repeat(104));
  for (const row of rows) {
    const note = row.ok ? '' : `  (${row.preview})`;
    console.log(
      `${pad(row.id, 26)} ${pad(row.tags, 24)} ${pad(row.size, 11)} ${pad(fmtMs(row.ms), 8)} ${pad(
        row.ok ? 'PASS' : 'FAIL',
        7,
      )} ${row.count}${row.fallback ? ` (${row.fallback})` : ''}${note}`,
    );
  }
  console.log('-'.repeat(104));
  console.log(
    `decoded ${decoded}/${rows.length} assets | total ${fmtMs(totalMs)} | avg ${fmtMs(totalMs / rows.length)}`,
  );
  const clean = rows.filter((r) => r.tags.includes('clean'));
  if (clean.length) console.log(`clean reference set: ${clean.filter((r) => r.ok).length}/${clean.length}`);
  if (hardTotal) console.log(`hard tier: ${hardDecoded}/${hardTotal}`);

  scanner.destroy();
  if (cleanFailures > 0) {
    console.error(`\nERROR: ${cleanFailures} clean asset(s) failed to decode`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
