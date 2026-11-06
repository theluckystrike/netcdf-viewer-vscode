"""Writes two small HDF5 files with a 512-byte user block, the layout used by Julia JLD2 and MATLAB 7.3 files.
Used by test/anyfile-export.test.mjs. Run: python3 scripts/make-userblock-fixtures.py"""
import os
import h5py
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(OUT, exist_ok=True)


def write(name, header, fill):
    path = os.path.join(OUT, name)
    with h5py.File(path, 'w', userblock_size=512, libver='earliest') as f:
        fill(f)
    with open(path, 'r+b') as fh:
        fh.write(header.ljust(512, b'\x00')[:512])
    return path


def jld2(f):
    t = f.create_dataset('t', data=np.arange(4, dtype='f8') * 0.5)
    t.make_scale('t')
    x = f.create_dataset('x', data=np.array([10, 20, 30], dtype='i4'))
    x.make_scale('x')
    u = f.create_dataset('u', data=np.arange(12, dtype='f4').reshape(4, 3) / 4)
    u.dims[0].attach_scale(t)
    u.dims[1].attach_scale(x)
    u.attrs['units'] = 'm/s'


def mat73(f):
    f.create_dataset('A', data=np.array([[1.5, 2.5], [3.5, 4.5]]))


write('model.jld2', b'HDF5-based Julia Data Format, version 0.1.6\x00', jld2)
write('matrix-v73.mat', b'MATLAB 7.3 MAT-file, Platform: GLNXA64, Created on: Fri Nov  6 12:00:00 2026 HDF5 schema 1.00 .', mat73)
print('ok')
