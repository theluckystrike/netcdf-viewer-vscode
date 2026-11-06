#!/usr/bin/env python3
"""Writes the small real sample files used by tests and screenshots (all under 1 MB).

  samples/era5-t2m-sample.nc      NetCDF-4 (HDF5) with CF metadata, packed int16, gzip+shuffle, dimension scales
  samples/argo-profiles-classic.nc NetCDF-3 classic, record dimension, noleap calendar, char variable
  samples/beamline-scan.h5        plain HDF5: nested groups, image, spectrum, compound table, links, LZF filter
Run: python3 scripts/make-samples.py   (needs numpy, h5py, scipy)
"""
import os
import numpy as np
import h5py
from scipy.io import netcdf_file

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'samples')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)


def era5():
    path = os.path.join(OUT, 'era5-t2m-sample.nc')
    nt, nlat, nlon = 24, 73, 144
    lat = np.linspace(90, -90, nlat).astype('f4')
    lon = np.arange(0, 360, 2.5).astype('f4')
    time = (1095000 + np.arange(nt) * 6).astype('i4')  # hours since 1900-01-01
    la, lo = np.meshgrid(np.deg2rad(lat), np.deg2rad(lon), indexing='ij')
    t2m = np.empty((nt, nlat, nlon), 'f8')
    for i in range(nt):
        diurnal = 4 * np.cos(lo + 2 * np.pi * i / 4)
        t2m[i] = 288 - 40 * np.sin(la) ** 2 + 6 * np.cos(3 * lo) * np.cos(la) + diurnal * np.cos(la) + rng.normal(0, 0.6, la.shape)
    scale, offset = 0.0025, 260.0
    packed = np.round((t2m - offset) / scale).astype('i2')
    packed[0, 0:3, 0:5] = -32767  # a few fill values
    tp = np.clip(rng.gamma(0.4, 0.002, (nt, nlat, nlon)) * (np.cos(la) ** 2 + 0.1), 0, None).astype('f4')
    tp[:, 70:, :] = np.nan
    with h5py.File(path, 'w', libver='earliest') as f:
        f.attrs['Conventions'] = 'CF-1.8'
        f.attrs['title'] = 'ERA5-style 2 m temperature and precipitation, synthetic sample'
        f.attrs['institution'] = 'zovo sample generator'
        f.attrs['history'] = '2026-11-06 make-samples.py'
        f.attrs['_NCProperties'] = 'version=2,h5py=%s' % h5py.__version__
        dims = {}
        for i, (name, data, attrs) in enumerate([
            ('time', time, {'units': 'hours since 1900-01-01 00:00:00.0', 'long_name': 'time', 'calendar': 'gregorian', 'standard_name': 'time', 'axis': 'T'}),
            ('latitude', lat, {'units': 'degrees_north', 'long_name': 'latitude', 'standard_name': 'latitude', 'axis': 'Y'}),
            ('longitude', lon, {'units': 'degrees_east', 'long_name': 'longitude', 'standard_name': 'longitude', 'axis': 'X'}),
        ]):
            d = f.create_dataset(name, data=data)
            for k, v in attrs.items():
                d.attrs[k] = v
            d.attrs['_Netcdf4Dimid'] = np.int32(i)
            d.make_scale(name)
            dims[name] = d
        v = f.create_dataset('t2m', data=packed, chunks=(1, nlat, nlon), compression='gzip', compression_opts=4, shuffle=True, fillvalue=np.int16(-32767))
        v.attrs['scale_factor'] = np.float64(scale)
        v.attrs['add_offset'] = np.float64(offset)
        v.attrs['_FillValue'] = np.int16(-32767)
        v.attrs['missing_value'] = np.int16(-32767)
        v.attrs['units'] = 'K'
        v.attrs['long_name'] = '2 metre temperature'
        v.attrs['standard_name'] = 'air_temperature'
        v.attrs['coordinates'] = 'latitude longitude'
        p = f.create_dataset('tp', data=tp, chunks=(4, nlat, nlon), compression='gzip', compression_opts=6)
        p.attrs['units'] = 'm'
        p.attrs['long_name'] = 'Total precipitation'
        p.attrs['standard_name'] = 'precipitation_amount'
        for var in (v, p):
            for i, name in enumerate(['time', 'latitude', 'longitude']):
                var.dims[i].attach_scale(dims[name])
    return path


