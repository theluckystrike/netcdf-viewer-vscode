// Detects the file format from its first bytes. Never trusts the file extension alone.
const HDF5_SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (head, text) => head && head.length >= text.length && text.split('').every((ch, i) => head[i] === ch.charCodeAt(0));
/**
 * MATLAB Level 5 MAT-file (saved with -v6 or -v7, MATLAB's default): "MATLAB 5.0 MAT-file" text, or any text with
 * version 0x0100 and the "IM"/"MI" byte order mark at bytes 124 to 127 (some writers put other text first).
 */
export function isMatV5(head) {
  if (!head || head.length < 128) return false;
  const e = String.fromCharCode(head[126], head[127]);
  if (e !== 'IM' && e !== 'MI') return false;
  const ver = e === 'IM' ? head[124] | (head[125] << 8) : (head[124] << 8) | head[125];
  if (ver !== 0x0100) return false;
  // Level 4 files have no text header; the first bytes of a Level 5 header are printable text.
  return startsWith(head, 'MATLAB') || head.subarray(0, 4).every(b => b >= 0x20 && b < 0x7f);
}

/**
 * End-of-file address from an HDF5 superblock at offset 0 (versions 0-3), or null if it cannot be read.
 * A file shorter than this address was cut off (an interrupted copy or download).
 */
export function hdf5EofAddress(sb) {
  if (!sb || sb.length < 13 || !HDF5_SIG.every((b, i) => sb[i] === b)) return null;
  const ver = sb[8];
  let o, at;
  if (ver === 0 || ver === 1) { o = sb[13]; at = (ver === 0 ? 24 : 28) + 2 * o; }
  else if (ver === 2 || ver === 3) { o = sb[9]; at = 12 + 2 * o; }
  else return null;
  if (!(o === 4 || o === 8) || sb.length < at + o) return null;
  let v = 0, allFF = true;
  for (let i = o - 1; i >= 0; i--) { v = v * 256 + sb[at + i]; if (sb[at + i] !== 0xff) allFF = false; }
  return allFF ? null : v;
}

/** head: Uint8Array of the first bytes. sigAt: optional reader for HDF5 user-block offsets. */
export function detectFormat(head, sigAt, fileSize) {
  if (head.length >= 4 && head[0] === 0x43 && head[1] === 0x44 && head[2] === 0x46) {
    if (head[3] === 1) return { format: 'netcdf3', label: 'NetCDF-3 classic' };
    if (head[3] === 2) return { format: 'netcdf3', label: 'NetCDF-3 64-bit offset' };
    if (head[3] === 5) return { format: 'netcdf3', label: 'NetCDF-3 CDF-5 (64-bit data)' };
  }
  const isH5 = buf => buf && buf.length >= 8 && HDF5_SIG.every((b, i) => buf[i] === b);
  if (isH5(head)) {
    const eof = hdf5EofAddress(head);
    if (fileSize != null && eof != null && eof > fileSize) {
      return { format: 'unsupported', label: 'HDF5 (truncated)', reason: `This file is truncated: its header says it is ${eof.toLocaleString('en-US')} bytes, but only ${fileSize.toLocaleString('en-US')} bytes are there. The copy or download was probably interrupted. Get the file again.` };
    }
    return { format: 'hdf5', label: 'HDF5' };
  }
  if (sigAt) for (let off = 512; off <= 1 << 30; off *= 2) {
    const b = sigAt(off);
    if (!b) break;
    // MATLAB's HDF5-based MAT-files: "MATLAB 7.3 MAT-file" text (older ones say 7.0) and version 0x0200 in the user block.
    const matH5 = startsWith(head, 'MATLAB 7.3 MAT-file') || (startsWith(head, 'MATLAB') && head.length >= 128 && ((head[124] === 0 && head[125] === 2) || (head[124] === 2 && head[125] === 0)));
    if (isH5(b)) return matH5 ? { format: 'hdf5', label: 'MATLAB MAT-file v7.3 (HDF5)', matlab: true } : { format: 'hdf5', label: 'HDF5 (user block)' };
  }
  if (isMatV5(head)) return { format: 'matv5', label: 'MATLAB MAT-file v5' };
  if (startsWith(head, 'MATLAB 5.0 MAT-file')) return { format: 'unsupported', label: 'MATLAB v5 (truncated)', reason: 'This file starts like a MATLAB MAT-file, but its 128-byte header is cut short. The file is probably truncated.' };
  if (startsWith(head, 'MATLAB 7.3 MAT-file')) return { format: 'unsupported', label: 'MATLAB v7.3 (damaged)', reason: 'This file starts like a MATLAB v7.3 MAT-file, but the HDF5 data that should follow the header is not there. The file is probably truncated or damaged.' };
  if (head.length >= 4 && head[0] === 0xcd && head[1] === 0xf3 && head[2] === 0x00 && head[3] === 0x01) return { format: 'unsupported', label: 'NASA CDF', reason: 'This is a NASA CDF file, not NetCDF. It is not supported.' };
  if (head.length >= 4 && head[0] === 0x0e && head[1] === 0x03 && head[2] === 0x13 && head[3] === 0x01) return { format: 'unsupported', label: 'HDF4', reason: 'This is an HDF4 file. Only HDF5 and NetCDF are supported.' };
  return { format: 'unknown', label: 'unknown', reason: 'This file is not HDF5 or NetCDF, and not a MATLAB MAT-file (no known signature in the first bytes).' };
}
