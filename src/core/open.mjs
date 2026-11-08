// Opens a file with the right backend after checking its signature. Never runs code from the file.
import fs from 'node:fs';
import { detectFormat } from './detect.mjs';
import { openNetcdf3 } from './netcdf3.mjs';
import { openHdf5 } from './hdf5.mjs';
import { openMatV5, openMatV4, probeMatV4 } from './matfile.mjs';

export function sniff(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(128, size)); // 8 bytes for the signatures, 64 for the HDF5 superblock, 128 for the MATLAB header
    fs.readSync(fd, head, 0, head.length, 0);
    const sigAt = off => { if (off + 8 > size) return null; const b = Buffer.alloc(8); fs.readSync(fd, b, 0, 8, off); return b; };
    const d = detectFormat(head, sigAt, size);
    // MATLAB Level 4 files have no signature: accept them only when every variable header chains exactly to the end.
    if (d.format === 'unknown' && /\.mat$/i.test(filePath) && probeMatV4(fd, size)) return { size, format: 'matv4', label: 'MATLAB MAT-file v4' };
    if (d.format === 'unknown' && /\.mat$/i.test(filePath)) {
      return { size, format: 'unknown', label: 'not a MAT-file', reason: 'This .mat file is not a MATLAB MAT-file: it has no MATLAB v4, v5, v7 or v7.3 header. Other programs also use the .mat extension. Use "Open as text" to see what is inside.' };
    }
    return { size, ...d };
  } finally { fs.closeSync(fd); }
}

/** libs: { h5wasm: () => Promise<module>, NetCDFReader } so tests and the bundle inject the same code. */
export async function openFile(filePath, libs, opts = {}) {
  const s = sniff(filePath);
  if (opts.maxFileSizeMB && s.size > opts.maxFileSizeMB * 1024 * 1024) {
    throw Object.assign(new Error(`This file is ${(s.size / 1048576).toFixed(0)} MB. The limit is ${opts.maxFileSizeMB} MB (setting hdf5NetcdfExplorer.maxFileSizeMB).`), { code: 'TOO_BIG' });
  }
  if (s.format === 'netcdf3') return { sniff: s, backend: openNetcdf3(libs.NetCDFReader, filePath, opts) };
  if (s.format === 'hdf5') {
    const h5wasm = await libs.h5wasm();
    return { sniff: s, backend: openHdf5(h5wasm, filePath, s.matlab ? { ...opts, matlab: true } : opts) };
  }
  if (s.format === 'matv5') return { sniff: s, backend: openMatV5(filePath, opts) };
  if (s.format === 'matv4') return { sniff: s, backend: openMatV4(filePath, opts) };
  throw Object.assign(new Error(s.reason || 'Unsupported file'), { code: 'UNSUPPORTED' });
}
