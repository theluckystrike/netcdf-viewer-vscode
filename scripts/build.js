'use strict';
// Bundles the extension host (CJS), the worker (ESM, loads the h5wasm Node build) and the webview (IIFE).
const esbuild = require('esbuild');
const root = require('path').join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
Promise.all([
  // ZOVO_TEST_PUBKEY: gate builds only. The release build trusts only the live key in src/license.
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'],
    define: process.env.ZOVO_TEST_PUBKEY ? { __ZOVO_TEST_PUBKEY__: JSON.stringify(process.env.ZOVO_TEST_PUBKEY) } : {} }),
  esbuild.build({ ...common, entryPoints: ['src/worker.mjs'], outfile: 'dist/worker.mjs', platform: 'node', format: 'esm', target: 'node18',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" } }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).then(() => {
  // HDF5 compression plugins (h5wasm-plugins): the worker adds dist/plugins to h5wasm's plugin search path.
  const fs = require('fs'), path = require('path');
  const PLUGINS = ['bshuf', 'blosc', 'blosc2', 'bz2', 'lz4', 'lzf', 'zfp', 'zstd']; // same list as src/core/filters.mjs
  const from = path.join(root, 'node_modules/h5wasm-plugins/plugins'), to = path.join(root, 'dist/plugins');
  fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
  for (const n of PLUGINS) fs.copyFileSync(path.join(from, `libH5Z${n}.so`), path.join(to, `libH5Z${n}.so`));
  console.log('built');
}, () => process.exit(1));
