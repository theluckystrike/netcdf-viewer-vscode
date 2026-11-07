// HDF5 compression plugins from h5wasm-plugins 0.3.0 (LZF, Blosc, Blosc2, bitshuffle, LZ4, Zstd, bzip2, ZFP).
// h5wasm loads a filter from its plugin search path the first time a dataset needs it. Each library below was
// checked against a file written by h5py + hdf5plugin (test/filters.test.mjs). Pure Node, no network.
import fs from 'node:fs';
import path from 'node:path';
import { addDecodableFilters } from './values.mjs';

/** Plugin library name (libH5Z<name>.so) -> the HDF5 filter id it registers. */
export const FILTER_PLUGINS = { bshuf: 32008, blosc: 32001, blosc2: 32026, bz2: 307, lz4: 32004, lzf: 32000, zfp: 32013, zstd: 32015 };

/**
 * Adds the first folder of dirs that holds plugin libraries to h5wasm's plugin search path, and marks their filters
 * as decodable. module: the object h5wasm.ready resolves to. Returns { dir, names } or null when none is found.
 */
export function installFilterPlugins(module, dirs) {
  if (!module || typeof module.insert_plugin_search_path !== 'function') return null;
  for (const dir of dirs) {
    if (!dir) continue;
    const names = Object.keys(FILTER_PLUGINS).filter(n => fs.existsSync(path.join(dir, `libH5Z${n}.so`)));
    if (!names.length) continue;
    module.insert_plugin_search_path(dir, 0);
    addDecodableFilters(names.map(n => FILTER_PLUGINS[n]));
    return { dir, names };
  }
  return null;
}
