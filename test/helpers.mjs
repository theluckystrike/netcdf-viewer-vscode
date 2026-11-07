import { NetCDFReader } from 'netcdfjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
export const S = p => fileURLToPath(new URL('../samples/' + p, import.meta.url));
export const expected = JSON.parse(fs.readFileSync(S('expected.json'), 'utf8'));
import { installFilterPlugins } from '../src/core/filters.mjs';
export const PLUGIN_DIR = fileURLToPath(new URL('../node_modules/h5wasm-plugins/plugins/', import.meta.url));
export const libs = { NetCDFReader, h5wasm: async () => { const m = (await import('h5wasm/node')).default; installFilterPlugins(await m.ready, [PLUGIN_DIR]); return m; } };