def argo():
    path = os.path.join(OUT, 'argo-profiles-classic.nc')
    nprof, ndepth = 12, 40
    with netcdf_file(path, 'w', version=2) as f:
        f.title = 'Ocean profiles, synthetic sample'
        f.Conventions = 'CF-1.6'
        f.createDimension('time', None)
        f.createDimension('depth', ndepth)
        f.createDimension('name_len', 8)
        t = f.createVariable('time', 'f8', ('time',))
        t.units = 'days since 2000-01-01 00:00:00'
        t.calendar = 'noleap'
        t.long_name = 'profile time'
        t[:] = 9490 + np.arange(nprof) * 10.5
        d = f.createVariable('depth', 'f4', ('depth',))
        d.units = 'm'
        d.positive = 'down'
        d[:] = np.linspace(0, 2000, ndepth)
        z = np.linspace(0, 2000, ndepth)
        temp = f.createVariable('temp', 'f4', ('time', 'depth'))
        temp.units = 'degree_Celsius'
        temp.long_name = 'sea water temperature'
        temp.standard_name = 'sea_water_temperature'
        temp._FillValue = np.float32(-999.0)
        vals = (2 + 24 * np.exp(-z / 300)[None, :] + rng.normal(0, 0.3, (nprof, ndepth))).astype('f4')
        vals[3, 30:] = -999.0
        temp[:] = vals
        sal = f.createVariable('salinity', 'i2', ('time', 'depth'))
        sal.units = '1e-3'
        sal.scale_factor = np.float32(0.001)
        sal.add_offset = np.float32(35.0)
        sal.long_name = 'sea water salinity'
        sal[:] = np.round((34.5 + 0.6 * np.tanh((z - 500) / 300)[None, :] + rng.normal(0, 0.02, (nprof, ndepth)) - 35.0) / 0.001).astype('i2')
        st = f.createVariable('station', 'c', ('time', 'name_len'))
        st.long_name = 'station name'
        names = ['WMO%05d' % (1000 + i) for i in range(nprof)]
        st[:] = np.array([list(n.ljust(8)) for n in names], dtype='S1')
    return path


def beamline():
    path = os.path.join(OUT, 'beamline-scan.h5')
    with h5py.File(path, 'w') as f:
        f.attrs['facility'] = 'Sample Light Source'
        f.attrs['file_format_version'] = np.int32(3)
        e = f.create_group('entry')
        e.attrs['NX_class'] = 'NXentry'
        e.attrs['start_time'] = '2026-11-06T09:00:00Z'
        det = e.create_group('instrument/detector')
        det.attrs['NX_class'] = 'NXdetector'
        y, x = np.mgrid[0:256, 0:256]
        img = 200 + 3000 * np.exp(-((x - 128) ** 2 + (y - 120) ** 2) / 900.0)
        for r in (40, 70, 100):
            img += 800 * np.exp(-((np.hypot(x - 128, y - 120) - r) ** 2) / 20.0)
        img = rng.poisson(img).astype('u2')
        im = det.create_dataset('image', data=img, chunks=(64, 64), compression='gzip', compression_opts=5)
        im.attrs['units'] = 'counts'
        im.attrs['exposure_s'] = 0.5
        en = np.linspace(5, 25, 2000)
        spec = 1000 * np.exp(-((en - 12) ** 2) / 0.02) + 400 * np.exp(-((en - 17.5) ** 2) / 0.05) + 50 + rng.normal(0, 8, en.size)
        e.create_dataset('data/energy_keV', data=en)
        s = e.create_dataset('data/spectrum', data=spec)
        s.attrs['units'] = 'counts/s'
        s.attrs['axes'] = 'energy_keV'
        dt = np.dtype([('step', 'i4'), ('motor_x_mm', 'f8'), ('motor_y_mm', 'f8'), ('ok', '?')])
        rows = np.zeros(50, dtype=dt)
        rows['step'] = np.arange(50)
        rows['motor_x_mm'] = np.linspace(0, 4.9, 50)
        rows['motor_y_mm'] = np.sin(np.arange(50) / 5)
        rows['ok'] = np.arange(50) % 7 != 0
        e.create_dataset('scan/positions', data=rows)
        e.create_dataset('scan/stack_lzf', data=rng.random((10, 64, 64)).astype('f4'), chunks=(1, 64, 64), compression='lzf')
        e['sample_name'] = np.bytes_(b'silicon wafer #7')
        e['data/latest_image'] = h5py.SoftLink('/entry/instrument/detector/image')
        e['data/calibration'] = h5py.ExternalLink('calibration.h5', '/coeffs')
        f.create_dataset('notes/labels', data=np.array(['dark', 'flat', 'scan <b>&</b>'], dtype=h5py.string_dtype()))
    return path


