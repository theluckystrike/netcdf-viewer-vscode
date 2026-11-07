#!/usr/bin/env python3
"""Writes test/fixtures/filters/<filter>.h5: one 64 x 64 int32 dataset /x = arange(4096), chunks 32 x 32, compressed
with each HDF5 plugin filter the viewer ships (h5wasm-plugins), plus SZ, which it does not ship.
Run: python3 scripts/make-filter-fixtures.py   (needs numpy, h5py, hdf5plugin)"""
import os, numpy as np, h5py, hdf5plugin

out = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'filters')
os.makedirs(out, exist_ok=True)
x = np.arange(64 * 64, dtype='<i4').reshape(64, 64)
F = {
    'lzf': dict(compression='lzf'), 'blosc': dict(hdf5plugin.Blosc()), 'blosc2': dict(hdf5plugin.Blosc2()),
    'bzip2': dict(hdf5plugin.BZip2()), 'lz4': dict(hdf5plugin.LZ4()), 'zstd': dict(hdf5plugin.Zstd()),
    'bitshuffle': dict(hdf5plugin.Bitshuffle()), 'bitshuffle-lz4': dict(hdf5plugin.Bitshuffle(cname='lz4')),
    'zfp': dict(hdf5plugin.Zfp(reversible=True)), 'sz': dict(hdf5plugin.SZ(absolute=0.1)),
}
for name, kw in F.items():
    data = x.astype('<f4') if name in ('zfp', 'sz') else x
    with h5py.File(os.path.join(out, name + '.h5'), 'w') as f:
        f.create_dataset('x', data=data, chunks=(32, 32), **kw)
print('wrote', len(F), 'files to', os.path.normpath(out))
