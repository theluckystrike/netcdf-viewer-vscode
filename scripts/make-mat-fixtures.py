"""Writes the MATLAB MAT-file test fixtures in test/fixtures/mat (used by test/matfile.test.mjs).
Real files come from scipy.io.savemat (v4, v5, v7 compressed) and h5py (v7.3 layout with the MATLAB user block).
Big-endian and hostile files (truncated, bogus sizes, zip bomb, deep nesting, wrong tags) are written byte by byte.
Run: python3 scripts/make-mat-fixtures.py"""
import os
import struct
import zlib

import h5py
import numpy as np
import scipy.io as sio
import scipy.sparse as sp

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'mat')
os.makedirs(OUT, exist_ok=True)
P = lambda name: os.path.join(OUT, name)


def content():
    s_nested = {'level': np.array([[2.5]]), 'tag': 'inner'}
    sa = np.zeros((1, 2), dtype=[('x', 'O'), ('y', 'O')])
    sa[0, 0] = (np.array([[1.0]]), 'first')
    sa[0, 1] = (np.array([[2.0, 3.0]]), 'second')
    cell = np.empty((1, 3), dtype=object)
    cell[0, 0] = np.array([[1.0]])
    cell[0, 1] = 'two'
    cell[0, 2] = np.array([[3, 4, 5]], dtype=np.int16)
    nested = np.empty((1, 1), dtype=object)
    inner = np.empty((1, 1), dtype=object)
    inner[0, 0] = np.array([[42.0]])
    nested[0, 0] = inner
    S = sp.csc_matrix(([1.5, -2.0, 3.25, 7.0], ([0, 3, 1, 4], [0, 0, 2, 3])), shape=(5, 4))
    Sc = sp.csc_matrix(([1 + 1j, 2 - 3j], ([1, 0], [0, 2])), shape=(2, 3))
    Sl = sp.csc_matrix(np.array([[True, False], [False, True], [True, True]]))
    return {
        'A': np.arange(12, dtype=np.float64).reshape(3, 4) + 0.5,  # A[i, j] = 4 i + j + 0.5
        'B': np.array([[1.25, -2.5]], dtype=np.float32),
        'i8': np.array([[-128, 0, 127]], dtype=np.int8),
        'u8': np.array([[0, 200, 255]], dtype=np.uint8),
        'i16': np.array([[-32768, 1, 32767]], dtype=np.int16),
        'u16': np.array([[65535, 2]], dtype=np.uint16),
        'i32': np.array([[-2147483648, 2147483647]], dtype=np.int32),
        'u32': np.array([[4294967295, 3]], dtype=np.uint32),
        'i64': np.array([[-9007199254740993, 9007199254740991, 5]], dtype=np.int64),
        'u64': np.array([[18446744073709551615, 7]], dtype=np.uint64),
        'flag': np.array([[True, False, True]]),
        'greeting': 'hello',
        'unicode': 'café ±',
        'names': np.array(['abc', 'def']),
        'z': np.array([[1 + 2j, 3 - 4j, 0 + 1j], [-1 - 1j, 5 + 0j, 0 - 2j]]),
        'S': S,
        'Sc': Sc,
        'Sl': Sl,
        'c': cell,
        'deep': nested,
        's': {'a': np.array([[7.0]]), 'b': 'text', 'inner': s_nested},
        'sa': sa,
        'empty': np.zeros((0, 0)),
        't3': np.arange(24, dtype=np.float64).reshape(2, 3, 4, order='F'),  # t3(i, j, k) = i + 2 j + 6 k (0-based)
        'col': np.arange(5, dtype=np.float64).reshape(5, 1),
        'small_double': np.array([[1.0, 2.0, 3.0]]),  # MATLAB-style writers may store these as uint8
    }


sio.savemat(P('basic-v5.mat'), content(), format='5', do_compression=False, oned_as='row')
sio.savemat(P('compressed-v7.mat'), content(), format='5', do_compression=True, oned_as='row')
sio.savemat(P('level4.mat'), {'M': np.arange(6, dtype=np.float64).reshape(2, 3), 'txt': 'abc', 'Z': np.array([[1 + 1j, 2 - 2j]])}, format='4')