def huge_sparse():
    """A 100000 x 100000 float32 dataset (37 GB logical) with one chunk written: tests paging on huge shapes."""
    path = os.path.join(OUT, 'huge-sparse.h5')
    with h5py.File(path, 'w') as f:
        d = f.create_dataset('big', shape=(100000, 100000), dtype='f4', chunks=(1000, 1000), compression='gzip', fillvalue=np.float32(-1))
        d[0:1000, 0:1000] = np.arange(1000 * 1000, dtype='f4').reshape(1000, 1000)
        d.attrs['note'] = 'only the first chunk is written; the rest reads as the fill value -1'
    return path


def expected():
    """Values the tests check, computed here with numpy/h5py/scipy (the reference libraries)."""
    import json
    out = {}
    with h5py.File(os.path.join(OUT, 'era5-t2m-sample.nc'), 'r') as f:
        v = f['t2m']
        out['t2m_5_10_20'] = float(v[5, 10, 20]) * v.attrs['scale_factor'] + v.attrs['add_offset']
        out['t2m_raw_0_0_0'] = int(v[0, 0, 0])
        out['tp_0_71_3_isnan'] = bool(np.isnan(f['tp'][0, 71, 3]))
        out['lat_10'] = float(f['latitude'][10])
        out['time_0'] = int(f['time'][0])
    with netcdf_file(os.path.join(OUT, 'argo-profiles-classic.nc'), 'r', mmap=False) as f:
        out['temp_2_7'] = float(f.variables['temp'][2, 7])
        out['temp_col7_step3'] = [float(x) for x in f.variables['temp'][0:12:3, 7]]
        out['sal_raw_4_20'] = int(f.variables['salinity'][4, 20])
        out['time_all'] = [float(x) for x in f.variables['time'][:]]
        out['station_5'] = f.variables['station'][5].tobytes().decode().strip()
    with h5py.File(os.path.join(OUT, 'beamline-scan.h5'), 'r') as f:
        im = f['entry/instrument/detector/image']
        out['image_100_37'] = int(im[100, 37])
        out['image_rows_10_15_cols_3'] = im[10:15, 3].tolist()
        out['spectrum_sum_first_10'] = float(f['entry/data/spectrum'][:10].sum())
        out['stack_lzf_3_5_7'] = float(f['entry/scan/stack_lzf'][3, 5, 7])
    with open(os.path.join(OUT, 'expected.json'), 'w') as fh:
        json.dump(out, fh, indent=1)
    return os.path.join(OUT, 'expected.json')


if __name__ == '__main__':
    for p in (era5(), argo(), beamline(), huge_sparse(), expected()):
        print('%8d  %s' % (os.path.getsize(p), os.path.relpath(p, os.path.join(HERE, '..'))))
