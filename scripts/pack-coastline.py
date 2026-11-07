import json, sys
src, dst = sys.argv[1], sys.argv[2]
g = json.load(open(src))
lines = []
npts = 0
for f in g['features']:
    geom = f['geometry']
    parts = geom['coordinates'] if geom['type'] == 'MultiLineString' else [geom['coordinates']]
    for part in parts:
        pts = []
        for lon, lat in part:
            p = (round(lon * 10), round(lat * 10))
            if not pts or pts[-1] != p:
                pts.append(p)
        if len(pts) < 2:
            continue
        out = [pts[0]] + [(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
        lines.append(' '.join(f'{x},{y}' for x, y in out))
        npts += len(pts)
data = ';'.join(lines)
js = (
"// Natural Earth 1:110m coastline (public domain, https://www.naturalearthdata.com/), packed for the map overlay.\n"
"// Lines are split by ';'. Each line is 'lon,lat' in tenths of a degree, the first point absolute and the rest as\n"
"// differences from the previous point. Made by scripts/pack-coastline.py from ne_110m_coastline.geojson.\n"
f"export const COASTLINE_110M = '{data}';\n")
open(dst, 'w').write(js)
print(len(lines), 'lines', npts, 'points', len(js), 'bytes')