# ---------- hand-written Level 5 files ----------

def writer(le):
    e = '<' if le else '>'

    def tag(t, n):
        return struct.pack(e + 'II', t, n)

    def elem(t, data):
        return tag(t, len(data)) + data + b'\0' * ((8 - len(data) % 8) % 8)

    def header(text=b'MATLAB 5.0 MAT-file, written by make-mat-fixtures.py'):
        return text.ljust(116, b' ') + b'\0' * 8 + struct.pack(e + 'H', 0x0100) + (b'IM' if le else b'MI')

    def matrix(cls, dims, name, parts=b'', flags=0, raw_dims=False):
        payload = elem(6, struct.pack(e + 'II', cls | flags, 0))
        payload += elem(5, b''.join(struct.pack(e + 'i', d) for d in dims))
        payload += elem(1, name.encode())
        return elem(14, payload + parts)

    def doubles(vals):
        return elem(9, b''.join(struct.pack(e + 'd', v) for v in vals))

    return e, tag, elem, header, matrix, doubles


# Big-endian file (MATLAB on old SPARC/PowerPC machines): a double matrix, an int16 vector, a char row, a complex
# vector, and the same double matrix inside a compressed element.
e, tag, elem, header, matrix, doubles = writer(False)
be = header()
be += matrix(6, [2, 3], 'D', doubles([1, 2, 3, 4, 5, 6]))  # column-major: D = [1 3 5; 2 4 6]
be += matrix(10, [1, 3], 'k', elem(3, struct.pack('>hhh', -5, 300, 7)))
be += matrix(4, [1, 2], 'ch', elem(4, struct.pack('>HH', ord('o'), ord('k'))))
be += matrix(6, [1, 2], 'zc', doubles([1, 2]) + doubles([-1, 0.5]), flags=0x800)
inner = matrix(6, [2, 3], 'Dz', doubles([1, 2, 3, 4, 5, 6]))
comp = zlib.compress(inner)
be += tag(15, len(comp)) + comp
open(P('bigendian-v5.mat'), 'wb').write(be)

e, tag, elem, header, matrix, doubles = writer(True)

# Truncated: the first 60% of the compressed file and of the uncompressed file.
for src, dst in (('basic-v5.mat', 'truncated-v5.mat'), ('compressed-v7.mat', 'truncated-v7.mat')):
    data = open(P(src), 'rb').read()
    open(P(dst), 'wb').write(data[: int(len(data) * 0.6) + 5])  # +5: never on an element boundary

# Bogus sizes: a 2^31-1 x 2^31-1 double whose data has 8 bytes, then a good variable.
bogus = header() + matrix(6, [2147483647, 2147483647], 'huge', doubles([1.0])) + matrix(6, [1, 1], 'ok', doubles([3.5]))
open(P('bogus-dims.mat'), 'wb').write(bogus)

# Zip bombs. (1) The header is honest: 20000 x 20000 doubles (3.2 GB); the compressed bytes stop after the header.
hdr = elem(6, struct.pack('<II', 6, 0)) + elem(5, struct.pack('<ii', 20000, 20000)) + elem(1, b'big')
body = tag(14, len(hdr) + 8 + 20000 * 20000 * 8) + hdr + tag(9, 20000 * 20000 * 8) + b'\0' * 4096
c1 = zlib.compress(body)
# (2) The header lies: a 1 x 1 double whose data element unpacks to 300 MB of zeros (about 300 KB in the file).
co = zlib.compressobj(9)
hdr2 = elem(6, struct.pack('<II', 6, 0)) + elem(5, struct.pack('<ii', 1, 1)) + elem(1, b'liar')
n2 = 300 * 1024 * 1024
parts = [co.compress(tag(14, len(hdr2) + 8 + n2) + hdr2 + tag(9, n2))]
chunk = b'\0' * (1 << 20)
for _ in range(300):
    parts.append(co.compress(chunk))
