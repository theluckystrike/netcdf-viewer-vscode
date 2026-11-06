'use strict';
// Bundles the extension host (CJS), the worker (ESM, loads the h5wasm Node build) and the webview (IIFE).
const esbuild = require('esbuild');
const root = require('path').join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/worker.mjs'], outfile: 'dist/worker.mjs', platform: 'node', format: 'esm', target: 'node18',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" } }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).then(() => console.log('built'), () => process.exit(1));
