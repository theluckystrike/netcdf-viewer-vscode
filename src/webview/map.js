// Map overlay for heatmaps of latitude x longitude grids: finds the lat/lon axes and turns the Natural Earth
// coastline into lines in cell units of the plotted (possibly sampled) grid. Pure functions, no DOM.
import { COASTLINE_110M } from './coastline.js';

const LAT_NAME = /^(lat|lats|latitude|nav_lat|xlat|lat_[0-9]+|g[0-9]+_lat_[0-9]+|y?lat(itude)?_?(rho|u|v|psi|t)?)$/i;
const LON_NAME = /^(lon|lons|long|longitude|nav_lon|xlong|lon_[0-9]+|g[0-9]+_lon_[0-9]+|x?lon(gitude)?_?(rho|u|v|psi|t)?)$/i;
const LAT_UNITS = /^degrees?_?(north|n)$/i;
const LON_UNITS = /^degrees?_?(east|e)$/i;

/**
 * 'lat', 'lon' or null for a plotted axis. name: dimension or coordinate variable name.
 * meta: optional { units, standard_name, axis } of the coordinate variable (CF attributes).
 */
export function geoKind(name, meta) {
  const m = meta || {};
  const sn = String(m.standard_name || '').toLowerCase();
  const u = String(m.units || '').trim();
  if (sn === 'latitude' || sn === 'grid_latitude' || LAT_UNITS.test(u)) return 'lat';
  if (sn === 'longitude' || sn === 'grid_longitude' || LON_UNITS.test(u)) return 'lon';
  // Units that say something else (metres of a projection, an index) win over the name.
  if (u && !/^degrees?$/i.test(u)) return null;
  if (LAT_NAME.test(String(name || ''))) return 'lat';
  if (LON_NAME.test(String(name || ''))) return 'lon';
  return null;
}

const finite = x => typeof x === 'number' && Number.isFinite(x);

/** True when vals are finite and strictly monotonic (either way). */
export function monotonic(vals) {
  if (!vals || vals.length < 2 || !vals.every(finite)) return false;
  const up = vals[1] > vals[0];
  for (let i = 1; i < vals.length; i++) if (up ? !(vals[i] > vals[i - 1]) : !(vals[i] < vals[i - 1])) return false;
  return true;
}

/** Fractional index of x in a monotonic array: piecewise linear inside, the end spacing outside. */
export function indexOf(vals) {
  const n = vals.length, up = vals[n - 1] > vals[0];
  return x => {
    let lo = 0, hi = n - 1;
    if (up ? x <= vals[0] : x >= vals[0]) { lo = 0; hi = 1; }
    else if (up ? x >= vals[n - 1] : x <= vals[n - 1]) { lo = n - 2; hi = n - 1; }
    else {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (up ? vals[mid] <= x : vals[mid] >= x) lo = mid; else hi = mid; }
    }
    return lo + (x - vals[lo]) / (vals[hi] - vals[lo]);
  };
}

let decoded = null;
/** The coastline as arrays of [lon, lat] in degrees (decoded once). */
export function coastline(packed = COASTLINE_110M) {
  if (packed === COASTLINE_110M && decoded) return decoded;
  const lines = packed.split(';').map(line => {
    let x = 0, y = 0;
    return line.split(' ').map((p, i) => {
      const [a, b] = p.split(',').map(Number);
      if (i === 0) { x = a; y = b; } else { x += a; y += b; }
      return [x / 10, y / 10];
    });
  });
  if (packed === COASTLINE_110M) decoded = lines;
  return lines;
}

/**
 * Coastline lines in cell units of a grid whose rows are latitudes and columns are longitudes (or the reverse).
 * rowVals / colVals: coordinate values at the plotted (sampled) rows and columns, cell centres at index + 0.5.
 * Returns { lines: [[[x, y], ...], ...], northUp } with x along columns and y along rows, or null when the grid is
 * not a usable lat-lon grid. northUp is true when latitude grows with the row number (the plot should flip rows).
 */
export function coastlineCells(rowKind, colKind, rowVals, colVals, packed) {
  let latVals, lonVals, transposed;
  if (rowKind === 'lat' && colKind === 'lon') { latVals = rowVals; lonVals = colVals; transposed = false; }
  else if (rowKind === 'lon' && colKind === 'lat') { latVals = colVals; lonVals = rowVals; transposed = true; }
  else return null;
  if (!monotonic(latVals) || !monotonic(lonVals)) return null;
  const latMin = Math.min(latVals[0], latVals[latVals.length - 1]), latMax = Math.max(latVals[0], latVals[latVals.length - 1]);
  const lonMin = Math.min(lonVals[0], lonVals[lonVals.length - 1]), lonMax = Math.max(lonVals[0], lonVals[lonVals.length - 1]);
  if (latMin < -91 || latMax > 91 || lonMin < -361 || lonMax > 721 || lonMax - lonMin > 361) return null;
  const li = indexOf(latVals), gi = indexOf(lonVals);
  // Coastline longitudes are -180..180; move each into the 360-degree window centred on the grid.
  const centre = (lonMin + lonMax) / 2;
  const wrap = lon => lon - 360 * Math.floor((lon - (centre - 180)) / 360);
  const margin = 2; // cells outside the grid that are still drawn (the canvas clips them)
  const nLat = latVals.length, nLon = lonVals.length;
  const out = [];
  for (const line of coastline(packed)) {
    let cur = [], prevLon = null;
    for (const [lon0, lat] of line) {
      const lon = wrap(lon0);
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) { if (cur.length > 1) out.push(cur); cur = []; }
      prevLon = lon;
      const a = li(lat) + 0.5, b = gi(lon) + 0.5;
      if (a < -margin || a > nLat + margin || b < -margin || b > nLon + margin) { if (cur.length > 1) out.push(cur); cur = []; continue; }
      cur.push(transposed ? [a, b] : [b, a]);
    }
    if (cur.length > 1) out.push(cur);
  }
  const latUp = latVals[latVals.length - 1] > latVals[0];
  return { lines: out, northUp: !transposed && latUp };
}