parts.append(co.flush())
c2 = b''.join(parts)
ok = matrix(6, [1, 1], 'fine', doubles([1.0]))
open(P('bomb.mat'), 'wb').write(header() + tag(15, len(c1)) + c1 + tag(15, len(c2)) + c2 + ok)

# Deep nesting: 200 cells inside each other around one double.
x = matrix(6, [1, 1], '', doubles([9.0]))
for _ in range(200):
    x = matrix(1, [1, 1], '', x)
deep = header() + matrix(1, [1, 1], 'nest', x) + matrix(6, [1, 1], 'after', doubles([2.0]))
open(P('deep-cells.mat'), 'wb').write(deep)

# Wrong tags: a variable whose array flags are a double, one whose data type is 99, a top-level element of type 9,
# then a good variable.
wrong = header()
wrong += elem(14, elem(9, struct.pack('<d', 1)) + elem(5, struct.pack('<ii', 1, 1)) + elem(1, b'w1'))
wrong += matrix(6, [1, 1], 'w2', tag(99, 8) + b'\0' * 8)
wrong += elem(9, struct.pack('<d', 1))
wrong += matrix(6, [1, 2], 'good', doubles([4.0, 5.0]))
open(P('wrong-tags.mat'), 'wb').write(wrong)

# A .mat file of another program (here: text).
open(P('not-matlab.mat'), 'w').write('This .mat file is a text export from some other program.\n1 2 3\n')

# ---------- v7.3 (HDF5 with a 512-byte MATLAB user block) ----------
path = P('v73.mat')
with h5py.File(path, 'w', userblock_size=512, libver='earliest') as f:
    a = np.arange(12, dtype=np.float64).reshape(3, 4) + 0.5
    d = f.create_dataset('A', data=a.T)  # MATLAB writes the transpose: HDF5 shape (4, 3) is MATLAB 3 x 4
    d.attrs['MATLAB_class'] = np.bytes_('double')
    zc = np.array([[1 + 2j, 3 - 4j, 0 + 1j], [-1 - 1j, 5 + 0j, 0 - 2j]])
    ct = np.dtype([('real', '<f8'), ('imag', '<f8')])
    zz = np.empty(zc.T.shape, dtype=ct)
    zz['real'] = zc.T.real
    zz['imag'] = zc.T.imag
    d = f.create_dataset('z', data=zz)
    d.attrs['MATLAB_class'] = np.bytes_('double')
    d = f.create_dataset('greeting', data=np.array([[ord(ch)] for ch in 'hello'], dtype=np.uint16))
    d.attrs['MATLAB_class'] = np.bytes_('char')
    d = f.create_dataset('flag', data=np.array([[1], [0], [1]], dtype=np.uint8))
    d.attrs['MATLAB_class'] = np.bytes_('logical')
with open(path, 'r+b') as fh:
    fh.write(b'MATLAB 7.3 MAT-file, Platform: GLNXA64, Created on: Sun Nov  8 12:00:00 2026 HDF5 schema 1.00 .'.ljust(116, b' ') + b'\0' * 8 + struct.pack('<H', 0x0200) + b'IM')

# ---------- complex numbers in plain HDF5 and NetCDF-4 style files ----------
with h5py.File(P('complex.h5'), 'w') as f:
    f['z128'] = np.array([[1 + 2j, 3 - 4j], [0 + 0j, -1 + 1j], [2 + 0j, 0 - 3j]])  # h5py: compound {r, i}
    f['z64'] = np.array([1 + 1j, -2 + 0.5j, 0 - 1j], dtype=np.complex64)
    t = np.dtype([('real', '<f4'), ('imag', '<f4')])
    w = np.zeros(4, dtype=t)
    w['real'] = [1, 0, -1, 0]
    w['imag'] = [0, 1, 0, -1]
    f['ri'] = w  # {real, imag}
    o = np.zeros(2, dtype=[('a', '<f8'), ('b', '<f8')])
    f['notcomplex'] = o  # two floats with other names stay a compound table
print('ok', sorted(os.listdir(OUT)))
